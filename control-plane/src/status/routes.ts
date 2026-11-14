import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { ApiError } from '../api/errors.js'
import { requirePlatformOperator } from '../api/ops.routes.js'
import { webhook } from './subscriptions.js'
import { snapshotSchema, componentSchema, seriesSchema, incidentSchema, maintenanceSchema } from './schemas.js'
import { snapshot, publicIncidents, maintenance, series, ranges, digest, xml, type Range } from './public.js'
const object = { type: 'object', additionalProperties: true } as const
const array = { type: 'array', items: object } as const
const string = { type: 'string' } as const
const uuid = { type: 'string', format: 'uuid' } as const
export const statusPaths = ['','/components/:slug','/components/:slug/uptime','/components/:slug/latency','/incidents','/incidents/:id','/maintenance','/metrics','/stream','/summary.json','/badge/:slug.svg','/feed.rss']
export const openapi = { openapi: '3.1.0', info: { title: 'Fleet Public Status', version: '1.0.0' }, paths: Object.fromEntries(statusPaths.map(path => ['/v1/status' + path.replace(/:([\w]+)/g, '{$1}'), { get: { summary: path || 'Current status', responses: { '200': { description: 'Public aggregate status; no customer identifiers', content: { 'application/json': { schema: object } } }, '304': { description: 'Unchanged' } } } }])) }
function send(reply: FastifyReply, body: unknown, contentType?: string) {
  const serialized = typeof body === 'string' ? body : JSON.stringify(body)
  const etag = digest(serialized)
  reply.header('cache-control', 'public, max-age=15, stale-while-revalidate=60').header('etag', etag)
  if (reply.request.headers['if-none-match'] === etag) return reply.code(304).send()
  if (contentType) reply.type(contentType)
  return reply.send(body)
}
export async function statusRoutes(app: FastifyInstance) {
  const ctx = app.ctx
  app.addHook('onRoute', options => {
    const path = options.url.replace(/:([\w]+)/g, '{$1}')
    if (options.schema && options.method === 'GET') (openapi.paths as Record<string, unknown>)[path] = { get: { parameters: [], responses: Object.fromEntries(Object.entries(options.schema.response ?? {}).map(([code, schema]) => [code, { description: code === '200' ? 'Public status response' : 'Response', content: { 'application/json': { schema } } }])) } }
  })
  const counters = new Map<string, { at: number; count: number }>()
  app.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', '*')
    if (counters.size > 10000) for (const [key, value] of counters) if (value.at < Date.now() - 60000) counters.delete(key)
    const key = req.ip; let counter = counters.get(key)
    if (!counter || counter.at < Date.now() - 60000) { counter = { at: Date.now(), count: 0 }; counters.set(key, counter) }
    // Allow the documented 200 rps cache benchmark while bounding abusive clients.
    if (++counter.count > 15000 || counters.size > 20000) return reply.code(429).header('retry-after', '60').send({ error: 'Rate limit exceeded' })
  })
  let cached: Awaited<ReturnType<typeof snapshot>> | undefined; let cachedAt = 0; let pending: Promise<Awaited<ReturnType<typeof snapshot>>> | undefined
  const current = async () => {
    if (cached && Date.now() - cachedAt < 15000) return cached
    if (!pending) pending = snapshot(ctx).then(value => { cached = value; cachedAt = Date.now(); return value }).finally(() => { pending = undefined })
    return pending
  }
  const querySchema = { type: 'object', properties: { range: { type: 'string', enum: Object.keys(ranges), default: '90d' } }, additionalProperties: false }
  const slugSchema = { type: 'object', properties: { slug: { type: 'string', maxLength: 80, pattern: '^[a-z0-9-]+$' } }, required: ['slug'] }
  const component = async (slug: string) => { const c = (await current()).components.find(c => c.slug === slug); if (!c) throw ApiError.notFound('Component'); return c }
  app.get('', { schema: { response: { 200: snapshotSchema } } }, async (_, reply) => send(reply, await current()))
  app.get('/openapi.json', { schema: { response: { 200: object } } }, async (_, reply) => send(reply, openapi))
  app.get('/components/:slug', { schema: { params: slugSchema, response: { 200: { ...componentSchema, properties: { ...componentSchema.properties, uptime_by_range: { type: 'object', additionalProperties: { type: ['number','null'] } } } } } } }, async (req, reply) => {
    const c = await component((req.params as { slug: string }).slug)
    const summaries = await Promise.all(Object.keys(ranges).map(async range => [range, (await series(ctx, c.slug, range as Range)).uptime]))
    return send(reply, { ...c, uptime_by_range: Object.fromEntries(summaries) })
  })
  for (const kind of ['uptime', 'latency']) app.get(`/components/:slug/${kind}`, { schema: { params: slugSchema, querystring: querySchema, response: { 200: seriesSchema } } }, async (req, reply) => {
    const c = await component((req.params as { slug: string }).slug)
    return send(reply, await series(ctx, c.slug, ((req.query as { range?: Range }).range ?? '90d')))
  })
  app.get('/incidents', { schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['investigating','identified','monitoring','resolved'] }, from: { type: 'string', format: 'date-time' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 }, cursor: uuid }, additionalProperties: false }, response: { 200: object } } }, async (req, reply) => {
    const q = req.query as { status?: string; from?: string; limit?: number; cursor?: string }
    const incidents = await publicIncidents(ctx, q.limit ?? 30, q.from ? new Date(q.from) : undefined, q.status ?? null, q.cursor ?? null)
    return send(reply, { incidents, next_cursor: incidents.length === (q.limit ?? 30) ? incidents.at(-1)!.id : null })
  })
  app.get('/incidents/:id', { schema: { params: { type: 'object', properties: { id: uuid }, required: ['id'] }, response: { 200: object } } }, async (req, reply) => {
    const id = (req.params as { id: string }).id
    const [i] = await ctx.sql`select i.id,i.title,i.impact,i.status,i.started_at,i.resolved_at from status_incidents i where i.id=${id} and exists(select 1 from incident_components ic join status_components c on c.id=ic.component_id where ic.incident_id=i.id and c.public)`
    if (!i) throw ApiError.notFound('Incident')
    const updates = await ctx.sql`select id,status,body,ts from incident_updates where incident_id=${id} order by ts`
    return send(reply, { ...i, updates: [...updates] })
  })
  app.get('/maintenance', { schema: { response: { 200: object } } }, async (_, reply) => send(reply, { maintenance: await maintenance(ctx) }))
  app.get('/metrics', { schema: { response: { 200: object } } }, async (_, reply) => {
    const [population] = await ctx.sql`select count(distinct n.id)::int nodes,count(distinct om.user_id)::int users from nodes n join fleets f on f.id=n.fleet_id join org_members om on om.org_id=f.org_id`
    if (population!.nodes < 5 || population!.users < 5) return send(reply, { agents_online_percent: null, deploys_24h: null, deploy_success_rate_7d: null, median_deploy_time_ms: null, failover_events_30d: null, median_failover_time_ms: null, agent_version_spread: null, latest_cli_version: process.env.STATUS_LATEST_CLI_VERSION ?? null })
    // Each deployment metric independently requires five contributing users and nodes.
    const [d] = await ctx.sql`select count(distinct om.user_id)::int users,count(distinct d.node_id)::int nodes,count(distinct d.id)::int total,count(distinct d.id) filter(where d.status='running')::int good,percentile_cont(.5) within group(order by extract(epoch from(d.finished_at-d.started_at))*1000) as median from deployments d join services s on s.id=d.service_id join fleets f on f.id=s.fleet_id join org_members om on om.org_id=f.org_id where d.started_at>now()-interval '7 days'`
    const [online] = await ctx.sql`select 100.0*count(*) filter(where last_heartbeat_at>now()-interval '30 seconds')/nullif(count(*),0) as pct from nodes`
    return send(reply, { agents_online_percent: Number(online?.pct), deploys_24h: null, deploy_success_rate_7d: d!.users>=5 && d!.nodes>=5 ? Number(d!.good)/Number(d!.total)*100 : null, median_deploy_time_ms: d!.users>=5 && d!.nodes>=5 ? Number(d!.median) : null, failover_events_30d: null, median_failover_time_ms: null, agent_version_spread: null, latest_cli_version: process.env.STATUS_LATEST_CLI_VERSION ?? null })
  })
  const streams = new Set<NodeJS.Timeout>()
  app.addHook('onClose', async () => { for (const timer of streams) clearInterval(timer) })
  app.get('/stream', { schema: { response: { 200: string } } }, async (req, reply) => {
    reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*', 'x-accel-buffering': 'no' })
    let previous = ''; let busy = false
    const tick = async () => { if (busy || reply.raw.destroyed) return; busy = true; try { const data = JSON.stringify(await current()); if (data !== previous) { reply.raw.write(`event: status-change\ndata: ${data}\n\n`); const incidents = JSON.stringify((await current()).incidents); reply.raw.write(`event: incident\ndata: ${incidents}\n\n`); previous = data } } finally { busy = false } }
    await tick()
    const changes = setInterval(() => { void tick().catch(() => {}) }, 15000)
    const heart = setInterval(() => reply.raw.write(': heartbeat\n\n'), 20000)
    streams.add(changes); streams.add(heart)
    req.raw.on('close', () => { clearInterval(changes); clearInterval(heart); streams.delete(changes); streams.delete(heart) })
  })
  app.get('/summary.json', { schema: { response: { 200: object } } }, async (_, reply) => {
    const s = await current(); return send(reply, { page: { id: 'fleet', name: 'Fleet OS', updated_at: s.as_of }, status: { indicator: s.status === 'operational' ? 'none' : s.status === 'unknown' ? 'none' : 'minor', description: s.status }, components: s.components.map(c => ({ id: c.slug, name: c.name, status: c.status })), incidents: s.incidents, scheduled_maintenances: s.maintenance })
  })
  app.get('/badge/:slug.svg', { schema: { response: { 200: string } } }, async (req, reply) => {
    const c = await component((req.params as { slug: string }).slug)
    const color = c.status === 'operational' ? '#3fe08b' : c.status === 'unknown' ? '#939ba7' : c.status === 'maintenance' ? '#939ba7' : '#ffb547'
    return send(reply, `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="20" role="img" aria-label="${xml(c.name + ': ' + c.status)}"><rect width="240" height="20" fill="#12161c"/><text x="8" y="14" fill="${color}" font-family="Verdana" font-size="11">Fleet · ${xml(c.slug)}: ${xml(c.status)}</text></svg>`, 'image/svg+xml')
  })
  app.get('/feed.rss', { schema: { response: { 200: string } } }, async (_, reply) => send(reply, `<?xml version="1.0"?><rss version="2.0"><channel><title>Fleet OS incidents</title><link>https://fleet.plastikworld.xyz/status</link><description>Public platform health</description>${(await current()).incidents.map(i => `<item><guid>${i.id}</guid><title>${xml(i.title)}</title><description>${xml(i.status)}</description><pubDate>${new Date(i.started_at).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`, 'application/rss+xml'))
  app.post('/subscriptions', { schema: { body: { type: 'object', required: ['channel','target'], properties: { channel: { type: 'string', enum: ['email','webhook'] }, target: { type: 'string', maxLength: 2048 }, component_ids: { type: 'array', maxItems: 20, items: string } }, additionalProperties: false }, response: { 202: object } } }, async (req, reply) => {
    const body = req.body as { channel: 'email' | 'webhook'; target: string; component_ids?: string[] }
    if (body.channel === 'email' && !(ctx.config.RESEND_API_KEY && ctx.config.MAIL_FROM)) throw ApiError.badRequest('email_disabled','Email subscriptions are not configured; use webhook.')
    if (body.channel === 'webhook') { let u: URL; try { u = new URL(body.target) } catch { throw ApiError.badRequest('invalid_target','A public HTTPS webhook is required.') }; if (u.protocol !== 'https:' || u.username || u.password) throw ApiError.badRequest('invalid_target','A public HTTPS webhook is required.') }
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.target)) throw ApiError.badRequest('invalid_target','A valid email is required.')
    const ids = body.component_ids ?? []; const allowed = (await current()).components.map(c => c.slug)
    if (ids.some(id => !allowed.includes(id))) throw ApiError.badRequest('invalid_component','Only public components can be subscribed to.')
    const token = randomBytes(32).toString('hex')
    await ctx.sql`insert into status_subscribers(channel,target,component_ids,token) values (${body.channel},${body.target},${ids},${token})`
    if (body.channel === 'email') await ctx.email.send(body.target, 'Confirm Fleet status subscription', `Confirm: ${ctx.config.PUBLIC_API_URL ?? ''}/v1/status/subscriptions/verify?token=${token}`)
    else {
      try { const response = await webhook(body.target, { event: 'verify', challenge: token }); if (response.trim() !== token) throw Error('Verification failed'); await ctx.sql`update status_subscribers set verified_at=now() where token=${token}` }
      catch { await ctx.sql`delete from status_subscribers where token=${token}`; throw ApiError.badRequest('verification_failed','Public HTTPS webhook must echo the verification challenge.') }
    }
    return reply.code(202).send({ accepted: true, verification_required: true })
  })
  app.get('/subscriptions/verify', { schema: { querystring: { type: 'object', required: ['token'], properties: { token: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, additionalProperties: false }, response: { 200: object } } }, async (req, reply) => {
    const token = (req.query as { token: string }).token
    const verified = await ctx.sql`update status_subscribers set verified_at=now() where token=${token} and channel='email' returning id`
    if (!verified.length) throw ApiError.notFound('Subscription')
    return reply.header('cache-control','no-store').send({ verified: true })
  })
  app.post('/admin/incidents', { preHandler: requirePlatformOperator, schema: { body: { type: 'object', required: ['title','impact','components'], properties: { title: { type: 'string', maxLength: 200 }, impact: { type: 'string', enum: ['degraded','partial_outage','major_outage'] }, components: { type: 'array', minItems: 1, maxItems: 17, items: string } }, additionalProperties: false }, response: { 201: object } } }, async (req, reply) => {
    const b = req.body as { title: string; impact: string; components: string[] }
    const incident = await ctx.sql.begin(async tx => { const [i] = await tx`insert into status_incidents(title,impact,status,started_at) values (${b.title},${b.impact},'investigating',now()) returning id`; for (const id of b.components) await tx`insert into incident_components(incident_id,component_id) values (${i!.id},${id}) on conflict do nothing`; return i })
    cachedAt = 0; await ctx.redis.del('status:v1:snapshot'); return reply.code(201).send(incident)
  })
  app.post('/admin/incidents/:id/updates', { preHandler: requirePlatformOperator, schema: { params: { type: 'object', properties: { id: uuid }, required: ['id'] }, body: { type: 'object', properties: { status: { type: 'string', enum: ['investigating','identified','monitoring','resolved'] }, body: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['status','body'], additionalProperties: false }, response: { 200: object } } }, async (req) => {
    const id = (req.params as { id: string }).id; const b = req.body as { status: string; body: string }
    await ctx.sql.begin(async tx => { const rows = await tx`update status_incidents set status=${b.status},resolved_at=${b.status === 'resolved' ? new Date() : null} where id=${id} returning id`; if (!rows.length) throw ApiError.notFound('Incident'); await tx`insert into incident_updates(incident_id,status,body,ts) values (${id},${b.status},${b.body},now())` })
    cachedAt = 0; await ctx.redis.del('status:v1:snapshot'); return { updated: true }
  })
}
