import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { PassThrough, Readable, Transform } from 'node:stream'
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
import { runtimeIntent } from './lifecycle.js'
import { enqueueDatabaseOperation } from './operations.js'
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
  actor: {
    orgId: string
    userId?: string | null
    actorKind?: 'user' | 'system'
  },
  options: { kind?: 'base' | 'logical' | 'rdb'; label?: string } = {},
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
    const kind =
      options.kind ?? (database.engine === 'postgres' ? 'logical' : 'rdb')
    if (
      (database.engine === 'postgres' &&
        kind !== 'base' &&
        kind !== 'logical') ||
      (database.engine === 'redis' && kind !== 'rdb')
    )
      throw ApiError.badRequest(
        'database_backup_kind_invalid',
        'Choose a backup type supported by this database engine.',
      )
    const input =
      kind === (database.engine === 'postgres' ? 'logical' : 'rdb')
        ? { databaseId: database.id }
        : { databaseId: database.id, kind }
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
        .update(`backup\n${JSON.stringify(input)}`)
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
      .update(`backup\n${JSON.stringify(input)}`)
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
      kind,
      objectPrefix: `${target.prefix ? `${target.prefix}/` : ''}databases/${database.id}/${backupId}`,
      label: options.label ?? 'manual',
    })
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      actorKind: actor.actorKind,
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

export async function createDatabaseRestore(
  ctx: AppContext,
  scope: { fleetId: string; project: string; databaseId: string },
  targetDatabaseId: string,
  backupId: string,
  key: string,
  actor: { orgId: string; userId: string },
  recoveryTarget?: { type: 'time' | 'name'; value: string },
  confirmation?: string,
) {
  const [source] = await ctx.db
    .select()
    .from(tenantDatabases)
    .where(
      and(
        eq(tenantDatabases.id, scope.databaseId),
        eq(tenantDatabases.fleetId, scope.fleetId),
        eq(tenantDatabases.project, scope.project),
      ),
    )
  if (!source) throw ApiError.notFound('Database')
  const [backup] = await ctx.db
    .select()
    .from(databaseBackups)
    .where(
      and(
        eq(databaseBackups.id, backupId),
        eq(databaseBackups.databaseId, source.id),
      ),
    )
  if (
    !backup ||
    backup.engine !== 'postgres' ||
    backup.generation !== source.generation ||
    backup.state !== 'complete' ||
    !backup.verifiedAt
  )
    throw ApiError.conflict(
      'database_backup_unverified',
      'Choose a completed, verified PostgreSQL backup.',
    )
  const [target] = await ctx.db
    .select()
    .from(tenantDatabases)
    .where(
      and(
        eq(tenantDatabases.id, targetDatabaseId),
        eq(tenantDatabases.fleetId, scope.fleetId),
        eq(tenantDatabases.project, scope.project),
      ),
    )
  if (!target) throw ApiError.notFound('Restore target database')
  if (target.engine !== 'postgres')
    throw ApiError.badRequest(
      'restore_engine_mismatch',
      'Restore the PostgreSQL backup into a PostgreSQL database.',
    )
  if (backup.kind === 'base') {
    const recoveryPoint = z
      .object({
        format: z.literal('wal-g-v1'),
        backupName: z.string().regex(/^base_[A-Za-z0-9_-]{1,180}$/),
      })
      .passthrough()
      .safeParse(backup.recoveryPoint)
    if (
      !recoveryPoint.success ||
      !backup.targetId ||
      source.backupTargetId !== backup.targetId
    )
      throw ApiError.conflict(
        'database_backup_unavailable',
        'The base backup target or recovery metadata is no longer available. Reconnect its original backup target before restoring.',
      )
    if (target.version !== source.version)
      throw ApiError.badRequest(
        'restore_version_mismatch',
        'Restore a PostgreSQL base backup into a database with the same major version.',
      )
    if (target.id === source.id && confirmation !== source.name)
      throw ApiError.badRequest(
        'restore_confirmation_required',
        'Confirm an in-place base restore with the exact database name.',
      )
    if (
      recoveryTarget?.type === 'time' &&
      !z.iso.datetime({ offset: true }).safeParse(recoveryTarget.value).success
    )
      throw ApiError.badRequest(
        'restore_target_invalid',
        'Use an ISO timestamp with a timezone.',
      )
    if (
      recoveryTarget?.type === 'name' &&
      !/^[A-Za-z0-9_-]{1,63}$/.test(recoveryTarget.value)
    )
      throw ApiError.badRequest(
        'restore_target_invalid',
        'Use a valid named PostgreSQL restore point.',
      )
  } else if (
    backup.kind !== 'logical' ||
    recoveryTarget ||
    targetDatabaseId === source.id
  ) {
    throw ApiError.badRequest(
      'database_backup_kind_invalid',
      'Choose a logical backup for a dump restore, or a base backup for point-in-time recovery.',
    )
  }
  if (target.status !== 'running' || !target.nodeId)
    throw ApiError.conflict(
      'database_unavailable',
      'Start the target database and wait until it is running before restoring.',
    )
  return enqueueDatabaseOperation(
    ctx,
    { fleetId: scope.fleetId, project: scope.project, databaseId: target.id },
    'restore',
    key,
    {
      sourceDatabaseId: source.id,
      backupId,
      ...(recoveryTarget ? { recoveryTarget } : {}),
      actorOrgId: actor.orgId,
      actorUserId: actor.userId,
      identity: {
        id: target.id,
        fleetId: target.fleetId,
        project: target.project,
        nodeId: target.nodeId,
        generation: target.generation,
      },
    },
    'restoring',
  )
}

