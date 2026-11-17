import type { FastifyBaseLogger } from 'fastify'
import { and, asc, eq, lte, ne } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../api/context.js'
import { ApiError } from '../api/errors.js'
import {
  databaseBackupSchedules,
  databaseBackups,
  fleets,
  nodes,
  tenantDatabases,
} from '../db/schema.js'
import { requireDatabaseCapabilities } from './capabilities.js'
import {
  checkpointDatabaseOperation,
  claimDatabaseOperation,
  commitDatabaseLifecycleOperation,
  commitDatabaseDeleteOperation,
  finishDatabaseOperation,
  renewDatabaseOperation,
  type OperationClaim,
} from './operations.js'
import { DatabaseTunnel, type DatabaseOperation } from './tunnel.js'
import {
  createDatabaseBackup,
  runDatabaseBackup,
  runDatabaseRestore,
} from './backups.js'

const command = z.object({
  command: z.array(z.string()).min(1).max(128),
  env: z.record(z.string(), z.string()),
  stdin: z.string().default(''),
})
const identity = z.object({
  id: z.string().uuid(),
  fleetId: z.string().uuid(),
  nodeId: z.string().uuid(),
  project: z.string(),
  generation: z.number().int().positive(),
})
const intent = z
  .object({
    backupId: z.string().uuid().optional(),
    recoveryTarget: z
      .object({
        type: z.enum(['time', 'name']),
        value: z.string().min(1).max(80),
      })
      .optional(),
    finalBackupId: z.string().uuid().optional(),
    sourceDatabaseId: z.string().uuid().optional(),
    actorOrgId: z.string().uuid().optional(),
    actorUserId: z.string().uuid().optional(),
    identity,
    requestHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    images: z
      .array(
        z.object({
          reference: z.string(),
          platform: z.enum(['linux/arm64', 'linux/amd64']),
          required_bytes: z.number().int().min(67108864).max(8589934592),
        }),
      )
      .max(8)
      .optional(),
    registryAuth: z.string().max(16384).optional(),
    reserveBytes: z.number().int().min(1073741824).optional(),
    containers: z
      .array(
        z.object({
          initialize: z.boolean(),
          identity,
          network: z.string(),
          volume: z.string(),
          dataPath: z.string(),
          platform: z.enum(['linux/arm64', 'linux/amd64']),
          cpu: z.number().positive(),
          container: z.object({
            role: z.enum(['database', 'pooler']),
            image: z
              .string()
              .regex(/^(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/),
            command: z.array(z.string()),
            env: z.record(z.string(), z.string()),
            files: z.array(
              z.object({
                path: z.string(),
                content: z.string(),
                secret: z.boolean(),
                mode: z.number().int(),
              }),
            ),
            aliases: z.array(z.string()),
            memoryMb: z.number().int().positive(),
            port: z.number().int(),
          }),
        }),
      )
      .max(2)
      .optional(),
    bootstrap: command.nullable().optional(),
    readiness: command.optional(),
  })
  .strict()

/** Inputs are encrypted server-generated runtime intents, never caller-supplied Docker plans. */
export class DatabaseWorker {
  private controller = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private active: Promise<boolean> | undefined
  private nextBackupScan = 0
  private tunnel: DatabaseTunnel
  constructor(private ctx: AppContext) {
    this.tunnel = new DatabaseTunnel(ctx.tunnels)
  }

  start(log: Pick<FastifyBaseLogger, 'warn'>): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        log.warn('Database worker could not claim pending work; will retry.')
      })
    }, 1000)
    this.timer.unref()
  }
  async close(): Promise<void> {
    clearInterval(this.timer)
    this.controller.abort()
    await this.active?.catch(() => {})
    this.tunnel.close()
  }
  tick(): Promise<boolean> {
    if (this.controller.signal.aborted) return Promise.resolve(false)
    if (this.active) return this.active
    this.active = this.run().finally(() => {
      this.active = undefined
    })
    return this.active
  }
  private async run(): Promise<boolean> {
    await this.queueScheduledBackups()
    const claim = await claimDatabaseOperation(this.ctx, [
      'create',
      'start',
      'stop',
      'restart',
      'backup',
      'restore',
      'delete',
    ])
    if (!claim) return false
    await this.execute(claim)
    return true
  }
  private async queueScheduledBackups(): Promise<void> {
    if (Date.now() < this.nextBackupScan) return
    this.nextBackupScan = Date.now() + 60_000
    const due = await this.ctx.db
      .select({
        schedule: databaseBackupSchedules,
        database: tenantDatabases,
        orgId: fleets.orgId,
      })
      .from(databaseBackupSchedules)
      .innerJoin(
        tenantDatabases,
        eq(databaseBackupSchedules.databaseId, tenantDatabases.id),
      )
      .innerJoin(fleets, eq(tenantDatabases.fleetId, fleets.id))
      .where(
        and(
          eq(databaseBackupSchedules.enabled, true),
          lte(databaseBackupSchedules.nextRunAt, new Date()),
        ),
      )
      .orderBy(asc(databaseBackupSchedules.nextRunAt))
      .limit(20)
    for (const { schedule, database, orgId } of due) {
      if (
        database.deletedAt ||
        database.status !== 'running' ||
        !database.backupTargetId
      )
        continue
      const dueDate = schedule.nextRunAt.toISOString().slice(0, 10)
      try {
        await createDatabaseBackup(
          this.ctx,
          {
            fleetId: database.fleetId,
            project: database.project,
            databaseId: database.id,
          },
          `scheduled:${dueDate}`,
          { orgId, actorKind: 'system' },
          {
            kind: database.engine === 'postgres' ? 'base' : 'rdb',
            label: 'scheduled-daily',
          },
        )
      } catch (error) {
        if (error instanceof ApiError && error.code === 'database_busy')
          continue
        throw error
      }
      await this.ctx.db
        .update(databaseBackupSchedules)
        .set({
          nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          lastQueuedAt: new Date(),
        })
        .where(eq(databaseBackupSchedules.databaseId, database.id))
    }
  }
  private async execute(claim: OperationClaim): Promise<void> {
    if (this.controller.signal.aborted) return
    const { operation, token } = claim
    const abort = new AbortController()
    const cancel = () => abort.abort()
    this.controller.signal.addEventListener('abort', cancel, { once: true })
    let renewTask: Promise<void> | undefined
    let renewing = false
    let leaseLost = false
    const renew = setInterval(() => {
      if (renewing) return
      renewing = true
      renewTask = renewDatabaseOperation(this.ctx, operation.id, token)
        .catch(() => {
          leaseLost = true
          abort.abort()
        })
        .finally(() => {
          renewing = false
        })
    }, 10000)
    try {
      const parsed = intent.safeParse(claim.input)
      if (!parsed.success) {
        await finishDatabaseOperation(
          this.ctx,
          operation.id,
          token,
          'runtime_failed',
        )
        return
      }
      const [database] = await this.ctx.db
        .select()
        .from(tenantDatabases)
        .where(
          and(
            eq(tenantDatabases.id, operation.databaseId),
            eq(tenantDatabases.generation, operation.generation),
          ),
        )
      if (!database?.nodeId) {
        await finishDatabaseOperation(
          this.ctx,
          operation.id,
          token,
          'generation_changed',
        )
        return
      }
      const expected = {
        id: database.id,
        fleetId: database.fleetId,
        project: database.project,
        nodeId: database.nodeId,
        generation: database.generation,
      }
      if (
        Object.entries(expected).some(
          ([key, value]) =>
            parsed.data.identity[key as keyof typeof expected] !== value,
        )
      ) {
        await finishDatabaseOperation(
          this.ctx,
          operation.id,
          token,
          'generation_changed',
        )
        return
      }
      const [node] = await this.ctx.db
        .select({ capabilities: nodes.databaseCapabilities })
        .from(nodes)
        .where(
          and(
            eq(nodes.id, database.nodeId),
            eq(nodes.fleetId, database.fleetId),
          ),
        )
      requireDatabaseCapabilities(node?.capabilities, ['database.runtime.v1'])
      if (!this.ctx.tunnels.has(database.nodeId)) return // Preserve the lease for receipt reconciliation after reconnect.
      if (operation.kind === 'backup') {
        if (!parsed.data.backupId) throw new Error('backup_intent_invalid')
        requireDatabaseCapabilities(node?.capabilities, ['database.exec.v1'])
        let backupProgress = Math.max(operation.progress, 20)
        await checkpointDatabaseOperation(
          this.ctx,
          operation.id,
          token,
          { step: 'execute' },
          backupProgress,
        )
        await runDatabaseBackup(
          this.ctx,
          this.tunnel,
          parsed.data.backupId,
          database,
          parsed.data.identity,
          abort.signal,
          async (step, progress) => {
            backupProgress = Math.max(backupProgress, Math.min(progress, 99))
            await checkpointDatabaseOperation(
              this.ctx,
              operation.id,
              token,
              {
                step:
                  step === 'verify'
                    ? 'verify'
                    : step === 'commit'
                      ? 'commit'
                      : 'execute',
              },
              backupProgress,
            )
          },
        )
        if (!leaseLost && !abort.signal.aborted)
          await finishDatabaseOperation(this.ctx, operation.id, token)
        return
      }
      if (operation.kind === 'restore') {
        requireDatabaseCapabilities(node?.capabilities, ['database.exec.v1'])
        if (
          !parsed.data.backupId ||
          !parsed.data.sourceDatabaseId ||
          !parsed.data.actorOrgId ||
          !parsed.data.actorUserId
        )
          throw new Error('restore_intent_invalid')
        let restoreProgress = Math.max(operation.progress, 20)
        await checkpointDatabaseOperation(
          this.ctx,
          operation.id,
          token,
          { step: 'execute' },
          restoreProgress,
        )
        await runDatabaseRestore(
          this.ctx,
          this.tunnel,
          parsed.data.sourceDatabaseId,
          parsed.data.backupId,
          database,
          parsed.data.identity,
          parsed.data.recoveryTarget,
          {
            orgId: parsed.data.actorOrgId,
            userId: parsed.data.actorUserId,
          },
          abort.signal,
          async (step, progress) => {
            restoreProgress = Math.max(restoreProgress, Math.min(progress, 99))
            await checkpointDatabaseOperation(
              this.ctx,
              operation.id,
              token,
              { step: step === 'verify' ? 'verify' : 'execute' },
              restoreProgress,
            )
          },
        )
        if (!leaseLost && !abort.signal.aborted)
          await commitDatabaseLifecycleOperation(
            this.ctx,
            operation.id,
            token,
            'running',
          )
        return
      }
      if (operation.kind === 'delete') {
        const [finalBackup] = parsed.data.finalBackupId
          ? await this.ctx.db
              .select({
                id: databaseBackups.id,
                engine: databaseBackups.engine,
                kind: databaseBackups.kind,
                createdAt: databaseBackups.createdAt,
                verifiedAt: databaseBackups.verifiedAt,
              })
              .from(databaseBackups)
              .where(
                and(
                  eq(databaseBackups.id, parsed.data.finalBackupId),
                  eq(databaseBackups.databaseId, database.id),
                  eq(databaseBackups.state, 'complete'),
                ),
              )
          : []
        const expectedKind = database.engine === 'postgres' ? 'logical' : 'rdb'
        if (
          !finalBackup?.verifiedAt ||
          finalBackup.engine !== database.engine ||
          finalBackup.kind !== expectedKind ||
          Date.now() - finalBackup.createdAt.getTime() > 15 * 60 * 1000 ||
          Date.now() - finalBackup.verifiedAt.getTime() > 15 * 60 * 1000
        )
          throw new Error('final_backup_unavailable')
        const runtime: DatabaseOperation = {
          ...parsed.data,
          id: operation.id,
          action: 'delete',
        }
        await checkpointDatabaseOperation(
          this.ctx,
          operation.id,
          token,
          { step: 'execute' },
          Math.max(operation.progress, 20),
        )
        const receipt = await this.tunnel.runOperation(runtime, abort.signal)
        if (leaseLost || abort.signal.aborted) return
        if (receipt.phase !== 'stopped') return
        await checkpointDatabaseOperation(
          this.ctx,
          operation.id,
          token,
          { step: 'verify', completed: true },
          Math.max(operation.progress, 90),
        )
        await commitDatabaseDeleteOperation(this.ctx, operation.id, token)
        return
      }
      await checkpointDatabaseOperation(
        this.ctx,
        operation.id,
        token,
        { step: 'execute' },
        Math.max(operation.progress, 20),
      )
      const runtime: DatabaseOperation = {
        ...parsed.data,
        id: operation.id,
        action:
          operation.kind === 'create'
            ? 'provision'
            : (operation.kind as 'start' | 'stop' | 'restart'),
      }
      const receipt = await this.tunnel.runOperation(runtime, abort.signal)
      if (leaseLost || abort.signal.aborted) return
      const status = operation.kind === 'stop' ? 'stopped' : 'running'
      if (receipt.phase !== status) return
      await checkpointDatabaseOperation(
        this.ctx,
        operation.id,
        token,
        { step: 'verify', completed: true },
        Math.max(operation.progress, 90),
      )
      await commitDatabaseLifecycleOperation(
        this.ctx,
        operation.id,
        token,
        status,
      )
    } catch (error) {
      if (operation.kind === 'restore')
        await finishDatabaseOperation(
          this.ctx,
          operation.id,
          token,
          error instanceof Error &&
            error.message.includes(
              '(operation_restore_failed_previous_data_was_restored)',
            )
            ? 'restore_rolled_back'
            : 'runtime_failed',
        )
      if (operation.kind === 'backup') {
        const parsedInput = intent.safeParse(claim.input)
        const backupId = parsedInput.success ? parsedInput.data.backupId : null
        if (backupId) {
          const [backup] = await this.ctx.db
            .select({ errorCode: databaseBackups.errorCode })
            .from(databaseBackups)
            .where(eq(databaseBackups.id, backupId))
          await this.ctx.db
            .update(databaseBackups)
            .set({
              state: 'failed',
              errorCode: backup?.errorCode ?? 'backup_worker_failed',
              finishedAt: new Date(),
            })
            .where(
              and(
                eq(databaseBackups.id, backupId),
                ne(databaseBackups.state, 'complete'),
              ),
            )
        }
      }
      // A lost reply does not prove failure: lease expiry resumes the same agent receipt, with bounded attempts.
    } finally {
      clearInterval(renew)
      await renewTask
      this.controller.signal.removeEventListener('abort', cancel)
    }
  }
}
