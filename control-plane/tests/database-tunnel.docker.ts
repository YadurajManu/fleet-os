import test from 'node:test'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createServer as createTCPServer } from 'node:net'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { TunnelRegistry } from '../src/tunnel/registry.js'
import { DatabaseTunnel } from '../src/databases/tunnel.js'
import { redisEngine } from '../src/databases/engines.js'
import type { AppContext } from '../src/api/context.js'

const docker = (args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
async function until(check: () => boolean) {
  const end = Date.now() + 30000
  while (!check()) {
    if (Date.now() > end) throw new Error('Tunnel fixture did not become ready')
    await delay(20)
  }
}
function resp(parts: Buffer[]) {
  return Buffer.concat([
    Buffer.from(`*${parts.length}\r\n`),
    ...parts.flatMap((part) => [
      Buffer.from(`$${part.length}\r\n`),
      part,
      Buffer.from('\r\n'),
    ]),
  ])
}

test(
  'real agents and Docker service transfer private Redis traffic, drop and reconnect at 100 ms RTT',
  { timeout: 240000 },
  async (t) => {
    const fleetId = randomUUID(),
      nodeId = randomUUID(),
      serviceNodeId = randomUUID(),
      id = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const registry = new TunnelRegistry({ builds: {} } as unknown as AppContext)
    const relay = new DatabaseTunnel(registry)
    const server = createServer(),
      wss = new WebSocketServer({ server })
    const peers: ReturnType<typeof spawn>[] = []
    wss.on('connection', (socket, request) => {
      const selected =
        request.headers.authorization === `Bearer ${token}-db`
          ? nodeId
          : request.headers.authorization === `Bearer ${token}-app`
            ? serviceNodeId
            : null
      if (!selected) {
        socket.close()
        return
      }
      // Delay each direction by 50 ms while retaining actual WebSocket framing/order.
      const send = socket.send.bind(socket)
      socket.send = ((data: string) => {
        setTimeout(() => {
          if (socket.readyState === 1) send(data)
        }, 50)
      }) as typeof socket.send
      const emit = socket.emit.bind(socket)
      socket.emit = ((event: string, ...args: unknown[]) => {
        if (event === 'message') {
          setTimeout(() => emit(event, ...args), 50)
          return true
        }
        return emit(event, ...args)
      }) as typeof socket.emit
      registry.register(selected, socket)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const image = docker([
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      'fleet-db-build/redis:7',
    ])
    const identity = {
      id,
      nodeId,
      fleetId,
      project: 'tunnel-e2e',
      generation: 1,
    }
    const credentials = redisEngine.credentials()
    const platform = `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
    const plan = redisEngine.plan({
      id,
      fleetId,
      project: identity.project,
      name: 'tunnel',
      version: '7',
      mode: 'durable',
      allocation: { memoryMb: 512, diskMb: 10240 },
      credentials,
      images: { primary: image },
    })
    const proxy = createTCPServer((socket) => {
      const stream = relay.open(
        { identity, role: 'database', port: 6379, timeoutMs: 30000 },
        new AbortController().signal,
      )
      stream.on('error', () => socket.destroy())
      socket.on('error', () => stream.destroy())
      socket.pipe(stream).pipe(socket)
    })
    try {
      const peerBinary = resolve('../deploy/databases/.build/tunnel-tests')
      execFileSync(
        'go',
        ['test', '-c', '-o', peerBinary, './internal/tunnel'],
        { cwd: '../agent', stdio: 'ignore' },
      )
      for (const [peerId, suffix] of [
        [nodeId, 'db'],
        [serviceNodeId, 'app'],
      ]) {
        const child = spawn(
          peerBinary,
          ['-test.run=^TestDatabaseTunnelPeer$', '-test.count=1'],
          {
            cwd: '../agent',
            env: {
              ...process.env,
              FLEET_DB_TUNNEL_FIXTURE: JSON.stringify({
                URL: `http://127.0.0.1:${address.port}`,
                Token: `${token}-${suffix}`,
                NodeID: peerId,
                FleetID: fleetId,
              }),
            },
            stdio: ['pipe', 'ignore', 'ignore'],
          },
        )
        peers.push(child)
      }
      await until(() => registry.has(nodeId) && registry.has(serviceNodeId))
      await relay.runOperation(
        {
          id: randomUUID(),
          action: 'provision',
          identity,
          readiness: plan.readiness,
          containers: plan.containers.map((container) => ({
            initialize: true,
            identity,
            network: plan.network,
            volume: `fleet-db-${id}-data`,
            dataPath: plan.dataPath,
            platform,
            cpu: 0.5,
            container,
          })),
        },
        new AbortController().signal,
      )
      const auth = resp([
        Buffer.from('AUTH'),
        Buffer.from(credentials.app.username),
        Buffer.from(credentials.app.password),
      ])
      const payload = randomBytes(2 * 1024 * 1024)
      const request = Buffer.concat([
        auth,
        resp([Buffer.from('SET'), Buffer.from('payload'), payload]),
        resp([Buffer.from('GET'), Buffer.from('payload')]),
      ])
      const transfer = async () => {
        const stream = relay.open(
          { identity, role: 'database', port: 6379, timeoutMs: 30000 },
          new AbortController().signal,
        )
        const output: Buffer[] = []
        stream.on('data', (chunk) => output.push(chunk))
        const finished = once(stream, 'end')
        stream.end(request)
        await finished
        const data = Buffer.concat(output)
        assert.ok(data.includes(payload))
        stream.destroy()
      }
      const started = performance.now()
      await transfer()
      const elapsedMs = performance.now() - started
      t.diagnostic(
        JSON.stringify({
          bytes: payload.length,
          rttMs: 100,
          elapsedMs,
          stopAndWaitMinimumMs: 12800,
        }),
      )
      assert.ok(elapsedMs < 12800 / 2)
      proxy.listen(0, '127.0.0.1')
      await once(proxy, 'listening')
      const endpoint = proxy.address()
      assert.ok(endpoint && typeof endpoint !== 'string')
      const service = await registry.runTask(
        serviceNodeId,
        {
          service: 'tunnel-client',
          image: JSON.parse(
            readFileSync(
              new URL(
                '../../deploy/databases/images.lock.json',
                import.meta.url,
              ),
              'utf8',
            ),
          ).redis,
          platform,
          command: [
            'sh',
            '-c',
            `redis-cli --raw --user fleet_app -h host.docker.internal -p ${endpoint.port} GET payload | sha256sum`,
          ],
          env: { REDISCLI_AUTH: credentials.app.password },
          registry_auth: null,
          memory_bytes: 128 * 1048576,
          timeout_ms: 30000,
        },
        new AbortController().signal,
      )
      assert.equal(service.exitCode, 0)
      assert.ok(
        service.output.includes(
          createHash('sha256')
            .update(Buffer.concat([payload, Buffer.from('\n')]))
            .digest('hex'),
        ),
      )
      const dropped = relay.open(
        { identity, role: 'database', port: 6379, timeoutMs: 30000 },
        new AbortController().signal,
      )
      const interrupted = once(dropped, 'error')
      await once(dropped, 'ready')
      dropped.write(
        Buffer.concat([
          auth,
          resp([
            Buffer.from('SET'),
            Buffer.from('interrupted'),
            randomBytes(8 * 1024 * 1024),
          ]),
        ]),
        () => {},
      )
      await delay(100)
      registry.close(nodeId)
      await interrupted
      await until(() => registry.has(nodeId))
      await transfer()
    } finally {
      relay.close()
      registry.close(nodeId)
      registry.close(serviceNodeId)
      for (const child of peers) {
        child.stdin?.end()
        child.kill('SIGTERM')
      }
      proxy.close()
      for (const socket of wss.clients) socket.terminate()
      wss.close()
      server.close()
      const containers = docker([
        'ps',
        '-aq',
        '--filter',
        `label=io.fleet.database=${id}`,
      ])
      if (containers) docker(['rm', '-f', ...containers.split(/\s+/)])
      const volumes = docker([
        'volume',
        'ls',
        '-q',
        '--filter',
        `label=io.fleet.database=${id}`,
      ])
      if (volumes) docker(['volume', 'rm', ...volumes.split(/\s+/)])
      try {
        docker(['network', 'rm', plan.network])
      } catch {}
    }
  },
)
