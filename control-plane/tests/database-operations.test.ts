import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { createDb } from '../src/db/client.js'
import { loadConfig } from '../src/config.js'
import { databaseOperations, fleets, orgs, tenantDatabases } from '../src/db/schema.js'
import { ApiError } from '../src/api/errors.js'
import { databaseCapabilities, requireDatabaseCapabilities } from '../src/databases/capabilities.js'
import {
  claimDatabaseOperation, checkpointDatabaseOperation, databaseOperationHistory,
  enqueueDatabaseOperation, finishDatabaseOperation, MAX_OPERATION_ATTEMPTS, renewDatabaseOperation,
  type DatabaseScope, type OperationClaim,
} from '../src/databases/operations.js'

test('database capabilities default to unsupported and accept future additive flags', () => {
  assert.deepEqual(databaseCapabilities.parse(undefined), [])
  assert.deepEqual(databaseCapabilities.parse(['database.future.v2']), ['database.future.v2'])
  assert.throws(() => requireDatabaseCapabilities(undefined, ['database.runtime.v1']), (error: unknown) => error instanceof ApiError && error.code === 'agent_upgrade_required')
  assert.doesNotThrow(() => requireDatabaseCapabilities(['database.runtime.v1'], ['database.runtime.v1']))
  assert.throws(() => databaseCapabilities.parse(['http://untrusted']))
})

