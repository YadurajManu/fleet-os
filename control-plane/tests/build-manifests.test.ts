import { test } from 'node:test'
import assert from 'node:assert/strict'
import { manifestPlatforms, pinnedImage } from '../src/build/manifests.js'
test('image indexes exclude attestations and Windows containers', () => {
  assert.deepEqual(
    manifestPlatforms({
      manifests: [
        { platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } },
        { platform: { os: 'linux', architecture: 'arm', variant: 'v7' } },
        { platform: { os: 'windows', architecture: 'amd64' } },
        { platform: { os: 'unknown', architecture: 'unknown' } },
      ],
    }),
    ['linux/arm64', 'linux/arm/v7']
  )
})
test('digest references remove mutable tags while preserving registry ports', () => {
  assert.equal(
    pinnedImage('registry.test:5000/app:latest', 'sha256:abc'),
    'registry.test:5000/app@sha256:abc'
  )
  // Bare library images are qualified so Docker 28+ does not reject the digest pull.
  assert.equal(pinnedImage('alpine', 'sha256:abc'), 'docker.io/library/alpine@sha256:abc')
  assert.equal(pinnedImage('postgres:16-alpine', 'sha256:abc'), 'docker.io/library/postgres@sha256:abc')
})
