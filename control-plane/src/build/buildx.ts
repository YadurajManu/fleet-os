import { spawn } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BuildProgress, BuildRequest, BuildResult, BuildRunner } from './runner.js'
import { BuildUnavailableError } from './runner.js'

/**
 * Multi-arch builds with Docker Buildx (FR-3, tech doc §3).
 *
 * Builds run centrally for v1 so a Pi never has to compile anything. The
 * resulting manifest list carries every architecture the fleet needs, and each
 * agent pulls whichever one matches its own.
 */
export class BuildxRunner implements BuildRunner {
  readonly name = 'buildx'

  constructor(
    private readonly opts: {
      registry?: string
      /** "username:password" for a registry that requires them. */
      credentials?: string
      builder?: string
      /** `linux/arm64=name,...` — which builder serves which platform. */
      platformBuilders?: string
      /** Root the build context must stay inside. */
      workdir: string
      /** Skip `--push` and load locally instead; used when no registry is set. */
      pushToRegistry?: boolean
      timeoutMs?: number
      /**
       * How much build cache to export. "max" caches intermediate stages and
       * gives the best reuse; "min" caches only the final image's layers and
       * uploads far less, which matters when the registry sits behind a proxy
       * with a request size limit. "off" skips the export entirely.
       */
      cacheMode?: 'max' | 'min' | 'off'
      log?: (line: string) => void
    }
  ) {}

  async available(): Promise<boolean> {
    try {
      await run('docker', ['buildx', 'version'], { timeoutMs: 5000 })
      return true
    } catch {
      return false
    }
  }

  /**
   * What a builder can target, and which of it is emulated.
   *
   * `--bootstrap` starts the builder if it is not running, which is also how a
   * remote arm64 builder gets woken before the first build of the day.
   */
  async platformsOf(builder?: string): Promise<BuilderPlatforms> {
    try {
      const args = ['buildx', 'inspect', '--bootstrap']
      if (builder) args.push(builder)
      const { stdout } = await run('docker', args, { timeoutMs: 120_000 })
      return parseInspectPlatforms(stdout)
    } catch {
      // Unknown, not empty. An inspect that fails must not be read as "this
      // builder can do nothing", which would refuse every build.
      return { native: new Set(), emulated: new Set() }
    }
  }

