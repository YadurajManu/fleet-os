import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultRange, formatUptime, monthGroups, staleSnapshot, statusColor } from '../src/lib/status.js'
test('history chooses longest range with at least half measured coverage', () => {
  assert.equal(defaultRange({ '90d': { coverage: .49 }, '30d': { coverage: .5 }, '7d': { coverage: 1 } }), '30d')
  assert.equal(defaultRange({}), '24h')
  assert.equal(formatUptime(0), '0.00%'); assert.equal(formatUptime(null), '—')
})
test('stale snapshots keep timestamps and history while component states become unknown', () => {
  const original = { as_of: '2026-11-14T00:00:00Z', status: 'major_outage', components: [{ slug: 'api', status: 'major_outage', ticks: [{ checks: 4 }] }] }
  const stale = staleSnapshot(original, Date.parse('2026-11-14T00:02:00Z'))
  assert.equal(stale.status, 'unknown'); assert.equal(stale.stale, true); assert.equal(stale.components[0].status, 'unknown')
  assert.equal(stale.as_of, original.as_of); assert.deepEqual(stale.components[0].ticks, original.components[0].ticks)
  assert.equal(statusColor('unknown'), statusColor('maintenance')); assert.notEqual(statusColor('unknown'), statusColor('major_outage'))
  assert.equal(staleSnapshot({ ...original, stale:true }, Date.parse(original.as_of)).components[0].status,'unknown')
  assert.equal(staleSnapshot({ ...original, as_of:'invalid' }).stale,true)
})
test('history groups incidents into months in descending date order', () => {
  const groups = monthGroups([{ id: 'old', started_at: '2026-09-01' }, { id: 'new', started_at: '2026-11-14' }])
  assert.deepEqual(groups.map(([month]) => month), ['2026-11','2026-09'])
})
