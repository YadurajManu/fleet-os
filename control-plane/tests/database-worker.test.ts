import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { createContext, closeContext } from '../src/api/context.js'
import { loadConfig } from '../src/config.js'
import {
  orgs,
  fleets,
  tenantDatabases,
  databaseOperations,
} from '../src/db/schema.js'
import { DatabaseWorker } from '../src/databases/worker.js'
import {
  enqueueDatabaseOperation,
  claimDatabaseOperation,
  commitDatabaseLifecycleOperation,
  databaseOperationHistory,
} from '../src/databases/operations.js'

test('workers fence competing claims, sanitize invalid input and atomically refuse an expired completion', async () => {
  const ctx = createContext(loadConfig())
  const orgId = randomUUID(),
    fleetId = randomUUID(),
    id = randomUUID()
  const first = new DatabaseWorker(ctx),
    second = new DatabaseWorker(ctx)
  try {
    const [database] = await ctx.sql<
      { name: string }[]
    >`select current_database() as name`
    assert.match(database!.name, /(?:^test_|_test$)/)
    await ctx.db.insert(orgs).values({ id: orgId, name: 'worker-unit' })
    await ctx.db
      .insert(fleets)
      .values({ id: fleetId, orgId, name: 'worker-unit' })
    await ctx.db.insert(tenantDatabases).values({
      id,
      fleetId,
      project: 'test',
      name: 'primary',
      engine: 'postgres',
      version: '16',
      volumeName: `fleet-db-${id}-data`,
      memoryMb: 512,
      cpu: 0.5,
      diskMb: 1024,
    })
    const scope = { fleetId, project: 'test', databaseId: id }
    const invalid = await enqueueDatabaseOperation(
      ctx,
      scope,
      'create',
      'invalid',
      { private: 'do-not-log-this' },
    )
    const claims = await Promise.all([first.tick(), second.tick()])
    assert.equal(claims.filter(Boolean).length, 1)
    const [failed] = await ctx.db
      .select()
      .from(databaseOperations)
      .where(eq(databaseOperations.id, invalid.id))
    assert.equal(failed!.state, 'failed')
    assert.equal(failed!.errorCode, 'runtime_failed')
    const history = await databaseOperationHistory(ctx, scope)
    assert.ok(!JSON.stringify(history).includes('do-not-log-this'))
    await enqueueDatabaseOperation(ctx, scope, 'start', 'expired', {})
    const claim = await claimDatabaseOperation(ctx, ['start'])
    assert.ok(claim)
    await ctx.db
      .update(databaseOperations)
      .set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` })
      .where(eq(databaseOperations.id, claim.operation.id))
    await assert.rejects(
      commitDatabaseLifecycleOperation(
        ctx,
        claim.operation.id,
        claim.token,
        'running',
      ),
    )
    const [unchanged] = await ctx.db
      .select()
      .from(tenantDatabases)
      .where(eq(tenantDatabases.id, id))
    const [unfinished] = await ctx.db
      .select()
      .from(databaseOperations)
      .where(eq(databaseOperations.id, claim.operation.id))
    assert.equal(unchanged!.status, 'provisioning')
    assert.notEqual(unfinished!.state, 'succeeded')
  } finally {
    await first.close()
    await second.close()
    await ctx.db.delete(tenantDatabases).where(eq(tenantDatabases.id, id))
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await closeContext(ctx)
  }
})
