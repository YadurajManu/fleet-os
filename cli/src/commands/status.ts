import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c, cursor, glyphs, table, mb, memoryPair, relativeTime, loadBar, statusBadge, header, section, hint } from '../render.js'
import { operationHeader } from '../presentation.js'
import type { Flags } from '../args.js'
import { failureKey, translateFailure } from '../error-translation.js'
import { loadProfile } from '../config.js'

type MapNode = { id: string; name: string; arch: string; status: string; reliabilityTier: string; ramMb: number; freeRamMb: number; loadFactor: number | null; services: Array<{ name: string; policy: string; status: string }> }
type Node = {
  id: string; name: string; arch: string; platform?: string | null; engineKind?: string | null; status: string; schedulable?: boolean
  reliabilityTier: string; ramMb: number; effectiveCpu?: number | null; effectiveMemBytes?: number | null
  tunnelConnected?: boolean; diskMb?: number; buildCacheFreeBytes?: number; buildDiskReserveBytes?: number; agentVersion?: string | null; canBuild?: boolean; live: boolean; lastHeartbeatAt: string | null
  telemetry: { cpuPct: number; ramUsedMb: number; containers: Array<{ name: string }>; ageMs?: number; runtime?: { dockerError?: string; registryError?: string; lastReconcileError?: string } } | null
}
type Service = {
  id: string; name: string
  current: { nodeId: string | null; nodeName: string | null; status: string } | null
  last: { status: string; failureReason: string | null; startedAt: string; nodeName: string | null } | null
  recentFailures: number
}
type Fleet = { id: string; name: string; heartbeatIntervalSec?: number; heartbeatMissThreshold?: number }
type Event = { at: string; service: string; reason: string; from: string | null; to: string | null; detail?: Record<string, unknown> | null }
export type StatusSnapshot = { fleet: Fleet; nodes: Node[]; mapNodes: MapNode[]; services: Service[]; unplaced: string[]; events: Event[]; fetchedAt: string }

const bool = (value: string | boolean | undefined): boolean => value === true || value === 'true'

function sinceMs(value: string | boolean | undefined): number | null {
  if (value === undefined) return null
  if (typeof value !== 'string') throw new CliError('--since needs a duration such as 30m, 24h, or 7d.', EXIT.usage)
  const match = /^(\d+)(m|h|d)$/.exec(value.trim())
  if (!match) throw new CliError('--since must look like 30m, 24h, or 7d.', EXIT.usage)
  const unit = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000
  return Number(match[1]) * unit
}

