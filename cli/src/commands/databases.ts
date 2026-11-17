import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { CliError, EXIT, request, requireFleet } from '../api.js'
import { loadProfile } from '../config.js'
import { c, table, statusBadge } from '../render.js'
import { askSecret, canPrompt, confirm } from '../prompt.js'
import type { Flags } from '../args.js'

type Database = {
  id: string
  project: string
  name: string
  nodeId: string | null
  engine: string
  version: string
  status: string
  nodeName: string | null
  backupConfigured: boolean
}
type Operation = {
  id: string
  kind: string
  state: string
  progress: number
  errorCode: string | null
}
type DatabaseLink = { serviceId: string; serviceName: string }
type BackupTarget = {
  id: string
  name: string
  endpoint: string
  bucket: string
  prefix: string
  region: string
  isDefault: boolean
  lastTestedAt: string | null
}
type DatabaseBackup = {
  id: string
  kind: string
  state: string
  sizeBytes: number | null
  errorCode: string | null
  createdAt: string
  verifiedAt: string | null
}
const base = (fleet: string, project: string) =>
  `/fleets/${encodeURIComponent(fleet)}/projects/${encodeURIComponent(project)}/databases`

async function waitForOperation(
  fleet: string,
  project: string,
  database: Database,
  operationId: string,
  flags: Flags,
) {
  if (flags['no-wait'] || flags.json) {
    console.log(`Operation ${operationId} queued for ${database.name}.`)
    return
  }
  let progress = -1
  while (true) {
    const { body } = await request<{
      database: Database
      operations: Operation[]
    }>('GET', `${base(fleet, project)}/${database.id}`)
    const operation = body.operations.find((item) => item.id === operationId)
    if (!operation)
      throw new CliError('The database operation disappeared from history.')
    if (operation.progress !== progress) {
      progress = operation.progress
      process.stdout.write(`\r${operation.kind}: ${progress}%`)
    }
    if (['succeeded', 'failed', 'cancelled'].includes(operation.state)) {
      console.log()
      if (operation.state !== 'succeeded')
        throw new CliError(
          `Database ${operation.kind} ${operation.state}${operation.errorCode ? ` (${operation.errorCode})` : ''}. Inspect the database operation history.`,
        )
      console.log(
        `${c.green('ready')}  ${database.name} on ${body.database.nodeName ?? 'its assigned node'}`,
      )
      return
    }
    await delay(1000)
  }
}

