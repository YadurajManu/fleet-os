import test from 'node:test'
import { and, eq, sql } from 'drizzle-orm'
import { createContext, closeContext } from '../src/api/context.js'
import { loadConfig } from '../src/config.js'
import {
  orgs,
  fleets,
  nodes,
  tenantDatabases,
  databaseCredentials,
  databaseBackups,
  databaseBackupTargets,
  databaseOperations,
  orgMembers,
  users,
  auditLog,
} from '../src/db/schema.js'
import { buildServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'
import { revokeSessions } from '../src/auth/tokens.js'
import { DatabaseWorker } from '../src/databases/worker.js'
import {
  enqueueDatabaseOperation,
  claimDatabaseOperation,
} from '../src/databases/operations.js'
import { streamDatabaseProgress } from '../src/databases/progress.js'

import { resolve } from 'node:path'
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  randomBytes,
  randomUUID,
  createHash,
  createDecipheriv,
  hkdfSync,
} from 'node:crypto'
import { createServer } from 'node:http'
import { createConnection, createServer as createTCPServer } from 'node:net'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import postgresClient from 'postgres'
import { TunnelRegistry } from '../src/tunnel/registry.js'
import { DatabaseTunnel } from '../src/databases/tunnel.js'
import {
  databaseBackupPrefix,
  postgresEngine,
  redisEngine,
} from '../src/databases/engines.js'
import { sealSecret } from '../src/lib/crypto.js'
import type { AppContext } from '../src/api/context.js'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'

const workerMode = process.env.FLEET_DB_WORKER_TEST === '1'
const docker = (args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
async function until(check: () => boolean) {
  const end = Date.now() + 30000
  while (!check()) {
    if (Date.now() > end) throw new Error('Tunnel fixture did not become ready')
    await delay(20)
  }
}
function resp(parts: Buffer[]) {
  return Buffer.concat([
    Buffer.from(`*${parts.length}\r\n`),
    ...parts.flatMap((part) => [
      Buffer.from(`$${part.length}\r\n`),
      part,
      Buffer.from('\r\n'),
    ]),
  ])
}
function decryptBackup(context: AppContext, backupId: string, object: Buffer) {
  assert.equal(object.subarray(0, 8).toString(), 'FLEETDB1')
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(context.config.SECRETS_MASTER_KEY, 'base64'),
      Buffer.from(backupId),
      Buffer.from('fleet-database-backup-v1'),
      32,
    ),
  )
  const decipher = createDecipheriv('aes-256-gcm', key, object.subarray(8, 20))
  decipher.setAuthTag(object.subarray(-16))
  return Buffer.concat([
    decipher.update(object.subarray(20, -16)),
    decipher.final(),
  ])
}

