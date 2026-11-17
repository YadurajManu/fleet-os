import type { FastifyBaseLogger } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../api/context.js'
import { nodes, tenantDatabases } from '../db/schema.js'
import { requireDatabaseCapabilities } from './capabilities.js'
import {
  checkpointDatabaseOperation,
  claimDatabaseOperation,
  commitDatabaseLifecycleOperation,
  finishDatabaseOperation,
  renewDatabaseOperation,
  type OperationClaim,
} from './operations.js'
import { DatabaseTunnel, type DatabaseOperation } from './tunnel.js'

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
              .regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
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
    const claim = await claimDatabaseOperation(this.ctx, [
      'create',
      'start',
      'stop',
      'restart',
    ])
    if (!claim) return false
    await this.execute(claim)
    return true
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
    } catch {
      // A lost reply does not prove failure: lease expiry resumes the same agent receipt, with bounded attempts.
    } finally {
      clearInterval(renew)
      await renewTask
      this.controller.signal.removeEventListener('abort', cancel)
    }
  }
}
