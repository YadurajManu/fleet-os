import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { nodes, services, deployments, buildJobs, taskReservations, tenantDatabases } from '../db/schema.js'
import type { AppContext } from '../api/context.js'
import type { AntiAffinityIndex, Arch, NodeSnapshot, Placements, ServiceSpec } from './types.js'

/** Deployment states that still occupy capacity on a node. */
const ACTIVE = ['deploying', 'running'] as const

/**
 * Build the view of a fleet the scheduler reasons over.
 *
 * Committed RAM is summed from active deployments rather than read from the
 * heartbeat: what the scheduler must not overcommit is what it has *promised*,
 * not what a container happens to be using this second. A service that is idle
 * right now still owns its reservation.
 */
export async function fleetSnapshot(
  ctx: AppContext,
  fleetId: string
): Promise<{ nodes: NodeSnapshot[]; placements: Placements; antiAffinityBy: AntiAffinityIndex }> {
  const nodeRows = await ctx.db
    .select()
    .from(nodes)
    .where(eq(nodes.fleetId, fleetId))
    .orderBy(asc(nodes.createdAt), asc(nodes.name))

  const active = await ctx.db
    .select({
      nodeId: deployments.nodeId,
      serviceName: services.name,
      requestRamMb: services.requestRamMb,
      requestCpu: services.requestCpu,
      antiAffinity: services.antiAffinity,
    })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .where(and(eq(services.fleetId, fleetId), inArray(deployments.status, [...ACTIVE])))

  const building = await ctx.db.select({ nodeId: buildJobs.builderNodeId, ram: buildJobs.reservedMemBytes, cpu: buildJobs.reservedCpu })
    .from(buildJobs).innerJoin(services, eq(buildJobs.serviceId, services.id))
    .where(and(eq(services.fleetId, fleetId), inArray(buildJobs.status, ['assigned', 'running'])))
  const committedCpu = new Map<string, number>()
  const committed = new Map<string, number>()
  const tasks = await ctx.db.select({ nodeId: taskReservations.nodeId, ram: taskReservations.reservedMemBytes, cpu: taskReservations.reservedCpu })
    .from(taskReservations).innerJoin(nodes, eq(nodes.id, taskReservations.nodeId))
    .where(and(eq(nodes.fleetId, fleetId), gt(taskReservations.expiresAt, new Date())))
  for (const task of tasks) {
    committed.set(task.nodeId, (committed.get(task.nodeId) ?? 0) + task.ram / 1048576)
    committedCpu.set(task.nodeId, (committedCpu.get(task.nodeId) ?? 0) + task.cpu)
  }
  for (const job of building) {
    if (!job.nodeId) continue
    committed.set(job.nodeId, (committed.get(job.nodeId) ?? 0) + job.ram / 1048576)
    committedCpu.set(job.nodeId, (committedCpu.get(job.nodeId) ?? 0) + job.cpu)
  }
  const stateful = await ctx.db.select().from(tenantDatabases).where(eq(tenantDatabases.fleetId, fleetId))
  const diskReservations = new Map<string, number>()
  for (const database of stateful) {
    if (!database.nodeId) continue
    committed.set(database.nodeId, (committed.get(database.nodeId) ?? 0) + database.memoryMb)
    committedCpu.set(database.nodeId, (committedCpu.get(database.nodeId) ?? 0) + database.cpu)
    // shortcut: reserve full disk budgets conservatively; account for measured volume usage when database metrics land.
    diskReservations.set(database.nodeId, (diskReservations.get(database.nodeId) ?? 0) + database.diskMb)
  }
  const placements: Placements = {}
  const antiAffinityBy: AntiAffinityIndex = {}
  for (const row of active) {
    if (!row.nodeId) continue
    committed.set(row.nodeId, (committed.get(row.nodeId) ?? 0) + row.requestRamMb)
    committedCpu.set(row.nodeId, (committedCpu.get(row.nodeId) ?? 0) + Number(row.requestCpu))
    placements[row.serviceName] = row.nodeId
    antiAffinityBy[row.serviceName] = row.antiAffinity
  }

  const snapshots = await Promise.all(
    nodeRows.map(async (n): Promise<NodeSnapshot> => {
      const [hb, outages] = await Promise.all([ctx.heartbeats.last(n.id), ctx.heartbeats.outageCount(n.id)])
      return {
        id: n.id,
        name: n.name,
        arch: n.arch,
        platform: n.platform,
        engineKind: n.engineKind,
        effectiveCpu: n.effectiveCpu,
        effectiveMemBytes: n.effectiveMemBytes,
        reliabilityScore: n.reliabilityScore,
        committedCpu: committedCpu.get(n.id) ?? 0,
        committedDiskMb: diskReservations.get(n.id) ?? 0,
        freeDiskMb: n.buildCacheFreeBytes > 0 ? Math.max(0, n.buildCacheFreeBytes - n.buildDiskReserveBytes) / 1048576 : undefined,
        databaseCapabilities: n.databaseCapabilities,
        uptimeSec: hb?.uptimeSec,
        outagesLast30Days: outages,
        status: n.status,
        ramMb: n.ramMb,
        cpuCores: n.cpuCores,
        hasGpu: n.hasGpu,
        reliabilityTier: n.reliabilityTier,
        tags: n.tags,
        committedRamMb: committed.get(n.id) ?? 0,
        // Absent rather than 0 when unknown: the ranker treats unknown as
        // mid-range, and claiming a node is idle would make it win every time.
        loadFactor: hb ? Math.min(1, Math.max(0, hb.cpuPct / 100)) : undefined,
      }
    })
  )

  return { nodes: snapshots, placements, antiAffinityBy }
}

/** Translate a stored service row into the scheduler's input shape. */
export function toServiceSpec(
  row: typeof services.$inferSelect,
  volumeNodeId?: string | null,
  preferredNodeIds: string[] = row.preferredNodeIds ?? []
): ServiceSpec {
  return {
    id: row.id,
    name: row.name,
    placementPolicy: row.placementPolicy,
    pinnedNodeId: row.pinnedNodeId,
    requestRamMb: row.requestRamMb,
    requestCpu: Number(row.requestCpu) || 0.25,
    requiresGpu: row.requiresGpu,
    minReliabilityTier: row.minReliabilityTier,
    compatibleArches: row.compatibleArches as Arch[],
    platforms: row.platforms,
    imagePlatforms: row.imagePlatforms,
    placementArch: row.placementArch,
    allowEmulation: row.allowEmulation,
    affinity: row.affinity,
    preferredNodeIds,
    antiAffinity: row.antiAffinity,
    persistentVolume: row.persistentVolume,
    volumeNodeId: volumeNodeId ?? null,
  }
}