describe('durable database operations against Postgres', () => {
  const config = loadConfig()
  const connection = createDb(config.DATABASE_URL)
  const ctx = { db: connection.db, config }
  const orgId = randomUUID(), fleetId = randomUUID()
  let scope: DatabaseScope

  before(async () => {
    // The suite creates its own tenant, and must never connect to a production-named database.
    const [database] = await connection.sql<{ name: string }[]>`select current_database() as name`
    assert.ok(database)
    assert.match(database.name, /(?:^test_|_test$)/)
    await ctx.db.insert(orgs).values({ id: orgId, name: `db-operations-${orgId}` })
    await ctx.db.insert(fleets).values({ id: fleetId, orgId, name: 'operations-test' })
  })
  after(async () => {
    await ctx.db.delete(tenantDatabases).where(eq(tenantDatabases.fleetId, fleetId))
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await connection.sql.end()
  })

  async function database() {
    const databaseId = randomUUID()
    await ctx.db.insert(tenantDatabases).values({
      id: databaseId, fleetId, project: 'test', name: `db-${databaseId.slice(0, 8)}`, engine: 'postgres', version: '16',
      volumeName: `fleet-db-test-${databaseId}`, memoryMb: 512, cpu: 0.5, diskMb: 1024,
    })
    scope = { fleetId, project: 'test', databaseId }
    return scope
  }

  async function claim(): Promise<OperationClaim> {
    const value = await claimDatabaseOperation(ctx, ['backup'])
    assert.ok(value)
    return value
  }

  async function expire(id: string) {
    await ctx.db.update(databaseOperations).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(databaseOperations.id, id))
  }

  test('retry identity is canonical, encrypted, serialized and scoped', async () => {
    await database()
    const secret = `password-${randomUUID()}`
    const [a, b] = await Promise.all([
      enqueueDatabaseOperation(ctx, scope, 'backup', 'same-key', { password: secret, options: { a: 1, b: 2 } }),
      enqueueDatabaseOperation(ctx, scope, 'backup', 'same-key', { options: { b: 2, a: 1 }, password: secret }),
    ])
    assert.equal(a.id, b.id)
    assert.ok(!JSON.stringify(a).includes(secret))
    await assert.rejects(enqueueDatabaseOperation(ctx, scope, 'stop', 'same-key', {}), { code: 'idempotency_conflict' })
    await assert.rejects(enqueueDatabaseOperation(ctx, scope, 'backup', 'other-key', {}), { code: 'database_busy' })
    await assert.rejects(enqueueDatabaseOperation(ctx, { ...scope, project: 'another-project' }, 'backup', 'same-key', {}), { code: 'not_found' })
    const worker = await claim()
    assert.equal((worker.input as { password: string }).password, secret)
    await finishDatabaseOperation(ctx, worker.operation.id, worker.token)
    assert.equal((await enqueueDatabaseOperation(ctx, scope, 'backup', 'same-key', { password: secret, options: { a: 1, b: 2 } })).state, 'succeeded')
    const history = await databaseOperationHistory(ctx, scope)
    assert.deepEqual(history.map(e => e.code), ['queued', 'claimed', 'succeeded'])
    assert.ok(!JSON.stringify(history).includes(secret))
    await assert.rejects(databaseOperationHistory(ctx, { ...scope, fleetId: randomUUID() }), { code: 'not_found' })
    await assert.rejects(databaseOperationHistory(ctx, scope, -1), { code: 'invalid_cursor' })
    assert.equal((await databaseOperationHistory(ctx, scope, history[0]!.id, 1))[0]!.code, 'claimed')
  })

  test('competing workers cannot claim the same lease', async () => {
    await database()
    const op = await enqueueDatabaseOperation(ctx, scope, 'backup', 'concurrent', {})
    assert.equal(await claimDatabaseOperation(ctx, ['restore']), null)
    const claims = await Promise.all([claimDatabaseOperation(ctx, ['backup']), claimDatabaseOperation(ctx, ['backup'])])
    assert.equal(claims.filter(Boolean).length, 1)
    const worker = claims.find(Boolean)!
    assert.equal(worker.operation.id, op.id)
    await renewDatabaseOperation(ctx, op.id, worker.token)
    await finishDatabaseOperation(ctx, op.id, worker.token)
  })

  test('a restarted worker resumes the checkpoint and fences expired workers', async () => {
    await database()
    const op = await enqueueDatabaseOperation(ctx, scope, 'backup', 'resume', { label: 'test' })
    const old = await claim()
    await checkpointDatabaseOperation(ctx, op.id, old.token, { step: 'prepare', resourceId: scope.databaseId }, 20)
    await expire(op.id)
    await assert.rejects(renewDatabaseOperation(ctx, op.id, old.token), { code: 'operation_lease_lost' })
    const next = await claim()
    assert.equal(next.resumed, true)
    assert.equal(next.operation.state, 'reconciling')
    assert.equal(next.operation.attempts, 2)
    assert.deepEqual(next.operation.checkpoint, { step: 'prepare', resourceId: scope.databaseId })
    await assert.rejects(finishDatabaseOperation(ctx, op.id, old.token), { code: 'operation_lease_lost' })
    await checkpointDatabaseOperation(ctx, op.id, next.token, { step: 'verify' }, 80)
    await assert.rejects(checkpointDatabaseOperation(ctx, op.id, next.token, { step: 'prepare' }, 10), { code: 'operation_lease_lost' })
    await finishDatabaseOperation(ctx, op.id, next.token)
    assert.equal((await databaseOperationHistory(ctx, scope)).at(-1)!.progress, 100)
  })

  test('generation changes invalidate existing leases and terminate stale work', async () => {
    await database()
    const op = await enqueueDatabaseOperation(ctx, scope, 'backup', 'generation', {})
    const worker = await claim()
    await ctx.db.update(tenantDatabases).set({ generation: 2 }).where(eq(tenantDatabases.id, scope.databaseId))
    await assert.rejects(checkpointDatabaseOperation(ctx, op.id, worker.token, { step: 'commit' }, 90), { code: 'operation_lease_lost' })
    await expire(op.id)
    assert.equal(await claimDatabaseOperation(ctx, ['backup']), null)
    const [row] = await ctx.db.select().from(databaseOperations).where(eq(databaseOperations.id, op.id))
    assert.equal(row!.state, 'failed')
    assert.equal(row!.errorCode, 'generation_changed')
  })

  test('repeated worker loss stops after bounded attempts', async () => {
    await database()
    const op = await enqueueDatabaseOperation(ctx, scope, 'backup', 'attempts', {})
    for (let i = 0; i < MAX_OPERATION_ATTEMPTS; i++) {
      assert.equal((await claim()).operation.attempts, i + 1)
      await expire(op.id)
    }
    assert.equal(await claimDatabaseOperation(ctx, ['backup']), null)
    const [row] = await ctx.db.select().from(databaseOperations).where(eq(databaseOperations.id, op.id))
    assert.equal(row!.errorCode, 'retry_limit')
    await enqueueDatabaseOperation(ctx, scope, 'backup', 'manual-retry', {})
    const retry = await claim()
    await finishDatabaseOperation(ctx, retry.operation.id, retry.token, 'runtime_failed')
  })

  test('invalid input/checkpoints and raw errors are rejected before persistence', async () => {
    await database()
    await assert.rejects(enqueueDatabaseOperation(ctx, scope, 'backup', '', {}), { code: 'invalid_idempotency_key' })
    await assert.rejects(enqueueDatabaseOperation(ctx, scope, 'backup', 'input', { n: Infinity }), { code: 'invalid_operation_input' })
    await assert.rejects(enqueueDatabaseOperation(ctx, scope, 'backup', 'input', 'x'.repeat(65536)), { code: 'operation_input_too_large' })
    const circular: Record<string, unknown> = {}; circular.self = circular
    await assert.rejects(enqueueDatabaseOperation(ctx, scope, 'backup', 'input', circular), { code: 'invalid_operation_input' })
    const op = await enqueueDatabaseOperation(ctx, scope, 'backup', 'valid', {})
    const worker = await claim()
    await assert.rejects(checkpointDatabaseOperation(ctx, op.id, worker.token, { step: 'prepare', password: 'secret' } as never, 20), { code: 'invalid_checkpoint' })
    await assert.rejects(finishDatabaseOperation(ctx, op.id, worker.token, 'password=secret' as never), { code: 'invalid_operation_error' })
    await finishDatabaseOperation(ctx, op.id, worker.token, 'deadline_exceeded')
    assert.ok(!JSON.stringify(await databaseOperationHistory(ctx, scope)).includes('secret'))
  })

  test('schema refuses invalid modes and blocks fleet deletion while volumes exist', async () => {
    await database()
    await assert.rejects(ctx.db.update(tenantDatabases).set({ mode: 'cache' }).where(eq(tenantDatabases.id, scope.databaseId)))
    await assert.rejects(ctx.db.delete(fleets).where(eq(fleets.id, fleetId)))
    await assert.rejects(ctx.db.update(tenantDatabases).set({ memoryMb: -1 }).where(eq(tenantDatabases.id, scope.databaseId)))
    const [resource] = await ctx.db.select().from(tenantDatabases).where(and(eq(tenantDatabases.id, scope.databaseId), eq(tenantDatabases.fleetId, fleetId)))
    assert.equal(resource!.mode, 'standard')
  })
})
