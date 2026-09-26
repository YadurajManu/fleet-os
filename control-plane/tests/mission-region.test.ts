import 'dotenv/config'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { nodes, orgs, users } from '../src/db/schema.js'

let ctx: AppContext
let app: FastifyInstance
let token: string
let outsider: string
let fleetId: string
let nodeId: string
const made: { orgs: string[]; users: string[] } = { orgs: [], users: [] }

before(async () => {
  ctx = createContext(loadConfig())
  app = await buildServer(ctx)
  for (const label of ['owner', 'outsider']) {
    const signup = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: `mission-${label}-${Date.now()}@example.test`, password: 'a-long-enough-password' } })
    assert.equal(signup.statusCode, 201, signup.body)
    const body = signup.json()
    made.orgs.push(body.org.id)
    made.users.push(body.user.id)
    if (label === 'owner') { token = body.accessToken; fleetId = body.fleet.id }
    else outsider = body.accessToken
  }
  const [node] = await ctx.db.insert(nodes).values({ fleetId, name: 'mission-node', arch: 'arm64', cpuCores: 4, ramMb: 8192, diskMb: 32768, tags: ['ssd'], agentTokenHash: `mission-${Date.now()}` } as never).returning()
  nodeId = node!.id
})

after(async () => {
  await app.close()
  for (const id of made.orgs) await ctx.db.delete(orgs).where(eq(orgs.id, id))
  for (const id of made.users) await ctx.db.delete(users).where(eq(users.id, id))
  await closeContext(ctx)
})

test('coarse region is editable only inside the caller’s fleet', async () => {
  const url = `/fleets/${fleetId}/nodes/${nodeId}/region`
  const own = await app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: { region: 'europe' } })
  assert.equal(own.statusCode, 200, own.body)
  const [node] = await ctx.db.select({ tags: nodes.tags }).from(nodes).where(eq(nodes.id, nodeId))
  assert.deepEqual(node?.tags, ['ssd', 'region:europe'])

  const outside = await app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${outsider}` }, payload: { region: 'oceania' } })
  assert.equal(outside.statusCode, 404)
  const outsideTraffic = await app.inject({ method: 'GET', url: `/fleets/${fleetId}/traffic`, headers: { authorization: `Bearer ${outsider}` } })
  assert.equal(outsideTraffic.statusCode, 404)
  const invalid = await app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: { region: 'my-house' } })
  assert.equal(invalid.statusCode, 422)

  const clear = await app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: { region: null } })
  assert.equal(clear.statusCode, 200, clear.body)
  const [cleared] = await ctx.db.select({ tags: nodes.tags }).from(nodes).where(eq(nodes.id, nodeId))
  assert.deepEqual(cleared?.tags, ['ssd'])
})
