import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import type { AppContext } from '../api/context.js'
import { intervalMs } from './probes.js'
import { worst, uptime, type Level } from './engine.js'

export const ranges = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 } as const
export type Range = keyof typeof ranges
export const digest = (value: string) => '"' + createHash('sha256').update(value).digest('hex') + '"'
export const xml = (value: string) => value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
export const snapshotPath = () => process.env.STATUS_SNAPSHOT_PATH ?? '/tmp/fleet-status-last-good.json'
export async function writeSnapshot(value: unknown, path = snapshotPath()) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path)
}

export async function publicIncidents(ctx: AppContext, limit = 30, from = new Date(Date.now() - 90 * 86400000), status: string | null = null, cursor: string | null = null) {
  const rows = await ctx.sql`select i.id,i.title,i.impact,i.status,i.started_at,i.resolved_at,array_agg(c.slug order by c.sort) as components
    from status_incidents i join incident_components ic on ic.incident_id=i.id join status_components c on c.id=ic.component_id and c.public
    where i.started_at>=${from.toISOString()} and (${status}::text is null or i.status=${status}) and (${cursor}::uuid is null or i.id<${cursor}::uuid)
    group by i.id order by i.id desc limit ${limit}`
  return rows.map(r => ({ id: r.id, title: r.title, impact: r.impact, status: r.status, started_at: r.started_at, resolved_at: r.resolved_at, components: r.components }))
}
export async function maintenance(ctx: AppContext) {
  return [...await ctx.sql`select m.id,m.title,m.starts_at,m.ends_at,array_agg(c.slug order by c.sort) as components from maintenance_windows m join maintenance_components mc on mc.maintenance_id=m.id join status_components c on c.id=mc.component_id and c.public where m.ends_at>now() group by m.id order by m.starts_at`]
}
export async function series(ctx: AppContext, component: string, range: Range) {
  const hours = ranges[range]; const granularity = hours <= 168 ? 'hour' : 'day'
  const rows = await ctx.sql`select bucket,checks,ok_checks,p50,p95,p99 from status_rollups where component_id=${component} and granularity=${granularity} and bucket>=${new Date(Date.now() - hours * 3600000).toISOString()} order by bucket`
  const [state] = await ctx.sql`select monitoring_since from status_component_state where component_id=${component}`
  const incidentRows = await ctx.sql`select i.id,i.started_at,i.resolved_at from status_incidents i join incident_components c on c.incident_id=i.id where c.component_id=${component} and i.started_at<=now() and (i.resolved_at is null or i.resolved_at>=${new Date(Date.now() - hours * 3600000).toISOString()})`
  const ticks = rows.map(r => ({ start: r.bucket, status: Number(r.checks) === 0 ? 'unknown' : Number(r.ok_checks) === Number(r.checks) ? 'operational' : Number(r.ok_checks) === 0 ? 'major_outage' : 'degraded', uptime: uptime(Number(r.checks), Number(r.ok_checks)), checks: Number(r.checks), p50: r.p50, p95: r.p95, p99: r.p99,
    incidents: incidentRows.filter(i => new Date(i.started_at).getTime() < new Date(r.bucket).getTime() + (granularity === 'hour' ? 3600000 : 86400000) && (!i.resolved_at || new Date(i.resolved_at) >= new Date(r.bucket))).map(i => i.id) }))
  const checks = rows.reduce((n, r) => n + Number(r.checks), 0); const good = rows.reduce((n, r) => n + Number(r.ok_checks), 0)
  const elapsed = Math.min(hours * 3600000, Math.max(0, Date.now() - new Date(state?.monitoring_since ?? Date.now()).getTime()))
  return { ticks, monitoring_since: state?.monitoring_since ?? null, coverage: Math.min(1, checks * intervalMs() / (hours * 3600000)), uptime: uptime(checks, good), checks, observed_ms: elapsed, granularity }
}

export async function assemble(ctx: AppContext) {
  const [beat] = await ctx.sql`select at from status_prober_heartbeat where id='primary'`
  const stale = !beat || Date.now() - new Date(beat.at).getTime() > 2 * intervalMs()
  const rows = await ctx.sql`select c.id,c.slug,c.name,c.description,c."group",s.status,s.checked_at,s.monitoring_since,
    exists(select 1 from maintenance_components mc join maintenance_windows m on m.id=mc.maintenance_id where mc.component_id=c.id and m.starts_at<=now() and m.ends_at>now()) as maintaining
    from status_components c left join status_component_state s on s.component_id=c.id where c.public order by c.sort`
  const components = await Promise.all(rows.map(async r => {
    const cadence = ['build','scheduler'].includes(r.id) ? 900000 : intervalMs()
    const missing = !r.checked_at || Date.now() - new Date(r.checked_at).getTime() > cadence * 2
    const history = await series(ctx, r.id, '90d')
    return { slug: r.slug, name: r.name, description: r.description, group: r.group,
      status: stale || missing ? 'unknown' : r.maintaining ? 'maintenance' : r.status ?? 'unknown', checked_at: r.checked_at ?? null, monitoring_since: r.monitoring_since ?? null, uptime: history.uptime, checks: history.checks, ticks: history.ticks }
  }))
  return { status: worst(components.map(c => c.status as Level)), stale, as_of: new Date().toISOString(), monitoring_since: rows.reduce<string | null>((v, r) => r.monitoring_since && (!v || new Date(r.monitoring_since) < new Date(v)) ? new Date(r.monitoring_since).toISOString() : v, null), components, incidents: await publicIncidents(ctx), maintenance: await maintenance(ctx) }
}
export type Snapshot = Awaited<ReturnType<typeof assemble>>
const bounded = <T>(promise: PromiseLike<T>, ms = 2000) => Promise.race([promise, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error('Status dependency timed out')), ms); timer.unref() })])
export async function snapshot(ctx: AppContext): Promise<Snapshot> {
  try {
    const cached = await Promise.race([ctx.redis.get('status:v1:snapshot'), new Promise<null>(resolve => setTimeout(() => resolve(null), 150))])
    if (cached) return JSON.parse(cached)
  } catch { /* A Redis outage must not hide database-backed status. */ }
  try {
    const result = await bounded(assemble(ctx))
    await Promise.allSettled([bounded(ctx.redis.set('status:v1:snapshot', JSON.stringify(result), 'EX', 15), 150), bounded(ctx.redis.set('status:v1:last-good', JSON.stringify(result), 'EX', 604800), 150), writeSnapshot(result)])
    return result
  } catch {
    try { const saved = await bounded(ctx.redis.get('status:v1:last-good'), 150); if (saved) { const cached = JSON.parse(saved) as Snapshot; return { ...cached, status: 'unknown', stale: true, components: cached.components.map(c => ({ ...c, status: 'unknown' })) } } } catch { /* Disk fallback below. */ }
    try { const cached = JSON.parse(await readFile(snapshotPath(), 'utf8')) as Snapshot; return { ...cached, status: 'unknown', stale: true, components: cached.components.map(c => ({ ...c, status: 'unknown' })) } }
    catch { return { status: 'unknown', stale: true, as_of: null as unknown as string, monitoring_since: null, components: [], incidents: [], maintenance: [] } }
  }
}
