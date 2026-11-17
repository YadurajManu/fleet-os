import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { ApiError } from '../api/errors.js'
import { tunePostgres, tuneRedis, type DatabaseAllocation } from './tuning.js'

export type DatabaseRole = 'owner' | 'app' | 'readonly'
export type EngineCredentials = Record<
  DatabaseRole,
  { username: string; password: string }
>
export type EngineCommand = {
  command: string[]
  env: Record<string, string>
  stdin?: string
}
export type EngineFile = {
  path: string
  content: string
  secret: boolean
  mode: number
}
export type EngineContainer = {
  role: 'database' | 'pooler'
  image: string
  command: string[]
  env: Record<string, string>
  files: EngineFile[]
  aliases: string[]
  memoryMb: number
  port: number
}
export type EngineOptions = {
  id: string
  fleetId: string
  project: string
  name: string
  version: string
  mode: 'standard' | 'cache' | 'durable'
  allocation: DatabaseAllocation
  credentials: EngineCredentials
  images: { primary: string; pooler?: string }
  backupTarget?: {
    endpoint: string
    bucket: string
    prefix: string
    region: string
    credentials: {
      accessKeyId: string
      secretAccessKey: string
      sessionToken?: string
    }
    encryptionKey: string
  }
  overrides?: unknown
}
export type EnginePlan = {
  network: string
  dataPath: string
  database: string
  containers: EngineContainer[]
  bootstrap: EngineCommand | null
  readiness: EngineCommand
  warnings: string[]
}
export type BackupPlan =
  | { type: 'wal-g'; command: EngineCommand }
  | { type: 'redis-rdb'; snapshot: EngineCommand; path: string }
export type RestoreTarget = {
  backup: string
  to?: { type: 'time' | 'name'; value: string }
}
export type RestorePlan =
  | { type: 'wal-g'; command: EngineCommand; recovery: Record<string, string> }
  | { type: 'redis-rdb'; path: string }
export type ImportPlan =
  | { type: 'pg-restore'; command: EngineCommand }
  | { type: 'redis-rdb'; path: string }

export interface DatabaseEnginePlugin {
  engine: 'postgres' | 'redis'
  versions: readonly string[]
  defaultVersion: string
  platforms: readonly string[]
  extensions: readonly string[]
  credentials(): EngineCredentials
  plan(options: EngineOptions): EnginePlan
  connection(
    options: EngineOptions,
    role: DatabaseRole,
    direct?: boolean,
  ): string
  backup(options: EngineOptions): BackupPlan
  restore(options: EngineOptions, target: RestoreTarget): RestorePlan
  export(options: EngineOptions): EngineCommand
  import(options: EngineOptions): ImportPlan
  extension(
    options: EngineOptions,
    name: string,
    enabled: boolean,
  ): EngineCommand
  metrics(options: EngineOptions): EngineCommand
  parseMetrics(output: string): Record<string, unknown>
}

const name = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/)
const image = z
  .string()
  .regex(/^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64})$/)
const metricNumber = z.number().nonnegative()
const postgresMetrics = z.object({
  connections: z
    .object({ active: metricNumber, idle: metricNumber, max: metricNumber })
    .optional(),
  transactions: metricNumber.optional(),
  cache_hits: metricNumber.optional(),
  disk_reads: metricNumber.optional(),
  size_bytes: metricNumber.optional(),
  tables: z
    .array(
      z.object({
        schemaname: z.string().max(128),
        relname: z.string().max(128),
        size_bytes: metricNumber,
      }),
    )
    .max(20)
    .optional(),
  slow: z
    .array(
      z.object({
        queryid: z.string().regex(/^-?[0-9]+$/),
        calls: metricNumber,
        total_exec_time: metricNumber,
        mean_exec_time: metricNumber,
        rows: metricNumber,
      }),
    )
    .max(20)
    .optional(),
  blocked: metricNumber.optional(),
  archiver: z
    .object({
      archived_count: metricNumber,
      last_archived_wal: z.string().max(128).nullable(),
      last_archived_time: z.string().max(64).nullable(),
      failed_count: metricNumber,
      last_failed_wal: z.string().max(128).nullable(),
      last_failed_time: z.string().max(64).nullable(),
      stats_reset: z.string().max(64),
    })
    .optional(),
})
const credential = z.object({
  username: z.string().regex(/^fleet_(owner|app|readonly)$/),
  password: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
})
const optionsSchema = z.object({
  id: z.string().uuid(),
  fleetId: z.string().uuid(),
  project: z.string().min(1).max(128),
  name,
  version: z.string(),
  mode: z.enum(['standard', 'cache', 'durable']),
  credentials: z.object({
    owner: credential,
    app: credential,
    readonly: credential,
  }),
  images: z.object({ primary: image, pooler: image.optional() }),
})

