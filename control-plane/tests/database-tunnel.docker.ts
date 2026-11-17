import test from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { createContext, closeContext } from '../src/api/context.js'
import { loadConfig } from '../src/config.js'
import {
  orgs,
  fleets,
  nodes,
  tenantDatabases,
  databaseCredentials,
  databaseOperations,
  orgMembers,
  users,
} from '../src/db/schema.js'
import { buildServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'
import { revokeSessions } from '../src/auth/tokens.js'
import { DatabaseWorker } from '../src/databases/worker.js'
import {
  enqueueDatabaseOperation,
  claimDatabaseOperation,
} from '../src/databases/operations.js'
import { streamDatabaseProgress } from '../src/databases/progress.js'

import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createConnection, createServer as createTCPServer } from 'node:net'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { TunnelRegistry } from '../src/tunnel/registry.js'
import { DatabaseTunnel } from '../src/databases/tunnel.js'
import { redisEngine } from '../src/databases/engines.js'
import { sealSecret } from '../src/lib/crypto.js'
import type { AppContext } from '../src/api/context.js'

const workerMode = process.env.FLEET_DB_WORKER_TEST === '1'
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
    const fixtureConfig = workerMode ? loadConfig() : null
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
      '{{index .RepoDigests 0}}',
      'fleet-db-build/redis:7',
    ])
    const identity = {
      id,
      nodeId,
      fleetId,
      project: 'tunnel-e2e',
      generation: 1,
    }
    const workerContext = fixtureConfig ? createContext(fixtureConfig) : null
    const orgId = randomUUID()
    if (workerContext) workerContext.tunnels = registry
    let worker: DatabaseWorker | undefined
    let api: FastifyInstance | undefined
    let cliProcess: ReturnType<typeof spawn> | undefined
    let connectAccount:
      | { user: { id: string }; org: { id: string }; accessToken: string }
      | undefined
    const credentials = redisEngine.credentials()
    const auth = resp([
      Buffer.from('AUTH'),
      Buffer.from(credentials.app.username),
      Buffer.from(credentials.app.password),
    ])
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
      if (workerContext) {
        const [current] = await workerContext.sql<
          { name: string }[]
        >`select current_database() as name`
        assert.match(current!.name, /(?:^test_|_test$)/)
        await workerContext.db
          .insert(orgs)
          .values({ id: orgId, name: 'worker-fixture' })
        await workerContext.db
          .insert(fleets)
          .values({ id: fleetId, orgId, name: 'worker-fixture' })
        await workerContext.db.insert(nodes).values({
          id: nodeId,
          fleetId,
          name: 'database-node',
          cpuCores: 2,
          ramMb: 4096,
          diskMb: 100000,
          agentTokenHash: createHash('sha256')
            .update(token + '-db')
            .digest('hex'),
          arch: process.arch,
          databaseCapabilities: ['database.runtime.v1'],
        })
        await workerContext.db.insert(tenantDatabases).values({
          id,
          fleetId,
          project: identity.project,
          name: 'tunnel',
          engine: 'redis',
          version: '7',
          mode: 'durable',
          nodeId,
          volumeName: `fleet-db-${id}-data`,
          memoryMb: 512,
          cpu: 0.5,
          diskMb: 10240,
        })
        await workerContext.db.insert(databaseCredentials).values({
          databaseId: id,
          role: 'app',
          generation: 1,
          encryptedValue: sealSecret(
            JSON.stringify(credentials.app),
            workerContext.config.SECRETS_MASTER_KEY,
          ),
        })
        const scope = { fleetId, project: identity.project, databaseId: id }
        const runtimeIntent = {
          identity,
          readiness: { ...plan.readiness, stdin: plan.readiness.stdin ?? '' },
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
        }
        const created = await enqueueDatabaseOperation(
          workerContext,
          scope,
          'create',
          'create',
          runtimeIntent,
        )
        worker = new DatabaseWorker(workerContext)
        assert.equal(await worker.tick(), true)
        api = await buildServer(workerContext)
        const signup = await api.inject({
          method: 'POST',
          url: '/auth/signup',
          payload: {
            email: `database-connect-${randomUUID()}@example.test`,
            password: 'database-connect-test-password',
          },
        })
        assert.equal(signup.statusCode, 201, signup.body)
        const account = signup.json() as NonNullable<typeof connectAccount>
        connectAccount = account
        await workerContext.db.insert(orgMembers).values({
          orgId,
          userId: account.user.id,
          role: 'admin',
        })
        const apiUrl = await api.listen({ port: 0, host: '127.0.0.1' })
        const connectUrl = new URL(
          `/fleets/${fleetId}/projects/${identity.project}/databases/${id}/connect`,
          apiUrl,
        )
        connectUrl.protocol = 'ws:'
        const unauthorized = new WebSocket(connectUrl)
        const unauthorizedStatus = await new Promise<number>(
          (resolve, reject) => {
            unauthorized.once('unexpected-response', (_request, response) => {
              response.resume()
              resolve(response.statusCode ?? 0)
            })
            unauthorized.once('error', reject)
          },
        )
        assert.equal(unauthorizedStatus, 401)
        t.diagnostic('unauthenticated database WebSocket rejected')
        const portProbe = createTCPServer()
        portProbe.listen(0, '127.0.0.1')
        await once(portProbe, 'listening')
        const portProbeAddress = portProbe.address()
        assert.ok(portProbeAddress && typeof portProbeAddress !== 'string')
        const localPort = portProbeAddress.port
        await new Promise<void>((resolve, reject) =>
          portProbe.close((error) => (error ? reject(error) : resolve())),
        )
        const cli = spawn(
          'node',
          [
            '--import',
            'tsx',
            'src/index.ts',
            'db',
            'connect',
            'tunnel',
            '--project',
            identity.project,
            '--port',
            String(localPort),
          ],
          {
            cwd: '../cli',
            env: {
              ...process.env,
              FLEET_API: apiUrl,
              FLEET_TOKEN: account.accessToken,
              FLEET_ID: fleetId,
              FLEET_CONFIG: `/tmp/fleet-db-connect-${id}.json`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        cliProcess = cli
        const cliOutput: Buffer[] = []
        const cliErrors: Buffer[] = []
        cli.stdout?.on('data', (chunk) => cliOutput.push(chunk))
        cli.stderr?.on('data', (chunk) => cliErrors.push(Buffer.from(chunk)))
        cli.once('error', (error) => {
          throw error
        })
        await until(() =>
          Buffer.concat(cliOutput)
            .toString()
            .includes(`127.0.0.1:${localPort}`),
        )
        t.diagnostic('local CLI forwarder is listening')
        const localClient = createConnection({
          host: '127.0.0.1',
          port: localPort,
        })
        await once(localClient, 'connect')
        t.diagnostic('local client connected to CLI forwarder')
        const streamOutput: Buffer[] = []
        localClient.on('error', (error) =>
          t.diagnostic(`local client socket error: ${error.message}`),
        )
        localClient.on('data', (chunk) => streamOutput.push(Buffer.from(chunk)))
        localClient.write(auth)
        localClient.write(resp([Buffer.from('PING')]))
        const pongDeadline = Date.now() + 30000
        while (
          !Buffer.concat(streamOutput).includes(Buffer.from('+PONG\r\n')) &&
          Date.now() < pongDeadline
        )
          await delay(20)
        assert.ok(
          Buffer.concat(streamOutput).includes(Buffer.from('+PONG\r\n')),
          Buffer.concat(cliErrors).toString(),
        )
        t.diagnostic('local CLI forwarder completed Redis PING')
        assert.ok(Buffer.concat(streamOutput).includes(Buffer.from('+OK\r\n')))
        const execOutput: Buffer[] = []
        const execProcess = spawn(
          'node',
          [
            '--import',
            'tsx',
            'src/index.ts',
            'db',
            'exec',
            'tunnel',
            '--project',
            identity.project,
            '--',
            'PING',
          ],
          {
            cwd: '../cli',
            env: {
              ...process.env,
              FLEET_API: apiUrl,
              FLEET_TOKEN: account.accessToken,
              FLEET_ID: fleetId,
              FLEET_CONFIG: `/tmp/fleet-db-exec-${id}.json`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        const execErrors: Buffer[] = []
        execProcess.stderr?.on('data', (chunk) =>
          execErrors.push(Buffer.from(chunk)),
        )
        execProcess.stdout?.on('data', (chunk) =>
          execOutput.push(Buffer.from(chunk)),
        )
        const execExit = await once(execProcess, 'exit')
        assert.equal(execExit[0], 0, Buffer.concat(execErrors).toString())
        assert.match(Buffer.concat(execOutput).toString(), /PONG/)
        t.diagnostic(
          'authenticated CLI db exec completed Redis PING over the tunnel',
        )
        const disconnected = once(localClient, 'close')
        await revokeSessions(workerContext.redis, account.user.id)
        await disconnected
        const cliExit = once(cli, 'exit')
        cli.kill('SIGINT')
        await cliExit
        cliProcess = undefined
        const [finished] = await workerContext.db
          .select()
          .from(databaseOperations)
          .where(eq(databaseOperations.id, created.id))
        assert.equal(finished!.state, 'succeeded')
        const restartIntent = {
          identity,
          readiness: { ...plan.readiness, stdin: plan.readiness.stdin ?? '' },
        }
        const restart = await enqueueDatabaseOperation(
          workerContext,
          scope,
          'restart',
          'restart',
          restartIntent,
        )
        const claimed = await claimDatabaseOperation(workerContext, ['restart'])
        assert.equal(claimed!.operation.id, restart.id)
        await relay.runOperation(
          { ...restartIntent, id: restart.id, action: 'restart' },
          new AbortController().signal,
        )
        const startedAt = docker([
          'inspect',
          '--format',
          '{{.State.StartedAt}}',
          `fleet-db-${id}-database`,
        ])
        await worker.close()
        await workerContext.db
          .update(databaseOperations)
          .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(databaseOperations.id, restart.id))
        worker = new DatabaseWorker(workerContext)
        assert.equal(await worker.tick(), true)
        const [resumed] = await workerContext.db
          .select()
          .from(databaseOperations)
          .where(eq(databaseOperations.id, restart.id))
        assert.equal(resumed!.state, 'succeeded')
        assert.equal(resumed!.attempts, 2)
        assert.equal(
          docker([
            'inspect',
            '--format',
            '{{.State.StartedAt}}',
            `fleet-db-${id}-database`,
          ]),
          startedAt,
        )
        const abort = new AbortController()
        const progress = []
        for await (const event of streamDatabaseProgress(
          workerContext,
          scope,
          abort.signal,
        )) {
          progress.push(event)
          if (event.operationId === restart.id && event.code === 'succeeded') {
            abort.abort()
            break
          }
        }
        assert.ok(progress.some((event) => event.code === 'checkpoint'))
        assert.equal(progress.at(-1)!.progress, 100)
        assert.ok(
          !JSON.stringify(progress).includes(credentials.owner.password),
        )
      } else {
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
      }
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
      cliProcess?.kill('SIGTERM')
      if (api) await api.close()
      await worker?.close()
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
      if (workerContext) {
        await workerContext.db
          .delete(tenantDatabases)
          .where(eq(tenantDatabases.id, id))
        await workerContext.db.delete(orgs).where(eq(orgs.id, orgId))
        if (connectAccount) {
          await workerContext.db
            .delete(orgs)
            .where(eq(orgs.id, connectAccount.org.id))
          await workerContext.db
            .delete(users)
            .where(eq(users.id, connectAccount.user.id))
        }
        await closeContext(workerContext)
      }
    }
  },
)
