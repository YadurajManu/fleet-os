import { and, count, desc, eq } from 'drizzle-orm'
import type { AppContext } from './context.js'
import { deployments, nodes, services } from '../db/schema.js'
import { ApiError } from './errors.js'
import { cleanReason } from './deploy-progress.js'

export type StoredBuildLog = { serviceId?: string; service: string; deploymentId?: string; nodeId: string; text: string; at: number }

/** An exact deployment must never borrow another attempt's output. */
export async function retainedBuildLogs(ctx: AppContext, serviceId: string, deploymentId?: string): Promise<StoredBuildLog[]> {
  const raw = await ctx.redis.lrange(`build:logs:${serviceId}`, 0, 199).catch(() => [])
  const entries: StoredBuildLog[] = []
  for (const line of raw.reverse()) {
    try {
      const entry = JSON.parse(line) as StoredBuildLog
      if (!entry || typeof entry.text !== 'string' || typeof entry.at !== 'number' || !Number.isFinite(entry.at) || Math.abs(entry.at) > 8.64e15) continue
      if (entry.serviceId && entry.serviceId !== serviceId) continue
      if (deploymentId && entry.deploymentId !== deploymentId) continue
      entries.push({ ...entry, text: cleanReason(entry.text) })
    } catch { /* Ignore malformed retained entries. */ }
  }
  return entries
}

/** Called after service authorization, by both the API and diagnosis tools. */
export async function readServiceLogs(ctx: AppContext, service: { id: string; name: string; fleetId: string }, nodeId?: string) {
  const [latest] = await ctx.db.select({
    id: deployments.id, status: deployments.status, nodeId: deployments.nodeId,
    nodeName: nodes.name, failureReason: deployments.failureReason, finishedAt: deployments.finishedAt,
  }).from(deployments).leftJoin(nodes, eq(nodes.id, deployments.nodeId))
    .where(eq(deployments.serviceId, service.id)).orderBy(desc(deployments.startedAt)).limit(1)
  const target = nodeId
    ? (await ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.fleetId, service.fleetId))).limit(1))[0]
    : latest?.nodeId ? { id: latest.nodeId, name: latest.nodeName ?? 'unknown' } : null
  if (nodeId && !target) throw ApiError.notFound('Node in this fleet')
  const retained = async () => {
    const build = await retainedBuildLogs(ctx, service.id, latest?.id)
    const lines = build.flatMap(entry => entry.text.split(/\r?\n/).filter(Boolean))
    if (latest?.failureReason) lines.push('Deployment failure: ' + cleanReason(latest.failureReason))
    return {
      service: service.name, node: target ?? null, deploymentId: latest?.id ?? null,
      capturedAt: build.length ? new Date(build[build.length - 1]!.at).toISOString() : latest?.finishedAt?.toISOString() ?? null,
      available: lines.length > 0, lines, source: build.length ? 'build' : lines.length ? 'deployment' : 'none',
      diagnostic: lines.length ? 'Retained output from the latest deployment; this is not a live container log.'
        : !latest ? 'This service has no live deployment or retained build logs.'
          : 'No retained logs or deployment failure are available. Build logs are retained for up to 24 hours.',
    }
  }
  // The previous healthy container is not the output of the failed attempt.
  if (!nodeId && latest?.status === 'failed') return retained()
  if (!target) return retained()
  const hb = await ctx.heartbeats.last(target.id)
  const [sameNamed] = await ctx.db.select({ count: count() }).from(services)
    .where(and(eq(services.fleetId, service.fleetId), eq(services.name, service.name)))
  const log = hb?.logs?.find(entry => entry.service_id === service.id ||
    (!entry.service_id && Number(sameNamed?.count ?? 0) === 1 && entry.service === service.name))
  if (!log) return retained()
  return {
    service: service.name, node: { id: target.id, name: target.name }, deploymentId: latest?.id ?? null,
    capturedAt: hb ? new Date(hb.at).toISOString() : null, available: true,
    lines: log.text.split(/\r?\n/).filter(Boolean), source: 'container', diagnostic: null,
  }
}
