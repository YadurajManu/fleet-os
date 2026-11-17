import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { CliError, EXIT, request, requireFleet } from '../api.js'
import { c, table, statusBadge } from '../render.js'
import type { Flags } from '../args.js'

type Database = {
  id: string
  project: string
  name: string
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
      const serviceId = args[3]
      if (!project || !nameOrId || !serviceId)
        throw new CliError(
          'usage: fleet databases link <project> <database-id> <service-id> [--role app|readonly] [--as PREFIX]',
          EXIT.usage,
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
      }>('POST', `${base(fleet, project)}/${nameOrId}/links`, {
        body: {
          serviceId,
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
      const serviceId = args[3]
      if (!project || !nameOrId || !serviceId)
        throw new CliError(
          'usage: fleet databases unlink <project> <database-id> <service-id>',
          EXIT.usage,
        )
      const { body } = await request<{
        serviceId: string
        restartRequired: boolean
      }>('DELETE', `${base(fleet, project)}/${nameOrId}/links/${serviceId}`)
      if (flags.json) return console.log(JSON.stringify(body, null, 2))
      console.log(`Service ${serviceId} unlinked.`)
      if (body.restartRequired)
        console.log('Redeploy the service to remove the database connection.')
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
      'usage: fleet databases list|create|start|stop|restart|link|unlink …',
      EXIT.usage,
    )
  },
}
