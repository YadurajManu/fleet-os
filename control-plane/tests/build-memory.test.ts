import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMemoryLimit } from '../src/build/platforms.js'
test('BuildKit memory scales above the old 2 GiB cap while preserving headroom', () => {
  assert.equal(buildMemoryLimit(8 * 1073741824), 6 * 1073741824)
  assert.equal(buildMemoryLimit(1073741824), 805306368)
  assert.throws(() => buildMemoryLimit(512 * 1048576), /at least 1 GiB/)
  assert.throws(() => buildMemoryLimit(NaN))
})
