/**
 * Health-gated rollouts.
 *
 * The behaviour under test is the sequencing: the release that works keeps
 * serving until its replacement has proved it can serve too. Every assertion
 * here would have passed trivially before, because the old release was
 * superseded the instant a deploy was scheduled — which is precisely what made
 * every deploy an outage and a broken image a lasting one.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, desc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, settleDeploys, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { orgs, users, services, deployments, nodes } from '../src/db/schema.js'
import { resolveRoute } from '../src/ingress/routes.js'
import { failStalledRollouts, ROLLOUT_TIMEOUT_MS } from '../src/heartbeat/sweeper.js'

describe('a rollout keeps the working release serving', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let token: string
  let agentToken: string
  let nodeId: string
  let fleetId: string
  let orgId: string
  let userId: string
  let serviceId: string
  let hostname: string

  before(async () => {
    ctx = createContext(loadConfig())
    app = await buildServer(ctx)

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `rollout-${Date.now()}@example.test`, password: 'a-long-enough-password' },
    })
    const body = signup.json()
    token = body.accessToken
    fleetId = body.fleet.id
    orgId = body.org.id
    userId = body.user.id

    const pair = await app.inject({
      method: 'POST',
      url: `/fleets/${fleetId}/nodes/pair-token`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    const register = await app.inject({
      method: 'POST',
      url: '/agent/register',
      headers: { authorization: `Bearer ${pair.json().token}` },
      payload: {
        arch: 'amd64',
        cpu_cores: 8,
        ram_mb: 16384,
        disk_mb: 200_000,
        hostname: 'rollout-node',
        advertise_addr: '10.0.0.20',
      },
    })
    agentToken = register.json().agent_token
    nodeId = register.json().node_id ?? register.json().nodeId

    await app.inject({
      method: 'POST',
      url: `/fleets/${fleetId}/services`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        manifest: `
fleet: homelab
services:
  web:
    image: nginx:1.27-alpine
    health: { path: /healthz }
`,
      },
    })

    const [svc] = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
    serviceId = svc!.id
    hostname = svc!.hostname!
  })

  after(async () => {
    await app.close()
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await ctx.db.delete(users).where(eq(users.id, userId))
    await closeContext(ctx)
  })

  // A deploy answers as soon as a node is chosen and keeps building after,
  // so every one of these tests would otherwise race the work it started —
  // editing a row while the deploy is still writing to it. Waiting here means
  // no caller has to remember.
  const deploy = async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/services/${serviceId}/deploy`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    await settleDeploys(ctx)
    return res
  }

  /** Report a container to the control plane the way the agent does. */
  const beat = (containers: Array<{ deployment_id: string; state: string; health?: string }>) =>
    app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        cpu_pct: 5,
        ram_used_mb: 1024,
        disk_used_mb: 20_000,
        runtime: { docker_available: true },
        containers: containers.map((c) => ({ name: 'web', ...c })),
      },
    })

  const live = () =>
    ctx.db
      .select({ id: deployments.id, status: deployments.status, hostPort: deployments.hostPort })
      .from(deployments)
      .where(eq(deployments.serviceId, serviceId))
      .orderBy(desc(deployments.startedAt))

  let first: string
  let second: string
  /** The rollout that timed out unhealthy — the one the failure message is about. */
  let timedOut: string

  test('the first deploy goes live once the container reports healthy', async () => {
    const res = await deploy()
    assert.equal(res.statusCode, 202, res.body)
    await settleDeploys(ctx)
    first = res.json().deployment.id

    await beat([{ deployment_id: first, state: 'running', health: 'healthy' }])

    const rows = await live()
    assert.equal(rows.find((r) => r.id === first)?.status, 'running')
  })

  test('a container that started but is not healthy is not promoted', async () => {
    // The failure this exists to catch: a process that is up and failing every
    // request used to count as a successful deploy.
    const res = await deploy()
    second = res.json().deployment.id

    await beat([
      { deployment_id: first, state: 'running', health: 'healthy' },
      { deployment_id: second, state: 'running', health: 'starting' },
    ])

    const rows = await live()
    assert.equal(rows.find((r) => r.id === second)?.status, 'deploying')
    assert.equal(rows.find((r) => r.id === first)?.status, 'running')
  })

  test('while it is being checked, traffic still reaches the old release', async () => {
    const route = await resolveRoute(ctx, hostname)
    const rows = await live()
    const running = rows.find((r) => r.id === first)!
    assert.ok(route, 'the hostname stopped resolving during a rollout')
    // Serving the half-started replacement here is the outage.
    assert.equal(route!.upstream.split(':')[1], String(running.hostPort))
  })

  test('an unhealthy replacement is still not promoted', async () => {
    await beat([
      { deployment_id: first, state: 'running', health: 'healthy' },
      { deployment_id: second, state: 'running', health: 'unhealthy' },
    ])
    const rows = await live()
    assert.equal(rows.find((r) => r.id === second)?.status, 'deploying')
    assert.equal(rows.find((r) => r.id === first)?.status, 'running')
  })

  test('once healthy it is promoted and the old release is superseded', async () => {
    await beat([
      { deployment_id: first, state: 'running', health: 'healthy' },
      { deployment_id: second, state: 'running', health: 'healthy' },
    ])

    const rows = await live()
    assert.equal(rows.find((r) => r.id === second)?.status, 'running')
    assert.equal(rows.find((r) => r.id === first)?.status, 'superseded')
    // Exactly one live row, or ingress has a coin flip to make.
    assert.equal(rows.filter((r) => r.status === 'running' || r.status === 'deploying').length, 1)
  })

  test('the route follows the promotion to the new port', async () => {
    const rows = await live()
    const now = rows.find((r) => r.id === second)!
    const route = await resolveRoute(ctx, hostname)
    assert.equal(route!.upstream.split(':')[1], String(now.hostPort))
  })

  test('a rollout that never becomes healthy fails without taking the site down', async () => {
    const res = await deploy()
    const third = res.json().deployment.id
    timedOut = third

    // Age it past the window rather than waiting ten minutes for it.
    await ctx.db
      .update(deployments)
      .set({ startedAt: new Date(Date.now() - ROLLOUT_TIMEOUT_MS - 60_000) })
      .where(eq(deployments.id, third))

    const failed = await failStalledRollouts(ctx)
    assert.ok(failed.includes(third))

    const rows = await live()
    assert.equal(rows.find((r) => r.id === third)?.status, 'failed')
    // The release that works is untouched, and still serving.
    assert.equal(rows.find((r) => r.id === second)?.status, 'running')
    const route = await resolveRoute(ctx, hostname)
    assert.ok(route, 'the site went down because a replacement failed')
  })

  test('a container the node reports running is promoted, never failed', async () => {
    // The outage this prevents: promotion only happens on a heartbeat carrying
    // the container, so anything that stops one arriving — a failed `docker ps`
    // on the node, a control plane that was down while the window elapsed —
    // leaves a container that is serving traffic sitting in `deploying`. The
    // sweeper then timed it out and tore it down. Four healthy services went
    // off the internet that way.
    const res = await app.inject({
      method: 'POST',
      url: `/services/${serviceId}/deploy`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    // The deploy answers before it finishes; this test then edits the row
    // it created, so it has to wait for the work to stop touching it.
    await settleDeploys(ctx)
    const fresh = res.json().deployment?.id ?? res.json().deploymentId
    assert.ok(fresh, `expected a deployment id, got ${res.body}`)

    // The node says it is up. The control plane has simply not acted on it.
    await beat([{ deployment_id: fresh, state: 'running' }])
    await ctx.db
      .update(deployments)
      .set({ status: 'deploying', startedAt: new Date(Date.now() - ROLLOUT_TIMEOUT_MS - 60_000) })
      .where(eq(deployments.id, fresh))
    // Re-report after the backdating, so the heartbeat the sweeper reads is
    // the current one rather than whatever the deploy left behind.
    await beat([{ deployment_id: fresh, state: 'running' }])

    const failed = await failStalledRollouts(ctx)
    assert.ok(!failed.includes(fresh), 'a running container must never be failed for timing out')

    const [row] = await ctx.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, fresh))
      .limit(1)
    assert.equal(row!.status, 'running', 'it was up; the timeout should promote it, not kill it')
  })

  test('a container the node reports as not running is still failed', async () => {
    // The rescue must not become a blanket amnesty: a container that is
    // genuinely dead has to fail, or a broken release sits in `deploying`
    // forever and nothing ever says why.
    const res = await app.inject({
      method: 'POST',
      url: `/services/${serviceId}/deploy`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    // The deploy answers before it finishes; this test then edits the row
    // it created, so it has to wait for the work to stop touching it.
    await settleDeploys(ctx)
    const dead = res.json().deployment?.id ?? res.json().deploymentId
    assert.ok(dead)

    await ctx.db
      .update(deployments)
      .set({ status: 'deploying', startedAt: new Date(Date.now() - ROLLOUT_TIMEOUT_MS - 60_000) })
      .where(eq(deployments.id, dead))
    await beat([{ deployment_id: dead, state: 'exited' }])

    const failed = await failStalledRollouts(ctx)
    assert.ok(failed.includes(dead))

    const [row] = await ctx.db
      .select({ status: deployments.status, reason: deployments.failureReason })
      .from(deployments)
      .where(eq(deployments.id, dead))
      .limit(1)
    assert.equal(row!.status, 'failed')
    // And it names the state, rather than claiming a health check timed out.
    assert.match(row!.reason!, /exited/)
  })

  test('a silent node leaves the rollout alone instead of failing it', async () => {
    // The outage this prevents, in full. Restarting the agent took a node off
    // the air for about a minute. The rollout window elapsed while it was
    // quiet, and this function failed both of its deployments. `failed` is in
    // none of the sets the recovery paths read -- rescheduleFromNode looks at
    // ['deploying', 'running'], reclaimForNode at 'pinned_unavailable' -- so
    // the rows became invisible to both, permanently. The agent came back,
    // found them absent from its desired state, and reaped the containers.
    // One of them was a database.
    //
    // A silent node is not evidence about a container. It is the absence of
    // evidence, and this function must not write a verdict on it.
    const res = await app.inject({
      method: 'POST',
      url: `/services/${serviceId}/deploy`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    await settleDeploys(ctx)
    const fresh = res.json().deployment?.id ?? res.json().deploymentId
    assert.ok(fresh, `expected a deployment id, got ${res.body}`)

    await ctx.db
      .update(deployments)
      .set({ status: 'deploying', startedAt: new Date(Date.now() - ROLLOUT_TIMEOUT_MS - 60_000) })
      .where(eq(deployments.id, fresh))

    // The node goes quiet: its heartbeat key expires exactly like this.
    await ctx.redis.del(`node:${nodeId}:hb`)

    const failed = await failStalledRollouts(ctx)
    assert.ok(!failed.includes(fresh), 'a silent node is not grounds for failing a deployment')

    const [row] = await ctx.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, fresh))
      .limit(1)
    assert.equal(
      row!.status,
      'deploying',
      'it must stay visible to the node-down path, which is what actually owns this case'
    )
  })

    test('is written to the node, not only into Redis', async () => {
      // An agent that upgrades itself keeps its identity and never registers
      // again. Registration was the only thing that wrote this column, so a node
      // went on reporting the version it first paired with indefinitely -- and
      // the dashboard, the CLI and `fleet status` all read it, so every one of
      // them named the wrong build with total confidence. That is worse than
      // saying nothing, because knowing what is actually deployed is the entire
      // point of an agent that can upgrade itself.
      await app.inject({
        method: 'POST',
        url: '/agent/heartbeat',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: {
          cpu_pct: 5,
          ram_used_mb: 1024,
          disk_used_mb: 20_000,
          agent_version: '9.9.9',
          runtime: { docker_available: true },
          containers: [],
        },
      })

      const [row] = await ctx.db
        .select({ agentVersion: nodes.agentVersion })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1)
      assert.equal(row?.agentVersion, '9.9.9', 'the node should report what it is actually running')
    })

    test('a heartbeat without one leaves the last known version alone', async () => {
      // Older agents omit it. Blanking the column on their behalf would replace
      // a true answer with no answer.
      await app.inject({
        method: 'POST',
        url: '/agent/heartbeat',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: {
          cpu_pct: 5,
          ram_used_mb: 1024,
          disk_used_mb: 20_000,
          runtime: { docker_available: true },
          containers: [],
        },
      })

      const [row] = await ctx.db
        .select({ agentVersion: nodes.agentVersion })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1)
      assert.equal(row?.agentVersion, '9.9.9')
    })

  test('reconcile errors surface without containers, clear on recovery, and fail only the exact deployment', async () => {
    const servingBefore = (await live()).filter(row => row.status === 'running')
    assert.ok(servingBefore.length)
    const [dep] = await ctx.db.insert(deployments).values({ serviceId, nodeId, status: 'deploying', imageTags: ['nginx:1.27-alpine'], startedAt: new Date(Date.now() + 1000) }).returning()
    const report = (error?: string, id = dep!.id) => app.inject({
      method: 'POST', url: '/agent/heartbeat', headers: { authorization: 'Bearer ' + agentToken },
      payload: { cpu_pct: 1, ram_used_mb: 100, disk_used_mb: 1000,
        runtime: { docker_available: true }, containers: [],
        deploys: [{ deployment_id: id, service: 'web', stage: 'pulling', ...(error ? { error } : {}) }] },
    })
    assert.equal((await report('pull: temporary registry failure')).statusCode, 200)
    const progress = await app.inject({ method: 'GET', url: '/services/' + serviceId + '/progress', headers: { authorization: 'Bearer ' + token } })
    assert.equal(progress.json().progress.deploymentId, dep!.id)
    assert.equal(progress.json().progress.status, 'deploying')
    assert.match(progress.json().progress.detail, /temporary registry failure/)
    const explained = await app.inject({ method: 'POST', url: '/fleets/' + fleetId + '/deployments/' + dep!.id + '/explain', headers: { authorization: 'Bearer ' + token } })
    assert.equal(explained.statusCode, 200)
    assert.match(explained.json().reason, /temporary registry failure/)
    await report()
    const [recovered] = await ctx.db.select().from(deployments).where(eq(deployments.id, dep!.id))
    assert.equal(recovered!.failureReason, null)
    await report('pull: invalid reference format')
    const [failed] = await ctx.db.select().from(deployments).where(eq(deployments.id, dep!.id))
    assert.equal(failed!.status, 'failed')
    assert.match(failed!.failureReason!, /invalid reference format/)
    const rows = await live()
    for (const serving of servingBefore) assert.equal(rows.find(row => row.id === serving.id)?.status, 'running')
    // Late progress cannot overwrite the durable terminal verdict.
    await report()
    const [stillFailed] = await ctx.db.select().from(deployments).where(eq(deployments.id, dep!.id))
    assert.equal(stillFailed!.status, 'failed')
  })

  test('failed deployment logs work without an assigned node and reject another attempt output', async () => {
    const [dep] = await ctx.db.insert(deployments).values({ serviceId, status: 'failed', failureReason: 'cannot monitor build disk usage: exit status 1', startedAt: new Date(Date.now() + 2000) }).returning()
    const key = 'build:logs:' + serviceId
    await ctx.redis.del(key)
    await ctx.redis.lpush(key, JSON.stringify({ serviceId, service: 'web', deploymentId: dep!.id, text: 'current build output', nodeId: 'builder', at: Date.now() }))
    await ctx.redis.lpush(key, JSON.stringify({ serviceId, service: 'web', deploymentId: second, text: 'unrelated attempt output', nodeId: 'builder', at: Date.now() }))
    try {
      const res = await app.inject({ method: 'GET', url: '/services/' + serviceId + '/logs', headers: { authorization: 'Bearer ' + token } })
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().node, null)
      assert.equal(res.json().source, 'build')
      assert.match(res.json().lines.join('\n'), /current build output/)
      assert.match(res.json().lines.join('\n'), /exit status 1/)
      assert.doesNotMatch(res.json().lines.join('\n'), /unrelated attempt/)
      const unauthenticated = await app.inject({ method: 'GET', url: '/services/' + serviceId + '/logs' })
      assert.equal(unauthenticated.statusCode, 401)
    } finally { await ctx.redis.del(key) }
  })

  test('a node cannot report another node deployment failure', async () => {
    const [dep] = await ctx.db.insert(deployments).values({ serviceId, nodeId: null, status: 'deploying' }).returning()
    await app.inject({ method: 'POST', url: '/agent/heartbeat', headers: { authorization: 'Bearer ' + agentToken },
      payload: { cpu_pct: 1, ram_used_mb: 100, disk_used_mb: 1000, runtime: { docker_available: true }, containers: [],
        deploys: [{ deployment_id: dep!.id, service: 'web', stage: 'pulling', error: 'pull: invalid reference format' }] } })
    const [unchanged] = await ctx.db.select().from(deployments).where(eq(deployments.id, dep!.id))
    assert.equal(unchanged!.status, 'deploying')
    assert.equal(unchanged!.failureReason, null)
    await ctx.db.delete(deployments).where(eq(deployments.id, dep!.id))
  })

  test('retry grace starts at the error rather than at build start', async () => {
    const [dep] = await ctx.db.insert(deployments).values({ serviceId, nodeId, status: 'deploying', startedAt: new Date(Date.now() - 20 * 60_000) }).returning()
    const errorKey = 'deploy:reconcile-error:' + dep!.id
    const report = () => app.inject({ method: 'POST', url: '/agent/heartbeat', headers: { authorization: 'Bearer ' + agentToken },
      payload: { cpu_pct: 1, ram_used_mb: 100, disk_used_mb: 1000, runtime: { docker_available: true }, containers: [],
        deploys: [{ deployment_id: dep!.id, service: 'web', stage: 'pulling', error: 'temporary registry failure' }] } })
    try {
      await report()
      const [retrying] = await ctx.db.select().from(deployments).where(eq(deployments.id, dep!.id))
      assert.equal(retrying!.status, 'deploying')
      await ctx.redis.set(errorKey, String(Date.now() - 91_000), 'EX', 600)
      await report()
      const [failed] = await ctx.db.select().from(deployments).where(eq(deployments.id, dep!.id))
      assert.equal(failed!.status, 'failed')
      assert.equal(failed!.failureReason, 'temporary registry failure')
    } finally { await ctx.redis.del(errorKey) }
  })

  test('ambiguous legacy service names cannot attach errors to another project', async () => {
    const [duplicate] = await ctx.db.insert(services).values({ fleetId, name: 'web', project: 'another-project', requestRamMb: 128 }).returning()
    const [dep] = await ctx.db.insert(deployments).values({ serviceId, nodeId, status: 'deploying' }).returning()
    try {
      await app.inject({ method: 'POST', url: '/agent/heartbeat', headers: { authorization: 'Bearer ' + agentToken },
        payload: { cpu_pct: 1, ram_used_mb: 100, disk_used_mb: 1000,
          runtime: { docker_available: true, last_reconcile_error: 'web: pull: invalid reference format' }, containers: [],
          deploys: [{ deployment_id: dep!.id, service: 'web', stage: 'pulling' }] } })
      const [unchanged] = await ctx.db.select().from(deployments).where(eq(deployments.id, dep!.id))
      assert.equal(unchanged!.status, 'deploying')
      assert.equal(unchanged!.failureReason, null)
    } finally {
      await ctx.db.delete(deployments).where(eq(deployments.id, dep!.id))
      await ctx.db.delete(services).where(eq(services.id, duplicate!.id))
    }
  })

  test('the failure says what happened', async () => {
    const [row] = await ctx.db
      .select({ reason: deployments.failureReason })
      .from(deployments)
      // By id, not "the newest failed row for this service". By now the service
      // has several failures with different causes, and both "limit 1" and
      // "order by startedAt" pick an arbitrary one of them - one of these
      // tests deliberately backdates its row, so recency is not even a
      // tiebreak. This assertion is about one specific rollout.
      .where(eq(deployments.id, timedOut))
      .limit(1)
    // The reason distinguishes "the node never told us about this container"
    // from "the node told us, and it was not healthy". They call for different
    // things — one is a broken release, the other is a node that has stopped
    // reporting — and one sentence for both sent people to debug the wrong one.
    assert.match(row!.reason!, /never reported (this container|healthy)/)
    assert.match(row!.reason!, /previous release was left running/)
  })
})

