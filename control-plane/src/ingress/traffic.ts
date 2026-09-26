import type { Redis } from 'ioredis'

const MINUTE_MS = 60_000
const TTL_SEC = 48 * 60 * 60
const keyFor = (fleetId: string, minute: number) => `traffic:${fleetId}:${minute}`

/** Completed ingress requests only. No URLs, IP addresses, or request bodies are stored. */
export async function recordTraffic(redis: Redis, fleetId: string, status: number, durationMs: number, now = Date.now()) {
  const key = keyFor(fleetId, Math.floor(now / MINUTE_MS))
  const error = status >= 500 ? 1 : 0
  await redis.multi()
    .hincrby(key, 'requests', 1)
    .hincrby(key, 'errors', error)
    .hincrby(key, 'duration_ms', Math.max(0, Math.round(durationMs)))
    .expire(key, TTL_SEC)
    .exec()
  // ponytail: one Redis transaction per response; batch if measured ingress throughput makes this costly.
}

export async function trafficForFleet(redis: Redis, fleetId: string, minutes = 60, now = Date.now()) {
  const end = Math.floor(now / MINUTE_MS)
  const pipe = redis.pipeline()
  for (let minute = end - minutes + 1; minute <= end; minute++) pipe.hgetall(keyFor(fleetId, minute))
  const rows = await pipe.exec()
  if (!rows) throw new Error('Traffic metrics unavailable')
  let totalDurationMs = 0
  const series = rows.map(([err, raw], index) => {
    if (err) throw err
    const bucket = raw as Record<string, string>
    const requests = Number(bucket.requests ?? 0)
    const errors = Number(bucket.errors ?? 0)
    const durationMs = Number(bucket.duration_ms ?? 0)
    totalDurationMs += durationMs
    return { at: new Date((end - minutes + 1 + index) * MINUTE_MS).toISOString(), requests, errors, meanMs: requests ? Math.round(durationMs / requests) : null }
  })
  const requests = series.reduce((sum, point) => sum + point.requests, 0)
  const errors = series.reduce((sum, point) => sum + point.errors, 0)
  return { requests, errors, meanMs: requests ? Math.round(totalDurationMs / requests) : null, series }
}
