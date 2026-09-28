import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { waitForRunning, requireRunning, DEPLOY_READY_TIMEOUT_MS, type ReadStatus } from '../src/deploy-wait.js'

/** A status source for tests that need real polling rather than a final read. */
const after = (
  timeline: Array<{ atMs: number; status: string; failureReason?: string | null }>
): { read: ReadStatus; reads: () => number } => {
  const startedAt = Date.now()
  let reads = 0
  const read: ReadStatus = async () => {
    reads++
    const elapsed = Date.now() - startedAt
    const hit = [...timeline].reverse().find((t) => elapsed >= t.atMs)
    return hit ? { status: hit.status, failureReason: hit.failureReason ?? null } : null
  }
  return { read, reads: () => reads }
}

describe('waiting for a deploy to become running', () => {
  test('a deploy that lands just after the deadline still succeeds', async () => {
    // At the deadline, only the final authoritative read can see the new
    // state. A call-count fixture proves that without depending on OS timers.
    let reads = 0
    const read: ReadStatus = async () => ({ status: ++reads === 1 ? 'deploying' : 'running' })
    const out = await waitForRunning('f', 's', { timeoutMs: 0, read })
    assert.deepEqual(out, { state: 'running' })
    assert.equal(reads, 2, 'the second read happens after the deadline')
  })

  test('a service already running is not waited for at all', async () => {
    const { read, reads } = after([{ atMs: 0, status: 'running' }])
    const out = await waitForRunning('f', 's', { timeoutMs: 5_000, pollMs: 50, read })
    assert.equal(out.state, 'running')
    assert.equal(reads(), 1, 'one read, no polling loop')
  })

  test('a real failure is reported as a failure, with its reason', async () => {
    const { read } = after([
      { atMs: 0, status: 'deploying' },
      { atMs: 30, status: 'failed', failureReason: 'health check never passed' },
    ])
    const out = await waitForRunning('f', 's', { timeoutMs: 2_000, pollMs: 10, read })
    assert.equal(out.state, 'failed')
    assert.equal(out.state === 'failed' && out.reason, 'health check never passed')
  })

  test('a deploy that never settles is a timeout, carrying the last status', async () => {
    const { read } = after([{ atMs: 0, status: 'building' }])
    const out = await waitForRunning('f', 's', { timeoutMs: 120, pollMs: 20, read })
    assert.equal(out.state, 'timeout')
    assert.equal(out.state === 'timeout' && out.last, 'building')
  })

  test('an unreadable status is not treated as a failure', async () => {
    // A control plane blip must not end a deploy that is going fine.
    let calls = 0
    const read: ReadStatus = async () => (++calls < 3 ? null : { status: 'running' })
    const out = await waitForRunning('f', 's', { timeoutMs: 2_000, pollMs: 10, read })
    assert.equal(out.state, 'running')
  })

  test('the caller is told what is being waited on', async () => {
    const seen: Array<string | null> = []
    const { read } = after([
      { atMs: 0, status: 'building' },
      { atMs: 60, status: 'running' },
    ])
    await waitForRunning('f', 's', {
      timeoutMs: 1_000,
      pollMs: 15,
      read,
      onPoll: (status) => void seen.push(status),
    })
    assert.ok(seen.length > 0, 'onPoll ran')
  })
})

describe('both commands share one deadline', () => {
  test('the shared timeout outlives the control plane build timeout', () => {
    // BUILD_TIMEOUT_MS on the control plane is 20 minutes. A client that gives
    // up first calls a deploy dead while the server is still working on it.
    assert.ok(
      DEPLOY_READY_TIMEOUT_MS > 20 * 60_000,
      'the CLI must not stop watching before the server stops building'
    )
    assert.equal(DEPLOY_READY_TIMEOUT_MS, 45 * 60_000, 'the value fleet up already used')
  })
})

describe('the message a failure carries', () => {
  test('a timeout says the deploy may still be running', async () => {
    const { read } = after([{ atMs: 0, status: 'building' }])
    await assert.rejects(
      () => requireRunning('f', 's', 'web', { timeoutMs: 60, pollMs: 15, read }),
      // Never "has not reported running", which reads as a verdict on the
      // service rather than on the waiting.
      (err: Error) => /may still be running/.test(err.message) && /last building/.test(err.message)
    )
  })

  test('a failure says it did not start, and why', async () => {
    const { read } = after([{ atMs: 0, status: 'failed', failureReason: 'image pull denied' }])
    await assert.rejects(
      () => requireRunning('f', 's', 'web', { timeoutMs: 500, pollMs: 10, read }),
      (err: Error) => /did not start/.test(err.message) && /image pull denied/.test(err.message)
    )
  })
})

/*
 * Resolving a name to a service is in services.ts behind `request`, so these
 * pin the rule rather than the wiring: an id wins outright, a single match
 * needs no project, and an ambiguous name must never resolve silently.
 */
describe('a name that two projects share', () => {
  type Row = { id: string; name: string; project: string }
  const rows: Row[] = [
    { id: 'a1', name: 'backend', project: 'medlifecycle' },
    { id: 'b2', name: 'backend', project: 'noneofyourbuisness' },
    { id: 'c3', name: 'landing-page', project: 'medlifecycle' },
  ]

  /** The same order of preference findService applies. */
  const resolve = (name: string, opts: { project?: string; here?: string } = {}) => {
    const byId = rows.find((r) => r.id === name)
    if (byId) return { ok: true as const, row: byId }
    const matches = rows.filter((r) => r.name === name)
    if (!matches.length) return { ok: false as const, why: 'unknown' }
    if (matches.length === 1) return { ok: true as const, row: matches[0]! }
    if (opts.project) {
      const scoped = matches.find((r) => r.project === opts.project)
      return scoped ? { ok: true as const, row: scoped } : { ok: false as const, why: 'wrong-project' }
    }
    const local = matches.find((r) => r.project === opts.here)
    return local ? { ok: true as const, row: local } : { ok: false as const, why: 'ambiguous' }
  }

  test('an unambiguous name needs no project', () => {
    assert.equal(resolve('landing-page').ok, true)
  })

  test('an id resolves without a project at all', () => {
    const out = resolve('b2')
    assert.equal(out.ok && out.row.project, 'noneofyourbuisness')
  })

  test('--project picks the right one of two', () => {
    const out = resolve('backend', { project: 'medlifecycle' })
    assert.equal(out.ok && out.row.id, 'a1')
  })

  test('--project naming a project without that service is an error, not a fallback', () => {
    const out = resolve('backend', { project: 'cafe-mvp' })
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.why, 'wrong-project')
  })

  test('the directory decides when it owns one of them', () => {
    const out = resolve('backend', { here: 'medlifecycle' })
    assert.equal(out.ok && out.row.id, 'a1')
  })

  test('an ambiguous name refuses rather than taking the first match', () => {
    // Taking the first match is how a command acts on another project's
    // service without saying so.
    const out = resolve('backend', { here: 'somewhere-else' })
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.why, 'ambiguous')
  })
})