function fail(message: string): never {
  throw ApiError.unprocessable(
    'invalid_database_engine',
    `${message} Correct the database settings or image catalog and retry.`,
  )
}
function validate(options: EngineOptions, engine: DatabaseEnginePlugin) {
  if (
    !optionsSchema.safeParse(options).success ||
    !engine.versions.includes(options.version)
  )
    fail('Unsupported engine version, identity, credentials or unpinned image.')
  for (const role of ['owner', 'app', 'readonly'] as const)
    if (options.credentials[role].username !== `fleet_${role}`)
      fail('Role credentials do not match the selected role.')
  if (
    engine.engine === 'postgres'
      ? options.mode !== 'standard'
      : options.mode === 'standard'
  )
    fail('The selected persistence mode does not match the engine.')
}
export function projectDatabaseNetwork(
  fleetId: string,
  project: string,
): string {
  return `fleet-db-${createHash('sha256').update(`${fleetId}\0${project}`).digest('hex').slice(0, 24)}`
}
const databaseName = (options: EngineOptions) =>
  options.name.replaceAll('-', '_')
const directHost = (options: EngineOptions) => `${options.name}.fleet.internal`
const poolHost = (options: EngineOptions) =>
  `${options.name}-pool.fleet.internal`
const credentials = (): EngineCredentials =>
  Object.fromEntries(
    (['owner', 'app', 'readonly'] as const).map((role) => [
      role,
      {
        username: `fleet_${role}`,
        password: randomBytes(32).toString('base64url'),
      },
    ]),
  ) as EngineCredentials
const file = (path: string, content: string, secret = false): EngineFile => ({
  path,
  content,
  secret,
  mode: secret ? 0o600 : 0o644,
})
const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`
const sqlIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`
const pgCommand = (
  options: EngineOptions,
  command: string[],
  stdin?: string,
): EngineCommand => ({
  command,
  env: {
    PGHOST: '/var/run/postgresql',
    PGUSER: options.credentials.owner.username,
    PGPASSWORD: options.credentials.owner.password,
    PGDATABASE: databaseName(options),
    PGCONNECT_TIMEOUT: '5',
  },
  ...(stdin === undefined ? {} : { stdin }),
})
const redisCommand = (
  options: EngineOptions,
  ...args: string[]
): EngineCommand => ({
  command: [
    'redis-cli',
    '--user',
    options.credentials.owner.username,
    '--raw',
    ...args,
  ],
  env: { REDISCLI_AUTH: options.credentials.owner.password },
})

