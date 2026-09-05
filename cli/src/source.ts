import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * The few files a service is built from, for an investigation to read.
 *
 * The blind spot this closes. A service failed because `vote/app.py` hardcodes
 * `Redis(host="redis")` while the manifest names that database `cache`. The
 * diagnosis traced it correctly — unhealthy, then a Redis connection failure in
 * the logs — and stopped at "check the cache service", because every lookup it
 * has reads the database, a node's heartbeat, or a build-context listing, and
 * the answer was in none of them.
 *
 * Sent by the CLI rather than read by the control plane, which is the whole
 * design. The control plane deletes an uploaded build context the moment a
 * build ends, on purpose: customer source is held only for as long as it takes
 * to build it. A `source` lookup that read from the server would have to break
 * that. This way the source exists in one request, for the length of one
 * investigation, and is never written down.
 *
 * The cost is that it only works from a project directory. That is honest —
 * `fleet fix` already requires one, and a diagnosis run from elsewhere simply
 * reports that it has no source rather than pretending.
 */

/** Never read: build output, dependencies, and anything that is not evidence. */
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.next', '.nuxt',
  'coverage', '__pycache__', '.venv', 'venv', '.turbo', '.cache', 'tmp',
])

/**
 * What is worth reading, in the order it is worth reading.
 *
 * An entry point first, because that is where a program says what it connects
 * to — the hostname, the port, the environment variable it reads. Then the
 * dependency manifest, which says what it is. The Dockerfile last: the build
 * context listing already covers most of what it would tell us.
 */
const EVIDENCE: RegExp[] = [
  /^(main|app|server|index|program)\.(py|js|ts|mjs|go|rb|cs|java)$/i,
  /^(package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|.*\.csproj)$/i,
  /^\.env\.(example|sample|template)$/,
  /^Dockerfile(\..+)?$/,
]

/**
 * How much of one service to send.
 *
 * Small on purpose. This lands in a loop whose whole conversation is resent
 * every turn against a token budget that took real work to fit inside — the
 * compaction, the deadline and the step budget all exist because that budget
 * is tight. A generous source dump would undo all three.
 */
const MAX_PER_FILE = 2_000
const MAX_PER_SERVICE = 4_000

/** The head of a file: a program declares its connections near the top. */
function head(text: string, limit: number): string {
  return text.length <= limit ? text.trimEnd() : `${text.slice(0, limit)}\n… (truncated)`
}

async function filesIn(dir: string): Promise<string[]> {
  const found: string[] = []

  const walk = async (at: string, depth: number): Promise<void> => {
    if (depth > 2) return
    let entries
    try {
      entries = await readdir(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && !e.name.startsWith('.env.')) continue
      if (SKIP.has(e.name)) continue
      const full = join(at, e.name)
      if (e.isDirectory()) await walk(full, depth + 1)
      else if (EVIDENCE.some((r) => r.test(e.name))) found.push(full)
    }
  }

  await walk(dir, 0)
  // Evidence order, so a truncated bundle keeps the entry point rather than
  // whichever file the filesystem happened to return first.
  return found.sort((a, b) => {
    const rank = (p: string) =>
      EVIDENCE.findIndex((r) => r.test(p.split('/').pop() ?? '')) ?? EVIDENCE.length
    return rank(a) - rank(b)
  })
}

/** One service's source evidence, or null when there is nothing to read. */
export async function sourceFor(root: string, buildContext: string): Promise<string | null> {
  const dir = join(root, buildContext)
  try {
    if (!(await stat(dir)).isDirectory()) return null
  } catch {
    return null
  }

  const parts: string[] = []
  let budget = MAX_PER_SERVICE

  for (const file of await filesIn(dir)) {
    if (budget <= 0) break
    try {
      const info = await stat(file)
      if (info.size > 256 * 1024) continue
      const text = head(await readFile(file, 'utf8'), Math.min(MAX_PER_FILE, budget))
      const rel = file.slice(dir.length + 1)
      const block = `--- ${rel}\n${text}`
      parts.push(block)
      budget -= block.length
    } catch {
      // Unreadable is not fatal; it is simply not evidence.
    }
  }

  return parts.length ? parts.join('\n\n') : null
}

/**
 * Source for every service the local manifest builds, keyed by service name.
 *
 * Every service, because the investigation chooses which one it wants and the
 * CLI cannot know in advance. Only what it asks for is ever put in front of the
 * model, so the cost of the others is bytes on one request rather than tokens
 * on every turn.
 */
export async function localSource(root: string, manifestPath = 'fleet.yaml'): Promise<Record<string, string>> {
  let doc: { services?: Record<string, { build?: string }> }
  try {
    doc = parseYaml(await readFile(join(root, manifestPath), 'utf8')) ?? {}
  } catch {
    return {}
  }

  const out: Record<string, string> = {}
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    if (!svc?.build) continue
    const found = await sourceFor(root, svc.build)
    if (found) out[name] = found
  }
  return out
}
