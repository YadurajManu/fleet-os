import { readFile } from 'node:fs/promises'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { startProber, probes, intervalMs, type Observation } from './probes.js'
import { writeSnapshot } from './public.js'
import { transition, worst, type State } from './engine.js'

type Batch = { id: string; observations: Observation[] }
const catalog: Record<string, string> = { api: 'Control plane API', postgres: 'Postgres', redis: 'Redis', registry: 'Registry storage', ingress: 'Ingress (Caddy)', tunnel: 'Tunnel gateway', build: 'Build pipeline', scheduler: 'Scheduler', logs: 'Log streaming', 'github-app': 'GitHub App & webhooks', 'cli-auth': 'CLI authentication', website: 'Website', docs: 'Docs', dashboard: 'Dashboard' }
const hmac = (key: string | Buffer, input: string) => createHmac('sha256', key).update(input).digest()
export async function publishSnapshot(body: string) {
  if (process.env.STATUS_PUBLISH_URL) {
    const response = await fetch(process.env.STATUS_PUBLISH_URL, { method: 'PUT', body, headers: { 'content-type': 'application/json', ...(process.env.STATUS_PUBLISH_TOKEN ? { authorization: `Bearer ${process.env.STATUS_PUBLISH_TOKEN}` } : {}) }, signal: AbortSignal.timeout(5000), redirect: 'error' })
    if (!response.ok) throw Error('Snapshot publish failed')
  }
  if (process.env.STATUS_S3_URL) {
    const url = new URL(process.env.STATUS_S3_URL); const region = process.env.STATUS_S3_REGION ?? 'us-east-1'
    const access = process.env.STATUS_S3_ACCESS_KEY; const secret = process.env.STATUS_S3_SECRET_KEY
    if (!access || !secret || url.protocol !== 'https:' || url.search) throw Error('Invalid S3 snapshot configuration')
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); const day = date.slice(0, 8)
    const hash = (s: string) => createHash('sha256').update(s).digest('hex')
    const payload = hash(body); const scope = `${day}/${region}/s3/aws4_request`
    const canonical = `PUT\n${url.pathname}\n\nhost:${url.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n\nhost;x-amz-content-sha256;x-amz-date\n${payload}`
    const key = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request')
    const signature = createHmac('sha256', key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).digest('hex')
    const response = await fetch(url, { method: 'PUT', body, headers: { 'x-amz-date': date, 'x-amz-content-sha256': payload, 'content-type': 'application/json', authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}` }, signal: AbortSignal.timeout(5000), redirect: 'error' })
    if (!response.ok) throw Error('S3 snapshot publish failed')
  }
}
export async function standalone() {
  const queuePath = process.env.STATUS_QUEUE_PATH ?? '/tmp/fleet-status-queue.json'
  const path = process.env.STATUS_PUBLISH_PATH ?? '/tmp/status.json'
  let queue: Batch[] = []
  try { queue = JSON.parse(await readFile(queuePath, 'utf8')) } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
  const states = new Map<string, State>(); const latest = new Map<string, Observation>(); const since = new Date().toISOString()
  let serial = Promise.resolve()
  const enqueue = (readings: Observation[]) => {
    serial = serial.then(async () => {
      if (queue.length >= 10000) throw Error('Standalone queue full; restore ingest connectivity')
      queue.push({ id: randomUUID(), observations: readings }); await writeSnapshot(queue, queuePath)
      for (const r of readings) { latest.set(r.component, r); states.set(r.component, transition(states.get(r.component) ?? { status: 'unknown', failures: 0, successes: 0, degraded_since: null }, r.ok, (r.latency_ms ?? 0) > 1000, Date.parse(r.ts))) }
    }).catch(() => console.error('Standalone queue write failed'))
    return serial
  }
  for (const batch of queue) for (const r of batch.observations) { latest.set(r.component, r); states.set(r.component, transition(states.get(r.component) ?? { status: 'unknown', failures: 0, successes: 0, degraded_since: null }, r.ok, false, Date.parse(r.ts))) }
  let busy = false
  const flush = async () => {
    if (busy) return; busy = true
    try {
      await serial
      if (process.env.STATUS_INGEST_URL && process.env.STATUS_INGEST_TOKEN) {
        while (queue.length) {
          const batch = queue[0]!
          const response = await fetch(process.env.STATUS_INGEST_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.STATUS_INGEST_TOKEN}` }, body: JSON.stringify(batch), signal: AbortSignal.timeout(5000), redirect: 'error' })
          if (!response.ok) break
          queue.shift(); await writeSnapshot(queue, queuePath)
        }
      }
    } catch { console.error('Standalone ingest unreachable; retaining queue') }
    finally {
      const components = Object.entries(catalog).map(([slug, name]) => { const reading = latest.get(slug); const status = !reading || Date.now() - Date.parse(reading.ts) > 2 * (['build','scheduler'].includes(slug) ? 900000 : intervalMs()) ? 'unknown' : states.get(slug)!.status; return { slug, name, status, checked_at: reading?.ts ?? null, monitoring_since: since, ticks: [], uptime: null, checks: null, group: 'Platform', description: '' } })
      const snapshot = { status: worst(components.map(c => c.status)), stale: false, as_of: new Date().toISOString(), monitoring_since: since, components, incidents: [], maintenance: [] }
      try { await writeSnapshot(snapshot, path); await publishSnapshot(JSON.stringify(snapshot)) } catch { console.error('Standalone snapshot publish failed') }
      busy = false
    }
  }
  const stop = startProber(probes(), enqueue, flush)
  const keepAlive = setInterval(() => {}, 60000)
  return async () => { stop(); clearInterval(keepAlive); await serial; await flush() }
}
