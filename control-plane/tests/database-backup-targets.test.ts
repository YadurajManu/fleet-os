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
  databaseBackups,
  databaseBackupTargets,
  databaseOperations,
  nodes,
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
let backupDatabaseId = ''
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
  if (backupDatabaseId)
    await ctx.db
      .delete(databaseBackups)
      .where(eq(databaseBackups.databaseId, backupDatabaseId))
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
  const failedProbe = await app.inject({
    method: 'POST',
    url: `${url}/${firstTarget.id}/test`,
    headers: auth,
  })
  assert.equal(failedProbe.statusCode, 503)
  assert.equal(failedProbe.body.includes(accessKeyId), false)
  assert.equal(failedProbe.body.includes(secretAccessKey), false)

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

  const databaseId = (backupDatabaseId = randomUUID())
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
  })
  const targetPath = `/fleets/${fleetId}/projects/${project}/databases/${databaseId}/backup-target`
  const assigned = await app.inject({
    method: 'PUT',
    url: targetPath,
    headers: auth,
    payload: { targetId: second.json().id },
  })
  assert.equal(assigned.statusCode, 200, assigned.body)
  assert.equal(assigned.json().backupTargetId, second.json().id)
  const detail = await app.inject({
    url: `/fleets/${fleetId}/projects/${project}/databases/${databaseId}`,
    headers: auth,
  })
  assert.equal(detail.json().database.backupConfigured, true)

  const backupNodeId = randomUUID()
  await ctx.db.insert(nodes).values({
    id: backupNodeId,
    fleetId,
    name: `backup-test-${backupNodeId.slice(0, 8)}`,
    arch: 'amd64',
    cpuCores: 2,
    ramMb: 4096,
    diskMb: 100000,
    agentTokenHash: randomUUID(),
  })
  await ctx.db
    .update(tenantDatabases)
    .set({ status: 'running', nodeId: backupNodeId })
    .where(eq(tenantDatabases.id, databaseId))
  const backupsUrl = `/fleets/${fleetId}/projects/${project}/databases/${databaseId}/backups`
  const backupKey = randomUUID()
  const queuedBackup = await app.inject({
    method: 'POST',
    url: backupsUrl,
    headers: { ...auth, 'idempotency-key': backupKey },
  })
  assert.equal(queuedBackup.statusCode, 202, queuedBackup.body)
  assert.equal(queuedBackup.body.includes(accessKeyId), false)
  assert.equal(queuedBackup.body.includes(secretAccessKey), false)
  const replayedBackup = await app.inject({
    method: 'POST',
    url: backupsUrl,
    headers: { ...auth, 'idempotency-key': backupKey },
  })
  assert.equal(replayedBackup.statusCode, 202)
  assert.deepEqual(replayedBackup.json(), queuedBackup.json())
  const [backupOperation] = await ctx.db
    .select()
    .from(databaseOperations)
    .where(eq(databaseOperations.id, queuedBackup.json().operationId))
  assert.equal(
    JSON.stringify(backupOperation!.encryptedInput).includes(secretAccessKey),
    false,
  )

  const foreignTarget = await app.inject({
    method: 'POST',
    url: `/fleets/${fleetId}/projects/other-project/backup-targets`,
    headers: auth,
    payload: payload('foreign'),
  })
  const rejectedAssignment = await app.inject({
    method: 'PUT',
    url: targetPath,
    headers: auth,
    payload: { targetId: foreignTarget.json().id },
  })
  assert.equal(rejectedAssignment.statusCode, 404)
  const [backup] = await ctx.db
    .insert(databaseBackups)
    .values({
      databaseId,
      targetId: second.json().id,
      generation: 1,
      engine: 'postgres',
      engineVersion: '16',
      kind: 'base',
      state: 'complete',
      objectPrefix: 'tenant-data/backup-1',
      manifest: [
        {
          key: 'tenant-data/backup-1/base.tar',
          sizeBytes: 123,
          checksumSha256: 'a'.repeat(64),
        },
      ],
      sizeBytes: 123,
      checksumSha256: 'a'.repeat(64),
      recoveryPoint: { lsn: '0/16B6C50' },
    })
    .returning()
  assert.equal(backup!.manifest.length, 1)

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
  const [retainedBackup] = await ctx.db
    .select()
    .from(databaseBackups)
    .where(eq(databaseBackups.id, backup!.id))
  assert.equal(retainedBackup!.targetId, null)
  assert.equal(retainedBackup!.state, 'complete')
  const detached = await app.inject({
    method: 'PUT',
    url: targetPath,
    headers: auth,
    payload: { targetId: null },
  })
  assert.equal(detached.statusCode, 200, detached.body)
  assert.equal(detached.json().backupTargetId, null)
})
