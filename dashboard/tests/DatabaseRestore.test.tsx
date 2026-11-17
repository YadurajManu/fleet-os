/** @jsxRuntime automatic @jsxImportSource react */
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../src/lib/auth.tsx'
import { session } from '../src/lib/api.ts'
import DatabaseDetail from '../src/pages/DatabaseDetail.tsx'

test('database detail queues restore to a separate empty target and follows it', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ path: string; method: string; body?: unknown }> = []
  const fleetId = 'fleet-id'
  session.set({ accessToken: 'test', refreshToken: 'test' })
  const database = (id: string, name: string) => ({
    id,
    fleetId,
    project: 'production',
    name,
    engine: 'postgres',
    version: '17',
    mode: 'standard',
    status: 'running',
    desiredState: 'running',
    nodeId: 'node-id',
    nodeName: 'node',
    nodeStatus: 'online',
    memoryMb: 512,
    cpu: 0.5,
    diskMb: 10240,
    profile: 'standard',
    generation: 1,
    createdAt: '2026-11-17T00:00:00Z',
    updatedAt: '2026-11-17T00:00:00Z',
    deletedAt: null,
    purgeAfter: null,
    warnings: [],
    backupConfigured: true,
    backupTargetId: 'backup-target',
  })
  const source = database('source-id', 'source')
  const target = database('target-id', 'target')
  globalThis.fetch = async (input, options) => {
    const path = String(input).replace(/^\/api/, '')
    const method = options?.method ?? 'GET'
    calls.push({
      path,
      method,
      ...(options?.body ? { body: JSON.parse(String(options.body)) } : {}),
    })
    let body: unknown = {}
    if (path === '/auth/me')
      body = {
        user: { email: 'admin@example.test', emailVerifiedAt: '2026-11-17' },
      }
    else if (path === '/fleets')
      body = {
        fleets: [
          {
            id: fleetId,
            name: 'test',
            orgId: 'org-id',
            role: 'admin',
            defaultReclaimPolicy: 'manual',
            heartbeatIntervalSec: 5,
            heartbeatMissThreshold: 3,
            agentAutoUpgrade: false,
          },
        ],
      }
    else if (path.includes('/databases?project='))
      body = { databases: [source, target], nextCursor: null }
    else if (path.endsWith('/links')) body = { links: [], services: [] }
    else if (path.endsWith('/backups'))
      body = {
        backups: [
          {
            id: 'backup-id',
            kind: 'logical',
            state: 'complete',
            sizeBytes: 1024,
            errorCode: null,
            createdAt: '2026-11-17T00:00:00Z',
            verifiedAt: '2026-11-17T00:01:00Z',
          },
        ],
      }
    else if (path.endsWith('/events')) return new Response('', { status: 404 })
    else if (path.endsWith('/backups/backup-id/restore'))
      body = { operationId: 'restore-operation', databaseId: target.id }
    else if (path.endsWith('/target-id'))
      body = {
        database: target,
        operations: [
          {
            id: 'restore-operation',
            kind: 'restore',
            state: 'running',
            progress: 20,
            errorCode: null,
            createdAt: '2026-11-17T00:00:00Z',
            finishedAt: null,
          },
        ],
      }
    else body = { database: source, operations: [] }
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/databases/production/source-id']}>
          <AuthProvider>
            <Routes>
              <Route
                path="/databases/:project/:databaseId"
                element={<DatabaseDetail />}
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>,
      ),
    )
    const select = host.querySelector<HTMLSelectElement>(
      '[aria-label="Restore target database"]',
    )!
    await act(async () => {
      select.value = target.id
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const button = [...host.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Restore backup-'),
    )!
    await act(async () => button.click())
    const restore = calls.find((call) => call.method === 'POST')
    assert.ok(restore?.path.endsWith('/source-id/backups/backup-id/restore'))
    assert.deepEqual(restore?.body, { targetDatabaseId: target.id })
    assert.match(host.textContent ?? '', /target/)
  } finally {
    act(() => root.unmount())
    globalThis.fetch = originalFetch
    session.clear()
  }
})
