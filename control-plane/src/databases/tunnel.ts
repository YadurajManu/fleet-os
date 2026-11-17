import { randomUUID } from 'node:crypto'
import { Duplex } from 'node:stream'
import { z } from 'zod'
import type { TunnelRegistry } from '../tunnel/registry.js'
import type { EngineCommand, EnginePlan } from './engines.js'

export type DatabaseIdentity = {
  id: string
  nodeId: string
  fleetId: string
  project: string
  generation: number
}
export type DatabaseOperation = {
  images?: Array<{
    reference: string
    platform: string
    required_bytes: number
  }>
  registryAuth?: string
  reserveBytes?: number
  id: string
  action: 'provision' | 'start' | 'stop' | 'restart' | 'delete' | 'restore'
  identity: DatabaseIdentity
  containers?: Array<{
    initialize: boolean
    identity: DatabaseIdentity
    network: string
    volume: string
    dataPath: string
    platform: string
    cpu: number
    container: EnginePlan['containers'][number]
  }>
  bootstrap?: EngineCommand | null
  readiness?: EngineCommand
  restore?: {
    backupName: string
    targetTime?: string
    targetName?: string
    env: Record<string, string>
    files: EnginePlan['containers'][number]['files']
  }
}
const identity = z.object({
  id: z.string().uuid(),
  nodeId: z.string().uuid(),
  fleetId: z.string().uuid(),
  project: z.string().min(1).max(512),
  generation: z.number().int().positive(),
})
const receipt = z.object({
  identity,
  operationId: z.string().uuid(),
  action: z.enum([
    'provision',
    'start',
    'stop',
    'restart',
    'delete',
    'restore',
  ]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['prepare', 'stopped', 'created', 'restored', 'running']),
  roles: z
    .array(z.enum(['database', 'pooler']))
    .min(1)
    .max(2),
  initialized: z.boolean(),
  bootstrapped: z.boolean(),
  complete: z.boolean(),
})
export type DatabaseReceipt = z.infer<typeof receipt>
const event = z.object({
  version: z.literal(1),
  type: z.enum([
    'db.result',
    'db.opened',
    'db.data',
    'db.ack',
    'db.closed',
    'db.disconnected',
  ]),
  id: z.string().uuid().optional(),
  seq: z.number().int().positive().optional(),
  window: z.union([z.literal(1), z.literal(16)]).optional(),
  data: z.string().max(43692).optional(),
  channel: z.enum(['stdout', 'stderr']).optional(),
  exitCode: z.number().int().min(-1).max(255).optional(),
  errorCode: z
    .string()
    .regex(/^[a-z_]{1,80}$/)
    .optional(),
  receipt: receipt.optional(),
})
type DatabaseEvent = z.infer<typeof event>
type Pending = {
  nodeId: string
  operation: DatabaseOperation
  finish: (value?: DatabaseReceipt, error?: Error) => void
}
export type SessionOptions = {
  identity: DatabaseIdentity
  role: 'database' | 'pooler'
  timeoutMs: number
  tty?: boolean
  command?: EngineCommand
  port?: number
}

