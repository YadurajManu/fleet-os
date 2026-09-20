import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ServerResponse } from 'http'
import type { Redis } from 'ioredis'
import type { AppContext } from './context.js'
import { services, nodes } from '../db/schema.js'

const CHANNEL_PREFIX = 'fleet:logs:'

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
const sharedSubs = new Map<string, { subscriber: Redis; count: number }>()

async function getSubscriber(redis: Redis, channel: string): Promise<Redis> {
  const existing = sharedSubs.get(channel)
  if (existing) {
    existing.count++
    return existing.subscriber
  }
  const subscriber = redis.duplicate()
  await subscriber.connect()
  await subscriber.subscribe(channel)
  sharedSubs.set(channel, { subscriber, count: 1 })
  return subscriber
}

async function releaseSubscriber(redis: Redis, channel: string): Promise<void> {
  const existing = sharedSubs.get(channel)
  if (!existing) return
  existing.count--
  if (existing.count <= 0) {
    await existing.subscriber.unsubscribe(channel)
    await existing.subscriber.quit().catch(() => {})
    sharedSubs.delete(channel)
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
  const channel = `${CHANNEL_PREFIX}${serviceName}`
  const redis = ctx.redis

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
        const payload = JSON.parse(raw) as { logs?: Array<{ service: string; text: string }>; at?: number }
        const logs = payload.logs ?? []
        for (const entry of logs) {
          if (entry.service === serviceName) {
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

  // Set SSE headers.
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const buildSeed = await redis.lrange(`build:logs:${serviceId}`, 0, 199).catch(() => [])
  for (const line of buildSeed.reverse()) { try { seed.push(JSON.parse(line)) } catch {} }
  // Send seed.
  for (const entry of seed) {
    reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`)
  }
  ;(reply.raw as ServerResponse & { flush: () => void }).flush?.()

  // Subscribe for live entries.
  const subscriber = await getSubscriber(redis, channel)

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

  // Clean up on client disconnect.
  reply.raw.on('close', async () => {
    subscriber.off('message', onMessage)
    await releaseSubscriber(redis, channel)
  })
}

/**
 * Register the log stream SSE route.
 */
export function registerLogStream(app: FastifyInstance): void {
  app.get(
    '/services/:serviceId/logs/stream',
    {
      preHandler: async (req: FastifyRequest<{ Params: { serviceId: string } }>) => {
        const { serviceId } = req.params
        const [service] = await (req.server.ctx as AppContext).db
          .select({ id: services.id })
          .from(services)
          .where(eq(services.id, serviceId))
          .limit(1)
        if (!service) throw { statusCode: 404, code: 'not_found', message: 'Service not found' }
      },
    },
    async (_req: FastifyRequest<{ Params: { serviceId: string } }>, reply: FastifyReply) => {
      const { serviceId } = _req.params
      await logStreamHandler(serviceId, _req.server.ctx as AppContext, reply)
      return reply
    }
  )
}

/**
 * Publish a log entry to the Redis channel for a service.
 */
export async function publishLog(
  redis: Redis,
  serviceName: string,
  entry: Omit<LogEntry, 'at'> & { at?: number }
): Promise<void> {
  const channel = `${CHANNEL_PREFIX}${serviceName}`
  const fullEntry: LogEntry = {
    ...entry,
    at: entry.at ?? Date.now(),
  }
  await redis.publish(channel, JSON.stringify(fullEntry)).catch(() => {})
}