test(
  'real agents and Docker service transfer private Redis traffic, drop and reconnect at 100 ms RTT',
  { timeout: 420000 },
  async (t) => {
    const fixtureConfig = workerMode ? loadConfig() : null
    const fleetId = randomUUID(),
      nodeId = randomUUID(),
      serviceNodeId = randomUUID(),
      id = randomUUID(),
      postgresId = randomUUID(),
      restoreTargetId = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const registry = new TunnelRegistry({ builds: {} } as unknown as AppContext)
    const relay = new DatabaseTunnel(registry)
    const server = createServer(),
      wss = new WebSocketServer({ server })
    const peers: ReturnType<typeof spawn>[] = []
    wss.on('connection', (socket, request) => {
      const selected =
        request.headers.authorization === `Bearer ${token}-db`
          ? nodeId
          : request.headers.authorization === `Bearer ${token}-app`
            ? serviceNodeId
            : null
      if (!selected) {
        socket.close()
        return
      }
      // Delay each direction by 50 ms while retaining actual WebSocket framing/order.
      const send = socket.send.bind(socket)
      socket.send = ((data: string) => {
        setTimeout(() => {
          if (socket.readyState === 1) send(data)
        }, 50)
      }) as typeof socket.send
      const emit = socket.emit.bind(socket)
      socket.emit = ((event: string, ...args: unknown[]) => {
        if (event === 'message') {
          setTimeout(() => emit(event, ...args), 50)
          return true
        }
        return emit(event, ...args)
      }) as typeof socket.emit
      registry.register(selected, socket)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const image = docker([
      'image',
      'inspect',
      '--format',
      '{{index .RepoDigests 0}}',
      'fleet-db-build/redis:7',
    ])
    const identity = {
      id,
      nodeId,
      fleetId,
      project: 'tunnel-e2e',
      generation: 1,
    }
    const workerContext = fixtureConfig ? createContext(fixtureConfig) : null
    const orgId = randomUUID()
    if (workerContext) workerContext.tunnels = registry
    let worker: DatabaseWorker | undefined
    let api: FastifyInstance | undefined
    let cliProcess: ReturnType<typeof spawn> | undefined
    let postgresCliProcess: ReturnType<typeof spawn> | undefined
    let connectAccount:
      | { user: { id: string }; org: { id: string }; accessToken: string }
      | undefined
    let backupS3: S3Client | undefined
    let backupBucket = ''
    const backupObjectKeys: string[] = []
    const credentials = redisEngine.credentials()
    const auth = resp([
      Buffer.from('AUTH'),
      Buffer.from(credentials.app.username),
      Buffer.from(credentials.app.password),
    ])
    const platform = `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
    const plan = redisEngine.plan({
      id,
      fleetId,
      project: identity.project,
      name: 'tunnel',
      version: '7',
      mode: 'durable',
      allocation: { memoryMb: 512, diskMb: 10240 },
      credentials,
      images: { primary: image },
    })
    const postgresIdentity = {
      id: postgresId,
      nodeId,
      fleetId,
      project: identity.project,
      generation: 1,
    }
    const postgresCredentials = postgresEngine.credentials()
    const postgresPlan = postgresEngine.plan({
      id: postgresId,
      fleetId,
      project: identity.project,
      name: 'tunnel-postgres',
      version: '17',
      mode: 'standard',
      allocation: { memoryMb: 512, diskMb: 10240 },
      credentials: postgresCredentials,
      images: {
        primary: docker([
          'image',
          'inspect',
          '--format',
          '{{.Id}}',
          'fleet-db-build/postgres:17',
        ]),
        pooler: docker([
          'image',
          'inspect',
          '--format',
          '{{.Id}}',
          'fleet-db-build/pgbouncer:1',
        ]),
      },
    })
    const proxy = createTCPServer((socket) => {
      const stream = relay.open(
        { identity, role: 'database', port: 6379, timeoutMs: 30000 },
        new AbortController().signal,
      )
      stream.on('error', () => socket.destroy())
      socket.on('error', () => stream.destroy())
      socket.pipe(stream).pipe(socket)
    })
    try {
      const peerBinary = resolve('../deploy/databases/.build/tunnel-tests')
      execFileSync(
        'go',
        ['test', '-c', '-o', peerBinary, './internal/tunnel'],
        { cwd: '../agent', stdio: 'ignore' },
      )
      for (const [peerId, suffix] of [
        [nodeId, 'db'],
        [serviceNodeId, 'app'],
      ]) {
        const child = spawn(
          peerBinary,
          ['-test.run=^TestDatabaseTunnelPeer$', '-test.count=1'],
          {
            cwd: '../agent',
            env: {
              ...process.env,
              FLEET_DB_TUNNEL_FIXTURE: JSON.stringify({
                URL: `http://127.0.0.1:${address.port}`,
                Token: `${token}-${suffix}`,
                NodeID: peerId,
                FleetID: fleetId,
              }),
            },
            stdio: ['pipe', 'ignore', 'ignore'],
          },
        )
        peers.push(child)
      }
      await until(() => registry.has(nodeId) && registry.has(serviceNodeId))
      if (workerContext) {
        const [current] = await workerContext.sql<
          { name: string }[]
        >`select current_database() as name`
        assert.match(current!.name, /(?:^test_|_test$)/)
        await workerContext.db
          .insert(orgs)
          .values({ id: orgId, name: 'worker-fixture' })
        await workerContext.db
          .insert(fleets)
          .values({ id: fleetId, orgId, name: 'worker-fixture' })
        await workerContext.db.insert(nodes).values({
          id: nodeId,
          fleetId,
          name: 'database-node',
          cpuCores: 2,
          ramMb: 4096,
          diskMb: 100000,
          agentTokenHash: createHash('sha256')
            .update(token + '-db')
            .digest('hex'),
          arch: process.arch,
          databaseCapabilities: ['database.runtime.v1', 'database.exec.v1'],
        })
        await workerContext.db.insert(tenantDatabases).values({
          id,
          fleetId,
          project: identity.project,
          name: 'tunnel',
          engine: 'redis',
          version: '7',
          mode: 'durable',
          nodeId,
          volumeName: `fleet-db-${id}-data`,
          memoryMb: 512,
          cpu: 0.5,
          diskMb: 10240,
        })
        await workerContext.db.insert(databaseCredentials).values(
          (['owner', 'app', 'readonly'] as const).map((role) => ({
            databaseId: id,
            role,
            generation: 1,
            encryptedValue: sealSecret(
              JSON.stringify(credentials[role]),
              workerContext.config.SECRETS_MASTER_KEY,
            ),
          })),
        )
        await workerContext.db.insert(tenantDatabases).values({
          id: postgresId,
          fleetId,
          project: identity.project,
          name: 'tunnel-postgres',
          engine: 'postgres',
          version: '17',
          mode: 'standard',
          status: 'running',
          desiredState: 'running',
          nodeId,
          volumeName: `fleet-db-${postgresId}-data`,
          memoryMb: 512,
          cpu: 0.5,
          diskMb: 10240,
          images: {
            primary: postgresPlan.containers.find(
              (container) => container.role === 'database',
            )!.image,
            pooler: postgresPlan.containers.find(
              (container) => container.role === 'pooler',
            )!.image,
          },
        })
        await workerContext.db.insert(databaseCredentials).values(
          (['owner', 'app', 'readonly'] as const).map((role) => ({
            databaseId: postgresId,
            role,
            generation: 1,
            encryptedValue: sealSecret(
              JSON.stringify(postgresCredentials[role]),
              workerContext.config.SECRETS_MASTER_KEY,
            ),
          })),
        )
        await relay.runOperation(
          {
            id: randomUUID(),
            action: 'provision',
            identity: postgresIdentity,
            bootstrap: postgresPlan.bootstrap,
            readiness: postgresPlan.readiness,
            containers: postgresPlan.containers.map((container) => ({
              initialize: true,
              identity: postgresIdentity,
              network: postgresPlan.network,
              volume: `fleet-db-${postgresId}-data`,
              dataPath: postgresPlan.dataPath,
              platform,
              cpu: 0.5,
              container,
            })),
          },
          new AbortController().signal,
        )
        const scope = { fleetId, project: identity.project, databaseId: id }
        const runtimeIntent = {
          identity,
          readiness: { ...plan.readiness, stdin: plan.readiness.stdin ?? '' },
          containers: plan.containers.map((container) => ({
            initialize: true,
            identity,
            network: plan.network,
            volume: `fleet-db-${id}-data`,
            dataPath: plan.dataPath,
            platform,
            cpu: 0.5,
            container,
          })),
        }
        const created = await enqueueDatabaseOperation(
          workerContext,
          scope,
          'create',
          'create',
          runtimeIntent,
        )
        worker = new DatabaseWorker(workerContext)
        assert.equal(await worker.tick(), true)
        api = await buildServer(workerContext)
        const signup = await api.inject({
          method: 'POST',
          url: '/auth/signup',
          payload: {
            email: `database-connect-${randomUUID()}@example.test`,
            password: 'database-connect-test-password',
          },
        })
        assert.equal(signup.statusCode, 201, signup.body)
        const account = signup.json() as NonNullable<typeof connectAccount>
        connectAccount = account
        await workerContext.db.insert(orgMembers).values({
          orgId,
          userId: account.user.id,
          role: 'admin',
        })
        if (process.env.FLEET_DB_BACKUP_TEST === '1') {
          const endpoint = process.env.FLEET_DB_MINIO_ENDPOINT!
          const accessKeyId = process.env.FLEET_DB_MINIO_ACCESS_KEY!
          const secretAccessKey = process.env.FLEET_DB_MINIO_SECRET_KEY!
          backupBucket = `fleet-db-backup-${randomUUID()}`
          backupS3 = new S3Client({
            endpoint,
            forcePathStyle: true,
            region: 'us-east-1',
            credentials: { accessKeyId, secretAccessKey },
            maxAttempts: 1,
          })
          await backupS3.send(new CreateBucketCommand({ Bucket: backupBucket }))
          const targets = `/fleets/${fleetId}/projects/${identity.project}/backup-targets`
          const targetResponse = await api.inject({
            method: 'POST',
            url: targets,
            headers: { authorization: `Bearer ${account.accessToken}` },
            payload: {
              name: 'docker-backup',
              endpoint,
              bucket: backupBucket,
              prefix: 'e2e',
              credentials: { accessKeyId, secretAccessKey },
              isDefault: true,
            },
          })
          assert.equal(targetResponse.statusCode, 201, targetResponse.body)
          const targetId = targetResponse.json().id as string
          // Docker agents need a host-gateway URL; the API-side S3 client uses the mapped port.
          await workerContext.db
            .update(databaseBackupTargets)
            .set({
              endpoint: endpoint.replace('127.0.0.1', 'host.docker.internal'),
            })
            .where(eq(databaseBackupTargets.id, targetId))
          const assigned = await api.inject({
            method: 'PUT',
            url: `${targets.replace('/backup-targets', '')}/databases/${postgresId}/backup-target`,
            headers: { authorization: `Bearer ${account.accessToken}` },
            payload: { targetId },
          })
          assert.equal(assigned.statusCode, 200, assigned.body)
          const restarted = await api.inject({
            method: 'POST',
            url: `${targets.replace('/backup-targets', '')}/databases/${postgresId}/actions`,
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              'idempotency-key': randomUUID(),
            },
            payload: { action: 'restart' },
          })
          assert.equal(restarted.statusCode, 202, restarted.body)
          assert.equal(await worker.tick(), true)
          const [restartOperation] = await workerContext.db
            .select({ state: databaseOperations.state })
            .from(databaseOperations)
            .where(eq(databaseOperations.id, restarted.json().operation.id))
          assert.equal(restartOperation!.state, 'succeeded')
          await workerContext.db
            .update(databaseBackupTargets)
            .set({ endpoint })
            .where(eq(databaseBackupTargets.id, targetId))
          docker([
            'exec',
            '-e',
            `PGPASSWORD=${postgresCredentials.owner.password}`,
            `fleet-db-${postgresId}-database`,
            'psql',
            '-X',
            '-v',
            'ON_ERROR_STOP=1',
            '-U',
            postgresCredentials.owner.username,
            '-d',
            'tunnel_postgres',
            '-c',
            "CREATE TABLE restore_marker (value text NOT NULL); INSERT INTO restore_marker VALUES ('restored-from-verified-backup');",
          ])
          const backupUrl = `${targets.replace('/backup-targets', '')}/databases/${postgresId}/backups`
          const queued = await api.inject({
            method: 'POST',
            url: backupUrl,
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              'idempotency-key': randomUUID(),
            },
          })
          assert.equal(queued.statusCode, 202, queued.body)
          assert.equal(await worker.tick(), true)
          const backupId = queued.json().backupId as string
          backupObjectKeys.push(
            `e2e/databases/${postgresId}/${backupId}/data.enc`,
          )
          const [backup] = await workerContext.db
            .select()
            .from(databaseBackups)
            .where(eq(databaseBackups.id, backupId))
          assert.equal(
            backup!.state,
            'complete',
            `backup failed with ${backup!.errorCode ?? 'no error code'}`,
          )
          assert.ok(backup!.verifiedAt)
          const object = await backupS3.send(
            new GetObjectCommand({
              Bucket: backupBucket,
              Key: backup!.manifest[0]!.key,
            }),
          )
          const sealed = Buffer.from(await object.Body!.transformToByteArray())
          const dump = decryptBackup(workerContext, backupId, sealed)
          assert.equal(dump.subarray(0, 5).toString(), 'PGDMP')
          assert.equal(sealed.length, backup!.sizeBytes)
          docker([
            'network',
            'connect',
            '--alias',
            'minio',
            postgresPlan.network,
            process.env.FLEET_DB_MINIO_CONTAINER!,
          ])
          await workerContext.db
            .update(databaseBackupTargets)
            .set({ endpoint: 'http://minio:9000' })
            .where(eq(databaseBackupTargets.id, targetId))
          const baseQueued = await api.inject({
            method: 'POST',
            url: `${targets.replace('/backup-targets', '')}/databases/${postgresId}/base-backups`,
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              'idempotency-key': randomUUID(),
            },
          })
          assert.equal(baseQueued.statusCode, 202, baseQueued.body)
          assert.equal(await worker.tick(), true)
          const baseBackupId = baseQueued.json().backupId as string
          const [baseBackup] = await workerContext.db
            .select()
            .from(databaseBackups)
            .where(eq(databaseBackups.id, baseBackupId))
          assert.equal(
            baseBackup!.state,
            'complete',
            `WAL-G base backup failed with ${baseBackup!.errorCode ?? 'no error code'}`,
          )
          assert.match(String(baseBackup!.recoveryPoint.backupName), /^base_/)
          const walPrefix = databaseBackupPrefix('e2e', fleetId, postgresId, 1)
          let continuationToken: string | undefined
          do {
            const objects = await backupS3.send(
              new ListObjectsV2Command({
                Bucket: backupBucket,
                Prefix: walPrefix,
                ContinuationToken: continuationToken,
              }),
            )
            for (const object of objects.Contents ?? [])
              if (object.Key) backupObjectKeys.push(object.Key)
            continuationToken = objects.NextContinuationToken
          } while (continuationToken)
          assert.ok(backupObjectKeys.some((key) => key.startsWith(walPrefix)))
          await workerContext.db
            .update(databaseBackupTargets)
            .set({ endpoint })
            .where(eq(databaseBackupTargets.id, targetId))
          const downloaded = await api.inject({
            method: 'GET',
            url: `${backupUrl}/${backupId}/download`,
            headers: { authorization: `Bearer ${account.accessToken}` },
          })
          assert.equal(downloaded.statusCode, 200, downloaded.body)
          assert.equal(
            downloaded.headers['content-type'],
            'application/octet-stream',
          )
          assert.match(
            downloaded.headers['content-disposition']!,
            new RegExp(`${backupId}\\.dump`),
          )
          assert.deepEqual(downloaded.rawPayload, dump)
          const [downloadAudit] = await workerContext.db
            .select()
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, 'database.backup.downloaded'),
                eq(auditLog.targetId, postgresId),
              ),
            )
          assert.equal(downloadAudit!.actorUserId, account.user.id)
          assert.equal(downloadAudit!.metadata?.backupId, backupId)

          const restoreCredentials = postgresEngine.credentials()
          const restorePlan = postgresEngine.plan({
            id: restoreTargetId,
            fleetId,
            project: identity.project,
            name: 'tunnel-restore-target',
            version: '17',
            mode: 'standard',
            allocation: { memoryMb: 512, diskMb: 10240 },
            credentials: restoreCredentials,
            images: {
              primary: postgresPlan.containers.find(
                (container) => container.role === 'database',
              )!.image,
              pooler: postgresPlan.containers.find(
                (container) => container.role === 'pooler',
              )!.image,
            },
          })
          const restoreIdentity = { ...postgresIdentity, id: restoreTargetId }
          await workerContext.db.insert(tenantDatabases).values({
            id: restoreTargetId,
            fleetId,
            project: identity.project,
            name: 'tunnel-restore-target',
            engine: 'postgres',
            version: '17',
            mode: 'standard',
            status: 'running',
            desiredState: 'running',
            nodeId,
            volumeName: `fleet-db-${restoreTargetId}-data`,
            memoryMb: 512,
            cpu: 0.5,
            diskMb: 10240,
            images: {
              primary: restorePlan.containers.find(
                (container) => container.role === 'database',
              )!.image,
              pooler: restorePlan.containers.find(
                (container) => container.role === 'pooler',
              )!.image,
            },
          })
          await workerContext.db.insert(databaseCredentials).values(
            (['owner', 'app', 'readonly'] as const).map((role) => ({
              databaseId: restoreTargetId,
              role,
              generation: 1,
              encryptedValue: sealSecret(
                JSON.stringify(restoreCredentials[role]),
                workerContext.config.SECRETS_MASTER_KEY,
              ),
            })),
          )
          await relay.runOperation(
            {
              id: randomUUID(),
              action: 'provision',
              identity: restoreIdentity,
              bootstrap: restorePlan.bootstrap,
              readiness: restorePlan.readiness,
              containers: restorePlan.containers.map((container) => ({
                initialize: true,
                identity: restoreIdentity,
                network: restorePlan.network,
                volume: `fleet-db-${restoreTargetId}-data`,
                dataPath: restorePlan.dataPath,
                platform,
                cpu: 0.5,
                container,
              })),
            },
            new AbortController().signal,
          )
          const restoreQueued = await api.inject({
            method: 'POST',
            url: `${backupUrl}/${backupId}/restore`,
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              'idempotency-key': randomUUID(),
            },
            payload: { targetDatabaseId: restoreTargetId },
          })
          assert.equal(restoreQueued.statusCode, 202, restoreQueued.body)
          assert.equal(
            (
              await workerContext.db
                .select({ status: tenantDatabases.status })
                .from(tenantDatabases)
                .where(eq(tenantDatabases.id, restoreTargetId))
            )[0]!.status,
            'restoring',
          )
          assert.equal(await worker.tick(), true)
          const [restoreOperation] = await workerContext.db
            .select({ state: databaseOperations.state })
            .from(databaseOperations)
            .where(eq(databaseOperations.id, restoreQueued.json().operationId))
          assert.equal(restoreOperation!.state, 'succeeded')
          assert.equal(
            docker([
              'exec',
              '-e',
              `PGPASSWORD=${restoreCredentials.owner.password}`,
              `fleet-db-${restoreTargetId}-database`,
              'psql',
              '-X',
              '-A',
              '-t',
              '-U',
              restoreCredentials.owner.username,
              '-d',
              'tunnel_restore_target',
              '-c',
              'SELECT value FROM restore_marker',
            ]),
            'restored-from-verified-backup',
          )
          const unsafeRestore = await api.inject({
            method: 'POST',
            url: `${backupUrl}/${backupId}/restore`,
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              'idempotency-key': randomUUID(),
            },
            payload: { targetDatabaseId: restoreTargetId },
          })
          assert.equal(unsafeRestore.statusCode, 202, unsafeRestore.body)
          assert.equal(await worker.tick(), true)
          const [unsafeOperation] = await workerContext.db
            .select({ state: databaseOperations.state })
            .from(databaseOperations)
            .where(eq(databaseOperations.id, unsafeRestore.json().operationId))
          assert.equal(unsafeOperation!.state, 'failed')
          const [afterUnsafeRestore] = await workerContext.db
            .select({ status: tenantDatabases.status })
            .from(tenantDatabases)
            .where(eq(tenantDatabases.id, restoreTargetId))
          assert.equal(afterUnsafeRestore!.status, 'running')
          assert.equal(
            docker([
              'exec',
              '-e',
              `PGPASSWORD=${restoreCredentials.owner.password}`,
              `fleet-db-${restoreTargetId}-database`,
              'psql',
              '-X',
              '-A',
              '-t',
              '-U',
              restoreCredentials.owner.username,
              '-d',
              'tunnel_restore_target',
              '-c',
              'SELECT value FROM restore_marker',
            ]),
            'restored-from-verified-backup',
          )
          backupObjectKeys.push(
            `e2e/databases/${postgresId}/${backupId}/data.enc`,
          )
          t.diagnostic(
            'verified encrypted backup restored into a new PostgreSQL database over the agent tunnel',
          )

          const redisAssignment = await api.inject({
            method: 'PUT',
            url: `${targets.replace('/backup-targets', '')}/databases/${id}/backup-target`,
            headers: { authorization: `Bearer ${account.accessToken}` },
            payload: { targetId },
          })
          assert.equal(redisAssignment.statusCode, 200, redisAssignment.body)
          const redisQueued = await api.inject({
            method: 'POST',
            url: `${targets.replace('/backup-targets', '')}/databases/${id}/backups`,
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              'idempotency-key': randomUUID(),
            },
          })
          assert.equal(redisQueued.statusCode, 202, redisQueued.body)
          assert.equal(await worker.tick(), true)
          const redisBackupId = redisQueued.json().backupId as string
          const [redisBackup] = await workerContext.db
            .select()
            .from(databaseBackups)
            .where(eq(databaseBackups.id, redisBackupId))
          assert.equal(
            redisBackup!.state,
            'complete',
            `Redis backup failed with ${redisBackup!.errorCode ?? 'no error code'}`,
          )
          const redisObject = await backupS3.send(
            new GetObjectCommand({
              Bucket: backupBucket,
              Key: redisBackup!.manifest[0]!.key,
            }),
          )
          const rdb = decryptBackup(
            workerContext,
            redisBackupId,
            Buffer.from(await redisObject.Body!.transformToByteArray()),
          )
          assert.equal(rdb.subarray(0, 5).toString(), 'REDIS')
          assert.equal(
            docker([
              'exec',
              `fleet-db-${id}-database`,
              'sh',
              '-c',
              'find /tmp -maxdepth 1 -name "fleet-db-backup-*.rdb" -print',
            ]),
            '',
          )
          backupObjectKeys.push(`e2e/databases/${id}/${redisBackupId}/data.enc`)
          t.diagnostic('encrypted Redis RDB uploaded and verified in MinIO')
          t.diagnostic(
            'encrypted PostgreSQL dump uploaded and verified in MinIO',
          )
          const databaseBase = `/fleets/${fleetId}/projects/${identity.project}/databases`
          const finalBackupId = backupId
          const deletionKey = randomUUID()
          const deletion = await api.inject({
            method: 'POST',
            url: `${databaseBase}/${postgresId}/delete`,
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              'idempotency-key': deletionKey,
            },
            payload: {
              confirmation: 'tunnel-postgres',
              backupId: finalBackupId,
            },
          })
          assert.equal(deletion.statusCode, 202, deletion.body)
          assert.equal(deletion.json().database.status, 'deleting')
          t.diagnostic('verified backup accepted and delete queued')
          assert.equal(await worker.tick(), true)
          t.diagnostic('delete worker returned')
          let deleteOperation
          for (let attempt = 0; attempt < 4; attempt++) {
            ;[deleteOperation] = await workerContext.db
              .select({
                state: databaseOperations.state,
                errorCode: databaseOperations.errorCode,
              })
              .from(databaseOperations)
              .where(eq(databaseOperations.id, deletion.json().operation.id))
            if (
              deleteOperation!.state === 'succeeded' ||
              deleteOperation!.state === 'failed'
            )
              break
            if (deleteOperation!.state === 'running') {
              await until(() => workerContext.tunnels.has(nodeId))
              await workerContext.db
                .update(databaseOperations)
                .set({
                  leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
                })
                .where(eq(databaseOperations.id, deletion.json().operation.id))
            }
            await worker.tick()
          }
          assert.deepEqual(
            deleteOperation,
            {
              state: 'succeeded',
              errorCode: null,
            },
            'delete operation must reconcile after its lease resumes',
          )
          t.diagnostic('delete operation committed')
          const replayedDelete = await api.inject({
            method: 'POST',
            url: `${databaseBase}/${postgresId}/delete`,
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              'idempotency-key': deletionKey,
            },
            payload: {
              confirmation: 'tunnel-postgres',
              backupId: finalBackupId,
            },
          })
          assert.equal(replayedDelete.statusCode, 202, replayedDelete.body)
          assert.equal(
            replayedDelete.json().operation.id,
            deletion.json().operation.id,
          )
          const [deleted] = await workerContext.db
            .select({
              status: tenantDatabases.status,
              deletedAt: tenantDatabases.deletedAt,
              purgeAfter: tenantDatabases.purgeAfter,
            })
            .from(tenantDatabases)
            .where(eq(tenantDatabases.id, postgresId))
          assert.equal(deleted!.status, 'deleting')
          assert.ok(deleted!.deletedAt)
          assert.ok(deleted!.purgeAfter! > new Date())
          assert.equal(
            docker([
              'ps',
              '-aq',
              '--filter',
              `name=fleet-db-${postgresId}-database`,
            ]),
            '',
          )
          docker(['volume', 'inspect', `fleet-db-${postgresId}-data`])
          const undelete = await api.inject({
            method: 'POST',
            url: `${databaseBase}/${postgresId}/restore-deleted`,
            headers: { authorization: `Bearer ${account.accessToken}` },
          })
          assert.equal(undelete.statusCode, 200, undelete.body)
          assert.equal(undelete.json().database.status, 'stopped')
          assert.equal(undelete.json().database.deletedAt, null)
          const restoreStart = await api.inject({
            method: 'POST',
            url: `${databaseBase}/${postgresId}/actions`,
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              'idempotency-key': randomUUID(),
            },
            payload: { action: 'start' },
          })
          assert.equal(restoreStart.statusCode, 202, restoreStart.body)
          assert.equal(await worker.tick(), true)
          const [started] = await workerContext.db
            .select({ state: databaseOperations.state })
            .from(databaseOperations)
            .where(eq(databaseOperations.id, restoreStart.json().operation.id))
          assert.equal(started!.state, 'succeeded')
          assert.equal(
            docker([
              'exec',
              '-e',
              `PGPASSWORD=${postgresCredentials.owner.password}`,
              `fleet-db-${postgresId}-database`,
              'psql',
              '-X',
              '-A',
              '-t',
              '-U',
              postgresCredentials.owner.username,
              '-d',
              'tunnel_postgres',
              '-c',
              'SELECT value FROM restore_marker',
            ]),
            'restored-from-verified-backup',
          )
          t.diagnostic(
            'typed delete retained the Docker data volume and undelete recovered its rows',
          )
        }
        const apiUrl = await api.listen({ port: 0, host: '127.0.0.1' })
        const connectUrl = new URL(
          `/fleets/${fleetId}/projects/${identity.project}/databases/${id}/connect`,
          apiUrl,
        )
        connectUrl.protocol = 'ws:'
        const unauthorized = new WebSocket(connectUrl)
        const unauthorizedStatus = await new Promise<number>(
          (resolve, reject) => {
            unauthorized.once('unexpected-response', (_request, response) => {
              response.resume()
              resolve(response.statusCode ?? 0)
            })
            unauthorized.once('error', reject)
          },
        )
        assert.equal(unauthorizedStatus, 401)
        t.diagnostic('unauthenticated database WebSocket rejected')
        const portProbe = createTCPServer()
        portProbe.listen(0, '127.0.0.1')
        await once(portProbe, 'listening')
        const portProbeAddress = portProbe.address()
        assert.ok(portProbeAddress && typeof portProbeAddress !== 'string')
        const localPort = portProbeAddress.port
        await new Promise<void>((resolve, reject) =>
          portProbe.close((error) => (error ? reject(error) : resolve())),
        )
        const cli = spawn(
          'node',
          [
            '--import',
            'tsx',
            'src/index.ts',
            'db',
            'connect',
            'tunnel',
            '--project',
            identity.project,
            '--port',
            String(localPort),
          ],
          {
            cwd: '../cli',
            env: {
              ...process.env,
              FLEET_API: apiUrl,
              FLEET_TOKEN: account.accessToken,
              FLEET_ID: fleetId,
              FLEET_CONFIG: `/tmp/fleet-db-connect-${id}.json`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        cliProcess = cli
        const cliOutput: Buffer[] = []
        const cliErrors: Buffer[] = []
        cli.stdout?.on('data', (chunk) => cliOutput.push(chunk))
        cli.stderr?.on('data', (chunk) => cliErrors.push(Buffer.from(chunk)))
        cli.once('error', (error) => {
          throw error
        })
        await until(() =>
          Buffer.concat(cliOutput)
            .toString()
            .includes(`127.0.0.1:${localPort}`),
        )
        t.diagnostic('local CLI forwarder is listening')
        const localClient = createConnection({
          host: '127.0.0.1',
          port: localPort,
        })
        await once(localClient, 'connect')
        t.diagnostic('local client connected to CLI forwarder')
        const streamOutput: Buffer[] = []
        localClient.on('error', (error) =>
          t.diagnostic(`local client socket error: ${error.message}`),
        )
        localClient.on('data', (chunk) => streamOutput.push(Buffer.from(chunk)))
        localClient.write(auth)
        localClient.write(resp([Buffer.from('PING')]))
        const pongDeadline = Date.now() + 30000
        while (
          !Buffer.concat(streamOutput).includes(Buffer.from('+PONG\r\n')) &&
          Date.now() < pongDeadline
        )
          await delay(20)
        assert.ok(
          Buffer.concat(streamOutput).includes(Buffer.from('+PONG\r\n')),
          Buffer.concat(cliErrors).toString(),
        )
        t.diagnostic('local CLI forwarder completed Redis PING')
        assert.ok(Buffer.concat(streamOutput).includes(Buffer.from('+OK\r\n')))
        const execOutput: Buffer[] = []
        const execProcess = spawn(
          'node',
          [
            '--import',
            'tsx',
            'src/index.ts',
            'db',
            'exec',
            'tunnel',
            '--project',
            identity.project,
            '--',
            'PING',
          ],
          {
            cwd: '../cli',
            env: {
              ...process.env,
              FLEET_API: apiUrl,
              FLEET_TOKEN: account.accessToken,
              FLEET_ID: fleetId,
              FLEET_CONFIG: `/tmp/fleet-db-exec-${id}.json`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        const execErrors: Buffer[] = []
        execProcess.stderr?.on('data', (chunk) =>
          execErrors.push(Buffer.from(chunk)),
        )
        execProcess.stdout?.on('data', (chunk) =>
          execOutput.push(Buffer.from(chunk)),
        )
        const execExit = await once(execProcess, 'exit')
        assert.equal(execExit[0], 0, Buffer.concat(execErrors).toString())
        assert.match(Buffer.concat(execOutput).toString(), /PONG/)
        t.diagnostic(
          'authenticated CLI db exec completed Redis PING over the tunnel',
        )
        const postgresOutput: Buffer[] = []
        const postgresErrors: Buffer[] = []
        const postgresExec = spawn(
          'node',
          [
            '--import',
            'tsx',
            'src/index.ts',
            'db',
            'exec',
            'tunnel-postgres',
            '--project',
            identity.project,
            '-c',
            'SELECT 1',
          ],
          {
            cwd: '../cli',
            env: {
              ...process.env,
              FLEET_API: apiUrl,
              FLEET_TOKEN: account.accessToken,
              FLEET_ID: fleetId,
              FLEET_CONFIG: `/tmp/fleet-db-psql-exec-${id}.json`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        postgresExec.stdout?.on('data', (chunk) =>
          postgresOutput.push(Buffer.from(chunk)),
        )
        postgresExec.stderr?.on('data', (chunk) =>
          postgresErrors.push(Buffer.from(chunk)),
        )
        const postgresExit = await once(postgresExec, 'exit')
        assert.equal(
          postgresExit[0],
          0,
          Buffer.concat(postgresErrors).toString(),
        )
        assert.match(Buffer.concat(postgresOutput).toString(), /1/)
        t.diagnostic(
          'authenticated CLI db exec completed Postgres SELECT 1 over the tunnel',
        )
        const runDump = async (databaseName: string, outputPath: string) => {
          const dumpProcess = spawn(
            'node',
            [
              '--import',
              'tsx',
              'src/index.ts',
              'db',
              'dump',
              databaseName,
              outputPath,
              '--project',
              identity.project,
            ],
            {
              cwd: '../cli',
              env: {
                ...process.env,
                FLEET_API: apiUrl,
                FLEET_TOKEN: account.accessToken,
                FLEET_ID: fleetId,
                FLEET_CONFIG: `/tmp/fleet-db-dump-${id}-${databaseName}.json`,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          )
          const stdout: Buffer[] = []
          const stderr: Buffer[] = []
          dumpProcess.stdout?.on('data', (chunk) =>
            stdout.push(Buffer.from(chunk)),
          )
          dumpProcess.stderr?.on('data', (chunk) =>
            stderr.push(Buffer.from(chunk)),
          )
          const [exitCode] = await once(dumpProcess, 'exit')
          return {
            exitCode,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          }
        }
        const dump = async (databaseName: string, extension: string) => {
          const outputPath = `/tmp/fleet-db-${id}-${databaseName}.${extension}`
          const result = await runDump(databaseName, outputPath)
          assert.equal(result.exitCode, 0, result.stderr.toString())
          assert.match(result.stdout.toString(), /Database dump saved/)
          const mode = statSync(outputPath).mode & 0o777
          assert.equal(mode, 0o600)
          const data = readFileSync(outputPath)
          unlinkSync(outputPath)
          return data
        }
        const pgDump = await dump('tunnel-postgres', 'dump')
        assert.equal(pgDump.subarray(0, 5).toString(), 'PGDMP')
        const redisDump = await dump('tunnel', 'rdb')
        assert.equal(redisDump.subarray(0, 5).toString(), 'REDIS')
        const exportAudit = await workerContext!.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, 'database.export.started'))
        assert.equal(exportAudit.length, 2)
        assert.deepEqual(
          exportAudit.map((entry) => entry.metadata?.format).sort(),
          ['pg_dump_custom', 'redis_rdb'],
        )
        const existingPath = `/tmp/fleet-db-${id}-existing.dump`
        writeFileSync(existingPath, 'preserve existing file')
        const refusedDump = await runDump('tunnel-postgres', existingPath)
        assert.notEqual(refusedDump.exitCode, 0)
        assert.equal(
          readFileSync(existingPath, 'utf8'),
          'preserve existing file',
        )
        unlinkSync(existingPath)
        t.diagnostic(
          'CLI streamed real Postgres custom and Redis RDB exports to mode-0600 files',
        )
        const postgresPortProbe = createTCPServer()
        postgresPortProbe.listen(0, '127.0.0.1')
        await once(postgresPortProbe, 'listening')
        const postgresPortAddress = postgresPortProbe.address()
        assert.ok(
          postgresPortAddress && typeof postgresPortAddress !== 'string',
        )
        const postgresPort = postgresPortAddress.port
        await new Promise<void>((resolve, reject) =>
          postgresPortProbe.close((error) =>
            error ? reject(error) : resolve(),
          ),
        )
        const postgresCli = spawn(
          'node',
          [
            '--import',
            'tsx',
            'src/index.ts',
            'db',
            'connect',
            'tunnel-postgres',
            '--project',
            identity.project,
            '--port',
            String(postgresPort),
          ],
          {
            cwd: '../cli',
            env: {
              ...process.env,
              FLEET_API: apiUrl,
              FLEET_TOKEN: account.accessToken,
              FLEET_ID: fleetId,
              FLEET_CONFIG: `/tmp/fleet-db-psql-connect-${id}.json`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        postgresCliProcess = postgresCli
        const postgresCliOutput: Buffer[] = []
        postgresCli.stdout?.on('data', (chunk) =>
          postgresCliOutput.push(Buffer.from(chunk)),
        )
        await until(() =>
          Buffer.concat(postgresCliOutput)
            .toString()
            .includes(`127.0.0.1:${postgresPort}`),
        )
        const psql = postgresClient({
          host: '127.0.0.1',
          port: postgresPort,
          username: postgresCredentials.app.username,
          password: postgresCredentials.app.password,
          database: 'tunnel_postgres',
          max: 1,
        })
        try {
          const [row] = await psql`SELECT 1 AS value`
          assert.equal(row!.value, 1)
        } finally {
          await psql.end()
        }
        const postgresCliExit = once(postgresCli, 'exit')
        postgresCli.kill('SIGINT')
        await postgresCliExit
        postgresCliProcess = undefined
        t.diagnostic(
          'Postgres protocol query succeeded through CLI local TCP forwarding',
        )
        const disconnected = once(localClient, 'close')
        await revokeSessions(workerContext.redis, account.user.id)
        await disconnected
        const cliExit = once(cli, 'exit')
        cli.kill('SIGINT')
        await cliExit
        cliProcess = undefined
        const [finished] = await workerContext.db
          .select()
          .from(databaseOperations)
          .where(eq(databaseOperations.id, created.id))
        assert.equal(finished!.state, 'succeeded')
        const restartIntent = {
          identity,
          readiness: { ...plan.readiness, stdin: plan.readiness.stdin ?? '' },
        }
        const restart = await enqueueDatabaseOperation(
          workerContext,
          scope,
          'restart',
          'restart',
          restartIntent,
        )
        const claimed = await claimDatabaseOperation(workerContext, ['restart'])
        assert.equal(claimed!.operation.id, restart.id)
        await relay.runOperation(
          { ...restartIntent, id: restart.id, action: 'restart' },
          new AbortController().signal,
        )
        const startedAt = docker([
          'inspect',
          '--format',
          '{{.State.StartedAt}}',
          `fleet-db-${id}-database`,
        ])
        await worker.close()
        await workerContext.db
          .update(databaseOperations)
          .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(databaseOperations.id, restart.id))
        worker = new DatabaseWorker(workerContext)
        assert.equal(await worker.tick(), true)
        const [resumed] = await workerContext.db
          .select()
          .from(databaseOperations)
          .where(eq(databaseOperations.id, restart.id))
        assert.equal(resumed!.state, 'succeeded')
        assert.equal(resumed!.attempts, 2)
        assert.equal(
          docker([
            'inspect',
            '--format',
            '{{.State.StartedAt}}',
            `fleet-db-${id}-database`,
          ]),
          startedAt,
        )
        const abort = new AbortController()
        const progress = []
        for await (const event of streamDatabaseProgress(
          workerContext,
          scope,
          abort.signal,
        )) {
          progress.push(event)
          if (event.operationId === restart.id && event.code === 'succeeded') {
            abort.abort()
            break
          }
        }
        assert.ok(progress.some((event) => event.code === 'checkpoint'))
        assert.equal(progress.at(-1)!.progress, 100)
        assert.ok(
          !JSON.stringify(progress).includes(credentials.owner.password),
        )
      } else {
        await relay.runOperation(
          {
            id: randomUUID(),
            action: 'provision',
            identity,
            readiness: plan.readiness,
            containers: plan.containers.map((container) => ({
              initialize: true,
              identity,
              network: plan.network,
              volume: `fleet-db-${id}-data`,
              dataPath: plan.dataPath,
              platform,
              cpu: 0.5,
              container,
            })),
          },
          new AbortController().signal,
        )
      }
      const payload = randomBytes(2 * 1024 * 1024)
      const request = Buffer.concat([
        auth,
        resp([Buffer.from('SET'), Buffer.from('payload'), payload]),
        resp([Buffer.from('GET'), Buffer.from('payload')]),
      ])
      const transfer = async () => {
        const stream = relay.open(
          { identity, role: 'database', port: 6379, timeoutMs: 30000 },
          new AbortController().signal,
        )
        const output: Buffer[] = []
        stream.on('data', (chunk) => output.push(chunk))
        const finished = once(stream, 'end')
        stream.end(request)
        await finished
        const data = Buffer.concat(output)
        assert.ok(data.includes(payload))
        stream.destroy()
      }
      const started = performance.now()
      await transfer()
      const elapsedMs = performance.now() - started
      t.diagnostic(
        JSON.stringify({
          bytes: payload.length,
          rttMs: 100,
          elapsedMs,
          stopAndWaitMinimumMs: 12800,
        }),
      )
      assert.ok(elapsedMs < 12800 / 2)
      proxy.listen(0, '127.0.0.1')
      await once(proxy, 'listening')
      const endpoint = proxy.address()
      assert.ok(endpoint && typeof endpoint !== 'string')
      const service = await registry.runTask(
        serviceNodeId,
        {
          service: 'tunnel-client',
          image: JSON.parse(
            readFileSync(
              new URL(
                '../../deploy/databases/images.lock.json',
                import.meta.url,
              ),
              'utf8',
            ),
          ).redis,
          platform,
          command: [
            'sh',
            '-c',
            `redis-cli --raw --user fleet_app -h host.docker.internal -p ${endpoint.port} GET payload | sha256sum`,
          ],
          env: { REDISCLI_AUTH: credentials.app.password },
          registry_auth: null,
          memory_bytes: 128 * 1048576,
          timeout_ms: 30000,
        },
        new AbortController().signal,
      )
      assert.equal(service.exitCode, 0)
      assert.ok(
        service.output.includes(
          createHash('sha256')
            .update(Buffer.concat([payload, Buffer.from('\n')]))
            .digest('hex'),
        ),
      )
      const dropped = relay.open(
        { identity, role: 'database', port: 6379, timeoutMs: 30000 },
        new AbortController().signal,
      )
      const interrupted = once(dropped, 'error')
      await once(dropped, 'ready')
      dropped.write(
        Buffer.concat([
          auth,
          resp([
            Buffer.from('SET'),
            Buffer.from('interrupted'),
            randomBytes(8 * 1024 * 1024),
          ]),
        ]),
        () => {},
      )
      await delay(100)
      registry.close(nodeId)
      await interrupted
      await until(() => registry.has(nodeId))
      await transfer()
    } finally {
      if (backupS3) {
        for (const key of backupObjectKeys)
          await backupS3
            .send(new DeleteObjectCommand({ Bucket: backupBucket, Key: key }))
            .catch(() => {})
        if (backupBucket)
          await backupS3
            .send(new DeleteBucketCommand({ Bucket: backupBucket }))
            .catch(() => {})
        backupS3.destroy()
      }
      cliProcess?.kill('SIGTERM')
      postgresCliProcess?.kill('SIGTERM')
      if (api) await api.close()
      await worker?.close()
      relay.close()
      registry.close(nodeId)
      registry.close(serviceNodeId)
      for (const child of peers) {
        child.stdin?.end()
        child.kill('SIGTERM')
      }
      proxy.close()
      for (const socket of wss.clients) socket.terminate()
      wss.close()
      server.close()
      for (const databaseId of [id, postgresId, restoreTargetId]) {
        const containers = docker([
          'ps',
          '-aq',
          '--filter',
          `label=io.fleet.database=${databaseId}`,
        ])
        if (containers) docker(['rm', '-f', ...containers.split(/\s+/)])
        const volumes = docker([
          'volume',
          'ls',
          '-q',
          '--filter',
          `label=io.fleet.database=${databaseId}`,
        ])
        if (volumes) docker(['volume', 'rm', ...volumes.split(/\s+/)])
      }
      try {
        docker(['network', 'rm', plan.network])
      } catch {}
      if (workerContext) {
        await workerContext.db
          .delete(databaseBackups)
          .where(sql`${databaseBackups.databaseId} in (${id}, ${postgresId})`)
        await workerContext.db
          .delete(databaseBackupTargets)
          .where(eq(databaseBackupTargets.fleetId, fleetId))
        await workerContext.db
          .delete(tenantDatabases)
          .where(
            sql`${tenantDatabases.id} in (${id}, ${postgresId}, ${restoreTargetId})`,
          )
        await workerContext.db.delete(orgs).where(eq(orgs.id, orgId))
        if (connectAccount) {
          await workerContext.db
            .delete(orgs)
            .where(eq(orgs.id, connectAccount.org.id))
          await workerContext.db
            .delete(users)
            .where(eq(users.id, connectAccount.user.id))
        }
        await closeContext(workerContext)
      }
    }
  },
)
