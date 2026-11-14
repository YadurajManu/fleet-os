import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshot } from '../src/status/public.js'
import type { AppContext } from '../src/api/context.js'
test('database outage preserves last-good time and neutralizes all component states', async () => {
  const saved = { status: 'operational', stale: false, as_of: '2026-11-01T00:00:00.000Z', monitoring_since: null, components: [{ slug: 'api', name: 'Control plane API', status: 'operational', ticks: [] }], incidents: [], maintenance: [] }
  const ctx = { sql: () => { throw Error('private-internal-database-address') }, redis: { get: async (key: string) => key === 'status:v1:last-good' ? JSON.stringify(saved) : null } } as unknown as AppContext
  const result = await snapshot(ctx)
  assert.equal(result.stale, true); assert.equal(result.status, 'unknown'); assert.equal(result.as_of, saved.as_of)
  assert.ok(result.components.every(c => c.status === 'unknown'))
  assert.equal(JSON.stringify(result).includes('private-internal'), false)
})
