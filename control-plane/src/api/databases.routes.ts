import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { once } from 'node:events'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { tenantDatabases, databaseOperations, services } from '../db/schema.js'
import { requireFleetPermission } from './guards.js'
import { ApiError } from './errors.js'
import {
  createDatabase,
  actOnDatabase,
  loadDatabase,
  databaseView,
  operationProjection,
  databaseCreateInput,
} from '../databases/lifecycle.js'
import { databaseEnginePlugin } from '../databases/engines.js'
import { fleetSnapshot } from '../scheduler/snapshot.js'
import { placeDatabase } from '../databases/placement.js'
import { streamDatabaseProgress } from '../databases/progress.js'
import {
  linkDatabase,
  listDatabaseLinks,
  unlinkDatabase,
} from '../databases/links.js'
import {
  backupTargetInput,
  createBackupTarget,
  deleteBackupTarget,
  listBackupTargets,
  testBackupTarget,
} from '../databases/backup-targets.js'

const scope = z.object({
  fleetId: z.string().uuid(),
  project: z.string().min(1).max(128),
})
const detail = scope.extend({ databaseId: z.string().uuid() })
function parseRequest<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success)
    throw ApiError.badRequest(
      'invalid_request',
      'Request parameters are invalid. Correct them and retry.',
    )
  return result.data
}
const key = (request: FastifyRequest) => {
  const result = z
    .string()
    .min(1)
    .max(128)
    .safeParse(request.headers['idempotency-key'])
  if (!result.success)
    throw ApiError.badRequest(
      'invalid_idempotency_key',
      'Provide an Idempotency-Key containing 1–128 characters, then retry.',
    )
  return result.data
}
const placement = z
  .object({
    memoryMb: z.coerce.number().int().min(128).max(1048576).default(512),
    cpu: z.coerce.number().positive().max(1024).default(0.5),
    diskMb: z.coerce.number().int().min(1024).max(2147483647).default(10240),
    nodeId: z.string().uuid().optional(),
  })
  .strict()

