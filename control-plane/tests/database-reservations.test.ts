import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createContext, closeContext } from '../src/api/context.js'
import { loadConfig } from '../src/config.js'
import { orgs, fleets, nodes, tenantDatabases } from '../src/db/schema.js'
import { fleetSnapshot } from '../src/scheduler/snapshot.js'
import { rescheduleFromNode } from '../src/scheduler/reschedule.js'

test('database reservations persist while stopped; offline handling never moves tenant data', async () => {
  const ctx = createContext(loadConfig()),
    orgId = randomUUID(),
    fleetId = randomUUID(),
    nodeId = randomUUID(),
    id = randomUUID()
  try {
    const [connected] = await ctx.sql<
      { name: string }[]
    >`select current_database() as name`
    assert.match(connected!.name, /(?:^test_|_test$)/)
    await ctx.db.insert(orgs).values({ id: orgId, name: 'database-placement' })
    await ctx.db
      .insert(fleets)
      .values({ id: fleetId, orgId, name: 'database-placement' })
    await ctx.db.insert(nodes).values({
      id: nodeId,
      fleetId,
      name: 'primary',
      arch: 'arm64',
      status: 'online',
      ramMb: 4096,
      cpuCores: 4,
      diskMb: 100000,
      agentTokenHash: 'placement-fixture',
      buildCacheFreeBytes: 50 * 1048576,
      buildDiskReserveBytes: 5 * 1048576,
      databaseCapabilities: ['database.runtime.v1'],
    })
    await ctx.db.insert(tenantDatabases).values({
      id,
      fleetId,
      project: 'test',
      name: 'primary',
      engine: 'postgres',
      version: '16',
      status: 'stopped',
      desiredState: 'stopped',
      nodeId,
      volumeName: `fleet-db-${id}-data`,
      memoryMb: 512,
      cpu: 0.5,
      diskMb: 1024,
    })
    const now = Date.now()
    await ctx.heartbeats.record(
      {
        nodeId,
        fleetId,
        cpuPct: 10,
        ramUsedMb: 100,
        diskUsedMb: 50,
        containers: [],
        meshConnected: false,
        uptimeSec: 86400,
      },
      now,
    )
    await ctx.heartbeats.recordOutage(nodeId, now - 2000)
    await ctx.heartbeats.recordOutage(nodeId, now - 1000)
    await ctx.heartbeats.recordOutage(nodeId, now - 31 * 86400000)
    const snapshot = await fleetSnapshot(ctx, fleetId)
    assert.equal(snapshot.nodes[0]!.committedRamMb, 512)
    assert.equal(snapshot.nodes[0]!.committedCpu, 0.5)
    assert.equal(snapshot.nodes[0]!.committedDiskMb, 1024)
    assert.equal(snapshot.nodes[0]!.freeDiskMb, 45)
    assert.equal(snapshot.nodes[0]!.uptimeSec, 86400)
    assert.equal(snapshot.nodes[0]!.outagesLast30Days, 2)
    await ctx.db
      .update(tenantDatabases)
      .set({ status: 'running', desiredState: 'running' })
      .where(eq(tenantDatabases.id, id))
    await rescheduleFromNode(ctx, fleetId, nodeId)
    const [held] = await ctx.db
      .select()
      .from(tenantDatabases)
      .where(eq(tenantDatabases.id, id))
    assert.equal(held!.status, 'unreachable')
    assert.equal(held!.nodeId, nodeId)
    assert.equal(held!.volumeName, `fleet-db-${id}-data`)
    assert.equal(held!.generation, 1)
    assert.equal(
      (
        await ctx.db
          .select()
          .from(tenantDatabases)
          .where(eq(tenantDatabases.fleetId, fleetId))
      ).length,
      1,
    )
  } finally {
    await ctx.db.delete(tenantDatabases).where(eq(tenantDatabases.id, id))
    await ctx.heartbeats.forget(fleetId, nodeId)
    await ctx.redis.del(`node:${nodeId}:outages`)
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await closeContext(ctx)
  }
})
