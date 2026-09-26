/** @jsxRuntime automatic @jsxImportSource react */
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../src/lib/auth.tsx'
import { session, type Node, type Service } from '../src/lib/api.ts'
import { missionHealth, nodeRegion } from '../src/lib/mission.ts'
import MissionControl from '../src/pages/MissionControl.tsx'

test('a stale heartbeat never produces fresh capacity or a healthy node', () => {
  const node = { id: 'n1', name: 'node-one', live: false, tags: ['region:europe'], telemetry: { ageMs: 1000, runtime: { dockerAvailable: true } } } as Node
  const service = { id: 's1', name: 'api', current: { status: 'running', nodeId: 'n1' } } as Service
  const health = missionHealth([node], [service], 15_000)
  assert.equal(health.fresh.length, 0)
  assert.equal(health.atRisk.length, 1)
  assert.equal(health.running.length, 0)
  assert.equal(nodeRegion(node), 'europe')
  assert.equal(nodeRegion({ ...node, tags: ['region:unknown'] }), null)
})

test('Mission Control renders real fleet data and does not invent traffic', async () => {
  const originalFetch = globalThis.fetch
  localStorage.clear()
  session.set({ accessToken: 'test', refreshToken: 'test', email: 'test@example.com' })
  const fleet = { id: 'mission-test', name: 'homelab', role: 'owner', heartbeatIntervalSec: 5, heartbeatMissThreshold: 3 }
  globalThis.fetch = async input => {
    const path = String(input).replace(/^\/api/, '')
    const body = path === '/auth/me' ? { user: { email: 'test@example.com', emailVerifiedAt: '2026-01-01' } }
      : path === '/fleets' ? { fleets: [fleet] }
      : path.endsWith('/nodes') ? { nodes: [{ id: 'n1', name: 'node-one', live: true, status: 'online', os: 'linux', arch: 'arm64', platform: 'linux/arm64', tags: ['region:europe'], effectiveMemBytes: 8589934592, lastHeartbeatAt: new Date().toISOString(), telemetry: { ageMs: 1000, cpuPct: 12, runtime: { dockerAvailable: true } } }] }
      : path.endsWith('/services') ? { services: [] }
      : path.endsWith('/placement-map') ? { nodes: [], unplaced: [] }
      : path === '/healthz' ? { status: 'ok', postgres: true, redis: true }
      : path.includes('/traffic?') ? { requests: 3, errors: 1, meanMs: 25, series: [{ at: new Date().toISOString(), requests: 3, errors: 1 }] }
      : { events: [] }
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<MemoryRouter><AuthProvider><MissionControl /></AuthProvider></MemoryRouter>))
    assert.match(host.textContent ?? '', /Mission Control/)
    assert.match(host.textContent ?? '', /North America|Europe/)
    assert.match(host.textContent ?? '', /node-one/)
    await act(async () => { host.querySelectorAll('button').forEach(button => { if (button.textContent === 'traffic') button.click() }) })
    assert.match(host.textContent ?? '', /3 completed requests/)
    assert.doesNotMatch(host.textContent ?? '', /99\.9% availability/)
  } finally {
    act(() => root.unmount())
    globalThis.fetch = originalFetch
    localStorage.clear()
  }
})
