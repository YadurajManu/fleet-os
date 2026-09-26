import test from 'node:test'
import assert from 'node:assert/strict'
import type { Redis } from 'ioredis'
import { recordTraffic, trafficForFleet } from '../src/ingress/traffic.js'

test('ingress metrics stay fleet-scoped and compute a request-weighted mean', async () => {
  const hashes = new Map<string, Record<string, string>>()
  const redis = {
    multi() {
      const writes: (() => void)[] = []
      const tx = {
        hincrby(key: string, field: string, amount: number) {
          writes.push(() => { const bucket = hashes.get(key) ?? {}; bucket[field] = String(Number(bucket[field] ?? 0) + amount); hashes.set(key, bucket) })
          return tx
        },
        expire() { return tx },
        async exec() { writes.forEach(write => write()); return [] },
      }
      return tx
    },
    pipeline() {
      const keys: string[] = []
      const pipe = { hgetall(key: string) { keys.push(key); return pipe }, async exec() { return keys.map(key => [null, hashes.get(key) ?? {}]) } }
      return pipe
    },
  } as unknown as Redis
  const at = 1_800_000
  await recordTraffic(redis, 'fleet-a', 200, 10, at)
  await recordTraffic(redis, 'fleet-a', 503, 41, at)
  await recordTraffic(redis, 'fleet-b', 200, 1000, at)
  assert.deepEqual((await trafficForFleet(redis, 'fleet-a', 1, at)), {
    requests: 2, errors: 1, meanMs: 26,
    series: [{ at: new Date(at).toISOString(), requests: 2, errors: 1, meanMs: 26 }],
  })
  assert.equal((await trafficForFleet(redis, 'fleet-b', 1, at)).requests, 1)
})
