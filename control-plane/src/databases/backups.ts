import {
  createCipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { PassThrough, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { z } from 'zod'
import type { AppContext } from '../api/context.js'
import { ApiError } from '../api/errors.js'
import {
  databaseBackupTargets,
  databaseBackups,
  databaseCredentials,
  databaseOperationEvents,
  databaseOperations,
  tenantDatabases,
} from '../db/schema.js'
import { recordAudit } from '../lib/audit.js'
import { openSecret, sealSecret } from '../lib/crypto.js'
import type { EngineCommand } from './engines.js'
import type { DatabaseIdentity, DatabaseTunnel } from './tunnel.js'

const targetCredentials = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().optional(),
})

async function uploadStream(
  client: S3Client,
  bucket: string,
  key: string,
  body: PassThrough,
  signal: AbortSignal,
) {
  const { UploadId } = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: 'application/octet-stream',
    }),
    { abortSignal: signal },
  )
  if (!UploadId) throw new Error('backup_upload_session_missing')
  const parts: Array<{ ETag: string; PartNumber: number }> = []
  const limit = 8 * 1024 * 1024
  let chunks: Buffer[] = []
  let bytes = 0
  let partNumber = 1
  const sendPart = async (data: Buffer) => {
    const result = await client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        PartNumber: partNumber,
        Body: data,
        ContentLength: data.length,
      }),
      { abortSignal: signal },
    )
    if (!result.ETag) throw new Error('backup_upload_part_missing_etag')
    parts.push({ ETag: result.ETag, PartNumber: partNumber++ })
  }
  try {
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk))
      bytes += chunk.length
      if (bytes >= limit) {
        await sendPart(Buffer.concat(chunks, bytes))
        chunks = []
        bytes = 0
      }
    }
    if (bytes) await sendPart(Buffer.concat(chunks, bytes))
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        MultipartUpload: { Parts: parts },
      }),
      { abortSignal: signal },
    )
  } catch (error) {
    await client
      .send(
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId }),
      )
      .catch(() => {})
    throw error
  }
}

export async function createDatabaseBackup(
  ctx: AppContext,
  scope: { fleetId: string; project: string; databaseId: string },
  key: string,
  actor: { orgId: string; userId: string },
) {
  return ctx.db.transaction(async (tx) => {
    const [database] = await tx
      .select()
      .from(tenantDatabases)
      .where(
        and(
          eq(tenantDatabases.id, scope.databaseId),
          eq(tenantDatabases.fleetId, scope.fleetId),
          eq(tenantDatabases.project, scope.project),
        ),
      )
      .for('update')
    if (!database) throw ApiError.notFound('Database')
    const existing = await tx
      .select()
      .from(databaseOperations)
      .where(
        and(
          eq(databaseOperations.databaseId, database.id),
          eq(databaseOperations.idempotencyKey, key),
        ),
      )
      .limit(1)
    if (existing[0]) {
      const inputHash = createHmac(
        'sha256',
        Buffer.from(ctx.config.SECRETS_MASTER_KEY, 'base64'),
      )
        .update(`backup\n${JSON.stringify({ databaseId: database.id })}`)
        .digest('hex')
      if (existing[0].kind !== 'backup' || existing[0].inputHash !== inputHash)
        throw ApiError.conflict(
          'idempotency_conflict',
          'This Idempotency-Key belongs to another request. Use a new key.',
        )
      return {
        backupId: JSON.parse(
          openSecret(existing[0].encryptedInput, ctx.config.SECRETS_MASTER_KEY),
        ).backupId,
        operationId: existing[0].id,
      }
    }
    if (database.deletedAt || database.status !== 'running' || !database.nodeId)
      throw ApiError.conflict(
        'database_not_running',
        'Start the database and wait for it to become healthy before creating a backup.',
      )
    if (!database.backupTargetId)
      throw ApiError.conflict(
        'backup_target_missing',
        'Assign and test a backup target before creating a backup.',
      )
    const [target] = await tx
      .select()
      .from(databaseBackupTargets)
      .where(
        and(
          eq(databaseBackupTargets.id, database.backupTargetId),
          eq(databaseBackupTargets.fleetId, scope.fleetId),
          eq(databaseBackupTargets.project, scope.project),
        ),
      )
    if (!target)
      throw ApiError.conflict(
        'backup_target_missing',
        'The configured backup target no longer exists. Assign another target, then retry.',
      )
    const backupId = randomUUID()
    const payload = JSON.stringify({
      backupId,
      identity: {
        id: database.id,
        fleetId: database.fleetId,
        nodeId: database.nodeId,
        project: database.project,
        generation: database.generation,
      },
    })
    const inputHash = createHmac(
      'sha256',
      Buffer.from(ctx.config.SECRETS_MASTER_KEY, 'base64'),
    )
      .update(`backup\n${JSON.stringify({ databaseId: database.id })}`)
      .digest('hex')
    const active = await tx
      .select({ id: databaseOperations.id })
      .from(databaseOperations)
      .where(
        and(
          eq(databaseOperations.databaseId, database.id),
          inArray(databaseOperations.state, [
            'queued',
            'running',
            'reconciling',
          ]),
        ),
      )
      .limit(1)
    if (active.length)
      throw ApiError.conflict(
        'database_busy',
        'A database operation is running. Wait for it to finish, then retry.',
      )
    const [operation] = await tx
      .insert(databaseOperations)
      .values({
        databaseId: database.id,
        kind: 'backup',
        idempotencyKey: key,
        inputHash,
        encryptedInput: sealSecret(payload, ctx.config.SECRETS_MASTER_KEY),
        generation: database.generation,
      })
      .returning()
    await tx
      .insert(databaseOperationEvents)
      .values({ operationId: operation!.id, code: 'queued', progress: 0 })
    await tx.insert(databaseBackups).values({
      id: backupId,
      databaseId: database.id,
      targetId: target.id,
      operationId: operation!.id,
      nodeId: database.nodeId,
      generation: database.generation,
      engine: database.engine,
      engineVersion: database.version,
      kind: database.engine === 'postgres' ? 'logical' : 'rdb',
      objectPrefix: `${target.prefix ? `${target.prefix}/` : ''}databases/${database.id}/${backupId}`,
      label: 'manual',
    })
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'database.backup.created',
      targetType: 'database',
      targetId: database.id,
      metadata: {
        backupId,
        operationId: operation!.id,
        project: database.project,
      },
    })
    return { backupId, operationId: operation!.id }
  })
}

