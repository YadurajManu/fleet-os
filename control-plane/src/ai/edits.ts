import { parseDocument, isMap } from 'yaml'
import { firstObject, snippet } from './json.js'

/**
 * A review expressed as edits rather than as a rewritten manifest.
 *
 * The whole-manifest form has three costs that only show up in use. The model
 * has to reproduce every line it is not changing, which is most of them, and
 * any slip there is a silent regression — it removed a `build:` that way and
 * deployed a bare nginx over somebody's site. It cannot be done per service,
 * because each pass would return a manifest missing the others. And a
 * round-trip through parse and re-serialise destroys the comments `init`
 * wrote, which are the only explanation a generated file carries.
 *
 * Edits fix all three. A pass returns what it wants changed and nothing else,
 * so a service it was not shown cannot be damaged; the passes compose; and the
 * document is edited in place, so comments and layout survive untouched.
 */

export type Edit = {
  service: string
  field: string
  /** null removes the field — how a wrong health check gets taken out. */
  value: string | number | boolean | null
  why: string
}

/** Fields a review may change. Anything else is refused, not applied. */
const EDITABLE = new Set([
  'container_port',
  'health',
  'resources',
  'placement',
  'replicas',
  'env',
  'command',
])

/**
 * Fields it may never change, and why each one is dangerous.
 *
 * `node` names a machine, which no repository knows about — a review invented
 * one from a compose service name. `build` and `image` decide where the code
 * comes from; swapping build for image deployed a public nginx in place of a
 * site. `uses` and `volume` decide placement and data, and getting either
 * wrong moves a database away from its disk.
 */
const FORBIDDEN = new Set(['node', 'build', 'image', 'uses', 'volume', 'name'])

/**
 * The shape the manifest wants, from the shape a model naturally writes.
 *
 * `health: /healthz` is the obvious way to say it and the manifest wants
 * `health: { path: /healthz }`. Without this the whole review is discarded —
 * the merged manifest fails the parser and the draft is kept — over a
 * difference in spelling that costs one line to accept. Only for fields where
 * the short form is unambiguous; anything else is passed through and stands or
 * falls on the parser.
 */
function shape(field: string, value: Edit['value']): unknown {
  if (field === 'health' && typeof value === 'string') return { path: value }
  return value
}

/**
 * Whether an edit may be applied by a machine, and why not when it may not.
 *
 * Separated from `applyEdits` because a refusal is worth reporting rather than
 * discarding. The first real candidate for an automatic fix was a service whose
 * application connects to the hostname "redis" against a database the manifest
 * had named "cache" -- correct diagnosis, and the fix is a rename, which is
 * exactly what this refuses. Renaming a service points it at a new volume: for
 * a cache that is harmless and for a database it silently abandons the data, so
 * the difference cannot be left to a model's judgement about which one it is
 * looking at.
 *
 * A refused fix is still the answer. It is told to the operator in words, to
 * carry out themselves, rather than performed.
 */
export function applicability(edit: Edit): { applicable: boolean; reason?: string } {
  if (FORBIDDEN.has(edit.field)) {
    return {
      applicable: false,
      reason:
        edit.field === 'name'
          ? 'Renaming a service points it at a new volume — harmless for a cache, and data loss for a database. Do this one by hand.'
          : `"${edit.field}" decides where the code or the data comes from, which nothing automatic should change.`,
    }
  }
  if (!EDITABLE.has(edit.field)) {
    return { applicable: false, reason: `"${edit.field}" is not a field a review may change.` }
  }
  return { applicable: true }
}

/**
 * Rename a service or database, and everything that refers to it.
 *
 * A name is not a label. It is the hostname other services resolve, so a
 * rename that changed only the key would leave every `uses:` and every
 * `affinity:` pointing at something that no longer exists — a manifest that
 * parses and cannot work, which is worse than refusing.
 */
function rename(doc: ReturnType<typeof parseDocument>, edit: Edit): boolean {
  const to = String(edit.value)
  const block = ['services', 'databases'].find((b) => {
    const m = doc.get(b)
    return isMap(m) && m.has(edit.service)
  })
  if (!block) return false

  const map = doc.get(block)
  if (!isMap(map)) return false

  const body = map.get(edit.service)
  map.delete(edit.service)
  map.set(to, body)

  // Every reference, in both blocks. A service that used the old name must
  // follow it, or the rename trades one broken lookup for another.
  for (const b of ['services', 'databases']) {
    const m = doc.get(b)
    if (!isMap(m)) continue
    for (const item of m.items) {
      const name = String((item as { key?: unknown }).key)
      for (const field of ['uses', 'affinity', 'anti_affinity']) {
        const list = doc.getIn([b, name, field])
        if (!Array.isArray((list as { items?: unknown[] })?.items)) continue
        const items = (list as { items: Array<{ value?: unknown }> }).items
        for (const entry of items) {
          if (String(entry.value) === edit.service) entry.value = to
        }
      }
    }
  }

  return true
}


/**
 * Comments that exist only to explain a field's absence.
 *
 * `init` writes these where it refused to guess, and they are the only
 * explanation a generated file carries — which is why `applyEdits` edits the
 * document in place rather than rebuilding it. But an explanation of an
 * omission is false the moment the omission is filled, and a review that adds
 * a health check leaves the file saying "No health check" directly above one.
 * A reader then has to work out which half to believe, which is worse than
 * having no comment at all.
 *
 * Matched per line rather than as a block: the `yaml` parser hands back every
 * adjacent comment line as one string attached to whatever follows, so a block
 * removed wholesale would take an unrelated neighbouring comment with it.
 */
