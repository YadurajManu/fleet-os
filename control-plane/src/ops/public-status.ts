import { access } from 'node:fs/promises'
import type { AppContext } from '../api/context.js'

type Component = { id: string; name: string; status: 'operational' | 'degraded' | 'outage' | 'unknown'; message: string }

// shortcut: a control-plane outage leaves a gap instead of a recorded outage, add an external probe when independent outage attribution is required.

async function check(ctx: AppContext): Promise<Component[]> {
  const [database, redis, registry] = await Promise.allSettled([
    ctx.sql`select 1`,
    ctx.redis.ping(),
    ctx.config.OPS_REGISTRY_STORAGE_PATH ? access(ctx.config.OPS_REGISTRY_STORAGE_PATH) : Promise.reject(new Error('not configured')),
  ])
  return [
    { id: 'api', name: 'Control plane API', status: 'operational', message: 'Public API is responding.' },
    { id: 'postgres', name: 'Postgres', status: database.status === 'fulfilled' ? 'operational' : 'outage', message: database.status === 'fulfilled' ? 'Database checks are passing.' : 'Database health check failed.' },
    { id: 'redis', name: 'Redis', status: redis.status === 'fulfilled' ? 'operational' : 'outage', message: redis.status === 'fulfilled' ? 'Cache and heartbeat checks are passing.' : 'Redis health check failed.' },
    { id: 'registry', name: 'Registry storage', status: !ctx.config.OPS_REGISTRY_STORAGE_PATH ? 'unknown' : registry.status === 'fulfilled' ? 'operational' : 'outage', message: !ctx.config.OPS_REGISTRY_STORAGE_PATH ? 'Registry storage monitoring is not configured.' : registry.status === 'fulfilled' ? 'Registry storage is accessible.' : 'Registry storage check failed.' },
  ]
}

export async function collectPublicStatus(ctx: AppContext) {
  const components = await check(ctx)
  for (const component of components) {
    const previous = await ctx.sql`select status from public_status_samples where component=${component.id} order by checked_at desc limit 1`
    const now = new Date().toISOString()
    await ctx.sql`insert into public_status_samples (component,status,checked_at) values (${component.id},${component.status},${now})`
    if (component.status !== 'unknown' && previous[0]?.status !== component.status && (previous.length > 0 || component.status !== 'operational')) {
      const resolved = component.status === 'operational'
      await ctx.sql`insert into public_status_events (component,status,message,occurred_at) values (${component.id},${component.status},${resolved ? `${component.name} returned to normal.` : component.message},${now})`
    }
  }
  await ctx.sql`delete from public_status_samples where checked_at < now() - interval '90 days'`
  await ctx.sql`delete from public_status_events where occurred_at < now() - interval '180 days'`
}

export async function publicStatus(ctx: AppContext) {
  const [latest, history, events, firstSample] = await Promise.all([
    ctx.sql`select distinct on (component) component,status,checked_at from public_status_samples order by component,checked_at desc`,
    ctx.sql`select component,date_trunc('day',checked_at)::date as day,count(*)::int as samples,count(*) filter(where status='operational')::int as ok from public_status_samples where checked_at >= now() - interval '90 days' and status <> 'unknown' group by component,day order by day`,
    ctx.sql`select id,component,status,message,occurred_at from public_status_events order by occurred_at desc limit 30`,
    ctx.sql`select min(checked_at) as at from public_status_samples`,
  ])
  const current = new Map(latest.map((row) => [row.component, row]))
  const byComponent = new Map<string, Array<{ date: string; uptime: number | null; samples: number }>>()
  for (const row of history) {
    const points = byComponent.get(row.component) ?? []
    points.push({ date: row.day, uptime: Math.round((Number(row.ok) / Number(row.samples)) * 10000) / 100, samples: Number(row.samples) })
    byComponent.set(row.component, points)
  }
  const definitions = [
    ['api', 'Control plane API'], ['postgres', 'Postgres'], ['redis', 'Redis'], ['registry', 'Registry storage'],
  ] as const
  const components = definitions.map(([id, name]) => {
    const row = current.get(id)
    const stale = !row || Date.now() - new Date(row.checked_at).getTime() > 120_000
    return { id, name, status: stale ? 'unknown' : row.status, checkedAt: row?.checked_at ?? null, uptime90d: byComponent.get(id) ?? [] }
  })
  const degraded = components.some((item) => item.status === 'outage' || item.status === 'degraded')
  const unknown = components.some((item) => item.status === 'unknown')
  return {
    status: degraded ? 'degraded' : unknown ? 'unknown' : 'operational',
    checkedAt: latest.reduce<Date | null>((newest, row) => !newest || new Date(row.checked_at) > newest ? new Date(row.checked_at) : newest, null),
    components,
    events,
    refreshSeconds: 30,
    monitoredSince: firstSample[0]?.at ?? null,
  }
}
