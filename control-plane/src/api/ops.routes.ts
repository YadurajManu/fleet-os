import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { platformOperators, users } from '../db/schema.js'
import { ApiError } from './errors.js'
import { requireUser } from './guards.js'
import { z } from 'zod'
import { infrastructure } from '../ops/metrics.js'
import { syncOpsSignals, incidentEvidence } from '../ops/incidents.js'
import { analyzeIncident } from '../ops/analysis.js'

/** Platform access is independent of customer fleet membership. No HTTP grant route. */
async function requirePlatformOperator(req: FastifyRequest, reply: FastifyReply) {
  const explicitBearer = req.headers.authorization?.startsWith('Bearer ')
  await requireUser(req, reply)
  const [operator] = await req.server.ctx.db.select({
    id: platformOperators.userId,
    verified: users.emailVerifiedAt,
    totp: users.totpSecret,
  }).from(platformOperators).innerJoin(users, eq(users.id, platformOperators.userId))
    .where(eq(platformOperators.userId, req.userId!)).limit(1)
  if (!operator?.verified || !operator.totp) throw ApiError.forbidden('Platform operations requires a verified operator account with 2FA')
  // Cookie fallback remains available for reads, but cannot authorize cross-origin writes.
  if (req.method === 'POST' && !explicitBearer) throw ApiError.forbidden('Operations actions require a bearer access token')
  const route = req.routeOptions.url ?? ''
  if (route.startsWith('/ops/users') || route.startsWith('/ops/deployments') || req.method === 'POST') {
    const params = req.params as { userId?: string; id?: string }
    const target = params.userId ?? params.id
    await req.server.ctx.sql`insert into platform_access_events(actor_id,action,target_id)
      values (${req.userId!},${req.method + ' ' + route},${target && validId(target) ? target : null})`
  }
}

