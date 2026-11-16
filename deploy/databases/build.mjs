import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const dir = dirname(fileURLToPath(import.meta.url))
const lock = JSON.parse(await readFile(join(dir, 'images.lock.json'), 'utf8'))
const platforms = process.env.FLEET_DB_PLATFORMS ?? `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
assert.match(platforms, /^linux\/(arm64|amd64)(,linux\/(arm64|amd64))?$/)
const output = join(dir, '.build')
await mkdir(output, { recursive: true })
const record = join(output, 'builder.json')
const owner = createHash('sha256').update(dir).digest('hex')
let builder
try {
  const saved = JSON.parse(await readFile(record, 'utf8'))
  assert.equal(saved.root, dir)
  assert.match(saved.name, /^fleet-db-images-[a-f0-9]{8}$/)
  builder = saved.name
} catch (error) { if (error.code !== 'ENOENT') throw error }
const run = args => new Promise((resolve, reject) => {
  const child = spawn('docker', args, { stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Docker command failed with exit ${code}`)))
})
if (process.argv[2] === '--clean') {
  if (builder) {
    const [owned] = JSON.parse(execFileSync('docker', ['inspect', `buildx_buildkit_${builder}0`], { encoding: 'utf8' }))
    assert.equal(owned.Name, `/buildx_buildkit_${builder}0`)
    assert.equal(owned.Config.Labels['fleet.db-build-test'], 'true')
    assert.ok(owned.Mounts.some(mount => mount.Type === 'volume' && mount.Name === `buildx_buildkit_${builder}0_state` && mount.Destination === '/var/lib/buildkit'), 'Refusing to remove a builder outside this workspace ownership record')
    await run(['buildx', 'rm', '--force', builder])
    await rm(record)
  }
  process.exit(0)
}
if (!builder) {
  let builderBase
  try { builderBase = execFileSync('docker', ['image', 'inspect', '--format', '{{index .Config.Labels "io.fleet.builder-base"}}', 'fleet-db-build/buildkit:local'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  if (builderBase !== lock.buildkit) await run(['image', 'build', '-f', join(dir, 'Builder.Dockerfile'), '--build-arg', `BUILDKIT_IMAGE=${lock.buildkit}`, '-t', 'fleet-db-build/buildkit:local', dir])
  builder = `fleet-db-images-${randomUUID().slice(0, 8)}`
  const state = `buildx_buildkit_${builder}0_state`
  await run(['volume', 'create', '--label', 'fleet.db-build-test=true', '--label', `io.fleet.builder-root=${owner}`, state])
  await run(['buildx', 'create', '--name', builder, '--driver', 'docker-container', '--driver-opt', 'memory=3g', '--driver-opt', 'image=fleet-db-build/buildkit:local'])
  await writeFile(record, JSON.stringify({ name: builder, root: dir }) + '\n')
}
const base = ['buildx', 'build', '--builder', builder, '--platform', platforms, '--label', 'fleet.db-build-test=true', '--progress', 'plain']
const images = [
  ...Object.entries(lock.postgres).map(([version, image]) => ({
    name: `postgres:${version}`, file: 'Postgres.Dockerfile', args: {
      PG_MAJOR: version, POSTGRES_IMAGE: image, DEBIAN_IMAGE: lock.debian, VECTOR_COMMIT: lock.pgvector.commit, VECTOR_SHA256: lock.pgvector.sha256,
      WALG_VERSION: lock.walG.version, WALG_ARM64_SHA256: lock.walG.arm64, WALG_AMD64_SHA256: lock.walG.amd64,
    },
  })),
  { name: 'pgbouncer:1', file: 'PgBouncer.Dockerfile', args: { DEBIAN_IMAGE: lock.debian, PGBOUNCER_VERSION: lock.pgbouncer.version, PGBOUNCER_SHA256: lock.pgbouncer.sha256 } },
  { name: 'redis:7', file: 'Redis.Dockerfile', args: { REDIS_IMAGE: lock.redis } },
  { name: 'registry-test:local', test: true, file: 'RegistryTest.Dockerfile', args: { REGISTRY_IMAGE: lock.registryTest, DIND_IMAGE: lock.dindTest } },
]
const requested = process.argv.slice(2)
assert.ok(requested.every(name => images.some(image => image.name === name)), 'Choose a maintained image or registry-test:local')
for (const image of images.filter(image => requested.length ? requested.includes(image.name) : !image.test)) {
    const tag = `fleet-db-build/${image.name}`
    const artifact = platforms.includes(',') ? ['--output', `type=oci,dest=${join(output, image.name.replace(':', '-') + '.tar')}`] : ['--load']
    console.log(`Building ${tag} for ${platforms}; no registry publication`)
    await run([...base, '-f', join(dir, image.file), '-t', tag, ...artifact, ...Object.entries(image.args).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]), dir])
}
console.log('Local build cache retained for the remaining architecture/tests; remove only this builder with: node deploy/databases/build.mjs --clean')
