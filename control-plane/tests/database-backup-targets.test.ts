import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  createContext,
  closeContext,
  type AppContext,
} from '../src/api/context.js'
import { loadConfig } from '../src/config.js'
import { buildServer } from '../src/server.js'
import {
  databaseBackupTargets,
  orgs,
  tenantDatabases,
  users,
} from '../src/db/schema.js'
import { openSecret } from '../src/lib/crypto.js'

let ctx: AppContext
let app: FastifyInstance
let fleetId = ''
let orgId = ''
let userId = ''
let accessToken = ''
const project = 'backup-target-test'
const accessKeyId = `minio-${randomUUID()}`
const secretAccessKey = `secret-${randomUUID()}`

before(async () => {
  ctx = createContext(loadConfig())
  app = await buildServer(ctx)
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      email: `database-backup-target-${randomUUID()}@example.test`,
      password: 'database-backup-target-test-password',
    },
  })
  assert.equal(signup.statusCode, 201, signup.body)
  const account = signup.json()
  fleetId = account.fleet.id
  orgId = account.org.id
  userId = account.user.id
  accessToken = account.accessToken
})

after(async () => {
  await app.close()
  await ctx.db
    .delete(tenantDatabases)
    .where(eq(tenantDatabases.fleetId, fleetId))
  await ctx.db
    .delete(databaseBackupTargets)
    .where(eq(databaseBackupTargets.fleetId, fleetId))
  await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
  await ctx.db.delete(users).where(eq(users.id, userId))
  await closeContext(ctx)
})

test('backup targets are project scoped, encrypted, audited and safely removable', async () => {
  const url = `/fleets/${fleetId}/projects/${project}/backup-targets`
  const auth = { authorization: `Bearer ${accessToken}` }
  const credentials = { accessKeyId, secretAccessKey }
  const payload = (name: string) => ({
    name,
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'fleet-backups',
    prefix: 'tenant-data',
    credentials,
    isDefault: true,
  })

  const rejectedHttp = await app.inject({
    method: 'POST',
    url,
    headers: auth,
    payload: { ...payload('unsafe'), endpoint: 'http://example.com:9000' },
  })
  assert.equal(rejectedHttp.statusCode, 400)

  const first = await app.inject({
    method: 'POST',
    url,
    headers: auth,
    payload: payload('first'),
  })
  assert.equal(first.statusCode, 201, first.body)
  assert.equal(first.body.includes(accessKeyId), false)
  assert.equal(first.body.includes(secretAccessKey), false)
  const firstTarget = first.json()
  assert.equal(firstTarget.isDefault, true)

  const stored = await ctx.db
    .select()
    .from(databaseBackupTargets)
    .where(eq(databaseBackupTargets.id, firstTarget.id))
  assert.equal(
    JSON.stringify(stored[0]!.encryptedCredentials).includes(secretAccessKey),
    false,
  )
  assert.deepEqual(
    JSON.parse(
      openSecret(
        stored[0]!.encryptedCredentials,
        ctx.config.SECRETS_MASTER_KEY,
      ),
    ),
    credentials,
  )

  const second = await app.inject({
    method: 'POST',
    url,
    headers: auth,
    payload: payload('second'),
  })
  assert.equal(second.statusCode, 201, second.body)
  assert.equal(second.json().isDefault, true)
  const defaults = await ctx.db
    .select()
    .from(databaseBackupTargets)
    .where(eq(databaseBackupTargets.fleetId, fleetId))
  assert.deepEqual(
    defaults.map((target) => [target.name, target.isDefault]),
    [
      ['first', false],
      ['second', true],
    ],
  )

  const otherProject = await app.inject({
    url: `/fleets/${fleetId}/projects/other-project/backup-targets`,
    headers: auth,
  })
  assert.deepEqual(otherProject.json().targets, [])
  const list = await app.inject({ url, headers: auth })
  assert.equal(list.statusCode, 200)
  assert.equal(list.body.includes(accessKeyId), false)
  assert.equal(list.body.includes(secretAccessKey), false)

  const databaseId = randomUUID()
  await ctx.db.insert(tenantDatabases).values({
    id: databaseId,
    fleetId,
    project,
    name: 'target-linked-db',
    engine: 'postgres',
    version: '16',
    volumeName: `fleet-db-${databaseId}`,
    memoryMb: 512,
    cpu: 0.5,
    diskMb: 1024,
    backupTargetId: second.json().id,
  })
  const wrongProjectDelete = await app.inject({
    method: 'DELETE',
    url: `/fleets/${fleetId}/projects/other-project/backup-targets/${second.json().id}`,
    headers: auth,
  })
  assert.equal(wrongProjectDelete.statusCode, 404)

  const deleted = await app.inject({
    method: 'DELETE',
    url: `${url}/${second.json().id}`,
    headers: auth,
  })
  assert.equal(deleted.statusCode, 200)
  const [database] = await ctx.db
    .select()
    .from(tenantDatabases)
    .where(eq(tenantDatabases.id, databaseId))
  assert.equal(database!.backupTargetId, null)
})
