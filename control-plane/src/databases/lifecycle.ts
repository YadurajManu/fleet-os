import { createHash, randomUUID } from 'node:crypto'
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../api/context.js'
import { ApiError } from '../api/errors.js'
import {
  databaseCredentials,
  databaseBackups,
  databaseBackupTargets,
  databaseOperations,
  nodes,
  tenantDatabases,
} from '../db/schema.js'
import { openSecret, sealSecret } from '../lib/crypto.js'
import { recordAudit } from '../lib/audit.js'
import { fleetSnapshot } from '../scheduler/snapshot.js'
import { nodePlatform } from '../build/platforms.js'
import {
  databaseEnginePlugin,
  databaseBackupPrefix,
  type EngineCredentials,
  type EngineOptions,
} from './engines.js'
import { resolveDatabaseImages } from './images.js'
import { placeDatabase } from './placement.js'
import { enqueueDatabaseOperation } from './operations.js'
import { requireDatabaseCapabilities } from './capabilities.js'

export const databaseCreateInput = z
  .object({
    name: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
    engine: z.enum(['postgres', 'redis']),
    version: z.string().optional(),
    mode: z.enum(['standard', 'cache', 'durable']).optional(),
    memoryMb: z.number().int().min(128).max(1048576).default(512),
    cpu: z.number().positive().max(1024).default(0.5),
    diskMb: z.number().int().min(1024).max(2147483647).default(10240),
    nodeId: z.string().uuid().optional(),
    profile: z.enum(['dev', 'standard', 'performance']).default('standard'),
  })
  .strict()
  .transform((input) => ({
    ...input,
    version: input.version ?? (input.engine === 'postgres' ? '17' : '7'),
    mode: input.mode ?? (input.engine === 'postgres' ? 'standard' : 'durable'),
  }))
export type DatabaseCreateInput = z.input<typeof databaseCreateInput>
const credential = z
  .object({ username: z.string().min(1), password: z.string().min(32) })
  .strict()

export const operationProjection = {
  id: databaseOperations.id,
  kind: databaseOperations.kind,
  state: databaseOperations.state,
  progress: databaseOperations.progress,
  errorCode: databaseOperations.errorCode,
  createdAt: databaseOperations.createdAt,
  finishedAt: databaseOperations.finishedAt,
}

export async function databaseView(
  ctx: AppContext,
  row: typeof tenantDatabases.$inferSelect,
) {
  const [node] = row.nodeId
    ? await ctx.db
        .select({ name: nodes.name, status: nodes.status })
        .from(nodes)
        .where(and(eq(nodes.id, row.nodeId), eq(nodes.fleetId, row.fleetId)))
    : []
  return {
    id: row.id,
    fleetId: row.fleetId,
    project: row.project,
    name: row.name,
    engine: row.engine,
    version: row.version,
    mode: row.mode,
    status: row.status,
    desiredState: row.desiredState,
    nodeId: row.nodeId,
    memoryMb: row.memoryMb,
    cpu: row.cpu,
    diskMb: row.diskMb,
    profile: row.profile,
    generation: row.generation,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    purgeAfter: row.purgeAfter,
    nodeName: node?.name ?? null,
    nodeStatus: node?.status ?? null,
    backupTargetId: row.backupTargetId,
    backupConfigured: row.backupTargetId !== null,
    warnings: [
      ...(row.backupTargetId
        ? []
        : [
            'No off-node backups are configured. Losing this node can lose this database.',
          ]),
      ...(row.engine === 'redis' && row.mode === 'cache'
        ? [
            'Cache mode has no persistence; keys can be evicted and are lost on restart.',
          ]
        : []),
      ...(row.engine === 'redis' && row.mode === 'durable'
        ? [
            'Durable mode refuses writes when its memory limit is reached; it does not silently evict data.',
          ]
        : []),
    ],
  }
}

export async function loadDatabase(
  ctx: AppContext,
  fleetId: string,
  project: string,
  id: string,
) {
  const [database] = await ctx.db
    .select()
    .from(tenantDatabases)
    .where(
      and(
        eq(tenantDatabases.id, id),
        eq(tenantDatabases.fleetId, fleetId),
        eq(tenantDatabases.project, project),
      ),
    )
  if (!database) throw ApiError.notFound('Database')
  return database
}

function registryAuth(ctx: AppContext): string {
  const credentials = ctx.config.REGISTRY_CREDENTIALS
  if (!credentials) return ''
  const separator = credentials.indexOf(':')
  if (separator < 1)
    throw ApiError.unavailable(
      'database_images_unavailable',
      'Private registry credentials are invalid. Repair the registry configuration and retry.',
    )
  return JSON.stringify({
    username: credentials.slice(0, separator),
    password: credentials.slice(separator + 1),
    serveraddress: ctx.config.REGISTRY_URL?.replace(/^https?:\/\//, '').replace(
      /\/$/,
      '',
    ),
  })
}

