import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRepos } from '../src/github/app.js'

test('installation catalog includes private repositories beyond the first 100', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-github-test-'))
  const key = join(dir, 'key.pem')
  await writeFile(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const original = globalThis.fetch
  const pages: number[] = []
  globalThis.fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'test-only', expires_at: new Date(Date.now() + 3600000).toISOString() })
    const page = Number(url.searchParams.get('page'))
    pages.push(page)
    return Response.json({ repositories: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ full_name: `owner/repo-${i}` })) : [{ full_name: 'owner/private-new', private: true }] })
  }
  try {
    const repos = await listRepos({ appId: 'test', privateKeyPath: key }, 987654321)
    assert.deepEqual(pages, [1, 2])
    assert.equal(repos.length, 101)
    assert.equal(repos.at(-1)?.full_name, 'owner/private-new')
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})