export async function downloadDatabaseBackup(
  ctx: AppContext,
  scope: { fleetId: string; project: string; databaseId: string },
  backupId: string,
  actor: { orgId: string; userId: string },
  action = 'database.backup.downloaded',
) {
  const [backup] = await ctx.db
    .select()
    .from(databaseBackups)
    .where(
      and(
        eq(databaseBackups.id, backupId),
        eq(databaseBackups.databaseId, scope.databaseId),
      ),
    )
  if (!backup) throw ApiError.notFound('Database backup')
  const [entry] = backup.manifest
  if (
    backup.state !== 'complete' ||
    !backup.verifiedAt ||
    !backup.checksumSha256 ||
    !backup.sizeBytes ||
    !entry ||
    entry.key !== `${backup.objectPrefix}/data.enc` ||
    entry.checksumSha256 !== backup.checksumSha256 ||
    entry.sizeBytes !== backup.sizeBytes
  )
    throw ApiError.conflict(
      'database_backup_unverified',
      'This backup has no verified downloadable artifact.',
    )
  const [target] = backup.targetId
    ? await ctx.db
        .select()
        .from(databaseBackupTargets)
        .where(
          and(
            eq(databaseBackupTargets.id, backup.targetId),
            eq(databaseBackupTargets.fleetId, scope.fleetId),
            eq(databaseBackupTargets.project, scope.project),
          ),
        )
    : []
  if (!target)
    throw ApiError.conflict(
      'database_backup_target_unavailable',
      'The backup target is no longer available. Reconnect or restore the configured target before downloading this backup.',
    )
  const credentials = targetCredentials.parse(
    JSON.parse(
      openSecret(target.encryptedCredentials, ctx.config.SECRETS_MASTER_KEY),
    ),
  )
  const client = new S3Client({
    endpoint: target.endpoint,
    forcePathStyle: true,
    region: target.region,
    credentials,
    maxAttempts: 2,
  })
  let object
  try {
    object = await client.send(
      new GetObjectCommand({ Bucket: target.bucket, Key: entry.key }),
    )
  } catch {
    client.destroy()
    throw ApiError.unavailable(
      'database_backup_unavailable',
      'The backup artifact could not be read from its target. Check the target and retry.',
    )
  }
  if (!object.Body) {
    client.destroy()
    throw ApiError.unavailable(
      'database_backup_unavailable',
      'The backup target returned no artifact. Check the target and retry.',
    )
  }
  await recordAudit(ctx.db, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    action,
    targetType: 'database',
    targetId: scope.databaseId,
    metadata: { backupId, project: scope.project },
  })
  const encryptionKey = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(ctx.config.SECRETS_MASTER_KEY, 'base64'),
      Buffer.from(backup.id),
      Buffer.from('fleet-database-backup-v1'),
      32,
    ),
  )
  const checksum = createHash('sha256')
  let sizeBytes = 0
  const body = async function* () {
    let header = Buffer.alloc(0)
    let tail = Buffer.alloc(0)
    let decipher: ReturnType<typeof createDecipheriv> | undefined
    try {
      for await (const raw of object.Body as NodeJS.ReadableStream) {
        const chunk = Buffer.from(raw as Uint8Array)
        checksum.update(chunk)
        sizeBytes += chunk.length
        let data = chunk
        if (!decipher) {
          header = Buffer.concat([header, chunk])
          if (header.length < 20) continue
          const nonce = header.subarray(8, 20)
          const recordedNonce = Buffer.from(
            String(backup.recoveryPoint.nonce ?? ''),
            'base64',
          )
          if (
            header.subarray(0, 8).toString() !== 'FLEETDB1' ||
            nonce.length !== 12 ||
            !nonce.equals(recordedNonce)
          )
            throw new Error('database_backup_header_invalid')
          decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce)
          data = header.subarray(20)
          header = Buffer.alloc(0)
        }
        const ciphertext = Buffer.concat([tail, data])
        if (ciphertext.length <= 16) {
          tail = ciphertext
          continue
        }
        const encrypted = ciphertext.subarray(0, ciphertext.length - 16)
        tail = ciphertext.subarray(ciphertext.length - 16)
        const plaintext = decipher.update(encrypted)
        if (plaintext.length) yield plaintext
      }
      if (
        !decipher ||
        header.length ||
        tail.length !== 16 ||
        sizeBytes !== backup.sizeBytes ||
        checksum.digest('hex') !== backup.checksumSha256
      )
        throw new Error('database_backup_checksum_invalid')
      const authenticatedDecipher = decipher as ReturnType<
        typeof createDecipheriv
      > & { setAuthTag(tag: Buffer): void }
      authenticatedDecipher.setAuthTag(tail)
      const final = authenticatedDecipher.final()
      if (final.length) yield final
    } finally {
      encryptionKey.fill(0)
      client.destroy()
    }
  }
  return {
    stream: Readable.from(body()),
    filename: `fleet-database-${backup.id}.dump`,
  }
}

