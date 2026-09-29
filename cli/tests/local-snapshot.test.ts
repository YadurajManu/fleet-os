import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packContext, snapshotArchive } from '../src/archive.js'
import { compareSnapshots } from '../src/snapshot.js'

test('local snapshot hashes only the included build context and compares file changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-snapshot-'))
  try {
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'node_modules', 'ignored.js'), 'ignored')
    await writeFile(join(dir, '.dockerignore'), 'secret.txt\n')
    await writeFile(join(dir, 'secret.txt'), 'not uploaded')
    await writeFile(join(dir, 'Dockerfile'), 'FROM scratch\n')
    await writeFile(join(dir, 'app.txt'), 'one')
    await writeFile(join(dir, '__proto__'), 'ordinary source file')
    const first = await snapshotArchive(await packContext(dir))
    assert.deepEqual(Object.keys(first.files).sort(), ['.dockerignore', 'Dockerfile', '__proto__', 'app.txt'])

    await writeFile(join(dir, 'app.txt'), 'two')
    await writeFile(join(dir, 'new.txt'), 'new')
    const second = await snapshotArchive(await packContext(dir))
    assert.notEqual(first.fingerprint, second.fingerprint)
    assert.deepEqual(compareSnapshots(second, first), { added: ['new.txt'], modified: ['app.txt'], removed: [] })

    await writeFile(join(dir, 'secret.txt'), 'still not uploaded')
    const ignoredChange = await snapshotArchive(await packContext(dir))
    assert.equal(ignoredChange.fingerprint, second.fingerprint)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
