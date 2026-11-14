import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observe } from '../src/status/probes.js'
test('probe exceptions become sanitized failed observations', async () => {
  const result = await observe({ component: 'api', interval: 30, run: async () => { throw Error('secret://private-customer-host') } })
  assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('private-customer'), false)
})
test('probe deadline bounds even a non-cooperative probe', async () => {
  process.env.PROBE_TIMEOUT_MS = '100'
  const start = Date.now()
  const result = await observe({ component: 'api', interval: 30, run: () => new Promise(() => {}) })
  assert.equal(result.ok, false); assert.ok(Date.now() - start < 500)
  delete process.env.PROBE_TIMEOUT_MS
})
