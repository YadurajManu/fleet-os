import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'

export type Snapshot = { fingerprint: string; files: Record<string, string> }

/** Hash the extracted build context, including symlink targets but never following them. */
export async function snapshotDirectory(root: string): Promise<Snapshot> {
  const files: Record<string, string> = Object.create(null)
  const walk = async (dir: string, prefix = ''): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name
      const full = join(dir, name)
      const entry = await lstat(full)
      if (entry.isDirectory()) await walk(full, path)
      else if (entry.isFile()) files[path] = createHash('sha256').update(`file\0${entry.mode & 0o7777}\0`).update(await readFile(full)).digest('hex')
      else if (entry.isSymbolicLink()) files[path] = createHash('sha256').update(`symlink\0${entry.mode & 0o7777}\0${await readlink(full)}`).digest('hex')
      else files[path] = createHash('sha256').update(`special\0${entry.mode}`).digest('hex')
    }
  }
  await walk(root)
  const digest = createHash('sha256')
  for (const path of Object.keys(files).sort()) digest.update(path).update('\0').update(files[path]!).update('\n')
  return { fingerprint: digest.digest('hex'), files }
}

export function compareSnapshots(current: Snapshot, previous?: Snapshot | null) {
  if (!previous) return null
  const added = Object.keys(current.files).filter((path) => !Object.hasOwn(previous.files, path)).sort()
  const modified = Object.keys(current.files).filter((path) => Object.hasOwn(previous.files, path) && current.files[path] !== previous.files[path]).sort()
  const removed = Object.keys(previous.files).filter((path) => !Object.hasOwn(current.files, path)).sort()
  return { added, modified, removed }
}
