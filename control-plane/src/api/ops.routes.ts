import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { platformOperators, users } from '../db/schema.js'
import { ApiError } from './errors.js'
import { requireUser } from './guards.js'

/** Platform access is independent of customer fleet membership. No HTTP grant route. */
async function requirePlatformOperator(req: FastifyRequest, reply: FastifyReply) {
  await requireUser(req, reply)
  const [operator] = await req.server.ctx.db.select({
    id: platformOperators.userId,
    verified: users.emailVerifiedAt,
    totp: users.totpSecret,
  }).from(platformOperators).innerJoin(users, eq(users.id, platformOperators.userId))
    .where(eq(platformOperators.userId, req.userId!)).limit(1)
  if (!operator?.verified || !operator.totp) throw ApiError.forbidden('Platform operations requires a verified operator account with 2FA')
}

export async function opsRoutes(app: FastifyInstance) {
  const sql = app.ctx.sql
  app.get('/ops/me', { preHandler: requirePlatformOperator }, async (req) => ({ operator: true, userId: req.userId }))

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
    const query = req.query as { q?: string; page?: string }
    const q = (query.q ?? '').trim().slice(0, 100)
    const page = Math.min(1000, Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1))
    const rows = await sql`select u.id, u.email, u.created_at, u.email_verified_at,
      (select count(*)::int from org_members m where m.user_id=u.id) as organizations,
      (select country from auth_sessions a where a.user_id=u.id order by last_seen desc limit 1) as last_country,
      (select max(last_seen) from auth_sessions a where a.user_id=u.id) as last_seen
      from users u where ${q === ''} or u.email ilike ${'%' + q + '%'}
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
