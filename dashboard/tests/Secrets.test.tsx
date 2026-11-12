/** @jsxRuntime automatic @jsxImportSource react */
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from '../src/lib/auth.tsx'
import { session } from '../src/lib/api.ts'
import Secrets from '../src/pages/Secrets.tsx'

test('secret copy form sends source and destination fleet identities without values', async () => {
  const original = globalThis.fetch
  session.set({ accessToken: 'test', refreshToken: 'test', email: 'test@example.com' })
  const fleets = [{ id: 'copy-source', name: 'Source', role: 'owner' }, { id: 'copy-destination', name: 'Destination', role: 'owner' }]
  let copied: { path: string; body: Record<string, unknown> } | undefined
  globalThis.fetch = async (input, init) => {
    const path = String(input).replace(/^\/api/, '')
    if (init?.method === 'POST' && path.endsWith('/clone')) copied = { path, body: JSON.parse(init.body as string) }
    const body = path === '/auth/me' ? { user: { email: 'test@example.com', emailVerifiedAt: '2026-01-01' } }
      : path === '/fleets' ? { fleets }
      : path.endsWith('/services') ? { services: [] }
      : path.endsWith('/secrets') ? { secrets: [{ key: 'COPY_TEST', scope: 'fleet', service: null, updatedAt: '2026-01-01' }] }
      : { key: 'COPY_TEST' }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  try {
    await act(async () => { root.render(<AuthProvider><Secrets /></AuthProvider>); await settle() })
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'copy')!
    assert.ok(button)
    await act(async () => { button.click(); await settle() })
    const destination = host.querySelector('select')!
    await act(async () => { destination.value = 'copy-destination'; destination.dispatchEvent(new Event('change', { bubbles: true })); await settle() })
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle() })
    assert.equal(copied?.path, '/fleets/copy-destination/secrets/clone')
    assert.deepEqual(copied?.body, { key: 'COPY_TEST', fromFleetId: 'copy-source', fromServiceId: null, toServiceId: null, toKey: 'COPY_TEST' })
    assert.match(host.textContent ?? '', /copied/)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = original
    session.clear()
  }
})