export class DatabaseTunnel {
  private operations = new Map<string, Pending>()
  private streams = new Map<string, DatabaseStream>()
  private unsubscribe: () => void
  constructor(private registry: TunnelRegistry) {
    this.unsubscribe = registry.onDatabaseMessage((nodeId, body) =>
      this.receive(nodeId, body),
    )
  }
  close(): void {
    this.unsubscribe()
    for (const pending of this.operations.values())
      pending.finish(
        undefined,
        new Error('Database tunnel stopped; reconcile before retrying.'),
      )
    for (const stream of this.streams.values())
      stream.destroy(new Error('Database tunnel stopped.'))
  }
  runOperation(
    operation: DatabaseOperation,
    signal: AbortSignal,
  ): Promise<DatabaseReceipt> {
    const nodeId = operation.identity.nodeId,
      id = randomUUID()
    if (!this.registry.has(nodeId))
      return Promise.reject(new Error('Database node is disconnected.'))
    if (
      [...this.operations.values()].filter((item) => item.nodeId === nodeId)
        .length >= 2
    )
      return Promise.reject(new Error('Database operation limit reached.'))
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.registry.sendBuild(nodeId, {
          type: 'db.operation.cancel',
          version: 1,
          id,
        })
        finish(
          undefined,
          new Error(
            'Database operation interrupted; reconcile before retrying.',
          ),
        )
      }
      const timer = setTimeout(cancel, 600000)
      const finish: Pending['finish'] = (value, error) => {
        if (!this.operations.delete(id)) return
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        if (error) reject(error)
        else if (value) resolve(value)
      }
      this.operations.set(id, { nodeId, operation, finish })
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) {
        cancel()
        return
      }
      if (
        !this.registry.sendBuild(nodeId, {
          type: 'db.operation',
          version: 1,
          id,
          operation,
        })
      )
        finish(undefined, new Error('Database node disconnected.'))
    })
  }
  open(options: SessionOptions, signal: AbortSignal): DatabaseStream {
    const nodeId = options.identity.nodeId
    if (!this.registry.has(nodeId))
      throw new Error('Database node is disconnected.')
    if (
      [...this.streams.values()].filter((stream) => stream.nodeId === nodeId)
        .length >= 8
    )
      throw new Error('Database session limit reached.')
    const id = randomUUID(),
      stream = new DatabaseStream(
        id,
        options,
        signal,
        (body) => this.registry.sendBuild(nodeId, body),
        () => this.streams.delete(id),
      )
    this.streams.set(id, stream)
    stream.start()
    return stream
  }
  private receive(nodeId: string, body: unknown): void {
    const parsed = event.safeParse(body)
    if (!parsed.success) {
      if (
        body &&
        typeof body === 'object' &&
        'id' in body &&
        typeof body.id === 'string'
      ) {
        const pending = this.operations.get(body.id)
        if (pending?.nodeId === nodeId) {
          pending.finish(
            undefined,
            new Error('Invalid database operation response.'),
          )
          return
        }
        const stream = this.streams.get(body.id)
        if (stream?.nodeId === nodeId)
          stream.destroy(new Error('Invalid database stream message.'))
      }
      return
    }
    const message = parsed.data
    if (message.type === 'db.disconnected') {
      for (const pending of this.operations.values())
        if (pending.nodeId === nodeId)
          pending.finish(
            undefined,
            new Error('Database node disconnected; reconcile before retrying.'),
          )
      for (const stream of this.streams.values())
        if (stream.nodeId === nodeId)
          stream.destroy(new Error('Database node disconnected.'))
      return
    }
    if (!message.id) return
    const pending = this.operations.get(message.id)
    if (pending?.nodeId === nodeId && message.type === 'db.result') {
      const result = message.receipt,
        expected = pending.operation
      if (message.errorCode)
        pending.finish(
          undefined,
          new Error(
            `Database operation requires reconciliation (${message.errorCode}).`,
          ),
        )
      else if (
        result &&
        result.complete &&
        result.operationId === expected.id &&
        result.action === expected.action &&
        Object.entries(expected.identity).every(
          ([key, value]) =>
            result.identity[key as keyof DatabaseIdentity] === value,
        )
      )
        pending.finish(result)
      else
        pending.finish(
          undefined,
          new Error('Database operation receipt did not match the request.'),
        )
      return
    }
    const stream = this.streams.get(message.id)
    if (stream?.nodeId === nodeId) stream.receive(message)
  }
}

