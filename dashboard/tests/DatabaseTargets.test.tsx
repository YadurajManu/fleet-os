/** @jsxRuntime automatic @jsxImportSource react */
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import DatabaseTargets from '../src/components/DatabaseTargets.tsx'

test('project backup targets can be checked through the scoped test route', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ path: string; method: string }> = []
  globalThis.fetch = async (input, options) => {
    const path = String(input).replace(/^\/api/, '')
    const method = options?.method ?? 'GET'
    calls.push({ path, method })
    const body = path.endsWith('/backup-targets')
      ? {
          targets: [
            {
              id: 'target-id',
              name: 'archive',
              endpoint: 'https://s3.example.test',
              bucket: 'backups',
              prefix: 'fleet',
              region: 'us-east-1',
              isDefault: true,
              lastTestedAt: null,
            },
          ],
        }
      : { ok: true }
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        <DatabaseTargets fleetId="fleet-id" project="app" canManage />,
      )
    })
    assert.match(host.textContent ?? '', /archive · default/)
    const button = [...host.querySelectorAll('button')].find(
      (item) => item.textContent === 'Test',
    )!
    await act(async () => {
      button.click()
    })
    assert.ok(
      calls.some(
        (call) =>
          call.path.endsWith('/backup-targets/target-id/test') &&
          call.method === 'POST',
      ),
    )
    assert.match(host.textContent ?? '', /Connection test passed for archive/)
  } finally {
    act(() => root.unmount())
    globalThis.fetch = originalFetch
  }
})
