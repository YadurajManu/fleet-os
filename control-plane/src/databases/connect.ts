import { WebSocketServer, type WebSocket } from 'ws'
import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { Duplex, Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../api/context.js'
import { tenantDatabases, orgMembers, fleets } from '../db/schema.js'
import { can } from '../auth/rbac.js'
import { sessionActive } from '../auth/tokens.js'
import { DatabaseTunnel } from './tunnel.js'

const route =
  /^\/(?:api\/)?fleets\/([a-f\d-]{36})\/projects\/([^/]+)\/databases\/([a-f\d-]{36})\/connect$/

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
    const [, fleetId, encodedProject, databaseId] = match
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
          id: tenantDatabases.id,
          nodeId: tenantDatabases.nodeId,
          fleetId: tenantDatabases.fleetId,
          project: tenantDatabases.project,
          generation: tenantDatabases.generation,
          engine: tenantDatabases.engine,
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
        const abort = new AbortController()
        let stream
        try {
          stream = tunnel.open(
            {
              identity: {
                id: target.id,
                nodeId: target.nodeId!,
                fleetId: target.fleetId,
                project: target.project,
                generation: target.generation,
              },
              role: 'database',
              timeoutMs: 60 * 60 * 1000,
              port: target.engine === 'redis' ? 6379 : 5432,
            },
            abort.signal,
          )
        } catch {
          client.close(1013, 'Database node disconnected')
          return
        }
        const rawSocket = socketForWebSocket(client)
        let closed = false
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
        client.on('message', (data, isBinary) => {
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
        stream.once('error', finish)
        stream.once('close', finish)
        client.once('close', finish)
        client.once('error', finish)
        app.log.info(
          { fleetId, databaseId, userId: claims.sub, sessionId: randomUUID() },
          'database connect session started',
        )
      })
    } catch {
      reject(socket, 500)
    }
  })
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