async function storedCredentials(
  ctx: AppContext,
  database: typeof tenantDatabases.$inferSelect,
): Promise<EngineCredentials> {
  const rows = await ctx.db
    .select()
    .from(databaseCredentials)
    .where(
      and(
        eq(databaseCredentials.databaseId, database.id),
        eq(databaseCredentials.generation, database.generation),
      ),
    )
  const credentials = {} as EngineCredentials
  for (const row of rows)
    credentials[row.role] = credential.parse(
      JSON.parse(openSecret(row.encryptedValue, ctx.config.SECRETS_MASTER_KEY)),
    )
  if (!credentials.owner || !credentials.app || !credentials.readonly)
    throw ApiError.unavailable(
      'database_credentials_unavailable',
      'Database credentials cannot be loaded. Inspect the resource before retrying.',
    )
  return credentials
}

export async function runtimeIntent(
  ctx: AppContext,
  database: typeof tenantDatabases.$inferSelect,
  images: { primary: string; pooler?: string },
  credentials: EngineCredentials,
  provision: boolean,
  configure = provision,
  requireConnected = true,
) {
  const [node] = await ctx.db
    .select()
    .from(nodes)
    .where(
      and(eq(nodes.id, database.nodeId!), eq(nodes.fleetId, database.fleetId)),
    )
  if (!node) throw ApiError.notFound('Database node')
  requireDatabaseCapabilities(node.databaseCapabilities, [
    'database.runtime.v1',
  ])
  if (requireConnected && !ctx.tunnels.has(node.id))
    throw ApiError.conflict(
      'database_node_unreachable',
      'The database node is disconnected. Data remains pinned there; reconnect the node or recover explicitly.',
    )
  const identity = {
    id: database.id,
    fleetId: database.fleetId,
    project: database.project,
    nodeId: node.id,
    generation: database.generation,
  }
  let backupTarget: EngineOptions['backupTarget']
  if (database.backupTargetId && database.engine === 'postgres') {
    const [target] = await ctx.db
      .select()
      .from(databaseBackupTargets)
      .where(
        and(
          eq(databaseBackupTargets.id, database.backupTargetId),
          eq(databaseBackupTargets.fleetId, database.fleetId),
          eq(databaseBackupTargets.project, database.project),
        ),
      )
      .limit(1)
    if (!target)
      throw ApiError.conflict(
        'backup_target_missing',
        'The configured backup target no longer exists. Assign another target before restarting this database.',
      )
    const backup = z
      .object({
        accessKeyId: z.string().min(1),
        secretAccessKey: z.string().min(1),
        sessionToken: z.string().optional(),
        encryptionKey: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .safeParse(
        JSON.parse(
          openSecret(
            target.encryptedCredentials,
            ctx.config.SECRETS_MASTER_KEY,
          ),
        ),
      )
    if (!backup.success)
      throw ApiError.conflict(
        'backup_target_key_unavailable',
        'The backup target has no recoverable encryption key. Recreate the target before restarting this database.',
      )
    backupTarget = {
      endpoint: target.endpoint,
      bucket: target.bucket,
      prefix: databaseBackupPrefix(
        target.prefix,
        database.fleetId,
        database.id,
        database.generation,
      ),
      region: target.region,
      credentials: backup.data,
      encryptionKey: backup.data.encryptionKey,
    }
  }
  const plugin = databaseEnginePlugin(database.engine)
  const plan = plugin.plan({
    id: database.id,
    fleetId: database.fleetId,
    project: database.project,
    name: database.name,
    version: database.version,
    mode: database.mode,
    allocation: {
      memoryMb: database.memoryMb,
      diskMb: database.diskMb,
      profile: database.profile,
      storage: node.tags.includes('storage:sd')
        ? 'sd'
        : node.tags.includes('storage:ssd')
          ? 'ssd'
          : 'unknown',
    },
    credentials,
    images,
    backupTarget,
    overrides: database.config,
  })
  return {
    identity,
    readiness: plan.readiness,
    ...(configure
      ? {
          containers: plan.containers.map((container) => ({
            initialize: provision,
            identity,
            network: plan.network,
            volume: database.volumeName,
            dataPath: plan.dataPath,
            platform: nodePlatform(node),
            cpu: database.cpu,
            container,
          })),
        }
      : {}),
    ...(provision
      ? {
          bootstrap: plan.bootstrap,
          registryAuth: registryAuth(ctx),
          reserveBytes: Math.max(1073741824, node.buildDiskReserveBytes),
          images: plan.containers.map((container) => ({
            reference: container.image,
            platform: nodePlatform(node),
            required_bytes:
              container.role === 'pooler'
                ? 268435456
                : database.engine === 'postgres'
                  ? 2147483648
                  : 536870912,
          })),
        }
      : {}),
  }
}

async function replayCreate(
  ctx: AppContext,
  fleetId: string,
  project: string,
  name: string,
  key: string,
  requestHash: string,
) {
  const [existing] = await ctx.db
    .select()
    .from(tenantDatabases)
    .where(
      and(
        eq(tenantDatabases.fleetId, fleetId),
        eq(tenantDatabases.project, project),
        eq(tenantDatabases.name, name),
      ),
    )
  if (existing) {
    const [operation] = await ctx.db
      .select()
      .from(databaseOperations)
      .where(
        and(
          eq(databaseOperations.databaseId, existing.id),
          eq(databaseOperations.idempotencyKey, key),
          eq(databaseOperations.kind, 'create'),
        ),
      )
    if (!operation)
      throw ApiError.conflict(
        'database_name_reserved',
        'This project already has a database with this name, including any deletion grace period.',
      )
    const original = JSON.parse(
      openSecret(operation.encryptedInput, ctx.config.SECRETS_MASTER_KEY),
    ) as { requestHash?: string }
    if (original.requestHash !== requestHash)
      throw ApiError.conflict(
        'idempotency_conflict',
        'This key belongs to different create input. Use a new key for the new request.',
      )
    return { database: existing, operationId: operation.id }
  }
  return null
}
async function publicOperation(
  ctx: AppContext,
  database: typeof tenantDatabases.$inferSelect,
  operationId: string,
) {
  const [operation] = await ctx.db
    .select(operationProjection)
    .from(databaseOperations)
    .where(
      and(
        eq(databaseOperations.id, operationId),
        eq(databaseOperations.databaseId, database.id),
      ),
    )
  if (!operation) throw ApiError.notFound('Database operation')
  return { database: await databaseView(ctx, database), operation }
}

export async function createDatabase(
  ctx: AppContext,
  fleetId: string,
  project: string,
  body: DatabaseCreateInput,
  key: string,
  actor: { orgId: string; userId: string },
) {
  const input = databaseCreateInput.parse(body),
    plugin = databaseEnginePlugin(input.engine)
  if (!plugin.versions.includes(input.version))
    throw ApiError.badRequest(
      'database_version_unsupported',
      'Choose an available database version from the catalog.',
    )
  if (
    (input.engine === 'postgres' && input.mode !== 'standard') ||
    (input.engine === 'redis' && input.mode === 'standard')
  )
    throw ApiError.badRequest(
      'database_mode_invalid',
      'Choose a mode supported by the selected engine.',
    )
  const requestHash = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
  const replay = await replayCreate(
    ctx,
    fleetId,
    project,
    input.name,
    key,
    requestHash,
  )
  if (replay) return publicOperation(ctx, replay.database, replay.operationId)
  const snapshot = await fleetSnapshot(ctx, fleetId)
  const decision = placeDatabase(
    {
      id: 'new',
      name: input.name,
      memoryMb: input.memoryMb,
      cpu: input.cpu,
      diskMb: input.diskMb,
      nodeId: input.nodeId,
    },
    snapshot.nodes,
  )
  if (decision.outcome !== 'placed')
    throw ApiError.unprocessable('database_no_eligible_node', decision.summary)
  const selected = snapshot.nodes.find((node) => node.id === decision.nodeId)!
  if (!ctx.tunnels.has(selected.id))
    throw ApiError.conflict(
      'database_node_unreachable',
      'The selected node is disconnected. Refresh placement and retry.',
    )
  const images = await resolveDatabaseImages(
    ctx.config,
    input.engine,
    input.version,
    nodePlatform(selected),
  )
  const id = randomUUID(),
    credentials = plugin.credentials()
  const created = await ctx.db
    .transaction(async (tx) => {
      await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.id, selected.id), eq(nodes.fleetId, fleetId)))
        .for('update')
      const local = { ...ctx, db: tx as unknown as AppContext['db'] }
      const duplicate = await replayCreate(
        local,
        fleetId,
        project,
        input.name,
        key,
        requestHash,
      )
      if (duplicate) return duplicate
      const current = await fleetSnapshot(local, fleetId)
      const checked = placeDatabase(
        {
          id,
          name: input.name,
          memoryMb: input.memoryMb,
          cpu: input.cpu,
          diskMb: input.diskMb,
          nodeId: selected.id,
        },
        current.nodes,
      )
      if (checked.outcome !== 'placed')
        throw ApiError.conflict(
          'database_capacity_changed',
          'Node capacity changed. Refresh placement and retry.',
        )
      const [database] = await tx
        .insert(tenantDatabases)
        .values({
          id,
          fleetId,
          project,
          name: input.name,
          engine: input.engine,
          version: input.version,
          mode: input.mode,
          memoryMb: input.memoryMb,
          cpu: input.cpu,
          diskMb: input.diskMb,
          nodeId: selected.id,
          profile: input.profile,
          volumeName: `fleet-db-${id}-data`,
          images,
        })
        .returning()
      await tx.insert(databaseCredentials).values(
        (['owner', 'app', 'readonly'] as const).map((role) => ({
          databaseId: id,
          role,
          encryptedValue: sealSecret(
            JSON.stringify(credentials[role]),
            ctx.config.SECRETS_MASTER_KEY,
          ),
          generation: 1,
        })),
      )
      const intent = {
        ...(await runtimeIntent(local, database!, images, credentials, true)),
        requestHash,
      }
      const operation = await enqueueDatabaseOperation(
        local,
        { fleetId, project, databaseId: id },
        'create',
        key,
        intent,
      )
      await recordAudit(tx, {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        action: 'database.create',
        targetType: 'database',
        targetId: id,
        metadata: { project, nodeId: selected.id, operationId: operation.id },
      })
      return { database: database!, operationId: operation.id }
    })
    .catch(async (error: unknown) => {
      const code =
        (error as { cause?: { code?: string }; code?: string })?.cause?.code ??
        (error as { code?: string })?.code
      if (code !== '23505') throw error
      const replay = await replayCreate(
        ctx,
        fleetId,
        project,
        input.name,
        key,
        requestHash,
      )
      if (replay) return replay
      throw ApiError.conflict(
        'database_conflict',
        'A database allocation changed concurrently. Refresh and retry.',
      )
    })
  return publicOperation(ctx, created.database, created.operationId)
}

