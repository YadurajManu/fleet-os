import { and, eq, isNotNull, or } from 'drizzle-orm'
import { resolve4 } from 'node:dns/promises'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { services, serviceDomains } from '../db/schema.js'
import { domainDns, domainKind, domainTls, newDomainChallenge, normalizeDomain } from '../ingress/domains.js'
import { invalidateRouteHosts } from '../ingress/routes.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from './errors.js'
import { loadService, requireServicePermission } from './services.routes.js'

const idParams = z.object({ serviceId: z.string().uuid(), domainId: z.string().uuid() })

function hostInput(value: string, zone: string) {
  try {
    const host = normalizeDomain(value.includes('.') ? value : `${value}.${zone}`)
    return { host, kind: domainKind(host, zone) }
  } catch (error) {
    throw ApiError.unprocessable('invalid_domain', (error as Error).message)
  }
}

export async function domainRoutes(app: FastifyInstance) {
  const { db, config } = app.ctx
  const zone = config.INGRESS_ZONE.toLowerCase()
  // DNS-only direct-TLS hostname. A customer subdomain may CNAME here; an apex
  // points its A record at the same public addresses.
  const target = `fleetregistry.${zone}`

  app.get('/services/:serviceId/domains', { preHandler: requireServicePermission('service.read') }, async (req) => {
    const { service } = await loadService(app, req.params as { serviceId: string })
    const domains = await db.select().from(serviceDomains).where(eq(serviceDomains.serviceId, service.id))
    const targetAddresses = await resolve4(target).catch(() => [] as string[])
    return { managed: service.hostname, primary: service.domain ?? service.hostname, target, targetAddresses,
      domains: domains.map((d) => ({ ...d, primary: d.host === service.domain,
        status: d.kind === 'managed_alias' ? 'attached' : d.tlsVerifiedAt ? 'https_verified' : d.verifiedAt ? 'ownership_verified' : 'waiting_for_ownership' })) }
  })

  app.post('/services/:serviceId/domains', { preHandler: requireServicePermission('service.update') }, async (req, reply) => {
    const { service } = await loadService(app, req.params as { serviceId: string })
    if (service.internal) throw ApiError.unprocessable('internal_service', 'Internal services cannot have public domains')
    const body = z.object({ host: z.string().min(1).max(253) }).safeParse(req.body)
    if (!body.success) throw ApiError.badRequest('invalid_domain', 'Send { host }')
    const { host, kind } = hostInput(body.data.host, zone)
    const occupied = await db.select({ id: services.id }).from(services)
      .where(or(eq(services.hostname, host), eq(services.domain, host))).limit(1)
    if (occupied.length) throw ApiError.conflict('domain_taken', 'That address is already in use')
    const count = await db.select({ id: serviceDomains.id }).from(serviceDomains)
      .where(eq(serviceDomains.serviceId, service.id))
    if (count.length >= 10) throw ApiError.unprocessable('domain_limit', 'A service can have up to 10 additional domains')
    const challenge = kind === 'custom' ? newDomainChallenge() : null
    let row
    try {
      row = await db.transaction(async (tx) => {
        const [created] = await tx.insert(serviceDomains).values({ serviceId: service.id, host, kind,
          source: 'api', challenge, verifiedAt: kind === 'managed_alias' ? new Date() : null }).returning()
        await recordAudit(tx, { orgId: req.orgId!, actorUserId: req.userId, action: 'service.domain_added',
          targetType: 'service', targetId: service.id, metadata: { host, kind } })
        return created!
      })
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw ApiError.conflict('domain_taken', 'That address is already in use')
      throw error
    }
    await invalidateRouteHosts(app.ctx, [host])
    const targetAddresses = kind === 'custom' ? await resolve4(target).catch(() => [] as string[]) : []
    return reply.code(201).send({ domain: row, dns: kind === 'custom'
      ? { ownership: { type: 'TXT', name: `_fleet-challenge.${host}`, value: challenge },
          routing: { name: host, cname: target, addresses: targetAddresses } }
      : null })
  })

  app.post('/services/:serviceId/domains/:domainId/check', { preHandler: requireServicePermission('service.update') }, async (req) => {
    const { serviceId, domainId } = idParams.parse(req.params)
    const { service } = await loadService(app, { serviceId })
    const [domain] = await db.select().from(serviceDomains).where(and(eq(serviceDomains.id, domainId), eq(serviceDomains.serviceId, service.id))).limit(1)
    if (!domain) throw ApiError.notFound('Domain')
    if (domain.kind === 'managed_alias') return { domain, ownership: true, routing: true, status: 'attached' }
    const allowed = await app.ctx.redis.set(`domain-check:${domain.id}`, '1', 'EX', 5, 'NX')
    if (!allowed) throw ApiError.tooManyRequests('check_too_soon', 'Wait five seconds before checking this domain again')
    const dns = await domainDns(domain.host, domain.challenge, target)
    if (dns.ownership !== Boolean(domain.verifiedAt)) {
      await db.transaction(async (tx) => {
        await tx.update(serviceDomains).set({
          verifiedAt: dns.ownership ? domain.verifiedAt ?? new Date() : null,
          tlsVerifiedAt: null,
        }).where(eq(serviceDomains.id, domain.id))
        if (!dns.ownership && service.domain === domain.host)
          await tx.update(services).set({ domain: null }).where(eq(services.id, service.id))
        if (dns.ownership && !domain.verifiedAt) {
          await recordAudit(tx, { orgId: req.orgId!, actorUserId: req.userId, action: 'service.domain_verified',
            targetType: 'service', targetId: service.id, metadata: { host: domain.host } })
        }
      })
      await invalidateRouteHosts(app.ctx, [domain.host])
    }
    // Caddy's ask endpoint must see verifiedAt before this handshake, or the
    // very first check could never obtain the certificate it is checking.
    const tls = dns.ownership && dns.routing && dns.targetA.length > 0
      ? await domainTls(domain.host, dns.targetA[0]!) : false
    if (tls !== Boolean(domain.tlsVerifiedAt))
      await db.update(serviceDomains).set({ tlsVerifiedAt: tls ? new Date() : null }).where(eq(serviceDomains.id, domain.id))
    return { domain: { ...domain, verifiedAt: dns.ownership ? domain.verifiedAt ?? new Date() : null,
        tlsVerifiedAt: tls ? new Date() : null },
      ownership: dns.ownership, routing: dns.routing, tls, observedA: dns.actualA, observedAAAA: dns.actualAAAA, targetA: dns.targetA,
      status: !dns.ownership ? 'waiting_for_ownership' : !dns.routing ? 'waiting_for_routing' : !tls ? 'securing_https' : 'https_verified' }
  })

  app.post('/services/:serviceId/domains/:domainId/primary', { preHandler: requireServicePermission('service.update') }, async (req) => {
    const { serviceId, domainId } = idParams.parse(req.params)
    const { service, orgId } = await loadService(app, { serviceId })
    const [domain] = await db.select().from(serviceDomains).where(and(eq(serviceDomains.id, domainId), eq(serviceDomains.serviceId, service.id))).limit(1)
    if (!domain) throw ApiError.notFound('Domain')
    if (!domain.verifiedAt) throw ApiError.unprocessable('unverified_domain', 'Verify ownership before making this the primary URL')
    if (domain.kind === 'custom') {
      const dns = await domainDns(domain.host, domain.challenge, target)
      if (!dns.ownership || !dns.routing || !dns.targetA.length)
        throw ApiError.unprocessable('dns_not_ready', `Keep the ownership TXT and point ${domain.host} to ${target} before making it primary`)
      if (!(await domainTls(domain.host, dns.targetA[0]!)))
        throw ApiError.unprocessable('tls_not_ready', `HTTPS for ${domain.host} is not ready. Check ports 80/443 and retry Check DNS.`)
    }
    await db.transaction(async (tx) => {
      await tx.update(services).set({ domain: domain.host }).where(eq(services.id, service.id))
      await recordAudit(tx, { orgId, actorUserId: req.userId, action: 'service.domain_primary',
        targetType: 'service', targetId: service.id, metadata: { host: domain.host } })
    })
    return { primary: domain.host }
  })

  app.post('/services/:serviceId/domains/managed/primary', { preHandler: requireServicePermission('service.update') }, async (req) => {
    const { service, orgId } = await loadService(app, req.params as { serviceId: string })
    if (!service.hostname) throw ApiError.unprocessable('internal_service', 'Internal services have no public URL')
    await db.transaction(async (tx) => {
      await tx.update(services).set({ domain: null }).where(eq(services.id, service.id))
      await recordAudit(tx, { orgId, actorUserId: req.userId, action: 'service.domain_primary',
        targetType: 'service', targetId: service.id, metadata: { host: service.hostname } })
    })
    return { primary: service.hostname }
  })

  app.delete('/services/:serviceId/domains/:domainId', { preHandler: requireServicePermission('service.update') }, async (req) => {
    const { serviceId, domainId } = idParams.parse(req.params)
    const { service, orgId } = await loadService(app, { serviceId })
    const [domain] = await db.select().from(serviceDomains).where(and(eq(serviceDomains.id, domainId), eq(serviceDomains.serviceId, service.id))).limit(1)
    if (!domain) throw ApiError.notFound('Domain')
    if (domain.source === 'manifest') throw ApiError.conflict('manifest_owned', 'Remove this domain from fleet.yaml and apply the manifest')
    await db.transaction(async (tx) => {
      if (service.domain === domain.host) await tx.update(services).set({ domain: null }).where(eq(services.id, service.id))
      await tx.delete(serviceDomains).where(eq(serviceDomains.id, domain.id))
      await recordAudit(tx, { orgId, actorUserId: req.userId, action: 'service.domain_removed',
        targetType: 'service', targetId: service.id, metadata: { host: domain.host } })
    })
    await invalidateRouteHosts(app.ctx, [domain.host])
    return { removed: domain.host, primary: service.domain === domain.host ? service.hostname : service.domain ?? service.hostname }
  })

  // Caddy queries this over the private Compose network before issuing TLS.
  // The endpoint returns no account information and fails closed on DB errors.
  app.get('/internal/domain-allowed', async (req, reply) => {
    const q = z.object({ domain: z.string() }).safeParse(req.query)
    if (!q.success) return reply.code(403).send()
    const host = q.data.domain.toLowerCase()
    const [allowed] = await db.select({ id: serviceDomains.id }).from(serviceDomains)
      .innerJoin(services, eq(services.id, serviceDomains.serviceId))
      .where(and(eq(serviceDomains.host, host), eq(serviceDomains.kind, 'custom'),
        isNotNull(serviceDomains.verifiedAt), eq(services.internal, false))).limit(1)
    return reply.code(allowed ? 204 : 403).send()
  })
}
