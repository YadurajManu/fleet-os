import type {
  NodeSnapshot,
  ServiceSpec,
  Placements,
  AntiAffinityIndex,
} from '../scheduler/types.js'
import { filterNodes } from '../scheduler/placement.js'
import { platformsFor } from './runner.js'

// Legacy agents only report host architecture. Their existing Linux-container
// contract remains eligible for execution, but never confers builder capability.
export function nodePlatform(
  node: Pick<NodeSnapshot, 'platform' | 'arch'>
): string {
  return node.platform ?? platformsFor([node.arch])[0] ?? ''
}
export function planPlatforms(
  service: ServiceSpec,
  nodes: NodeSnapshot[],
  placements: Placements = {},
  antiAffinityBy: AntiAffinityIndex = {}
): string[] {
  const { eligible } = filterNodes(
    { ...service, imagePlatforms: [] },
    nodes,
    placements,
    antiAffinityBy
  )
  if (Array.isArray(service.platforms)) return [...new Set(service.platforms)]
  return [...new Set(eligible.map(nodePlatform))].filter(Boolean).sort()
}

export type Builder = {
  id: string
  platform: string | null
  canBuild: boolean
  connected: boolean
  active: number
  maxConcurrentBuilds: number
  freeCpu: number
  freeMemBytes: number
  buildDiskBytes?: number
  buildDiskReserveBytes?: number
  buildCacheFreeBytes: number
  load: number
  reliabilityScore: number
}
export function selectBuilder(
  pool: Builder[],
  platform: string,
  sticky: string | null,
  allowQemu = false
): Builder | undefined {
  const capable = pool.filter(
    (n) =>
      n.canBuild &&
      n.connected &&
      n.active < n.maxConcurrentBuilds &&
      (n.freeCpu >= 0.5 || (n.freeCpu > 0 && n.active === 0)) &&
      n.freeMemBytes >= 1073741824 &&
      n.buildCacheFreeBytes - (n.buildDiskReserveBytes ?? 0) >=
        (n.buildDiskBytes ?? 20 * 1073741824) * (n.active + 1)
  )
  const native = capable.filter((n) => n.platform === platform)
  const eligible = native.length
    ? native
    : allowQemu
      ? capable.filter((n) => n.platform === 'linux/amd64')
      : []
  return eligible.sort(
    (a, b) =>
      Number(b.id === sticky) - Number(a.id === sticky) ||
      b.freeCpu - a.freeCpu ||
      b.buildCacheFreeBytes - a.buildCacheFreeBytes ||
      a.load - b.load ||
      b.reliabilityScore - a.reliabilityScore ||
      a.id.localeCompare(b.id)
  )[0]
}

/** Each concurrent build gets a share, with headroom for the engine and services. */
export function buildMemoryLimit(freeBytes: number): number {
  if (!Number.isFinite(freeBytes) || freeBytes < 1073741824) throw new Error('Builder needs at least 1 GiB of uncommitted memory per build slot')
  return Math.floor(freeBytes * 0.75)
}
