import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transition, uptime, worst, type State } from '../src/status/engine.js'
const initial: State = { status: 'operational', failures: 0, successes: 0, degraded_since: null }
test('outage hysteresis requires two failures, escalates at three, and three good probes recover', () => {
  let s = transition(initial, false, false, 0)
  assert.equal(s.status, 'operational')
  s = transition(s, false, false, 1); assert.equal(s.status, 'partial_outage')
  s = transition(s, false, false, 2); assert.equal(s.status, 'major_outage')
  s = transition(s, true, false, 3); assert.equal(s.status, 'major_outage')
  s = transition(s, false, false, 4); assert.equal(s.status, 'major_outage')
  for (let i = 0; i < 3; i++) s = transition(s, true, false, 5 + i)
  assert.equal(s.status, 'operational')
})
test('sustained degradation, maintenance and unknown remain distinct from outages', () => {
  const s = transition(initial, true, true, 1000)
  assert.equal(transition(s, true, true, 301000).status, 'degraded')
  assert.equal(transition(s, false, false, 2000, true).status, 'maintenance')
  assert.equal(transition(s, null, false, 2000).status, 'unknown')
  assert.equal(worst(['unknown', 'operational']), 'unknown')
  assert.equal(uptime(0, 0), null); assert.equal(uptime(4, 3), 75)
})