  /**
   * Authenticate against the registry before pushing.
   *
   * A registry reachable from outside the LAN has to require credentials, and
   * `REGISTRY_CREDENTIALS` has been in the config schema since the beginning
   * without anything reading it — so a push to an authenticated registry
   * failed with a 401 that looked like a build error.
   *
   * The password goes in on stdin. As an argument it would be visible in `ps`
   * to every user on the host and recorded in any process accounting.
   */
  private async login(): Promise<void> {
    const credentials = this.opts.credentials
    const registry = this.opts.registry
    if (!credentials || !registry) return

    const separator = credentials.indexOf(':')
    if (separator < 1) {
      throw new BuildUnavailableError(
        'REGISTRY_CREDENTIALS must be "username:password"'
      )
    }
    const username = credentials.slice(0, separator)
    const password = credentials.slice(separator + 1)

    // `run` resolves with the exit code rather than throwing on a non-zero
    // one, so a failed login has to be checked for, not caught.
    let code: number
    try {
      ;({ code } = await run(
        'docker',
        ['login', registry, '--username', username, '--password-stdin'],
        { timeoutMs: 30_000, stdin: password }
      ))
    } catch {
      code = 1
    }

    if (code !== 0) {
      // Deliberately does not include docker's output: it echoes the registry
      // address and can include the credential on some versions.
      throw new BuildUnavailableError(
        `could not sign in to the registry at ${registry} as "${username}". Check REGISTRY_CREDENTIALS.`
      )
    }
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    if (!(await this.available())) {
      throw new BuildUnavailableError('docker buildx is not available on the control plane host')
    }
    await this.login()

    const context = await this.resolveContext(req.buildContext, req.contextRoot)
    const tag = this.tagFor(req)
    const pushing = this.opts.pushToRegistry !== false && Boolean(this.opts.registry)

    // Which builder runs which platform. With nothing configured this is one
    // group on the default builder, which is exactly what it did before.
    const routing = parseBuilderRouting(this.opts.platformBuilders)
    const plan = planBuilds(req.platforms, routing, this.opts.builder)

    if (!pushing && (req.platforms.length > 1 || plan.length > 1)) {
      // A multi-platform build cannot be --load into the local daemon, and two
      // builders cannot be joined into one manifest without somewhere to put it.
      throw new BuildUnavailableError(
        'a multi-architecture build needs a registry to push to; set REGISTRY_URL'
      )
    }

    // Ask each builder what it can do before running anything, so a fleet does
    // not wait twenty minutes to be told the architecture was never available.
    const groups: Array<BuildGroup & { emulated: boolean }> = []
    for (const group of plan) {
      const caps = await this.platformsOf(group.builder)
      const known = caps.native.size + caps.emulated.size > 0
      const missing = known
        ? group.platforms.filter((p) => !caps.native.has(p) && !caps.emulated.has(p))
        : []
      if (missing.length) {
        throw new BuildUnavailableError(
          `builder "${group.builder ?? 'default'}" cannot target ${missing.join(', ')}. ` +
            `Install QEMU emulators (docker run --privileged --rm tonistiigi/binfmt --install all), ` +
            `add a native builder for it, or remove those architectures from the fleet. ` +
            `Supported: ${[...caps.native, ...[...caps.emulated].map((p) => `${p} (emulated)`)].join(', ')}.`
        )
      }
      groups.push({
        ...group,
        emulated: known ? group.platforms.some((p) => !caps.native.has(p)) : false,
      })
    }

    const started = Date.now()
    const builds: NonNullable<BuildResult['builds']> = []
    const groupTags: string[] = []
    let lastOutput = ''

    for (const group of groups) {
      // One tag per group only when there is more than one, so the common case
      // pushes the final name directly and needs no manifest step at all.
      const groupTag =
        groups.length === 1
          ? tag
          : `${tag}-${group.platforms.map((p) => p.replace(/[^A-Za-z0-9]+/g, '-')).join('_')}`

      const args = [
        'buildx', 'build',
        '--platform', group.platforms.join(','),
        '--tag', groupTag,
        '--label', `org.opencontainers.image.revision=${req.gitSha}`,
        '--label', 'org.opencontainers.image.source=fleet-os',
        '--progress', 'plain',
      ]
      if (group.builder) args.push('--builder', group.builder)

      if (pushing) {
        args.push('--push')

        const cacheRef = cacheRefFor(tag, group.platforms)

        // Read the cache. This was missing entirely: every build exported one
        // to the registry and no build ever imported one, so the export was
        // write-only and every `pip install` ran again from nothing. A ref that
        // does not exist yet is a warning from buildx rather than an error,
        // which is what makes it safe to ask for unconditionally.
        args.push('--cache-from', `type=registry,ref=${cacheRef}`)

        // Build cache is an optimisation, and it is exported *after* the image
        // has already been pushed. Letting a failed cache upload fail the whole
        // build throws away a perfectly good image — which is exactly what
        // happened behind Cloudflare, whose free plan rejects request bodies
        // over 100MB with a 413 and took the deploy down with it.
        //
        // ignore-error keeps that a slow build next time instead of a failed one
        // now. mode is configurable because "max" exports every intermediate
        // stage, which is the version most likely to exceed such a limit.
        const cacheMode = this.opts.cacheMode ?? 'max'
        if (cacheMode !== 'off') {
          args.push('--cache-to', `type=registry,ref=${cacheRef},mode=${cacheMode},ignore-error=true`)
        }
      } else {
        // No registry, so no registry cache — `type=registry` needs somewhere
        // to put it, and that is the whole of the limitation.
        //
        // It is narrower than it sounds. BuildKit keeps its own cache inside
        // the builder container, so consecutive `--load` builds on this host
        // still reuse layers and cache mounts; a repeated build is near
        // instant. What is lost is cache that outlives the builder — nothing
        // is shared with another machine, and `docker buildx rm` or a prune
        // takes it with them, so the next build is cold.
        //
        // Deliberately not papered over with `type=local`: a directory export
        // grows without bound and would need its own eviction policy, which is
        // a bigger commitment than the case deserves. A fleet that wants cache
        // reuse sets REGISTRY_URL, which it needs anyway to deploy to more than
        // one node.
        args.push('--load')
      }

      args.push(context)

      // One line per group, not per build line. Enough to answer "why was this
      // slow" without a log store: which builder, which platforms, and whether
      // the whole Dockerfile ran through QEMU.
      this.opts.log?.(
        `builder=${group.builder ?? 'default'} platform=${group.platforms.join(',')} ` +
          `emulation=${group.emulated} cache=${pushing ? (this.opts.cacheMode ?? 'max') : 'off'} ` +
          `service=${req.serviceName}`
      )

      const groupStarted = Date.now()
      const watching = Boolean(this.opts.log || req.onProgress)
      const { stdout, stderr, code } = await run('docker', args, {
        timeoutMs: this.opts.timeoutMs ?? 20 * 60_000,
        onLine: watching
          ? (line) => {
              this.opts.log?.(line)
              if (!req.onProgress) return
              const progress = parseBuildLine(line)
              // Decorated with who is running it. A consumer cannot work out
              // emulation from the platform alone once a native remote builder
              // exists, because the answer stops being a property of the
              // control plane's own architecture.
              if (progress) {
                req.onProgress({
                  ...progress,
                  // buildx only prefixes a stage header with the platform on a
                  // multi-platform build -- a single-arch build emits "[5/6]",
                  // not "[linux/arm64 5/6]". The platform is no less true for
                  // being unstated, and it is the field that answers "why is
                  // this slow", so it is supplied from the group when the line
                  // does not carry one. Only when the group is one platform:
                  // with several, the line genuinely does not say which.
                  ...(progress.platform === undefined && group.platforms.length === 1
                    ? { platform: group.platforms[0]! }
                    : {}),
                  ...(group.builder ? { builder: group.builder } : {}),
                  emulated: group.emulated,
                })
              }
            }
          : undefined,
      })

      lastOutput = stderr + stdout
      if (code !== 0) {
        // The last few lines are what a user needs; the whole log is noise.
        const tail = (stderr || stdout).trim().split('\n').slice(-12).join('\n')
        throw new BuildUnavailableError(
          `buildx failed for "${req.serviceName}" on builder "${group.builder ?? 'default'}" ` +
            `(${group.platforms.join(',')}${group.emulated ? ', emulated' : ''}):\n${tail}`
        )
      }

      groupTags.push(groupTag)
      builds.push({
        builder: group.builder ?? 'default',
        platforms: group.platforms,
        emulated: group.emulated,
        durationMs: Date.now() - groupStarted,
        // BuildKit's own count, not an estimate. A build that reports zero
        // cached steps after a cache was configured is the tell that the
        // cache is not being read — which is how the missing --cache-from
        // went unnoticed for as long as it did.
        cachedSteps: (lastOutput.match(/^#\d+ CACHED\b/gm) ?? []).length,
      })
    }

    // Two builders produce two images; a node pulls one name. `imagetools
    // create` writes the manifest list that makes them one, without pulling or
    // rebuilding either — it is a registry-side operation on digests.
    if (groupTags.length > 1) {
      const { stdout, stderr, code } = await run(
        'docker',
        ['buildx', 'imagetools', 'create', '--tag', tag, ...groupTags],
        { timeoutMs: 5 * 60_000 }
      )
      lastOutput = stderr + stdout
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split('\n').slice(-12).join('\n')
        throw new BuildUnavailableError(
          `could not combine ${groupTags.length} per-architecture images into "${tag}":\n${tail}`
        )
      }
    }

    return {
      imageTags: [tag],
      digest: extractDigest(lastOutput) ?? undefined,
      logUrl: undefined,
      durationMs: Date.now() - started,
      builds,
    }
  }

  private tagFor(req: BuildRequest): string {
    const registry = (this.opts.registry ?? req.registry ?? '').replace(/\/+$/, '')
    const name = `${req.serviceName}:${req.gitSha.slice(0, 12)}`
    return registry ? `${registry}/${name}` : name
  }

  /**
   * Keep the build context inside the configured workdir. A manifest is user
   * input, and "build: ../../../etc" must not be a way to read the host.
   */
  private async resolveContext(buildContext: string, contextRoot?: string): Promise<string> {
    // A webhook checkout lands outside the configured workspace, so the root
    // travels with the request; the containment check still applies to it.
    const resolved = containedContext(contextRoot ?? this.opts.workdir, buildContext)
    try {
      await access(resolved)
      const info = await stat(resolved)
      if (!info.isDirectory()) throw new Error('not a directory')
    } catch {
      throw new BuildUnavailableError(`build context "${buildContext}" does not exist in the checkout`)
    }
    return resolved
  }
}

/**
 * Where a build context resolves to, and a refusal if it leaves its root.
 *
 * Pure and exported so the two shapes can be pinned down in a test. They are
 * genuinely different and confusing them is a real bug: a checkout is a whole
 * repository and the manifest's path selects a directory inside it, whereas an
 * upload *is* the directory — the CLI resolved the path before packing, so the
 * context is "." and joining the path on again looks for ./api inside ./api.
 */
export function containedContext(base: string, buildContext: string): string {
  const resolved = join(base, buildContext)
  const root = base.replace(/\/+$/, '')
  if (resolved !== root && !resolved.startsWith(root + '/')) {
    throw new BuildUnavailableError(`build context "${buildContext}" escapes the workspace root`)
  }
  return resolved
}

/**
 * Strip the tag from an image reference.
 *
 * Splitting on the first colon is wrong the moment a registry has a port:
 * "localhost:5001/hello:abc" would yield "localhost", which resolves to Docker
 * Hub. Only a colon after the last slash is a tag separator.
 */
export function repositoryOf(imageRef: string): string {
  const slash = imageRef.lastIndexOf('/')
  const colon = imageRef.lastIndexOf(':')
  return colon > slash ? imageRef.slice(0, colon) : imageRef
}

/**
 * Which builder serves which platform, from `linux/arm64=arm64,linux/amd64=main`.
 *
 * Malformed pairs are dropped rather than throwing. This is read at startup
 * from an environment variable, and a typo in it must not stop a control plane
 * from booting — the consequence of ignoring one pair is a slower build, and
 * the consequence of throwing is no control plane at all.
 */
export function parseBuilderRouting(spec: string | undefined): Map<string, string> {
  const routing = new Map<string, string>()
  if (!spec) return routing
  for (const pair of spec.split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    const platform = pair.slice(0, eq).trim()
    const builder = pair.slice(eq + 1).trim()
    if (platform && builder) routing.set(platform, builder)
  }
  return routing
}

/** What a builder can do, and which of it is emulated. */
export type BuilderPlatforms = { native: Set<string>; emulated: Set<string> }

/** The architecture part of a platform: linux/amd64/v2 -> amd64, linux/arm/v7 -> arm. */
const archOf = (platform: string): string => platform.split('/')[1] ?? ''

/**
 * Read `docker buildx inspect` for what a builder can actually target, and
 * which of it would be emulated.
 *
 * Two signals, because neither is sufficient alone.
 *
 * Older buildx marks an emulated platform with a trailing asterisk, and where
 * that appears it is authoritative. But buildx v0.30 — the version on Docker
 * Desktop today — prints no asterisks at all, so an arm64 Mac and an amd64
 * server advertising arm64 through QEMU produce identical lines. Trusting the
 * asterisk alone would report the twenty-minute path as native.
 *
 * So the fallback is ordering: buildkit reports a node's OWN platform first,
 * then its variants, then everything it can only emulate. Verified against a
 * native arm64 daemon, which lists `linux/arm64` first with binfmt installed
 * for six other architectures.
 *
 * A platform any node can do natively is native, whatever another node said —
 * which is the entire point of appending an arm64 node to an amd64 builder.
 */
export function parseInspectPlatforms(stdout: string): BuilderPlatforms {
  const native = new Set<string>()
  const emulated = new Set<string>()

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.toLowerCase().startsWith('platforms:')) continue

