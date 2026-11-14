import type { AppContext } from '../api/context.js'
import type { Observation } from './probes.js'
import { intervalMs } from './probes.js'
export type Level = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance' | 'unknown'
export type State = { status: Level; failures: number; successes: number; degraded_since: string | Date | null }
export function transition(previous: State, ok: boolean | null, slow: boolean, now: number, maintenance = false): State {
  if (maintenance) return { status: 'maintenance', failures: 0, successes: 0, degraded_since: null }
  if (ok === null) return { ...previous, status: 'unknown', failures: 0, successes: 0, degraded_since: null }
  const failures = ok ? 0 : previous.failures + 1
  const successes = ok ? previous.successes + 1 : 0
  const degraded_since = slow ? previous.degraded_since ?? new Date(now).toISOString() : null
  let status = previous.status
  if (failures >= 3) status = 'major_outage'
  else if (failures >= 2) status = 'partial_outage'
  else if (degraded_since && now - new Date(degraded_since).getTime() >= (Number(process.env.STATUS_DEGRADED_SECONDS) || 300) * 1000) status = 'degraded'
  else if (successes >= 3 && !slow) status = 'operational'
  return { status, failures, successes, degraded_since }
}
export const uptime = (checks: number, good: number) => checks ? good / checks * 100 : null
export function worst(levels: Level[]): Level {
  return (['major_outage', 'partial_outage', 'degraded', 'maintenance', 'unknown', 'operational'] as Level[]).find(level => levels.includes(level)) ?? 'unknown'
}
export const outage = (s: string) => ['degraded', 'partial_outage', 'major_outage'].includes(s)

export async function evaluate(ctx: AppContext, readings: Observation[]) {
  for (const r of readings) await ctx.sql.begin(async tx => {
    await tx`insert into status_component_state(component_id,monitoring_since) values (${r.component},${r.ts}) on conflict do nothing`
    const [previous] = await tx`select * from status_component_state where component_id=${r.component} for update`
    if (previous?.checked_at && new Date(previous.checked_at).getTime() >= Date.parse(r.ts)) return
    const [maintenance] = await tx`select 1 from maintenance_windows m join maintenance_components c on c.maintenance_id=m.id where c.component_id=${r.component} and m.starts_at<=${r.ts} and m.ends_at>${r.ts} limit 1`
    const [stats] = await tx`select percentile_cont(.95) within group(order by latency_ms) as p95,avg(case when ok then 0.0 else 1.0 end) filter(where ok is not null) as rate from status_checks where component_id=${r.component} and ts>=${r.ts}::timestamptz-interval '5 minutes'`
    const slow = Number(stats?.p95) > (Number(process.env.STATUS_LATENCY_P95_MS) || 1000) || Number(stats?.rate) > (Number(process.env.STATUS_ERROR_RATE) || .05)
    const next = transition(previous as State, r.ok, slow, Date.parse(r.ts), Boolean(maintenance))
    await tx`update status_component_state set status=${next.status},failures=${next.failures},successes=${next.successes},degraded_since=${next.degraded_since},checked_at=${r.ts} where component_id=${r.component}`
    if (next.status === previous!.status) return
    if (outage(next.status)) {
      const existing = await tx`select distinct i.id from status_incidents i join incident_components ic on ic.incident_id=i.id where i.auto and i.resolved_at is null and (ic.component_id=${r.component} or exists(select 1 from status_components c where c.id=${r.component} and ic.component_id=any(c.depends_on)) or exists(select 1 from status_components c where c.id=ic.component_id and ${r.component}=any(c.depends_on))) limit 1`
      let incidentId = existing[0]?.id
      if (!incidentId) {
        const [component] = await tx`select name from status_components where id=${r.component}`
        const [incident] = await tx`insert into status_incidents(title,impact,status,started_at,auto) values (${component!.name + ' health interruption'},${next.status},'investigating',${r.ts},true) returning id`
        incidentId = incident!.id
      }
      await tx`insert into incident_components(incident_id,component_id) select ${incidentId},id from status_components where id=${r.component} or ${r.component}=any(depends_on) on conflict do nothing`
      await tx`update status_incidents set impact=case when impact='major_outage' or ${next.status}='major_outage' then 'major_outage' when impact='partial_outage' or ${next.status}='partial_outage' then 'partial_outage' else 'degraded' end where id=${incidentId}`
      await tx`insert into incident_updates(incident_id,status,body,ts) values (${incidentId},'investigating','Automated checks detected a component health change.',${r.ts})`
    } else if (next.status === 'operational') {
      const incidents = await tx`select i.id from status_incidents i join incident_components ic on ic.incident_id=i.id where i.auto and i.resolved_at is null and ic.component_id=${r.component}`
      for (const incident of incidents) {
        const [bad] = await tx`select 1 from incident_components ic join status_component_state s on s.component_id=ic.component_id where ic.incident_id=${incident.id} and s.status in ('degraded','partial_outage','major_outage','unknown') limit 1`
        if (!bad) {
          await tx`update status_incidents set status='resolved',resolved_at=${r.ts} where id=${incident.id}`
          await tx`insert into incident_updates(incident_id,status,body,ts) values (${incident.id},'resolved','Repeated successful checks confirm recovery.',${r.ts})`
        }
      }
    }
  })
  await ctx.redis.del('status:v1:snapshot').catch(() => {})
}

export async function rollup(ctx: AppContext) {
  await ctx.sql.begin(async tx => {
    // Whole buckets only: never overwrite an older complete daily bucket with a partial raw tail.
    await tx`insert into status_rollups(component_id,bucket,granularity,checks,ok_checks,p50,p95,p99,downtime_s)
      select component_id,date_trunc(g,ts at time zone 'UTC') at time zone 'UTC',g,count(ok)::int,count(*) filter(where ok)::int,
      percentile_cont(.5) within group(order by latency_ms)::real,percentile_cont(.95) within group(order by latency_ms)::real,percentile_cont(.99) within group(order by latency_ms)::real,count(*) filter(where ok=false)*(case when component_id in ('build','scheduler') then 900 else ${intervalMs() / 1000} end)
      from status_checks cross join (values ('hour'),('day')) as grain(g) where ts>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'-interval '6 days'
      group by component_id,g,date_trunc(g,ts at time zone 'UTC')
      on conflict(component_id,bucket,granularity) do update set checks=excluded.checks,ok_checks=excluded.ok_checks,p50=excluded.p50,p95=excluded.p95,p99=excluded.p99,downtime_s=excluded.downtime_s`
    await tx`delete from status_checks where ts<now()-interval '7 days'`
    await tx`delete from status_rollups where (granularity='hour' and bucket<now()-interval '90 days') or (granularity='day' and bucket<now()-interval '2 years')`
  })
}
