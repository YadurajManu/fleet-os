import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { planFromManifest } from '../src/plan.js'
import { packContext, checkUploadSize, uploadLimit } from '../src/archive.js'
import { parseArgs } from '../src/args.js'
import { composeToFleet } from '../src/compose.js'
import { buildContextOf } from '../src/source-edit.js'
import { parse as parseYaml } from 'yaml'

test('.fleetignore and .dockerignore both apply while the selected Dockerfile travels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-ignore-'))
  try {
    await mkdir(join(dir, 'docker'))
    await writeFile(join(dir, 'docker', 'Worker'), 'FROM scratch\n')
    await writeFile(join(dir, 'app.js'), 'hello')
    await writeFile(join(dir, 'mobile.apk'), 'large artifact')
    await writeFile(join(dir, 'cache.tmp'), 'cache')
    await writeFile(join(dir, '.dockerignore'), '*.tmp\ndocker/Worker\n')
    await writeFile(join(dir, '.fleetignore'), '*.apk\n')
    const archive = await packContext(dir, 'docker/Worker')
    const listing = execFileSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8' })
    assert.match(listing, /docker\/Worker/)
    assert.match(listing, /app.js/)
    assert.doesNotMatch(listing, /mobile.apk|cache.tmp/)
    await writeFile(join(dir, '.fleetignore'), '!private.env\n')
    await assert.rejects(packContext(dir, 'docker/Worker'), /exclusion patterns only/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('upload limits are validated and reject oversized snapshots before transfer', () => {
  const previous = process.env.FLEET_MAX_UPLOAD_BYTES
  try {
    process.env.FLEET_MAX_UPLOAD_BYTES = '1024'
    assert.equal(uploadLimit(), 1024)
    assert.doesNotThrow(() => checkUploadSize(1024))
    assert.throws(() => checkUploadSize(1025), /\.fleetignore/)
    process.env.FLEET_MAX_UPLOAD_BYTES = 'NaN'
    assert.throws(() => uploadLimit(), /integer/)
  } finally {
    if (previous === undefined) delete process.env.FLEET_MAX_UPLOAD_BYTES
    else process.env.FLEET_MAX_UPLOAD_BYTES = previous
  }
})

test('preserving a custom Dockerfile never exposes an excluded parent directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-ignore-private-'))
  try {
    await mkdir(join(dir, 'docker'))
    await writeFile(join(dir, 'docker', 'Worker'), 'FROM scratch\n')
    await writeFile(join(dir, 'docker', 'private.txt'), 'must stay excluded')
    await writeFile(join(dir, '.dockerignore'), 'docker/*\n')
    const listing = execFileSync('tar', ['-tzf', '-'], { input: await packContext(dir, 'docker/Worker'), encoding: 'utf8' })
    assert.doesNotMatch(listing, /private.txt|docker\/Worker/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