    const entries = trimmed
      .slice(trimmed.indexOf(':') + 1)
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
    if (!entries.length) continue

    // This node's own architecture, from the platform it named first.
    const hostArch = archOf(entries[0]!.replace(/\*$/, '').trim())

    for (const entry of entries) {
      const starred = entry.endsWith('*')
      const platform = starred ? entry.slice(0, -1).trim() : entry
      if (starred || archOf(platform) !== hostArch) emulated.add(platform)
      else native.add(platform)
    }
  }

  for (const platform of native) emulated.delete(platform)
  return { native, emulated }
}

/** One buildx invocation: a set of platforms and the builder that will run it. */
export type BuildGroup = { builder?: string; platforms: string[] }

/**
 * Split the requested platforms across the builders configured to serve them.
 *
 * Order is preserved so the resulting tags and logs are stable between builds,
 * and platforms with no routing entry fall to the default builder — which is
 * how a fleet that has configured nothing keeps behaving exactly as before.
 */
export function planBuilds(
  platforms: string[],
  routing: Map<string, string>,
  fallback?: string
): BuildGroup[] {
  const groups: BuildGroup[] = []
  const byBuilder = new Map<string, BuildGroup>()

  for (const platform of platforms) {
    const builder = routing.get(platform) ?? fallback
    // A group per builder, with `undefined` — buildx's own default — its own
    // key rather than being merged into whatever was named first.
    const key = builder ?? '\u0000default'
    let group = byBuilder.get(key)
    if (!group) {
      group = { ...(builder ? { builder } : {}), platforms: [] }
      byBuilder.set(key, group)
      groups.push(group)
    }
    group.platforms.push(platform)
  }

  return groups
}

