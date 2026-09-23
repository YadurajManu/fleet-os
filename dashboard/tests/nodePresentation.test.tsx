/** @jsxRuntime automatic @jsxImportSource react */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Node } from '../src/lib/api.ts'
import { diskUse, dockerState, memoryUse, nodePlatformLabel } from '../src/lib/nodePresentation.ts'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import NodeTelemetry from '../src/components/NodeTelemetry.tsx'

const node = {
  id: 'node-1', name: 'workstation', os: 'linux', arch: 'arm64', platform: 'linux/arm64',
  engineKind: 'docker-desktop', cpuCores: 8, ramMb: 8192, diskMb: 51200,
  live: true, telemetry: {
    cpuPct: 38, ramUsedMb: 17000, diskUsedMb: 409000, diskTotalMb: 460000,
    meshConnected: false, ageMs: 2000, containers: [], runtime: { dockerAvailable: false, registryStatus: 'ok' },
  },
} as Node

test('Docker Desktop host memory never becomes a percentage of its VM limit', () => {
  assert.equal(memoryUse(node), null)
  assert.equal(nodePlatformLabel(node), 'Docker Desktop · linux/arm64')
  assert.equal(dockerState(node), 'unavailable')
  assert.ok(diskUse(node)?.ratio! < 1)
  const html = renderToStaticMarkup(<MemoryRouter><NodeTelemetry node={node} /></MemoryRouter>)
  assert.match(html, /Docker RAM limit/)
  assert.match(html, /Last reported limit/)
  assert.doesNotMatch(html, /17\.0 GB \/ 8\.0 GB/)
})

test('native memory uses comparable capacity; stale and impossible samples stay unknown', () => {
  const native = { ...node, engineKind: 'native' as const, ramMb: 24000 }
  assert.equal(memoryUse(native)?.ratio, 17000 / 24000)
  assert.equal(memoryUse({ ...native, live: false }), null)
  assert.equal(diskUse({ ...native, live: false }), null)
  assert.equal(dockerState({ ...node, live: false }), 'unknown')
  assert.equal(memoryUse({ ...native, ramMb: 8000 }), null)
})
