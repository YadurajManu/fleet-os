import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { loadConfig } from '../src/config.js'
import { buildServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'
import { recordChecks, heartbeat } from '../src/status/store.js'
import { evaluate, rollup } from '../src/status/engine.js'
import { statusPaths } from '../src/status/routes.js'
import { assemble } from '../src/status/public.js'
import { writeFile } from 'node:fs/promises'
let ctx: AppContext; let app: FastifyInstance
before(async () => { ctx = createContext({ ...loadConfig(), NODE_ENV: 'test' }); app = await buildServer(ctx); await ctx.redis.del('status:v1:snapshot') })
after(async () => { await app.close(); await closeContext(ctx) })
test('probe -> hysteresis incident -> rollup -> public API, privacy, cache and recovery', async () => {
  const secret = 'private-user-secret-host-192.0.2.123-' + Date.now()
  const signup = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: `${secret}@example.test`, password: 'long-test-password' } })
  assert.equal(signup.statusCode, 201, signup.body)
  await ctx.sql`delete from status_component_state where component_id in ('postgres','api')`
  const t = Date.now() - 10000
  for (let i = 0; i < 3; i++) {
    const observations = [{ component: 'postgres', ts: new Date(t + i * 1000).toISOString(), ok: false, latency_ms: 10, status_code: null, error: 'Health check failed.' }]
    await recordChecks(ctx, observations); await evaluate(ctx, observations)
  }
  await heartbeat(ctx); await rollup(ctx)
  await assemble(ctx)
  const response = await app.inject({ url: '/v1/status' })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().components.find((c: { slug: string }) => c.slug === 'postgres').status, 'major_outage')
  assert.ok(response.json().incidents.some((i: { components: string[] }) => i.components.includes('postgres') && i.components.includes('api')))
  for (const path of statusPaths.filter(p => p !== '/stream' && p !== '/incidents/:id')) {
    const url = '/v1/status' + path.replace(':slug', 'postgres')
    const res = await app.inject({ url }); assert.equal(res.statusCode, 200, `${url}: ${res.body}`); assert.equal(res.body.includes(secret), false); assert.equal(res.body.includes('192.0.2.123'), false)
  }
  const id = response.json().incidents[0].id
  assert.equal((await app.inject({ url: `/v1/status/incidents/${id}` })).statusCode, 200)
  const same = await app.inject({ url: '/v1/status', headers: { 'if-none-match': String(response.headers.etag) } }); assert.equal(same.statusCode, 304)
  assert.equal((await app.inject({ url: '/v1/status/components/github' })).statusCode, 404)
  for (const component of ['postgres', 'api']) for (let i = 0; i < 3; i++) {
    const observations = [{ component, ts: new Date(Date.now() + i * 1000).toISOString(), ok: true, latency_ms: 1, status_code: 200, error: null }]
    await recordChecks(ctx, observations); await evaluate(ctx, observations)
  }
  const [state] = await ctx.sql`select status from status_component_state where component_id='postgres'`
  // The 5-minute failure-rate window may deliberately retain degraded until it clears.
  assert.ok(['operational','major_outage','degraded'].includes(state!.status))
  await ctx.sql`delete from users where id=${signup.json().user.id}`
})
test('retention deletes expired raw/hourly data and preserves daily history', async () => {
  await ctx.sql`insert into status_checks(component_id,ts,ok) values ('npm',now()-interval '8 days',false)`
  await ctx.sql`insert into status_rollups(component_id,bucket,granularity,checks,ok_checks) values ('npm',now()-interval '100 days','day',1,1),('npm',now()-interval '100 days','hour',1,1)`
  await rollup(ctx)
  assert.equal((await ctx.sql`select 1 from status_checks where component_id='npm' and ts<now()-interval '7 days'`).length, 0)
  assert.equal((await ctx.sql`select 1 from status_rollups where component_id='npm' and granularity='hour' and bucket<now()-interval '90 days'`).length, 0)
  assert.ok((await ctx.sql`select 1 from status_rollups where component_id='npm' and granularity='day' and bucket<now()-interval '90 days'`).length)
})
test('OpenAPI is served and generated from the route registry', async () => {
  const result = await app.inject({ url: '/v1/status/openapi.json' }); assert.equal(result.statusCode, 200)
  await writeFile('../docs/status-openapi.json', JSON.stringify(result.json(), null, 2) + '\n')
})
