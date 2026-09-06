/** @jsxRuntime automatic @jsxImportSource react */
import test from 'node:test'
import assert from 'node:assert/strict'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { usePoll } from '../src/lib/auth.tsx'

/* ── harness ─────────────────────────────────────────────────────────
 *
 * The crash this file guards against:
 *
 *   Uncaught TypeError: Cannot read properties of undefined (reading 'length')
 *   at ServiceDetail  —  !deployments.data?.deployments.length
 *
 * `usePoll` cached each response under `JSON.stringify(deps)`. Three panels
 * on the service page polled three different endpoints with the same
 * `[serviceId]` dependency, so on a remount within the freshness window the
 * `deployments` hook initialised from whatever endpoint wrote the cache last
 * — usually `/logs`, whose body has no `deployments` key. `.data.deployments`
 * was then `undefined` and `.length` threw.
 */

// A poll interval long enough that each hook fetches once and then sits still
// for the duration of a test.
const ONCE = 1_000_000

let routes: Record<string, { status?: number; body: unknown } | (() => { status?: number; body: unknown })>
let calls: string[]
let live: Array<() => void>

test.beforeEach(() => {
  routes = {}
  calls = []
  live = []
  ;(globalThis as { fetch: unknown }).fetch = async (url: string) => {
    const path = url.replace(/^\/api/, '')
    calls.push(path)
    const entry = routes[path]
    if (entry === undefined) return new Response('{"error":{"message":"no route"}}', { status: 404 })
    const { status = 200, body } = typeof entry === 'function' ? entry() : entry
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
})

// Every test tears its trees down: `usePoll` keeps a module-level cache and a
// pending timer, and a component left mounted would poll into the next test.
test.afterEach(() => {
  for (const teardown of live.splice(0)) teardown()
})

function mount(el: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(el))
  const unmount = () => {
    try { act(() => root.unmount()) } catch { /* already gone */ }
    host.remove()
  }
  live.push(unmount)
  return {
    host,
    text: () => host.textContent ?? '',
    rerender: (next: React.ReactElement) => act(() => root.render(next)),
    unmount,
  }
}

/** Let pending fetches and their state updates flush. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

/* ── the fix: cache is keyed by URL, never by an ambiguous dep ────────
 *
 * Each test uses its own paths: `usePoll`'s cache is module-level and lives
 * for the whole run.
 */

const jsonGet = <T,>(path: string) => () => fetch(`/api${path}`).then((r) => r.json() as Promise<T>)

test("two endpoints sharing a dependency do not receive each other's data", async () => {
  routes['/services/a/deployments'] = { body: { deployments: [{ id: 'd1' }] } }
  routes['/services/a/logs'] = { body: { node: { name: 'n1' }, lines: ['boot'], diagnostic: null } }

  function Page() {
    const deployments = usePoll<{ deployments: { id: string }[] }>(
      jsonGet('/services/a/deployments'), '/services/a/deployments', ONCE,
    )
    const logs = usePoll<{ lines: string[] }>(jsonGet('/services/a/logs'), '/services/a/logs', ONCE)
    // The exact expression that crashed — deliberately NOT hardened here.
    return (
      <>
        <span>dep:{!deployments.data?.deployments.length ? 'empty' : deployments.data.deployments.length}</span>
        <span>log:{logs.data?.lines.length ?? 'none'}</span>
      </>
    )
  }

  const view = mount(<Page />)
  await settle()

  assert.equal(view.text(), 'dep:1log:1')
})

test('reproduction: remount after a sibling endpoint filled the cache does not crash', async () => {
  routes['/services/b/logs'] = { body: { node: { name: 'n1' }, lines: ['a', 'b'], diagnostic: null } }
  routes['/services/b/deployments'] = { body: { deployments: [] } }

  // 1. A component that only polls /logs primes the module cache. Before the
  //    fix this wrote the cache entry that /deployments then read by mistake,
  //    because both keyed on the bare service id.
  function LogsOnly() {
    const logs = usePoll(jsonGet('/services/b/logs'), '/services/b/logs', ONCE)
    return <span>{logs.loading ? 'loading' : 'ready'}</span>
  }
  const first = mount(<LogsOnly />)
  await settle()
  assert.equal(first.text(), 'ready')
  first.unmount()

  // 2. The deployments panel, mounted fresh. Pre-fix it initialised from the
  //    /logs body and threw on `.deployments.length`.
  function DeploymentsPanel() {
    const deployments = usePoll<{ deployments: { id: string }[] }>(
      jsonGet('/services/b/deployments'), '/services/b/deployments', ONCE,
    )
    return <span>{!deployments.data?.deployments.length ? 'never deployed' : 'has deploys'}</span>
  }

  let view!: ReturnType<typeof mount>
  assert.doesNotThrow(() => {
    view = mount(<DeploymentsPanel />)
  })
  await settle()
  assert.equal(view.text(), 'never deployed')
})