const validId = (value: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
function idParam(req: FastifyRequest) {
  const { id } = req.params as { id: string }
  if (!validId(id)) throw ApiError.notFound('Record')
  return id
}

export async function opsRoutes(app: FastifyInstance) {
  const sql = app.ctx.sql
  let collector: ReturnType<typeof setInterval> | undefined
  if (app.ctx.config.NODE_ENV !== 'test') {
    let pending: Promise<void> | undefined
    const collect = () => {
      if (pending) return pending
      pending = syncOpsSignals(app.ctx).catch((err) => { app.log.error({ err }, 'Operations signal collection failed') })
        .finally(() => { pending = undefined })
      return pending
    }
    app.addHook('onReady', async () => { await collect(); collector = setInterval(() => { void collect() }, 30_000); collector.unref() })
    app.addHook('onClose', async () => { if (collector) clearInterval(collector); await pending })
  }
  app.get('/ops/me', { preHandler: requirePlatformOperator }, async (req) => ({ operator: true, userId: req.userId }))

  app.get('/ops/infrastructure', { preHandler: requirePlatformOperator }, async () => infrastructure(app.ctx))
  app.get('/ops/incidents', { preHandler: requirePlatformOperator }, async (req) => {
    const status = (req.query as { status?: string }).status ?? 'active'
    if (!['active', 'resolved', 'all'].includes(status)) throw ApiError.badRequest('invalid_filter', 'Choose active, resolved, or all')
    const incidents = await sql`select i.*, u.email as assigned_email,
      case when i.kind='node_stale' then n.name else s.name end as target_name,
      coalesce(nf.name,f.name) as fleet,coalesce(no.name,o.name) as organization
      from platform_incidents i left join users u on u.id=i.assigned_to
      left join nodes n on n.id=i.target_id and i.kind='node_stale' left join fleets nf on nf.id=n.fleet_id left join orgs no on no.id=nf.org_id
      left join deployments d on d.id=i.target_id and i.kind='deployment_failed'
      left join services s on s.id=d.service_id left join fleets f on f.id=s.fleet_id left join orgs o on o.id=f.org_id
      where ${status === 'all'} or (${status === 'active'} and i.status <> 'resolved') or (${status === 'resolved'} and i.status='resolved')
      order by i.last_observed_at desc,i.id desc limit 100`
    return { incidents, limit: 100, observedAt: new Date().toISOString() }
  })
  app.get('/ops/incidents/:id', { preHandler: requirePlatformOperator }, async (req) => {
    const id = idParam(req)
    const evidence = await incidentEvidence(app.ctx, id)
    if (!evidence) throw ApiError.notFound('Incident')
    const events = await sql`select e.id,e.action,e.note,e.at,u.email as actor from platform_incident_events e
      left join users u on u.id=e.actor_id where e.incident_id=${id} order by e.at desc,e.id desc limit 100`
    return { ...evidence, events: events.reverse() }
  })
  app.post('/ops/incidents/:id/actions', { preHandler: requirePlatformOperator }, async (req) => {
    const id = idParam(req)
    const input = z.object({ action: z.enum(['acknowledge','resolve','reopen','assign_me','note']), note: z.string().trim().max(1000).optional() }).safeParse(req.body)
    if (!input.success) throw ApiError.badRequest('invalid_action', 'Choose an incident action and a note of at most 1000 characters')
    const { action, note } = input.data
    if (['resolve','reopen','note'].includes(action) && (!note || note.length < 3)) throw ApiError.badRequest('note_required', 'Explain this incident update in a short note')
    await sql.begin(async (tx) => {
      const [current] = await tx`select status from platform_incidents where id=${id} for update`
      if (!current) throw ApiError.notFound('Incident')
      if (action === 'acknowledge' && current.status !== 'open') throw ApiError.conflict('invalid_transition', 'Only open incidents can be acknowledged')
      if (action === 'reopen' && current.status !== 'resolved') throw ApiError.conflict('invalid_transition', 'Only resolved incidents can be reopened')
      if (action === 'resolve' && current.status === 'resolved') throw ApiError.conflict('invalid_transition', 'This incident is already resolved')
      if (action === 'acknowledge') await tx`update platform_incidents set status='acknowledged',assigned_to=coalesce(assigned_to,${req.userId!}) where id=${id}`
      if (action === 'assign_me') await tx`update platform_incidents set assigned_to=${req.userId!} where id=${id}`
      if (action === 'resolve') await tx`update platform_incidents set status='resolved',resolved_at=now() where id=${id}`
      if (action === 'reopen') await tx`update platform_incidents set status='open',resolved_at=null where id=${id}`
      await tx`insert into platform_incident_events(incident_id,actor_id,action,note) values (${id},${req.userId!},${action},${note ?? null})`
    })
    return { ok: true }
  })
  app.post('/ops/incidents/:id/analyze', { preHandler: requirePlatformOperator }, async (req) => analyzeIncident(app.ctx, idParam(req), req.userId!))

  app.get('/ops/deployments', { preHandler: requirePlatformOperator }, async (req) => {
    const query = req.query as { q?: string; page?: string }
    const q = (query.q ?? '').trim().slice(0,100)
    const page = Math.min(1000,Math.max(1,Number.parseInt(query.page ?? '1',10) || 1))
    const deployments = await sql`select d.id,d.status,d.git_sha,d.started_at,d.activated_at,d.finished_at,s.name as service,
      f.name as fleet,o.name as organization,n.name as node,
      d.build_context->'snapshot'->>'fingerprint' as snapshot,
      (select count(*)::int from build_jobs b where b.deployment_id=d.id) as builds
      from deployments d join services s on s.id=d.service_id join fleets f on f.id=s.fleet_id join orgs o on o.id=f.org_id
      left join nodes n on n.id=d.node_id where ${q === ''} or s.name ilike ${'%' + q + '%'} or o.name ilike ${'%' + q + '%'}
      order by d.started_at desc,d.id desc limit 50 offset ${(page-1)*50}`
    return { deployments, page }
  })
  app.get('/ops/deployments/:id', { preHandler: requirePlatformOperator }, async (req) => {
    const id = idParam(req)
    const [deployment] = await sql`select d.id,d.status,d.git_sha,d.image_tags,d.started_at,d.activated_at,d.finished_at,
      s.id as service_id,s.name as service,f.name as fleet,o.name as organization,n.name as node,
      d.build_context->'snapshot'->>'fingerprint' as snapshot,
      (select p.id from deployments p where p.service_id=d.service_id and p.activated_at is not null and p.started_at<d.started_at order by p.started_at desc limit 1) as previous_release
      from deployments d join services s on s.id=d.service_id join fleets f on f.id=s.fleet_id join orgs o on o.id=f.org_id
      left join nodes n on n.id=d.node_id where d.id=${id}`
    if (!deployment) throw ApiError.notFound('Deployment')
    const builds = await sql`select b.id,b.platform,b.status,b.attempt,b.created_at,b.started_at,b.finished_at,b.image_digest,n.name as builder
      from build_jobs b left join nodes n on n.id=b.builder_node_id where b.deployment_id=${id} order by b.created_at limit 20`
    return { deployment, builds }
  })
  app.get('/ops/security', { preHandler: requirePlatformOperator }, async () => {
    const [operators, events] = await Promise.all([
      sql`select u.email,p.granted_at,(u.email_verified_at is not null) as verified,(u.totp_secret is not null) as two_factor from platform_operators p join users u on u.id=p.user_id order by p.granted_at`,
      sql`select e.id,e.action,e.target_id,e.at,u.email as actor from platform_access_events e left join users u on u.id=e.actor_id order by e.at desc,e.id desc limit 100`,
    ])
    return { operators, events }
  })

  app.get('/ops/summary', { preHandler: requirePlatformOperator }, async (req) => {
    const days = Number((req.query as { days?: string }).days ?? 30)
    if (![7, 30, 90].includes(days)) throw ApiError.badRequest('invalid_range', 'Choose 7, 30, or 90 days')
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const [activation, counts, health, geography, nodePlatforms, signupTrend, deployTrend, buildTrend, dbSize] = await Promise.all([
      sql`select
        (select count(*)::int from users u where u.created_at >= ${since}) as signup,
        (select count(*)::int from users u where u.created_at >= ${since} and u.email_verified_at is not null) as verified,
        (select count(*)::int from users u where u.created_at >= ${since} and exists (
          select 1 from org_members m join fleets f on f.org_id=m.org_id where m.user_id=u.id
        )) as first_fleet,
        (select count(*)::int from users u where u.created_at >= ${since} and exists (
          select 1 from org_members m join fleets f on f.org_id=m.org_id join nodes n on n.fleet_id=f.id where m.user_id=u.id
        )) as first_node,
        (select count(*)::int from users u where u.created_at >= ${since} and exists (
          select 1 from org_members m join fleets f on f.org_id=m.org_id join services s on s.fleet_id=f.id
          join deployments d on d.service_id=s.id where m.user_id=u.id and d.activated_at is not null
        )) as first_deploy`,
      sql`select
        (select count(*)::int from users) as users,
        (select count(*)::int from users where email_verified_at is not null) as verified_users,
        (select count(*)::int from users where created_at >= ${since}) as new_users,
        (select count(*)::int from users where email_verified_at >= ${since}) as newly_verified,
        (select count(*)::int from orgs) as organizations,
        (select count(distinct f.org_id)::int from fleets f join services s on s.fleet_id=f.id join deployments d on d.service_id=s.id where d.started_at >= ${since}) as active_organizations,
        (select count(*)::int from fleets) as fleets,
        (select count(*)::int from fleets where created_at >= ${since}) as new_fleets,
        (select count(*)::int from nodes) as nodes,
        (select count(*)::int from services) as services,
        (select count(*)::int from deployments where started_at >= ${since}) as deployments,
        (select count(*)::int from build_jobs where created_at >= ${since}) as builds,
        (select count(distinct s.fleet_id)::int from deployments d join services s on s.id=d.service_id where d.status='running') as fleets_with_running_release`,
      sql`select
        (select count(*)::int from nodes where last_heartbeat_at >= now() - interval '30 seconds') as online_nodes,
        (select count(*)::int from nodes where last_heartbeat_at < now() - interval '30 seconds' or last_heartbeat_at is null) as stale_nodes,
        (select count(*)::int from deployments where status='failed' and started_at >= now() - interval '24 hours') as failed_deployments_24h,
        (select count(*)::int from build_jobs where status='failed' and created_at >= now() - interval '24 hours') as failed_builds_24h`,
      sql`select coalesce(latest.country, 'unknown') as country, count(*)::int as users
        from users u left join lateral (
          select country from auth_sessions where user_id=u.id order by last_seen desc limit 1
        ) latest on true group by 1 order by users desc`,
      sql`select coalesce(platform, 'unknown') as platform, count(*)::int as nodes from nodes group by 1 order by nodes desc`,
      sql`select date_trunc('day', created_at)::date::text as day, count(*)::int as count from users where created_at >= ${since} group by 1 order by 1`,
      sql`select date_trunc('day', started_at)::date::text as day, count(*)::int as count from deployments where started_at >= ${since} group by 1 order by 1`,
      sql`select date_trunc('day', created_at)::date::text as day, count(*)::int as count from build_jobs where created_at >= ${since} group by 1 order by 1`,
      sql`select pg_database_size(current_database())::bigint::text as bytes`,
    ])
    return {
      days, counts: counts[0], activation: activation[0], health: health[0], geography, nodePlatforms,
      trends: { signups: signupTrend, deployments: deployTrend, builds: buildTrend },
      storage: { databaseBytes: dbSize[0]?.bytes, registryBytes: null, networkBytes: null },
      unavailable: ['nodeCoordinates', 'apiErrorRate', 'registryDiskBytes', 'networkStorageBytes'],
    }
  })

  app.get('/ops/users', { preHandler: requirePlatformOperator }, async (req) => {
    const query = req.query as { q?: string; page?: string; country?: string }
    const q = (query.q ?? '').trim().slice(0, 100)
    const country = query.country ?? ''
    if (country && country !== 'unknown' && !/^[A-Z]{2}$/.test(country)) throw ApiError.badRequest('invalid_country', 'Use a two-letter country code or unknown')
    const page = Math.min(1000, Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1))
    const rows = await sql`select u.id, u.email, u.created_at, u.email_verified_at,
      (select count(*)::int from org_members m where m.user_id=u.id) as organizations,
      (select country from auth_sessions a where a.user_id=u.id order by last_seen desc limit 1) as last_country,
      (select max(last_seen) from auth_sessions a where a.user_id=u.id) as last_seen
      from users u where (${q === ''} or u.email ilike ${'%' + q + '%'})
      and (${country === ''} or coalesce((select country from auth_sessions a where a.user_id=u.id order by last_seen desc limit 1),'unknown')=${country})
      order by u.created_at desc, u.id desc limit 50 offset ${(page - 1) * 50}`
    return { page, users: rows.map(({ id, email, created_at, email_verified_at, organizations, last_country, last_seen }) => ({
      id, email, createdAt: created_at, verified: email_verified_at != null, organizations,
      country: last_country ?? 'unknown', lastSeen: last_seen,
    })) }
  })

  app.get('/ops/users/:userId', { preHandler: requirePlatformOperator }, async (req) => {
    const { userId } = req.params as { userId: string }
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(userId)) throw ApiError.notFound('User')
    const rows = await sql`select u.id, u.email, u.created_at, u.email_verified_at,
      (select count(*)::int from org_members m where m.user_id=u.id) as organizations,
      (select count(*)::int from fleets f join org_members m on m.org_id=f.org_id where m.user_id=u.id) as fleets,
      (select count(*)::int from nodes n join fleets f on f.id=n.fleet_id join org_members m on m.org_id=f.org_id where m.user_id=u.id) as nodes,
      (select count(*)::int from services s join fleets f on f.id=s.fleet_id join org_members m on m.org_id=f.org_id where m.user_id=u.id) as services,
      (select count(*)::int from deployments d join services s on s.id=d.service_id join fleets f on f.id=s.fleet_id join org_members m on m.org_id=f.org_id where m.user_id=u.id) as deployments,
      (select country from auth_sessions a where a.user_id=u.id order by last_seen desc limit 1) as last_country,
      (select max(last_seen) from auth_sessions a where a.user_id=u.id) as last_seen
      from users u where u.id=${userId} limit 1`
    const row = rows[0]
    if (!row) throw ApiError.notFound('User')
    return { user: {
      id: row.id, email: row.email, createdAt: row.created_at, verified: row.email_verified_at != null,
      organizations: row.organizations, fleets: row.fleets, nodes: row.nodes, services: row.services,
      deployments: row.deployments, country: row.last_country ?? 'unknown', lastSeen: row.last_seen,
    } }
  })

  app.get('/ops/nodes', { preHandler: requirePlatformOperator }, async () => {
    const rows = await sql`select n.id, n.name, n.platform, n.agent_version, n.last_heartbeat_at,
      n.effective_cpu, n.effective_mem_bytes, f.name as fleet, o.name as organization,
      sample.disk_used_mb, sample.disk_total_mb, sample.net_rx_kbps, sample.net_tx_kbps
      from nodes n join fleets f on f.id=n.fleet_id join orgs o on o.id=f.org_id
      left join lateral (
        select disk_used_mb, disk_total_mb, net_rx_kbps, net_tx_kbps from node_samples
        where node_id=n.id order by at desc limit 1
      ) sample on true
      order by n.last_heartbeat_at desc nulls last limit 200`
    return { nodes: rows.map(({ id, name, platform, agent_version, last_heartbeat_at, effective_cpu, effective_mem_bytes, fleet, organization, disk_used_mb, disk_total_mb, net_rx_kbps, net_tx_kbps }) => ({
      id, name, platform, agentVersion: agent_version, lastHeartbeatAt: last_heartbeat_at,
      effectiveCpu: effective_cpu, effectiveMemBytes: effective_mem_bytes?.toString() ?? null,
      fleet, organization, country: null,
      diskUsedMb: disk_used_mb, diskTotalMb: disk_total_mb, netRxKbps: net_rx_kbps, netTxKbps: net_tx_kbps,
    })) }
  })
}
