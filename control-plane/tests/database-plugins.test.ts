import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  databaseEnginePlugin,
  databaseBackupPrefix,
  postgresEngine,
  redisEngine,
  type EngineOptions,
} from '../src/databases/engines.js'
import {
  databaseImageTags,
  resolveDatabaseImages,
} from '../src/databases/images.js'

function options(engine: 'postgres' | 'redis'): EngineOptions {
  return {
    id: randomUUID(),
    fleetId: randomUUID(),
    project: 'test',
    name: 'primary-db',
    version: engine === 'postgres' ? '17' : '7',
    mode: engine === 'postgres' ? 'standard' : 'durable',
    allocation: { memoryMb: 512, diskMb: 10240 },
    credentials: databaseEnginePlugin(engine).credentials(),
    images: {
      primary: `sha256:${'a'.repeat(64)}`,
      pooler: `sha256:${'b'.repeat(64)}`,
    },
  }
}

test('engine catalog rejects unsupported engines and mutable image references', () => {
  assert.equal(databaseEnginePlugin('postgres'), postgresEngine)
  assert.throws(() => databaseEnginePlugin('mysql'), {
    code: 'invalid_database_engine',
  })
  const input = options('postgres')
  for (const value of [
    { ...input, version: '15' },
    { ...input, name: 'bad\nsetting' },
    { ...input, images: { primary: 'postgres:17' } },
    { ...input, mode: 'cache' as const },
  ]) {
    assert.throws(() => postgresEngine.plan(value), {
      code: 'invalid_database_engine',
    })
  }
})

test('private image namespaces validate versions and refuse an unconfigured catalog', async () => {
  assert.deepEqual(
    databaseImageTags('registry.example.test:5000', 'postgres', '17'),
    {
      primary: 'registry.example.test:5000/fleet-databases/postgres:17',
      pooler: 'registry.example.test:5000/fleet-databases/pgbouncer:1',
    },
  )
  for (const prefix of [
    'https://registry.example.test',
    'user:password@registry.example.test',
    'registry.test/../escape',
  ])
    assert.throws(() => databaseImageTags(prefix, 'redis', '7'), {
      code: 'invalid_database_image_catalog',
    })
  await assert.rejects(
    resolveDatabaseImages({}, 'postgres', '17', 'linux/arm64'),
    { code: 'database_images_unavailable' },
  )
})

test('Postgres plans isolate projects, restrict roles and separate pool/direct endpoints', () => {
  const input = options('postgres'),
    plan = postgresEngine.plan(input)
  assert.equal(plan.containers.length, 2)
  assert.notEqual(
    plan.network,
    postgresEngine.plan({ ...input, project: 'other' }).network,
  )
  assert.ok(plan.bootstrap)
  assert.match(plan.bootstrap.stdin!, /ALTER DEFAULT PRIVILEGES/)
  assert.match(plan.bootstrap.stdin!, /NOSUPERUSER NOCREATEDB NOCREATEROLE/)
  for (const container of plan.containers) {
    for (const cred of Object.values(input.credentials))
      assert.ok(!JSON.stringify(container.command).includes(cred.password))
    for (const config of container.files.filter((f) => f.secret))
      assert.equal(config.mode, 0o600)
  }
  const pooled = new URL(postgresEngine.connection(input, 'app'))
  assert.equal(pooled.port, '6432')
  assert.equal(pooled.searchParams.get('pgbouncer'), 'true')
  assert.equal(
    new URL(postgresEngine.connection(input, 'owner', true)).port,
    '5432',
  )
  assert.throws(() => postgresEngine.connection(input, 'owner'), {
    code: 'invalid_database_engine',
  })
  assert.ok(
    !JSON.stringify(plan.readiness.command).includes(
      input.credentials.owner.password,
    ),
  )
  assert.equal(
    plan.containers.reduce((sum, c) => sum + c.memoryMb, 0),
    512,
  )
})

test('Postgres WAL archive plan keeps object credentials and encryption key in secret files', () => {
  const input = options('postgres')
  input.backupTarget = {
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'fleet-backups',
    prefix: 'project/db',
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret-value',
      sessionToken: 'test-session-token',
    },
    encryptionKey: 'a'.repeat(64),
  }
  const database = postgresEngine.plan(input).containers[0]!
  const config = database.files.find(
    (entry) => entry.path === '/etc/fleet/postgresql.conf',
  )!
  assert.match(config.content, /archive_mode = on/)
  assert.match(config.content, /archive_timeout = '60s'/)
  assert.match(config.content, /archive_command = 'wal-g wal-push %p'/)
  assert.match(config.content, /restore_command = 'wal-g wal-fetch %f %p'/)
  assert.equal(database.env.WALG_S3_PREFIX, 's3://fleet-backups/project/db')
  assert.equal(database.env.AWS_ENDPOINT, input.backupTarget.endpoint)
  assert.ok(!JSON.stringify(database.env).includes('test-secret-value'))
  assert.ok(!JSON.stringify(database.command).includes('test-access'))
  for (const path of [
    '/etc/fleet/aws-credentials',
    '/etc/fleet/walg-key',
    '/etc/fleet/walg.pgpass',
  ]) {
    const secret = database.files.find((entry) => entry.path === path)!
    assert.equal(secret.secret, true)
    assert.equal(secret.mode, 0o600)
  }
  assert.match(
    database.files.find((entry) => entry.path === '/etc/fleet/aws-credentials')!
      .content,
    /aws_session_token=test-session-token/,
  )
  assert.equal(database.env.PGPASSFILE, '/etc/fleet/walg.pgpass')
  assert.ok(
    !JSON.stringify(database.env).includes(input.credentials.owner.password),
  )
  const withoutTarget = postgresEngine.plan(options('postgres')).containers[0]!
  assert.equal(withoutTarget.env.WALG_S3_PREFIX, undefined)
  assert.doesNotMatch(
    withoutTarget.files.find(
      (entry) => entry.path === '/etc/fleet/postgresql.conf',
    )!.content,
    /archive_mode = on/,
  )
})