test('a null key keeps the hook idle — no fetch, not loading', async () => {
  let ran = 0
  function Idle() {
    const p = usePoll(() => { ran++; return Promise.resolve({ x: 1 }) }, null, ONCE)
    return <span>{p.loading ? 'loading' : `idle:${p.data === null}`}</span>
  }
  const view = mount(<Idle />)
  await settle()
  assert.equal(ran, 0)
  assert.equal(view.text(), 'idle:true')
  assert.deepEqual(calls, [])
})

test('key change from null to a url starts polling that url', async () => {
  routes['/services/c/deployments'] = { body: { deployments: [{ id: 'x' }] } }

  function Gated() {
    const [open, setOpen] = useState(false)
    const dep = usePoll<{ deployments: unknown[] }>(
      jsonGet('/services/c/deployments'),
      open ? '/services/c/deployments' : null,
      ONCE,
    )
    return (
      <button onClick={() => setOpen(true)}>
        {dep.data ? `n=${dep.data.deployments.length}` : 'closed'}
      </button>
    )
  }
  const view = mount(<Gated />)
  await settle()
  assert.equal(view.text(), 'closed')
  assert.deepEqual(calls, [])

  act(() => view.host.querySelector('button')!.click())
  await settle()
  assert.equal(view.text(), 'n=1')
})

test('cache survives an unmount/remount and shows immediately', async () => {
  let n = 0
  routes['/services/d/deployments'] = () => ({ body: { deployments: Array.from({ length: ++n }, (_, i) => ({ id: i })) } })

  function Deps() {
    const dep = usePoll<{ deployments: unknown[] }>(
      jsonGet('/services/d/deployments'), '/services/d/deployments', ONCE,
    )
    return <span>{dep.loading ? 'loading' : `n=${dep.data?.deployments.length}`}</span>
  }

  const a = mount(<Deps />)
  await settle()
  assert.equal(a.text(), 'n=1')
  a.unmount()

  const b = mount(<Deps />)
  // No loading flash: the remembered answer is shown synchronously.
  assert.equal(b.text(), 'n=1')
  await settle()
  assert.equal(b.text(), 'n=2')
})

/* ── the crash site's data shapes ──────────────────────────────────── */

// Mirrors ServiceDetail's deployments panel: lines 365 (.map) and 414 (.length).
function DeploymentsList({ data }: { data: unknown }) {
  const d = data as { deployments?: { id: string; imageTags?: string[] }[] } | null
  const rows = d?.deployments ?? []
  return (
    <div>
      {rows.map((x) => (
        <span key={x.id}>{x.id}:{(x.imageTags ?? [])[0] ?? '—'}</span>
      ))}
      {!(d?.deployments ?? []).length && <p>never deployed</p>}
    </div>
  )
}

for (const [label, data, expected] of [
  ['populated', { deployments: [{ id: 'd1', imageTags: ['img:1'] }] }, 'd1:img:1'],
  ['empty array', { deployments: [] }, 'never deployed'],
  ['missing field', {}, 'never deployed'],
  ['undefined field', { deployments: undefined }, 'never deployed'],
  ['null field', { deployments: null }, 'never deployed'],
  ['null response', null, 'never deployed'],
  ['legacy row without imageTags', { deployments: [{ id: 'd2' }] }, 'd2:—'],
] as const) {
  test(`deployments panel renders "${label}" without throwing`, () => {
    let view!: ReturnType<typeof mount>
    assert.doesNotThrow(() => {
      view = mount(<DeploymentsList data={data} />)
    })
    assert.ok(view.text().includes(expected), `got: ${view.text()}`)
  })
}
