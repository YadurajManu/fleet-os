import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
const exec = promisify(execFile)

type RegistryConfig = { REGISTRY_URL?: string; REGISTRY_CREDENTIALS?: string }
async function withRegistry<T>(
  host: string,
  credentials: string | undefined,
  action: (env: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-manifests-'))
  const env = { ...process.env, DOCKER_CONFIG: dir }
  try {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        cliPluginsExtraDirs: [
          join(
            process.env.DOCKER_CONFIG ?? join(homedir(), '.docker'),
            'cli-plugins'
          ),
          '/Applications/Docker.app/Contents/Resources/cli-plugins',
        ],
      }),
      { mode: 0o600 }
    )
    if (credentials) {
      const separator = credentials.indexOf(':')
      if (separator < 1) throw new Error('invalid registry credentials')
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'docker',
          [
            'login',
            host,
            '--username',
            credentials.slice(0, separator),
            '--password-stdin',
          ],
          { env, stdio: ['pipe', 'ignore', 'ignore'], timeout: 30000 }
        )
        child.once('error', reject)
        child.stdin.once('error', reject)
        child.once('exit', (code) =>
          code === 0
            ? resolve()
            : reject(new Error('registry authentication failed'))
        )
        child.stdin.end(credentials.slice(separator + 1))
      })
    }
    return await action(env)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Registry-only imagetools operations never execute a Dockerfile or need a daemon. */
export async function mergeManifests(
  repo: string,
  tag: string,
  digests: string[],
  credentials?: string
): Promise<string> {
  if (!digests.length || digests.some((d) => !/^sha256:[a-f0-9]{64}$/.test(d)))
    throw new Error('invalid per-platform image digest')
  try {
    return await withRegistry(repo.split('/')[0]!, credentials, async (env) => {
      await exec(
        'docker',
        [
          'buildx',
          'imagetools',
          'create',
          '--tag',
          `${repo}:${tag}`,
          ...digests.map((d) => `${repo}@${d}`),
        ],
        { env, timeout: 300000, maxBuffer: 1048576 }
      )
      const { stdout } = await exec(
        'docker',
        [
          'buildx',
          'imagetools',
          'inspect',
          '--format',
          '{{.Manifest.Digest}}',
          `${repo}:${tag}`,
        ],
        { env, timeout: 30000 }
      )
      const digest = stdout.trim()
      if (!/^sha256:[a-f0-9]{64}$/.test(digest))
        throw new Error('manifest digest missing')
      return digest
    })
  } catch {
    throw new Error(
      'registry manifest assembly failed; inspect registry connectivity and per-platform digests'
    )
  }
}

export function manifestPlatforms(manifest: unknown): string[] {
  const m = manifest as {
    manifests?: Array<{
      platform?: { os?: string; architecture?: string; variant?: string }
    }>
  }
  return [
    ...new Set(
      (m.manifests ?? [])
        .map((x) => {
          const p = x.platform
          return p?.os === 'linux' && p.architecture
            ? `linux/${p.architecture}${p.architecture === 'arm' && p.variant ? `/${p.variant}` : ''}`
            : ''
        })
        .filter((p) => /^linux\/(amd64|arm64|arm\/v7)$/.test(p))
    ),
  ]
}
export function pinnedImage(image: string, digest: string): string {
  return `${image.split('@')[0]!.replace(/:[^/:]+$/, '')}@${digest}`
}
export async function inspectImage(
  image: string,
  config: RegistryConfig = {}
): Promise<{ platforms: string[]; digest: string }> {
  if (image.startsWith('-') || /[\s\r\n]/.test(image))
    throw new Error('invalid image reference')
  const registry = config.REGISTRY_URL?.replace(/^https?:\/\//, '').split(
    '/'
  )[0]
  // Never send the private registry's credentials to an arbitrary image host.
  const host = image.split('/')[0]!
  const credentials =
    registry && host === registry ? config.REGISTRY_CREDENTIALS : undefined
  try {
    return await withRegistry(host, credentials, async (env) => {
      const { stdout } = await exec(
        'docker',
        ['buildx', 'imagetools', 'inspect', '--raw', image],
        { env, timeout: 30000, maxBuffer: 4 * 1048576 }
      )
      const manifest = JSON.parse(stdout)
      let platforms = manifestPlatforms(manifest)
      if (!manifest.manifests) {
        const { stdout: config } = await exec(
          'docker',
          [
            'buildx',
            'imagetools',
            'inspect',
            '--format',
            '{{json .Image}}',
            image,
          ],
          { env, timeout: 30000, maxBuffer: 4 * 1048576 }
        )
        const c = JSON.parse(config)
        platforms = manifestPlatforms({
          manifests: [
            {
              platform: {
                os: c.os,
                architecture: c.architecture,
                variant: c.variant,
              },
            },
          ],
        })
      }
      if (!platforms.length)
        throw new Error('no supported Linux image platform')
      const { stdout: d } = await exec(
        'docker',
        [
          'buildx',
          'imagetools',
          'inspect',
          '--format',
          '{{.Manifest.Digest}}',
          image,
        ],
        { env, timeout: 30000, maxBuffer: 1024 }
      )
      const digest = d.trim()
      if (!/^sha256:[a-f0-9]{64}$/.test(digest))
        throw new Error('no image digest')
      return { platforms, digest }
    })
  } catch {
    throw new Error(
      'Cannot inspect image manifest platforms; check the image reference and registry access'
    )
  }
}
