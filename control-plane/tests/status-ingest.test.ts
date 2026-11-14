import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildServer } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { createContext, closeContext } from '../src/api/context.js'
test('standalone ingest requires its credential, sanitizes errors and deduplicates retries', async () => {
  const ctx = createContext({ ...loadConfig(), NODE_ENV: 'test' }); const app = await buildServer(ctx)
  const previous = process.env.STATUS_INGEST_TOKEN; process.env.STATUS_INGEST_TOKEN = 'dedicated-canary-test-token-at-least-32-characters'
  try {
    const ts = new Date().toISOString(); const payload = { id: randomUUID(), observations: [{ component: 'website', ts, ok: false, latency_ms: 3, status_code: 500, error: 'private-customer.example' }] }
    const input = { method: 'POST' as const, url: '/v1/status/ingest', payload }
    assert.equal((await app.inject(input)).statusCode, 401)
    const headers = { authorization: `Bearer ${process.env.STATUS_INGEST_TOKEN}` }
    assert.equal((await app.inject({ ...input, headers })).statusCode, 202)
    assert.equal((await app.inject({ ...input, headers })).statusCode, 202)
    const rows = await ctx.sql`select error from status_checks where component_id='website' and ts=${ts}`
    assert.equal(rows.length, 1); assert.equal(rows[0]!.error, 'Health check failed or timed out.')
  } finally { if (previous) process.env.STATUS_INGEST_TOKEN = previous; else delete process.env.STATUS_INGEST_TOKEN; await app.close(); await closeContext(ctx) }
})