export async function listDatabaseBackups(
  ctx: AppContext,
  scope: { fleetId: string; project: string; databaseId: string },
) {
  const [database] = await ctx.db
    .select({ id: tenantDatabases.id })
    .from(tenantDatabases)
    .where(
      and(
        eq(tenantDatabases.id, scope.databaseId),
        eq(tenantDatabases.fleetId, scope.fleetId),
        eq(tenantDatabases.project, scope.project),
      ),
    )
  if (!database) throw ApiError.notFound('Database')
  return ctx.db
    .select()
    .from(databaseBackups)
    .where(eq(databaseBackups.databaseId, database.id))
    .orderBy(asc(databaseBackups.createdAt))
}

export async function runDatabaseBackup(
  ctx: AppContext,
  tunnel: DatabaseTunnel,
  backupId: string,
  database: typeof tenantDatabases.$inferSelect,
  identity: DatabaseIdentity,
  signal: AbortSignal,
  progress: (step: string, value: number) => Promise<void>,
) {
  const [backup] = await ctx.db
    .select()
    .from(databaseBackups)
    .where(
      and(
        eq(databaseBackups.id, backupId),
        eq(databaseBackups.databaseId, database.id),
        eq(databaseBackups.generation, database.generation),
      ),
    )
  if (backup?.state === 'complete') return
  const [target] = backup?.targetId
    ? await ctx.db
        .select()
        .from(databaseBackupTargets)
        .where(eq(databaseBackupTargets.id, backup.targetId))
    : []
  if (!backup || !target || database.status !== 'running')
    throw new Error('backup_identity_changed')
  await ctx.db
    .update(databaseBackups)
    .set({ state: 'running', errorCode: null, startedAt: new Date() })
    .where(eq(databaseBackups.id, backup.id))
  const credentials = targetCredentials.parse(
    JSON.parse(
      openSecret(target.encryptedCredentials, ctx.config.SECRETS_MASTER_KEY),
    ),
  )
  const [role] = await ctx.db
    .select()
    .from(databaseCredentials)
    .where(
      and(
        eq(databaseCredentials.databaseId, database.id),
        eq(databaseCredentials.role, 'owner'),
      ),
    )
  if (!role) throw new Error('backup_credentials_missing')
  const dbCredentials = JSON.parse(
    openSecret(role.encryptedValue, ctx.config.SECRETS_MASTER_KEY),
  ) as { username: string; password: string }
  const command: EngineCommand =
    database.engine === 'postgres'
      ? {
          command: [
            'pg_dump',
            '--format=custom',
            '--no-owner',
            '--no-acl',
            '--host=127.0.0.1',
            '--port=5432',
            `--username=${dbCredentials.username}`,
            database.name.replaceAll('-', '_'),
          ],
          env: { PGPASSWORD: dbCredentials.password },
        }
      : {
          command: [
            'redis-cli',
            '--user',
            dbCredentials.username,
            '--rdb',
            '/dev/stdout',
          ],
          env: {
            REDISCLI_AUTH: dbCredentials.password,
            FLEET_DB_BACKUP: '1',
          },
        }
  const stream = tunnel.open(
    { identity, role: 'database', timeoutMs: 60 * 60 * 1000, command },
    signal,
  )
  let exitCode: number | undefined
  const exited = new Promise<void>((resolve) =>
    stream.once('exit', (code: number) => {
      exitCode = code
      resolve()
    }),
  )
  await new Promise<void>((resolve, reject) => {
    stream.once('ready', () => resolve())
    stream.once('error', reject)
  })
  await progress('streaming', 30)
  const key = `${backup.objectPrefix}/data.enc`
  const nonce = randomBytes(12)
  const encryptionKey = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(ctx.config.SECRETS_MASTER_KEY, 'base64'),
      Buffer.from(backup.id),
      Buffer.from('fleet-database-backup-v1'),
      32,
    ),
  )
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce)
  const checksum = createHash('sha256')
  let sizeBytes = 0
  const encrypted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length
      checksum.update(chunk)
      callback(null, chunk)
    },
    flush(callback) {
      const tag = cipher.getAuthTag()
      sizeBytes += tag.length
      checksum.update(tag)
      callback(null, tag)
    },
  })
  const body = new PassThrough({ highWaterMark: 65536 })
  const client = new S3Client({
    endpoint: target.endpoint,
    forcePathStyle: true,
    region: target.region,
    credentials,
    maxAttempts: 2,
  })
  const upload = uploadStream(client, target.bucket, key, body, signal)
  let uploaded = false
  let failureCode = 'backup_upload_failed'
  const transfer = (async () => {
    const header = Buffer.concat([Buffer.from('FLEETDB1'), nonce])
    sizeBytes += header.length
    checksum.update(header)
    if (!body.write(header))
      await new Promise<void>((resolve) => body.once('drain', resolve))
    await pipeline(stream, cipher, encrypted, body, { signal })
  })()
  try {
    await Promise.all([transfer, upload])
    uploaded = true
    await exited
    if (exitCode !== 0) {
      failureCode = 'backup_command_failed'
      throw new Error(failureCode)
    }
    failureCode = 'backup_verification_read_failed'
    await progress('verify', 90)
    const checksumSha256 = checksum.digest('hex')
    const object = await client.send(
      new GetObjectCommand({ Bucket: target.bucket, Key: key }),
      { abortSignal: signal },
    )
    if (!object.Body) throw new Error('backup_verification_body_missing')
    const downloadedChecksum = createHash('sha256')
    let downloadedBytes = 0
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length
        downloadedChecksum.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(object.Body as NodeJS.ReadableStream, verifier, { signal })
    failureCode = 'backup_verification_checksum_failed'
    if (downloadedBytes !== sizeBytes) {
      failureCode = 'backup_verification_size_mismatch'
      throw new Error(failureCode)
    }
    if (downloadedChecksum.digest('hex') !== checksumSha256) {
      failureCode = 'backup_verification_checksum_mismatch'
      throw new Error(failureCode)
    }
    failureCode = 'backup_manifest_commit_failed'
    await ctx.db
      .update(databaseBackups)
      .set({
        state: 'complete',
        manifest: [{ key, sizeBytes, checksumSha256 }],
        sizeBytes,
        checksumSha256,
        recoveryPoint: {
          format: 'fleet-aes-256-gcm-v1',
          nonce: nonce.toString('base64'),
        },
        startedAt: backup.startedAt ?? new Date(),
        finishedAt: new Date(),
        verifiedAt: new Date(),
      })
      .where(eq(databaseBackups.id, backup.id))
    failureCode = 'backup_progress_commit_failed'
    await progress('commit', 100)
  } catch (error) {
    stream.destroy(error as Error)
    body.destroy(error as Error)
    if (uploaded)
      await client
        .send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key }))
        .catch(() => {})
    await ctx.db
      .update(databaseBackups)
      .set({
        state: 'failed',
        errorCode: failureCode,
        finishedAt: new Date(),
      })
      .where(eq(databaseBackups.id, backup.id))
    throw error
  } finally {
    client.destroy()
    encryptionKey.fill(0)
  }
}
