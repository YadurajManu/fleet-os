import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'

test('every SQL migration is registered once in chronological journal order', async () => {
  const folder = new URL('../src/db/migrations/', import.meta.url)
  const files = (await readdir(folder)).filter(name => name.endsWith('.sql')).sort()
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', folder), 'utf8'))
  const entries = journal.entries as { idx: number; when: number; tag: string }[]
  assert.deepEqual(entries.map(entry => `${entry.tag}.sql`).sort(), files)
  entries.forEach((entry, index) => {
    assert.equal(entry.idx, index)
    if (index) assert.ok(entry.when > entries[index - 1]!.when)
  })
})
