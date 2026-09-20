import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { suggest } from '../src/suggestions.js'
import { usage, welcomeBox } from '../src/index.js'

describe('error recovery suggestions', () => {
  test('suggests actions for port in use errors', () => {
    const s = suggest('listen tcp :3000: bind: address already in use')
    assert.ok(s)
    assert.ok(s.some((line) => line.includes('fleet services')))
    assert.ok(s.some((line) => line.includes('fleet down')))
  })

  test('suggests actions when no eligible nodes exist', () => {
    const s = suggest('no eligible node found for service placement')
    assert.ok(s)
    assert.ok(s.some((line) => line.includes('fleet nodes')))
    assert.ok(s.some((line) => line.includes('fleet nodes pair')))
  })

  test('suggests actions for missing container images', () => {
    const s = suggest('manifest unknown: repository does not exist')
    assert.ok(s)
    assert.ok(s.some((line) => line.includes('fleet.yaml')))
  })

  test('suggests actions for health check failures', () => {
    const s = suggest('health check failed: service returned 502')
    assert.ok(s)
    assert.ok(s.some((line) => line.includes('fleet logs')))
    assert.ok(s.some((line) => line.includes('fleet explain')))
  })

  test('suggests actions for connection refused to control plane', () => {
    const s = suggest('Could not reach control plane: connect ECONNREFUSED 127.0.0.1:8080')
    assert.ok(s)
    assert.ok(s.some((line) => line.includes('control plane is running')))
    assert.ok(s.some((line) => line.includes('fleet config show')))
  })

  test('suggests actions when session has expired', () => {
    const s = suggest('your session has expired, please log in again')
    assert.ok(s)
    assert.ok(s.some((line) => line.includes('fleet auth login')))
  })

  test('suggests actions when missing Dockerfile', () => {
    const s = suggest('Dockerfile not found in repository root')
    assert.ok(s)
    assert.ok(s.some((line) => line.includes('fleet init')))
  })

  test('suggests actions when disk is full', () => {
    const s = suggest('write /var/lib/docker: no space left on device')
    assert.ok(s)
    assert.ok(s.some((line) => line.includes('docker system prune')))
    assert.ok(s.some((line) => line.includes('fleet doctor')))
  })

  test('caps suggestions at max limit', () => {
    const s = suggest('timed out connection ECONNREFUSED address already in use', 2)
    assert.ok(s)
    assert.ok(s.length <= 2)
  })

  test('returns null for unrecognized messages', () => {
    const s = suggest('something completely unprecedented happened')
    assert.equal(s, null)
  })

  test('returns null for empty strings', () => {
    assert.equal(suggest(''), null)
  })
})

describe('welcome box and first-run help', () => {
  test('welcomeBox renders start steps and doc link', () => {
    const box = welcomeBox()
    assert.ok(box.includes('First time? Start here:'))
    assert.ok(box.includes('fleet auth login'))
    assert.ok(box.includes('fleet nodes pair'))
    assert.ok(box.includes('fleet up'))
    assert.ok(box.includes('https://fleet.plastikworld.xyz/#/docs'))
  })

  test('usage(true) appends welcome box', () => {
    const outWith = usage(true)
    assert.ok(outWith.includes('First time? Start here:'))
    assert.ok(outWith.includes('fleet auth login'))
  })

  test('usage(false) omits welcome box', () => {
    const outWithout = usage(false)
    assert.ok(!outWithout.includes('First time? Start here:'))
  })
})
