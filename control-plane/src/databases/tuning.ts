import { z } from 'zod'
import { ApiError } from '../api/errors.js'

const allocation = z.object({
  memoryMb: z.number().int().min(128).max(1048576),
  diskMb: z.number().int().min(1024).max(2147483647),
  profile: z.enum(['dev', 'standard', 'performance']).default('standard'),
  storage: z.enum(['ssd', 'sd', 'unknown']).default('unknown'),
})
export type DatabaseAllocation = z.input<typeof allocation>
const overridesSchema = z
  .object({
    shared_buffers: z.number().int().min(16).optional(),
    work_mem: z.number().int().min(64).optional(),
    maintenance_work_mem: z.number().int().min(1).optional(),
    max_connections: z.number().int().min(10).optional(),
    random_page_cost: z.number().min(1).max(10).optional(),
    autovacuum_vacuum_scale_factor: z.number().min(0.01).max(0.2).optional(),
  })
  .strict()

function invalid(message: string): never {
  throw ApiError.unprocessable(
    'invalid_database_tuning',
    `${message} Use a larger allocation or remove the override, then retry.`,
  )
}

/** Units for overrides: shared/maintenance MB, work_mem KiB; no arbitrary server directives. */
export function tunePostgres(
  input: DatabaseAllocation,
  overrides: unknown = {},
) {
  const parsed = allocation.safeParse(input)
  const selected = overridesSchema.safeParse(overrides)
  if (!parsed.success || !selected.success)
    invalid(
      'Use a supported tuning profile, allocation and allowlisted numeric settings.',
    )
  const { memoryMb, diskMb, profile, storage } = parsed.data
  if (memoryMb < 256)
    invalid('Postgres needs at least 256 MiB including its connection pool.')
  const poolerMemoryMb = 64
  const serverMemoryMb = memoryMb - poolerMemoryMb
  const maximumConnections = Math.max(
    10,
    Math.min(100, Math.floor(serverMemoryMb / 16)),
  )
  const maxConnections =
    selected.data.max_connections ??
    Math.min(
      maximumConnections,
      profile === 'dev' ? 20 : profile === 'standard' ? 60 : 100,
    )
  if (maxConnections > maximumConnections)
    invalid('max_connections exceeds this allocation’s backend budget.')
  // max_db_connections covers both app roles; default_pool_size alone is per role/database.
  const poolConnections = maxConnections - 5
  const workMemKb =
    selected.data.work_mem ??
    Math.max(
      64,
      Math.min(
        4096,
        Math.floor((serverMemoryMb * 1024 * 0.1) / (poolConnections * 4)),
      ),
    )
  const sharedBuffersMb =
    selected.data.shared_buffers ?? Math.floor(serverMemoryMb * 0.25)
  const maintenanceMb =
    selected.data.maintenance_work_mem ??
    Math.max(
      1,
      Math.min(
        profile === 'performance' ? 128 : 64,
        Math.floor(serverMemoryMb * 0.05),
      ),
    )
  if (sharedBuffersMb > serverMemoryMb * 0.4)
    invalid('shared_buffers exceeds 40% of the Postgres allocation.')
  if (workMemKb * poolConnections * 4 > serverMemoryMb * 1024 * 0.1)
    invalid('work_mem exceeds the concurrent query budget.')
  if (maintenanceMb > serverMemoryMb * 0.1)
    invalid('maintenance_work_mem exceeds the maintenance budget.')
  const maxWalMb = Math.max(128, Math.min(4096, Math.floor(diskMb * 0.1)))
  const settings = {
    shared_buffers: `${sharedBuffersMb}MB`,
    effective_cache_size: `${Math.floor(serverMemoryMb * 0.7)}MB`,
    work_mem: `${workMemKb}kB`,
    maintenance_work_mem: `${maintenanceMb}MB`,
    max_connections: maxConnections,
    wal_buffers: `${Math.max(1, Math.min(16, Math.floor(sharedBuffersMb / 32)))}MB`,
    min_wal_size: `${Math.floor(maxWalMb / 2)}MB`,
    max_wal_size: `${maxWalMb}MB`,
    checkpoint_timeout: '5min',
    checkpoint_completion_target: 0.9,
    random_page_cost:
      selected.data.random_page_cost ?? (storage === 'ssd' ? 1.1 : 4),
    autovacuum_max_workers: Math.max(
      1,
      Math.min(3, Math.floor(serverMemoryMb / 512)),
    ),
    autovacuum_work_mem: `${Math.max(1, Math.min(32, Math.floor(serverMemoryMb * 0.02)))}MB`,
    autovacuum_vacuum_scale_factor:
      selected.data.autovacuum_vacuum_scale_factor ?? 0.1,
    autovacuum_analyze_scale_factor: 0.05,
    password_encryption: 'scram-sha-256',
    shared_preload_libraries: 'pg_stat_statements',
    log_statement: 'none',
    log_min_error_statement: 'panic',
    log_parameter_max_length: 0,
    log_parameter_max_length_on_error: 0,
  }
  const config =
    Object.entries(settings)
      .map(
        ([key, value]) =>
          `${key} = ${typeof value === 'number' ? value : `'${value}'`}`,
      )
      .join('\n') + '\n'
  return {
    settings,
    config,
    serverMemoryMb,
    poolerMemoryMb,
    pool: {
      pool_mode: 'transaction' as const,
      default_pool_size: Math.max(1, Math.floor(poolConnections / 2)),
      max_db_connections: poolConnections,
      reserve_pool_size: 0,
    },
    warnings:
      storage === 'sd'
        ? [
            'SD-card storage can stall checkpoints and wear out; keep verified off-node backups.',
          ]
        : [],
  }
}

export function tuneRedis(
  input: DatabaseAllocation,
  mode: 'cache' | 'durable',
) {
  const parsed = allocation.safeParse(input)
  if (!parsed.success || (mode !== 'cache' && mode !== 'durable'))
    invalid('Use a supported allocation and Redis cache or durable mode.')
  // AOF buffers, fork copy-on-write and allocator fragmentation sit outside maxmemory.
  const maxmemory = Math.floor(
    parsed.data.memoryMb * 1048576 * (mode === 'durable' ? 0.5 : 0.7),
  )
  const settings = {
    maxmemory,
    'maxmemory-policy': mode === 'cache' ? 'allkeys-lru' : 'noeviction',
    appendonly: mode === 'durable' ? 'yes' : 'no',
    appendfsync: 'everysec',
    save: mode === 'durable' ? '900 1' : '""',
    'stop-writes-on-bgsave-error': 'yes',
    'protected-mode': 'yes',
    aclfile: '/etc/fleet/users.acl',
  }
  return {
    settings,
    config:
      Object.entries(settings)
        .map(([key, value]) => `${key} ${value}`)
        .join('\n') + '\n',
    warnings:
      mode === 'durable'
        ? [
            'At the memory limit Redis rejects writes instead of evicting keys. AOF everysec can lose about one second on a crash; off-node backups are still required.',
          ]
        : [
            'Cache mode has no persistence and evicts keys under memory pressure.',
          ],
  }
}
