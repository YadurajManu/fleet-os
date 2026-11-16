import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { postgresEngine, redisEngine, type EngineCommand, type EngineOptions } from '../src/databases/engines.js'

const label = 'fleet.db-build-test=true'
const quote = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`
async function docker(args: string[], stdin?: string | Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', b => chunks.push(b))
    // Do not print raw engine output: bootstrap input contains credentials.
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Docker test command failed (${code}); raw engine output withheld`)))
    child.stdin.end(stdin)
  })
}
async function execute(container: string, command: EngineCommand) {
  const marker = `FLEET_${randomUUID().replaceAll('-', '')}`
  const env = Object.entries(command.env).map(([k, v]) => `export ${k}=${quote(v)}`).join('\n')
  const script = `${env}\nexec ${command.command.map(quote).join(' ')}${command.stdin === undefined ? '' : ` <<'${marker}'\n${command.stdin}\n${marker}`}\n`
  return docker(['exec', '-i', container, '/bin/sh'], script)
}
async function ready(check: () => Promise<unknown>) {
  const until = Date.now() + 60000
  while (true) {
    try { return await check() } catch (error) { if (Date.now() >= until) throw error; await delay(250) }
  }
}
async function imageId(tag: string) { return (await docker(['image', 'inspect', '--format', '{{.Id}}', tag])).toString().trim() }

for (const engine of [postgresEngine, redisEngine]) {
  for (const version of engine.versions) test(`maintained ${engine.engine} ${version}: private runtime plan, roles, health, metrics and portable export`, { timeout: 180000 }, async () => {
    const id = randomUUID(), prefix = `fleet-db-plugin-${id.slice(0, 8)}`
    const options: EngineOptions = {
      id, fleetId: randomUUID(), project: 'integration', name: 'primary', version,
      mode: engine.engine === 'postgres' ? 'standard' : 'durable', allocation: { memoryMb: 512, diskMb: 10240 },
      credentials: engine.credentials(), images: {
        primary: await imageId(`fleet-db-build/${engine.engine}:${version}`),
        ...(engine.engine === 'postgres' ? { pooler: await imageId('fleet-db-build/pgbouncer:1') } : {}),
      },
    }
    const plan = engine.plan(options), containers: string[] = [], volumes: string[] = []
    const network = `${prefix}-net`
    const main = `${prefix}-database`
    try {
      await docker(['network', 'create', '--label', label, network])
      for (const container of plan.containers) {
        const name = `${prefix}-${container.role}`, config = `${name}-config`
        containers.push(name); volumes.push(config)
        await docker(['volume', 'create', '--label', label, config])
        const script = 'set -eu\numask 077\n' + container.files.map(file => `mkdir -p ${quote(file.path.slice(0, file.path.lastIndexOf('/')))}\nprintf '%s' ${quote(file.content)} > ${quote(file.path)}\nchown 999:999 ${quote(file.path)}\nchmod ${file.mode.toString(8)} ${quote(file.path)}`).join('\n')
        await docker(['run', '--rm', '-i', '--label', label, '--network', 'none', '--entrypoint', '/bin/sh', '--mount', `type=volume,src=${config},dst=/etc/fleet`, container.image], script)
        const mounts = ['--mount', `type=volume,src=${config},dst=/etc/fleet,readonly`]
        if (container.role === 'database') {
          const data = `${name}-data`; volumes.push(data)
          await docker(['volume', 'create', '--label', label, data])
          mounts.push('--mount', `type=volume,src=${data},dst=${plan.dataPath}`)
        }
        await docker(['create', '--name', name, '--label', label, '--network', network,
          ...container.aliases.flatMap(alias => ['--network-alias', alias]), '--memory', `${container.memoryMb}m`,
          ...mounts, ...Object.entries(container.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), container.image, ...container.command])
        await docker(['start', name])
        const [inspect] = JSON.parse((await docker(['inspect', name])).toString())
        assert.deepEqual(inspect.HostConfig.PortBindings ?? {}, {})
      }
      await ready(() => execute(main, plan.readiness))
      if (plan.bootstrap) await execute(main, plan.bootstrap)
      if (engine.engine === 'postgres') {
        const owner = (query: string): EngineCommand => ({ ...plan.readiness, command: ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], stdin: query })
        for (const extension of engine.extensions) await execute(main, owner(`CREATE EXTENSION IF NOT EXISTS "${extension}";`))
        await execute(main, owner('CREATE TABLE role_probe (id integer primary key);'))
        const roleQuery = (role: 'app' | 'readonly', query: string): EngineCommand => ({
          ...owner(query), env: { ...owner(query).env, PGHOST: 'primary-pool.fleet.internal', PGPORT: '6432',
            PGUSER: options.credentials[role].username, PGPASSWORD: options.credentials[role].password },
        })
        await ready(() => execute(main, roleQuery('app', 'SELECT 1;')))
        await execute(main, roleQuery('app', 'INSERT INTO role_probe VALUES (42);'))
        assert.equal((await execute(main, roleQuery('readonly', 'SELECT id FROM role_probe;'))).toString().trim(), '42')
        await assert.rejects(execute(main, roleQuery('readonly', 'INSERT INTO role_probe VALUES (43);')))
        await assert.rejects(execute(main, roleQuery('app', 'CREATE TABLE forbidden (id int);')))
        const versionOutput = await docker(['exec', main, 'wal-g', '--version'])
        assert.match(versionOutput.toString(), /3\.0\.9/)
        const dump = await execute(main, engine.export(options))
        assert.equal(dump.subarray(0, 5).toString(), 'PGDMP')
      } else {
        const query = (role: 'app' | 'readonly', ...args: string[]): EngineCommand => ({
          command: ['redis-cli', '-e', '--user', options.credentials[role].username, '--raw', ...args], env: { REDISCLI_AUTH: options.credentials[role].password },
        })
        await execute(main, query('app', 'SET', 'role-probe', '42'))
        assert.equal((await execute(main, query('readonly', 'GET', 'role-probe'))).toString().trim(), '42')
        await assert.rejects(execute(main, query('readonly', 'SET', 'role-probe', '43')))
        await assert.rejects(execute(main, query('app', 'FLUSHALL')))
        const dump = await execute(main, engine.export(options))
        assert.equal(dump.subarray(0, 5).toString(), 'REDIS')
      }
      const metrics = engine.parseMetrics((await execute(main, engine.metrics(options))).toString())
      assert.ok(Object.keys(metrics).length > 0)
      for (const cred of Object.values(options.credentials)) assert.ok(!JSON.stringify(metrics).includes(cred.password))
    } finally {
      for (const name of containers.reverse()) await docker(['rm', '-f', name]).catch(() => {})
      for (const volume of volumes) await docker(['volume', 'rm', volume]).catch(() => {})
      await docker(['network', 'rm', network]).catch(() => {})
    }
  })
}
