import test from 'node:test'
import assert from 'node:assert/strict'
import {
  placeDatabase,
  databaseStabilityScore,
} from '../src/databases/placement.js'
import { place } from '../src/scheduler/placement.js'
import type { NodeSnapshot, ServiceSpec } from '../src/scheduler/types.js'

const node = (
  id: string,
  changes: Partial<NodeSnapshot> = {},
): NodeSnapshot => ({
  id,
  name: id,
  arch: 'arm64',
  platform: 'linux/arm64',
  status: 'online',
  ramMb: 8192,
  cpuCores: 4,
  hasGpu: false,
  reliabilityTier: 'standard',
  tags: ['storage:ssd'],
  committedRamMb: 0,
  committedCpu: 0,
  freeDiskMb: 50000,
  committedDiskMb: 0,
  databaseCapabilities: ['database.runtime.v1'],
  uptimeSec: 30 * 86400,
  outagesLast30Days: 0,
  ...changes,
})
const request = {
  id: 'database',
  name: 'primary',
  memoryMb: 512,
  cpu: 0.5,
  diskMb: 10240,
}

test('database placement preserves its data pin during an outage', () => {
  const decision = placeDatabase({ ...request, volumeNodeId: 'original' }, [
    node('original', { status: 'offline' }),
    node('spare'),
  ])
  assert.equal(decision.outcome, 'no_eligible_node')
  assert.ok(
    decision.rejected.some(
      (row) =>
        row.code === 'not_pinned_node' || row.code === 'volume_elsewhere',
    ),
  )
})
test('database placement measures stability, reservations and safe headroom', () => {
  const stable = node('stable'),
    flaky = node('laptop', {
      ramMb: 16384,
      uptimeSec: 300,
      outagesLast30Days: 10,
    })
  assert.ok(databaseStabilityScore(stable) > databaseStabilityScore(flaky))
  const decision = placeDatabase(request, [flaky, stable])
  assert.equal(decision.outcome, 'placed')
  if (decision.outcome === 'placed') {
    assert.equal(decision.nodeId, 'stable')
    assert.match(decision.candidates[0]!.reason!, /stability 1.00/)
  }
  assert.equal(
    placeDatabase(request, [node('full', { committedDiskMb: 45000 })]).outcome,
    'no_eligible_node',
  )
  assert.equal(
    placeDatabase(request, [node('ram', { ramMb: 600 })]).outcome,
    'no_eligible_node',
  )
  assert.equal(
    placeDatabase(request, [node('cpu', { committedCpu: 3.8 })]).outcome,
    'no_eligible_node',
  )
})
test('unknown disk and old agents are refused; SD storage and unstable nodes warn', () => {
  assert.equal(
    placeDatabase(request, [node('old', { databaseCapabilities: [] })])
      .rejected[0]!.code,
    'agent_upgrade_required',
  )
  assert.equal(
    placeDatabase(request, [node('unknown', { freeDiskMb: undefined })])
      .rejected[0]!.code,
    'disk_unknown',
  )
  const decision = placeDatabase(request, [
    node('sd', { tags: ['storage:sd'], uptimeSec: 100, outagesLast30Days: 3 }),
  ])
  assert.ok(decision.warnings.some((warning) => warning.includes('SD-card')))
  assert.ok(decision.warnings.some((warning) => warning.includes('outages')))
})
test('soft database affinity affects rank without weakening existing hard affinity', () => {
  const spec: ServiceSpec = {
    id: 'app',
    name: 'app',
    placementPolicy: 'flexible',
    requestRamMb: 512,
    requestCpu: 0.5,
    requiresGpu: false,
    minReliabilityTier: 'opportunistic',
    compatibleArches: [],
    affinity: [],
    antiAffinity: [],
    persistentVolume: false,
    preferredNodeIds: ['database-node'],
  }
  const nodes = [node('other'), node('database-node')]
  const preferred = place(spec, nodes)
  assert.equal(preferred.outcome, 'placed')
  if (preferred.outcome === 'placed')
    assert.equal(preferred.nodeId, 'database-node')
  const hard = place({ ...spec, affinity: ['existing'] }, nodes, {
    existing: 'other',
  })
  assert.equal(hard.outcome, 'placed')
  if (hard.outcome === 'placed') assert.equal(hard.nodeId, 'other')
  assert.ok(hard.warnings.some((warning) => warning.includes('latency')))
  const held = place(
    { ...spec, workloadClass: 'stateful', volumeNodeId: 'database-node' },
    [node('other')],
  )
  assert.equal(held.outcome, 'no_eligible_node')
})
