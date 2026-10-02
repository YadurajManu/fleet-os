/** @jsxRuntime automatic @jsxImportSource react */
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../src/lib/auth.tsx'
import { session } from '../src/lib/api.ts'
import Services from '../src/pages/Services.tsx'

test('service cards show failures, first-deploy guidance, and a domains route', async () => {
  const originalFetch = globalThis.fetch
  session.set({ accessToken: 'test', refreshToken: 'test', email: 'test@example.com' })
  const fleet = { id: 'services-ux-test', name: 'homelab', heartbeatIntervalSec: 5, heartbeatMissThreshold: 3, role: 'owner' }
  const base = { project: 'medlifecycle', repoUrl: null, image: null, buildContext: './landing_page', placementPolicy: 'flexible', requestRamMb: 512,
    current: null, recentFailures: 0, replicas: 1, persistentVolume: false, requiresGpu: false }
  const services = [
    { ...base, id: 'landing', name: 'landing-page', hostname: 'landing.example.com', last: { id: 'deploy-1', status: 'failed', failureReason: 'Node did not report the container', startedAt: '2026-10-01T12:00:00Z', finishedAt: '2026-10-01T12:10:00Z' } },
    { ...base, id: 'backend', name: 'backend', hostname: 'backend.example.com', last: null },
  ]
  globalThis.fetch = async (input) => {
    const path = String(input).replace(/^\/api/, '')
    const body = path === '/auth/me' ? { user: { email: 'test@example.com', emailVerifiedAt: '2026-01-01' } }
      : path === '/fleets' ? { fleets: [fleet] }
      : path.endsWith('/services') ? { services }
      : path.endsWith('/nodes') ? { nodes: [] }
      : {}
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<MemoryRouter><AuthProvider><Services /></AuthProvider></MemoryRouter>))
    assert.match(host.textContent ?? '', /Failed1/)
    assert.match(host.textContent ?? '', /Never Deployed1/)
    assert.match(host.textContent ?? '', /Deploy failed · Node did not report the container/)
    assert.match(host.textContent ?? '', /No release yet\. Run fleet deploy backend from your project directory/)
    assert.equal(host.querySelector('a[href="/services/landing#domains"]')?.textContent?.trim(), 'Manage domains')
  } finally {
    act(() => root.unmount())
    globalThis.fetch = originalFetch
  }
})