export const databasesCommand = {
  async run(args: string[], flags: Flags) {
    const [action, project, nameOrId] = args
    const fleet = await requireFleet(
      typeof flags.fleet === 'string' ? flags.fleet : undefined,
    )
    if (action === 'list') {
      const query = new URLSearchParams({ limit: '100' })
      if (typeof flags.project === 'string') query.set('project', flags.project)
      const { body } = await request<{ databases: Database[] }>(
        'GET',
        `/fleets/${fleet}/databases?${query}`,
      )
      if (flags.json) return console.log(JSON.stringify(body, null, 2))
      console.log(
        table(
          ['project', 'name', 'engine', 'status', 'node', 'backup'],
          body.databases.map((database) => [
            database.project,
            database.name,
            `${database.engine} ${database.version}`,
            statusBadge(database.status),
            database.nodeName ?? 'unassigned',
            database.backupConfigured ? 'configured' : c.yellow('none'),
          ]),
        ),
      )
      return
    }
    if (action === 'targets') {
      if (!project)
        throw new CliError('usage: fleet db targets <project>', EXIT.usage)
      const { body } = await request<{ targets: BackupTarget[] }>(
        'GET',
        targetPath(fleet, project),
      )
      if (flags.json) return console.log(JSON.stringify(body.targets, null, 2))
      if (!body.targets.length) {
        console.log(`No backup targets in ${project}.`)
        console.log(
          c.dim(`  add one with \`fleet db target add ${project} NAME\``),
        )
        return
      }
      console.log(
        table(
          ['name', 'bucket', 'endpoint', 'default', 'last tested', 'id'],
          body.targets.map((target) => [
            target.name,
            target.bucket,
            target.endpoint,
            target.isDefault ? 'yes' : 'no',
            target.lastTestedAt ?? 'never',
            c.dim(target.id.slice(0, 8)),
          ]),
        ),
      )
      return
    }
    if (action === 'target') {
      const [operation, targetProject, targetName, assignedTargetName] =
        args.slice(1)
      if (!targetProject || !operation)
        throw new CliError(
          'usage: fleet db target add|assign|test|remove <project> ...',
          EXIT.usage,
        )
      const path = targetPath(fleet, targetProject)
      if (operation === 'assign') {
        if (!targetName || !assignedTargetName)
          throw new CliError(
            'usage: fleet db target assign <project> <database> <target|none>',
            EXIT.usage,
          )
        const database = await findDatabase(fleet, targetName, {
          ...flags,
          project: targetProject,
        })
        const selected =
          assignedTargetName === 'none'
            ? null
            : selectBackupTarget(
                (await request<{ targets: BackupTarget[] }>('GET', path)).body
                  .targets,
                assignedTargetName,
              )
        const { body } = await request<{ backupTargetId: string | null }>(
          'PUT',
          `${base(fleet, database.project)}/${database.id}/backup-target`,
          { body: { targetId: selected?.id ?? null } },
        )
        if (flags.json) return console.log(JSON.stringify(body, null, 2))
        console.log(
          selected
            ? `${c.green('assigned')} ${selected.name} to ${database.name}`
            : `${c.green('removed')} backup target from ${database.name}`,
        )
        return
      }
      if (operation === 'add') {
        if (
          !targetName ||
          typeof flags.endpoint !== 'string' ||
          typeof flags.bucket !== 'string' ||
          typeof flags.region !== 'string'
        )
          throw new CliError(
            'usage: fleet db target add <project> <name> --endpoint URL --bucket NAME --region REGION [--prefix PATH] [--default]',
            EXIT.usage,
          )
        const accessKeyId =
          process.env.FLEET_S3_ACCESS_KEY_ID ||
          (canPrompt() ? await askSecret('S3 access key') : '')
        const secretAccessKey =
          process.env.FLEET_S3_SECRET_ACCESS_KEY ||
          (canPrompt() ? await askSecret('S3 secret key') : '')
        if (!accessKeyId || !secretAccessKey)
          throw new CliError(
            'Set FLEET_S3_ACCESS_KEY_ID and FLEET_S3_SECRET_ACCESS_KEY, or run interactively to enter them securely.',
            EXIT.usage,
          )
        const { body } = await request<BackupTarget>('POST', path, {
          body: {
            name: targetName,
            endpoint: flags.endpoint,
            bucket: flags.bucket,
            region: flags.region,
            ...(typeof flags.prefix === 'string'
              ? { prefix: flags.prefix }
              : {}),
            credentials: { accessKeyId, secretAccessKey },
            ...(flags.default ? { isDefault: true } : {}),
          },
        })
        if (flags.json) return console.log(JSON.stringify(body, null, 2))
        console.log(
          `${c.green('added')} backup target ${c.bold(body.name)} (${body.id.slice(0, 8)})`,
        )
        return
      }
      if (operation === 'test' || operation === 'remove') {
        if (!targetName)
          throw new CliError(
            `usage: fleet db target ${operation} <project> <target>`,
            EXIT.usage,
          )
        const { body: listed } = await request<{ targets: BackupTarget[] }>(
          'GET',
          path,
        )
        const target = selectBackupTarget(listed.targets, targetName)
        if (
          operation === 'remove' &&
          !flags.yes &&
          !(await confirm(`Remove backup target ${target.name}?`))
        )
          return
        const result = await request(
          operation === 'test' ? 'POST' : 'DELETE',
          `${path}/${target.id}${operation === 'test' ? '/test' : ''}`,
        )
        if (flags.json) return console.log(JSON.stringify(result.body, null, 2))
        console.log(
          operation === 'test'
            ? `${c.green('verified')} ${target.name}`
            : `${c.green('removed')} ${target.name}`,
        )
        return
      }
      throw new CliError(
        'usage: fleet db target add|assign|test|remove <project> ...',
        EXIT.usage,
      )
    }
    if (action === 'backup' || action === 'backups') {
      if (!project)
        throw new CliError(
          `usage: fleet db ${action} <database> [--project PROJECT]`,
          EXIT.usage,
        )
      const database = await findDatabase(fleet, project, flags)
      const path = `${base(fleet, database.project)}/${database.id}/backups`
      if (action === 'backup') {
        const { body } = await request<{
          backupId: string
          operationId: string
        }>('POST', path, { idempotencyKey: randomUUID() })
        if (flags.json) return console.log(JSON.stringify(body, null, 2))
        await waitForOperation(
          fleet,
          database.project,
          database,
          body.operationId,
          flags,
        )
      }
      const { body } = await request<{ backups: DatabaseBackup[] }>('GET', path)
      if (flags.json) return console.log(JSON.stringify(body.backups, null, 2))
      if (!body.backups.length) {
        console.log(`No backups recorded for ${database.name}.`)
        return
      }
      console.log(
        table(
          ['id', 'kind', 'state', 'size', 'created', 'verified'],
          body.backups.map((backup) => [
            c.dim(backup.id.slice(0, 8)),
            backup.kind,
            statusBadge(backup.verifiedAt ? 'verified' : backup.state),
            backup.sizeBytes === null
              ? 'pending'
              : `${(backup.sizeBytes / 1024 / 1024).toFixed(1)} MiB`,
            backup.createdAt,
            backup.verifiedAt ?? 'no',
          ]),
        ),
      )
      return
    }
    if (action === 'create') {
      if (!project || !nameOrId)
        throw new CliError(
          'usage: fleet databases create <project> <name> [--engine postgres|redis]',
          EXIT.usage,
        )
      const engine =
        typeof flags.engine === 'string' ? flags.engine : 'postgres'
      if (engine !== 'postgres' && engine !== 'redis')
        throw new CliError('--engine must be postgres or redis.', EXIT.usage)
      const body = {
        name: nameOrId,
        engine,
        ...(typeof flags.version === 'string'
          ? { version: flags.version }
          : {}),
        ...(typeof flags.mode === 'string' ? { mode: flags.mode } : {}),
      }
      const { body: result } = await request<{
        database: Database
        operation: Operation
      }>('POST', base(fleet, project), {
        body,
        idempotencyKey: randomUUID(),
      })
      if (flags.json) return console.log(JSON.stringify(result, null, 2))
      await waitForOperation(
        fleet,
        project,
        result.database,
        result.operation.id,
        flags,
      )
      return
    }
    if (action === 'link') {
      if (!project || !nameOrId)
        throw new CliError(
          'usage: fleet db link <database> <service> [--project PROJECT] [--role app|readonly] [--as PREFIX]',
          EXIT.usage,
        )
      const database = await findDatabase(fleet, nameOrId, flags)
      const { body: linkInfo } = await request<{
        services: { id: string; name: string }[]
      }>('GET', `${base(fleet, database.project)}/${database.id}/links`)
      const service = linkInfo.services.find(
        (item) => item.id === project || item.name === project,
      )
      if (!service)
        throw new CliError(
          `Service "${project}" was not found in project ${database.project}.`,
        )
      const role = typeof flags.role === 'string' ? flags.role : 'app'
      if (role !== 'app' && role !== 'readonly')
        throw new CliError('--role must be app or readonly.', EXIT.usage)
      const { body } = await request<{
        link: {
          serviceName: string
          role: string
          envKeys: Record<string, string>
          restartRequired: boolean
        }
      }>('POST', `${base(fleet, database.project)}/${database.id}/links`, {
        body: {
          serviceId: service.id,
          role,
          ...(typeof flags.as === 'string' ? { as: flags.as } : {}),
        },
      })
      if (flags.json) return console.log(JSON.stringify(body, null, 2))
      console.log(
        `${body.link.serviceName} linked as ${body.link.role}: ${Object.keys(body.link.envKeys).join(', ')}`,
      )
      if (body.link.restartRequired)
        console.log('Redeploy the service to apply the database connection.')
      return
    }
    if (action === 'unlink') {
      if (!project || !nameOrId)
        throw new CliError(
          'usage: fleet db unlink <database> <service> [--project PROJECT]',
          EXIT.usage,
        )
      const database = await findDatabase(fleet, nameOrId, flags)
      const { body: linkInfo } = await request<{ links: DatabaseLink[] }>(
        'GET',
        `${base(fleet, database.project)}/${database.id}/links`,
      )
      const link = linkInfo.links.find(
        (item) => item.serviceId === project || item.serviceName === project,
      )
      if (!link)
        throw new CliError(
          `Service "${project}" is not linked to ${database.name}.`,
        )
      const { body } = await request<{
        serviceId: string
        restartRequired: boolean
      }>(
        'DELETE',
        `${base(fleet, database.project)}/${database.id}/links/${link.serviceId}`,
      )
      if (flags.json) return console.log(JSON.stringify(body, null, 2))
      console.log(`Service ${link.serviceName} unlinked.`)
      if (body.restartRequired)
        console.log('Redeploy the service to remove the database connection.')
      return
    }
    if (action === 'connect') {
      if (!project)
        throw new CliError(
          'usage: fleet db connect <database> [--project PROJECT] [--port LOCAL_PORT]',
          EXIT.usage,
        )
      const database = await findDatabase(fleet, project, flags)
      if (database.status !== 'running' || !database.nodeId)
        throw new CliError(
          `Database ${database.name} must be running before connecting.`,
        )
      const portValue =
        typeof flags.port === 'string' ? Number(flags.port) : 15432
      if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535)
        throw new CliError('--port must be a valid TCP port.', EXIT.usage)
      await connectDatabase(fleet, database, portValue)
      return
    }
    if (action === 'exec') {
      if (!project)
        throw new CliError(
          'usage: fleet db exec <database> -c SQL | -f FILE | -- REDIS-COMMAND [ARGS…]',
          EXIT.usage,
        )
      const database = await findDatabase(fleet, project, flags)
      if (database.status !== 'running' || !database.nodeId)
        throw new CliError(
          `Database ${database.name} must be running before executing a command.`,
        )
      await execDatabase(fleet, database, args.slice(2), flags)
      return
    }
    if (['start', 'stop', 'restart'].includes(action ?? '')) {
      if (!project || !nameOrId)
        throw new CliError(
          `usage: fleet databases ${action} <project> <database-id>`,
          EXIT.usage,
        )
      const { body: result } = await request<{
        database: Database
        operation: Operation
      }>('POST', `${base(fleet, project)}/${nameOrId}/actions`, {
        body: { action },
        idempotencyKey: randomUUID(),
      })
      if (flags.json) return console.log(JSON.stringify(result, null, 2))
      await waitForOperation(
        fleet,
        project,
        result.database,
        result.operation.id,
        flags,
      )
      return
    }
    throw new CliError(
      'usage: fleet db list|create|start|stop|restart|link|unlink|connect|exec|targets|target …',
      EXIT.usage,
    )
  },
}

