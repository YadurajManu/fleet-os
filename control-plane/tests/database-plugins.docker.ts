import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  postgresEngine,
  redisEngine,
  type EngineCommand,
  type EngineOptions,
} from '../src/databases/engines.js'

const platform =
  process.env.FLEET_DB_TEST_PLATFORM ??
  `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
assert.match(platform, /^linux\/(arm64|amd64)$/)
async function run(
  program: string,
  args: string[],
  stdin?: string | Buffer,
  env = process.env,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (b) => chunks.push(b))
    // Do not print raw engine output: bootstrap input contains credentials.
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('exit', (code) => {
      const output = Buffer.concat(chunks)
      if (code === 0) {
        resolve(output)
        return
      }
      const detail =
        program === 'go'
          ? output
              .toString()
              .replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')
              .slice(-4000)
          : 'raw engine output withheld'
      reject(
        new Error(
          `${program} database test command failed (${code}): ${detail}`,
        ),
      )
    })
    child.stdin.end(stdin)
  })
}
const docker = (args: string[], stdin?: string | Buffer) =>
  run('docker', args, stdin)
async function execute(
  container: string,
  command: EngineCommand,
  input: string | Buffer | undefined = command.stdin,
) {
  const role =
    command.env.PGUSER ?? command.command[command.command.indexOf('--user') + 1]
  const user =
    role === 'fleet_readonly'
      ? '10000:10000'
      : role === 'fleet_app'
        ? '10001:10001'
        : '999:999'
  return run(
    'docker',
    [
      'exec',
      '-i',
      '--user',
      user,
      ...Object.keys(command.env).flatMap((key) => ['--env', key]),
      container,
      ...command.command,
    ],
    input,
    { ...process.env, ...command.env },
  )
}
async function ready(check: () => Promise<unknown>) {
  const until = Date.now() + 60000
  while (true) {
    try {
      return await check()
    } catch (error) {
      if (Date.now() >= until) throw error
      await delay(250)
    }
  }
}
// Docker creates multi-platform images from the index ID; a platform config ID is not an image reference.
async function imageId(tag: string) {
  return (await docker(['image', 'inspect', '--format', '{{.Id}}', tag]))
    .toString()
    .trim()
}

for (const engine of [postgresEngine, redisEngine]) {
  for (const version of engine.versions)
    test(
      `maintained ${engine.engine} ${version} (${platform}): private runtime plan, roles, health, metrics and portable export`,
      { timeout: 180000 },
      async () => {
        const id = randomUUID(),
          prefix = `fleet-db-${id}`
        const options: EngineOptions = {
          id,
          fleetId: randomUUID(),
          project: 'integration',
          name: 'primary',
          version,
          mode: engine.engine === 'postgres' ? 'standard' : 'durable',
          allocation: { memoryMb: 512, diskMb: 10240 },
          credentials: engine.credentials(),
          images: {
            primary: await imageId(
              `fleet-db-build/${engine.engine}:${version}`,
            ),
            ...(engine.engine === 'postgres'
              ? { pooler: await imageId('fleet-db-build/pgbouncer:1') }
              : {}),
          },
        }
        const plan = engine.plan(options),
          containers: string[] = [],
          volumes: string[] = []
        const network = plan.network
        const main = `${prefix}-database`
        const identity = {
          id,
          nodeId: randomUUID(),
          fleetId: options.fleetId,
          project: options.project,
          generation: 1,
        }
        const volume = `${prefix}-data`
        const apply = async (
          container: (typeof plan.containers)[number],
          initialize: boolean,
          action = 'start',
        ) => {
          const output = await run(
            'go',
            [
              '-C',
              '../agent',
              'test',
              './internal/docker',
              '-run',
              '^TestDatabaseResourceRealDocker$',
              '-count=1',
              '-v',
            ],
            undefined,
            {
              ...process.env,
              FLEET_DB_RESOURCE_ACTION: action,
              FLEET_DB_RESOURCE_TEST: JSON.stringify({
                identity,
                initialize,
                network,
                volume,
                dataPath: plan.dataPath,
                platform,
                cpu: 0.5,
                container,
                ...(container.role === 'database'
                  ? { readiness: plan.readiness }
                  : {}),
              }),
            },
          )
          assert.match(
            output.toString(),
            /--- PASS: TestDatabaseResourceRealDocker/,
          )
        }
        try {
          for (const container of plan.containers) {
            const name = `${prefix}-${container.role}`,
              config = `${volume}-${container.role}-config`
            containers.push(name)
            volumes.push(config)
            if (container.role === 'database') volumes.push(volume)
            await apply(container, true)
            const [inspect] = JSON.parse(
              (await docker(['inspect', name])).toString(),
            )
            assert.deepEqual(inspect.HostConfig.PortBindings ?? {}, {})
          }
          await ready(() => execute(main, plan.readiness))
          if (plan.bootstrap) await execute(main, plan.bootstrap)
          if (engine.engine === 'postgres') {
            const owner = (query: string): EngineCommand => ({
              ...plan.readiness,
              command: ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At'],
              stdin: query,
            })
            for (const extension of engine.extensions)
              await execute(
                main,
                owner(`CREATE EXTENSION IF NOT EXISTS "${extension}";`),
              )
            await execute(
              main,
              owner('CREATE TABLE role_probe (id integer primary key);'),
            )
            const roleQuery = (
              role: 'app' | 'readonly',
              query: string,
            ): EngineCommand => ({
              ...owner(query),
              env: {
                ...owner(query).env,
                PGHOST: 'primary-pool.fleet.internal',
                PGPORT: '6432',
                PGUSER: options.credentials[role].username,
                PGPASSWORD: options.credentials[role].password,
              },
            })
            await ready(() => execute(main, roleQuery('app', 'SELECT 1;')))
            await execute(
              main,
              roleQuery('app', 'INSERT INTO role_probe VALUES (42);'),
            )
            assert.equal(
              (
                await execute(
                  main,
                  roleQuery('readonly', 'SELECT id FROM role_probe;'),
                )
              )
                .toString()
                .trim(),
              '42',
            )
            await assert.rejects(
              execute(
                main,
                roleQuery('readonly', 'INSERT INTO role_probe VALUES (43);'),
              ),
            )
            await assert.rejects(
              execute(
                main,
                roleQuery('app', 'CREATE TABLE forbidden (id int);'),
              ),
            )
            const isolation = await run(
              'go',
              [
                '-C',
                '../agent',
                'test',
                './internal/docker',
                '-run',
                '^TestDatabaseResourceRealDocker$',
                '-count=1',
                '-v',
              ],
              undefined,
              {
                ...process.env,
                FLEET_DB_RESOURCE_ACTION: 'exec',
                FLEET_DB_RESOURCE_TEST: JSON.stringify({
                  identity,
                  container: plan.containers[0],
                  expected: 'DENIED',
                  command: {
                    ...roleQuery(
                      'readonly',
                      '\\! if test -r /etc/fleet/owner-password; then echo READABLE; else echo DENIED; fi',
                    ),
                    env: {
                      ...plan.readiness.env,
                      PGUSER: options.credentials.readonly.username,
                      PGPASSWORD: options.credentials.readonly.password,
                    },
                  },
                }),
              },
            )
            assert.match(
              isolation.toString(),
              /--- PASS: TestDatabaseResourceRealDocker/,
            )
            const versionOutput = await docker([
              'exec',
              main,
              'wal-g',
              '--version',
            ])
            assert.match(versionOutput.toString(), /3\.0\.9/)
            const dump = await execute(main, engine.export(options))
            assert.equal(dump.subarray(0, 5).toString(), 'PGDMP')
            await execute(main, owner('DROP TABLE role_probe;'))
            const imported = engine.import(options)
            assert.equal(imported.type, 'pg-restore')
            if (imported.type === 'pg-restore')
              await execute(main, imported.command, dump)
            assert.equal(
              (await execute(main, owner('SELECT id FROM role_probe;')))
                .toString()
                .trim(),
              '42',
            )
          } else {
            const query = (
              role: 'app' | 'readonly',
              ...args: string[]
            ): EngineCommand => ({
              command: [
                'redis-cli',
                '-e',
                '--user',
                options.credentials[role].username,
                '--raw',
                ...args,
              ],
              env: { REDISCLI_AUTH: options.credentials[role].password },
            })
            await execute(main, query('app', 'SET', 'role-probe', '42'))
            assert.equal(
              (await execute(main, query('readonly', 'GET', 'role-probe')))
                .toString()
                .trim(),
              '42',
            )
            await assert.rejects(
              execute(main, query('readonly', 'SET', 'role-probe', '43')),
            )
            await assert.rejects(execute(main, query('app', 'FLUSHALL')))
            const dump = await execute(main, engine.export(options))
            assert.equal(dump.subarray(0, 5).toString(), 'REDIS')
          }
          const metrics = engine.parseMetrics(
            (await execute(main, engine.metrics(options))).toString(),
          )
          assert.ok(Object.keys(metrics).length > 0)
          for (const cred of Object.values(options.credentials))
            assert.ok(!JSON.stringify(metrics).includes(cred.password))
          for (const container of [...plan.containers].reverse())
            await apply(container, false, 'stop')
          for (const container of plan.containers) await apply(container, false)
          await ready(() => execute(main, plan.readiness))
          if (engine.engine === 'postgres') {
            assert.equal(
              (
                await execute(main, {
                  ...plan.readiness,
                  command: ['psql', '-X', '-Atc', 'SELECT id FROM role_probe'],
                })
              )
                .toString()
                .trim(),
              '42',
            )
          } else {
            assert.equal(
              (
                await execute(main, {
                  ...plan.readiness,
                  command: [
                    'redis-cli',
                    '--user',
                    options.credentials.owner.username,
                    '--raw',
                    'GET',
                    'role-probe',
                  ],
                })
              )
                .toString()
                .trim(),
              '42',
            )
          }
        } finally {
          for (const name of containers.reverse())
            await docker(['rm', '-f', name]).catch(() => {})
          for (const volume of volumes)
            await docker(['volume', 'rm', volume]).catch(() => {})
          await docker(['network', 'rm', network]).catch(() => {})
        }
      },
    )
}
