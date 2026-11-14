import type { FastifyInstance } from 'fastify'
import { requireUser } from '../api/guards.js'
import { ApiError } from '../api/errors.js'

export async function fleetHealthRoutes(app: FastifyInstance) {
  const ctx = app.ctx
  const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }
  app.addHook('preHandler', requireUser)
  app.addHook('onSend', async (_req, reply) => { reply.header('cache-control','private, no-store') })
  app.get('/nodes', async req => {
    const rows = await ctx.sql`select distinct n.id,n.name,n.status,n.last_heartbeat_at,n.agent_version,n.arch,n.ram_mb,n.cpu_cores,n.effective_cpu,n.effective_mem_bytes
      from nodes n join fleets f on f.id=n.fleet_id join org_members m on m.org_id=f.org_id where m.user_id=${req.userId!}`
    const nodes = await Promise.all(rows.map(async n => {
      const telemetry = await ctx.heartbeats.last(n.id)
      const [reserved] = await ctx.sql`select coalesce(sum(cpu),0) cpu,coalesce(sum(mem),0) mem from (
        select s.request_cpu::real cpu,s.request_ram_mb*1048576::bigint mem from deployments d join services s on s.id=d.service_id where d.node_id=${n.id} and d.status in ('running','scheduling','deploying')
        union all select reserved_cpu,reserved_mem_bytes from build_jobs where builder_node_id=${n.id} and status in ('assigned','running') and lease_expires_at>now()
        union all select reserved_cpu,reserved_mem_bytes from task_reservations where node_id=${n.id} and expires_at>now()) reservations`
      const live = Boolean(telemetry && Date.now() - telemetry.at < ctx.heartbeats.downAfterMs())
      return { id: n.id, name: n.name, online: live, connection_state: ctx.tunnels.has(n.id) ? 'connected' : 'disconnected', last_heartbeat: n.last_heartbeat_at, agent_version: n.agent_version, arch: n.arch, telemetry: live ? telemetry : null, measurement_age_ms: telemetry ? Date.now() - telemetry.at : null, tunnel_rtt_ms: telemetry?.tunnelRttMs ?? null,
        scheduler_headroom: { cpu: Math.max(0, Number(n.effective_cpu ?? n.cpu_cores) - Number(reserved!.cpu)), memory_bytes: Math.max(0, Number(n.effective_mem_bytes ?? Number(n.ram_mb)*1048576) - Number(reserved!.mem)) } }
    }))
    return { nodes }
  })
  app.get('/nodes/:id/history', { schema: { params: idParams, querystring: { type: 'object', properties: { hours: { type: 'integer', minimum: 1, maximum: 720, default: 24 } }, additionalProperties: false } } }, async req => {
    const id = (req.params as { id: string }).id
    const authorized = await ctx.sql`select 1 from nodes n join fleets f on f.id=n.fleet_id join org_members m on m.org_id=f.org_id where n.id=${id} and m.user_id=${req.userId!}`
    if (!authorized.length) throw ApiError.notFound('Node')
    const hours = (req.query as { hours?: number }).hours ?? 24
    const samples = await ctx.sql`select at,cpu_pct,ram_used_mb,disk_used_mb,disk_total_mb,docker_ok from node_samples where node_id=${id} and at>=${new Date(Date.now()-hours*3600000).toISOString()} order by at limit 5000`
    return { samples: [...samples], uptime: null, note: 'Resource samples are not a complete heartbeat uptime ledger; gaps are unknown.' }
  })
  app.get('/services', async req => {
    const rows = await ctx.sql`select distinct s.id,s.name,s.project,s.fleet_id,d.status,d.git_sha,d.node_id,d.id as deployment_id,d.started_at,d.finished_at from services s join fleets f on f.id=s.fleet_id join org_members m on m.org_id=f.org_id left join lateral(select * from deployments where service_id=s.id order by started_at desc limit 1)d on true where m.user_id=${req.userId!}`
    return { services: await Promise.all(rows.map(async s => {
      const hb = s.node_id ? await ctx.heartbeats.last(s.node_id) : null
      const container = hb?.containers.find(c => c.deployment_id === s.deployment_id)
      return { ...s, restarts: container?.restarts ?? null, health_check: container?.health ?? null, external_reachability: null, cert_expires_at: null, telemetry_age_ms: hb ? Date.now()-hb.at : null }
    })) }
  })
  app.get('/failovers', async req => ({ failovers: [...await ctx.sql`select distinct e.id,e.service_id,e.from_node_id,e.to_node_id,e.created_at,e.reason from placement_events e join services s on s.id=e.service_id join fleets f on f.id=s.fleet_id join org_members m on m.org_id=f.org_id where m.user_id=${req.userId!} and e.reason='failover' order by e.created_at desc limit 100`] }))
  app.get('/deploys/:id/timing', { schema: { params: idParams } }, async req => {
    const id = (req.params as { id: string }).id
    const [d] = await ctx.sql`select d.id,d.started_at,d.activated_at,d.finished_at from deployments d join services s on s.id=d.service_id join fleets f on f.id=s.fleet_id join org_members m on m.org_id=f.org_id where d.id=${id} and m.user_id=${req.userId!} limit 1`
    if (!d) throw ApiError.notFound('Deployment')
    const [build] = await ctx.sql`select min(started_at) started,max(finished_at) finished from build_jobs where deployment_id=${id}`
    return { id: d.id, started_at: d.started_at, finished_at: d.finished_at, clone_ms: null, build_ms: build?.started && build?.finished ? new Date(build.finished).getTime()-new Date(build.started).getTime() : null, push_ms: null, pull_ms: null, start_ms: null, total_ms: d.activated_at ? new Date(d.activated_at).getTime()-new Date(d.started_at).getTime() : null }
  })
}
