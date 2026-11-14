import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createContext, closeContext } from '../src/api/context.js'
import { loadConfig } from '../src/config.js'
import { buildServer } from '../src/server.js'
import { nodes, services, deployments } from '../src/db/schema.js'
test('private fleet health scopes every list and detail to memberships; public routes reveal no fixtures', async () => {
  const ctx = createContext({ ...loadConfig(), NODE_ENV: 'test' }); const app = await buildServer(ctx)
  const secrets: string[] = []; const users: string[] = []
  try {
    const accounts = []
    for (let i = 0; i < 2; i++) {
      const secret = `private-status-${randomUUID()}`; secrets.push(secret)
      const response = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: `${secret}@example.test`, password: 'long-enough-test-password' } }); assert.equal(response.statusCode, 201, response.body)
      const account = response.json(); users.push(account.user.id)
      const [node] = await ctx.db.insert(nodes).values({ fleetId: account.fleet.id, name: secret, arch: 'amd64', cpuCores: 2, ramMb: 1024, diskMb: 1000, agentTokenHash: secret }).returning()
      const [service] = await ctx.db.insert(services).values({ fleetId: account.fleet.id, name: secret, project: secret, placementPolicy: 'pinned', requestRamMb: 64, requestCpu: '.1' }).returning()
      const [deploy] = await ctx.db.insert(deployments).values({ serviceId: service!.id, nodeId: node!.id, status: 'running' }).returning()
      accounts.push({ account, node: node!, service: service!, deploy: deploy! })
    }
    const [a,b] = accounts; const headers = { authorization: `Bearer ${a!.account.accessToken}` }
    for (const path of ['/nodes','/services','/failovers']) {
      assert.equal((await app.inject({ url: '/v1/fleet'+path })).statusCode, 401)
      const result = await app.inject({ url: '/v1/fleet'+path, headers }); assert.equal(result.statusCode, 200, result.body); assert.equal(result.body.includes(secrets[1]!), false)
    }
    for (const path of [`/nodes/${b!.node.id}/history`,`/deploys/${b!.deploy.id}/timing`]) assert.equal((await app.inject({ url: '/v1/fleet'+path, headers })).statusCode, 404)
    for (const path of [`/nodes/${a!.node.id}/history`,`/deploys/${a!.deploy.id}/timing`]) { const result = await app.inject({ url: '/v1/fleet'+path, headers }); assert.equal(result.statusCode, 200, result.body) }
    for (const path of ['','/metrics','/incidents','/summary.json','/feed.rss']) { const response = await app.inject({ url: '/v1/status'+path }); assert.equal(response.statusCode, 200); for (const secret of secrets) assert.equal(response.body.includes(secret), false) }
  } finally {
    for (const id of users) { const fleets = await ctx.sql`select f.id from fleets f join org_members m on m.org_id=f.org_id where m.user_id=${id}`; for (const fleet of fleets) await ctx.sql`delete from services where fleet_id=${fleet.id}`; await ctx.sql`delete from users where id=${id}` }
    await app.close(); await closeContext(ctx)
  }
})
