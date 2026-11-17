import { WebSocketServer, type WebSocket } from 'ws'
import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { Duplex, Writable } from 'node:stream'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../api/context.js'
import {
  databaseCredentials,
  tenantDatabases,
  orgMembers,
  fleets,
} from '../db/schema.js'
import { can } from '../auth/rbac.js'
import { sessionActive } from '../auth/tokens.js'
import { openSecret } from '../lib/crypto.js'
import { recordAudit } from '../lib/audit.js'
import type { EngineCommand } from './engines.js'
import { DatabaseTunnel, type DatabaseStream } from './tunnel.js'

const route =
  /^\/(?:api\/)?fleets\/([a-f\d-]{36})\/projects\/([^/]+)\/databases\/([a-f\d-]{36})\/(connect|exec)$/
const execRequest = z.discriminatedUnion('mode', [
  z
    .object({ mode: z.literal('sql'), role: z.enum(['app', 'readonly']) })
    .strict(),
  z
    .object({
      mode: z.literal('redis'),
      role: z.enum(['app', 'readonly']),
      command: z.array(z.string().min(1).max(4096)).min(1).max(64),
    })
    .strict(),
  z.object({ mode: z.literal('dump') }).strict(),
])

export function setupDatabaseConnectServer(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 })
  const tunnel = new DatabaseTunnel(ctx.tunnels)
  app.addHook('onClose', async () => tunnel.close())

  app.server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const match = route.exec(url.pathname)
    if (!match) return
    const [, fleetId, encodedProject, databaseId, action] = match
    let project: string
    try {
      project = decodeURIComponent(encodedProject!)
    } catch {
      return reject(socket, 400)
    }
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token) return reject(socket, 401)

    let claims: { sub: string; typ: string; sid?: string; exp: number }
    try {
      claims = app.jwt.verify(token)
      if (
        claims.typ !== 'access' ||
        !(await sessionActive(ctx.redis, claims)) ||
        Date.now() >= claims.exp * 1000
      )
        return reject(socket, 401)
    } catch {
      return reject(socket, 401)
    }

    try {
      const [target] = await ctx.db
        .select({
          role: orgMembers.role,
          orgId: fleets.orgId,
          id: tenantDatabases.id,
          nodeId: tenantDatabases.nodeId,
          fleetId: tenantDatabases.fleetId,
          project: tenantDatabases.project,
          generation: tenantDatabases.generation,
          engine: tenantDatabases.engine,
          mode: tenantDatabases.mode,
          name: tenantDatabases.name,
          status: tenantDatabases.status,
          deletedAt: tenantDatabases.deletedAt,
        })
        .from(tenantDatabases)
        .innerJoin(fleets, eq(fleets.id, tenantDatabases.fleetId))
        .innerJoin(orgMembers, eq(orgMembers.orgId, fleets.orgId))
        .where(
          and(
            eq(tenantDatabases.id, databaseId!),
            eq(tenantDatabases.fleetId, fleetId!),
            eq(tenantDatabases.project, project),
            eq(orgMembers.userId, claims.sub),
          ),
        )
        .limit(1)
      if (!target) return reject(socket, 404)
      if (!can(target.role, 'database.access')) return reject(socket, 403)
      if (target.deletedAt || target.status !== 'running' || !target.nodeId)
        return reject(socket, 409)
      if (!ctx.tunnels.has(target.nodeId)) return reject(socket, 502)

      wss.handleUpgrade(req, socket, head, (client) => {
        if (action === 'exec') {
          client.once('message', (data, isBinary) => {
            void startExec(
              app,
              ctx,
              tunnel,
              client,
              target,
              claims,
              data,
              isBinary,
            )
          })
          return
        }
        try {
          const abort = new AbortController()
          const stream = tunnel.open(
            {
              identity: databaseIdentity(target),
              role: 'database',
              timeoutMs: 60 * 60 * 1000,
              port: target.engine === 'redis' ? 6379 : 5432,
            },
            abort.signal,
          )
          bridge(app, ctx, client, stream, claims, fleetId!, databaseId!, abort)
        } catch {
          client.close(1013, 'Database node disconnected')
        }
      })
    } catch {
      reject(socket, 500)
    }
  })
}