export const postgresEngine: DatabaseEnginePlugin = {
  engine: 'postgres',
  versions: ['16', '17'],
  defaultVersion: '17',
  platforms: ['linux/arm64', 'linux/amd64'],
  extensions: [
    'vector',
    'pg_stat_statements',
    'pgcrypto',
    'uuid-ossp',
    'pg_trgm',
  ],
  credentials,
  plan(options): EnginePlan {
    validate(options, this)
    if (!options.images.pooler)
      fail('Postgres requires a pinned PgBouncer image.')
    const tuned = tunePostgres(options.allocation, options.overrides)
    const database = databaseName(options)
    const owner = options.credentials.owner
    const roles = (['app', 'readonly'] as const)
      .map((role) => {
        const cred = options.credentials[role]
        return `DO $fleet$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${sqlLiteral(cred.username)}) THEN CREATE ROLE ${sqlIdentifier(cred.username)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${sqlLiteral(cred.password)}; END IF; END $fleet$;`
      })
      .join('\n')
    const app = sqlIdentifier(options.credentials.app.username),
      readonly = sqlIdentifier(options.credentials.readonly.username)
    const bootstrap = `SET log_statement = 'none'; SET log_min_error_statement = 'panic'; SET pg_stat_statements.track_utility = off;\n${roles}\nREVOKE CONNECT ON DATABASE ${sqlIdentifier(database)} FROM PUBLIC;\nGRANT CONNECT ON DATABASE ${sqlIdentifier(database)} TO ${app}, ${readonly};\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\nGRANT USAGE ON SCHEMA public TO ${app}, ${readonly};\nGRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app};\nGRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app};\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO ${readonly};\nALTER DEFAULT PRIVILEGES FOR ROLE ${sqlIdentifier(owner.username)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app};\nALTER DEFAULT PRIVILEGES FOR ROLE ${sqlIdentifier(owner.username)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${app};\nALTER DEFAULT PRIVILEGES FOR ROLE ${sqlIdentifier(owner.username)} IN SCHEMA public GRANT SELECT ON TABLES TO ${readonly};\nCREATE EXTENSION IF NOT EXISTS pg_stat_statements;\n`
    const poolConfig = `[databases]\n${database} = host=${directHost(options)} port=5432 dbname=${database}\n[pgbouncer]\nlisten_addr = 0.0.0.0\nlisten_port = 6432\nunix_socket_dir = /tmp\npidfile = /tmp/pgbouncer.pid\nauth_type = scram-sha-256\nauth_file = /etc/fleet/users.txt\npool_mode = transaction\ndefault_pool_size = ${tuned.pool.default_pool_size}\nmax_db_connections = ${tuned.pool.max_db_connections}\nreserve_pool_size = 0\nmax_client_conn = 200\nignore_startup_parameters = extra_float_digits\nlog_connections = 0\nlog_disconnections = 0\nlog_pooler_errors = 0\n`
    const backup = options.backupTarget
    const backupConfig = backup
      ? `\narchive_mode = on\narchive_timeout = '60s'\narchive_command = 'wal-g wal-push %p'\nrestore_command = 'wal-g wal-fetch %f %p'\n`
      : ''
    const walGEnv: Record<string, string> = backup
      ? {
          WALG_S3_PREFIX: `s3://${backup.bucket}/${backup.prefix}`.replace(
            /\/$/,
            '',
          ),
          WALG_LIBSODIUM_KEY_PATH: '/etc/fleet/walg-key',
          AWS_SHARED_CREDENTIALS_FILE: '/etc/fleet/aws-credentials',
          AWS_REGION: backup.region,
          AWS_ENDPOINT: backup.endpoint,
          AWS_S3_FORCE_PATH_STYLE: 'true',
        }
      : {}
    const walGFiles = backup
      ? [
          file(
            '/etc/fleet/aws-credentials',
            `[default]\naws_access_key_id=${backup.credentials.accessKeyId}\naws_secret_access_key=${backup.credentials.secretAccessKey}\n${backup.credentials.sessionToken ? `aws_session_token=${backup.credentials.sessionToken}\n` : ''}`,
            true,
          ),
          file('/etc/fleet/walg-key', backup.encryptionKey, true),
        ]
      : []
    return {
      network: projectDatabaseNetwork(options.fleetId, options.project),
      dataPath: '/var/lib/postgresql/data',
      database,
      warnings: [
        ...tuned.warnings,
        'No off-node backups are configured; losing this node can lose all database data.',
      ],
      bootstrap: pgCommand(
        options,
        ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-q'],
        bootstrap,
      ),
      readiness: pgCommand(options, [
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-Atc',
        'SELECT 1',
      ]),
      containers: [
        {
          role: 'database',
          image: options.images.primary,
          command: ['postgres', '-c', 'config_file=/etc/fleet/postgresql.conf'],
          env: {
            POSTGRES_USER: owner.username,
            POSTGRES_DB: database,
            POSTGRES_PASSWORD_FILE: '/etc/fleet/owner-password',
            POSTGRES_INITDB_ARGS:
              '--auth-host=scram-sha-256 --auth-local=scram-sha-256',
            PGDATA: '/var/lib/postgresql/data/pgdata',
            ...walGEnv,
          },
          files: [
            file(
              '/etc/fleet/postgresql.conf',
              `listen_addresses = '*'\n${backupConfig}${tuned.config}`,
            ),
            file('/etc/fleet/owner-password', owner.password, true),
            ...walGFiles,
          ],
          aliases: [directHost(options)],
          memoryMb: tuned.serverMemoryMb,
          port: 5432,
        },
        {
          role: 'pooler',
          image: options.images.pooler,
          command: ['/etc/fleet/pgbouncer.ini'],
          env: {},
          files: [
            file('/etc/fleet/pgbouncer.ini', poolConfig),
            file(
              '/etc/fleet/users.txt',
              (['app', 'readonly'] as const)
                .map(
                  (role) =>
                    `"${options.credentials[role].username}" "${options.credentials[role].password}"`,
                )
                .join('\n') + '\n',
              true,
            ),
          ],
          aliases: [poolHost(options)],
          memoryMb: tuned.poolerMemoryMb,
          port: 6432,
        },
      ],
    }
  },
  connection(options, role, direct = false) {
    validate(options, this)
    if (role !== 'owner' && role !== 'app' && role !== 'readonly')
      fail('Unknown database role.')
    if (role === 'owner' && !direct)
      fail(
        'Owner credentials must use the direct endpoint for migrations and administration.',
      )
    const cred = options.credentials[role]
    const url = new URL(
      `postgresql://${direct ? directHost(options) : poolHost(options)}:${direct ? 5432 : 6432}/${databaseName(options)}`,
    )
    url.username = cred.username
    url.password = cred.password
    if (!direct) url.searchParams.set('pgbouncer', 'true')
    return url.toString()
  },
  backup(options) {
    validate(options, this)
    return {
      type: 'wal-g',
      command: pgCommand(options, [
        'wal-g',
        'backup-push',
        '/var/lib/postgresql/data/pgdata',
      ]),
    }
  },
  restore(options, target) {
    validate(options, this)
    if (!/^(LATEST|base_[A-Za-z0-9_-]{1,180})$/.test(target.backup))
      fail('Choose LATEST or a valid WAL-G base backup identifier.')
    const recovery: Record<string, string> = {
      restore_command: 'wal-g wal-fetch %f %p',
      recovery_target_action: 'promote',
    }
    if (target.to?.type === 'time') {
      if (!z.iso.datetime({ offset: true }).safeParse(target.to.value).success)
        fail('Use an ISO timestamp within the backup recovery window.')
      recovery.recovery_target_time = target.to.value
    } else if (target.to?.type === 'name') {
      if (!/^[A-Za-z0-9_-]{1,63}$/.test(target.to.value))
        fail('Use a valid named restore point.')
      recovery.recovery_target_name = target.to.value
    } else if (target.to) {
      fail('Choose a timestamp or named restore point.')
    }
    return {
      type: 'wal-g',
      command: pgCommand(options, [
        'wal-g',
        'backup-fetch',
        '/var/lib/postgresql/data/pgdata',
        target.backup,
      ]),
      recovery,
    }
  },
  export(options) {
    validate(options, this)
    return pgCommand(options, [
      'pg_dump',
      '--format=custom',
      '--no-owner',
      '--no-acl',
    ])
  },
  import(options) {
    validate(options, this)
    return {
      type: 'pg-restore',
      command: pgCommand(options, [
        'pg_restore',
        '--dbname',
        databaseName(options),
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        '--single-transaction',
      ]),
    }
  },
  extension(options, name, enabled) {
    validate(options, this)
    if (!this.extensions.includes(name))
      fail('Choose an extension from the maintained image catalog.')
    return pgCommand(
      options,
      ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-q'],
      enabled
        ? `CREATE EXTENSION IF NOT EXISTS ${sqlIdentifier(name)};`
        : `DROP EXTENSION IF EXISTS ${sqlIdentifier(name)} RESTRICT;`,
    )
  },
  metrics(options) {
    validate(options, this)
    const query = `SELECT json_build_object('connections', (SELECT json_build_object('active', count(*) FILTER (WHERE state = 'active'), 'idle', count(*) FILTER (WHERE state = 'idle'), 'max', current_setting('max_connections')::int) FROM pg_stat_activity WHERE datname = current_database()), 'transactions', xact_commit + xact_rollback, 'cache_hits', blks_hit, 'disk_reads', blks_read, 'size_bytes', pg_database_size(current_database()), 'tables', (SELECT coalesce(json_agg(t), '[]') FROM (SELECT schemaname, relname, pg_total_relation_size(relid) AS size_bytes FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 20) t), 'slow', (SELECT coalesce(json_agg(q), '[]') FROM (SELECT queryid::text, calls, total_exec_time, mean_exec_time, rows FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY total_exec_time DESC LIMIT 20) q), 'blocked', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0), 'archiver', (SELECT row_to_json(a) FROM pg_stat_archiver a)) FROM pg_stat_database WHERE datname = current_database()`
    return pgCommand(options, [
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atc',
      query,
    ])
  },
  parseMetrics(output) {
    if (Buffer.byteLength(output) > 262144)
      fail('Engine metric response exceeded its limit.')
    try {
      const result = postgresMetrics.safeParse(JSON.parse(output))
      if (!result.success || !Object.keys(result.data).length)
        fail('Engine returned no supported Postgres metrics.')
      return result.data
    } catch {
      fail('Engine returned invalid metrics.')
    }
  },
}

