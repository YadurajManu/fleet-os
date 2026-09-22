import 'dotenv/config'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { auditLog, orgs, services, users } from '../src/db/schema.js'
import type { FastifyInstance } from 'fastify'

let ctx: AppContext
let app: FastifyInstance
let token: string
let fleetId: string
let orgId: string
let userId: string

before(async () => {
  ctx = createContext(loadConfig())
  app = await buildServer(ctx)
  const signup = await app.inject({ method: 'POST', url: '/auth/signup', payload: {
    email: `audit-${Date.now()}@example.test`, password: 'a-long-enough-password',
  } })
  assert.equal(signup.statusCode, 201, signup.body)
  const body = signup.json()
  token = body.accessToken
  fleetId = body.fleet.id
  orgId = body.org.id
  userId = body.user.id
  const [service] = await ctx.db.insert(services).values({ fleetId, name: 'api' }).returning()
  await ctx.db.insert(auditLog).values([
    { orgId, actorUserId: userId, action: 'service.deployed', targetType: 'service', targetId: service!.id, createdAt: new Date('2026-09-20T12:00:00Z') },
    { orgId, actorUserId: userId, action: 'service.deleted', targetType: 'service', targetId: null, metadata: { name: 'retired-api' }, createdAt: new Date('2026-09-20T11:00:00Z') },
  ])
})

after(async () => {
  await app.close()
  await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
  await ctx.db.delete(users).where(eq(users.id, userId))
  await closeContext(ctx)
})

test('audit history pages deterministically and resolves current and deleted targets', async () => {
  const headers = { authorization: `Bearer ${token}` }
  const first = await app.inject({ url: `/fleets/${fleetId}/audit?limit=1&action=service.deployed`, headers })
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().entries.length, 1)
  assert.equal(first.json().entries[0].targetName, 'api')
  const page = await app.inject({ url: `/fleets/${fleetId}/audit?limit=1`, headers })
  assert.equal(page.statusCode, 200, page.body)
  assert.ok(page.json().nextCursor)
  const cursor = new URLSearchParams(page.json().nextCursor)
  const next = await app.inject({ url: `/fleets/${fleetId}/audit?limit=1&${cursor}`, headers })
  assert.equal(next.statusCode, 200, next.body)
  assert.notEqual(next.json().entries[0].id, page.json().entries[0].id)
  const deleted = await app.inject({ url: `/fleets/${fleetId}/audit?target=retired-api`, headers })
  assert.equal(deleted.statusCode, 200, deleted.body)
  assert.equal(deleted.json().entries.length, 1)
  assert.equal(deleted.json().entries[0].action, 'service.deleted')
})
