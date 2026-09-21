import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logChannel, publishLog } from '../src/api/log-stream.js'

const fleetA = '11111111-1111-4111-8111-111111111111'
const fleetB = '22222222-2222-4222-8222-222222222222'
const serviceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const serviceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

test('runtime log channels are isolated by fleet and service ID, not display name', async () => {
  assert.notEqual(logChannel(fleetA, serviceA), logChannel(fleetB, serviceA))
  assert.notEqual(logChannel(fleetA, serviceA), logChannel(fleetA, serviceB))

  const published: Array<{ channel: string; body: string }> = []
  const redis = { publish: async (channel: string, body: string) => { published.push({ channel, body }) } }
  await publishLog(redis as never, fleetA, serviceA, {
    service: 'api', serviceId: serviceA, nodeId: 'node-a', text: 'fleet A only',
  })
  await publishLog(redis as never, fleetB, serviceA, {
    service: 'api', serviceId: serviceA, nodeId: 'node-b', text: 'fleet B only',
  })

  assert.deepEqual(published.map((entry) => entry.channel), [
    logChannel(fleetA, serviceA),
    logChannel(fleetB, serviceA),
  ])
  assert.equal(JSON.parse(published[0]!.body).text, 'fleet A only')
})
