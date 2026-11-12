/**
 * Packing a build context.
 *
 * `build:` used to mean "only via a git push", because a checkout on the
 * control plane was the one context a build could run against. This sends the
 * directory instead, so a deploy from a laptop builds the same way a pushed
 * commit does — and Fleet, which can see the fleet's architectures, builds for
 * all of them rather than leaving you to notice that the image you made on an
 * Apple laptop will not start on an amd64 node.
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CliError, EXIT } from './api.js'
import { snapshotDirectory, type Snapshot } from './snapshot.js'

/**
 * Excluded even when no .dockerignore says so.
 *
 * These are never part of an image and are the difference between an upload of
 * a few hundred kilobytes and one of several hundred megabytes. A Dockerfile
 * that genuinely needs .git is rare enough to be worth an explicit exception
 * later rather than a slow upload for everybody now.
 */
const ALWAYS_EXCLUDE = ['.git', 'node_modules', '.DS_Store']

/**
 * Patterns that must never be honoured, however the .dockerignore is written.
 *
 * `Dockerfile` in a .dockerignore is standard, recommended practice: a local
 * `docker build` reads it from the host rather than from the context, so
 * excluding it avoids shipping it twice. Here the context is built somewhere
 * else, and the Dockerfile has to travel with it — honouring that line
 * produces "failed to read dockerfile" on a context that is otherwise perfect.
 *
 * A bare `*` is the other one. It is the whitelist idiom, always paired with
 * `!keep-this` lines, and since negations are not supported it would otherwise
 * mean "exclude the entire project".
 */
function mustNotExclude(pattern: string, dockerfile = 'Dockerfile'): boolean {
  const p = pattern.replace(/^\.?\//, '').replace(/^\*\*\//, '')
  if (p === '*' || p === '**' || p === '.') return true
  const selected = dockerfile.replace(/^\.\//, '')
  if (p === selected) return true
  return /^\*?dockerfile/i.test(p)
}

/**
 * Read .dockerignore into tar exclusion patterns.
 *
 * The two formats are close but not identical: .dockerignore has negations
 * (`!keep-this`) and anchors paths at the context root. Negations are dropped
 * rather than half-implemented — including a file that should have been
 * excluded is a slow upload, whereas excluding one that should have been kept
 * is a broken build, and silently doing the second would be worse.
 */
export async function ignorePatterns(dir: string, dockerfile = 'Dockerfile'): Promise<string[]> {
  const texts = await Promise.all(['.dockerignore', '.fleetignore'].map(async name => {
    try {
      const text = await readFile(join(dir, name), 'utf8')
      if (name === '.fleetignore' && text.split(/\r?\n/).some(line => line.trim().startsWith('!'))) throw new CliError('.fleetignore supports exclusion patterns only; remove negated ! patterns.', EXIT.usage)
      return text
    } catch (err) {
      if (err instanceof CliError) throw err
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw new CliError(`Cannot read ${name} in ${dir}.`, EXIT.usage)
    }
  }))
  const patterns = texts.join('\n').split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))
    .map(line => line.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(line => line && !mustNotExclude(line, dockerfile))
  return [...new Set([...ALWAYS_EXCLUDE, ...patterns])]
}

/** A conservative default for proxied APIs; self-hosted users can set their actual limit. */
export function uploadLimit(): number {
  const bytes = Number(process.env.FLEET_MAX_UPLOAD_BYTES ?? 95_000_000)
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 256 * 1024 * 1024) {
    throw new CliError('FLEET_MAX_UPLOAD_BYTES must be an integer from 1 to 268435456 bytes.', EXIT.usage)
  }
  return bytes
}

export function checkUploadSize(bytes: number, limit = uploadLimit()): void {
  if (bytes > limit) throw new CliError(
    `Build context is ${humanBytes(bytes)}, over the ${humanBytes(limit)} upload limit. Exclude large artifacts in .fleetignore or .dockerignore. For a self-hosted API with a larger limit, set FLEET_MAX_UPLOAD_BYTES to its limit in bytes.`, EXIT.usage)
}

/**
 * Pack `dir` into a gzipped tar in memory.
 *
 * Buffered rather than streamed because the whole thing is POSTed as one body,
 * and the control plane rejects anything over its limit anyway — a stream would
 * only defer discovering that until after the upload.
 */
