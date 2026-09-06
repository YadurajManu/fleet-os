import { WebSocketServer, WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../api/context.js'
import { nodes, orgMembers, fleets } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { TunnelRegistry } from './registry.js'

/**
 * Browser → Control Plane → Agent terminal proxy.
 *
 * Handles WebSocket upgrades on `/fleets/:fleetId/nodes/:nodeId/terminal`.
 * Authenticates the JWT from the query string, verifies fleet membership,
 * then bridges the browser WebSocket to the node's reverse tunnel.
 */
export function setupTerminalServer(
  app: FastifyInstance,
  ctx: AppContext,
  registry: TunnelRegistry
) {
  const wss = new WebSocketServer({ noServer: true })

  app.server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`)

    // Match /fleets/:fleetId/nodes/:nodeId/terminal (with optional /api prefix)
    const match = url.pathname.match(
      /^(?:\/api)?\/fleets\/([a-f0-9-]+)\/nodes\/([a-f0-9-]+)\/terminal$/
    )
    if (!match) return // Not our path — let other upgrade handlers run.

    const [, fleetId, nodeId] = match

    // Authenticate: JWT from query string `?token=...`
    const token = url.searchParams.get('token')
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    try {
      const decoded = app.jwt.verify<{ sub: string; typ: string }>(token)
      if (decoded.typ !== 'access') {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      const userId = decoded.sub

      // Verify fleet membership
      const rows = await ctx.db
        .select({ orgId: fleets.orgId, role: orgMembers.role })
        .from(fleets)
        .innerJoin(orgMembers, eq(orgMembers.orgId, fleets.orgId))
        .where(and(eq(fleets.id, fleetId!), eq(orgMembers.userId, userId)))
        .limit(1)

      if (!rows[0]) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }

      // Verify node exists in this fleet
      const nodeRows = await ctx.db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.id, nodeId!), eq(nodes.fleetId, fleetId!)))
        .limit(1)

      if (!nodeRows[0]) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }

      // Verify tunnel is connected
      if (!registry.has(nodeId!)) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        socket.destroy()
        return
      }

      // Upgrade to WebSocket
      wss.handleUpgrade(req, socket, head, (browserWs) => {
        const sessionId = randomUUID()

        app.log.info(
          { nodeId, fleetId, userId, sessionId },
          'terminal session started'
        )

        // Start the terminal on the agent
        const started = registry.startTerminal(
          nodeId!,
          sessionId,
          browserWs,
          80,
          24
        )

        if (!started) {
          browserWs.send(
            JSON.stringify({
              type: 'terminal_close',
              id: sessionId,
              error: 'Node tunnel is not connected',
            })
          )
          browserWs.close()
          return
        }

        // Handle browser → agent messages
        browserWs.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString())
            switch (msg.type) {
              case 'terminal_data':
                registry.sendTerminalData(nodeId!, sessionId, msg.data)
                break
              case 'terminal_resize':
                registry.resizeTerminal(
                  nodeId!,
                  sessionId,
                  msg.cols ?? 80,
                  msg.rows ?? 24
                )
                break
              case 'terminal_close':
                registry.closeTerminal(nodeId!, sessionId)
                browserWs.close()
                break
            }
          } catch {
            // ignore malformed messages
          }
        })

        browserWs.on('close', () => {
          app.log.info({ sessionId, nodeId }, 'terminal session closed')
          registry.closeTerminal(nodeId!, sessionId)
          registry.closeTerminalSessionsForBrowser(browserWs)
        })

        browserWs.on('error', () => {
          registry.closeTerminal(nodeId!, sessionId)
          registry.closeTerminalSessionsForBrowser(browserWs)
        })
      })
    } catch (err) {
      app.log.error({ err }, 'terminal upgrade auth failed')
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
    }
  })
}
