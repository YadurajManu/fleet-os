import { desc, eq } from 'drizzle-orm'
import { deployments, fleets, services } from '../db/schema.js'
import { recordAudit } from '../lib/audit.js'
import { invalidateRoutesForService } from '../ingress/routes.js'
import type { AppContext } from '../api/context.js'
import type { FleetEventPayload } from '../lib/events.js'

/**
 * Canary window for post-rollout health verification.
 *
 * If a newly promoted or deploying release crashes repeatedly or fails health
 * checks during this window, the watchdog restores the previous known healthy release
 * automatically rather than leaving broken software serving traffic.
 */
export const CANARY_WINDOW_MS = 5 * 60_000

/**
 * Number of consecutive unhealthy heartbeats required before triggering an
 * automated rollback. Prevents premature rollbacks on transient warm-up pauses.
 */
export const CONSECUTIVE_UNHEALTHY_THRESHOLD = 3

export type WatchdogTrigger = 'crash_loop' | 'unhealthy' | 'missing'

export type WatchdogResult =
  | {
      action: 'rolled_back'
      fromDeploymentId: string
      targetDeploymentId: string
      newDeploymentId: string
      trigger: WatchdogTrigger
    }
  | { action: 'skipped'; reason: string }

export type WatchdogOptions = {
  onEvent?: (e: FleetEventPayload) => void | Promise<void>
  log?: {
    info: (o: unknown, m: string) => void
    warn: (o: unknown, m: string) => void
    error: (o: unknown, m: string) => void
  }
}

/**
 * Evaluate whether a newly deployed container is experiencing a post-rollout
 * failure during the canary window, and execute an automated rollback if
 * a verified target release exists.
 */
export async function evaluateCanaryHealth(
  ctx: AppContext,
  opts: {
    serviceId: string
    deploymentId: string
    nodeId: string
    trigger: WatchdogTrigger
  },
  handlers: WatchdogOptions = {}
): Promise<WatchdogResult> {
  const [current] = await ctx.db
    .select()
    .from(deployments)
    .where(eq(deployments.id, opts.deploymentId))

  if (!current) {
    return { action: 'skipped', reason: 'deployment_not_found' }
  }

  if (current.status !== 'running' && current.status !== 'deploying') {
    return { action: 'skipped', reason: `status_${current.status}` }
  }

  // Check canary window against the moment this deployment finished starting
  // or was created.
  const refTime = current.finishedAt ?? current.startedAt ?? new Date()
  const elapsed = Date.now() - refTime.getTime()
  if (elapsed > CANARY_WINDOW_MS) {
    return { action: 'skipped', reason: 'outside_canary_window' }
  }

  // Consecutive health check tracking for 'unhealthy' triggers.
  if (opts.trigger === 'unhealthy') {
    const failKey = `canary:fail:${opts.deploymentId}`
    const fails = await ctx.redis.incr(failKey)
    await ctx.redis.expire(failKey, 600)

    if (fails < CONSECUTIVE_UNHEALTHY_THRESHOLD) {
      return { action: 'skipped', reason: `consecutive_unhealthy_${fails}` }
    }
  }

  // Guard against cascading or duplicate rollbacks for the same deployment.
  const guardKey = `canary:guard:${opts.deploymentId}`
  const acquired = await ctx.redis.set(guardKey, '1', 'EX', 3600, 'NX')
  if (!acquired) {
    return { action: 'skipped', reason: 'already_handled' }
  }

  // Find rollback target: the newest superseded deployment with valid image tags.
  const history = await ctx.db
    .select()
    .from(deployments)
    .where(eq(deployments.serviceId, opts.serviceId))
    .orderBy(desc(deployments.startedAt))
    .limit(20)

  const target = history.find(
    (d) => d.id !== current.id && d.status === 'superseded' && d.imageTags.length > 0
  )

  if (!target || !target.imageTags.length) {
    handlers.log?.warn(
      { serviceId: opts.serviceId, deploymentId: current.id, trigger: opts.trigger },
      'canary failure detected but no previous healthy release exists to roll back to'
    )
    return { action: 'skipped', reason: 'no_rollback_target' }
  }

  const targetNode = current.nodeId ?? target.nodeId
  if (!targetNode) {
    return { action: 'skipped', reason: 'no_node_assignment' }
  }

  // Find organization and fleet info for audit log and event emission.
  const [svcRow] = await ctx.db
    .select({ orgId: fleets.orgId, fleetId: fleets.id, name: services.name })
    .from(services)
    .innerJoin(fleets, eq(fleets.id, services.fleetId))
    .where(eq(services.id, opts.serviceId))

  const failureReason = `auto-rollback: ${opts.trigger} during canary window (${Math.round(elapsed / 1000)}s post-deploy)`

  const [created] = await ctx.db.transaction(async (tx) => {
    // Mark current failing deployment as failed.
    await tx
      .update(deployments)
      .set({
        status: 'failed',
        failureReason,
        finishedAt: new Date(),
      })
      .where(eq(deployments.id, current.id))

    // Restore the previous deployment image as a new deploying record.
    const created = await tx
      .insert(deployments)
      .values({
        serviceId: opts.serviceId,
        gitSha: target.gitSha,
        imageTags: target.imageTags,
        nodeId: targetNode,
        hostPort: current.hostPort ?? target.hostPort,
        status: 'deploying',
      })
      .returning()

    if (svcRow?.orgId) {
      await recordAudit(tx, {
        orgId: svcRow.orgId,
        actorUserId: null,
        action: 'service.auto_rolled_back',
        targetType: 'service',
        targetId: opts.serviceId,
        metadata: {
          fromDeployment: current.id,
          targetDeployment: target.id,
          deployment: created[0]!.id,
          trigger: opts.trigger,
          elapsedMs: elapsed,
        },
      })
    }

    return created
  })

  await invalidateRoutesForService(ctx, opts.serviceId)

  await handlers.onEvent?.({
    type: 'service.auto_rolled_back',
    fleetId: svcRow?.fleetId ?? '',
    at: new Date().toISOString(),
    subject: svcRow?.name ?? opts.serviceId,
    detail: {
      serviceId: opts.serviceId,
      serviceName: svcRow?.name,
      fromDeploymentId: current.id,
      targetDeploymentId: target.id,
      newDeploymentId: created!.id,
      trigger: opts.trigger,
      elapsedSec: Math.round(elapsed / 1000),
    },
  })

  handlers.log?.warn(
    {
      service: svcRow?.name,
      fromDeployment: current.id,
      restoredRelease: target.id,
      trigger: opts.trigger,
    },
    'canary watchdog auto-rolled back service to previous release'
  )

  return {
    action: 'rolled_back',
    fromDeploymentId: current.id,
    targetDeploymentId: target.id,
    newDeploymentId: created!.id,
    trigger: opts.trigger,
  }
}

/** Reset consecutive unhealthy count when container reports healthy. */
export async function recordCanaryHealthy(
  ctx: AppContext,
  deploymentId: string
): Promise<void> {
  await ctx.redis.del(`canary:fail:${deploymentId}`).catch(() => {})
}
