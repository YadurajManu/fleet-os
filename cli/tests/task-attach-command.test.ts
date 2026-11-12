import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import { deployCommand } from '../src/commands/services.js'
import { runCommand } from '../src/commands/run.js'
import { waitForRunning } from '../src/deploy-wait.js'
import { uploadContext } from '../src/archive.js'

async function withApi(handler: RequestListener, run: () => Promise<void>) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const saved = { FLEET_API: process.env.FLEET_API, FLEET_TOKEN: process.env.FLEET_TOKEN }
  process.env.FLEET_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.FLEET_TOKEN = 'test-only'
  try { await run() }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test('attach follows the requested deployment using GET only, ignoring an older serving release', async () => {
  const requests: string[] = []
  let detailReads = 0
  await withApi((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/fleets/fleet/services') res.end(JSON.stringify({ services: [{ id: 'service', name: 'web', current: { status: 'running' } }] }))
    else if (req.url === '/services/service/deployments') res.end(JSON.stringify({ deployments: [{ id: 'new' }, { id: 'old' }] }))
    else if (req.url === '/services/service/deployments/new') {
      detailReads++
      res.end(JSON.stringify({ deployment: { id: 'new', status: detailReads < 3 ? 'building' : 'running', startedAt: new Date().toISOString(), gitSha: null, failureReason: null }, progress: null }))
    } else { res.statusCode = 404; res.end('{}') }
  }, async () => {
    await deployCommand.run(['attach', 'web'], { fleet: 'fleet', json: true })
    assert.ok(detailReads >= 3)
    assert.ok(requests.every(path => path.startsWith('GET ')))
    assert.ok(!requests.some(path => path.includes('/build-context') || path.includes('/deployments/old')))
  })
})

test('superseded attempts stop waiting immediately rather than timing out', async () => {
  const result = await waitForRunning('fleet', 'service', { timeoutMs: 50, pollMs: 1, read: async () => ({ status: 'superseded', failureReason: null }) })
  assert.deepEqual(result, { state: 'failed', reason: 'deployment superseded' })
})

test('run forwards literal arguments and propagates the task exit code', async () => {
  let command: unknown
  const previousExitCode = process.exitCode
  await withApi((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ services: [{ id: 'service', name: 'web' }] }))
    } else {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        command = JSON.parse(Buffer.concat(chunks).toString())
        res.setHeader('content-type', 'text/event-stream')
        res.end('event: result\ndata: {"exitCode":7,"output":"task output"}\n\n')
      })
    }
  }, async () => {
    try {
      await runCommand.run(['web', '--', 'node', '--version'], { fleet: 'fleet', timeout: '30', json: true })
      assert.deepEqual(command, { command: ['node', '--version'], timeoutMs: 30000 })
      assert.equal(process.exitCode, 7)
    } finally { process.exitCode = previousExitCode }
  })
})

test('oversized prepacked uploads fail before making any API request', async () => {
  let calls = 0
  const old = process.env.FLEET_MAX_UPLOAD_BYTES
  process.env.FLEET_MAX_UPLOAD_BYTES = '100'
  try {
    await withApi((_req, res) => { calls++; res.end('{}') }, async () => {
      await assert.rejects(uploadContext('service', '.', Buffer.alloc(101)), /upload limit/)
      assert.equal(calls, 0)
    })
  } finally {
    if (old === undefined) delete process.env.FLEET_MAX_UPLOAD_BYTES
    else process.env.FLEET_MAX_UPLOAD_BYTES = old
  }
})

test('partial secret imports report completed and pending keys without echoing values', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { secretsCommand } = await import('../src/commands/secrets.js')
  const dir = await mkdtemp(join(tmpdir(), 'fleet-import-failure-'))
  const file = join(dir, '.env')
  await writeFile(file, 'FIRST=hidden-one\nSECOND=hidden-two\nTHIRD=hidden-three\n')
  let writes = 0
  try {
    await withApi((req, res) => {
      req.resume()
      if (++writes === 1) { res.setHeader('content-type', 'application/json'); res.end('{"created":true}') }
      else { res.statusCode = 403; res.end('hidden-two') }
    }, async () => {
      await assert.rejects(secretsCommand.run(['import', file], { all: true, fleet: 'fleet' }), err => {
        assert.match(String(err), /Completed: FIRST/)
        assert.match(String(err), /--only SECOND,THIRD/)
        assert.doesNotMatch(String(err), /hidden-one|hidden-two|hidden-three/)
        return true
      })
      assert.equal(writes, 2)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
