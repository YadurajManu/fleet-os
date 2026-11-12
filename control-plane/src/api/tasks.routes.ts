import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { deployments, nodes, taskReservations } from '../db/schema.js'
import { reserveTask } from '../scheduler/tasks.js'
import { ApiError } from './errors.js'
import { loadService, requireServicePermission } from './services.routes.js'
import { registryAuth } from './agent.routes.js'
import { buildEnv } from '../secrets/store.js'
import { recordAudit } from '../lib/audit.js'
import { sessionActive } from '../auth/tokens.js'
import { nodePlatform } from '../build/platforms.js'

const taskInput = z.object({
  command: z.array(z.string().max(8192).refine(s => !s.includes('\0'))).min(1).max(128),
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
}).refine(value => Boolean(value.command[0]) && value.command.reduce((n, s) => n + Buffer.byteLength(s), 0) <= 32768, 'Command is empty or exceeds 32 KiB')

export async function taskRoutes(app: FastifyInstance) {
  app.post('/services/:serviceId/tasks', { preHandler: requireServicePermission('service.exec') }, async (req, reply) => {
    const parsed = taskInput.safeParse(req.body)
    if (!parsed.success) throw ApiError.badRequest('invalid_task', 'Provide a command argument array and a timeout from 1 to 600 seconds.')
    const { service, orgId } = await loadService(app, req.params as { serviceId: string })
    const [release] = await app.ctx.db.select().from(deployments)
      .where(eq(deployments.serviceId, service.id)).orderBy(desc(deployments.startedAt)).limit(1)
    const nodeId = release?.nodeId ?? service.pinnedNodeId
    const image = release?.imageTags[0] ?? service.image
    if (!nodeId || !image) throw ApiError.unprocessable('task_image_unavailable', 'Deploy this service once to build its image and select its node before running a task.')
    const [node] = await app.ctx.db.select().from(nodes).where(and(eq(nodes.id, nodeId), eq(nodes.fleetId, service.fleetId))).limit(1)
    if (!node?.taskRun) throw ApiError.unprocessable('task_agent_upgrade', 'Upgrade this node’s agent to a version supporting one-off tasks.')
    if (!app.ctx.tunnels.has(nodeId)) throw ApiError.unprocessable('task_node_offline', 'The service node is disconnected; no task was started.')
    const platform = nodePlatform(node)
    if (service.imagePlatforms.length && !service.imagePlatforms.includes(platform) && !service.allowEmulation) {
      throw ApiError.unprocessable('task_platform_mismatch', 'This image does not support the service node platform.')
    }
    const { env, missing } = await buildEnv(app.ctx, service.fleetId, service)
    if (missing.length) throw ApiError.unprocessable('missing_secrets', `Set the missing service secrets: ${missing.join(', ')}`)
    const registryHost = app.ctx.config.REGISTRY_URL?.replace(/^https?:\/\//, '').split('/')[0]
    const pullAuth = registryHost && image.split('/')[0] === registryHost ? registryAuth(app.ctx.config) : null
    const cpuMillis = Math.max(10, Math.ceil(Number(service.requestCpu) * 1000))
    const memory = Math.max(service.requestRamMb, 6) * 1048576
    const reservationId = await reserveTask(app.ctx, service.fleetId, nodeId, cpuMillis / 1000, memory, parsed.data.timeoutMs)
    try {
      await recordAudit(app.ctx.db, { orgId, actorUserId: req.userId, action: 'service.task_started', targetType: 'service', targetId: service.id, metadata: { deploymentId: release?.id ?? null, nodeId, argumentCount: parsed.data.command.length } })
    } catch (err) {
      await app.ctx.db.delete(taskReservations).where(eq(taskReservations.id, reservationId))
      throw err
    }
    const abort = new AbortController()
    const onClose = () => abort.abort()
    reply.raw.once('close', onClose)
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
    reply.raw.flushHeaders()
    const pulse = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': task running\n\n')
      void sessionActive(app.ctx.redis, req.user).then(active => {
        const exp = (req.user as { exp?: number }).exp
        if (!active || !exp || Date.now() >= exp * 1000) abort.abort()
      }).catch(() => abort.abort())
    }, 5000)
    try {
      const result = await app.ctx.tunnels.runTask(nodeId, {
        service: service.name, image, platform, command: parsed.data.command, env,
        registry_auth: pullAuth, memory_bytes: memory, cpu_millis: cpuMillis,
        timeout_ms: parsed.data.timeoutMs,
      }, abort.signal)
      if (result.cleanupComplete === true || (!result.error && result.cleanupComplete !== false)) await app.ctx.db.delete(taskReservations).where(eq(taskReservations.id, reservationId))
      if (!reply.raw.destroyed) reply.raw.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
      await recordAudit(app.ctx.db, { orgId, actorUserId: req.userId, action: 'service.task_finished', targetType: 'service', targetId: service.id, metadata: { nodeId, exitCode: result.exitCode } }).catch(err => req.log.error({ err, serviceId: service.id }, 'could not audit completed task'))
    } catch (err) {
      await recordAudit(app.ctx.db, { orgId, actorUserId: req.userId, action: abort.signal.aborted ? 'service.task_cancelled' : 'service.task_failed', targetType: 'service', targetId: service.id, metadata: { nodeId } }).catch(() => {})
      if (!reply.raw.destroyed) reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`)
    } finally {
      clearInterval(pulse)
      reply.raw.off('close', onClose)
      if (!reply.raw.destroyed) reply.raw.end()
    }
    return reply
  })
}
