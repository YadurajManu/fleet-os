import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveDatabaseImages } from '../src/databases/images.js'
import { mergeManifests } from '../src/build/manifests.js'

const hostEnv = { ...process.env }
function run(
  command: string,
  args: string[],
  stdin?: string,
  env = hostEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 180000,
      }),
      chunks: Buffer[] = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
    child.once('error', reject)
    child.once('exit', (code) => {
      const output = Buffer.concat(chunks).toString().trim()
      if (code === 0) {
        resolve(output)
        return
      }
      let detail = 'raw output withheld'
      if (command === 'go' && env.FLEET_DB_PREPULL_TEST) {
        const setup = JSON.parse(env.FLEET_DB_PREPULL_TEST) as { auth: string }
        const auth = JSON.parse(setup.auth) as { password: string }
        detail = output
          .replaceAll(auth.password, '[redacted]')
          .replaceAll(setup.auth, '[redacted]')
          .slice(-4000)
      }
      reject(
        new Error(
          `Registry fixture ${command} ${args[0] ?? ''} failed (${code}): ${detail}`,
        ),
      )
    })
  })
}
async function transferImage(
  tag: string,
  platform: string,
  env: NodeJS.ProcessEnv,
) {
  const save = spawn('docker', ['image', 'save', '--platform', platform, tag], {
    env: hostEnv,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 180000,
  })
  const load = spawn('docker', ['image', 'load'], {
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 180000,
  })
  save.stdout.pipe(load.stdin)
  load.stdin.on('error', () => {})
  await Promise.all(
    [save, load].map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code) =>
            code === 0
              ? resolve()
              : reject(new Error('Isolated registry image transfer failed')),
          )
        }),
    ),
  )
}
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

