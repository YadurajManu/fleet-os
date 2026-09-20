import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { streamRequest } from '../src/api.js'

test('follow receives build phases and log lines across split SSE chunks without a result event', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only')
    assert.equal(req.method, 'GET')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"text":"building linux/')
    setImmediate(() => res.end('arm64"}\n\ndata: {"text":"RUN npm ci"}\n\n'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const lines: string[] = []
    await streamRequest<{ text: string }, void>('GET', '/logs/stream', {
      profile: { api: `http://127.0.0.1:${address.port}`, accessToken: 'test-only' },
      onMessage: entry => lines.push(entry.text),
    })
    assert.deepEqual(lines, ['building linux/arm64', 'RUN npm ci'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
