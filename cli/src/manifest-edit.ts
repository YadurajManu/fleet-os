import { readFile, writeFile } from 'node:fs/promises'
import { parseDocument } from 'yaml'
import { CliError, EXIT } from './api.js'

/**
 * Writing a measured fact into the manifest, instead of asking a person to
 * transcribe it.
 *
 * Fleet establishes things about a running service that no repository can
 * answer: which path it answers 2xx on, how much memory it actually uses. Until
 * now every one of those ended as a line of advice telling the reader to go and
 * edit `fleet.yaml` themselves — the system knowing the answer and asking for it
 * back.
 *
 * Shared by `fleet tune` and `fleet fix` deliberately. They edit the same file
 * under the same rules, and two implementations of that would drift: one would
 * learn to keep comments and the other would not, and nobody would notice until
 * a manifest came back stripped of the explanations `fleet init` wrote into it.
 */

export type ManifestEdit = {
  /** The service or database the field belongs to. */
  service: string
  field: string
  /** null removes the field — how a health check that answers nothing is taken out. */
  value: unknown
  why: string
}

/**
 * Fields the CLI will write. Deliberately the same set the control plane's
 * review is allowed to touch, and for the same reasons — see
 * `control-plane/src/ai/edits.ts`, which is the authority. Duplicated rather
 * than imported because the two do not share a package, and a copy that drifts
 * open is caught by the server refusing the edit anyway.
 */
const WRITABLE = new Set([
  'container_port',
  'health',
  'resources',
  'placement',
  'replicas',
  'env',
  'command',
])

export type EditOutcome = {
  applied: ManifestEdit[]
  refused: Array<{ edit: ManifestEdit; reason: string }>
  /** The document as it was, for putting back if the deploy goes badly. */
  before: string
}

/**
 * Apply edits to a manifest file in place.
 *
 * Edited as a document rather than parsed and re-serialised, so the comments
 * survive. A generated manifest's comments are the only thing explaining why it
 * looks the way it does, and a round trip through `parse`/`stringify` silently
 * removes every one of them.
 *
 * A service can live under `services:` or `databases:`; both are looked at,
 * because to everything downstream a database is a service and a reader
 * correcting one should not have to know which block the tool expects.
 */
export async function editManifest(
  path: string,
  edits: ManifestEdit[]
): Promise<EditOutcome> {
  const before = await readFile(path, 'utf8').catch(() => {
    throw new CliError(
      `No ${path} here. Run this from the project directory.`,
      EXIT.usage
    )
  })

  const doc = parseDocument(before)
  const applied: ManifestEdit[] = []
  const refused: Array<{ edit: ManifestEdit; reason: string }> = []

  for (const edit of edits) {
    if (!WRITABLE.has(edit.field)) {
      refused.push({ edit, reason: `"${edit.field}" is not a field this may write` })
      continue
    }

    const block = doc.hasIn(['services', edit.service])
      ? 'services'
      : doc.hasIn(['databases', edit.service])
        ? 'databases'
        : null

    if (!block) {
      refused.push({ edit, reason: `no service or database named "${edit.service}"` })
      continue
    }

    if (edit.value === null) doc.deleteIn([block, edit.service, edit.field])
    else doc.setIn([block, edit.service, edit.field], edit.value)
    applied.push(edit)
  }

  if (applied.length) await writeFile(path, String(doc))
  return { applied, refused, before }
}

/** Put a manifest back, after a change that made things worse. */
export async function restoreManifest(path: string, before: string): Promise<void> {
  await writeFile(path, before)
}
