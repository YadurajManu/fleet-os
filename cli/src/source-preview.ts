import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { request } from './api.js'
import { packContext, snapshotArchive, humanBytes, ignorePatterns } from './archive.js'
import { compareSnapshots, type Snapshot } from './snapshot.js'

type Baseline = { release: {
  id: string
  gitSha: string | null
  buildContext: { snapshot?: Snapshot & { manifestHash?: string } } | null
} | null }

async function gitContext(dir: string): Promise<string | null> {
  try {
    const run = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: dir })).stdout.trim()
    const branch = await run('branch', '--show-current')
    const sha = await run('rev-parse', '--short', 'HEAD')
    const dirty = Boolean(await run('status', '--porcelain', '--untracked-files=normal', '--', '.'))
    return `${branch || 'detached'} · ${sha}${dirty ? ' + uncommitted changes' : ''}`
  } catch {
    return null
  }
}

export async function localPreview(serviceId: string, dir: string, manifestPath?: string) {
  const archive = await packContext(dir)
  const snapshot = await snapshotArchive(archive)
  const { body } = await request<Baseline>('GET', `/services/${serviceId}/source-baseline`)
  const previous = body.release?.buildContext?.snapshot
  const diff = compareSnapshots(snapshot, previous)
  const manifestHash = manifestPath
    ? createHash('sha256').update(await readFile(manifestPath)).digest('hex')
    : undefined
  return {
    archive, snapshot, previous: body.release, diff, manifestHash,
    git: await gitContext(dir),
    ignored: await ignorePatterns(dir),
  }
}

export function printLocalPreview(name: string, dir: string, preview: Awaited<ReturnType<typeof localPreview>>, manifestApplied = false) {
  console.log(`\nLocal snapshot for ${name}`)
  console.log(`  Source       local · ${JSON.stringify(dir)}`)
  console.log(`  Snapshot     ${preview.snapshot.fingerprint.slice(0, 12)}`)
  console.log(`  Included     ${Object.keys(preview.snapshot.files).length} files`)
  if (preview.git) console.log(`  Git context  ${preview.git}`)
  if (preview.previous) {
    const previousSource = preview.previous.buildContext?.snapshot
      ? `Local snapshot ${preview.previous.buildContext.snapshot.fingerprint.slice(0, 12)}`
      : preview.previous.gitSha ? `Git ${preview.previous.gitSha.slice(0, 12)}` : 'prebuilt image or older release'
    console.log(`  Compared     ${previousSource} · release ${preview.previous.id.slice(0, 8)}`)
  }
  if (preview.diff) {
    for (const [label, files] of Object.entries(preview.diff)) {
      console.log(`  ${label.padEnd(12)} ${files.length}${files.length ? ` · ${files.slice(0, 5).map((path) => JSON.stringify(path)).join(', ')}${files.length > 5 ? ', …' : ''}` : ''}`)
    }
  } else if (preview.previous) {
    console.log('  Compared     previous release has no local file hashes; source switch or older CLI')
  } else console.log('  Compared     no verified successful release')
  if (preview.manifestHash && preview.previous?.buildContext?.snapshot?.manifestHash) {
    console.log(`  Manifest     ${preview.manifestHash === preview.previous.buildContext.snapshot.manifestHash ? 'local file unchanged' : manifestApplied ? 'local file changed · applied by fleet up' : 'local file changed · run fleet apply to update service settings'}`)
  } else console.log('  Manifest     no previous manifest fingerprint')
  console.log(`  Excluded     ${preview.ignored.map((pattern) => JSON.stringify(pattern)).join(', ')}`)
  console.log(`  Upload       ${humanBytes(preview.archive.length)}`)
}