async function startExec(
  app: FastifyInstance,
  ctx: AppContext,
  tunnel: DatabaseTunnel,
  client: WebSocket,
  target: {
    role: 'viewer' | 'deployer' | 'admin' | 'owner'
    orgId: string
    id: string
    nodeId: string | null
    fleetId: string
    project: string
    name: string
    generation: number
    engine: 'postgres' | 'redis'
    mode: 'standard' | 'cache' | 'durable'
  },
  claims: { sub: string; typ: string; sid?: string; exp: number },
  data: Buffer | ArrayBuffer | Buffer[],
  isBinary: boolean,
) {
  if (isBinary) return client.close(1008, 'Send an execution request first')
  let payload
  try {
    payload = execRequest.parse(JSON.parse(messageBuffer(data).toString()))
  } catch {
    return client.close(1008, 'Execution request is invalid')
  }
  if (
    (target.engine === 'postgres' && !['sql', 'dump'].includes(payload.mode)) ||
    (target.engine === 'redis' && !['redis', 'dump'].includes(payload.mode))
  )
    return client.close(
      1008,
      'Execution mode does not match the database engine',
    )
  if (
    payload.mode === 'redis' &&
    (payload.command.some((arg) => arg.startsWith('-') || arg.includes('\0')) ||
      payload.command.reduce((size, arg) => size + Buffer.byteLength(arg), 0) >
        65536)
  )
    return client.close(1008, 'Redis command arguments are invalid')
  if (payload.mode === 'dump' && !can(target.role, 'database.backup'))
    return client.close(1008, 'Database backup permission is required')
  if (
    payload.mode === 'dump' &&
    target.engine === 'redis' &&
    target.mode !== 'durable'
  )
    return client.close(1008, 'Only durable Redis databases can be exported')

  try {
    const role = payload.mode === 'dump' ? 'owner' : payload.role
    const [row] = await ctx.db
      .select({ encryptedValue: databaseCredentials.encryptedValue })
      .from(databaseCredentials)
      .where(
        and(
          eq(databaseCredentials.databaseId, target.id),
          eq(databaseCredentials.generation, target.generation),
          eq(databaseCredentials.role, role),
        ),
      )
      .limit(1)
    if (!row) return client.close(1011, 'Database credentials unavailable')
    const credentials = z
      .object({ username: z.string().min(1), password: z.string().min(32) })
      .parse(
        JSON.parse(
          openSecret(row.encryptedValue, ctx.config.SECRETS_MASTER_KEY),
        ),
      )
    const command: EngineCommand =
      payload.mode === 'sql'
        ? {
            command: ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
            env: {
              PGHOST: '/var/run/postgresql',
              PGUSER: credentials.username,
              PGPASSWORD: credentials.password,
              PGDATABASE: target.name.replaceAll('-', '_'),
              PGCONNECT_TIMEOUT: '5',
            },
          }
        : payload.mode === 'redis'
          ? {
              command: [
                'redis-cli',
                '--user',
                credentials.username,
                '--raw',
                ...payload.command,
              ],
              env: { REDISCLI_AUTH: credentials.password },
            }
          : target.engine === 'postgres'
            ? {
                command: [
                  'pg_dump',
                  '--format=custom',
                  '--no-owner',
                  '--no-acl',
                  '--dbname',
                  target.name.replaceAll('-', '_'),
                ],
                env: {
                  PGHOST: '/var/run/postgresql',
                  PGUSER: credentials.username,
                  PGPASSWORD: credentials.password,
                  PGCONNECT_TIMEOUT: '5',
                },
              }
            : {
                command: [
                  'redis-cli',
                  '--user',
                  credentials.username,
                  '--raw',
                  '--rdb',
                  '-',
                ],
                env: {
                  REDISCLI_AUTH: credentials.password,
                  FLEET_DB_BACKUP: '1',
                },
              }
    if (
      client.readyState !== client.OPEN ||
      !(await sessionActive(ctx.redis, claims)) ||
      Date.now() >= claims.exp * 1000
    )
      return client.close(1008, 'Database session is no longer active')
    if (payload.mode === 'dump')
      await ctx.db.transaction((tx) =>
        recordAudit(tx, {
          orgId: target.orgId,
          actorUserId: claims.sub,
          action: 'database.export.started',
          targetType: 'tenant_database',
          targetId: target.id,
          metadata: {
            project: target.project,
            engine: target.engine,
            format:
              target.engine === 'postgres' ? 'pg_dump_custom' : 'redis_rdb',
          },
        }),
      )
    const abort = new AbortController()
    const stream = tunnel.open(
      {
        identity: databaseIdentity(target),
        role: 'database',
        timeoutMs: 60 * 60 * 1000,
        command,
      },
      abort.signal,
    )
    bridge(
      app,
      ctx,
      client,
      stream,
      claims,
      target.fleetId,
      target.id,
      abort,
      true,
    )
  } catch {
    client.close(1011, 'Database command could not be started')
  }
}

