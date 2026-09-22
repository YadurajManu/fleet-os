/** @jsxRuntime automatic @jsxImportSource react */
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import AuditEntries from '../src/components/AuditEntries.tsx'
import type { AuditEntry } from '../src/lib/api.ts'

const base: AuditEntry = {
  id: 'first', action: 'service.deleted', actorKind: 'user', actorUserId: 'user-1',
  actorEmail: 'owner@example.com', targetType: 'service', targetId: 'service-1',
  targetName: null, metadata: { name: 'api', password: 'DO_NOT_SHOW' }, createdAt: '2026-09-22T10:00:00Z',
}

test('audit groups remain expandable and never display unknown metadata', () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const entries = [base, { ...base, id: 'second', targetId: 'service-2', metadata: { name: 'worker', token: 'DO_NOT_SHOW' }, createdAt: '2026-09-22T09:59:00Z' }]
  act(() => root.render(<MemoryRouter><AuditEntries entries={entries} /></MemoryRouter>))
  assert.match(host.textContent ?? '', /2 service actions/)
  const group = host.querySelector('button')!
  act(() => group.click())
  assert.match(host.textContent ?? '', /api/)
  assert.match(host.textContent ?? '', /worker/)
  assert.equal((host.textContent ?? '').includes('DO_NOT_SHOW'), false)
  const details = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Details')!
  act(() => details.click())
  assert.match(host.textContent ?? '', /Record ID/)
  assert.equal((host.textContent ?? '').includes('DO_NOT_SHOW'), false)
  act(() => root.unmount())
  host.remove()
})
