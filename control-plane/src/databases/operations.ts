import { createHmac, randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../api/context.js'
import { ApiError } from '../api/errors.js'
import { databaseOperationEvents as events, databaseOperations as operations, tenantDatabases } from '../db/schema.js'
import { openSecret, sealSecret } from '../lib/crypto.js'

type Context = Pick<AppContext, 'db' | 'config'>
export type DatabaseScope = { fleetId: string; project: string; databaseId: string }
export type Operation = typeof operations.$inferSelect
export type OperationKind = Operation['kind']
export const OPERATION_LEASE_MS = 30_000
export const MAX_OPERATION_ATTEMPTS = 3
const active = ['queued', 'running', 'reconciling'] as const
const idempotencyKey = z.string().min(1).max(128)
const checkpointSchema = z.object({
  step: z.enum(['inspect', 'prepare', 'execute', 'verify', 'commit']),
  resourceId: z.string().uuid().optional(),
  completed: z.boolean().optional(),
}).strict()
export type OperationCheckpoint = z.infer<typeof checkpointSchema>
export type OperationFailure = 'runtime_failed' | 'agent_disconnected' | 'deadline_exceeded' | 'retry_limit' | 'generation_changed'
const failureSchema = z.enum(['runtime_failed', 'agent_disconnected', 'deadline_exceeded', 'retry_limit', 'generation_changed'])

// Canonical JSON makes retry identity independent of object key insertion order.
function canonical(value: unknown, depth = 0): string {
  if (depth > 16) throw ApiError.badRequest('invalid_operation_input', 'Operation input is too deeply nested. Reduce it and retry.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(',')}]`
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`
  }
  throw ApiError.badRequest('invalid_operation_input', 'Operation input must be finite JSON data. Correct the input and retry.')
}

const scopedDatabase = (scope: DatabaseScope) => and(
  eq(tenantDatabases.id, scope.databaseId), eq(tenantDatabases.fleetId, scope.fleetId), eq(tenantDatabases.project, scope.project),
)

/** Authorization happens at the route; scope is also enforced on every resource lookup. */
export async function enqueueDatabaseOperation(
  ctx: Context, scope: DatabaseScope, kind: OperationKind, key: string, input: unknown,
): Promise<Operation> {
  if (!idempotencyKey.safeParse(key).success) throw ApiError.badRequest('invalid_idempotency_key', 'Provide an Idempotency-Key containing 1–128 characters, then retry.')
  const encoded = canonical(input)
  if (Buffer.byteLength(encoded) > 65536) throw ApiError.badRequest('operation_input_too_large', 'Operation input exceeds 64 KiB. Reduce it and retry.')
  const inputHash = createHmac('sha256', Buffer.from(ctx.config.SECRETS_MASTER_KEY, 'base64')).update(`${kind}\n${encoded}`).digest('hex')
  return ctx.db.transaction(async tx => {
    const [database] = await tx.select().from(tenantDatabases).where(scopedDatabase(scope)).for('update')
    if (!database) throw ApiError.notFound('Database')
    const [existing] = await tx.select().from(operations).where(and(eq(operations.databaseId, database.id), eq(operations.idempotencyKey, key)))
    if (existing) {
      if (existing.inputHash !== inputHash) throw ApiError.conflict('idempotency_conflict', 'This Idempotency-Key belongs to different input. Use a new key for the new action.')
      return existing
    }
    const [busy] = await tx.select({ id: operations.id }).from(operations).where(and(eq(operations.databaseId, database.id), inArray(operations.state, [...active])))
    if (busy) throw ApiError.conflict('database_busy', `Database operation ${busy.id} is still active. Follow that operation before submitting another action.`)
    const [operation] = await tx.insert(operations).values({
      databaseId: database.id, kind, idempotencyKey: key, inputHash,
      encryptedInput: sealSecret(encoded, ctx.config.SECRETS_MASTER_KEY), generation: database.generation,
    }).returning()
    await tx.insert(events).values({ operationId: operation!.id, code: 'queued', progress: 0 })
    return operation!
  })
}

export type OperationClaim = { operation: Operation; token: string; resumed: boolean; input: unknown }

/** Claim only kinds with installed handlers. An expired lease always requires reconciliation. */
export async function claimDatabaseOperation(ctx: Context, kinds: OperationKind[]): Promise<OperationClaim | null> {
  if (!kinds.length) return null
  const claimed = await ctx.db.transaction(async tx => {
    const [operation] = await tx.select().from(operations).where(and(
      inArray(operations.kind, kinds),
      or(eq(operations.state, 'queued'), and(inArray(operations.state, ['running', 'reconciling']), lt(operations.leaseExpiresAt, sql`clock_timestamp()`))),
    )).orderBy(asc(operations.createdAt), asc(operations.id)).limit(1).for('update', { skipLocked: true })
    if (!operation) return null
    const [database] = await tx.select({ generation: tenantDatabases.generation }).from(tenantDatabases).where(eq(tenantDatabases.id, operation.databaseId))
    const errorCode = operation.generation !== database?.generation ? 'generation_changed'
      : operation.attempts >= MAX_OPERATION_ATTEMPTS ? 'retry_limit' : null
    if (errorCode) {
      await tx.update(operations).set({ state: 'failed', errorCode, finishedAt: sql`clock_timestamp()`, leaseToken: null, leaseExpiresAt: null }).where(eq(operations.id, operation.id))
      await tx.insert(events).values({ operationId: operation.id, code: errorCode, progress: operation.progress })
      return null
    }
    const token = randomUUID()
    const resumed = operation.state !== 'queued'
    const [row] = await tx.update(operations).set({
      state: resumed ? 'reconciling' : 'running', leaseToken: token,
      leaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
      attempts: operation.attempts + 1, startedAt: operation.startedAt ?? sql`clock_timestamp()`,
    }).where(eq(operations.id, operation.id)).returning()
    await tx.insert(events).values({ operationId: operation.id, code: resumed ? 'reconciling' : 'claimed', progress: operation.progress })
    return { operation: row!, token, resumed }
  })
  if (!claimed) return null
  try {
    return { ...claimed, input: JSON.parse(openSecret(claimed.operation.encryptedInput, ctx.config.SECRETS_MASTER_KEY)) as unknown }
  } catch {
    await finishDatabaseOperation(ctx, claimed.operation.id, claimed.token, 'runtime_failed')
    return null
  }
}

function ownedLease(id: string, token: string) {
  return and(
    eq(operations.id, id), eq(operations.leaseToken, token), inArray(operations.state, ['running', 'reconciling']),
    gt(operations.leaseExpiresAt, sql`clock_timestamp()`),
    sql`exists (select 1 from ${tenantDatabases} where ${tenantDatabases.id} = ${operations.databaseId} and ${tenantDatabases.generation} = ${operations.generation})`,
  )
}

function assertOwned(row: unknown): asserts row {
  if (!row) throw ApiError.conflict('operation_lease_lost', 'The operation lease expired or changed owner/generation. Stop this worker and reconcile the current operation before retrying.')
}

/** Checkpoints contain only a fixed step, UUID and completion flag; never runtime output/secrets. */
export async function checkpointDatabaseOperation(ctx: Context, id: string, token: string, checkpoint: OperationCheckpoint, progress: number): Promise<void> {
  const parsed = checkpointSchema.safeParse(checkpoint)
  if (!parsed.success || !Number.isInteger(progress) || progress < 0 || progress > 99) throw ApiError.badRequest('invalid_checkpoint', 'Use a valid operation step and integer progress from 0 through 99, then retry.')
  await ctx.db.transaction(async tx => {
    const [row] = await tx.update(operations).set({
      state: 'running', checkpoint: parsed.data, progress, leaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
    }).where(and(ownedLease(id, token), sql`${operations.progress} <= ${progress}`)).returning({ id: operations.id })
    assertOwned(row)
    await tx.insert(events).values({ operationId: id, code: 'checkpoint', progress })
  })
}

export async function renewDatabaseOperation(ctx: Context, id: string, token: string): Promise<void> {
  const [row] = await ctx.db.update(operations).set({ leaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'` })
    .where(ownedLease(id, token)).returning({ id: operations.id })
  assertOwned(row)
}