/**
 * Where this group's build cache lives in the registry.
 *
 * Per platform group, because two groups pushing to one ref overwrite each
 * other's manifest and every build then misses. A tag may only contain
 * `[A-Za-z0-9_.-]`, so the slashes in `linux/arm64` have to go.
 */
export function cacheRefFor(tag: string, platforms: string[]): string {
  const suffix = platforms
    .map((p) => p.replace(/[^A-Za-z0-9]+/g, '-'))
    .sort()
    .join('_')
    .replace(/^-+|-+$/g, '')
  return `${repositoryOf(tag)}:buildcache-${suffix || 'default'}`
}

function extractDigest(output: string): string | null {
  const match = /digest:\s*(sha256:[a-f0-9]{64})/i.exec(output)
  return match?.[1] ?? null
}

/** `#12 [linux/arm64 4/6] RUN npm ci` — the stage header, with an optional platform. */
const STEP_LINE = /^#\d+\s+\[([^\]]+)\]\s+(.+)$/
/** `#18 pushing manifest for …`, `#18 exporting layers 1.2s done` — no stage bracket. */
const PUSH_LINE = /^#\d+\s+((?:pushing|exporting)\b.*)$/i

/**
 * A progress detail is about to be shown in somebody's terminal, so it is
 * stripped of control characters — a Dockerfile is user input and a `RUN` line
 * carrying cursor escapes would corrupt the CLI's redraw region — and capped,
 * because this travels through Redis on every build.
 */
