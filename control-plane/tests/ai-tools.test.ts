/**
 * The read-only view a diagnosis is built on.
 *
 * Each of these is a query somebody ran by hand while working out why a
 * service was down. They are tested against a real database rather than a
 * mock, because what makes them useful is exactly what a mock would invent:
 * that a deployment's failure reason is where the cause usually is, that a
 * node's own heartbeat disagrees with the control plane when something has
 * gone wrong, that a service with no live deployment has no log to read.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { auditLog, deployments, fleets, nodes, orgs, services } from '../src/db/schema.js'
import { hashToken, newAgentToken } from '../src/lib/tokens.js'
import { callTool } from '../src/ai/tools.js'

let ctx: AppContext
let fleetId: string
let otherFleetId: string
let orgId: string
let apiId: string
let nodeId: string
/** Hostnames are unique across the whole table, and this database is not reset
    between runs — a fixed one works exactly once and then fails for ever. */
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

before(async () => {
  ctx = createContext(loadConfig())

  const [org] = await ctx.db.insert(orgs).values({ name: `tools-org-${Date.now()}` }).returning()
  orgId = org!.id
  const [fleet] = await ctx.db.insert(fleets).values({ orgId: org!.id, name: 'tools' }).returning()
  const [other] = await ctx.db.insert(fleets).values({ orgId: org!.id, name: 'other' }).returning()
  fleetId = fleet!.id
  otherFleetId = other!.id

  const [node] = await ctx.db
    .insert(nodes)
    .values({
      fleetId, name: 'box-1', arch: 'amd64', cpuCores: 4, ramMb: 8192, diskMb: 100_000,
      agentTokenHash: hashToken(newAgentToken()), status: 'online', agentVersion: '0.2.2',
    })
    .returning()
  nodeId = node!.id

  const [svc] = await ctx.db
    .insert(services)
    .values({
      fleetId, name: 'api', project: 'demo', placementPolicy: 'flexible',
      requestRamMb: 512, compatibleArches: ['amd64'], hostname: `api-${runId}.example.invalid`,
    })
    .returning()
  apiId = svc!.id

  // One failure and one success, so "how did it end" has something to say.
  await ctx.db.insert(deployments).values([
    {
      serviceId: svc!.id, nodeId: node!.id, status: 'failed',
      failureReason: 'the container is restarting and never reported healthy within the rollout window',
      startedAt: new Date(Date.now() - 600_000), finishedAt: new Date(Date.now() - 590_000),
    },
    { serviceId: svc!.id, nodeId: node!.id, status: 'running', startedAt: new Date(Date.now() - 60_000) },
  ])

  // The shape that made the first real diagnosis wrong: a system action from
  // the middle of an outage, and a person stopping the service afterwards.
  await ctx.db.insert(auditLog).values([
    {
      orgId, actorKind: 'system', action: 'service.rescheduled',
      targetType: 'service', targetId: svc!.id,
      createdAt: new Date(Date.now() - 3_600_000),
    },
    {
      orgId, actorKind: 'user', action: 'service.stopped',
      targetType: 'service', targetId: svc!.id,
      createdAt: new Date(Date.now() - 120_000),
    },
  ])

  // A service in another fleet, to prove scoping.
  await ctx.db.insert(services).values({
    fleetId: otherFleetId, name: 'secret-api', project: 'other', placementPolicy: 'flexible',
    requestRamMb: 512, compatibleArches: ['amd64'],
  })
})

after(async () => {
  await closeContext(ctx)
})

