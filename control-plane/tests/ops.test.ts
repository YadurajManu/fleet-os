import 'dotenv/config'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { platformOperators, users } from '../src/db/schema.js'

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
