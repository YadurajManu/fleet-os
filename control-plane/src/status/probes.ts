import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { access, statfs } from 'node:fs/promises'
import { connect } from 'node:tls'
import WebSocket from 'ws'
import type { AppContext } from '../api/context.js'

export type Observation = { component: string; ts: string; ok: boolean | null; latency_ms: number | null; status_code: number | null; error: string | null; metrics?: Record<string, number> }
export type Probe = { component: string; interval: number; run: (signal: AbortSignal) => Promise<{ status_code?: number; metrics?: Record<string, number> } | void> }
export const intervalMs = () => Math.max(5, Number(process.env.PROBE_INTERVAL_S) || 30) * 1000
export const timeoutMs = () => Math.max(100, Number(process.env.PROBE_TIMEOUT_MS) || 5000)
export const enabled = (name: string) => process.env[`PROBE_${name.toUpperCase().replaceAll('-', '_')}_ENABLED`] === 'true'

async function http(url: string, signal: AbortSignal, token?: string) {
  const response = await fetch(url, { signal, headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: 'error' })
  await response.body?.cancel()
  if (!response.ok) throw new Error('HTTP check failed')
  return { status_code: response.status }
}

export function probes(ctx?: AppContext): Probe[] {
  const normal = intervalMs()
  const list: Probe[] = []
  const add = (component: string, run: Probe['run'], interval = normal) => list.push({ component, run, interval })
  if (ctx) {
    add('postgres', async () => { await ctx.sql`select 1`; const [pool] = await ctx.sql`select count(*)::int active from pg_stat_activity where datname=current_database()`; return { metrics: { pool_connections: Number(pool!.active) } } })
    add('redis', async signal => {
      await ctx.redis.ping()
      const subscriber = ctx.redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: 1 })
      const channel = `status-canary:${randomUUID()}`
      try {
        await subscriber.connect(); await subscriber.subscribe(channel)
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new Error('Redis round trip timed out'))
          signal.addEventListener('abort', abort, { once: true })
          subscriber.once('message', () => { signal.removeEventListener('abort', abort); resolve() })
          void ctx.redis.publish(channel, 'check').catch(reject)
        })
      } finally { subscriber.disconnect() }
    })
    if (ctx.config.OPS_REGISTRY_STORAGE_PATH) add('registry', async () => {
      await access(ctx.config.OPS_REGISTRY_STORAGE_PATH!)
      const fs = await statfs(ctx.config.OPS_REGISTRY_STORAGE_PATH!)
      return { metrics: { disk_free_percent: fs.bavail / fs.blocks * 100 } }
    })
  }
  const urls: Record<string, string | undefined> = {
    api: process.env.PROBE_API_URL, registry: process.env.PROBE_REGISTRY_URL,
    website: process.env.PROBE_WEBSITE_URL, docs: process.env.PROBE_DOCS_URL, dashboard: process.env.PROBE_DASHBOARD_URL,
    'cli-auth': process.env.PROBE_CLI_AUTH_URL,
    github: enabled('third-party') ? 'https://api.github.com' : undefined,
    npm: enabled('third-party') ? 'https://registry.npmjs.org' : undefined,
    'docker-hub': enabled('third-party') ? 'https://hub.docker.com/v2/' : undefined,
  }
  for (const [id, url] of Object.entries(urls)) if (url) add(id, async signal => {
    const result = await http(url, signal)
    if (id === 'api' && process.env.PROBE_API_CANARY_URL && process.env.PROBE_API_CANARY_TOKEN) await http(process.env.PROBE_API_CANARY_URL, signal, process.env.PROBE_API_CANARY_TOKEN)
    return result
  })
  if (enabled('ingress') && process.env.PROBE_INGRESS_URL) add('ingress', async signal => {
    const result = await http(process.env.PROBE_INGRESS_URL!, signal)
    const url = new URL(process.env.PROBE_INGRESS_URL!)
    const days = await new Promise<number>((resolve, reject) => {
      const socket = connect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname }, () => {
        const remaining = (Date.parse(socket.getPeerCertificate().valid_to) - Date.now()) / 86400000
        socket.end(); remaining > 0 ? resolve(remaining) : reject(new Error('TLS expired'))
      }); signal.addEventListener('abort', () => { socket.destroy(); reject(new Error('TLS timeout')) }, { once: true }); socket.once('error', reject)
    })
    return { ...result, metrics: { tls_days_left: days } }
  })
  if (enabled('tunnel') && process.env.PROBE_TUNNEL_URL && process.env.PROBE_TUNNEL_TOKEN) add('tunnel', signal => new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(process.env.PROBE_TUNNEL_URL!, { headers: { authorization: `Bearer ${process.env.PROBE_TUNNEL_TOKEN}` }, handshakeTimeout: timeoutMs() })
    signal.addEventListener('abort', () => socket.terminate(), { once: true })
    socket.once('open', () => { socket.close(); resolve() }); socket.once('error', reject)
  }))
  for (const name of ['build', 'scheduler']) if (enabled(name) && process.env[`PROBE_${name.toUpperCase()}_URL`]) add(name, signal => http(process.env[`PROBE_${name.toUpperCase()}_URL`]!, signal, process.env.PROBE_CANARY_TOKEN), 900000)
  if (enabled('logs') && process.env.PROBE_LOGS_URL) add('logs', async signal => {
    const response = await fetch(process.env.PROBE_LOGS_URL!, { signal, headers: { authorization: `Bearer ${process.env.PROBE_CANARY_TOKEN ?? ''}` } })
    if (!response.ok || !response.body) throw new Error('SSE connection failed')
    const reader = response.body.getReader()
    try { for (let text = ''; ;) { const chunk = await reader.read(); if (chunk.done) throw new Error('SSE ended without an event'); text += new TextDecoder().decode(chunk.value); if (/data:.*\n/.test(text)) break } } finally { await reader.cancel() }
  })
  if (enabled('github-app') && process.env.PROBE_GITHUB_APP_URL) add('github-app', signal => http(process.env.PROBE_GITHUB_APP_URL!, signal, process.env.PROBE_CANARY_TOKEN))
  return list
}

export async function observe(probe: Probe): Promise<Observation> {
  const start = performance.now(); const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([probe.run(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, timeoutMs()) })])
    return { component: probe.component, ts: new Date().toISOString(), ok: true, latency_ms: performance.now() - start, status_code: result?.status_code ?? null, error: null, ...(result?.metrics ? { metrics: result.metrics } : {}) }
  } catch {
    // Probe exceptions may contain private endpoints, credentials or database errors.
    return { component: probe.component, ts: new Date().toISOString(), ok: false, latency_ms: performance.now() - start, status_code: null, error: 'Health check failed or timed out.' }
  } finally { if (timer) clearTimeout(timer); controller.abort() }
}

export function startProber(list: Probe[], record: (observations: Observation[]) => Promise<void>, heartbeat: () => Promise<void>) {
  let stopped = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const schedule = (fn: () => Promise<void>, delay: number) => { const timer = setTimeout(() => { timers.delete(timer); if (!stopped) void fn().catch(() => {}) }, delay); timers.add(timer); timer.unref() }
  for (const probe of list) {
    const tick = async () => { try { await record([await observe(probe)]) } finally { if (!stopped) schedule(tick, probe.interval) } }
    schedule(tick, Math.random() * Math.min(probe.interval, intervalMs()))
  }
  const beat = async () => { try { await heartbeat() } finally { if (!stopped) schedule(beat, intervalMs()) } }
  schedule(beat, 0)
  return () => { stopped = true; for (const timer of timers) clearTimeout(timer) }
}
