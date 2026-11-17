import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseEventDecoder } from '../src/lib/databases.ts'
import { api, apiStream, session } from '../src/lib/api.ts'

const progress = {
  id: 7,
  operationId: 'aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa',
  kind: 'create',
  state: 'running',
  code: 'checkpoint',
  progress: 20,
  createdAt: '2026-11-17T00:00:00Z',
}
const frame = (value = progress) =>
  `id: ${value.id}\r\nevent: progress\r\ndata: ${JSON.stringify(value)}\r\n\r\n`

test('database SSE decoder handles split events, keepalives and batched input', () => {
  const decoder = new DatabaseEventDecoder()
  const text = frame()
  assert.deepEqual(decoder.push(': keepalive\r\n\r\n' + text.slice(0, 35)), [])
  assert.deepEqual(decoder.push(text.slice(35)), [progress])
  assert.equal(
    decoder.push(Array.from({ length: 1000 }, () => frame()).join('')).length,
    1000,
  )
})
test('database SSE decoder rejects oversize partial events and invalid progress', () => {
  assert.throws(
    () => new DatabaseEventDecoder().push('data: ' + 'x'.repeat(131073)),
    /size/,
  )
  assert.throws(
    () =>
      new DatabaseEventDecoder().push(frame({ ...progress, progress: 101 })),
    /invalid/,
  )
  assert.throws(
    () => new DatabaseEventDecoder().push(frame().replace('id: 7', 'id: 8')),
    /invalid/,
  )
})
test('database requests carry idempotency keys and SSE refresh uses the shared session', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ path: string; headers: Headers }> = []
  session.set({
    accessToken: 'test-expired-access',
    refreshToken: 'test-refresh',
  })
  globalThis.fetch = (async (
    input: string | URL | Request,
    options?: RequestInit,
  ) => {
    const path = String(input),
      headers = new Headers(options?.headers)
    calls.push({ path, headers })
    if (path.endsWith('/auth/refresh'))
      return new Response(
        JSON.stringify({
          accessToken: 'test-fresh-access',
          refreshToken: 'test-new-refresh',
        }),
      )
    if (path.endsWith('/events')) {
      if (headers.get('authorization') !== 'Bearer test-fresh-access')
        return new Response('{}', { status: 401 })
      return new Response(frame(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response('{}', {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    await api('/databases', {
      method: 'POST',
      body: { name: 'primary' },
      idempotencyKey: 'same-request-key',
    })
    assert.equal(calls[0]!.headers.get('idempotency-key'), 'same-request-key')
    const response = await apiStream('/events', new AbortController().signal)
    assert.equal(response.status, 200)
    assert.equal(
      calls.filter((item) => item.path.endsWith('/auth/refresh')).length,
      1,
    )
    assert.equal(
      calls.at(-1)!.headers.get('authorization'),
      'Bearer test-fresh-access',
    )
  } finally {
    globalThis.fetch = originalFetch
    session.clear()
  }
})