export async function runDatabaseRestore(
  ctx: AppContext,
  tunnel: DatabaseTunnel,
  sourceDatabaseId: string,
  backupId: string,
  target: typeof tenantDatabases.$inferSelect,
  identity: DatabaseIdentity,
  recoveryTarget: { type: 'time' | 'name'; value: string } | undefined,
  actor: { orgId: string; userId: string },
  signal: AbortSignal,
  progress: (step: string, value: number) => Promise<void>,
) {
  const [source] = await ctx.db
    .select()
    .from(tenantDatabases)
    .where(
      and(
        eq(tenantDatabases.id, sourceDatabaseId),
        eq(tenantDatabases.fleetId, target.fleetId),
        eq(tenantDatabases.project, target.project),
      ),
    )
  const [backup] = await ctx.db
    .select()
    .from(databaseBackups)
    .where(
      and(
        eq(databaseBackups.id, backupId),
        eq(databaseBackups.databaseId, sourceDatabaseId),
      ),
    )
  if (
    !source ||
    source.engine !== 'postgres' ||
    target.engine !== 'postgres' ||
    (source.id === target.id && backup?.kind !== 'base') ||
    target.status !== 'restoring' ||
    !backup ||
    backup.engine !== 'postgres' ||
    !['logical', 'base'].includes(backup.kind) ||
    backup.state !== 'complete' ||
    !backup.verifiedAt
  )
    throw new Error('restore_identity_changed')

  const [role] = await ctx.db
    .select()
    .from(databaseCredentials)
    .where(
      and(
        eq(databaseCredentials.databaseId, target.id),
        eq(databaseCredentials.generation, target.generation),
        eq(databaseCredentials.role, 'owner'),
      ),
    )
  if (!role) throw new Error('restore_credentials_missing')
  const credentials = JSON.parse(
    openSecret(role.encryptedValue, ctx.config.SECRETS_MASTER_KEY),
  ) as { username: string; password: string }
  const targetCredentialRows = await ctx.db
    .select()
    .from(databaseCredentials)
    .where(
      and(
        eq(databaseCredentials.databaseId, target.id),
        eq(databaseCredentials.generation, target.generation),
      ),
    )
  const targetCredentials = Object.fromEntries(
    targetCredentialRows.map((item) => [
      item.role,
      JSON.parse(
        openSecret(item.encryptedValue, ctx.config.SECRETS_MASTER_KEY),
      ),
    ]),
  ) as {
    owner: { username: string; password: string }
    app: { username: string; password: string }
    readonly: { username: string; password: string }
  }
  const databaseName = target.name.replaceAll('-', '_')
  const command = (args: string[]) => ({
    command: args,
    env: { PGPASSWORD: credentials.password },
  })
  const emptyCheck = tunnel.open(
    {
      identity,
      role: 'database',
      timeoutMs: 60 * 60 * 1000,
      command: command([
        'psql',
        '-X',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-h',
        '127.0.0.1',
        '-U',
        credentials.username,
        '-d',
        databaseName,
        '-c',
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('r','p','v','m','S','f') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e');",
      ]),
    },
    signal,
  )
  let checkExit: number | undefined
  emptyCheck.once('exit', (code: number) => (checkExit = code))
  const checkOutput: Buffer[] = []
  for await (const chunk of emptyCheck) checkOutput.push(Buffer.from(chunk))
  if (
    !(backup.kind === 'base' && source.id === target.id) &&
    (checkExit !== 0 || Buffer.concat(checkOutput).toString().trim() !== '0')
  )
    throw new Error('restore_target_not_empty')

  if (backup.kind === 'base') {
    if (!backup.targetId || source.backupTargetId !== backup.targetId)
      throw new Error('restore_backup_target_changed')
    const recoveryPoint = z
      .object({
        format: z.literal('wal-g-v1'),
        backupName: z.string().regex(/^base_[A-Za-z0-9_-]{1,180}$/),
      })
      .passthrough()
      .parse(backup.recoveryPoint)
    const runtime = async (
      database: typeof tenantDatabases.$inferSelect,
      connected: boolean,
    ) => {
      const rows = await ctx.db
        .select()
        .from(databaseCredentials)
        .where(
          and(
            eq(databaseCredentials.databaseId, database.id),
            eq(databaseCredentials.generation, database.generation),
          ),
        )
      const credentials = Object.fromEntries(
        rows.map((item) => [
          item.role,
          JSON.parse(
            openSecret(item.encryptedValue, ctx.config.SECRETS_MASTER_KEY),
          ),
        ]),
      ) as {
        owner: { username: string; password: string }
        app: { username: string; password: string }
        readonly: { username: string; password: string }
      }
      const images = database.images
      if (!images.primary || !images.pooler)
        throw new Error('restore_images_missing')
      return runtimeIntent(
        ctx,
        database,
        { primary: images.primary, pooler: images.pooler },
        credentials,
        false,
        true,
        connected,
      )
    }
    const [sourceRuntime, targetRuntime] = await Promise.all([
      runtime(source, false),
      runtime(target, true),
    ])
    const sourceContainer = sourceRuntime.containers?.find(
      (item) => item.container.role === 'database',
    )
    if (!sourceContainer) throw new Error('restore_source_plan_missing')
    await progress('execute', 30)
    const restoringIntoAnotherDatabase = source.id !== target.id
    const sourceName = source.name.replaceAll('-', '_')
    const targetName = target.name.replaceAll('-', '_')
    const sourceOwner = restoringIntoAnotherDatabase
      ? (JSON.parse(
          openSecret(
            (
              await ctx.db
                .select()
                .from(databaseCredentials)
                .where(
                  and(
                    eq(databaseCredentials.databaseId, source.id),
                    eq(databaseCredentials.generation, source.generation),
                    eq(databaseCredentials.role, 'owner'),
                  ),
                )
            )[0]!.encryptedValue,
            ctx.config.SECRETS_MASTER_KEY,
          ),
        ) as { username: string; password: string })
      : null
    const recoveryOwner = sourceOwner ?? credentials
    const sourceReadiness = {
      command: [
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        recoveryOwner.username,
        '-d',
        'postgres',
        '-c',
        "DO $$ BEGIN IF pg_is_in_recovery() THEN RAISE EXCEPTION 'recovery not complete'; END IF; END $$",
      ],
      env: { PGPASSWORD: recoveryOwner.password },
    }
    const postCommands: Array<{
      command: string[]
      env: Record<string, string>
      stdin: string
    }> = sourceOwner
      ? [
          {
            command: [
              'psql',
              '-X',
              '-v',
              'ON_ERROR_STOP=1',
              '-h',
              '127.0.0.1',
              '-U',
              sourceOwner.username,
              '-d',
              'postgres',
            ],
            env: { PGPASSWORD: sourceOwner.password },
            stdin: `ALTER DATABASE "${sourceName}" RENAME TO "${targetName}";`,
          },
          {
            command: [
              'psql',
              '-X',
              '-v',
              'ON_ERROR_STOP=1',
              '-h',
              '127.0.0.1',
              '-U',
              sourceOwner.username,
              '-d',
              targetName,
            ],
            env: { PGPASSWORD: sourceOwner.password },
            stdin: [
              `ALTER ROLE fleet_owner PASSWORD '${targetCredentials.owner.password}';`,
              `ALTER ROLE fleet_app PASSWORD '${targetCredentials.app.password}';`,
              `ALTER ROLE fleet_readonly PASSWORD '${targetCredentials.readonly.password}';`,
            ].join('\n'),
          },
        ]
      : []
    await tunnel.runOperation(
      {
        ...targetRuntime,
        id: randomUUID(),
        action: 'restore',
        readiness: sourceReadiness,
        restore: {
          backupName: recoveryPoint.backupName,
          ...(recoveryTarget?.type === 'time'
            ? { targetTime: recoveryTarget.value }
            : {}),
          ...(recoveryTarget?.type === 'name'
            ? { targetName: recoveryTarget.value }
            : {}),
          env: sourceContainer.container.env,
          files: sourceContainer.container.files,
          ...(restoringIntoAnotherDatabase
            ? {
                postCommands,
                finalReadiness: targetRuntime.readiness,
              }
            : {}),
        },
      },
      signal,
    )
    await progress('verify', 95)
    return
  }
  if (recoveryTarget) throw new Error('restore_target_invalid')

  await progress('execute', 30)
  const { stream } = await downloadDatabaseBackup(
    ctx,
    { fleetId: source.fleetId, project: source.project, databaseId: source.id },
    backupId,
    actor,
    'database.backup.restored',
  )
  const restore = tunnel.open(
    {
      identity,
      role: 'database',
      timeoutMs: 60 * 60 * 1000,
      command: command([
        'pg_restore',
        '--dbname',
        databaseName,
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        '--single-transaction',
        '--host=127.0.0.1',
        '--port=5432',
        `--username=${credentials.username}`,
      ]),
    },
    signal,
  )
  await new Promise<void>((resolve, reject) => {
    restore.once('ready', resolve)
    restore.once('error', reject)
  })
  const exited = new Promise<number>((resolve) => restore.once('exit', resolve))
  await pipeline(stream, restore, { signal })
  if ((await exited) !== 0) throw new Error('restore_command_failed')
  await progress('verify', 95)
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
  if (backup.kind === 'base') {
    try {
      if (database.engine !== 'postgres')
        throw new Error('backup_engine_mismatch')
      const run = async (args: string[]) => {
        const stream = tunnel.open(
          {
            identity,
            role: 'database',
            timeoutMs: 60 * 60 * 1000,
            command: {
              command: args,
              env: { AWS_ENDPOINT: target.endpoint, PGUSER: 'fleet_owner' },
            },
          },
          signal,
        )
        let exitCode: number | undefined
        const exited = new Promise<void>((resolve) =>
          stream.once('exit', (code: number) => {
            exitCode = code
            resolve()
          }),
        )
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of stream) {
          size += chunk.length
          if (size > 1024 * 1024) {
            stream.destroy(new Error('wal_g_output_too_large'))
            throw new Error('wal_g_output_too_large')
          }
          chunks.push(Buffer.from(chunk))
        }
        await exited
        if (exitCode !== 0) throw new Error('wal_g_command_failed')
        return Buffer.concat(chunks, size).toString('utf8')
      }
      const readBackups = async () => {
        const output = await run(['wal-g', 'backup-list', '--json'])
        const parsed = z
          .array(
            z
              .object({
                backup_name: z.string().regex(/^base_[A-Za-z0-9_-]{1,180}$/),
                start_time: z.string().optional(),
                finish_time: z.string().optional(),
              })
              .passthrough(),
          )
          .safeParse(JSON.parse(output))
        if (!parsed.success) throw new Error('wal_g_backup_list_invalid')
        return parsed.data
      }
      const before = new Set(
        (await readBackups()).map((item) => item.backup_name),
      )
      await progress('backup', 30)
      await run(['wal-g', 'backup-push', '/var/lib/postgresql/data/pgdata'])
      await progress('verify', 90)
      const created = (await readBackups()).find(
        (item) => !before.has(item.backup_name),
      )
      if (!created) throw new Error('wal_g_backup_not_visible')
      await ctx.db
        .update(databaseBackups)
        .set({
          state: 'complete',
          recoveryPoint: {
            format: 'wal-g-v1',
            backupName: created.backup_name,
            ...(created.start_time ? { startTime: created.start_time } : {}),
            ...(created.finish_time ? { finishTime: created.finish_time } : {}),
          },
          startedAt: backup.startedAt ?? new Date(),
          finishedAt: new Date(),
          verifiedAt: new Date(),
        })
        .where(eq(databaseBackups.id, backup.id))
      await progress('commit', 100)
    } catch (error) {
      await ctx.db
        .update(databaseBackups)
        .set({
          state: 'failed',
          errorCode: 'base_backup_failed',
          finishedAt: new Date(),
        })
        .where(eq(databaseBackups.id, backup.id))
      throw error
    }
    return
  }
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
