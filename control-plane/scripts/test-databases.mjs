import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const suffix = randomUUID().slice(0, 8),
  prefix = `fleet-db-tests-${suffix}`
const containers = [],
  volumes = [],
  images = [],
  temporaryDirectories = []
const minioImage = `fleet-db-minio-test:${suffix}`
const password = randomBytes(32).toString('base64url')
const minioAccessKey = `fleet${randomUUID().slice(0, 12)}`
const minioSecretKey = randomBytes(32).toString('base64url')
const run = (
  cmd,
  args,
  { capture = false, cwd = root, env = process.env } = {},
) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit',
    })
    const chunks = []
    if (capture) child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString().trim())
        : reject(
            new Error(
              `${cmd} failed with exit ${code}; no credential-bearing arguments were used`,
            ),
          ),
    )
  })
async function buildMinioImage() {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-db-minio-'))
  temporaryDirectories.push(directory)
  const env = {
    ...process.env,
    GOOS: 'linux',
    GOARCH: 'arm64',
    CGO_ENABLED: '0',
  }
  delete env.GOBIN
  const gopath = await run('go', ['env', 'GOPATH'], { capture: true, env })
  await run(
    'go',
    ['install', 'github.com/minio/minio@RELEASE.2025-10-15T17-29-55Z'],
    { env },
  )
  const binary = join(directory, 'minio')
  await copyFile(join(gopath, 'bin/linux_arm64/minio'), binary)
  await writeFile(
    join(directory, 'Dockerfile'),
    `FROM alpine:3.22\nCOPY minio /usr/local/bin/minio\nEXPOSE 9000 9001\nENTRYPOINT ["/usr/local/bin/minio"]\n`,
  )
  images.push(minioImage)
  await run('docker', [
    'build',
    '--label',
    'fleet.db-build-test=true',
    '--tag',
    minioImage,
    directory,
  ])
}
try {
  const dependencies = [
    ['postgres', 'postgres:16-alpine', 5432],
    ['redis', 'redis:7-alpine', 6379],
  ]
  if (
    process.argv.includes('--target') ||
    process.argv.includes('--target-only') ||
    process.argv.includes('--backup')
  ) {
    await buildMinioImage()
    dependencies.push(['minio', minioImage, 9000])
  }
  for (const [kind, image, port] of dependencies) {
    const name = `${prefix}-${kind}`,
      volume = `${name}-data`
    volumes.push(volume)
    containers.push(name)
    await run(
      'docker',
      ['volume', 'create', '--label', 'fleet.db-build-test=true', volume],
      { capture: true },
    )
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'fleet.db-build-test=true',
      '-p',
      `127.0.0.1::${port}`,
      '--mount',
      `type=volume,src=${volume},dst=${kind === 'postgres' ? '/var/lib/postgresql/data' : '/data'}`,
      ...(kind === 'postgres'
        ? [
            '--env',
            'POSTGRES_PASSWORD',
            '--env',
            'POSTGRES_DB=fleet_databases_test',
          ]
        : kind === 'minio'
          ? ['--env', 'MINIO_ROOT_USER', '--env', 'MINIO_ROOT_PASSWORD']
          : []),
      image,
      ...(kind === 'minio'
        ? ['server', '/data', '--console-address', ':9001']
        : []),
    ]
    await run('docker', args, {
      capture: true,
      env: {
        ...process.env,
        ...(kind === 'postgres' ? { POSTGRES_PASSWORD: password } : {}),
        ...(kind === 'minio'
          ? {
              MINIO_ROOT_USER: minioAccessKey,
              MINIO_ROOT_PASSWORD: minioSecretKey,
            }
          : {}),
      },
    })
  }
  const pg = await run('docker', ['port', `${prefix}-postgres`, '5432/tcp'], {
    capture: true,
  })
  const redis = await run('docker', ['port', `${prefix}-redis`, '6379/tcp'], {
    capture: true,
  })
  assert.match(pg, /^127\.0\.0\.1:[0-9]+$/)
  assert.match(redis, /^127\.0\.0\.1:[0-9]+$/)
  const minio =
    process.argv.includes('--target') ||
    process.argv.includes('--target-only') ||
    process.argv.includes('--backup')
      ? await run('docker', ['port', `${prefix}-minio`, '9000/tcp'], {
          capture: true,
        })
      : undefined
  if (minio) assert.match(minio, /^127\.0\.0\.1:[0-9]+$/)
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    JWT_SECRET: randomBytes(32).toString('base64url'),
    SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
    LOG_LEVEL: 'error',
    BUILD_MODE: 'local',
    DATABASE_URL: `postgres://postgres:${password}@${pg}/fleet_databases_test`,
    REDIS_URL: `redis://${redis}/15`,
    ...(minio
      ? {
          FLEET_DB_MINIO_ENDPOINT: `http://${minio}`,
          FLEET_DB_MINIO_CONTAINER: `${prefix}-minio`,
          FLEET_DB_MINIO_ACCESS_KEY: minioAccessKey,
          FLEET_DB_MINIO_SECRET_KEY: minioSecretKey,
        }
      : {}),
  }
  const until = Date.now() + 30000
  while (true) {
    try {
      await run(
        'docker',
        ['exec', `${prefix}-postgres`, 'pg_isready', '-U', 'postgres'],
        { capture: true },
      )
      break
    } catch (error) {
      if (Date.now() >= until) throw error
      await delay(250)
    }
  }
  if (minio) {
    const endpoint = `http://${minio}`
    const deadline = Date.now() + 30000
    while (true) {
      try {
        const response = await fetch(`${endpoint}/minio/health/ready`)
        if (response.ok) break
      } catch {}
      if (Date.now() >= deadline) throw new Error('MinIO did not become ready')
      await delay(250)
    }
  }
  for (const script of process.argv.includes('--worker-only') ||
  process.argv.includes('--target-only')
    ? ['pretest']
    : ['db:format:check', 'db:lint', 'test', 'typecheck', 'build'])
    await run('npm', ['run', script], {
      cwd: resolve(root, 'control-plane'),
      env,
    })
  if (!process.argv.includes('--target-only'))
    await run('go', ['test', './...'], { cwd: resolve(root, 'agent') })
  if (
    !process.argv.includes('--target-only') &&
    (process.argv.includes('--worker') ||
      process.argv.includes('--worker-only'))
  ) {
    await run(
      'node',
      ['--test', '--import', 'tsx', 'tests/database-tunnel.docker.ts'],
      {
        cwd: resolve(root, 'control-plane'),
        env: {
          ...env,
          FLEET_DB_WORKER_TEST: '1',
          ...(process.argv.includes('--backup')
            ? {
                FLEET_DB_BACKUP_TEST: '1',
                FLEET_DB_MINIO_CONTAINER: `${prefix}-minio`,
              }
            : {}),
        },
      },
    )
    if (process.argv.includes('--backup'))
      await run(
        'node',
        ['--test', '--import', 'tsx', 'tests/database-walg.docker.ts'],
        { cwd: resolve(root, 'control-plane'), env },
      )
  } else if (
    !process.argv.includes('--unit-only') &&
    !process.argv.includes('--target-only')
  )
    await run(
      'node',
      [
        '--test',
        '--test-concurrency=1',
        '--import',
        'tsx',
        'tests/database-engines.docker.ts',
        'tests/database-plugins.docker.ts',
        'tests/database-registry.docker.ts',
      ],
      { cwd: resolve(root, 'control-plane'), env },
    )
  if (
    process.argv.includes('--target') ||
    process.argv.includes('--target-only')
  )
    await run(
      'node',
      ['--test', '--import', 'tsx', 'tests/database-backup-targets.docker.ts'],
      { cwd: resolve(root, 'control-plane'), env },
    )
} finally {
  for (const name of containers)
    await run('docker', ['rm', '-f', name], { capture: true }).catch(() => {})
  for (const name of volumes)
    await run('docker', ['volume', 'rm', name], { capture: true }).catch(
      () => {},
    )
  for (const image of images)
    await run('docker', ['image', 'rm', image], { capture: true }).catch(
      () => {},
    )
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true })
}
