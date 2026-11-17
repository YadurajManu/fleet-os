import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { createContext, closeContext } from '../src/api/context.js'
import { loadConfig } from '../src/config.js'
import {
  auditLog,
  databaseBackupSchedules,
  databaseBackupTargets,
  databaseBackups,
  databaseOperations,
  fleets,
  nodes,
  orgs,
  tenantDatabases,
} from '../src/db/schema.js'
import { sealSecret, openSecret } from '../src/lib/crypto.js'
import { DatabaseWorker } from '../src/databases/worker.js'

test('a due backup schedule queues one durable system operation and advances', async () => {
  const ctx = createContext(loadConfig())
  const orgId = randomUUID()
  const fleetId = randomUUID()
  const nodeId = randomUUID()
  const databaseId = randomUUID()
  const targetId = randomUUID()
  const worker = new DatabaseWorker(ctx)
  try {
    const [database] = await ctx.sql<{ name: string }[]>`
      select current_database() as name
    `
    assert.match(database!.name, /(?:^test_|_test$)/)
    await ctx.db
      .insert(orgs)
      .values({ id: orgId, name: 'backup-schedule-test' })
    await ctx.db.insert(fleets).values({
      id: fleetId,
      orgId,
      name: 'backup-schedule-test',
    })
    await ctx.db.insert(nodes).values({
      id: nodeId,
      fleetId,
      name: 'database-node',
      arch: process.arch,
      cpuCores: 2,
      ramMb: 4096,
      diskMb: 100000,
      agentTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      databaseCapabilities: ['database.runtime.v1', 'database.exec.v1'],
    })
    await ctx.db.insert(databaseBackupTargets).values({
      id: targetId,
      fleetId,
      project: 'schedule-test',
      name: 'schedule-target',
      endpoint: 'https://backups.example.test',
      bucket: 'fleet-backups',
      encryptedCredentials: sealSecret(
        JSON.stringify({ accessKeyId: 'key', secretAccessKey: 'secret' }),
        ctx.config.SECRETS_MASTER_KEY,
      ),
    })
    await ctx.db.insert(tenantDatabases).values({
      id: databaseId,
      fleetId,
      project: 'schedule-test',
      name: 'scheduled-postgres',
      engine: 'postgres',
      version: '17',
      status: 'running',
      desiredState: 'running',
      nodeId,
      backupTargetId: targetId,
      volumeName: `fleet-db-${databaseId}-data`,
      memoryMb: 512,
      cpu: 0.5,
      diskMb: 1024,
    })
    await ctx.db.insert(databaseBackupSchedules).values({
      databaseId,
      enabled: true,
      nextRunAt: new Date(Date.now() - 60_000),
    })

    assert.equal(await worker.tick(), true)
    const [schedule] = await ctx.db
      .select()
      .from(databaseBackupSchedules)
      .where(eq(databaseBackupSchedules.databaseId, databaseId))
    const [backup] = await ctx.db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.databaseId, databaseId))
    const [operation] = await ctx.db
      .select()
      .from(databaseOperations)
      .where(eq(databaseOperations.databaseId, databaseId))

    assert.ok(schedule!.nextRunAt.getTime() > Date.now())
    assert.ok(schedule!.lastQueuedAt)
    assert.equal(backup!.kind, 'base')
    assert.equal(backup!.label, 'scheduled-daily')
    assert.equal(operation!.state, 'running') // No live agent is attached in this unit test.
    const input = JSON.parse(
      openSecret(operation!.encryptedInput, ctx.config.SECRETS_MASTER_KEY),
    ) as { backupId: string }
    assert.equal(input.backupId, backup!.id)
    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'database.backup.created'),
          eq(auditLog.targetId, databaseId),
        ),
      )
    assert.equal(audit!.actorKind, 'system')
    assert.equal(audit!.actorUserId, null)
    assert.equal(await worker.tick(), false)
    const [count] = await ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(databaseBackups)
      .where(eq(databaseBackups.databaseId, databaseId))
    assert.equal(count!.count, 1)
  } finally {
    await worker.close()
    await ctx.db
      .delete(databaseBackups)
      .where(eq(databaseBackups.databaseId, databaseId))
    await ctx.db
      .delete(databaseOperations)
      .where(eq(databaseOperations.databaseId, databaseId))
    await ctx.db
      .delete(tenantDatabases)
      .where(eq(tenantDatabases.id, databaseId))
    await ctx.db
      .delete(databaseBackupTargets)
      .where(eq(databaseBackupTargets.id, targetId))
    await ctx.db.delete(nodes).where(eq(nodes.id, nodeId))
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await closeContext(ctx)
  }
})
