import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c, glyphs, table, statusColour, mb, relativeTime } from '../render.js'
import { operationHeader } from '../presentation.js'
import type { Flags } from '../args.js'

type MapNode = { id: string; name: string; arch: string; status: string; reliabilityTier: string; ramMb: number; freeRamMb: number; loadFactor: number | null; services: Array<{ name: string; policy: string; status: string }> }
type Node = {
  id: string; name: string; arch: string; platform?: string | null; engineKind?: string | null; status: string
  reliabilityTier: string; ramMb: number; effectiveCpu?: number | null; effectiveMemBytes?: number | null
  agentVersion?: string | null; canBuild?: boolean; live: boolean; lastHeartbeatAt: string | null
  telemetry: { cpuPct: number; ramUsedMb: number; containers: Array<{ name: string }>; ageMs?: number } | null
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
    request<{ events: Event[] }>('GET', `/fleets/${fleetId}/events?limit=${flags.since ? 200 : 5}`),
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

const nodeStatus = (node: Node): string => node.live ? node.status === 'cordoned' ? 'cordoned' : 'online' : 'offline'

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
    ['node', 'platform', 'last seen', 'cpu', 'memory', 'services', 'status'],
    data.nodes.map((node) => {
      const assigned = nodeServices(node, data.services)
      const hasLiveTelemetry = node.live && node.telemetry
      const memoryTotalMb = node.effectiveMemBytes ? node.effectiveMemBytes / 1048576 : node.ramMb
      const memoryTotal = mb(memoryTotalMb)
      // Older macOS agents mixed host RAM used with Docker-engine capacity.
      // Used > capacity is evidence that those figures describe different
      // machines, not a reason to print 0 MB free with false precision.
      const memoryComparable = hasLiveTelemetry && node.telemetry!.ramUsedMb <= memoryTotalMb
      return [
        node.name,
        node.platform || `linux/${node.arch}`,
        relativeTime(node.lastHeartbeatAt),
        hasLiveTelemetry ? `${Math.round(node.telemetry!.cpuPct)}%` : c.dim('unavailable'),
        memoryComparable ? `${mb(Math.max(0, memoryTotalMb - node.telemetry!.ramUsedMb))}/${memoryTotal}` : c.dim(`unavailable · ${memoryTotal} total`),
        assigned.length ? assigned.map((service) => service.current?.status === 'running' ? service.name : c.yellow(service.name)).join(' ') : c.dim('—'),
        statusColour(nodeStatus(node)),
      ]
    })
  )
}

function renderCapabilities(data: StatusSnapshot): string {
  return data.nodes.map((node) => {
    const parts: Array<string | null | undefined> = [node.engineKind, node.agentVersion ? `agent v${node.agentVersion.replace(/^v/, '')}` : null]
    if (node.canBuild) parts.push('builder')
    if (node.effectiveCpu) parts.push(`${node.effectiveCpu} CPU`)
    return `  ${c.dim(glyphs.branch)} ${node.name} · ${parts.filter(Boolean).join(' · ') || 'capabilities unavailable'}`
  }).join('\n')
}

function renderServices(data: StatusSnapshot): string {
  return table(
    ['service', 'node', 'status', 'last deploy', 'failures (7d)'],
    data.services.map((service) => [
      service.name,
      service.current?.nodeName ?? service.last?.nodeName ?? c.dim('unplaced'),
      statusColour(service.current?.status ?? service.last?.status ?? 'not deployed'),
      relativeTime(service.last?.startedAt),
      service.recentFailures ? c.yellow(String(service.recentFailures)) : '0',
    ])
  )
}

function renderProblems(data: StatusSnapshot): string[] {
  const lines: string[] = []
  for (const node of data.nodes.filter((item) => !item.live)) lines.push(`${c.red(glyphs.fail)} ${node.name} stopped reporting ${relativeTime(node.lastHeartbeatAt)}`)
  for (const service of affectedServices(data)) {
    const status = service.current?.status ?? service.last?.status ?? 'not deployed'
    lines.push(`${c.red(glyphs.fail)} ${service.name} ${status}${service.last?.failureReason ? ` · ${service.last.failureReason}` : ''}`)
  }
  for (const service of data.unplaced) lines.push(`${c.yellow(glyphs.warn)} ${service} has no eligible node`)
  return [...new Set(lines)]
}