export const redisEngine: DatabaseEnginePlugin = {
  engine: 'redis',
  versions: ['7'],
  defaultVersion: '7',
  platforms: ['linux/arm64', 'linux/amd64'],
  extensions: [],
  credentials,
  plan(options) {
    validate(options, this)
    const tuned = tuneRedis(
      options.allocation,
      options.mode as 'cache' | 'durable',
    )
    const rules = {
      owner: '+@all',
      app: '+@read +@write +@connection +@pubsub +@scripting -@dangerous',
      readonly: '+@read +@connection -@dangerous',
    }
    const acl =
      'user default off\n' +
      (['owner', 'app', 'readonly'] as const)
        .map((role) => {
          const cred = options.credentials[role]
          return `user ${cred.username} on #${createHash('sha256').update(cred.password).digest('hex')} ~* &* ${rules[role]}`
        })
        .join('\n') +
      '\n'
    return {
      network: projectDatabaseNetwork(options.fleetId, options.project),
      dataPath: '/data',
      database: '0',
      containers: [
        {
          role: 'database',
          image: options.images.primary,
          command: ['redis-server', '/etc/fleet/redis.conf'],
          env: {},
          files: [
            file(
              '/etc/fleet/redis.conf',
              `${tuned.config}dir /data\nrequirepass ${options.credentials.owner.password}\n`,
              true,
            ),
            file('/etc/fleet/users.acl', acl, true),
          ],
          aliases: [directHost(options)],
          memoryMb: options.allocation.memoryMb,
          port: 6379,
        },
      ],
      bootstrap: null,
      readiness: redisCommand(options, 'PING'),
      warnings: [
        ...tuned.warnings,
        ...(options.mode === 'durable'
          ? [
              'No off-node backups are configured; AOF on this node is not an off-node backup.',
            ]
          : []),
      ],
    }
  },
  connection(options, role) {
    validate(options, this)
    if (role !== 'owner' && role !== 'app' && role !== 'readonly')
      fail('Unknown database role.')
    const cred = options.credentials[role]
    const url = new URL(`redis://${directHost(options)}:6379/0`)
    url.username = cred.username
    url.password = cred.password
    return url.toString()
  },
  backup(options) {
    validate(options, this)
    if (options.mode !== 'durable')
      fail(
        'Cache mode has no persistent backup; use durable mode for recoverable data.',
      )
    return {
      type: 'redis-rdb',
      snapshot: redisCommand(options, 'BGSAVE'),
      path: '/data/dump.rdb',
    }
  },
  restore(options, target) {
    validate(options, this)
    if (target.to)
      fail(
        'Redis snapshots do not support point-in-time recovery. Choose a specific RDB backup.',
      )
    return { type: 'redis-rdb', path: '/data/dump.rdb' }
  },
  export(options) {
    validate(options, this)
    return redisCommand(options, '--rdb', '-')
  },
  import(options) {
    validate(options, this)
    return { type: 'redis-rdb', path: '/data/dump.rdb' }
  },
  extension() {
    fail(
      'Redis does not provide SQL extensions. Use the Postgres extension commands for a Postgres database.',
    )
  },
  metrics(options) {
    validate(options, this)
    return redisCommand(options, 'INFO', 'ALL')
  },
  parseMetrics(output) {
    if (Buffer.byteLength(output) > 262144)
      fail('Engine metric response exceeded its limit.')
    const values: Record<string, unknown> = {}
    const allowed = new Set([
      'used_memory',
      'maxmemory',
      'keyspace_hits',
      'keyspace_misses',
      'instantaneous_ops_per_sec',
      'evicted_keys',
      'connected_clients',
      'aof_enabled',
      'aof_last_write_status',
      'aof_last_bgrewrite_status',
      'rdb_last_bgsave_status',
      'rdb_last_save_time',
      'total_commands_processed',
    ])
    for (const line of output.split(/\r?\n/)) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const key = line.slice(0, colon),
        value = line.slice(colon + 1)
      if (allowed.has(key)) {
        if (key.endsWith('_status')) {
          if (value !== 'ok' && value !== 'err')
            fail('Engine returned an invalid Redis persistence status.')
          values[key] = value
        } else {
          if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
            fail('Engine returned an invalid numeric Redis metric.')
          values[key] = Number(value)
        }
      }
    }
    if (!Object.keys(values).length)
      fail('Engine returned no supported Redis metrics.')
    return values
  },
}

export const DATABASE_ENGINES: Readonly<
  Record<'postgres' | 'redis', DatabaseEnginePlugin>
> = { postgres: postgresEngine, redis: redisEngine }
export function databaseEnginePlugin(engine: string): DatabaseEnginePlugin {
  if (engine !== 'postgres' && engine !== 'redis')
    fail('Supported tenant database engines are postgres and redis.')
  return DATABASE_ENGINES[engine]
}