describe('the tools a diagnosis can call', () => {
  test('services lists what is in the fleet, with how each stands', async () => {
    const out = await callTool(ctx, fleetId, 'services', {})
    assert.ok(out.ok)
    const rows = out.data as Array<{ service: string; status: string }>
    assert.deepEqual(rows.map((r) => r.service), ['api'])
    assert.equal(rows[0]!.status, 'running')
  })

  test('deployments carry the failure reason, which is usually the answer', async () => {
    const out = await callTool(ctx, fleetId, 'deployments', { service: 'api' })
    assert.ok(out.ok)
    const rows = out.data as Array<{ status: string; failureReason: string | null }>
    assert.equal(rows[0]!.status, 'running', 'newest first')
    assert.match(rows[1]!.failureReason!, /never reported healthy/)
  })

  test('nodes report how long they have been quiet', async () => {
    // "Marked online but silent for nine minutes" was a real finding, and it
    // is invisible without the elapsed time beside the status.
    const out = await callTool(ctx, fleetId, 'nodes', {})
    assert.ok(out.ok)
    const rows = out.data as Array<{ node: string; status: string; agentVersion: string }>
    assert.equal(rows[0]!.node, 'box-1')
    assert.equal(rows[0]!.agentVersion, '0.2.2')
  })

  test('history shows that a person stopped it, which nothing else records', async () => {
    // The first real diagnosis read a run of no_eligible_node failures from an
    // outage an hour earlier and concluded, in the present tense and with
    // citations, that the scheduler had nowhere to put the service. Somebody
    // had stopped it from the dashboard thirty minutes before. That leaves no
    // failure, no placement event and no container -- only this.
    const out = await callTool(ctx, fleetId, 'history', { service: 'api' })
    assert.ok(out.ok)
    const rows = out.data as Array<{ action: string; by: string; secondsAgo: number }>
    assert.equal(rows[0]!.action, 'service.stopped', 'newest first, or the answer is buried')
    assert.equal(rows[0]!.by, 'user', 'a person stopping it is an answer; the system moving it is a symptom')
    assert.ok(rows[0]!.secondsAgo < rows[1]!.secondsAgo, 'elapsed time is what separates now from then')
  })

  test('history is scoped to the fleet like every other tool', async () => {
    const out = await callTool(ctx, fleetId, 'history', { service: 'secret-api' })
    assert.equal(out.ok, false)
    if (!out.ok) assert.match(out.error, /no service named/)
  })

  test('context shows the file that explains a build failure', async () => {
    // The blind spot. A .NET service failed `dotnet restore` with "more than
    // one project or solution file" against a directory holding exactly one.
    // The second existed only inside the uploaded archive, which lives on
    // neither the database nor a node, and is deleted when the build ends.
    await ctx.db.insert(deployments).values({
      serviceId: apiId,
      nodeId,
      status: 'failed',
      failureReason: 'buildx failed: MSB1011',
      startedAt: new Date(Date.now() - 30_000),
      buildContext: {
        entries: ['._Worker.csproj', './Dockerfile', './Worker.csproj'],
        total: 3,
        bytes: 4096,
      },
    })

    const out = await callTool(ctx, fleetId, 'context', { service: 'api' })
    assert.ok(out.ok)
    const data = out.data as { unexpected: string[]; files: string[]; fileCount: number }
    assert.deepEqual(
      data.unexpected,
      ['._Worker.csproj'],
      'the file nobody put there is named outright, not left among the others'
    )
    assert.equal(data.fileCount, 3)
  })

  test('context says so plainly when nothing was recorded', async () => {
    // A service deploying a prebuilt image has no context, and that is an
    // answer rather than an error -- a tool that threw here would end an
    // investigation on a service that never builds anything.
    await ctx.db.insert(services).values({
      fleetId, name: `prebuilt-${runId}`, project: 'demo', placementPolicy: 'flexible',
      requestRamMb: 512, compatibleArches: ['amd64'],
    })

    const out = await callTool(ctx, fleetId, 'context', { service: `prebuilt-${runId}` })
    assert.ok(out.ok)
    assert.match((out.data as { note: string }).note, /no build context recorded/)
  })

  test('source is read from what the caller sent, never from disk', async () => {
    // The design constraint that shaped this. The control plane deletes an
    // uploaded build context the moment a build ends — customer source is held
    // only for as long as it takes to build it — so a lookup reading source
    // from the server would have to break that. It comes with the request and
    // lives exactly as long as the investigation.
    const out = await callTool(ctx, fleetId, 'source', { service: 'api' }, {
      source: { api: '--- app.py\nRedis(host="redis", db=0)\n' },
    })
    assert.ok(out.ok)
    assert.match(JSON.stringify(out.data), /Redis\(host=/)
  })

  test('source says plainly when none was sent', async () => {
    // `fleet diagnose` runs from anywhere, so this is the one lookup that is
    // sometimes unavailable. Saying so beats an empty answer that reads like a
    // finding.
    const out = await callTool(ctx, fleetId, 'source', { service: 'api' })
    assert.ok(out.ok)
    assert.match((out.data as { note: string }).note, /no source was sent/)
  })

  test('source cannot reach a service in another fleet', async () => {
    const out = await callTool(ctx, fleetId, 'source', { service: 'secret-api' }, {
      source: { 'secret-api': 'private' },
    })
    assert.equal(out.ok, false)
    if (!out.ok) assert.match(out.error, /no service named/)
  })

  test('a tool cannot read another fleet', async () => {
    // Scoped at the boundary rather than by asking callers to filter, so no
    // amount of argument-shaping reaches somebody else's fleet.
    const out = await callTool(ctx, fleetId, 'deployments', { service: 'secret-api' })
    assert.equal(out.ok, false)
    if (!out.ok) assert.match(out.error, /no service named/)
  })

  test('a lookup called without its argument says which one', async () => {
    // A model asked `source` seven times in one investigation with no arguments
    // at all. What came back was 'no service named "undefined"' — the symptom,
    // not the mistake — so it asked again, and again: seven of eight steps
    // spent learning nothing. Naming the argument is the difference between a
    // correction and a loop.
    const out = await callTool(ctx, fleetId, 'source', {})
    assert.equal(out.ok, false)
    if (!out.ok) {
      assert.match(out.error, /needs a "service" argument/)
      assert.match(out.error, /"args": \{"service"/, 'and shows the shape to send')
    }
  })

  test('every lookup that needs a name refuses without one', async () => {
    // One at a time is how they were written and how they will be changed. A
    // lookup added later that quietly accepts undefined reintroduces exactly
    // the loop above.
    for (const [tool, arg] of [
      ['deployments', 'service'],
      ['logs', 'service'],
      ['history', 'service'],
      ['context', 'service'],
      ['probe', 'service'],
      ['placements', 'service'],
      ['containers', 'node'],
    ] as const) {
      const out = await callTool(ctx, fleetId, tool, {})
      assert.equal(out.ok, false, `${tool} accepted a missing ${arg}`)
      if (!out.ok) assert.match(out.error, new RegExp(`needs a "${arg}" argument`))
    }
  })

  test('an unknown tool says what there is instead of failing silently', async () => {
    const out = await callTool(ctx, fleetId, 'rm_rf', {})
    assert.equal(out.ok, false)
    if (!out.ok) {
      assert.match(out.error, /no tool named/)
      assert.match(out.error, /deployments/, 'and lists the real ones')
    }
  })

  test('a service with no live deployment says so rather than erroring', async () => {
    // "Nothing is running" is a finding, not a failure, and a tool that threw
    // here would end the diagnosis at its most interesting moment.
    const [idle] = await ctx.db
      .insert(services)
      .values({
        fleetId, name: 'idle', project: 'demo', placementPolicy: 'flexible',
        requestRamMb: 512, compatibleArches: ['amd64'],
      })
      .returning()
    assert.ok(idle)

    const out = await callTool(ctx, fleetId, 'logs', { service: 'idle' })
    assert.ok(out.ok)
    assert.match(JSON.stringify(out.data), /no live deployment/)
  })
})
