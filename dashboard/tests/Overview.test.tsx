/** @jsxRuntime automatic @jsxImportSource react */
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../src/lib/auth.tsx'
import { session } from '../src/lib/api.ts'
import Overview from '../src/pages/Overview.tsx'

for (const withNode of [true, false]) {
  test(`dismissed onboarding preserves overview with ${withNode ? 'one node' : 'an empty fleet'} and no services`, async () => {
    const originalFetch = globalThis.fetch
    localStorage.clear()
    localStorage.setItem('fleet-os.first-run-dismissed', '1')
    session.set({ accessToken: 'test', refreshToken: 'test', email: 'test@example.com' })
    const fleet = { id: `empty-${withNode}`, name: 'homelab', heartbeatIntervalSec: 5, heartbeatMissThreshold: 3 }
    const node = { id: 'node', name: 'existing-node', live: true, status: 'online', ramMb: 18000, freeRamMb: 18000, arch: 'arm64', services: [], tags: [], loadFactor: 0, reliabilityTier: 'standard' }
    globalThis.fetch = async (input) => {
      const path = String(input).replace(/^\/api/, '')
      const body = path === '/auth/me' ? { user: { email: 'test@example.com', emailVerifiedAt: '2026-01-01' } }
        : path === '/fleets' ? { fleets: [fleet] }
        : path.endsWith('/placement-map') ? { nodes: withNode ? [node] : [], unplaced: [] }
        : path.endsWith('/nodes') ? { nodes: withNode ? [node] : [] }
        : path.endsWith('/services') ? { services: [] }
        : path.endsWith('/alert-rules') ? { rules: [] }
        : { events: [] }
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<MemoryRouter><AuthProvider><Overview /></AuthProvider></MemoryRouter>)
      })
      assert.match(host.textContent ?? '', /Services running/)
      assert.match(host.textContent ?? '', /Nodes reachable/)
      assert.match(host.textContent ?? '', /Nodes and capacity/)
      assert.doesNotMatch(host.textContent ?? '', /Welcome to homelab/)
      if (withNode) assert.match(host.textContent ?? '', /existing-node/)
    } finally {
      act(() => root.unmount())
      globalThis.fetch = originalFetch
      localStorage.clear()
    }
  })
}
