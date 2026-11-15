import test from 'node:test'
import assert from 'node:assert/strict'
import { RELEASE_COMPONENTS, RELEASES, RELEASES_CHECKED_AT } from '../src/lib/releases.js'
test('release catalog separates published packages, hosted distributions and previews', () => {
  assert.deepEqual(RELEASE_COMPONENTS.map(c => c.id), ['cli','server','agent'])
  assert.equal(new Set(RELEASES.map(r => r.id)).size, RELEASES.length)
  assert.ok(Number.isFinite(Date.parse(RELEASES_CHECKED_AT)))
  for (const entry of [...RELEASE_COMPONENTS, ...RELEASES]) {
    assert.match(entry.version, /^\d+\.\d+\.\d+$/)
    assert.equal(new URL(entry.sourceUrl).protocol, 'https:')
    if (entry.publishedAt) assert.ok(Number.isFinite(Date.parse(entry.publishedAt)))
  }
  assert.equal(RELEASE_COMPONENTS.find(c => c.id === 'agent').publishedAt, null)
  assert.match(RELEASES.find(r => r.component === 'agent').channel, /preview/i)
  assert.ok(RELEASES.every((entry, i) => i === 0 || Date.parse(RELEASES[i-1].publishedAt) >= Date.parse(entry.publishedAt)))
})
test('upgrade commands do not imply npm updates servers or silently enable all agents', () => {
  assert.match(RELEASE_COMPONENTS[0].command, /npm install -g @yadurajfleetos\/cli@latest/)
  assert.match(RELEASE_COMPONENTS[1].command, /upgrade\.sh check[\s\S]*upgrade\.sh apply/)
  assert.equal(RELEASE_COMPONENTS[2].command, 'fleet updates')
  assert.match(RELEASE_COMPONENTS[2].note, /one node/)
})
