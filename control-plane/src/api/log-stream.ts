import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ServerResponse } from 'http'
import type { Redis } from 'ioredis'
import type { AppContext } from './context.js'
import { services, nodes } from '../db/schema.js'
import { requireServicePermission } from './services.routes.js'
import { sessionActive } from '../auth/tokens.js'

const CHANNEL_PREFIX = 'fleet:logs:'

/**
 * Runtime log channels are an authorization boundary. Service names are only
 * unique within a project and were previously enough to leak live log lines
 * between fleets (or same-named projects in one fleet).
 */
export const logChannel = (fleetId: string, serviceId: string) =>
  `${CHANNEL_PREFIX}${fleetId}:${serviceId}`

interface LogEntry {
  serviceId?: string
  service: string
  text: string
  nodeId: string
  deploymentId?: string
  at: number
}

/**
 * Track shared subscribers so multiple clients watching the same
 * service share one Redis subscription instead of one per client.
 */
const sharedSubs = new Map<string, { subscriber: Redis; count: number; ready: Promise<unknown> }>()

async function getSubscriber(redis: Redis, channel: string): Promise<Redis> {
  const existing = sharedSubs.get(channel)
  if (existing) {
    existing.count++
    await existing.ready
    return existing.subscriber
  }
  const subscriber = redis.duplicate({ lazyConnect: true })
  const ready = subscriber.connect().then(() => subscriber.subscribe(channel))
  sharedSubs.set(channel, { subscriber, count: 1, ready })
  try {
    await ready
  } catch (err) {
    sharedSubs.delete(channel)
    subscriber.disconnect()
    throw err
  }
  return subscriber
}

async function releaseSubscriber(redis: Redis, channel: string): Promise<void> {
  const existing = sharedSubs.get(channel)
  if (!existing) return
  existing.count--
  if (existing.count <= 0) {
    sharedSubs.delete(channel)
    await existing.subscriber.quit().catch(() => existing.subscriber.disconnect())
  }
}

/**
 * SSE endpoint for real-time logs.
 *
 * Seeds the last 200 lines from Redis heartbeat snapshots, then streams
 * new entries as the agent publishes them on every heartbeat.
 */
export async function logStreamHandler(
  serviceId: string,
  ctx: AppContext,
  reply: FastifyReply
): Promise<void> {
  const [service] = await ctx.db
    .select({ id: services.id, name: services.name, fleetId: services.fleetId })
    .from(services)
    .where(eq(services.id, serviceId))
    .limit(1)

  if (!service) {
    throw { statusCode: 404, code: 'not_found', message: 'Service not found' }
  }

  const { name: serviceName, fleetId } = service
  const channel = logChannel(fleetId, serviceId)
  const redis = ctx.redis
  const sameNamed = await ctx.db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.fleetId, fleetId), eq(services.name, serviceName)))
  // Old agents did not report a service UUID. Preserve their tails only when
  // the name identifies exactly one service; otherwise omitting a tail is
  // safer than attributing another service's output to this one.
  const allowLegacyName = sameNamed.length === 1

  // Seed: pull recent logs from each node's heartbeat snapshot.
  let seed: LogEntry[] = []
  try {
    const nodeRows = await ctx.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.fleetId, fleetId))
      .limit(50)

    for (const node of nodeRows) {
      const raw = await redis.get(`node:${node.id}:hb`).catch(() => null)
      if (!raw) continue
      try {
        const payload = JSON.parse(raw) as { logs?: Array<{ service: string; service_id?: string; text: string }>; at?: number }
        const logs = payload.logs ?? []
        for (const entry of logs) {
          if (entry.service_id === serviceId || (!entry.service_id && allowLegacyName && entry.service === serviceName)) {
            seed.push({
              service: entry.service,
              text: entry.text,
              nodeId: node.id,
              at: payload.at ?? Date.now(),
            })
          }
        }
      } catch {
        // Skip malformed heartbeat.
      }
    }
  } catch {
    // Seed is optional.
  }

  seed = seed.slice(-200)

  const buildSeed = await redis.lrange(`build:logs:${serviceId}`, 0, 199).catch(() => [])
  for (const line of buildSeed.reverse()) { try { seed.push(JSON.parse(line)) } catch {} }
  // Subscribe before sending headers so connection failures remain ordinary API errors.
  const subscriber = await getSubscriber(redis, channel)
  if (reply.raw.destroyed) {
    await releaseSubscriber(redis, channel)
    return
  }
  const onMessage = (_: string, message: string) => {
    try {
      const entry: LogEntry = JSON.parse(message)
      if (entry.serviceId && entry.serviceId !== serviceId) return
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`)
      ;(reply.raw as ServerResponse & { flush: () => void }).flush?.()
    } catch {
      // Skip malformed messages.
    }
  }
  subscriber.on('message', onMessage)
  reply.raw.once('close', () => {
    subscriber.off('message', onMessage)
    void releaseSubscriber(redis, channel)
  })

  // Set SSE headers.
  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  reply.raw.flushHeaders()

  // Send seed.
  for (const entry of seed) {
    reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`)
  }
  ;(reply.raw as ServerResponse & { flush: () => void }).flush?.()

}

/**
 * Register the log stream SSE route.
 */
export function registerLogStream(app: FastifyInstance): void {
  app.get<{ Params: { serviceId: string } }>(
    '/services/:serviceId/logs/stream',
    {
      preHandler: requireServicePermission('logs.read'),
    },
    async (_req: FastifyRequest<{ Params: { serviceId: string } }>, reply: FastifyReply) => {
      const { serviceId } = _req.params
      await logStreamHandler(serviceId, _req.server.ctx as AppContext, reply)
      if (reply.raw.destroyed) return reply
      const timer = setInterval(() => {
        void sessionActive(_req.server.ctx.redis, _req.user).then(active => {
          const exp = (_req.user as { exp?: number }).exp
          if (!active || !exp || Date.now() >= exp * 1000) reply.raw.end()
        }).catch(() => reply.raw.end())
      }, 5_000)
      timer.unref()
      reply.raw.once('close', () => clearInterval(timer))
      return reply
    }
  )
}

/**
 * Publish a log entry to the Redis channel for a service.
 */
export async function publishLog(
  redis: Redis,
  fleetId: string,
  serviceId: string,
  entry: Omit<LogEntry, 'at'> & { at?: number }
): Promise<void> {
  const channel = logChannel(fleetId, serviceId)
  const fullEntry: LogEntry = {
    ...entry,
    at: entry.at ?? Date.now(),
  }
  await redis.publish(channel, JSON.stringify(fullEntry)).catch(() => {})
}