test('WAL-G storage prefixes isolate fleets, databases and runtime generations', () => {
  assert.equal(
    databaseBackupPrefix('tenant-backups', 'fleet-a', 'db-one', 1),
    'tenant-backups/databases/fleet-a/db-one/generation-1',
  )
  assert.notEqual(
    databaseBackupPrefix('', 'fleet-a', 'db-one', 1),
    databaseBackupPrefix('', 'fleet-a', 'db-two', 1),
  )
  assert.notEqual(
    databaseBackupPrefix('', 'fleet-a', 'db-one', 1),
    databaseBackupPrefix('', 'fleet-a', 'db-one', 2),
  )
})

test('Redis enforces hashed role ACLs without passwords in process arguments', () => {
  const input = options('redis'),
    plan = redisEngine.plan(input),
    container = plan.containers[0]!
  const acl = container.files.find((f) => f.path.endsWith('users.acl'))!
  assert.match(acl.content, /user default off/)
  assert.match(acl.content, /fleet_readonly.*\+@read \+@connection -@dangerous/)
  for (const cred of Object.values(input.credentials)) {
    assert.ok(!acl.content.includes(cred.password))
    assert.ok(!JSON.stringify(container.command).includes(cred.password))
    assert.ok(!JSON.stringify(plan.readiness.command).includes(cred.password))
  }
  assert.equal(
    new URL(redisEngine.connection(input, 'readonly')).username,
    'fleet_readonly',
  )
  assert.equal(redisEngine.backup(input).type, 'redis-rdb')
  assert.throws(() => redisEngine.backup({ ...input, mode: 'cache' }), {
    code: 'invalid_database_engine',
  })
  assert.throws(
    () =>
      redisEngine.restore(input, {
        backup: 'snapshot',
        to: { type: 'time', value: new Date().toISOString() },
      }),
    { code: 'invalid_database_engine' },
  )
})

test('restore targets are validated and portable dumps never contain credentials in arguments', () => {
  const input = options('postgres')
  const restored = postgresEngine.restore(input, {
    backup: 'LATEST',
    to: { type: 'time', value: '2026-11-16T01:00:00Z' },
  })
  assert.equal(restored.type, 'wal-g')
  if (restored.type === 'wal-g')
    assert.equal(restored.recovery.recovery_target_time, '2026-11-16T01:00:00Z')
  assert.throws(
    () => postgresEngine.restore(input, { backup: 'LATEST;rm -rf /' }),
    { code: 'invalid_database_engine' },
  )
  assert.throws(
    () =>
      postgresEngine.restore(input, {
        backup: 'LATEST',
        to: { type: 'name', value: "bad'\ninclude" },
      }),
    { code: 'invalid_database_engine' },
  )
  assert.deepEqual(postgresEngine.export(input).command, [
    'pg_dump',
    '--format=custom',
    '--no-owner',
    '--no-acl',
  ])
  assert.equal(postgresEngine.import(input).type, 'pg-restore')
  assert.match(
    postgresEngine.extension(input, 'vector', true).stdin!,
    /CREATE EXTENSION IF NOT EXISTS "vector"/,
  )
  assert.match(
    postgresEngine.extension(input, 'vector', false).stdin!,
    /RESTRICT/,
  )
  assert.throws(
    () => postgresEngine.extension(input, 'vector; DROP TABLE users', true),
    { code: 'invalid_database_engine' },
  )
  for (const command of [
    postgresEngine.export(input),
    postgresEngine.metrics(input),
  ])
    assert.ok(
      !JSON.stringify(command.command).includes(
        input.credentials.owner.password,
      ),
    )
})

test('metric parsers reject invalid responses and Redis drops unsupported private fields', () => {
  assert.deepEqual(postgresEngine.parseMetrics('{"size_bytes":42}'), {
    size_bytes: 42,
  })
  assert.deepEqual(
    postgresEngine.parseMetrics('{"size_bytes":42,"password":"secret"}'),
    { size_bytes: 42 },
  )
  assert.throws(() => postgresEngine.parseMetrics('broken'), {
    code: 'invalid_database_engine',
  })
  assert.throws(() => postgresEngine.parseMetrics('[]'), {
    code: 'invalid_database_engine',
  })
  assert.deepEqual(
    redisEngine.parseMetrics(
      '# Memory\r\nused_memory:42\r\nmaster_auth:secret\r\naof_last_write_status:ok\r\n',
    ),
    { used_memory: 42, aof_last_write_status: 'ok' },
  )
  assert.throws(() => redisEngine.parseMetrics('invalid'), {
    code: 'invalid_database_engine',
  })
  assert.throws(
    () => redisEngine.parseMetrics('aof_last_write_status:secret'),
    { code: 'invalid_database_engine' },
  )
})
