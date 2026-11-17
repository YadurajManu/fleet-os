import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { DatabaseStream } from '../src/databases/tunnel.js'

function fixture(window: 1 | 16) {
  const sent: Array<{ type: string; seq?: number; data?: string }> = []
  const id = randomUUID()
  const stream = new DatabaseStream(
    id,
    {
      identity: {
        id,
        nodeId: randomUUID(),
        fleetId: randomUUID(),
        project: 'test',
        generation: 1,
      },
      role: 'database',
      port: 5432,
      timeoutMs: 30000,
    },
    new AbortController().signal,
    (body) => {
      sent.push(body as (typeof sent)[number])
      return true
    },
    () => {},
  )
  stream.on('error', () => {})
  stream.start()
  stream.receive({ type: 'db.opened', version: 1, id, window })
  return { stream, sent, id }
}

test('sender bounds its window and grants one replacement per drained frame', async () => {
  const { stream, sent, id } = fixture(16)
  try {
    let completed = false
    stream.write(Buffer.alloc(32 * 32768), () => {
      completed = true
    })
    const frames = () => sent.filter((item) => item.type === 'db.data')
    assert.equal(frames().length, 16)
    stream.receive({ type: 'db.ack', version: 1, id, seq: 1 })
    assert.equal(frames().length, 17)
    for (let seq = 2; seq <= 32; seq++)
      stream.receive({ type: 'db.ack', version: 1, id, seq })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(completed, true)
  } finally {
    stream.destroy()
  }
})

test('old peers negotiate a single frame', () => {
  const { stream, sent, id } = fixture(1)
  try {
    stream.write(Buffer.alloc(3 * 32768))
    assert.equal(sent.filter((item) => item.type === 'db.data').length, 1)
    stream.receive({ type: 'db.ack', version: 1, id, seq: 1 })
    assert.equal(sent.filter((item) => item.type === 'db.data').length, 2)
  } finally {
    stream.destroy()
  }
})

for (const mode of [
  'out-of-order',
  'oversize',
  'excess-credit',
  'invalid-ack',
]) {
  test(`rejects ${mode} frames`, async () => {
    const { stream, id } = fixture(16)
    const closed = once(stream, 'close')
    if (mode === 'invalid-ack')
      stream.receive({ type: 'db.ack', version: 1, id, seq: 1 })
    else if (mode === 'excess-credit') {
      for (let seq = 1; seq <= 19; seq++)
        stream.receive({
          type: 'db.data',
          version: 1,
          id,
          seq,
          data: Buffer.alloc(32768).toString('base64'),
        })
    } else
      stream.receive({
        type: 'db.data',
        version: 1,
        id,
        seq: mode === 'out-of-order' ? 2 : 1,
        data: Buffer.alloc(mode === 'oversize' ? 32769 : 1).toString('base64'),
      })
    await closed.catch(() => {})
    assert.equal(stream.destroyed, true)
  })
}

test('slow receivers stop granting credit and bound buffered bytes', () => {
  const { stream, sent, id } = fixture(16)
  try {
    for (let seq = 1; seq <= 17; seq++)
      stream.receive({
        type: 'db.data',
        version: 1,
        id,
        seq,
        data: Buffer.alloc(32768).toString('base64'),
      })
    assert.equal(sent.filter((item) => item.type === 'db.ack').length, 1)
    assert.ok(stream.readableLength <= 17 * 32768)
    while (stream.read(32768) !== null) {}
    assert.equal(sent.filter((item) => item.type === 'db.ack').length, 17)
  } finally {
    stream.destroy()
  }
})

test('16 credits transfer 2 MiB much faster over a simulated 100 ms RTT', async (t) => {
  async function transfer(window: 1 | 16) {
    const { stream, sent, id } = fixture(window)
    const payload = Buffer.alloc(2 * 1024 * 1024, 197)
    const received: Buffer[] = []
    let cursor = 0
    const pump = setInterval(() => {
      while (cursor < sent.length) {
        const frame = sent[cursor++]!
        if (frame.type !== 'db.data') continue
        received.push(Buffer.from(frame.data!, 'base64'))
        setTimeout(
          () =>
            stream.receive({ type: 'db.ack', version: 1, id, seq: frame.seq }),
          100,
        )
      }
    }, 1)
    const started = performance.now()
    try {
      await new Promise<void>((resolve, reject) =>
        stream.write(payload, (error) => (error ? reject(error) : resolve())),
      )
      assert.deepEqual(Buffer.concat(received), payload)
      return performance.now() - started
    } finally {
      clearInterval(pump)
      stream.destroy()
    }
  }
  const legacyMs = await transfer(1)
  const windowMs = await transfer(16)
  t.diagnostic(
    JSON.stringify({ bytes: 2097152, rttMs: 100, legacyMs, windowMs }),
  )
  assert.ok(windowMs < legacyMs / 4)
})