export async function databaseRoutes(app: FastifyInstance) {
  const ctx = app.ctx
  app.get(
    '/fleets/:fleetId/databases',
    { preHandler: requireFleetPermission('database.read') },
    async (request) => {
      const { fleetId } = parseRequest(
        z.object({ fleetId: z.string().uuid() }),
        request.params,
      )
      const query = parseRequest(
        z.object({
          project: z.string().min(1).max(128).optional(),
          after: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        request.query,
      )
      const rows = await ctx.db
        .select()
        .from(tenantDatabases)
        .where(
          and(
            eq(tenantDatabases.fleetId, fleetId),
            query.project
              ? eq(tenantDatabases.project, query.project)
              : undefined,
            query.after ? gt(tenantDatabases.id, query.after) : undefined,
          ),
        )
        .orderBy(asc(tenantDatabases.id))
        .limit(query.limit + 1)
      return {
        databases: await Promise.all(
          rows.slice(0, query.limit).map((row) => databaseView(ctx, row)),
        ),
        nextCursor:
          rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      }
    },
  )
  const base = '/fleets/:fleetId/projects/:project/databases'
  const targets = '/fleets/:fleetId/projects/:project/backup-targets'
  app.get(
    targets,
    { preHandler: requireFleetPermission('database.read') },
    async (request) => {
      const { fleetId, project } = parseRequest(scope, request.params)
      return { targets: await listBackupTargets(ctx, fleetId, project) }
    },
  )
  app.post(
    targets,
    { preHandler: requireFleetPermission('database.target') },
    async (request, reply) => {
      const { fleetId, project } = parseRequest(scope, request.params)
      const input = parseRequest(backupTargetInput, request.body)
      return reply.code(201).send(
        await createBackupTarget(ctx, fleetId, project, input, {
          orgId: request.orgId!,
          userId: request.userId!,
        }),
      )
    },
  )
  app.delete(
    targets + '/:targetId',
    { preHandler: requireFleetPermission('database.target') },
    async (request) => {
      const { fleetId, project } = parseRequest(scope, request.params)
      const { targetId } = parseRequest(
        z.object({ targetId: z.string().uuid() }),
        request.params,
      )
      return deleteBackupTarget(ctx, fleetId, project, targetId, {
        orgId: request.orgId!,
        userId: request.userId!,
      })
    },
  )
  app.post(
    targets + '/:targetId/test',
    { preHandler: requireFleetPermission('database.target') },
    async (request) => {
      const { fleetId, project } = parseRequest(scope, request.params)
      const { targetId } = parseRequest(
        z.object({ targetId: z.string().uuid() }),
        request.params,
      )
      return testBackupTarget(ctx, fleetId, project, targetId, {
        orgId: request.orgId!,
        userId: request.userId!,
      })
    },
  )
  app.get(
    base + '/:databaseId/links',
    { preHandler: requireFleetPermission('database.read') },
    async (request) => {
      const { fleetId, project, databaseId } = parseRequest(
        detail,
        request.params,
      )
      const [links, projectServices] = await Promise.all([
        listDatabaseLinks(ctx, fleetId, project, databaseId),
        ctx.db
          .select({ id: services.id, name: services.name })
          .from(services)
          .where(
            and(eq(services.fleetId, fleetId), eq(services.project, project)),
          )
          .orderBy(services.name),
      ])
      return { links, services: projectServices }
    },
  )
  app.post(
    base + '/:databaseId/links',
    { preHandler: requireFleetPermission('database.access') },
    async (request) => {
      const { fleetId, project, databaseId } = parseRequest(
        detail,
        request.params,
      )
      const body = parseRequest(
        z
          .object({
            serviceId: z.string().uuid(),
            role: z.enum(['app', 'readonly']).optional(),
            as: z
              .string()
              .regex(/^[A-Z_][A-Z0-9_]{0,63}$/)
              .optional(),
          })
          .strict(),
        request.body,
      )
      return linkDatabase(ctx, fleetId, project, databaseId, body, {
        orgId: request.orgId!,
        userId: request.userId!,
      })
    },
  )
  app.delete(
    base + '/:databaseId/links/:serviceId',
    { preHandler: requireFleetPermission('database.access') },
    async (request) => {
      const { fleetId, project, databaseId } = parseRequest(
        detail,
        request.params,
      )
      const { serviceId } = parseRequest(
        z.object({ serviceId: z.string().uuid() }),
        request.params,
      )
      return unlinkDatabase(ctx, fleetId, project, databaseId, serviceId, {
        orgId: request.orgId!,
        userId: request.userId!,
      })
    },
  )
  app.get(
    base + '/catalog',
    { preHandler: requireFleetPermission('database.read') },
    async (request) => {
      parseRequest(scope, request.params)
      return {
        engines: ['postgres', 'redis'].map((engine) => ({
          engine,
          versions: databaseEnginePlugin(engine).versions,
          modes: engine === 'postgres' ? ['standard'] : ['cache', 'durable'],
          profiles: ['dev', 'standard', 'performance'],
        })),
      }
    },
  )
  app.get(
    base + '/placement',
    { preHandler: requireFleetPermission('database.read') },
    async (request) => {
      const { fleetId } = parseRequest(scope, request.params)
      const query = parseRequest(placement, request.query),
        snapshot = await fleetSnapshot(ctx, fleetId)
      return placeDatabase(
        { id: 'placement', name: 'database', ...query },
        snapshot.nodes,
      )
    },
  )
  app.post(
    base,
    { preHandler: requireFleetPermission('database.create') },
    async (request, reply) => {
      const { fleetId, project } = parseRequest(scope, request.params)
      const input = parseRequest(databaseCreateInput, request.body)
      const result = await createDatabase(
        ctx,
        fleetId,
        project,
        input,
        key(request),
        { orgId: request.orgId!, userId: request.userId! },
      )
      return reply.code(202).send(result)
    },
  )
  app.get(
    base + '/:databaseId',
    { preHandler: requireFleetPermission('database.read') },
    async (request) => {
      const { fleetId, project, databaseId } = parseRequest(
        detail,
        request.params,
      )
      const database = await loadDatabase(ctx, fleetId, project, databaseId)
      const operations = await ctx.db
        .select(operationProjection)
        .from(databaseOperations)
        .where(eq(databaseOperations.databaseId, database.id))
        .orderBy(desc(databaseOperations.createdAt))
        .limit(50)
      return { database: await databaseView(ctx, database), operations }
    },
  )
  app.post(
    base + '/:databaseId/actions',
    { preHandler: requireFleetPermission('database.operate') },
    async (request, reply) => {
      const { fleetId, project, databaseId } = parseRequest(
        detail,
        request.params,
      )
      const { action } = parseRequest(
        z.object({ action: z.enum(['start', 'stop', 'restart']) }).strict(),
        request.body,
      )
      const database = await loadDatabase(ctx, fleetId, project, databaseId)
      return reply.code(202).send(
        await actOnDatabase(ctx, database, action, key(request), {
          orgId: request.orgId!,
          userId: request.userId!,
        }),
      )
    },
  )
  app.get(
    base + '/:databaseId/events',
    { preHandler: requireFleetPermission('database.read') },
    async (request, reply) => {
      const { fleetId, project, databaseId } = parseRequest(
        detail,
        request.params,
      )
      await loadDatabase(ctx, fleetId, project, databaseId)
      const query = parseRequest(
        z.object({
          after: z.coerce
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .optional(),
        }),
        request.query,
      )
      const after =
        query.after ??
        parseRequest(
          z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          request.headers['last-event-id'] ?? 0,
        )
      const abort = new AbortController(),
        closed = () => abort.abort()
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      reply.raw.on('close', closed)
      reply.raw.on('error', closed)
      let checking = false
      const heartbeat = setInterval(() => {
        if (!reply.raw.writableNeedDrain && !reply.raw.destroyed)
          reply.raw.write(': keepalive\n\n')
        if (checking) return
        checking = true
        void requireFleetPermission('database.read')(request, reply)
          .catch(closed)
          .finally(() => {
            checking = false
          })
      }, 15000)
      try {
        reply.raw.write(': connected\n\n')
        for await (const event of streamDatabaseProgress(
          ctx,
          { fleetId, project, databaseId },
          abort.signal,
          after,
        )) {
          if (
            !reply.raw.write(
              `id: ${event.id}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`,
            )
          )
            await once(reply.raw, 'drain', { signal: abort.signal })
        }
      } catch {
        // Closing a stream never serializes database or authentication exceptions.
      } finally {
        clearInterval(heartbeat)
        abort.abort()
        reply.raw.off('close', closed)
        reply.raw.off('error', closed)
        reply.raw.end()
      }
    },
  )
}
