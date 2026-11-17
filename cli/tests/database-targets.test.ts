import test from 'node:test'
import assert from 'node:assert/strict'
import {
  databasesCommand,
  selectBackupTarget,
} from '../src/commands/databases.js'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const targets = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'primary' },
  { id: '11112222-1111-4222-8222-222222222222', name: 'nearby' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'archive' },
] as Parameters<typeof selectBackupTarget>[0]

test('backup target lookup accepts exact names and unique id prefixes', () => {
  assert.equal(selectBackupTarget(targets, 'primary'), targets[0])
  assert.equal(selectBackupTarget(targets, '22222222-2'), targets[2])
})

test('backup target lookup refuses missing and ambiguous selectors', () => {
  assert.throws(
    () => selectBackupTarget(targets, 'missing'),
    /No backup target/,
  )
  assert.throws(() => selectBackupTarget(targets, '1111'), /ambiguous/)
})

test('database backup creates an idempotent operation and lists its manifest', async () => {
  const originalFetch = globalThis.fetch
  const originalApi = process.env.FLEET_API
  const originalToken = process.env.FLEET_TOKEN
  const calls: Array<{ path: string; method: string; key: string | null }> = []
  process.env.FLEET_API = 'https://control.example.test'
  process.env.FLEET_TOKEN = 'access-token'
  globalThis.fetch = async (input, options) => {
    const path = String(input)
    const method = options?.method ?? 'GET'
    calls.push({
      path,
      method,
      key: new Headers(options?.headers).get('idempotency-key'),
    })
    const body = path.includes('/databases?')
      ? {
          databases: [
            {
              id: 'database-id',
              project: 'production',
              name: 'primary',
              nodeId: 'node-id',
              engine: 'postgres',
              version: '17',
              status: 'running',
              nodeName: 'node',
              backupConfigured: true,
            },
          ],
          nextCursor: null,
        }
      : method === 'POST'
        ? { backupId: 'backup-id', operationId: 'operation-id' }
        : {
            backups: [
              {
                id: 'backup-id',
                kind: 'logical',
                state: 'complete',
                sizeBytes: 2048,
                errorCode: null,
                createdAt: '2026-11-17T00:00:00Z',
                verifiedAt: '2026-11-17T00:01:00Z',
              },
            ],
          }
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })
  }
  const output: string[] = []
  const originalLog = console.log
  console.log = (...args) => output.push(args.join(' '))
  try {
    await databasesCommand.run(['backup', 'primary'], {
      fleet: 'fleet-id',
      project: 'production',
      'no-wait': true,
    })
    assert.ok(
      calls.some(
        (call) =>
          call.method === 'POST' && call.path.endsWith('/database-id/backups'),
      ),
    )
    assert.match(
      calls.find((call) => call.method === 'POST')?.key ?? '',
      /^[0-9a-f-]{36}$/,
    )
    assert.ok(
      calls.some(
        (call) =>
          call.method === 'GET' && call.path.endsWith('/database-id/backups'),
      ),
    )
    assert.match(output.join('\n'), /verified/)
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
    if (originalApi === undefined) delete process.env.FLEET_API
    else process.env.FLEET_API = originalApi
    if (originalToken === undefined) delete process.env.FLEET_TOKEN
    else process.env.FLEET_TOKEN = originalToken
  }
})