const targetPath = (fleet: string, project: string) =>
  `/fleets/${encodeURIComponent(fleet)}/projects/${encodeURIComponent(project)}/backup-targets`

export function selectBackupTarget(targets: BackupTarget[], nameOrId: string) {
  const matches = targets.filter(
    (target) =>
      target.id === nameOrId ||
      target.id.startsWith(nameOrId) ||
      target.name === nameOrId,
  )
  if (matches.length !== 1)
    throw new CliError(
      matches.length
        ? `Backup target "${nameOrId}" is ambiguous.`
        : `No backup target "${nameOrId}" was found.`,
      EXIT.usage,
    )
  return matches[0]!
}

async function execDatabase(
  fleet: string,
  database: Database,
  trailing: string[],
  flags: Flags,
) {
  const role = typeof flags.role === 'string' ? flags.role : 'app'
  if (role !== 'app' && role !== 'readonly')
    throw new CliError('--role must be app or readonly.', EXIT.usage)
  const sql = typeof flags.c === 'string' ? flags.c : undefined
  const file = typeof flags.f === 'string' ? flags.f : undefined
  const command = trailing[0] === '--' ? trailing.slice(1) : []
  const sqlMode = sql !== undefined || file !== undefined
  if (
    Number(sql !== undefined) +
      Number(file !== undefined) +
      Number(command.length > 0) !==
    1
  )
    throw new CliError(
      'Choose exactly one of -c SQL, -f FILE, or -- REDIS-COMMAND.',
      EXIT.usage,
    )
  if (database.engine === 'postgres' && !sqlMode)
    throw new CliError('Postgres exec requires -c SQL or -f FILE.', EXIT.usage)
  if (database.engine === 'redis' && (sqlMode || command.length === 0))
    throw new CliError(
      'Redis exec requires -- REDIS-COMMAND [ARGS…].',
      EXIT.usage,
    )

  const profile = await loadProfile()
  if (!profile.api || !profile.accessToken)
    throw new CliError(
      'Sign in before executing a database command.',
      EXIT.usage,
    )
  const endpoint = new URL(profile.api)
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}${base(fleet, database.project)}/${database.id}/exec`
  const socket = new WebSocket(endpoint, {
    headers: { authorization: `Bearer ${profile.accessToken}` },
    maxPayload: 1_048_576,
  })
  const payload =
    database.engine === 'postgres'
      ? { mode: 'sql', role }
      : { mode: 'redis', role, command }

  await new Promise<void>((resolve, reject) => {
    let completed = false
    const finish = (error?: Error) => {
      if (completed) return
      completed = true
      if (error && socket.readyState === WebSocket.OPEN) socket.close()
      error ? reject(error) : resolve()
    }
    const rawSocket = () =>
      (socket as WebSocket & { _socket: import('node:stream').Duplex | null })
        ._socket
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      finish(
        new CliError(`Database exec was rejected (${response.statusCode}).`),
      )
    })
    socket.once('error', () =>
      finish(new CliError('Database exec connection failed.')),
    )
    socket.once('open', () => socket.send(JSON.stringify(payload)))
    socket.on('message', (data, binary) => {
      if (binary) {
        const chunk = data as Buffer
        if (!process.stdout.write(chunk)) rawSocket()?.pause()
        return
      }
      let message: { type?: string; data?: string; code?: number }
      try {
        message = JSON.parse(data.toString()) as typeof message
      } catch {
        return finish(
          new CliError('Database exec returned an invalid response.'),
        )
      }
      if (message.type === 'ready') {
        void sendInput(socket, sql, file, database.engine).catch(() =>
          finish(new CliError('Could not send database command input.')),
        )
        return
      }
      if (message.type === 'stderr' && message.data) {
        if (!process.stderr.write(Buffer.from(message.data, 'base64')))
          rawSocket()?.pause()
        return
      }
      if (message.type === 'exit') {
        socket.close()
        finish(
          message.code === 0
            ? undefined
            : new CliError(
                `Database command exited with status ${message.code ?? 1}.`,
              ),
        )
      }
    })
    process.stdout.on('drain', () => rawSocket()?.resume())
    socket.once('close', (code, reason) => {
      process.stdout.off('drain', onOutputDrain)
      process.stderr.off('drain', onOutputDrain)
      if (!completed)
        finish(
          new CliError(
            `Database exec session ended before completion (${code}${reason.length ? `: ${reason.toString()}` : ''}).`,
          ),
        )
    })
    const onOutputDrain = () => rawSocket()?.resume()
    process.stdout.on('drain', onOutputDrain)
    process.stderr.on('drain', onOutputDrain)
  })
}

async function sendInput(
  socket: WebSocket,
  sql: string | undefined,
  file: string | undefined,
  engine: string,
) {
  const send = (data: Buffer) =>
    new Promise<void>((resolve, reject) => {
      socket.send(data, { binary: true }, (error) =>
        error ? reject(error) : resolve(),
      )
    })
  if (engine === 'postgres') {
    if (sql !== undefined) await send(Buffer.from(sql))
    else if (file) {
      for await (const chunk of createReadStream(file))
        await send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
  }
  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify({ type: 'eof' }), (error) =>
      error ? reject(error) : resolve(),
    )
  })
}

async function connectDatabase(
  fleet: string,
  database: Database,
  localPort: number,
) {
  const profile = await loadProfile()
  if (!profile.api || !profile.accessToken)
    throw new CliError(
      'Sign in before opening a database connection.',
      EXIT.usage,
    )
  const endpoint = new URL(profile.api)
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}${base(fleet, database.project)}/${database.id}/connect`
  const clients = new Set<import('node:net').Socket>()
  const server = createServer((client) => {
    clients.add(client)
    client.once('close', () => clients.delete(client))
    const tunnel = new WebSocket(endpoint, {
      headers: { authorization: `Bearer ${profile.accessToken}` },
      maxPayload: 1_048_576,
    })
    const rawSocket = () =>
      (
        tunnel as WebSocket & {
          _socket: import('node:stream').Duplex | null
        }
      )._socket
    client.pause()
    tunnel.once('unexpected-response', (_request, response) => {
      console.error(`Database connect was rejected (${response.statusCode}).`)
      client.destroy()
    })
    tunnel.once('open', () => {
      rawSocket()?.on('drain', () => client.resume())
      client.resume()
    })
    tunnel.on('message', (data, binary) => {
      if (!binary) return client.destroy()
      const frame =
        data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Array.isArray(data)
            ? Buffer.concat(data)
            : data
      if (!client.write(frame)) rawSocket()?.pause()
    })
    client.on('data', (data) => {
      if (tunnel.readyState !== WebSocket.OPEN) return client.destroy()
      try {
        tunnel.send(data, { binary: true })
      } catch {
        client.destroy()
        return
      }
      if (tunnel.bufferedAmount > 1_048_576) client.pause()
    })
    client.on('drain', () => rawSocket()?.resume())
    tunnel.on('error', () => client.destroy())
    tunnel.on('close', () => client.destroy())
    client.on('close', () => tunnel.close())
    client.on('error', () => tunnel.close())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(localPort, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  console.log(
    `Database tunnel listening on 127.0.0.1:${localPort}; press Ctrl-C to close.`,
  )
  await new Promise<void>((resolve) => {
    let closing = false
    const close = () => {
      if (closing) return
      closing = true
      for (const client of clients) client.destroy()
      server.close(() => resolve())
    }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
    server.once('close', () => {
      process.off('SIGINT', close)
      process.off('SIGTERM', close)
      resolve()
    })
  })
}

async function findDatabase(fleet: string, nameOrId: string, flags: Flags) {
  const databases: Database[] = []
  let after: string | undefined
  do {
    const query = new URLSearchParams({ limit: '100' })
    if (typeof flags.project === 'string') query.set('project', flags.project)
    if (after) query.set('after', after)
    const { body } = await request<{
      databases: Database[]
      nextCursor: string | null
    }>('GET', `/fleets/${fleet}/databases?${query}`)
    databases.push(...body.databases)
    after = body.nextCursor ?? undefined
  } while (after)
  return selectDatabase(
    databases,
    nameOrId,
    typeof flags.project === 'string' ? flags.project : undefined,
  )
}

export function selectDatabase(
  databases: Database[],
  nameOrId: string,
  project?: string,
) {
  const matches = databases.filter(
    (database) =>
      (database.id === nameOrId || database.name === nameOrId) &&
      (!project || database.project === project),
  )
  if (matches.length === 0)
    throw new CliError(
      `Database "${nameOrId}" was not found${typeof project === 'string' ? ` in project ${project}` : ''}.`,
    )
  if (matches.length > 1)
    throw new CliError(
      `Database name "${nameOrId}" is used by multiple projects; pass --project.`,
    )
  return matches[0]!
}