const sanitise = (text: string): string =>
  [...text]
    .map((ch) => (ch.codePointAt(0)! < 0x20 || ch.codePointAt(0)! === 0x7f ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)

/**
 * Turn one line of `--progress plain` output into a phase and a detail, or
 * nothing.
 *
 * Only the builder's own stage headers are recognised. Everything else — the
 * `#8 12.34 added 214 packages` echo of a step's stdout, `DONE`/`CACHED`
 * markers, `[auth]` lines naming registry credentials — is dropped rather than
 * forwarded, so what reaches the operator is the build's structure and not its
 * log.
 */
export function parseBuildLine(line: string): BuildProgress | null {
  const text = line.trim()

  // Push and export come first: they carry no stage bracket, so the step
  // pattern would never match them anyway.
  const push = PUSH_LINE.exec(text)
  if (push) {
    const detail = sanitise(push[1]!)
    return detail ? { phase: 'pushing', detail } : null
  }

  const step = STEP_LINE.exec(text)
  if (!step) return null

  const stage = step[1]!.trim()
  if (/^auth\b/i.test(stage)) return null

  const detail = sanitise(step[2]!)
  if (!detail) return null

  const counter = /(\d+)\/(\d+)\s*$/.exec(stage)
  const platform = /(linux\/[a-z0-9._/-]+)/i.exec(stage)?.[1]
  return {
    phase: 'building',
    ...(counter ? { step: Number(counter[1]), ofSteps: Number(counter[2]) } : {}),
    ...(platform ? { platform } : {}),
    detail,
  }
}

function run(
  command: string,
  args: string[],
  opts: { timeoutMs: number; onLine?: (line: string) => void; stdin?: string }
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    // stdin is always a pipe and always closed straight away. Closing it is
    // what 'ignore' would have achieved — the child reads EOF — and keeping
    // the shape fixed is what lets stdout and stderr be typed as streams.
    child.stdin.on('error', () => {
      /* the close handler reports why the process went away */
    })
    child.stdin.end(opts.stdin ?? '')
    // Let the streams do the UTF-8 decoding, so a chunk boundary falling inside
    // a multi-byte character cannot turn it into a replacement glyph.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new BuildUnavailableError(`${command} timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)

    // A chunk boundary also falls mid-line, so the tail of each stream is held
    // back until its newline arrives. Splitting the raw chunk instead would
    // report one line as two fragments, neither of which parses.
    const partial = { out: '', err: '' }
    const collect = (target: 'out' | 'err') => (chunk: string) => {
      if (target === 'out') stdout += chunk
      else stderr += chunk
      if (!opts.onLine) return
      const lines = (partial[target] + chunk).split('\n')
      partial[target] = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) opts.onLine(line)
    }

    child.stdout.on('data', collect('out'))
    child.stderr.on('data', collect('err'))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // A final line with no trailing newline is still a line.
      if (opts.onLine)
        for (const rest of [partial.out, partial.err]) if (rest.trim()) opts.onLine(rest)
      resolve({ stdout, stderr, code: code ?? 1 })
    })
  })
}
