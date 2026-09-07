import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { orgs, fleets, nodes, services } from '../src/db/schema.js'
import { hashToken, newAgentToken } from '../src/lib/tokens.js'
import { parseManifest } from '../src/manifest/parse.js'
import { syncManifest } from '../src/manifest/sync.js'
import { ApiError } from '../src/api/errors.js'

describe('applying a manifest to a fleet', () => {
  let ctx: AppContext
  let orgId: string
  let fleetId: string

  before(async () => {
    ctx = createContext(loadConfig())
    const [org] = await ctx.db.insert(orgs).values({ name: 'sync-test' }).returning()
    orgId = org!.id
    const [fleet] = await ctx.db.insert(fleets).values({ orgId, name: `sync-${Date.now()}` }).returning()
    fleetId = fleet!.id

    await ctx.db.insert(nodes).values({
      fleetId,
      name: 'node-03',
      arch: 'amd64',
      cpuCores: 4,
      ramMb: 8192,
      diskMb: 100_000,
      agentTokenHash: hashToken(newAgentToken()),
    })
  })

  after(async () => {
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await closeContext(ctx)
  })

  const apply = (yaml: string) => syncManifest(ctx, fleetId, orgId, parseManifest(yaml))

  test('creates services and resolves a pinned node name to its id', async () => {
    const result = await apply(`
fleet: homelab
services:
  web: { image: nginx, resources: { ram: 512Mi } }
  db:  { image: postgres:16, placement: pinned, node: node-03, volume: pgdata }
`)
    assert.deepEqual(result.created.sort(), ['db', 'web'])

    const rows = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
    const db = rows.find((r) => r.name === 'db')!
    assert.equal(db.placementPolicy, 'pinned')
    assert.ok(db.pinnedNodeId, 'the node name should have been resolved to an id')
    assert.equal(db.persistentVolume, true)
    assert.equal(db.volumeName, 'pgdata')

    const web = rows.find((r) => r.name === 'web')!
    assert.equal(web.requestRamMb, 512)
  })

  test('re-applying updates in place rather than duplicating', async () => {
    const result = await apply(`
fleet: homelab
services:
  web: { image: nginx, resources: { ram: 1Gi } }
  db:  { image: postgres:16, placement: pinned, node: node-03, volume: pgdata }
`)
    assert.deepEqual(result.created, [])
    assert.deepEqual(result.updated.sort(), ['db', 'web'])

    const rows = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
    assert.equal(rows.length, 2, 'no duplicates')
    assert.equal(rows.find((r) => r.name === 'web')!.requestRamMb, 1024)
  })

  test('a service dropped from the manifest is reported, never deleted', async () => {
    // A typo in a service name must not silently destroy a running service
    // and its volume.
    const result = await apply(`
fleet: homelab
services:
  web: { image: nginx }
`)
    assert.deepEqual(result.orphaned, ['db'])
    assert.ok(result.warnings.some((w) => /Nothing was deleted/.test(w)))

    const rows = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
    assert.equal(rows.length, 2, 'the orphan is still there')
  })

  test('naming a node that does not exist fails whole, not half-applied', async () => {
    const before = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))

    await assert.rejects(
      () =>
        apply(`
fleet: homelab
services:
  web:   { image: nginx }
  cache: { image: redis, placement: pinned, node: does-not-exist }
`),
      (err: unknown) => {
        assert.ok(err instanceof ApiError)
        assert.equal(err.code, 'unknown_node')
        return true
      }
    )

    const after = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
    assert.equal(after.length, before.length, 'nothing should have been written')
    assert.ok(!after.some((s) => s.name === 'cache'), 'the valid service must not have been created either')
  })

  // These come last on purpose: they add services to the fleet the earlier
  // tests count rows in, and a shared fixture is only safe to grow at the end.
  test('two projects in one fleet may both have a service called the same thing', async () => {
    // The failure this replaces: applying project B's manifest matched project
    // A's "backend" by name and updated it in place, taking its volume, its
    // deployments and its hostname, and reporting success.
    const yaml = (proj: string) => `
fleet: homelab
project: ${proj}
services:
  backend: { image: nginx, placement: flexible }
`
    await apply(yaml('alpha'))
    await apply(yaml('beta'))

    const rows = await ctx.db
      .select()
      .from(services)
      .where(and(eq(services.fleetId, fleetId), eq(services.name, 'backend')))

    assert.equal(rows.length, 2, 'both projects keep their own service')
    assert.deepEqual(rows.map((r) => r.project).sort(), ['alpha', 'beta'])
    // services_hostname_key is global, and the project is in the name exactly
    // so two same-named services do not collide on it.
    assert.notEqual(rows[0]!.hostname, rows[1]!.hostname)
    // The project sits between the service and the fleet, which is what stops
    // the two colliding. The fleet here is named sync-<timestamp> by the fixture.
    for (const r of rows) assert.match(r.hostname!, /^backend-(alpha|beta)-sync-/)
  })

  test('re-applying a project updates its own service, not the other one', async () => {
    const yaml = (proj: string, port: number) => `
fleet: homelab
project: ${proj}
services:
  api: { image: nginx, placement: flexible, container_port: ${port} }
`
    await apply(yaml('one', 3000))
    await apply(yaml('two', 3000))
    await apply(yaml('one', 4000))

    const rows = await ctx.db
      .select()
      .from(services)
      .where(and(eq(services.fleetId, fleetId), eq(services.name, 'api')))
    assert.equal(rows.length, 2, 'no row was created or destroyed')
    assert.equal(rows.find((r) => r.project === 'one')!.containerPort, 4000)
    assert.equal(rows.find((r) => r.project === 'two')!.containerPort, 3000, 'the other project was left alone')
  })

  test('an existing service keeps the hostname it was deployed with', async () => {
    // The hostname scheme changed to carry the project. Rewriting a live row's
    // hostname would break a URL somebody has bookmarked, so an update keeps
    // whatever is already there.
    const yaml = `
fleet: homelab
project: keepers
services:
  keeper: { image: nginx, placement: flexible }
`
    await apply(yaml)
    const [first] = await ctx.db
      .select()
      .from(services)
      .where(and(eq(services.fleetId, fleetId), eq(services.name, 'keeper')))

    await ctx.db
      .update(services)
      .set({ hostname: 'keeper-homelab-oldform.example.test' })
      .where(eq(services.id, first!.id))

    await apply(yaml)
    const [again] = await ctx.db.select().from(services).where(eq(services.id, first!.id))
    assert.equal(again!.hostname, 'keeper-homelab-oldform.example.test')
  })

})