export class DatabaseStream extends Duplex {
  readonly nodeId: string
  private outgoing = 0
  private incoming = 0
  private awaitingRead: number[] = []
  private acknowledged = 0
  private released = 0
  private window = 1
  private opened = false
  private pendingWrite:
    | { data: Buffer; callback: (error?: Error | null) => void; offset: number }
    | undefined
  private timer: NodeJS.Timeout | undefined
  private abort = () =>
    this.destroy(new Error('Database session revoked or cancelled.'))
  constructor(
    readonly id: string,
    private options: SessionOptions,
    private signal: AbortSignal,
    private send: (body: unknown) => boolean,
    private remove: () => void,
  ) {
    super({
      readableHighWaterMark: 65536,
      writableHighWaterMark: 65536,
      allowHalfOpen: true,
    })
    this.nodeId = options.identity.nodeId
  }
  start(): void {
    this.signal.addEventListener('abort', this.abort, { once: true })
    this.timer = setTimeout(
      () => this.destroy(new Error('Database session expired.')),
      this.options.timeoutMs,
    )
    if (this.signal.aborted) {
      this.abort()
      return
    }
    if (
      !this.send({
        type: this.options.port ? 'db.tcp.open' : 'db.exec.open',
        version: 1,
        id: this.id,
        ...this.options,
        window: 16,
      })
    )
      this.destroy(new Error('Database node disconnected.'))
  }
  resize(columns: number, rows: number): void {
    if (
      !this.options.tty ||
      !Number.isInteger(columns) ||
      !Number.isInteger(rows) ||
      columns < 1 ||
      columns > 1000 ||
      rows < 1 ||
      rows > 1000
    )
      throw new Error('Invalid database terminal dimensions.')
    this.send({ type: 'db.resize', version: 1, id: this.id, columns, rows })
  }
  private grantCredit(seq: number): void {
    this.released = seq
    this.send({ type: 'db.ack', version: 1, id: this.id, seq })
  }
  override read(size?: number): Buffer | null {
    const data = super.read(size) as Buffer | null
    if (this.readableLength < 65536) this.releaseCredits()
    return data
  }
  override _read(): void {}
  private releaseCredits(): void {
    const drained = this.awaitingRead
    this.awaitingRead = []
    for (const seq of drained) this.grantCredit(seq)
  }
  override _write(
    data: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.pendingWrite = { data, callback, offset: 0 }
    this.writeFrame()
  }
  private writeFrame(): void {
    const pending = this.pendingWrite
    if (!pending || !this.opened) return
    while (
      pending.offset < pending.data.length &&
      this.outgoing - this.acknowledged < this.window
    ) {
      const data = pending.data.subarray(pending.offset, pending.offset + 32768)
      pending.offset += data.length
      this.outgoing++
      if (
        !this.send({
          type: 'db.data',
          version: 1,
          id: this.id,
          seq: this.outgoing,
          data: data.toString('base64'),
        })
      ) {
        this.destroy(new Error('Database stream disconnected.'))
        return
      }
    }
    if (
      pending.offset === pending.data.length &&
      this.acknowledged === this.outgoing
    ) {
      this.pendingWrite = undefined
      pending.callback()
    }
  }
  override _final(callback: (error?: Error | null) => void): void {
    this.send({ type: 'db.eof', version: 1, id: this.id })
    callback()
  }
  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    clearTimeout(this.timer)
    this.signal.removeEventListener('abort', this.abort)
    this.remove()
    this.send({ type: 'db.close', version: 1, id: this.id })
    const pending = this.pendingWrite
    this.pendingWrite = undefined
    pending?.callback(error ?? new Error('Database stream closed.'))
    callback(error)
  }
  receive(message: DatabaseEvent): void {
    if (this.destroyed) return
    switch (message.type) {
      case 'db.opened':
        if (this.opened) {
          this.destroy(new Error('Duplicate database stream open.'))
          return
        }
        this.opened = true
        this.window = message.window === 16 ? 16 : 1
        this.writeFrame()
        this.emit('ready')
        break
      case 'db.ack':
        if (
          !this.pendingWrite ||
          message.seq !== this.acknowledged + 1 ||
          message.seq > this.outgoing
        ) {
          this.destroy(new Error('Database stream acknowledgement mismatch.'))
          return
        }
        this.acknowledged = message.seq
        this.writeFrame()
        break
      case 'db.data': {
        if (
          message.seq !== this.incoming + 1 ||
          this.incoming - this.released >= this.window ||
          !message.data
        ) {
          this.destroy(new Error('Invalid database stream sequence.'))
          return
        }
        const data = Buffer.from(message.data, 'base64')
        if (
          !data.length ||
          data.length > 32768 ||
          data.toString('base64') !== message.data
        ) {
          this.destroy(new Error('Invalid database stream frame.'))
          return
        }
        this.incoming++
        if (message.channel === 'stderr') this.emit('stderr', data)
        if (
          (message.channel === 'stderr' || this.push(data)) &&
          this.readableLength < 65536 &&
          this.awaitingRead.length === 0
        )
          this.grantCredit(message.seq!)
        else this.awaitingRead.push(message.seq!)
        break
      }
      case 'db.closed':
        this.emit('exit', message.exitCode ?? -1)
        if (message.errorCode)
          this.destroy(new Error('Database session interrupted.'))
        else {
          this.push(null)
          this.end()
        }
        break
    }
  }
}
