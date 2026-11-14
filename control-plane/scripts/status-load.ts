import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'
import { createContext, closeContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
const cfg = loadConfig()
if (!['localhost','127.0.0.1'].includes(new URL(cfg.DATABASE_URL).hostname)) throw Error('Local database required')
const ctx = createContext({ ...cfg, NODE_ENV: 'test' }); const app = await buildServer(ctx)
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); await fetch(address + '/v1/status')
  const values: number[] = []; let failures = 0; const requests: Promise<void>[] = []
  for (let second = 0; second < 100; second++) {
    const before = performance.now()
    for (let i = 0; i < 20; i++) requests.push((async () => { const start = performance.now(); const r = await fetch(address + '/v1/status'); await r.arrayBuffer(); if (!r.ok) failures++; values.push(performance.now()-start) })())
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 100-(performance.now()-before))))
  }
  await Promise.all(requests); values.sort((a,b) => a-b)
  const p95 = values[Math.floor(values.length*.95)]!
  console.log(JSON.stringify({ requests: values.length, offered_rps: 200, duration_s: 10, failures, p95_ms: p95 }))
  assert.equal(failures, 0); assert.ok(p95<50, `p95 ${p95}ms exceeds 50ms`)
} finally { await app.close(); await closeContext(ctx) }
