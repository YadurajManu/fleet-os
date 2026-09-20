/** @jsxRuntime automatic @jsxImportSource react */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadRatio, freshTelemetry, serviceCounts } from '../src/lib/telemetry.ts'
import { RingGauge } from '../src/components/ui.tsx'
import ClusterMeshVisualizer from '../src/components/ClusterMeshVisualizer.tsx'
import type { Node, Service, PlacementMapNode } from '../src/lib/api.ts'

const node = { id: 'node-1', name: 'test-node', arch: 'arm64', status: 'online', live: true, ramMb: 18000, tunnelConnected: true, telemetry: { cpuPct: 33.45, ramUsedMb: 17000, ageMs: 1000, containers: [] } } as unknown as Node
const placement = { id: node.id, name: node.name, arch: 'arm64', status: 'online', ramMb: 18000, freeRamMb: 18000, loadFactor: .3345, services: [] } as PlacementMapNode

test('33.45 percent renders as 33%, never a saturated 100% or 3345%', () => {
  assert.equal(loadRatio(33.45), .3345)
  const html = renderToStaticMarkup(<RingGauge value={loadRatio(33.45)} max={1} label="Normalized load" />)
  assert.match(html, /33%/)
  assert.doesNotMatch(html, /100%|3345%/)
})
test('missing, negative and non-finite metrics are unknown; zero is a real reading', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 101]) assert.equal(loadRatio(value), null)
  assert.equal(loadRatio(0), 0)
  const html = renderToStaticMarkup(<RingGauge value={null} max={100} />)
  assert.match(html, /—/)
  assert.doesNotMatch(html, />0%/)
})
test('disconnected and stale telemetry cannot be presented as fresh', () => {
  assert.ok(freshTelemetry(node, 15000))
  assert.equal(freshTelemetry({ ...node, live: false }, 15000), null)
  assert.equal(freshTelemetry({ ...node, telemetry: { ...node.telemetry!, ageMs: 16000 } }, 15000), null)
})
test('deploying and pinned-down services are not counted as running', () => {
  const services = ['running', 'deploying', 'pinned_unavailable', 'failed'].map(status => ({ current: { status } } as Service))
  const counts = serviceCounts(services)
  assert.equal(counts.running.length, 1)
  assert.equal(counts.deploying.length, 1)
  assert.equal(counts.attention.length, 2)
})
test('mesh uses percentage units, compact canvas and distinct connection labels', () => {
  const html = renderToStaticMarkup(<ClusterMeshVisualizer nodes={[node]} mapNodes={[placement]} />)
  assert.match(html, /33%/)
  assert.doesNotMatch(html, /3345%|mesh ok|animateMotion/)
  assert.match(html, /height="240"/)
  assert.match(html, /Tunnel connected/)
  assert.match(html, /Host memory/)
})
test('stale mesh samples do not become zero container or load measurements', () => {
  const html = renderToStaticMarkup(<ClusterMeshVisualizer nodes={[{ ...node, live: false }]} mapNodes={[placement]} />)
  assert.match(html, /Container count unavailable/)
  assert.match(html, /Telemetry unavailable or stale/)
  assert.doesNotMatch(html, /33%/)
})
