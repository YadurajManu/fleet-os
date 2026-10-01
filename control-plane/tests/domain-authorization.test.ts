import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { loadConfig } from '../src/config.js'
import { createContext, closeContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { orgs, fleets, services, serviceDomains } from '../src/db/schema.js'

test('Caddy can issue certificates only for verified, attached public domains', async () => {
  const ctx = createContext(loadConfig())
  const app = await buildServer(ctx)
  const [org] = await ctx.db.insert(orgs).values({ name: `domains-${Date.now()}` }).returning()
  try {
    const [fleet] = await ctx.db.insert(fleets).values({ orgId: org!.id, name: 'domains' }).returning()
    const [service] = await ctx.db.insert(services).values({ fleetId: fleet!.id, name: 'web', requestRamMb: 256 }).returning()
    const host = `test-${service!.id}.example.com`
    const ask = () => app.inject({ method: 'GET', url: `/internal/domain-allowed?domain=${host}` })
    assert.equal((await ask()).statusCode, 403)
    const [domain] = await ctx.db.insert(serviceDomains).values({ serviceId: service!.id, host, kind: 'custom', source: 'api', challenge: 'proof' }).returning()
    assert.equal((await ask()).statusCode, 403)
    await ctx.db.update(serviceDomains).set({ verifiedAt: new Date() }).where(eq(serviceDomains.id, domain!.id))
    assert.equal((await ask()).statusCode, 204)
    await ctx.db.update(services).set({ internal: true }).where(eq(services.id, service!.id))
    assert.equal((await ask()).statusCode, 403)
    await ctx.db.update(services).set({ internal: false }).where(eq(services.id, service!.id))
    await ctx.db.delete(serviceDomains).where(eq(serviceDomains.id, domain!.id))
    assert.equal((await ask()).statusCode, 403)
  } finally {
    await ctx.db.delete(orgs).where(eq(orgs.id, org!.id))
    await app.close()
    await closeContext(ctx)
  }
})
