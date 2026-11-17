import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import postgres from 'postgres'
import {
  CreateBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  databaseBackupPrefix,
  postgresEngine,
} from '../src/databases/engines.js'

const dockerExec = promisify(execFile)
const run = async (...args: string[]) =>
  (await dockerExec('docker', args, { maxBuffer: 1024 * 1024 })).stdout.trim()

test(
  'Postgres archives and decrypts WAL while pushing a base to real MinIO',
  { skip: !process.env.FLEET_DB_MINIO_CONTAINER, timeout: 240000 },
  async () => {
    const id = randomUUID()
    const name = `fleet-db-walg-${id.slice(0, 8)}`
    const network = `${name}-net`
    const volume = `${name}-config`
    const configDir = await mkdtemp(join(tmpdir(), `${name}-`))
    const endpoint = process.env.FLEET_DB_MINIO_ENDPOINT!
    const credentials = {
      accessKeyId: process.env.FLEET_DB_MINIO_ACCESS_KEY!,
      secretAccessKey: process.env.FLEET_DB_MINIO_SECRET_KEY!,
    }
    const bucket = 'fleet-backups'
    const fleetId = randomUUID()
    const prefix = databaseBackupPrefix('walg-test', fleetId, id, 1)
    const client = new S3Client({
      endpoint,
      forcePathStyle: true,
      region: 'us-east-1',
      credentials,
      maxAttempts: 1,
    })
    let sql: ReturnType<typeof postgres> | undefined
    try {
      await run('network', 'create', network)
      await run(
        'network',
        'connect',
        '--alias',
        'fleet-minio',
        network,
        process.env.FLEET_DB_MINIO_CONTAINER!,
      )
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
      const postgresImage = await run(
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        'fleet-db-build/postgres:17',
      )
      const poolerImage = await run(
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        'fleet-db-build/pgbouncer:1',
      )
      const target = {
        endpoint: 'http://fleet-minio:9000',
        bucket,
        prefix,
        region: 'us-east-1',
        credentials,
        encryptionKey: randomBytes(32).toString('hex'),
      }
      const plan = postgresEngine.plan({
        id,
        fleetId,
        project: 'walg-test',
        name: `db-${id.slice(0, 8)}`,
        version: '17',
        mode: 'standard',
        allocation: { memoryMb: 512, diskMb: 10240, storage: 'ssd' },
        credentials: postgresEngine.credentials(),
        images: {
          primary: postgresImage,
          pooler: poolerImage,
        },
        backupTarget: target,
      })
      const database = plan.containers.find(
        (container) => container.role === 'database',
      )!
      for (const file of database.files)
        await writeFile(join(configDir, basename(file.path)), file.content, {
          mode: file.mode,
        })
      await run('volume', 'create', volume)
      await run(
        'run',
        '--rm',
        '--mount',
        `type=volume,src=${volume},dst=/etc/fleet`,
        '--mount',
        `type=bind,src=${configDir},dst=/tmp/config,readonly`,
        'debian:bookworm-slim',
        'sh',
        '-c',
        'cp /tmp/config/* /etc/fleet/ && chown -R 999:999 /etc/fleet',
      )
      await run(
        'run',
        '-d',
        '--name',
        name,
        '--network',
        network,
        '--mount',
        `type=volume,src=${volume},dst=/etc/fleet,readonly`,
        '--mount',
        `type=volume,src=${name}-data,dst=/var/lib/postgresql/data`,
        '-p',
        '127.0.0.1::5432',
        ...Object.entries(database.env).flatMap(([key, value]) => [
          '--env',
          `${key}=${value}`,
        ]),
        database.image,
        ...database.command,
      )
      const hostPort = Number(
        (await run('port', name, '5432/tcp')).split(':').at(-1),
      )
      sql = postgres({
        host: '127.0.0.1',
        port: hostPort,
        username: database.env.POSTGRES_USER,
        password: database.files.find((file) =>
          file.path.endsWith('owner-password'),
        )!.content,
        database: plan.database,
        max: 1,
        connect_timeout: 2,
        onnotice: () => {},
      })
      const deadline = Date.now() + 45000
      while (true) {
        try {
          await sql`select 1`
          break
        } catch (error) {
          if (Date.now() > deadline) throw error
          await delay(250)
        }
      }
      await sql`create table wal_probe (value text)`
      await sql`insert into wal_probe values ('encrypted wal marker')`
      await sql`select pg_switch_wal()`
      const archiveDeadline = Date.now() + 90000
      let archived = false
      let walName: string | null = null
      while (!archived) {
        const [status] =
          await sql`select last_archived_wal from pg_stat_archiver`
        walName = status!.last_archived_wal
        archived = Boolean(walName)
        if (archived) break
        if (Date.now() > archiveDeadline)
          throw new Error('Postgres did not archive the switched WAL segment')
        await delay(500)
      }
      await dockerExec(
        'docker',
        [
          'exec',
          '-u',
          'postgres',
          name,
          'wal-g',
          'backup-push',
          '/var/lib/postgresql/data/pgdata',
        ],
        { maxBuffer: 1024 * 1024, timeout: 180000 },
      )
      assert.match(walName!, /^[A-F0-9]{24}$/)
      await dockerExec('docker', [
        'exec',
        '-u',
        'postgres',
        name,
        'sh',
        '-ec',
        `wal-g wal-fetch ${walName} /tmp/${walName} && pg_waldump -p /tmp -s 0/0 ${walName} >/dev/null`,
      ])
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
      )
      assert.ok((listed.Contents?.length ?? 0) >= 2)
      const status = await run(
        'exec',
        name,
        'sh',
        '-c',
        'test "$(stat -c %a /etc/fleet/walg-key)" = 600 && test "$(stat -c %a /etc/fleet/aws-credentials)" = 600 && test "$(stat -c %a /etc/fleet/walg.pgpass)" = 600',
      )
      assert.equal(status, '')
    } finally {
      await sql?.end({ timeout: 1 }).catch(() => {})
      client.destroy()
      await run('rm', '-f', name).catch(() => {})
      await run('volume', 'rm', '-f', volume, `${name}-data`).catch(() => {})
      await run(
        'network',
        'disconnect',
        network,
        process.env.FLEET_DB_MINIO_CONTAINER!,
      ).catch(() => {})
      await run('network', 'rm', network).catch(() => {})
      await rm(configDir, { recursive: true, force: true })
    }
  },
)