function databaseIdentity(target: {
  id: string
  nodeId: string | null
  fleetId: string
  project: string
  generation: number
}) {
  return {
    id: target.id,
    nodeId: target.nodeId!,
    fleetId: target.fleetId,
    project: target.project,
    generation: target.generation,
  }
}

function bridge(
  app: FastifyInstance | null,
  ctx: AppContext,
  client: WebSocket,
  stream: DatabaseStream,
  claims: { sub: string; typ: string; sid?: string; exp: number },
  fleetId: string,
  databaseId: string,
  abort: AbortController,
  exec = false,
) {
  let closed = false
  let exitSent = false
  const finish = () => {
    if (closed) return
    closed = true
    clearInterval(authorizationTimer)
    abort.abort()
    stream.destroy()
    if (client.readyState === client.OPEN) client.close()
  }
  const authorizationTimer = setInterval(() => {
    void sessionActive(ctx.redis, claims)
      .then((active) => {
        if (!active || Date.now() >= claims.exp * 1000) finish()
      })
      .catch(finish)
  }, 5000)
  authorizationTimer.unref()

  stream.pipe(
    new Writable({
      write(chunk, _encoding, callback) {
        if (client.readyState !== client.OPEN)
          return callback(new Error('Database client disconnected.'))
        client.send(chunk, { binary: true }, callback)
      },
    }),
  )
  if (exec) {
    stream.once('ready', () => client.send(JSON.stringify({ type: 'ready' })))
    stream.on('stderr', (chunk: Buffer) =>
      client.send(
        JSON.stringify({ type: 'stderr', data: chunk.toString('base64') }),
      ),
    )
    stream.once('exit', (code: number) => {
      exitSent = true
      client.send(JSON.stringify({ type: 'exit', code }), finish)
    })
  }
  const rawSocket = socketForWebSocket(client)
  client.on('message', (data, isBinary) => {
    if (exec && !isBinary) {
      try {
        if (
          (JSON.parse(messageBuffer(data).toString()) as { type?: string })
            .type === 'eof'
        )
          stream.end()
        else finish()
      } catch {
        finish()
      }
      return
    }
    if (!isBinary) return finish()
    const bytes =
      data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Array.isArray(data)
          ? Buffer.concat(data)
          : data
    if (!stream.write(bytes)) rawSocket.pause()
  })
  stream.on('drain', () => rawSocket.resume())
  stream.once('error', () => {
    if (!exec || !exitSent) finish()
  })
  stream.once('close', () => {
    if (!exec || !exitSent) finish()
  })
  client.once('close', finish)
  client.once('error', finish)
  app?.log.info(
    { fleetId, databaseId, userId: claims.sub, sessionId: randomUUID() },
    exec ? 'database exec session started' : 'database connect session started',
  )
}

function messageBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Array.isArray(data) ? Buffer.concat(data) : data
}

function reject(socket: Duplex, status: number) {
  const text =
    status === 401
      ? 'Unauthorized'
      : status === 400
        ? 'Bad Request'
        : status === 403
          ? 'Forbidden'
          : status === 404
            ? 'Not Found'
            : status === 409
              ? 'Conflict'
              : status === 502
                ? 'Bad Gateway'
                : 'Internal Server Error'
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function socketForWebSocket(client: WebSocket): Duplex {
  return (client as WebSocket & { _socket: Duplex })._socket
}