const renderEvents = (events: Event[]): string[] => events.map((event) => {
  const route = event.from ? `${event.from} → ${event.to ?? 'unplaced'}` : `→ ${event.to ?? 'unplaced'}`
  return `  ${relativeTime(event.at).padEnd(9)} ${event.service.padEnd(20)} ${c.dim(event.reason)} ${route}`
})

function nextActions(data: StatusSnapshot): string[] {
  const actions = new Set<string>()
  if (data.nodes.some((node) => !node.live)) actions.add('fleet doctor')
  for (const service of affectedServices(data)) {
    actions.add(`fleet logs ${service.name} --follow`)
    if (data.nodes.some((node) => node.live)) actions.add(`fleet reschedule ${service.name}`)
  }
  if (!actions.size) actions.add('fleet services')
  return [...actions].slice(0, 4)
}

export function renderStatus(data: StatusSnapshot, flags: Flags = {}): string {
  if (!data.nodes.length) return `${operationHeader(data.fleet.name, 'Status') }\nNo nodes in this fleet yet.\n  Run \`fleet nodes pair\` to connect a machine.\n`
  const health = fleetHealth(data)
  const affected = affectedServices(data)
  const offline = data.nodes.filter((node) => !node.live)
  const onlyNodes = bool(flags.nodes)
  const onlyServices = bool(flags.services)
  const onlyFailures = bool(flags.failures)
  const sections: string[] = [operationHeader(data.fleet.name, `Status ${statusColour(health)}`).trimEnd()]

  sections.push(health === 'healthy'
    ? `${c.green(glyphs.ok)} ${data.nodes.length} node(s) reporting · ${data.services.length} service(s) available`
    : `${c.yellow(glyphs.warn)} ${offline.length} node(s) offline · ${affected.length} service(s) affected`)

  if (!onlyFailures && !onlyServices) {
    sections.push(renderNodes(data))
    sections.push(renderCapabilities(data))
  }
  if (onlyServices || (!onlyNodes && data.services.length)) {
    sections.push(data.services.length ? `${c.dim('Services')}\n${renderServices(data)}` : c.dim('No services deployed.'))
  }

  const problems = renderProblems(data)
  if (problems.length) sections.push(`${c.bold('Why degraded')}\n${problems.join('\n')}`)
  else if (onlyFailures) sections.push(c.dim('No current failures.'))
  if (!onlyNodes && !onlyServices && !onlyFailures && data.events.length) sections.push(`${c.dim('Recent activity')}\n${renderEvents(data.events).join('\n')}`)

  const actions = nextActions(data)
  if (actions.length && health !== 'healthy') sections.push(`${c.bold('Next actions')}\n${actions.map((action) => `  ${c.cyan(action)}`).join('\n')}`)

  const interval = data.fleet.heartbeatIntervalSec
  sections.push(c.dim(`Updated just now${interval ? ` · heartbeat expected every ${interval}s` : ''}`))
  return `${sections.filter(Boolean).join('\n\n')}\n`
}

async function printStatus(fleetId: string, flags: Flags): Promise<void> {
  const data = await snapshot(fleetId, flags)
  if (flags.json) return console.log(JSON.stringify({ ...data, health: fleetHealth(data), affectedServices: affectedServices(data) }, null, 2))
  process.stdout.write(renderStatus(data, flags))
}

export const statusCommand = {
  async run(_args: string[], flags: Flags) {
    if (flags.watch && flags.json) throw new CliError('--watch cannot be combined with --json.', EXIT.usage)
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    if (!flags.watch) return printStatus(fleetId, flags)
    do {
      if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H')
      await printStatus(fleetId, flags)
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    } while (true)
  },
}

export const eventsCommand = {
  async run(_args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const limit = typeof flags.limit === 'string' ? flags.limit : '30'
    const { body } = await request<{ events: Event[] }>('GET', `/fleets/${fleetId}/events?limit=${limit}`)
    if (flags.json) return console.log(JSON.stringify(body.events, null, 2))
    if (!body.events.length) return console.log('no events yet')
    console.log(table(['when', 'service', 'reason', 'from', 'to', 'score'], body.events.map((event) => [
      relativeTime(event.at), event.service, event.reason === 'failover' ? c.yellow(event.reason) : event.reason,
      event.from ?? c.dim('—'), event.to ?? c.dim('—'), typeof event.detail?.score === 'number' ? event.detail.score.toFixed(3) : c.dim('—'),
    ])))
  },
}