test(
  'private registry authenticates and the real agent pre-pulls verified digests in an isolated daemon',
  { timeout: 600000 },
  async () => {
    const root = resolve('.db-build')
    await mkdir(root, { recursive: true })
    const dir = await mkdtemp(join(root, 'registry-')),
      suffix = randomUUID().slice(0, 8)
    const name = `fleet-db-registry-${suffix}`,
      volumes = [`${name}-registry`, `${name}-docker`]
    const user = 'fleet-integration',
      password = randomBytes(32).toString('base64url'),
      port = await freePort(),
      host = `127.0.0.1:${port}`
    const saved: Record<string, string | undefined> = Object.fromEntries(
      [
        'DOCKER_HOST',
        'DOCKER_CONTEXT',
        'DOCKER_TLS_VERIFY',
        'DOCKER_CERT_PATH',
      ].map((key) => [key, process.env[key]]),
    )
    try {
      try {
        assert.equal(
          await run('docker', [
            'image',
            'inspect',
            '--format',
            '{{index .Config.Labels "fleet.db-build-test"}}',
            'fleet-db-build/registry-test:local',
          ]),
          'true',
        )
      } catch {
        await run('node', [
          '../deploy/databases/build.mjs',
          'registry-test:local',
        ])
      }
      const auth = await run('htpasswd', ['-Bni', user], `${password}\n`)
      assert.match(auth, /^fleet-integration:\$2/)
      await writeFile(join(dir, 'htpasswd'), `${auth}\n`, { mode: 0o600 })
      for (const volume of volumes)
        await run('docker', [
          'volume',
          'create',
          '--label',
          'fleet.db-build-test=true',
          volume,
        ])
      await run('docker', [
        'run',
        '-d',
        '--privileged',
        '--name',
        name,
        '--label',
        'fleet.db-build-test=true',
        '-p',
        `127.0.0.1:${port}:${port}`,
        '-p',
        '127.0.0.1::2375',
        '--mount',
        `type=volume,src=${volumes[0]},dst=/var/lib/registry`,
        '--mount',
        `type=volume,src=${volumes[1]},dst=/var/lib/docker`,
        '--mount',
        `type=bind,src=${join(dir, 'htpasswd')},dst=/auth/htpasswd,readonly`,
        '-e',
        `REGISTRY_HTTP_ADDR=0.0.0.0:${port}`,
        '-e',
        'REGISTRY_AUTH=htpasswd',
        '-e',
        'REGISTRY_AUTH_HTPASSWD_REALM=Fleet-local-tests',
        '-e',
        'REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd',
        'fleet-db-build/registry-test:local',
      ])
      const api = await run('docker', ['port', name, '2375/tcp'])
      assert.match(api, /^127\.0\.0\.1:[0-9]+$/)
      const end = Date.now() + 90000
      while (true) {
        try {
          assert.equal((await fetch(`http://${host}/v2/`)).status, 401)
          assert.equal(await (await fetch(`http://${api}/_ping`)).text(), 'OK')
          break
        } catch (error) {
          if (Date.now() >= end) throw error
          await delay(250)
        }
      }
      const dockerConfig = join(dir, 'docker-config')
      await mkdir(dockerConfig, { mode: 0o700 })
      await writeFile(
        join(dockerConfig, 'config.json'),
        JSON.stringify({ auths: { [host]: {} } }),
        { mode: 0o600 },
      )
      const env = {
        ...hostEnv,
        DOCKER_HOST: `tcp://${api}`,
        DOCKER_CONTEXT: '',
        DOCKER_TLS_VERIFY: '',
        DOCKER_CERT_PATH: '',
        DOCKER_CONFIG: dockerConfig,
      }
      await run(
        'docker',
        ['login', host, '--username', user, '--password-stdin'],
        password,
        env,
      )
      process.env.DOCKER_HOST = env.DOCKER_HOST
      for (const key of [
        'DOCKER_CONTEXT',
        'DOCKER_TLS_VERIFY',
        'DOCKER_CERT_PATH',
      ])
        delete process.env[key]
      for (const image of [
        'postgres:16',
        'postgres:17',
        'redis:7',
        'pgbouncer:1',
      ]) {
        const digests: string[] = []
        for (const architecture of ['arm64', 'amd64']) {
          await transferImage(
            `fleet-db-build/${image}`,
            `linux/${architecture}`,
            env,
          )
          const tag = `${host}/fleet-databases/${image}-${architecture}`
          await run(
            'docker',
            ['tag', `fleet-db-build/${image}`, tag],
            undefined,
            env,
          )
          await run('docker', ['push', tag], undefined, env)
          const [stored] = JSON.parse(
            await run('docker', ['image', 'inspect', tag], undefined, env),
          )
          const digest = stored.RepoDigests.find((ref: string) =>
            ref.startsWith(`${host}/fleet-databases/`),
          ).split('@')[1]
          assert.match(digest, /^sha256:[a-f0-9]{64}$/)
          digests.push(digest)
        }
        const [engine, version] = image.split(':')
        await mergeManifests(
          `${host}/fleet-databases/${engine}`,
          version!,
          digests,
          `${user}:${password}`,
        )
      }
      // The isolated daemon shares the registry's loopback namespace; host ports stay private.
      process.env.DOCKER_HOST = env.DOCKER_HOST
      for (const key of [
        'DOCKER_CONTEXT',
        'DOCKER_TLS_VERIFY',
        'DOCKER_CERT_PATH',
      ])
        delete process.env[key]
      const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
      const config = {
        REGISTRY_URL: host,
        REGISTRY_CREDENTIALS: `${user}:${password}`,
      }
      const postgres = await resolveDatabaseImages(
        config,
        'postgres',
        '17',
        `linux/${architecture}`,
      )
      assert.match(
        postgres.primary,
        /\/fleet-databases\/postgres@sha256:[a-f0-9]{64}$/,
      )
      assert.match(
        postgres.pooler!,
        /\/fleet-databases\/pgbouncer@sha256:[a-f0-9]{64}$/,
      )
      assert.equal(
        (await resolveDatabaseImages(config, 'postgres', '17', 'linux/amd64'))
          .primary,
        postgres.primary,
      )
      assert.equal(
        (await resolveDatabaseImages(config, 'postgres', '17', 'linux/arm64'))
          .primary,
        postgres.primary,
      )
      const redis = await resolveDatabaseImages(
        config,
        'redis',
        '7',
        `linux/${architecture}`,
      )
      assert.match(redis.primary, /\/fleet-databases\/redis@sha256:/)
      await assert.rejects(
        resolveDatabaseImages(
          { ...config, REGISTRY_CREDENTIALS: `${user}:wrong` },
          'postgres',
          '17',
          `linux/${architecture}`,
        ),
        (error: unknown) => {
          assert.ok(!String(error).includes(password))
          return (
            (error as { code: string }).code === 'database_images_unavailable'
          )
        },
      )
      await assert.rejects(
        run('docker', ['image', 'inspect', redis.primary], undefined, env),
      )
      await run('docker', ['image', 'rm', redis.primary], undefined, env).catch(
        () => {},
      )
      const requiredBytes = Math.max(
        64 * 1048576,
        Number(
          await run('docker', [
            'image',
            'inspect',
            '--platform',
            `linux/${architecture}`,
            '--format',
            '{{.Size}}',
            'fleet-db-build/redis:7',
          ]),
        ) * 2,
      )
      const go = await run(
        'go',
        [
          '-C',
          '../agent',
          'test',
          './internal/docker',
          '-run',
          '^TestDatabaseImagePrepullRealRegistry$',
          '-count=1',
          '-v',
        ],
        undefined,
        {
          ...env,
          FLEET_DB_PREPULL_TEST: JSON.stringify({
            reference: redis.primary,
            platform: `linux/${architecture}`,
            requiredBytes,
            auth: JSON.stringify({
              username: user,
              password,
              serveraddress: host,
            }),
          }),
        },
      )
      assert.match(go, /--- PASS: TestDatabaseImagePrepullRealRegistry/)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await run('docker', ['rm', '-f', name]).catch(() => {})
      for (const volume of volumes)
        await run('docker', ['volume', 'rm', volume]).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  },
)
