import type { Node, Service } from './api'
import { freshTelemetry } from './telemetry'

export const REGIONS = [
  { id: 'north-america', label: 'North America', x: 24, y: 33 },
  { id: 'south-america', label: 'South America', x: 35, y: 68 },
  { id: 'europe', label: 'Europe', x: 51, y: 32 },
  { id: 'africa', label: 'Africa', x: 52, y: 57 },
  { id: 'middle-east', label: 'Middle East', x: 61, y: 49 },
  { id: 'south-asia', label: 'South Asia', x: 69, y: 57 },
  { id: 'east-asia', label: 'East Asia', x: 77, y: 35 },
  { id: 'oceania', label: 'Oceania', x: 79, y: 73 },
] as const

export type RegionId = (typeof REGIONS)[number]['id']

export function nodeRegion(node: Node): RegionId | null {
  const tag = node.tags?.find(value => value.startsWith('region:'))?.slice(7)
  return REGIONS.find(region => region.id === tag)?.id ?? null
}

export function missionHealth(nodes: Node[], services: Service[], maxAgeMs: number) {
  const fresh = nodes.filter(node => freshTelemetry(node, maxAgeMs))
  const reachable = nodes.filter(node => node.live)
  const offline = nodes.filter(node => !node.live)
  const runtimeDown = fresh.filter(node => node.telemetry?.runtime.dockerAvailable === false)
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const reportedRunning = services.filter(service => ['running', 'online'].includes(service.current?.status ?? ''))
  const deploying = services.filter(service => service.current?.status === 'deploying')
  const notRunning = services.filter(service => !reportedRunning.includes(service) && !deploying.includes(service))
  const atRisk = reportedRunning.filter(service => {
    const node = service.current?.nodeId ? nodeById.get(service.current.nodeId) : null
    return !node || !node.live
  })
  const running = reportedRunning.filter(service => !atRisk.includes(service))
  const issues = [
    ...notRunning.map(service => ({ id: `service:${service.id}`, kind: 'Service', label: service.name, detail: service.last?.failureReason || 'No running release reported', href: `/services/${service.id}` })),
    ...atRisk.map(service => ({ id: `risk:${service.id}`, kind: 'At risk', label: service.name, detail: 'Its node is not responding; the reported release may be unavailable', href: `/services/${service.id}` })),
    ...offline.map(node => ({ id: `node:${node.id}`, kind: 'Node', label: node.name, detail: 'Agent heartbeat unavailable', href: `/nodes/${node.id}` })),
    ...runtimeDown.map(node => ({ id: `runtime:${node.id}`, kind: 'Runtime', label: node.name, detail: 'Docker engine unavailable', href: `/nodes/${node.id}` })),
  ]
  const latestHeartbeat = nodes.map(node => node.lastHeartbeatAt).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null
  return { fresh, reachable, offline, running, deploying, notRunning, atRisk, issues, latestHeartbeat }
}