test('database backup download writes verified bytes with private permissions', async () => {
  const originalFetch = globalThis.fetch
  const originalApi = process.env.FLEET_API
  const originalToken = process.env.FLEET_TOKEN
  const root = await mkdtemp(join(tmpdir(), 'fleet-db-backup-download-'))
  const path = join(root, 'backup.dump')
  const calls: string[] = []
  process.env.FLEET_API = 'https://control.example.test'
  process.env.FLEET_TOKEN = 'access-token'
  globalThis.fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/databases?'))
      return new Response(
        JSON.stringify({
          databases: [
            {
              id: 'database-id',
              project: 'production',
              name: 'primary',
              nodeId: 'node-id',
              engine: 'postgres',
              version: '17',
              status: 'running',
              nodeName: 'node',
              backupConfigured: true,
            },
          ],
          nextCursor: null,
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    if (url.endsWith('/download'))
      return new Response(Buffer.from('PGDMP test'))
    return new Response(
      JSON.stringify({
        backups: [
          {
            id: 'backup-id',
            kind: 'logical',
            state: 'complete',
            sizeBytes: 10,
            errorCode: null,
            createdAt: '2026-11-17T00:00:00Z',
            verifiedAt: '2026-11-17T00:01:00Z',
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    await databasesCommand.run(
      ['backup', 'download', 'primary', 'backup-id', path],
      { fleet: 'fleet-id', project: 'production' },
    )
    assert.deepEqual(await readFile(path), Buffer.from('PGDMP test'))
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.ok(calls.some((url) => url.endsWith('/backup-id/download')))
  } finally {
    globalThis.fetch = originalFetch
    if (originalApi === undefined) delete process.env.FLEET_API
    else process.env.FLEET_API = originalApi
    if (originalToken === undefined) delete process.env.FLEET_TOKEN
    else process.env.FLEET_TOKEN = originalToken
    await rm(root, { recursive: true, force: true })
  }
})

test('database restore targets a separate running Postgres database', async () => {
  const originalFetch = globalThis.fetch
  const originalApi = process.env.FLEET_API
  const originalToken = process.env.FLEET_TOKEN
  let restorePath = ''
  let restoreBody: unknown
  process.env.FLEET_API = 'https://control.example.test'
  process.env.FLEET_TOKEN = 'access-token'
  globalThis.fetch = async (input, options) => {
    const path = String(input)
    if (path.includes('/databases?'))
      return new Response(
        JSON.stringify({
          databases: [
            {
              id: 'source-id',
              project: 'production',
              name: 'source',
              nodeId: 'node-id',
              engine: 'postgres',
              version: '17',
              status: 'running',
            },
            {
              id: 'target-id',
              project: 'production',
              name: 'target',
              nodeId: 'node-id',
              engine: 'postgres',
              version: '17',
              status: 'running',
            },
          ],
          nextCursor: null,
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    if (path.endsWith('/backups'))
      return new Response(
        JSON.stringify({
          backups: [
            {
              id: 'backup-id',
              kind: 'logical',
              state: 'complete',
              verifiedAt: '2026-11-17T00:00:00Z',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    restorePath = path
    restoreBody = JSON.parse(String(options?.body))
    return new Response(
      JSON.stringify({
        operationId: 'restore-operation',
        databaseId: 'target-id',
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    await databasesCommand.run(['restore', 'source', 'backup-id'], {
      fleet: 'fleet-id',
      project: 'production',
      into: 'target',
      'no-wait': true,
    })
    assert.ok(restorePath.endsWith('/source-id/backups/backup-id/restore'))
    assert.deepEqual(restoreBody, { targetDatabaseId: 'target-id' })
  } finally {
    globalThis.fetch = originalFetch
    if (originalApi === undefined) delete process.env.FLEET_API
    else process.env.FLEET_API = originalApi
    if (originalToken === undefined) delete process.env.FLEET_TOKEN
    else process.env.FLEET_TOKEN = originalToken
  }
})

test('database deletion requires a recent verified backup and exact name, then restores by name', async () => {
  const originalFetch = globalThis.fetch
  const originalApi = process.env.FLEET_API
  const originalToken = process.env.FLEET_TOKEN
  const calls: Array<{ path: string; method: string; body?: unknown }> = []
  let deleted = false
  process.env.FLEET_API = 'https://control.example.test'
  process.env.FLEET_TOKEN = 'access-token'
  globalThis.fetch = async (input, options) => {
    const path = String(input)
    const method = options?.method ?? 'GET'
    calls.push({
      path,
      method,
      ...(options?.body ? { body: JSON.parse(String(options.body)) } : {}),
    })
    const now = Date.now()
    const body = path.includes('/databases?')
      ? {
          databases: [
            {
              id: 'database-id',
              project: 'production',
              name: 'primary',
              nodeId: 'node-id',
              engine: 'postgres',
              version: '17',
              status: 'running',
              nodeName: 'node',
              backupConfigured: true,
              deletedAt: deleted ? new Date().toISOString() : null,
            },
          ],
          nextCursor: null,
        }
      : method === 'GET'
        ? {
            backups: [
              {
                id: 'verified-backup-id',
                kind: 'logical',
                state: 'complete',
                createdAt: new Date(now - 60_000).toISOString(),
                verifiedAt: new Date(now - 30_000).toISOString(),
              },
            ],
          }
        : path.endsWith('/delete')
          ? ((deleted = true),
            {
              database: { name: 'primary' },
              operation: {
                id: 'delete-operation',
                kind: 'delete',
                state: 'queued',
                progress: 0,
                errorCode: null,
              },
            })
          : { database: { name: 'primary', status: 'stopped' } }
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await databasesCommand.run(['delete', 'primary'], {
      fleet: 'fleet-id',
      project: 'production',
      backup: 'verified-backup',
      confirm: 'primary',
      'no-wait': true,
    })
    const deletion = calls.find((call) => call.path.endsWith('/delete'))
    assert.deepEqual(deletion?.body, {
      confirmation: 'primary',
      backupId: 'verified-backup-id',
    })
    await databasesCommand.run(['restore-deleted', 'primary'], {
      fleet: 'fleet-id',
      project: 'production',
    })
    assert.ok(calls.some((call) => call.path.endsWith('/restore-deleted')))
  } finally {
    globalThis.fetch = originalFetch
    if (originalApi === undefined) delete process.env.FLEET_API
    else process.env.FLEET_API = originalApi
    if (originalToken === undefined) delete process.env.FLEET_TOKEN
    else process.env.FLEET_TOKEN = originalToken
  }
})

test('target creation sends credentials only in the authenticated request body', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    api: process.env.FLEET_API,
    token: process.env.FLEET_TOKEN,
    access: process.env.FLEET_S3_ACCESS_KEY_ID,
    secret: process.env.FLEET_S3_SECRET_ACCESS_KEY,
  }
  let sentPath = ''
  let sentBody: unknown
  process.env.FLEET_API = 'https://control.example.test'
  process.env.FLEET_TOKEN = 'access-token'
  process.env.FLEET_S3_ACCESS_KEY_ID = 'access-key'
  process.env.FLEET_S3_SECRET_ACCESS_KEY = 'secret-key'
  globalThis.fetch = async (input, options) => {
    sentPath = String(input)
    sentBody = JSON.parse(String(options?.body))
    return new Response(
      JSON.stringify({
        id: 'target-id',
        name: 'archive',
        endpoint: 'https://s3.example.test',
        bucket: 'backups',
        prefix: '',
        region: 'us-east-1',
        isDefault: true,
        lastTestedAt: null,
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  const output: string[] = []
  const originalLog = console.log
  console.log = (...args) => output.push(args.join(' '))
  try {
    await databasesCommand.run(['target', 'add', 'production', 'archive'], {
      fleet: 'fleet-id',
      endpoint: 'https://s3.example.test',
      bucket: 'backups',
      region: 'us-east-1',
      default: true,
    })
    assert.match(
      sentPath,
      /\/fleets\/fleet-id\/projects\/production\/backup-targets$/,
    )
    assert.deepEqual(sentBody, {
      name: 'archive',
      endpoint: 'https://s3.example.test',
      bucket: 'backups',
      region: 'us-east-1',
      credentials: { accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
      isDefault: true,
    })
    assert.doesNotMatch(output.join('\n'), /access-key|secret-key/)
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
    for (const [key, value] of [
      ['FLEET_API', originalEnv.api],
      ['FLEET_TOKEN', originalEnv.token],
      ['FLEET_S3_ACCESS_KEY_ID', originalEnv.access],
      ['FLEET_S3_SECRET_ACCESS_KEY', originalEnv.secret],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('target assignment resolves scoped database and target names', async () => {
  const originalFetch = globalThis.fetch
  const originalApi = process.env.FLEET_API
  const originalToken = process.env.FLEET_TOKEN
  const calls: Array<{ path: string; method: string; body?: unknown }> = []
  process.env.FLEET_API = 'https://control.example.test'
  process.env.FLEET_TOKEN = 'access-token'
  globalThis.fetch = async (input, options) => {
    const path = new URL(String(input)).pathname
    const method = options?.method ?? 'GET'
    const body = options?.body ? JSON.parse(String(options.body)) : undefined
    calls.push({ path, method, body })
    const response = path.endsWith('/databases')
      ? {
          databases: [
            {
              id: 'database-id',
              project: 'production',
              name: 'primary',
            },
          ],
          nextCursor: null,
        }
      : path.endsWith('/backup-targets')
        ? {
            targets: [
              {
                id: 'target-id',
                name: 'archive',
              },
            ],
          }
        : { backupTargetId: 'target-id' }
    return new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await databasesCommand.run(
      ['target', 'assign', 'production', 'primary', 'archive'],
      { fleet: 'fleet-id' },
    )
    const assignment = calls.find((call) => call.method === 'PUT')
    assert.equal(
      assignment?.path,
      '/fleets/fleet-id/projects/production/databases/database-id/backup-target',
    )
    assert.deepEqual(assignment?.body, { targetId: 'target-id' })
  } finally {
    globalThis.fetch = originalFetch
    if (originalApi === undefined) delete process.env.FLEET_API
    else process.env.FLEET_API = originalApi
    if (originalToken === undefined) delete process.env.FLEET_TOKEN
    else process.env.FLEET_TOKEN = originalToken
  }
})