export async function actOnDatabase(
  ctx: AppContext,
  database: typeof tenantDatabases.$inferSelect,
  action: 'start' | 'stop' | 'restart',
  key: string,
  actor: { orgId: string; userId: string },
) {
  const [replay] = await ctx.db
    .select(operationProjection)
    .from(databaseOperations)
    .where(
      and(
        eq(databaseOperations.databaseId, database.id),
        eq(databaseOperations.idempotencyKey, key),
      ),
    )
  if (replay) {
    if (replay.kind !== action)
      throw ApiError.conflict(
        'idempotency_conflict',
        'This key belongs to a different action. Use a new key.',
      )
    return { database: await databaseView(ctx, database), operation: replay }
  }
  if (database.deletedAt || database.status === 'deleting')
    throw ApiError.conflict(
      'database_deleting',
      'This database is in its deletion grace period. Restore it before operating it.',
    )
  if (!database.nodeId)
    throw ApiError.conflict(
      'database_unplaced',
      'The database has no data node. Recover it explicitly; a lifecycle action cannot choose a replacement node.',
    )
  const credentials = await storedCredentials(ctx, database)
  if (!database.images.primary)
    throw ApiError.conflict(
      'database_image_identity_missing',
      'The database image identity is missing. Reconcile the resource before retrying.',
    )
  const intent = await runtimeIntent(
    ctx,
    database,
    { primary: database.images.primary, pooler: database.images.pooler },
    credentials,
    false,
    action !== 'stop',
  )
  const operation = await enqueueDatabaseOperation(
    ctx,
    {
      fleetId: database.fleetId,
      project: database.project,
      databaseId: database.id,
    },
    action,
    key,
    intent,
  )
  await recordAudit(ctx.db, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    action: `database.${action}`,
    targetType: 'database',
    targetId: database.id,
    metadata: { operationId: operation.id, project: database.project },
  })
  const [safe] = await ctx.db
    .select(operationProjection)
    .from(databaseOperations)
    .where(eq(databaseOperations.id, operation.id))
  return {
    database: await databaseView(
      ctx,
      await loadDatabase(ctx, database.fleetId, database.project, database.id),
    ),
    operation: safe!,
  }
}