async function snapshot(fleetId: string, flags: Flags): Promise<StatusSnapshot> {
  const [fleet, map, nodes, services, events] = await Promise.all([
    request<{ fleet: Fleet }>('GET', `/fleets/${fleetId}`),
    request<{ nodes: MapNode[]; unplaced: string[] }>('GET', `/fleets/${fleetId}/placement-map`),
    request<{ nodes: Node[] }>('GET', `/fleets/${fleetId}/nodes`),
    request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`),
    request<{ events: Event[] }>('GET', `/fleets/${fleetId}/events?limit=${flags.since || flags.all ? 200 : 5}`),
  ])
  const window = sinceMs(flags.since)
  return {
    fleet: fleet.body.fleet,
    nodes: nodes.body.nodes,
    mapNodes: map.body.nodes,
    services: services.body.services,
    unplaced: map.body.unplaced,
    events: window === null ? events.body.events : events.body.events.filter((event) => Date.now() - new Date(event.at).getTime() <= window),
    fetchedAt: new Date().toISOString(),
  }
}

const nodeStatus = (node: Node): string => !node.live ? 'offline' : node.status === 'cordoned' ? 'cordoned' : 'online'

export function affectedServices(data: StatusSnapshot): Service[] {
  const offlineIds = new Set(data.nodes.filter((node) => !node.live).map((node) => node.id))
  return data.services.filter((service) => !service.current || service.current.status !== 'running' || Boolean(service.current.nodeId && offlineIds.has(service.current.nodeId)))
}

export function fleetHealth(data: StatusSnapshot): 'healthy' | 'degraded' | 'critical' {
  const affected = affectedServices(data)
  if (affected.some((service) => service.current?.status === 'pinned_unavailable')) return 'critical'
  if (data.nodes.some((node) => !node.live) || affected.length || data.unplaced.length) return 'degraded'
  return 'healthy'
}

const nodeServices = (node: Node, services: Service[]): Service[] => services.filter((service) => service.current?.nodeId === node.id)

function renderNodes(data: StatusSnapshot): string {
  return table(
    ['node', 'platform', 'role', 'load', 'memory', 'runs', 'status'],
    data.nodes.map((node) => {
      const assigned = nodeServices(node, data.services)
      const age = node.telemetry?.ageMs
      const hasLiveTelemetry = node.live && node.telemetry && typeof age === 'number' && age >= 0 && age <= (data.fleet.heartbeatIntervalSec ?? 5) * (data.fleet.heartbeatMissThreshold ?? 3) * 1000
      const memoryTotalMb = node.effectiveMemBytes ? node.effectiveMemBytes / 1048576 : node.ramMb
      // Older macOS agents mixed host RAM used with Docker-engine capacity.
      // Used > capacity is evidence that those figures describe different
      // machines, not a reason to print 0 MB free with false precision.
      const memoryComparable = hasLiveTelemetry && node.telemetry!.ramUsedMb <= memoryTotalMb
      const freeMb = Math.max(0, memoryTotalMb - (node.telemetry?.ramUsedMb ?? 0))
      const memoryLabel = memoryPair(freeMb, memoryTotalMb)
      return [
        `${node.live ? c.green(glyphs.online) : c.red(glyphs.fail)} ${node.name}${node.status === 'cordoned' ? ` ${c.yellow('[cordoned]')}` : ''}`,
        node.platform || `linux/${node.arch}`,
        node.canBuild ? 'builder' : node.reliabilityTier,
        hasLiveTelemetry ? loadBar(node.telemetry!.cpuPct, (process.stdout.columns ?? 80) >= 100 ? 8 : 5) : '—',
        memoryComparable ? memoryLabel : '—',
        assigned.length ? (node.telemetry?.containers.map((container) => container.name).join(', ') || assigned.map((service) => service.name).join(', ')) : '—',
        statusBadge(nodeStatus(node)),
      ]
    }),
    { priorities: [0, 3, 7, 3, 3, 5, 0] }
  )
}

function renderNodeDetails(data: StatusSnapshot): string {
  return data.nodes.map((node) => {
    const age = node.telemetry?.ageMs
    const details = [node.engineKind, node.agentVersion ? `agent v${node.agentVersion.replace(/^v/, '')}` : null, node.effectiveCpu ? `${node.effectiveCpu} CPU` : null]
    details.push(node.tunnelConnected ? 'tunnel connected' : 'tunnel disconnected')
    details.push(node.live && node.diskMb != null ? `${mb(node.diskMb)} disk free` : 'disk —')
    details.push(age == null ? 'sample age —' : `sample ${Math.round(age / 1000)}s${age > (data.fleet.heartbeatIntervalSec ?? 5) * (data.fleet.heartbeatMissThreshold ?? 3) * 1000 ? ' stale' : ''}`)
    const errors = node.telemetry?.runtime && [node.telemetry.runtime.dockerError, node.telemetry.runtime.registryError, node.telemetry.runtime.lastReconcileError].filter(Boolean)
    if (errors?.length) details.push(`runtime: ${errors.join('; ')}`)
    if (node.canBuild) details.push(`${mb((node.buildDiskReserveBytes ?? 0) / 1048576)} build reserve`)
    return `  ${c.dim(glyphs.branch)} ${node.name} · ${details.filter(Boolean).join(' · ')}`
  }).join('\n')
}

function renderServices(data: StatusSnapshot): string {
  return table(
    ['service', 'node', 'status', 'last deploy', 'failures (7d)'],
    data.services.map((service) => [
      service.name,
      service.current?.nodeName ?? service.last?.nodeName ?? c.dim('unplaced'),
      statusBadge(service.current?.status ?? service.last?.status ?? 'not deployed'),
      relativeTime(service.last?.startedAt),
      service.recentFailures ? c.yellow(String(service.recentFailures)) : '0',
    ]),
    { priorities: [0, 3, 0, 4, 2] }
  )
}

function builderHint(service: Service, data: StatusSnapshot): string | undefined {
  if (!service.last?.failureReason || !/build/i.test(service.last.failureReason)) return undefined
  const used = data.nodes.find((node) => node.name === service.last?.nodeName)
  const stronger = data.nodes.filter((node) => node.live && node.canBuild && node.effectiveCpu && (!used?.effectiveCpu || node.effectiveCpu > used.effectiveCpu)).sort((a, b) => (b.effectiveCpu ?? 0) - (a.effectiveCpu ?? 0))[0]
  return used && stronger?.effectiveCpu && used.effectiveCpu
    ? `  ${c.dim(`built on ${used.name} (${used.effectiveCpu} CPU); ${stronger.name} has ${stronger.effectiveCpu} CPU` )}`
    : undefined
}

function renderProblems(data: StatusSnapshot): string[] {
  const blocks: string[] = []
  for (const node of data.nodes.filter((item) => !item.live)) {
    blocks.push(`${c.red(`${glyphs.fail} ${node.name}`)} stopped reporting ${relativeTime(node.lastHeartbeatAt)}\n${hint('fleet doctor')}`)
  }

  const failedGroups = new Map<string, Service[]>()
  const other = affectedServices(data).filter((service) => {
    const status = service.current?.status ?? service.last?.status ?? 'not deployed'
    if (status === 'failed' && service.last?.failureReason) {
      const key = failureKey(service.last.failureReason)
      failedGroups.set(key, [...(failedGroups.get(key) ?? []), service])
      return false
    }
    return true
  })

  for (const services of failedGroups.values()) {
    const names = services.map((service) => service.name).join(', ')
    const lines = [`${c.red(`${glyphs.fail} ${names}`)}  ${translateFailure(services[0]!.last!.failureReason!)}`]
    for (const service of services) {
      const clue = builderHint(service, data)
      if (clue) lines.push(clue)
      lines.push(hint(`fleet logs ${service.name} --follow`))
    }
    blocks.push(lines.join('\n'))
  }

  for (const service of other) {
    const status = service.current?.status ?? service.last?.status ?? 'not deployed'
    const node = data.nodes.find((item) => item.id === service.current?.nodeId)
    const offlineNode = node && !node.live ? node : undefined
    const cordoned = status === 'pinned_unavailable' && node?.status === 'cordoned'
    if (status === 'not deployed') {
      blocks.push(`${c.dim(`${glyphs.stepTodo} ${service.name}`)} never deployed\n${hint(`fleet deploy ${service.name}`)}`)
    } else if (cordoned && node) {
      blocks.push(`${c.yellow(`${glyphs.warn} ${service.name}`)} unavailable because ${node.name} is cordoned\n${hint(`fleet nodes uncordon ${node.name}`)}\n${hint(`fleet deploy ${service.name}`)}`)
    } else if (offlineNode) {
      blocks.push(`${c.red(`${glyphs.fail} ${service.name}`)} assigned to offline node ${offlineNode.name}\n${hint('fleet doctor')}`)
    } else if (['deploying', 'building', 'pushing', 'queued'].includes(status)) {
      blocks.push(`${statusBadge(status)} ${service.name}\n${hint('fleet status --watch')}`)
    } else {
      const cause = service.last?.failureReason ? translateFailure(service.last.failureReason) : status.replaceAll('_', ' ')
      blocks.push(`${c.red(`${glyphs.fail} ${service.name}`)}  ${cause}\n${hint(`fleet logs ${service.name} --follow`)}`)
    }
  }
  for (const name of data.unplaced) {
    if (data.services.some((service) => service.name === name && !service.current && !service.last)) continue
    blocks.push(`${c.yellow(`${glyphs.warn} ${name}`)} has no eligible node\n${hint('fleet doctor')}`)
  }
  return blocks
}

const renderEvents = (events: Event[]): string[] => events.map((event) => {
  const route = event.from ? `${event.from} → ${event.to ?? 'unplaced'}` : `→ ${event.to ?? 'unplaced'}`
  return `  ${relativeTime(event.at).padEnd(9)} ${event.service.padEnd(20)} ${c.dim(event.reason)} ${route}`
})

export function renderStatus(data: StatusSnapshot, flags: Flags = {}, newlyFailed: string[] = []): string {
  if (!data.nodes.length) return `${operationHeader(data.fleet.name, 'Status') }\nNo nodes in this fleet yet.\n  Run \`fleet nodes pair\` to connect a machine.\n`
  const health = fleetHealth(data)
  const affected = affectedServices(data)
  const onlyNodes = bool(flags.nodes)
  const onlyServices = bool(flags.services)
  const onlyFailures = bool(flags.failures)
  const running = data.services.filter((service) => service.current?.status === 'running').length
  const failed = data.services.filter((service) => service.current?.status === 'failed' || (!service.current && service.last?.status === 'failed')).length
  const notDeployed = data.services.filter((service) => !service.current && (!service.last || service.last.status === 'not deployed')).length
  const online = data.nodes.filter((node) => node.live).length
  const healthLabel = health === 'healthy' ? 'HEALTHY' : health === 'critical' ? 'DOWN' : 'DEGRADED'
  const onlineSummary = online ? `${online} ${online === 1 ? 'node' : 'nodes'} online` : 'No nodes online'
  const sections: string[] = [`${header(`fleet ${glyphs.info} ${data.fleet.name}`, healthLabel)}\n${onlineSummary} · ${running} of ${data.services.length} services running${failed ? ` · ${failed} failed` : ''}${notDeployed ? ` · ${notDeployed} not deployed` : ''}`]

  if (newlyFailed.length) sections.push(c.red(`${glyphs.fail} NEW FAILURE  ${newlyFailed.join(', ')}`))

  if (!onlyFailures && !onlyServices) {
    sections.push(`${section('Nodes')}\n${renderNodes(data)}${bool(flags.verbose) || bool(flags.v) ? `\n${renderNodeDetails(data)}` : ''}`)
  }
  if (onlyServices || (!onlyNodes && data.services.length)) {
    sections.push(data.services.length ? `${section('Services')}\n${renderServices(data)}` : c.dim('No services deployed.'))
  }

  const problems = renderProblems(data)
  if (problems.length && health !== 'healthy') sections.push(`${section('Problems')}\n${problems.join('\n\n')}`)
  else if (onlyFailures) sections.push(c.dim('No current failures.'))
  if (!onlyNodes && !onlyServices && !onlyFailures && data.events.length) sections.push(`${section('Recent')}\n${renderEvents(data.events.slice(0, bool(flags.all) ? data.events.length : 5)).join('\n')}`)

  const interval = data.fleet.heartbeatIntervalSec
  const footer = [`updated ${relativeTime(data.fetchedAt)}`, '--watch for live view', '--json for scripts']
  if (interval) footer.push(`heartbeat ${interval}s`)
  sections.push(c.dim(footer.join(' · ')))
  return `${sections.filter(Boolean).join('\n\n')}\n`
}

export function statusJson(data: StatusSnapshot): string {
  return JSON.stringify({ ...data, health: fleetHealth(data), affectedServices: affectedServices(data) }, null, 2)
}

async function printStatus(fleetId: string, flags: Flags): Promise<void> {
  const data = await snapshot(fleetId, flags)
  if (flags.json) return console.log(statusJson(data))
  process.stdout.write(renderStatus(data, flags))
}

export const statusCommand = {
  async run(_args: string[], flags: Flags) {
    if (flags.public) {
      if (flags.watch) throw new CliError('--public does not support --watch; the public status page updates live.', EXIT.usage)
      const profile = await loadProfile()
      const response = await request<{ status: string; stale: boolean; as_of: string | null; components: Array<{ name: string; status: string; uptime: number | null }> }>('GET', '/v1/status', { auth: false, profile: { ...profile, api: profile.api || 'https://fleetapi.plastikworld.xyz' } })
      if (flags.json) { console.log(JSON.stringify(response.body, null, 2)); return }
      console.log(header('Fleet public status'))
      console.log(`${response.body.status.replaceAll('_', ' ')}${response.body.stale ? ' · stale readings' : ''}`)
      console.log(table(['COMPONENT', 'STATUS', 'UPTIME'], response.body.components.map(component => [component.name, component.status.replaceAll('_', ' '), typeof component.uptime === 'number' ? `${component.uptime.toFixed(2)}%` : 'unknown'])))
      console.log(`As of: ${response.body.as_of ?? 'No measurements yet'}`)
      return
    }
    if (flags.watch && flags.json) throw new CliError('--watch cannot be combined with --json.', EXIT.usage)
    if (flags.watch && !process.stdout.isTTY) throw new CliError('--watch needs an interactive terminal.', EXIT.usage)
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    if (!flags.watch) return printStatus(fleetId, flags)
    let stopping = false
    let previousFailed: Set<string> | null = null
    let timer: NodeJS.Timeout | undefined
    let wake: (() => void) | null = null
    const onInterrupt = () => {
      stopping = true
      wake?.()
      process.stdout.write(cursor.show())
    }
    process.on('SIGINT', onInterrupt)
    process.stdout.write(cursor.hide())
    try {
      while (!stopping) {
        const data = await snapshot(fleetId, flags)
        const failedNow = new Set(affectedServices(data).filter((service) => service.current?.status === 'failed').map((service) => service.name))
        const newlyFailed = previousFailed ? [...failedNow].filter((name) => !previousFailed!.has(name)) : []
        previousFailed = failedNow
        process.stdout.write(`\x1b[H\x1b[0J${renderStatus(data, flags, newlyFailed)}`)
        if (stopping) break
        await new Promise<void>((resolve) => {
          timer = setTimeout(() => { wake = null; resolve() }, 2_000)
          wake = () => { if (timer) clearTimeout(timer); wake = null; resolve() }
        })
      }
    } finally {
      if (timer) clearTimeout(timer)
      process.removeListener('SIGINT', onInterrupt)
      process.stdout.write(cursor.show())
    }
  },
}

export const eventsCommand = {
  async run(_args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const limit = typeof flags.limit === 'string' ? flags.limit : '30'
    const { body } = await request<{ events: Event[] }>('GET', `/fleets/${fleetId}/events?limit=${limit}`)
    if (flags.json) return console.log(JSON.stringify(body.events, null, 2))
    if (!body.events.length) return console.log('No events recorded yet.')
    console.log(`${section('Recent events')}\n${table(['time', 'subject', 'event', 'details'], body.events.map((event) => {
      const marker = /fail|error/i.test(event.reason) ? c.red(glyphs.fail) : event.reason === 'failover' ? c.yellow(glyphs.warn) : /running|healthy|online|complete/i.test(event.reason) ? c.green(glyphs.online) : c.cyan(glyphs.info)
      const location = event.from || event.to ? `${event.from ?? '—'} → ${event.to ?? '—'}` : '—'
      const score = typeof event.detail?.score === 'number' ? `score ${event.detail.score.toFixed(3)}` : ''
      return [relativeTime(event.at), `${marker} ${event.service}`, event.reason.replaceAll('_', ' '), [location, score].filter(Boolean).join(' · ')]
    }), { priorities: [0, 0, 2, 1] })}`)
  },
}
