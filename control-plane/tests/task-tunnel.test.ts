import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { TunnelRegistry, type TaskSpec } from '../src/tunnel/registry.js'
import type { AppContext } from '../src/api/context.js'

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN
  sent: Array<{ type: string; id: string }> = []
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  ping() {}
  close() { this.emit('close') }
  terminate() { this.emit('close') }
}
const spec: TaskSpec = { service: 'web', image: 'app:1', platform: 'linux/arm64', command: ['pnpm', 'db:migrate'], env: {}, registry_auth: null, memory_bytes: 128 * 1048576, timeout_ms: 1000 }

test('task responses are fenced to the authenticated node and exact task ID', async () => {
  const registry = new TunnelRegistry({ builds: {} } as unknown as AppContext)
  const first = new Socket(), second = new Socket()
  registry.register('first', first as unknown as WebSocket)
  registry.register('second', second as unknown as WebSocket)
  try {
    let resolved = false
    const pending = registry.runTask('first', spec, new AbortController().signal).then(result => { resolved = true; return result })
    const id = first.sent[0]!.id
    second.emit('message', JSON.stringify({ type: 'task_result', id, result: { exitCode: 0, output: 'wrong node' } }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(resolved, false)
    first.emit('message', JSON.stringify({ type: 'task_result', id, result: { exitCode: 7, output: 'own task' } }))
    assert.deepEqual(await pending, { exitCode: 7, output: 'own task' })
  } finally { first.close(); second.close() }
})

test('aborting a task sends cancellation and disconnects fail without a retry', async () => {
  const registry = new TunnelRegistry({ builds: {} } as unknown as AppContext)
  const socket = new Socket()
  registry.register('node', socket as unknown as WebSocket)
  try {
    const abort = new AbortController()
    const pending = registry.runTask('node', spec, abort.signal)
    abort.abort()
    await assert.rejects(pending, /cancelled/)
    assert.equal(socket.sent[1]!.type, 'task_cancel')
    const disconnected = registry.runTask('node', spec, new AbortController().signal)
    socket.close()
    await assert.rejects(disconnected, /not retried/)
  } finally { socket.close() }
})
