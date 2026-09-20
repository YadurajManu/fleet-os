import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planPlatforms,
  selectBuilder,
  type Builder,
} from '../src/build/platforms.js'
import { filterNodes } from '../src/scheduler/placement.js'
import type { NodeSnapshot, ServiceSpec } from '../src/scheduler/types.js'
const node = (id: string, arch: string): NodeSnapshot => ({
  id,
  name: id,
  arch,
  platform: `linux/${arch}`,
  status: 'online',
  ramMb: 8192,
  cpuCores: 8,
  hasGpu: false,
  reliabilityTier: 'standard',
  tags: [],
  committedRamMb: 0,
})
const service: ServiceSpec = {
  id: 's',
  name: 's',
  placementPolicy: 'flexible',
  requestRamMb: 256,
  requestCpu: 0.25,
  requiresGpu: false,
  minReliabilityTier: 'standard',
  compatibleArches: [],
  affinity: [],
  antiAffinity: [],
  persistentVolume: false,
}
test('auto builds all eligible platforms, including failover nodes', () => {
  const nodes = [
    node('mac', 'arm64'),
    node('linux', 'amd64'),
    { ...node('offline', 'armv7'), status: 'offline' as const },
  ]
  assert.deepEqual(planPlatforms(service, nodes), [
    'linux/amd64',
    'linux/arm64',
  ])
  assert.deepEqual(
    planPlatforms({ ...service, placementArch: 'arm64' }, nodes),
    ['linux/arm64']
  )
})
test('manifest platform mismatch needs explicit emulation opt-in', () => {
  const pool = [node('mac', 'arm64'), node('linux', 'amd64')]
  const spec = { ...service, imagePlatforms: ['linux/amd64'] }
  assert.deepEqual(
    filterNodes(spec, pool).eligible.map((n) => n.id),
    ['linux']
  )
  assert.equal(
    filterNodes({ ...spec, allowEmulation: true }, pool).eligible.length,
    2
  )
  assert.deepEqual(
    filterNodes(
      { ...spec, allowEmulation: true, placementArch: 'arm64' },
      pool
    ).eligible.map((n) => n.id),
    ['mac']
  )
})
test('effective engine resources override host totals and include reservations', () => {
  const n = {
    ...node('mac', 'arm64'),
    effectiveCpu: 2,
    effectiveMemBytes: 512 * 1048576,
    committedRamMb: 400,
    committedCpu: 2,
  }
  assert.equal(filterNodes(service, [n]).eligible.length, 0)
})
const builder = (id: string, platform: string): Builder => ({
  id,
  platform,
  buildCacheFreeBytes: 100 * 1073741824,
  canBuild: true,
  connected: true,
  active: 0,
  maxConcurrentBuilds: 1,
  freeCpu: 4,
  freeMemBytes: 8 * 1073741824,
  load: 0.2,
  reliabilityScore: 0.5,
})
test('native selection, warm cache, opt-in, concurrency, and explicit QEMU fallback', () => {
  const mac = builder('mac', 'linux/arm64'),
    x86 = builder('x86', 'linux/amd64')
  assert.equal(selectBuilder([mac, x86], 'linux/arm64', 'x86')?.id, 'mac')
  assert.equal(selectBuilder([x86], 'linux/arm64', null), undefined)
  assert.equal(selectBuilder([x86], 'linux/arm64', null, true)?.id, 'x86')
  assert.equal(selectBuilder([mac], 'linux/amd64', null, true), undefined)
  assert.equal(
    selectBuilder([{ ...mac, canBuild: false }], 'linux/arm64', null),
    undefined
  )
  assert.equal(
    selectBuilder([{ ...mac, active: 1 }], 'linux/arm64', null),
    undefined
  )
  assert.equal(
    selectBuilder([mac, { ...mac, id: 'warm' }], 'linux/arm64', 'warm')?.id,
    'warm'
  )
})

test('builders preserve a disk reserve and account for concurrent build budgets', () => {
  const mac = builder('mac', 'linux/arm64')
  assert.equal(
    selectBuilder(
      [
        {
          ...mac,
          buildCacheFreeBytes: 24 * 1073741824,
          buildDiskReserveBytes: 5 * 1073741824,
        },
      ],
      'linux/arm64',
      null
    ),
    undefined
  )
  assert.equal(
    selectBuilder(
      [
        {
          ...mac,
          buildCacheFreeBytes: 40 * 1073741824,
          buildDiskReserveBytes: 5 * 1073741824,
          active: 1,
          maxConcurrentBuilds: 2,
        },
      ],
      'linux/arm64',
      null
    ),
    undefined
  )
  assert.equal(
    selectBuilder(
      [
        {
          ...mac,
          buildDiskBytes: 5 * 1073741824,
          buildCacheFreeBytes: 11 * 1073741824,
          buildDiskReserveBytes: 5 * 1073741824,
        },
      ],
      'linux/arm64',
      null
    )?.id,
    'mac'
  )
})
test('auto platforms include only nodes satisfying anti-affinity', () => {
  assert.deepEqual(
    planPlatforms(
      { ...service, antiAffinity: ['db'] },
      [node('mac', 'arm64'), node('pc', 'amd64')],
      { db: 'mac' }
    ),
    ['linux/amd64']
  )
})