const OMISSION_COMMENT: Record<string, RegExp> = {
  health:
    /no health check|is up\. add one once you know|health: \{ path|note the probe runs from the node|container, so the image needs nothing/i,
}

/**
 * Drop the comment explaining why `field` was left out.
 *
 * The comment is not attached to the field it describes — there is no such
 * field, that being the point. The parser attaches a run of comment lines to
 * the key that follows them, or to the map itself when nothing does, so both
 * have to be searched.
 */
function dropOmissionComment(body: unknown, field: string): void {
  const pattern = OMISSION_COMMENT[field]
  if (!pattern || !isMap(body)) return

  const clean = (text: string | null | undefined): string | undefined => {
    if (!text) return text ?? undefined
    const kept = text.split('\n').filter((line) => !pattern.test(line))
    // Every line went: remove the comment rather than leaving an empty one,
    // which renders as a bare `#`.
    return kept.length ? kept.join('\n') : undefined
  }

  for (const item of body.items as Array<{ key?: { commentBefore?: string | null } }>) {
    if (item.key?.commentBefore) item.key.commentBefore = clean(item.key.commentBefore) ?? null
  }
  const map = body as { comment?: string | null }
  if (map.comment) map.comment = clean(map.comment) ?? null
}

export type ApplyResult = {
  manifest: string
  applied: Edit[]
  refused: Array<{ edit: Edit; reason: string }>
}

/**
 * Apply edits to a manifest, keeping everything they do not mention.
 *
 * Edited as a document rather than an object: `init` writes comments
 * explaining what it could not determine, and a service carrying "# No health
 * check: container state decides whether this is up" loses the one thing
 * telling the reader why, the moment the file is rebuilt from parsed values.
 */
export function applyEdits(
  manifest: string,
  edits: Edit[],
  /**
   * Service names that already hold data in this fleet.
   *
   * The forbidden list is calibrated for a running fleet: renaming a service
   * points it at a new volume, which is nothing for a cache and data loss for a
   * database. At `init` time none of that is true — the manifest is a draft and
   * nothing has been deployed — so the rule is not "never rename" but "never
   * rename something that has data", and the control plane knows which those
   * are rather than having to guess from the engine.
   *
   * Empty means nothing is protected, which is correct for a draft and wrong
   * for anything else, so callers pass it deliberately.
   */
  holdsData: Set<string> = new Set()
): ApplyResult {
  const doc = parseDocument(manifest)
  const applied: Edit[] = []
  const refused: Array<{ edit: Edit; reason: string }> = []

  const services = doc.get('services')
  if (!isMap(services)) {
    return { manifest, applied, refused: edits.map((edit) => ({ edit, reason: 'no services block' })) }
  }

  for (const edit of edits) {
    // A rename of something with nothing to lose.
    //
    // The case this exists for: `init` named a Redis database "cache", because
    // the compose file did, while the application connects to the hostname
    // "redis" -- and Fleet resolves a database by the name the manifest gives
    // it, so every request failed. The review could see both facts and was not
    // allowed to reconcile them.
    if (edit.field === 'name' && typeof edit.value === 'string' && !holdsData.has(edit.service)) {
      const renamed = rename(doc, edit)
      if (renamed) applied.push(edit)
      else refused.push({ edit, reason: `no service or database named "${edit.service}"` })
      continue
    }

    if (FORBIDDEN.has(edit.field)) {
      refused.push({
        edit,
        reason:
          edit.field === 'name'
            ? `"${edit.service}" already holds data in this fleet — renaming it would point it at a new volume`
            : `"${edit.field}" is not something a repository can decide`,
      })
      continue
    }
    if (!EDITABLE.has(edit.field)) {
      refused.push({ edit, reason: `"${edit.field}" is not an editable field` })
      continue
    }
    if (!services.has(edit.service)) {
      // A service the manifest does not have. Adding one from a review would
      // deploy something nobody asked for.
      refused.push({ edit, reason: `no service named "${edit.service}"` })
      continue
    }

    if (edit.value === null) {
      doc.deleteIn(['services', edit.service, edit.field])
    } else {
      doc.setIn(['services', edit.service, edit.field], shape(edit.field, edit.value))
      // The file explained why this field was missing. It is not missing now.
      dropOmissionComment(doc.getIn(['services', edit.service]), edit.field)
    }
    applied.push(edit)
  }

  return { manifest: applied.length ? String(doc) : manifest, applied, refused }
}

/** Pull the edits out of a reply that may be fenced or padded with prose. */
export function parseEdits(content: string): { edits: Edit[]; questions: unknown[] } {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced?.[1] ?? content).trim()
  // Brace-matched, not first-`{`-to-last-`}`. Reviewing a four-service draft on
  // a free Nemotron, every service failed with "Unexpected non-whitespace
  // character after JSON at position 36": the reply was two objects in a row
  // and the naive span joined them into something that parsed as neither, with
  // the whole usable answer sitting in the first 36 characters.
  const object = firstObject(raw)
  if (!object) throw new Error(`the model did not return JSON — it replied: ${snippet(raw)}`)

  const parsed = JSON.parse(object) as { edits?: unknown; questions?: unknown }

  // A malformed edit is dropped rather than failing the pass: the others are
  // still good, and one bad entry should not cost a whole service's review.
  const edits: Edit[] = Array.isArray(parsed.edits)
    ? (parsed.edits as unknown[])
        .filter((e): e is Edit => {
          const c = e as Partial<Edit>
          return (
            typeof c?.service === 'string' &&
            typeof c?.field === 'string' &&
            typeof c?.why === 'string' &&
            (c.value === null ||
              typeof c.value === 'string' ||
              typeof c.value === 'number' ||
              typeof c.value === 'boolean' ||
              (typeof c.value === 'object' && c.value !== null))
          )
        })
        .slice(0, 8)
    : []

  return { edits, questions: Array.isArray(parsed.questions) ? parsed.questions : [] }
}
