import type { AppContext } from '../api/context.js'

/** Bounded signal categories. Failures are grouped per service, never by raw logs. */
export async function syncOpsSignals(ctx: AppContext) {
  const threshold = ctx.config.HEARTBEAT_INTERVAL_SEC * ctx.config.HEARTBEAT_MISS_THRESHOLD
  if (Date.now() - ctx.startedAt.getTime() < threshold * 1000) return
  const signals = await ctx.sql`select 'node:' || n.id::text as key, 'node_stale' as kind,
      n.id as target, 'Agent stopped reporting' as title, coalesce(n.last_heartbeat_at,n.created_at) as evidence_at
      from nodes n where coalesce(n.last_heartbeat_at,n.created_at) < now() - ${threshold} * interval '1 second'
    union all
    select 'service:' || s.id::text, 'deployment_failed', d.id, 'Latest deployment failed', d.started_at
      from services s join lateral (select id,status,started_at from deployments where service_id=s.id order by started_at desc,id desc limit 1) d on true
      where d.status='failed'`
  // Serialise overlapping collectors across processes; retain state and timeline atomically.
  await ctx.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(8612032)`
    const keys = signals.map((signal) => signal.key as string)
    const cleared = await tx`update platform_incidents set status='resolved',resolved_at=now()
      where status <> 'resolved' and kind in ('node_stale','deployment_failed') and not (signal_key=any(${keys}::text[])) returning id`
    for (const row of cleared) await tx`insert into platform_incident_events(incident_id,action,note) values (${row.id},'signal_cleared','The observed failure signal cleared; inspect deployment and heartbeat evidence before closing the investigation.')`
    for (const signal of signals) {
      const [existing] = await tx`select id,status,resolved_at from platform_incidents where signal_key=${signal.key}`
      if (!existing) {
        const [created] = await tx`insert into platform_incidents(signal_key,kind,target_id,title,evidence_at)
          values (${signal.key},${signal.kind},${signal.target},${signal.title},${signal.evidence_at}) returning id`
        await tx`insert into platform_incident_events(incident_id,action) values (${created!.id},'opened')`
      } else {
        const reopen = existing.status === 'resolved' && new Date(signal.evidence_at).getTime() > new Date(existing.resolved_at).getTime()
        await tx`update platform_incidents set target_id=${signal.target},evidence_at=${signal.evidence_at},last_observed_at=now(),
          status=case when ${reopen} then 'open' else status end,
          resolved_at=case when ${reopen} then null else resolved_at end where id=${existing.id}`
        if (reopen) await tx`insert into platform_incident_events(incident_id,action) values (${existing.id},'reopened')`
      }
    }
  })
}

export async function incidentEvidence(ctx: AppContext, id: string) {
  const [incident] = await ctx.sql`select id,kind,target_id,status,opened_at,last_observed_at from platform_incidents where id=${id}`
  if (!incident) return null
  if (incident.kind === 'node_stale') {
    const [node] = await ctx.sql`select id,last_heartbeat_at,agent_version,platform,status from nodes where id=${incident.target_id}`
    return { incident, facts: [{ id: 'incident', value: incident }, { id: 'node', value: node ?? { deleted: true } }] }
  }
  const [deployment] = await ctx.sql`select id,status,started_at,activated_at,finished_at,node_id from deployments where id=${incident.target_id}`
  const builds = await ctx.sql`select id,platform,status,created_at,started_at,finished_at,attempt from build_jobs where deployment_id=${incident.target_id} order by created_at limit 20`
  return { incident, facts: [{ id: 'incident', value: incident }, { id: 'deployment', value: deployment ?? { deleted: true } }, { id: 'builds', value: builds }] }
}
