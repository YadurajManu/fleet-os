import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import { deployCommand } from '../src/commands/services.js'
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
