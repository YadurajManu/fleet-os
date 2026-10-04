import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiMetrics } from '../src/ops/metrics.js'
import { parseAnalysis } from '../src/ops/analysis.js'

test('API metrics bound retention, count server errors and disclose histogram bounds', () => {
  const metrics = new ApiMetrics()
  const now = 1_800_000
  metrics.record(500, 900, now - 15 * 60_000)
  for (let i = 0; i < 19; i++) metrics.record(200, 12, now)
  metrics.record(503, 400, now)
  const result = metrics.snapshot(now)
  assert.equal(result.requests, 20)
  assert.equal(result.errors, 1)
  assert.equal(result.errorRate, .05)
  assert.equal(result.p95UpperBoundMs, 25)
  assert.equal(result.minutes.length, 1)
  assert.equal(metrics.snapshot(now + 15 * 60_000).requests, 0)
  assert.equal(metrics.snapshot(now + 15 * 60_000).errorRate, null)
})

test('AI analysis must cite supplied evidence and rejects invented citations', () => {
  const answer = { summary: 'Agent heartbeat is stale.', hypotheses: [{ claim: 'Connectivity may be unavailable.', evidenceIds: ['node'] }], checks: ['Check the heartbeat timestamp.'], uncertainty: 'The network cause is not recorded.' }
  assert.equal(parseAnalysis(JSON.stringify(answer), ['node']).hypotheses.length, 1)
  assert.throws(() => parseAnalysis(JSON.stringify(answer), ['deployment']), /Unknown evidence/)
  assert.throws(() => parseAnalysis('{"summary":"ok"}', ['node']))
})
