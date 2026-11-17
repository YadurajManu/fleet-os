import test from 'node:test'
import assert from 'node:assert/strict'
import {
  databasesCommand,
  selectBackupTarget,
} from '../src/commands/databases.js'

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
