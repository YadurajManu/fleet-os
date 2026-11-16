import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const dir = dirname(fileURLToPath(import.meta.url))
const lock = JSON.parse(await readFile(join(dir, 'images.lock.json'), 'utf8'))
const platforms = process.env.FLEET_DB_PLATFORMS ?? `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
assert.match(platforms, /^linux\/(arm64|amd64)(,linux\/(arm64|amd64))?$/)
const builder = `fleet-db-images-${randomUUID().slice(0, 8)}`
const output = join(dir, '.build')
await mkdir(output, { recursive: true })
const run = args => new Promise((resolve, reject) => {
  const child = spawn('docker', args, { stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Docker command failed with exit ${code}`)))
})
const base = ['buildx', 'build', '--builder', builder, '--platform', platforms, '--label', 'fleet.db-build-test=true', '--progress', 'plain']
const images = [
  ...Object.entries(lock.postgres).map(([version, image]) => ({
    name: `postgres:${version}`, file: 'Postgres.Dockerfile', args: {
      PG_MAJOR: version, POSTGRES_IMAGE: image, VECTOR_COMMIT: lock.pgvector.commit, VECTOR_SHA256: lock.pgvector.sha256,
      WALG_VERSION: lock.walG.version, WALG_ARM64_SHA256: lock.walG.arm64, WALG_AMD64_SHA256: lock.walG.amd64,
    },
  })),
  { name: 'pgbouncer:1', file: 'PgBouncer.Dockerfile', args: { DEBIAN_IMAGE: lock.debian, PGBOUNCER_VERSION: lock.pgbouncer.version, PGBOUNCER_SHA256: lock.pgbouncer.sha256 } },
  { name: 'redis:7', file: 'Redis.Dockerfile', args: { REDIS_IMAGE: lock.redis } },
]
await run(['buildx', 'create', '--name', builder, '--driver', 'docker-container', '--driver-opt', 'memory=3g'])
try {
  for (const image of images) {
    const tag = `fleet-db-build/${image.name}`
    const artifact = platforms.includes(',') ? ['--output', `type=oci,dest=${join(output, image.name.replace(':', '-') + '.tar')}`] : ['--load']
    console.log(`Building ${tag} for ${platforms}; no registry publication`)
    await run([...base, '-f', join(dir, image.file), '-t', tag, ...artifact, ...Object.entries(image.args).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]), dir])
  }
} finally {
  await run(['buildx', 'rm', '--force', builder])
}
