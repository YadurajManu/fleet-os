import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  createContext,
  closeContext,
  type AppContext,
} from '../src/api/context.js'
import { loadConfig } from '../src/config.js'
import { buildServer } from '../src/server.js'
import { databaseBackupTargets, orgs, users } from '../src/db/schema.js'

const endpoint = process.env.FLEET_DB_MINIO_ENDPOINT!
const accessKeyId = process.env.FLEET_DB_MINIO_ACCESS_KEY!
const secretAccessKey = process.env.FLEET_DB_MINIO_SECRET_KEY!
const bucket = `fleet-db-${randomUUID()}`
const prefix = `probe-${randomUUID()}`
const unrelatedKey = 'unrelated/keep.txt'
let ctx: AppContext
let app: FastifyInstance
let fleetId = ''
let orgId = ''
let userId = ''
let accessToken = ''
let targetId = ''
const s3 = new S3Client({
  endpoint,
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: { accessKeyId, secretAccessKey },
  maxAttempts: 1,
})

before(async () => {
  assert.ok(
    endpoint && accessKeyId && secretAccessKey,
    'MinIO test credentials are missing',
  )
  ctx = createContext(loadConfig())
  app = await buildServer(ctx)
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      email: `database-backup-target-docker-${randomUUID()}@example.test`,
      password: 'database-backup-target-docker-password',
    },
  })
  assert.equal(signup.statusCode, 201, signup.body)
  const account = signup.json()
  fleetId = account.fleet.id
  orgId = account.org.id
  userId = account.user.id
  accessToken = account.accessToken
  await s3.send(new CreateBucketCommand({ Bucket: bucket }))
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: unrelatedKey,
      Body: 'preserve me',
    }),
  )
})

after(async () => {
  if (fleetId) {
    await app.close()
    if (targetId)
      await ctx.db
        .delete(databaseBackupTargets)
        .where(eq(databaseBackupTargets.id, targetId))
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await ctx.db.delete(users).where(eq(users.id, userId))
    await closeContext(ctx)
  }
  await s3
    .send(new DeleteObjectCommand({ Bucket: bucket, Key: unrelatedKey }))
    .catch(() => {})
  await s3.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {})
  s3.destroy()
})

test('target connectivity writes, reads, verifies and removes only its MinIO probe object', async () => {
  const base = `/fleets/${fleetId}/projects/backup-target-docker/backup-targets`
  const created = await app.inject({
    method: 'POST',
    url: base,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      name: 'minio',
      endpoint,
      bucket,
      prefix,
      credentials: { accessKeyId, secretAccessKey },
      isDefault: true,
    },
  })
  assert.equal(created.statusCode, 201, created.body)
  assert.equal(created.body.includes(accessKeyId), false)
  assert.equal(created.body.includes(secretAccessKey), false)
  targetId = created.json().id

  const tested = await app.inject({
    method: 'POST',
    url: `${base}/${targetId}/test`,
    headers: { authorization: `Bearer ${accessToken}` },
  })
  assert.equal(tested.statusCode, 200, tested.body)
  assert.equal(tested.json().ok, true)
  assert.equal(tested.body.includes(accessKeyId), false)
  assert.equal(tested.body.includes(secretAccessKey), false)

  const probeObjects = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${prefix}/.fleet-test/`,
    }),
  )
  assert.equal(probeObjects.KeyCount, 0)
  const preserved = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: unrelatedKey }),
  )
  assert.equal(await preserved.Body!.transformToString(), 'preserve me')

  const [target] = await ctx.db
    .select()
    .from(databaseBackupTargets)
    .where(eq(databaseBackupTargets.id, targetId))
  assert.ok(target!.lastTestedAt)
})
