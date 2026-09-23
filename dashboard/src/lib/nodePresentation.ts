import type { Node } from './api'

/** The agent samples host memory; Docker Desktop reports a separate VM limit. */
export function memoryUse(node: Node): { usedMb: number; totalMb: number; ratio: number } | null {
  if (!node.live || node.engineKind === 'docker-desktop' || !node.telemetry) return null
  const usedMb = node.telemetry.ramUsedMb
  const totalMb = node.ramMb
  if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb) || totalMb <= 0 || usedMb < 0 || usedMb > totalMb) return null
  return { usedMb, totalMb, ratio: usedMb / totalMb }
}

export function diskUse(node: Node): { usedMb: number; totalMb: number; ratio: number } | null {
  if (!node.live || !node.telemetry) return null
  const usedMb = node.telemetry.diskUsedMb
  const totalMb = node.telemetry.diskTotalMb ?? usedMb + node.diskMb
  if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb) || totalMb <= 0 || usedMb < 0 || usedMb > totalMb) return null
  return { usedMb, totalMb, ratio: usedMb / totalMb }
}

export function dockerState(node: Node): 'ready' | 'unavailable' | 'unknown' {
  if (!node.live || !node.telemetry?.runtime) return 'unknown'
  return node.telemetry.runtime.dockerAvailable ? 'ready' : 'unavailable'
}

export function nodePlatformLabel(node: Node): string {
  const platform = node.platform ?? `${node.os}/${node.arch}`
  return node.engineKind === 'docker-desktop' ? `Docker Desktop · ${platform}` : platform
}
