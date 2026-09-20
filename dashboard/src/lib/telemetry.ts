import type { Node, Service } from './api'

/** Agent cpuPct is normalized one-minute load (0–100), not CPU utilization. */
export function loadRatio(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) || value < 0 || value > 100 ? null : value / 100
}
export function freshTelemetry(node: Node, maxAgeMs: number) {
  const sample = node.telemetry
  return node.live && sample && Number.isFinite(sample.ageMs) && sample.ageMs >= 0 && sample.ageMs <= maxAgeMs ? sample : null
}
export function serviceCounts(services: Service[]) {
  const running = services.filter(s => ['running', 'online'].includes(s.current?.status ?? ''))
  const deploying = services.filter(s => s.current?.status === 'deploying')
  const attention = services.filter(s => !running.includes(s) && !deploying.includes(s))
  return { running, deploying, attention }
}