/** Errors are finite codes. The raw exception must never enter persisted operation events. */
export async function finishDatabaseOperation(ctx: Context, id: string, token: string, errorCode?: OperationFailure): Promise<void> {
  if (errorCode !== undefined && !failureSchema.safeParse(errorCode).success) throw ApiError.badRequest('invalid_operation_error', 'Use a recognized operation error code. Do not persist raw exceptions.')
  await ctx.db.transaction(async tx => {
    const [row] = await tx.update(operations).set({
      state: errorCode ? 'failed' : 'succeeded', errorCode: errorCode ?? null,
      ...(errorCode ? {} : { progress: 100 }), finishedAt: sql`clock_timestamp()`, leaseToken: null, leaseExpiresAt: null,
    }).where(ownedLease(id, token)).returning({ progress: operations.progress })
    assertOwned(row)
    await tx.insert(events).values({ operationId: id, code: errorCode ? 'failed' : 'succeeded', progress: row.progress })
  })
}

/** Used by API/SSE readers: no input envelope, lease token, credential or checkpoint is exposed. */
export async function databaseOperationHistory(ctx: Context, scope: DatabaseScope, after = 0, limit = 100) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw ApiError.badRequest('invalid_cursor', 'Use a nonnegative event cursor and a page size from 1 through 100, then retry.')
  const [database] = await ctx.db.select({ id: tenantDatabases.id }).from(tenantDatabases).where(scopedDatabase(scope))
  if (!database) throw ApiError.notFound('Database')
  return ctx.db.select({
    id: events.id, operationId: events.operationId, kind: operations.kind, state: operations.state,
    code: events.code, progress: events.progress, createdAt: events.createdAt,
  }).from(events).innerJoin(operations, eq(operations.id, events.operationId))
    .where(and(eq(operations.databaseId, database.id), gt(events.id, after))).orderBy(asc(events.id)).limit(limit)
}
