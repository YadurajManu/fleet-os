import { place } from '../scheduler/placement.js'
import type {
  Decision,
  NodeSnapshot,
  Rejection,
  ServiceSpec,
} from '../scheduler/types.js'

export function databaseStabilityScore(node: NodeSnapshot): number {
  const uptime =
    node.uptimeSec === undefined
      ? 0.5
      : 0.4 + 0.6 * Math.min(1, Math.max(0, node.uptimeSec) / (7 * 86400))
  return Math.max(
    0,
    Math.min(
      1,
      uptime * Math.exp(-Math.max(0, node.outagesLast30Days ?? 0) / 10),
    ),
  )
}

type DatabasePlacement = {
  id: string
  name: string
  memoryMb: number
  cpu: number
  diskMb: number
  nodeId?: string
  volumeNodeId?: string
  preferredNodeIds?: string[]
}

/** Pure recommendation only: existing data pins are never converted into failover placement. */
export function placeDatabase(
  request: DatabasePlacement,
  nodes: NodeSnapshot[],
): Decision {
  if (
    !Number.isInteger(request.memoryMb) ||
    request.memoryMb < 128 ||
    request.memoryMb > 1048576 ||
    !Number.isFinite(request.cpu) ||
    request.cpu <= 0 ||
    request.cpu > 1024 ||
    !Number.isInteger(request.diskMb) ||
    request.diskMb < 1024 ||
    request.diskMb > 2147483647
  )
    throw new Error('Invalid database resource allocation.')
  if (
    request.nodeId &&
    request.volumeNodeId &&
    request.nodeId !== request.volumeNodeId
  ) {
    return {
      outcome: 'no_eligible_node',
      candidates: [],
      rejected: [],
      warnings: [],
      summary:
        'This volume is pinned to another node. Use explicit recovery or a planned move.',
    }
  }
  const rejected: Rejection[] = []
  const eligible = nodes.filter((node) => {
    const reject = (code: Rejection['code'], detail: string) => {
      rejected.push({ nodeId: node.id, nodeName: node.name, code, detail })
      return false
    }
    if (!node.databaseCapabilities?.includes('database.runtime.v1'))
      return reject(
        'agent_upgrade_required',
        'Upgrade the agent before placing a database on this node.',
      )
    if (
      node.freeDiskMb === undefined ||
      !Number.isFinite(node.freeDiskMb) ||
      node.freeDiskMb < 0
    )
      return reject(
        'disk_unknown',
        'Docker disk headroom has not been measured; refresh the agent capacity report.',
      )
    if (node.freeDiskMb - (node.committedDiskMb ?? 0) < request.diskMb)
      return reject(
        'insufficient_disk',
        'Insufficient disk after existing database reservations and the node safety reserve.',
      )
    return true
  })
  const pin = request.volumeNodeId ?? request.nodeId
  const spec: ServiceSpec = {
    id: request.id,
    name: request.name,
    workloadClass: 'stateful',
    placementPolicy: pin ? 'pinned' : 'preferred',
    pinnedNodeId: pin,
    requestRamMb: request.memoryMb,
    requestCpu: request.cpu,
    requiresGpu: false,
    minReliabilityTier: 'opportunistic',
    compatibleArches: ['arm64', 'amd64'],
    platforms: ['linux/arm64', 'linux/amd64'],
    persistentVolume: true,
    volumeNodeId: request.volumeNodeId,
    affinity: [],
    antiAffinity: [],
    preferredNodeIds: request.preferredNodeIds,
  }
  const decision = place(
    spec,
    eligible.map((node) => ({
      ...node,
      effectiveCpu: node.effectiveCpu ?? node.cpuCores,
      committedRamMb:
        node.committedRamMb +
        Math.max(
          128,
          Math.ceil(
            (node.effectiveMemBytes
              ? node.effectiveMemBytes / 1048576
              : node.ramMb) * 0.1,
          ),
        ),
      reliabilityScore: databaseStabilityScore(node),
    })),
  )
  decision.rejected.push(...rejected)
  if (decision.outcome === 'no_eligible_node') {
    decision.summary =
      'No eligible database node. Review disk, memory, agent capabilities and the existing data pin.'
    return decision
  }
  const selected = nodes.find((node) => node.id === decision.nodeId)!
  if (databaseStabilityScore(selected) < 0.6)
    decision.warnings.push(
      'Limited uptime history or recent outages: this database becomes unreachable if the selected node sleeps or disconnects.',
    )
  if (selected.tags.includes('storage:sd'))
    decision.warnings.push(
      'SD-card storage can be slow and has limited write endurance; use off-node backups.',
    )
  else if (
    !selected.tags.some((tag) => ['storage:ssd', 'storage:hdd'].includes(tag))
  )
    decision.warnings.push(
      'Storage type is unmeasured. Verify the database volume backing before placing a write-heavy workload.',
    )
  for (const candidate of decision.candidates) {
    const node = nodes.find((node) => node.id === candidate.nodeId)!
    candidate.freeDiskMb = Math.max(
      0,
      (node.freeDiskMb ?? 0) - (node.committedDiskMb ?? 0),
    )
    candidate.reason = `${Math.floor(candidate.freeRamMb)} MB spare RAM; ${Math.floor(candidate.freeDiskMb)} MB reserved-safe disk; stability ${databaseStabilityScore(node).toFixed(2)}.`
  }
  return decision
}
