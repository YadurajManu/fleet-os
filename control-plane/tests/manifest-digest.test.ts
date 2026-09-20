import test from 'node:test'
import assert from 'node:assert/strict'
import { manifestDigest } from '../src/build/manifests.js'

test('reads the Buildx 0.19 JSON manifest descriptor instead of treating human output as a digest', () => {
  const digest = `sha256:${'a'.repeat(64)}`
  assert.equal(manifestDigest(JSON.stringify({ schemaVersion: 2, digest, manifests: [] })), digest)
  assert.throws(() => manifestDigest('Name: postgres:16-alpine\nDigest: ' + digest))
  assert.throws(() => manifestDigest('{"digest":"sha256:"}'))
  assert.throws(() => manifestDigest('{}'))
})
