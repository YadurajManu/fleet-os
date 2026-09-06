import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBuilderRouting,
  parseInspectPlatforms,
  planBuilds,
  cacheRefFor,
} from '../src/build/buildx.js'

describe('which builder serves which platform', () => {
  test('reads pairs, and ignores what it cannot read', () => {
    const routing = parseBuilderRouting('linux/arm64=arm, linux/amd64=main, rubbish, =nameless, plat=')
    assert.equal(routing.get('linux/arm64'), 'arm')
    assert.equal(routing.get('linux/amd64'), 'main')
    assert.equal(routing.size, 2)
  })

  test('nothing configured is not an error', () => {
    assert.equal(parseBuilderRouting(undefined).size, 0)
    assert.equal(parseBuilderRouting('').size, 0)
  })
})

describe('what a builder can actually do', () => {
  // The asterisk is the whole point: linux/arm64 and linux/arm64* are the
  // difference between forty seconds and twenty minutes.
  const INSPECT = `Name:          fleet-builder
Driver:        docker-container

Nodes:
Name:      fleet-builder0
Endpoint:  unix:///var/run/docker.sock
Status:    running
Platforms: linux/amd64, linux/amd64/v2, linux/arm64*, linux/arm/v7*

Name:      fleet-builder-arm64
Endpoint:  ssh://ubuntu@10.0.1.42
Status:    running
Platforms: linux/arm64, linux/arm/v7*
`

  test('separates native from emulated', () => {
    const { native, emulated } = parseInspectPlatforms(INSPECT)
    assert.ok(native.has('linux/amd64'))
    assert.ok(native.has('linux/arm64'), 'the arm64 node makes arm64 native')
    assert.ok(emulated.has('linux/arm/v7'))
  })

  test('a platform one node does natively is not emulated', () => {
    // The amd64 node reports linux/arm64*, the arm64 node reports linux/arm64.
    // Reading them independently would call the fast path emulated.
    const { emulated } = parseInspectPlatforms(INSPECT)
    assert.equal(emulated.has('linux/arm64'), false)
  })

  // buildx v0.30 prints no asterisks at all, so ordering is the only signal.
  // This is the real output of a native arm64 daemon with binfmt installed.
  test('an unmarked list is read by node ordering', () => {
    const { native, emulated } = parseInspectPlatforms(
      'Platforms: linux/arm64, linux/amd64, linux/amd64/v2, linux/riscv64, linux/arm/v7'
    )
    assert.ok(native.has('linux/arm64'), 'the first platform is the node\'s own')
    assert.ok(emulated.has('linux/amd64'), 'amd64 on an arm64 daemon is QEMU')
    assert.ok(emulated.has('linux/arm/v7'))
    assert.equal(native.size, 1)
  })

  test('an amd64 control plane reports arm64 as emulated', () => {
    const { native, emulated } = parseInspectPlatforms(
      'Platforms: linux/amd64, linux/amd64/v2, linux/arm64, linux/arm/v7'
    )
    assert.ok(native.has('linux/amd64'))
    assert.ok(native.has('linux/amd64/v2'), 'a variant of the host arch is still native')
    assert.ok(emulated.has('linux/arm64'), 'this is the twenty-minute path')
  })

  test('an empty inspect claims nothing rather than claiming none', () => {
    const { native, emulated } = parseInspectPlatforms('')
    assert.equal(native.size, 0)
    assert.equal(emulated.size, 0)
  })
})

describe('planning a build across builders', () => {
  test('one group when nothing is routed', () => {
    const plan = planBuilds(['linux/amd64', 'linux/arm64'], new Map(), 'fleet-builder')
    assert.equal(plan.length, 1)
    assert.deepEqual(plan[0]!.platforms, ['linux/amd64', 'linux/arm64'])
    assert.equal(plan[0]!.builder, 'fleet-builder')
  })

  test('a group per builder when they differ', () => {
    const routing = parseBuilderRouting('linux/arm64=arm64-native')
    const plan = planBuilds(['linux/amd64', 'linux/arm64'], routing, 'fleet-builder')
    assert.equal(plan.length, 2)
    assert.deepEqual(plan[0], { builder: 'fleet-builder', platforms: ['linux/amd64'] })
    assert.deepEqual(plan[1], { builder: 'arm64-native', platforms: ['linux/arm64'] })
  })

  test('platforms routed to the same builder stay in one build', () => {
    const routing = parseBuilderRouting('linux/arm64=multi,linux/amd64=multi')
    const plan = planBuilds(['linux/amd64', 'linux/arm64'], routing, undefined)
    assert.equal(plan.length, 1)
    assert.deepEqual(plan[0]!.platforms, ['linux/amd64', 'linux/arm64'])
  })

  test('no default builder is its own group, not merged into a named one', () => {
    const routing = parseBuilderRouting('linux/arm64=arm64-native')
    const plan = planBuilds(['linux/amd64', 'linux/arm64'], routing, undefined)
    assert.equal(plan.length, 2)
    assert.equal(plan[0]!.builder, undefined)
  })
})

describe('where the build cache lives', () => {
  test('a ref per platform group, so two groups do not overwrite each other', () => {
    const amd = cacheRefFor('localhost:5001/api:abc123', ['linux/amd64'])
    const arm = cacheRefFor('localhost:5001/api:abc123', ['linux/arm64'])
    assert.notEqual(amd, arm)
    assert.equal(amd, 'localhost:5001/api:buildcache-linux-amd64')
  })

  test('the registry port is not mistaken for a tag', () => {
    assert.ok(cacheRefFor('localhost:5001/api:abc', ['linux/arm64']).startsWith('localhost:5001/api:'))
  })

  test('order does not change the ref, so a cache is not missed by a reordering', () => {
    const a = cacheRefFor('r/app:1', ['linux/amd64', 'linux/arm64'])
    const b = cacheRefFor('r/app:1', ['linux/arm64', 'linux/amd64'])
    assert.equal(a, b)
  })
})
