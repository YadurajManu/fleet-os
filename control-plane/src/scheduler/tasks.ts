import { and, eq, gt, lte } from 'drizzle-orm'
import { nodes, taskReservations } from '../db/schema.js'
import type { AppContext } from '../api/context.js'
import { ApiError } from '../api/errors.js'
import { fleetSnapshot } from './snapshot.js'

export async function reserveTask(ctx: AppContext, fleetId: string, nodeId: string, cpu: number, memory: number, timeoutMs: number): Promise<string> {
  return ctx.db.transaction(async tx => {
    const [node] = await tx.select().from(nodes).where(and(eq(nodes.id, nodeId), eq(nodes.fleetId, fleetId))).for('update')
    if (!node) throw ApiError.notFound('Task node')
    await tx.delete(taskReservations).where(lte(taskReservations.expiresAt, new Date()))
    const active = await tx.select({ id: taskReservations.id }).from(taskReservations).where(and(eq(taskReservations.nodeId, nodeId), gt(taskReservations.expiresAt, new Date())))
    if (active.length >= 2) throw ApiError.conflict('task_slots_full', 'This node has two tasks running or awaiting cleanup. Wait before starting another task.')
    const snapshot = await fleetSnapshot({ ...ctx, db: tx as unknown as AppContext['db'] }, fleetId)
    const capacity = snapshot.nodes.find(n => n.id === nodeId)!
    if ((node.effectiveCpu ?? node.cpuCores) - (capacity.committedCpu ?? 0) < cpu || (node.effectiveMemBytes ?? node.ramMb * 1048576) - capacity.committedRamMb * 1048576 < memory) {
      throw ApiError.unprocessable('task_capacity', 'Not enough unreserved CPU or memory for this task. Wait for active builds/tasks, reduce service requests or select a larger node.')
    }
    const [reservation] = await tx.insert(taskReservations).values({ nodeId, reservedCpu: cpu, reservedMemBytes: memory, expiresAt: new Date(Date.now() + timeoutMs + 90000) }).returning({ id: taskReservations.id })
    return reservation!.id
  })
}
