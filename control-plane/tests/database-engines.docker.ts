/** Explicit real-Docker checks: node --test --import tsx tests/database-engines.docker.ts */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import postgres from 'postgres'
import { Redis } from 'ioredis'
import { tunePostgres, tuneRedis } from '../src/databases/tuning.js'

const exec = promisify(execFile)
const root = resolve('.db-build')
const docker = async (...args: string[]) =>
  (
    await exec('docker', args, { timeout: 180000, maxBuffer: 1024 * 1024 })
  ).stdout.trim()

async function fixture() {
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'engine-'))
  return {
    dir,
    name: `fleet-db-v1-engine-${randomUUID().slice(0, 8)}`,
    password: randomBytes(32).toString('base64url'),
  }
}

async function port(name: string, containerPort: number) {
  const endpoint = await docker('port', name, `${containerPort}/tcp`)
  assert.match(endpoint, /^127\.0\.0\.1:[0-9]+$/)
  return Number(endpoint.split(':')[1])
}

async function untilReady(check: () => Promise<unknown>) {
  const end = Date.now() + 45000
  while (true) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() >= end) throw error
      await delay(250)
    }
  }
}

for (const version of ['16', '17'])
  test(
    `Postgres ${version} starts and applies generated tuning in a separate Docker engine fixture`,
    { timeout: 240000 },
    async () => {
      const { dir, name, password } = await fixture()
      const tuned = tunePostgres({
        memoryMb: 512,
        diskMb: 10240,
        storage: 'ssd',
      })
      let client: ReturnType<typeof postgres> | undefined
      try {
        await writeFile(join(dir, 'password'), password, { mode: 0o600 })
        await writeFile(
          join(dir, 'postgresql.conf'),
          `listen_addresses = '*'\n${tuned.config}`,
          { mode: 0o644 },
        )
        await docker(
          'run',
          '-d',
          '--name',
          name,
          '--label',
          'fleet.db-build-test=true',
          '--memory',
          `${tuned.serverMemoryMb}m`,
          '-p',
          '127.0.0.1::5432',
          '--mount',
          `type=bind,src=${dir},dst=/etc/fleet,readonly`,
          '-e',
          'POSTGRES_PASSWORD_FILE=/etc/fleet/password',
          '-e',
          'POSTGRES_DB=fleet_engine_test',
          `postgres:${version}-alpine`,
          'postgres',
          '-c',
          'config_file=/etc/fleet/postgresql.conf',
        )
        client = postgres({
          host: '127.0.0.1',
          port: await port(name, 5432),
          username: 'postgres',
          password,
          database: 'fleet_engine_test',
          max: 1,
          connect_timeout: 1,
          onnotice: () => {},
        })
        await untilReady(async () => {
          await client!`select 1`
        })
        const [settings] =
          await client`select current_setting('max_connections') as connections, current_setting('work_mem') as work_mem, current_setting('password_encryption') as encryption, current_setting('shared_preload_libraries') as preload`
        assert.equal(
          Number(settings!.connections),
          tuned.settings.max_connections,
        )
        assert.equal(settings!.work_mem, tuned.settings.work_mem)
        assert.equal(settings!.encryption, 'scram-sha-256')
        assert.equal(settings!.preload, 'pg_stat_statements')
        await client`create extension pg_stat_statements`
        const [query] =
          await client`select count(*)::int as count from pg_stat_statements`
        assert.ok(query!.count >= 0)
        await client`create table persisted (id integer primary key)`
        await client`insert into persisted values (42)`
        await client.end({ timeout: 1 })
        client = undefined
        await docker('restart', name)
        client = postgres({
          host: '127.0.0.1',
          port: await port(name, 5432),
          username: 'postgres',
          password,
          database: 'fleet_engine_test',
          max: 1,
          connect_timeout: 1,
          onnotice: () => {},
        })
        await untilReady(async () => {
          await client!`select 1`
        })
        const [row] = await client`select id from persisted`
        assert.equal(row!.id, 42)
      } finally {
        await client?.end({ timeout: 1 })
        await docker('rm', '-f', '-v', name).catch(() => {})
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

for (const mode of ['cache', 'durable'] as const)
  test(
    `Redis ${mode} authenticates, enforces memory policy and has the documented restart behavior`,
    { timeout: 240000 },
    async () => {
      const { dir, name, password } = await fixture()
      let client: Redis | undefined
      try {
        const tuned = tuneRedis({ memoryMb: 256, diskMb: 10240 }, mode)
        await writeFile(join(dir, 'redis.conf'), `${tuned.config}dir /data\n`, {
          mode: 0o644,
        })
        const hash = createHash('sha256').update(password).digest('hex')
        await writeFile(
          join(dir, 'users.acl'),
          `user default off\nuser fleet_test on #${hash} ~* &* +@all\n`,
          { mode: 0o644 },
        )
        await docker(
          'run',
          '-d',
          '--name',
          name,
          '--label',
          'fleet.db-build-test=true',
          '--memory',
          '256m',
          '-p',
          '127.0.0.1::6379',
          '--mount',
          `type=bind,src=${dir},dst=/etc/fleet,readonly`,
          'redis:7-alpine',
          'redis-server',
          '/etc/fleet/redis.conf',
        )
        const connect = async () => {
          const redis = new Redis({
            host: '127.0.0.1',
            port: await port(name, 6379),
            username: 'fleet_test',
            password,
            lazyConnect: true,
            retryStrategy: () => null,
            connectTimeout: 1000,
            maxRetriesPerRequest: 0,
          })
          redis.on('error', () => {})
          try {
            await redis.connect()
            await redis.ping()
            return redis
          } catch (error) {
            redis.disconnect()
            throw error
          }
        }
        await untilReady(async () => {
          client = await connect()
        })
        const unauthenticated = new Redis({
          host: '127.0.0.1',
          port: await port(name, 6379),
          lazyConnect: true,
          retryStrategy: () => null,
          enableReadyCheck: false,
        })
        unauthenticated.on('error', () => {})
        try {
          await assert.rejects(unauthenticated.ping(), /NOAUTH/)
        } finally {
          unauthenticated.disconnect()
        }
        assert.deepEqual(await client!.config('GET', 'maxmemory-policy'), [
          'maxmemory-policy',
          tuned.settings['maxmemory-policy'],
        ])
        assert.deepEqual(await client!.config('GET', 'appendonly'), [
          'appendonly',
          tuned.settings.appendonly,
        ])
        if (mode === 'cache') {
          await client!.config('SET', 'maxmemory', '2mb')
          for (let i = 0; i < 500; i++)
            await client!.set(`pressure:${i}`, 'x'.repeat(8192))
          assert.ok(
            Number(
              (await client!.info('stats')).match(/evicted_keys:(\d+)/)![1],
            ) > 0,
          )
        }
        await client!.set('persisted', 'fleet-engine-test')
        if (mode === 'durable') {
          await client!.config('SET', 'maxmemory', '1')
          await assert.rejects(client!.set('new-write', 'refused'), /OOM/)
          assert.equal(await client!.get('persisted'), 'fleet-engine-test')
        }
        client!.disconnect()
        client = undefined
        await docker('restart', name)
        await untilReady(async () => {
          client = await connect()
        })
        assert.equal(
          await client!.get('persisted'),
          mode === 'durable' ? 'fleet-engine-test' : null,
        )
      } finally {
        client?.disconnect()
        await docker('rm', '-f', '-v', name).catch(() => {})
        await rm(dir, { recursive: true, force: true })
      }
    },
  )