export async function deleteDatabase(
  ctx: AppContext,
  database: typeof tenantDatabases.$inferSelect,
  confirmation: string,
  backupId: string,
  key: string,
  actor: { orgId: string; userId: string },
) {
  const [replay] = await ctx.db
    .select()
    .from(databaseOperations)
    .where(
      and(
        eq(databaseOperations.databaseId, database.id),
        eq(databaseOperations.idempotencyKey, key),
      ),
    )
  if (replay) {
    let priorBackupId: string | undefined
    try {
      priorBackupId = JSON.parse(
        openSecret(replay.encryptedInput, ctx.config.SECRETS_MASTER_KEY),
      ).finalBackupId
    } catch {
      throw ApiError.conflict(
        'idempotency_conflict',
        'This key belongs to a different operation. Use a new key to delete this database.',
      )
    }
    if (replay.kind !== 'delete' || priorBackupId !== backupId)
      throw ApiError.conflict(
        'idempotency_conflict',
        'This key belongs to a different operation. Use a new key to delete this database.',
      )
    const [safe] = await ctx.db
      .select(operationProjection)
      .from(databaseOperations)
      .where(eq(databaseOperations.id, replay.id))
    return { database: await databaseView(ctx, database), operation: safe! }
  }
  if (confirmation !== database.name)
    throw ApiError.badRequest(
      'database_name_confirmation',
      'Type the exact database name to confirm deletion.',
    )
  if (database.deletedAt || !['running', 'stopped'].includes(database.status))
    throw ApiError.conflict(
      'database_unavailable',
      'Wait until the database is running or stopped before deleting it.',
    )
  if (!database.nodeId || !database.images.primary)
    throw ApiError.conflict(
      'database_identity_missing',
      'The database runtime identity is incomplete. Inspect it before deleting.',
    )
  const [backup] = await ctx.db
    .select({ id: databaseBackups.id })
    .from(databaseBackups)
    .where(
      and(
        eq(databaseBackups.id, backupId),
        eq(databaseBackups.databaseId, database.id),
        eq(databaseBackups.engine, database.engine),
        eq(databaseBackups.state, 'complete'),
        gt(databaseBackups.createdAt, new Date(Date.now() - 15 * 60 * 1000)),
        isNotNull(databaseBackups.verifiedAt),
        database.engine === 'postgres'
          ? eq(databaseBackups.kind, 'logical')
          : eq(databaseBackups.kind, 'rdb'),
      ),
    )
  if (!backup)
    throw ApiError.conflict(
      'database_final_backup_required',
      'Create and verify a final backup within the last 15 minutes before deleting this database.',
    )
  const credentials = await storedCredentials(ctx, database)
  const intent = await runtimeIntent(
    ctx,
    database,
    { primary: database.images.primary!, pooler: database.images.pooler },
    credentials,
    false,
    true,
  )
  const operation = await enqueueDatabaseOperation(
    ctx,
    {
      fleetId: database.fleetId,
      project: database.project,
      databaseId: database.id,
    },
    'delete',
    key,
    { ...intent, finalBackupId: backup.id },
    'deleting',
  )
  await recordAudit(ctx.db, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    action: 'database.delete',
    targetType: 'database',
    targetId: database.id,
    metadata: { operationId: operation.id, backupId: backup.id },
  })
  const [safe] = await ctx.db
    .select(operationProjection)
    .from(databaseOperations)
    .where(eq(databaseOperations.id, operation.id))
  return {
    database: await databaseView(
      ctx,
      await loadDatabase(ctx, database.fleetId, database.project, database.id),
    ),
    operation: safe!,
  }
}

export async function restoreDeletedDatabase(
  ctx: AppContext,
  database: typeof tenantDatabases.$inferSelect,
  actor: { orgId: string; userId: string },
) {
  if (
    !database.deletedAt ||
    !database.purgeAfter ||
    database.purgeAfter <= new Date() ||
    database.status !== 'deleting'
  )
    throw ApiError.conflict(
      'database_grace_period_expired',
      'This database is not inside its deletion grace period.',
    )
  const [restored] = await ctx.db
    .update(tenantDatabases)
    .set({
      status: 'stopped',
      desiredState: 'stopped',
      deletedAt: null,
      purgeAfter: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tenantDatabases.id, database.id),
        eq(tenantDatabases.status, 'deleting'),
        isNotNull(tenantDatabases.deletedAt),
        gt(tenantDatabases.purgeAfter, sql`clock_timestamp()`),
      ),
    )
    .returning()
  if (!restored)
    throw ApiError.conflict(
      'database_restore_raced',
      'Database deletion changed while restoring. Refresh the database and retry.',
    )
  await recordAudit(ctx.db, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    action: 'database.restored_from_deleted',
    targetType: 'database',
    targetId: database.id,
    metadata: { project: database.project },
  })
  return { database: await databaseView(ctx, restored) }
}