export async function packContext(dir: string, dockerfile = 'Dockerfile'): Promise<Buffer> {
  const limit = uploadLimit()
  const excludes = await ignorePatterns(dir, dockerfile)
  const args = [
    '-czf',
    '-',
    '-C',
    dir,
    // Ownership and timestamps vary per machine and would make two packs of the
    // same tree differ for no reason.
    //
    // Not sufficient on its own on macOS -- see COPYFILE_DISABLE below.
    '--no-xattrs',
    ...excludes.flatMap((p) => ['--exclude', p]),
    '.',
  ]

  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      /**
       * Keep macOS from smuggling AppleDouble files into the build context.
       *
       * bsdtar stores extended attributes as separate `._name` members, and
       * `--no-xattrs` does not stop it -- that flag is a GNU-compatible alias
       * bsdtar accepts for xattr *archiving*, while the AppleDouble members
       * come from copyfile, which only this variable disables.
       *
       * The failure is invisible from a Mac, which is what makes it worth a
       * comment this long. `tar tzf` on macOS does not list those members: it
       * folds them back into xattrs on the file they belong to. GNU tar on the
       * Linux control plane has no such notion and writes them out as real
       * files, so a context packed here arrives there carrying `._Dockerfile`,
       * `._Program.cs` and the rest.
       *
       * That is not merely untidy. Docker's COPY globs use Go's filepath.Match,
       * where `*` matches a leading dot -- unlike a shell -- so a Dockerfile
       * doing `COPY *.csproj .` copies both `Worker.csproj` and
       * `._Worker.csproj`, and `dotnet restore` then refuses with "this folder
       * contains more than one project or solution file". Found exactly that
       * way, on a .NET service in Docker's own example voting app, having
       * built five other services in the same deploy without complaint.
       */
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    const chunks: Buffer[] = []
    let stderr = ''
    let settled = false

    const fail = (message: string) => {
      if (settled) return
      settled = true
      reject(new CliError(message, EXIT.failure))
    }

    let bytes = 0
    child.stdout.on('data', (c: Buffer) => {
      if (settled) return
      bytes += c.length
      try { checkUploadSize(bytes, limit) } catch (err) {
        child.kill()
        fail((err as Error).message)
        return
      }
      chunks.push(c)
    })
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    child.on('error', (err) =>
      fail(`Could not run tar to package the build context: ${err.message}`)
    )
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-2).join(' ')
        return reject(
          new CliError(`Could not package the build context${detail ? `: ${detail}` : ''}`, EXIT.failure)
        )
      }
      resolve(Buffer.concat(chunks))
    })
  })
}

/** For the "uploading 4.2MB" line, so a slow upload says why it is slow. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}kB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** Inspect the same packed bytes that will be uploaded, without uploading them. */
export async function snapshotArchive(archive: Buffer): Promise<Snapshot> {
  const root = await mkdtemp(join(tmpdir(), 'fleet-snapshot-'))
  try {
    const archivePath = join(root, 'context.tar.gz')
    const extracted = join(root, 'contents')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(extracted)
    await writeFile(archivePath, archive)
    await promisify(execFile)('tar', ['-xzf', archivePath, '-C', extracted, '--no-same-owner', '--exclude=._*'])
    return await snapshotDirectory(extracted)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Pack the directory and hand it to the control plane.
 *
 * Returns the id the deploy quotes back, or null when there is nothing to
 * send — a service deploying a prebuilt `image:` has no context, and uploading
 * one would be pure waste.
 */
export async function uploadContext(
  serviceId: string,
  dir: string,
  packed?: Buffer
): Promise<{ contextId: string; bytes: number }> {
  const { request } = await import('./api.js')
  const archive = packed ?? await packContext(dir)
  checkUploadSize(archive.length)
  if (archive.length > uploadLimit() * 0.8) console.error(`Warning: build context is ${humanBytes(archive.length)} and close to the upload limit. Consider .fleetignore.`)

  const { body } = await request<{ contextId: string; bytes: number }>(
    'POST',
    `/services/${serviceId}/build-context`,
    { raw: { data: archive, contentType: 'application/gzip' } }
  )
  return body
}