describe('a service with no health check', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let orgId: string
  let userId: string

  before(async () => {
    ctx = createContext(loadConfig())
    app = await buildServer(ctx)
  })

  after(async () => {
    await app.close()
    if (orgId) await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    if (userId) await ctx.db.delete(users).where(eq(users.id, userId))
    await closeContext(ctx)
  })

  test('is promoted on the running state, since that is the only evidence there is', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `nohealth-${Date.now()}@example.test`, password: 'a-long-enough-password' },
    })
    const body = signup.json()
    orgId = body.org.id
    userId = body.user.id
    const token = body.accessToken
    const fleetId = body.fleet.id

    const pair = await app.inject({
      method: 'POST',
      url: `/fleets/${fleetId}/nodes/pair-token`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    const register = await app.inject({
      method: 'POST',
      url: '/agent/register',
      headers: { authorization: `Bearer ${pair.json().token}` },
      payload: { arch: 'amd64', cpu_cores: 4, ram_mb: 8192, disk_mb: 50_000, hostname: 'plain' },
    })

    await app.inject({
      method: 'POST',
      url: `/fleets/${fleetId}/services`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        manifest: `
fleet: homelab
services:
  worker:
    image: alpine:3.20
    health: { disabled: true }
`,
      },
    })

    const [svc] = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
    const res = await app.inject({
      method: 'POST',
      url: `/services/${svc!.id}/deploy`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    // The deploy answers before it finishes; this test then edits the row
    // it created, so it has to wait for the work to stop touching it.
    await settleDeploys(ctx)
    const id = res.json().deployment.id

    // No health field at all, which is what Docker reports for an image with
    // no check. Refusing to promote would strand every such service forever.
    await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${register.json().agent_token}` },
      payload: {
        cpu_pct: 1,
        ram_used_mb: 100,
        disk_used_mb: 1000,
        runtime: { docker_available: true },
        containers: [{ name: 'worker', state: 'running', deployment_id: id }],
      },
    })

    const [row] = await ctx.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, id))
    assert.equal(row!.status, 'running')
  })
})
