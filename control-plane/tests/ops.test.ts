import 'dotenv/config'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { platformOperators, users, nodes, fleets } from '../src/db/schema.js'
import { syncOpsSignals } from '../src/ops/incidents.js'

let ctx: AppContext
let app: FastifyInstance
let userId: string
let token: string

before(async () => {
  ctx = createContext(loadConfig())
  app = await buildServer(ctx)
  const signup = await app.inject({ method: 'POST', url: '/auth/signup', payload: {
    email: `ops-${Date.now()}@example.test`, password: 'a-long-enough-password',
  } })
  assert.equal(signup.statusCode, 201, signup.body)
  userId = signup.json().user.id
  token = signup.json().accessToken
})
after(async () => {
  await app.close()
  if (userId) await ctx.db.delete(users).where(eq(users.id, userId))
  await closeContext(ctx)
})

test('customer owner cannot read platform data without separate grant', async () => {
  const response = await app.inject({ url: '/ops/summary', headers: { authorization: `Bearer ${token}` } })
  assert.equal(response.statusCode, 403)
  assert.equal(response.body.includes('verified operator'), true)
})

test('platform grant still requires verified email and TOTP', async () => {
  await ctx.db.insert(platformOperators).values({ userId })
  const headers = { authorization: `Bearer ${token}` }
  assert.equal((await app.inject({ url: '/ops/me', headers })).statusCode, 403)
  await ctx.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId))
  assert.equal((await app.inject({ url: '/ops/me', headers })).statusCode, 403)
  await ctx.db.update(users).set({ totpSecret: 'test-only-secret' }).where(eq(users.id, userId))
  const access = await app.inject({ url: '/ops/me', headers })
  assert.equal(access.statusCode, 200, access.body)
  const summary = await app.inject({ url: '/ops/summary?days=30', headers })
  assert.equal(summary.statusCode, 200, summary.body)
  assert.ok(summary.json().counts.verified_users >= 1, summary.body)
  assert.equal(summary.json().storage.registryBytes, null)
  assert.equal((await app.inject({ url: '/ops/summary?days=365', headers })).statusCode, 400)
  const accounts = await app.inject({ url: '/ops/users?q=ops-', headers })
  assert.equal(accounts.statusCode, 200, accounts.body)
  assert.ok(accounts.json().users.some((entry: { id: string }) => entry.id === userId))
  assert.equal(JSON.stringify(accounts.json()).includes('test-only-secret'), false)
  const detail = await app.inject({ url: `/ops/users/${userId}`, headers })
  assert.equal(detail.statusCode, 200, detail.body)
  assert.equal(detail.json().user.id, userId)
  assert.equal(typeof detail.json().user.fleets, 'number')
  assert.equal(JSON.stringify(detail.json()).includes('test-only-secret'), false)
})

test('incident collection groups stale heartbeats, preserves acknowledgement and records recovery', async () => {
  const [fleet] = await ctx.db.select().from(fleets).limit(1)
  const [node] = await ctx.db.insert(nodes).values({ fleetId: fleet!.id, name: 'ops-stale-test', arch: 'arm64', cpuCores: 2, ramMb: 2048, diskMb: 10000, agentTokenHash: 'ops-test', lastHeartbeatAt: new Date(Date.now() - 600_000) }).returning()
  const headers = { authorization: `Bearer ${token}` }
  const startedAt = ctx.startedAt.getTime()
  ctx.startedAt.setTime(Date.now() - 3_600_000)
  try {
    await syncOpsSignals(ctx)
    await syncOpsSignals(ctx)
    const [incident] = await ctx.sql`select id,status from platform_incidents where signal_key=${'node:' + node!.id}`
    assert.equal(incident!.status, 'open')
    const url = `/ops/incidents/${incident!.id}`
    const detail = await app.inject({ url, headers })
    assert.equal(detail.statusCode, 200, detail.body)
    assert.equal(detail.json().events.length, 1, 'polling does not duplicate incidents or timeline events')
    assert.equal(JSON.stringify(detail.json()).includes('ops-test'), false, 'agent credentials excluded')
    const cookieWrite = await app.inject({ method: 'POST', url: url + '/actions', headers: { cookie: `fleet_access_token=${token}` }, payload: { action: 'acknowledge' } })
    assert.equal(cookieWrite.statusCode, 403, cookieWrite.body)
    assert.equal((await app.inject({ method: 'POST', url: url + '/actions', headers, payload: { action: 'acknowledge' } })).statusCode, 200)
    await syncOpsSignals(ctx)
    assert.equal((await app.inject({ url, headers })).json().incident.status, 'acknowledged')
    assert.equal((await app.inject({ method: 'POST', url: url + '/actions', headers, payload: { action: 'resolve' } })).statusCode, 400, 'resolution requires explanation')
    assert.equal((await app.inject({ method: 'POST', url: url + '/actions', headers, payload: { action: 'note', note: 'Checking network connectivity.' } })).statusCode, 200)
    await ctx.db.update(nodes).set({ lastHeartbeatAt: new Date() }).where(eq(nodes.id, node!.id))
    await syncOpsSignals(ctx)
    const recovered = (await app.inject({ url, headers })).json()
    assert.equal(recovered.incident.status, 'resolved')
    assert.equal(recovered.events.at(-1).action, 'signal_cleared')
    assert.equal((await app.inject({ method: 'POST', url: url + '/actions', headers, payload: { action: 'resolve', note: 'Already recovered.' } })).statusCode, 409)
    const security = await app.inject({ url: '/ops/security', headers })
    assert.equal(security.statusCode, 200, security.body)
    assert.ok(security.json().events.some((event: { target_id: string }) => event.target_id === incident!.id))
    assert.equal(security.body.includes('test-only-secret'), false)
  } finally {
    ctx.startedAt.setTime(startedAt)
    await ctx.sql`delete from platform_incidents where signal_key=${'node:' + node!.id}`
    await ctx.db.delete(nodes).where(eq(nodes.id, node!.id))
  }
})

test('infrastructure, filters and deployment lookup expose bounded data', async () => {
  const headers = { authorization: `Bearer ${token}` }
  const infra = await app.inject({ url: '/ops/infrastructure', headers })
  assert.equal(infra.statusCode, 200, infra.body)
  assert.ok(Number(infra.json().postgres.bytes) > 0)
  assert.equal(infra.json().registry.status, 'not_configured')
  assert.equal(infra.json().api.windowMinutes, 15)
  assert.equal((await app.inject({ url: '/ops/users?country=unknown', headers })).statusCode, 200)
  assert.equal((await app.inject({ url: '/ops/users?country=invalid', headers })).statusCode, 400)
  assert.equal((await app.inject({ url: '/ops/deployments', headers })).statusCode, 200)
  assert.equal((await app.inject({ url: '/ops/deployments/not-a-uuid', headers })).statusCode, 404)
  assert.equal((await app.inject({ url: '/ops/incidents?status=invalid', headers })).statusCode, 400)
})
