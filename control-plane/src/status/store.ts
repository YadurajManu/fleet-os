import type { AppContext } from '../api/context.js'
import type { Observation } from './probes.js'

export async function recordChecks(ctx: AppContext, readings: Observation[]) {
  for (const r of readings) await ctx.sql`insert into status_checks(component_id,ts,ok,latency_ms,status_code,error,metrics)
    values (${r.component},${r.ts},${r.ok},${r.latency_ms},${r.status_code},${r.error},${JSON.stringify(r.metrics ?? {})}::jsonb)`
}
export async function heartbeat(ctx: AppContext) {
  await ctx.sql`insert into status_prober_heartbeat(id,at) values ('primary',now()) on conflict(id) do update set at=excluded.at`
}
