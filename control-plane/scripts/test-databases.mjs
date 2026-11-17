import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const suffix = randomUUID().slice(0, 8), prefix = `fleet-db-tests-${suffix}`
const containers = [], volumes = []
const password = randomBytes(32).toString('base64url')
const run = (cmd, args, { capture = false, cwd = root, env = process.env } = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit' })
  const chunks = []
  if (capture) child.stdout.on('data', chunk => chunks.push(chunk))
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve(Buffer.concat(chunks).toString().trim()) : reject(new Error(`${cmd} failed with exit ${code}; no credential-bearing arguments were used`)))
})
try {
  for (const [kind, image, port] of [['postgres', 'postgres:16-alpine', 5432], ['redis', 'redis:7-alpine', 6379]]) {
    const name = `${prefix}-${kind}`, volume = `${name}-data`
    volumes.push(volume); containers.push(name)
    await run('docker', ['volume', 'create', '--label', 'fleet.db-build-test=true', volume], { capture: true })
    await run('docker', ['run', '-d', '--name', name, '--label', 'fleet.db-build-test=true', '-p', `127.0.0.1::${port}`,
      '--mount', `type=volume,src=${volume},dst=${kind === 'postgres' ? '/var/lib/postgresql/data' : '/data'}`,
      ...(kind === 'postgres' ? ['--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=fleet_databases_test'] : []), image],
    { capture: true, env: { ...process.env, POSTGRES_PASSWORD: password } })
  }
  const pg = await run('docker', ['port', `${prefix}-postgres`, '5432/tcp'], { capture: true })
  const redis = await run('docker', ['port', `${prefix}-redis`, '6379/tcp'], { capture: true })
  assert.match(pg, /^127\.0\.0\.1:[0-9]+$/); assert.match(redis, /^127\.0\.0\.1:[0-9]+$/)
  const env = { ...process.env, DATABASE_URL: `postgres://postgres:${password}@${pg}/fleet_databases_test`, REDIS_URL: `redis://${redis}/15` }
  const until = Date.now() + 30000
  while (true) {
    try { await run('docker', ['exec', `${prefix}-postgres`, 'pg_isready', '-U', 'postgres'], { capture: true }); break } catch (error) {
      if (Date.now() >= until) throw error
      await delay(250)
    }
  }
  for (const script of ['test', 'typecheck', 'build']) await run('npm', ['run', script], { cwd: resolve(root, 'control-plane'), env })
  await run('go', ['test', './...'], { cwd: resolve(root, 'agent') })
  if (!process.argv.includes('--unit-only')) await run('node', ['--test', '--test-concurrency=1', '--import', 'tsx', 'tests/database-engines.docker.ts', 'tests/database-plugins.docker.ts', 'tests/database-registry.docker.ts'], { cwd: resolve(root, 'control-plane'), env })
} finally {
  for (const name of containers) await run('docker', ['rm', '-f', name], { capture: true }).catch(() => {})
  for (const name of volumes) await run('docker', ['volume', 'rm', name], { capture: true }).catch(() => {})
}
