import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, relative, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const run = promisify(execFile)

/**
 * Changing one line of a service's own source, reversibly.
 *
 * The case a manifest cannot reach. A service connected to the hostname
 * "redis" while the manifest named that database "cache"; the manifest side of
 * that is a rename, which Fleet refuses because renaming points a service at a
 * new volume. The other side is one line of Python, and until now nothing could
 * touch it.
 *
 * This is the furthest this system reaches into somebody's work, so the checks
 * are the point and the edit is almost incidental. Every one of them exists to
 * make the change undoable or to stop it happening at all:
 *
 *   - the file must sit inside the service's own build context, so a fix for
 *     one service cannot reach another's code, or anywhere else on the disk
 *   - the file must be tracked by git and have no uncommitted changes, so
 *     `git checkout` is a complete undo and nothing of the reader's is lost
 *   - the line must appear exactly once, so a match cannot silently hit the
 *     wrong place
 *   - one line replaces one line; a model asked for a file returns a file, and
 *     every line it did not mean to change is a silent regression
 */

export type SourceEdit = {
  service: string
  file: string
  find: string
  replace: string
  why: string
}

export type EditCheck =
  | { ok: true; path: string; line: number }
  | { ok: false; reason: string }

/** Where a service's build context is, according to the local manifest. */
export async function buildContextOf(root: string, service: string): Promise<string | null> {
  try {
    const doc = parseYaml(await readFile(join(root, 'fleet.yaml'), 'utf8')) as {
      services?: Record<string, { build?: string }>
    }
    return doc?.services?.[service]?.build ?? null
  } catch {
    return null
  }
}

async function git(root: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await run('git', args, { cwd: root })
    return { ok: true, out: stdout }
  } catch (err) {
    return { ok: false, out: (err as { stdout?: string }).stdout ?? '' }
  }
}

/**
 * Everything that must be true before a line of somebody's source is touched.
 *
 * Separated from applying it so the answer can be shown before anything
 * happens, and so each refusal can be tested without a repository being
 * modified to find out.
 */
export async function checkEdit(root: string, edit: SourceEdit): Promise<EditCheck> {
  const context = await buildContextOf(root, edit.service)
  if (!context) {
    return { ok: false, reason: `fleet.yaml does not say where "${edit.service}" is built from` }
  }

  const base = resolve(root, context)
  const path = resolve(base, edit.file)

  // Inside the service's own build context, and nowhere else. A path is checked
  // after resolving, so `../` cannot walk out of it.
  const within = relative(base, path)
  if (within.startsWith('..') || within.startsWith('/')) {
    return { ok: false, reason: `${edit.file} is outside ${context}, which is all this service may change` }
  }

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { ok: false, reason: `${edit.file} does not exist in ${context}` }
  }

  const occurrences = text.split(edit.find).length - 1
  if (occurrences === 0) {
    return { ok: false, reason: `that line is not in ${edit.file} — it may have been quoted from memory` }
  }
  if (occurrences > 1) {
    return {
      ok: false,
      reason: `that line appears ${occurrences} times in ${edit.file}, so a replacement could hit the wrong one`,
    }
  }

  // Undoable, which is the condition on all of this. A file git does not track,
  // or one already carrying uncommitted work, cannot be restored by checking it
  // out — and losing somebody's unsaved change to fix a hostname is not a trade
  // worth offering.
  const tracked = await git(root, ['ls-files', '--error-unmatch', path])
  if (!tracked.ok) {
    return { ok: false, reason: `${edit.file} is not tracked by git, so this could not be undone` }
  }
  const dirty = await git(root, ['status', '--porcelain', '--', path])
  if (dirty.out.trim()) {
    return { ok: false, reason: `${edit.file} has uncommitted changes — commit or stash them first, so this can be undone` }
  }

  const line = text.slice(0, text.indexOf(edit.find)).split('\n').length
  return { ok: true, path, line }
}

/** Apply a checked edit. Call `checkEdit` first; this trusts it. */
export async function applyEdit(path: string, edit: SourceEdit): Promise<void> {
  const text = await readFile(path, 'utf8')
  await writeFile(path, text.replace(edit.find, edit.replace))
}

/** Put a file back exactly as git has it. */
export async function revertEdit(root: string, path: string): Promise<boolean> {
  const out = await git(root, ['checkout', '--', path])
  return out.ok
}
