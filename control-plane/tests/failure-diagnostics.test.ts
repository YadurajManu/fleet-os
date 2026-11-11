import test from 'node:test'
import assert from 'node:assert/strict'
import type { AppContext } from '../src/api/context.js'
import { retainedBuildLogs } from '../src/api/service-logs.js'
import { describeRecordedFailure } from '../src/ai/explain.js'

test('retained build logs are chronological and belong to the requested service and attempt', async () => {
  const row = (text: string, deploymentId: string, at: number, serviceId = 'service') => JSON.stringify({ serviceId, service: 'web', deploymentId, nodeId: 'builder', text, at })
  const raw = [row('last', 'new', 3), row('foreign service', 'new', 2, 'other'), row('old attempt', 'old', 1), 'invalid JSON', JSON.stringify({ text: 42 }), row('first', 'new', 0)]
  const ctx = { redis: { lrange: async (key: string, start: number, end: number) => {
    assert.equal(key, 'build:logs:service')
    assert.equal(start, 0)
    assert.equal(end, 199)
    return [...raw]
  } } } as unknown as AppContext
  assert.deepEqual((await retainedBuildLogs(ctx, 'service', 'new')).map(row => row.text), ['first', 'last'])
})

test('missing or expired build logs do not hide the recorded failure', async () => {
  const ctx = { redis: { lrange: async () => { throw new Error('unavailable') } } } as unknown as AppContext
  assert.deepEqual(await retainedBuildLogs(ctx, 'service', 'deployment'), [])
  const reason = describeRecordedFailure('web', 'cannot monitor build disk usage: exit status 1', 'failed')
  assert.match(reason, /exit status 1/)
  assert.match(reason, /BuildKit/)
  assert.match(reason, /fleet logs web/)
  assert.doesNotMatch(reason, /already the whole reason|there is no log/)
})

test('short reconcile errors get evidence and actionable advice without a provider', () => {
  const reason = describeRecordedFailure('db', 'pull: invalid reference format', 'deploying')
  assert.match(reason, /still retrying/)
  assert.match(reason, /pull: invalid reference format/)
  assert.match(reason, /repository, tag or digest/)
})
