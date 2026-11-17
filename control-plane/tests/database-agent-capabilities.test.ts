import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  createContext,
  closeContext,
  type AppContext,
} from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { fleets, nodes, orgs, pairingTokens } from '../src/db/schema.js'
import { newPairingToken, hashToken } from '../src/lib/tokens.js'
import type { FastifyInstance } from 'fastify'

let ctx: AppContext, app: FastifyInstance
const orgId = randomUUID(),
  fleetId = randomUUID()
const capability = { arch: 'arm64', cpu_cores: 4, ram_mb: 4096, disk_mb: 20000 }
before(async () => {
  ctx = createContext(loadConfig())
  app = await buildServer(ctx)
  await ctx.db
    .insert(orgs)
    .values({ id: orgId, name: 'database-capabilities-test' })
  await ctx.db
    .insert(fleets)
    .values({ id: fleetId, orgId, name: 'database-capabilities-test' })
})
after(async () => {
  await app.close()
  await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
  await closeContext(ctx)
})

async function register(fields: Record<string, unknown>) {
  const token = newPairingToken()
  await ctx.db
    .insert(pairingTokens)
    .values({
      fleetId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60000),
    })
  const response = await app.inject({
    method: 'POST',
    url: '/agent/register',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      ...capability,
      hostname: `db-test-${randomUUID().slice(0, 8)}`,
      ...fields,
    },
  })
  assert.equal(response.statusCode, 201, response.body)
  return response.json() as { node_id: string; agent_token: string }
}

test('v0.2.4 registration and heartbeat remain valid with databases disabled', async () => {
  const old = await register({ agent_version: '0.2.4' })
  const heartbeat = await app.inject({
    method: 'POST',
    url: '/agent/heartbeat',
    headers: { authorization: `Bearer ${old.agent_token}` },
    payload: {
      agent_version: '0.2.4',
      cpu_pct: 2,
      ram_used_mb: 256,
      disk_used_mb: 100,
    },
  })
  assert.equal(heartbeat.statusCode, 200, heartbeat.body)
  const [node] = await ctx.db
    .select()
    .from(nodes)
    .where(eq(nodes.id, old.node_id))
  assert.deepEqual(node!.databaseCapabilities, [])
})

test('capabilities are negotiated explicitly and cleared on downgrade/missing reports', async () => {
  const agent = await register({
    agent_version: '9.9.9',
    database_capabilities: [
      'database.runtime.v1',
      'database.runtime.v1',
      'database.future.v2',
    ],
  })
  let [node] = await ctx.db
    .select()
    .from(nodes)
    .where(eq(nodes.id, agent.node_id))
  assert.deepEqual(node!.databaseCapabilities, [
    'database.runtime.v1',
    'database.future.v2',
  ])
  const beat = async (fields: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${agent.agent_token}` },
      payload: { cpu_pct: 2, ram_used_mb: 256, disk_used_mb: 100, ...fields },
    })
    assert.equal(res.statusCode, 200, res.body)
    const [row] = await ctx.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, agent.node_id))
    return row!
  }
  node = await beat({
    agent_version: '9.9.9',
    capabilities: {
      ...capability,
      database_capabilities: ['database.exec.v1'],
    },
  })
  assert.deepEqual(node.databaseCapabilities, ['database.exec.v1'])
  node = await beat({ agent_version: '9.9.9' })
  assert.deepEqual(node.databaseCapabilities, [])
  await beat({
    capabilities: {
      ...capability,
      database_capabilities: ['database.runtime.v1'],
    },
  })
  node = await beat({ agent_version: '0.2.4' })
  assert.deepEqual(node.databaseCapabilities, [])
})
