import 'dotenv/config'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { loadConfig } from '../src/config.js'
import { createContext, closeContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { orgs, users, pairingTokens, orgMembers, services, deployments } from '../src/db/schema.js'

const ctx = createContext(loadConfig())
const app = await buildServer(ctx)
let owner: { accessToken: string; fleet: { id: string }; org: { id: string }; user: { id: string } }
before(async () => {
  owner = (await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: `pairing-${Date.now()}@example.test`, password: 'long-enough-test-password' } })).json()
})
after(async () => {
  await app.close()
  await ctx.db.delete(orgs).where(eq(orgs.id, owner.org.id))
  await ctx.db.delete(users).where(eq(users.id, owner.user.id))
  await closeContext(ctx)
})
const headers = () => ({ authorization: `Bearer ${owner.accessToken}` })

test('PowerShell installer is available separately without credentials embedded', async () => {
  const result = await app.inject({ url: '/install/windows.ps1' })
  assert.equal(result.statusCode, 200, result.body)
  assert.match(result.body, /Get-FileHash/)
  assert.match(result.body, /Switch Docker Desktop to Linux containers/)
  assert.match(result.body, /FLEET_PAIRING_TOKEN/)
  assert.equal(result.headers['cache-control'], 'no-store')
})

test('receipt is scoped, distinguishes registration from heartbeat, and contains no token hashes', async () => {
  const receipt = (await app.inject({ method: 'POST', url: `/fleets/${owner.fleet.id}/nodes/pair-token`, headers: headers(), payload: {} })).json()
  assert.ok(receipt.pairing_id)
  const path = `/fleets/${owner.fleet.id}/nodes/pairings/${receipt.pairing_id}`
  assert.equal((await app.inject({ url: path })).statusCode, 401)
  assert.equal((await app.inject({ url: path, headers: headers() })).json().status, 'pending')
  const registration = await app.inject({ method: 'POST', url: '/agent/register', headers: { authorization: `Bearer ${receipt.token}` }, payload: {
    arch: 'amd64', cpu_cores: 4, ram_mb: 8192, disk_mb: 200000, hostname: 'receipt-node', platform: 'linux/amd64', engine_kind: 'docker-desktop', effective_cpu: 4, effective_mem_bytes: 8589934592,
  } })
  assert.equal(registration.statusCode, 201, registration.body)
  const nodeId = registration.json().node_id
  assert.equal((await app.inject({ url: path, headers: headers() })).json().status, 'registered')
  await ctx.heartbeats.record({ nodeId: 'another-node', fleetId: owner.fleet.id, cpuPct: 0, ramUsedMb: 0, diskUsedMb: 0, containers: [], meshConnected: false })
  assert.equal((await app.inject({ url: path, headers: headers() })).json().status, 'registered')
  await ctx.heartbeats.record({ nodeId, fleetId: owner.fleet.id, cpuPct: 0, ramUsedMb: 0, diskUsedMb: 0, containers: [], meshConnected: false, runtime: { dockerAvailable: true } })
  const connected = await app.inject({ url: path, headers: headers() })
  assert.equal(connected.json().status, 'connected')
  assert.equal(connected.json().node.platform, 'linux/amd64')
  assert.doesNotMatch(connected.body, /tokenHash|agentToken|token_hash/)
  await ctx.heartbeats.record({ nodeId, fleetId: owner.fleet.id, cpuPct: 0, ramUsedMb: 0, diskUsedMb: 0, containers: [], meshConnected: false }, Date.now() - 60000)
  assert.equal((await app.inject({ url: path, headers: headers() })).json().status, 'registered')
})

test('expired receipt and viewer/foreign-fleet access are explicit', async () => {
  const receipt = (await app.inject({ method: 'POST', url: `/fleets/${owner.fleet.id}/nodes/pair-token`, headers: headers(), payload: {} })).json()
  const path = `/fleets/${owner.fleet.id}/nodes/pairings/${receipt.pairing_id}`
  await ctx.db.update(pairingTokens).set({ expiresAt: new Date(0) }).where(eq(pairingTokens.id, receipt.pairing_id))
  assert.equal((await app.inject({ url: path, headers: headers() })).json().status, 'expired')
  assert.equal((await app.inject({ url: path.replace(owner.fleet.id, '00000000-0000-4000-8000-000000000000'), headers: headers() })).statusCode, 404)
  await ctx.db.update(orgMembers).set({ role: 'viewer' }).where(eq(orgMembers.userId, owner.user.id))
  try { assert.equal((await app.inject({ url: path, headers: headers() })).statusCode, 403) }
  finally { await ctx.db.update(orgMembers).set({ role: 'owner' }).where(eq(orgMembers.userId, owner.user.id)) }
})

test('deployment lookup uses exact ID even while a previous release is running', async () => {
  const [service] = await ctx.db.insert(services).values({ fleetId: owner.fleet.id, name: 'receipt-app' }).returning()
  await ctx.db.insert(deployments).values({ serviceId: service!.id, status: 'running' })
  const [failed] = await ctx.db.insert(deployments).values({ serviceId: service!.id, status: 'failed', failureReason: 'broken Dockerfile' }).returning()
  const path = `/services/${service!.id}/deployments/${failed!.id}`
  assert.equal((await app.inject({ url: path })).statusCode, 401)
  const result = await app.inject({ url: path, headers: headers() })
  assert.equal(result.statusCode, 200, result.body)
  assert.equal(result.json().deployment.status, 'failed')
  assert.equal(result.json().deployment.id, failed!.id)
})
