import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../api/context.js'

const exec = promisify(execFile)
const BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity]
type Minute = { at: number; requests: number; errors: number; latency: number[] }
export class ApiMetrics {
  private minutes = new Map<number, Minute>()
  record(status: number, elapsed: number, now = Date.now()) {
    const at = Math.floor(now / 60_000) * 60_000
    const row = this.minutes.get(at) ?? { at, requests: 0, errors: 0, latency: BUCKETS.map(() => 0) }
    row.requests++
    if (status >= 500) row.errors++
    const bin = BUCKETS.findIndex((limit) => elapsed <= limit)
    row.latency[bin < 0 ? BUCKETS.length - 1 : bin]!++
    this.minutes.set(at, row)
    for (const key of this.minutes.keys()) if (key < at - 14 * 60_000) this.minutes.delete(key)
  }
  snapshot(now = Date.now()) {
    const rows = [...this.minutes.values()].filter((row) => row.at >= Math.floor(now / 60_000) * 60_000 - 14 * 60_000).sort((a, b) => a.at - b.at)
    const requests = rows.reduce((sum, row) => sum + row.requests, 0)
    const errors = rows.reduce((sum, row) => sum + row.errors, 0)
    let p95: number | null = null, seen = 0
    if (requests) for (let i = 0; i < BUCKETS.length; i++) {
      seen += rows.reduce((sum, row) => sum + row.latency[i]!, 0)
      if (seen >= Math.ceil(requests * .95)) { p95 = Number.isFinite(BUCKETS[i]) ? BUCKETS[i]! : null; break }
    }
    return { requests, errors, errorRate: requests ? errors / requests : null, p95UpperBoundMs: p95, windowMinutes: 15, minutes: rows.map(({ at, requests, errors }) => ({ at, requests, errors })) }
  }
}
const metrics = new WeakMap<AppContext, ApiMetrics>()
export function apiMetrics(ctx: AppContext) {
  let current = metrics.get(ctx)
  if (!current) { current = new ApiMetrics(); metrics.set(ctx, current) }
  return current
}
export function instrumentApi(app: FastifyInstance) {
  app.addHook('onResponse', async (req, reply) => {
    // Exclude monitoring and Ops traffic; store numbers, never URLs or identities.
    if (req.routeOptions.url?.startsWith('/ops/') || req.routeOptions.url === '/healthz') return
    apiMetrics(app.ctx).record(reply.statusCode, reply.elapsedTime)
  })
}

type RegistryMeasurement = { bytes: number | null; observedAt: string; status: 'measured' | 'unavailable' | 'not_configured' }
const registryCache = new WeakMap<AppContext, Promise<RegistryMeasurement>>()
const registryAt = new WeakMap<AppContext, number>()
async function registrySize(ctx: AppContext): Promise<RegistryMeasurement> {
  const old = registryCache.get(ctx)
  if (old && Date.now() - (registryAt.get(ctx) ?? 0) < 60_000) return old
  const pending = (async (): Promise<RegistryMeasurement> => {
    const observedAt = new Date().toISOString()
    if (!ctx.config.OPS_REGISTRY_STORAGE_PATH) return { bytes: null, observedAt, status: 'not_configured' }
    try {
      const { stdout } = await exec('du', ['-sk', '--', ctx.config.OPS_REGISTRY_STORAGE_PATH], { timeout: 8000, maxBuffer: 4096 })
      const kb = Number(stdout.trim().split(/\s+/)[0])
      if (!Number.isFinite(kb)) throw new Error('Invalid measurement')
      return { bytes: kb * 1024, observedAt, status: 'measured' }
    } catch { return { bytes: null, observedAt, status: 'unavailable' } }
  })()
  registryAt.set(ctx, Date.now()); registryCache.set(ctx, pending)
  return pending
}
function timed<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Collector timed out')), ms)
    promise.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
  })
}
export async function infrastructure(ctx: AppContext) {
  const [postgres, redis, registry, queues] = await Promise.all([
    ctx.sql`select pg_database_size(current_database())::text as bytes,
      (select count(*)::int from pg_stat_activity where datname=current_database()) as connections,
      (select count(*)::int from pg_stat_activity where datname=current_database() and state='active') as active_connections,
      current_setting('max_connections')::int as max_connections`,
    timed(ctx.redis.info('memory'), 3000).then((raw) => {
      const values = Object.fromEntries(raw.split(/\r?\n/).filter((line) => line.includes(':')).map((line) => line.split(':')))
      return { status: 'measured', usedBytes: Number(values.used_memory), maxBytes: Number(values.maxmemory) || null }
    }).catch(() => ({ status: 'unavailable', usedBytes: null, maxBytes: null })),
    registrySize(ctx),
    ctx.sql`select status, count(*)::int as count, min(created_at) as oldest from build_jobs where status in ('queued','assigned','running') group by status`,
  ])
  return { observedAt: new Date().toISOString(), revision: ctx.config.FLEET_REVISION, startedAt: ctx.startedAt,
    postgres: postgres[0], redis, registry, queues, api: apiMetrics(ctx).snapshot(),
    process: { rssBytes: process.memoryUsage().rss, uptimeSeconds: Math.floor(process.uptime()) } }
}
