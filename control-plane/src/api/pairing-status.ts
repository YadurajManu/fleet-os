import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { fleets, nodes, pairingTokens } from '../db/schema.js'
import { requireFleetPermission } from './guards.js'
import { ApiError } from './errors.js'

/** A receipt identifies an attempt, never a bearer credential. */
export async function pairingStatusRoutes(app: FastifyInstance) {
  app.get('/fleets/:fleetId/nodes/pairings/:pairingId', {
    preHandler: requireFleetPermission('node.pair'),
  }, async req => {
    const { fleetId, pairingId } = req.params as { fleetId: string; pairingId: string }
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(pairingId)) throw ApiError.notFound('Pairing')
    const [pairing] = await app.ctx.db.select().from(pairingTokens)
      .where(and(eq(pairingTokens.id, pairingId), eq(pairingTokens.fleetId, fleetId))).limit(1)
    if (!pairing) throw ApiError.notFound('Pairing')
    if (!pairing.consumedByNodeId) return { status: pairing.expiresAt.getTime() <= Date.now() ? 'expired' : 'pending' }
    const [node] = await app.ctx.db.select({ id: nodes.id, name: nodes.name, platform: nodes.platform, engineKind: nodes.engineKind })
      .from(nodes).where(and(eq(nodes.id, pairing.consumedByNodeId), eq(nodes.fleetId, fleetId))).limit(1)
    if (!node) return { status: 'removed' }
    const [fleet] = await app.ctx.db.select().from(fleets).where(eq(fleets.id, fleetId)).limit(1)
    const hb = await app.ctx.heartbeats.last(node.id)
    const fresh = hb && hb.at >= pairing.consumedAt!.getTime() &&
      Date.now() - hb.at <= app.ctx.heartbeats.downAfterMs(fleet!.heartbeatIntervalSec, fleet!.heartbeatMissThreshold)
    return { status: fresh ? 'connected' : 'registered', node, dockerAvailable: fresh ? hb.runtime?.dockerAvailable ?? null : null }
  })
}
