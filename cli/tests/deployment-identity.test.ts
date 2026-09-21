import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { waitForRunning } from '../src/deploy-wait.js'

test('a running old deployment cannot satisfy the requested deployment, including failed builds', async () => {
  let requested = 0
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url!)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/services/service/deployments/new') {
      requested++
      res.end(JSON.stringify({ deployment: { id: 'new', status: requested < 3 ? 'building' : 'failed', failureReason: 'broken Dockerfile', startedAt: new Date().toISOString(), gitSha: null }, progress: null }))
    } else res.end(JSON.stringify({ services: [{ id: 'service', current: { status: 'running' } }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const previous = { api: process.env.FLEET_API, token: process.env.FLEET_TOKEN }
  process.env.FLEET_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.FLEET_TOKEN = 'test-only'
  try {
    const statuses: string[] = []
    const result = await waitForRunning('fleet', 'service', { deploymentId: 'new', pollMs: 1, timeoutMs: 1000, onProgress: p => { statuses.push(p.status) } })
    assert.deepEqual(result, { state: 'failed', reason: 'broken Dockerfile' })
    assert.ok(paths.every(path => path === '/services/service/deployments/new'))
    assert.deepEqual(statuses, ['building', 'building', 'failed'])
  } finally {
    if (previous.api === undefined) delete process.env.FLEET_API; else process.env.FLEET_API = previous.api
    if (previous.token === undefined) delete process.env.FLEET_TOKEN; else process.env.FLEET_TOKEN = previous.token
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
