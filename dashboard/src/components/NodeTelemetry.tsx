import { Link } from 'react-router-dom'
import type { Node } from '../lib/api'
import { mb, since } from '../lib/format'
import { diskUse, dockerState, memoryUse } from '../lib/nodePresentation'

function Meter({ label, value, ratio, note }: { label: string; value: string; ratio: number | null; note?: string }) {
  const tone = ratio !== null && ratio >= 0.9 ? 'var(--color-down)' : ratio !== null && ratio >= 0.8 ? 'var(--color-warn)' : 'var(--color-signal)'
  return <div className="min-w-0 rounded border border-[var(--color-line)] bg-[var(--color-ink-900)] px-3 py-2.5">
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-fg-dim)]">{label}</span>
      <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-[var(--color-fg)]">{value}</span>
    </div>
    {ratio !== null ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-line-2)]" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, ratio * 100)}%`, background: tone }} />
    </div> : <div className="mt-2 h-1.5 rounded-full bg-[var(--color-line-2)]" />}
    {note && <p className="mt-1.5 text-[10px] text-[var(--color-fg-dim)]">{note}</p>}
  </div>
}

export default function NodeTelemetry({ node }: { node: Node }) {
  if (!node.live || !node.telemetry) return <div className="mt-4 rounded border border-[var(--color-line)] bg-[var(--color-ink-900)] px-3 py-3 text-[11px] text-[var(--color-fg-muted)]">Live metrics unavailable · last heartbeat {since(node.lastHeartbeatAt)}</div>

  const cpu = node.telemetry.cpuPct
  const cpuRatio = Number.isFinite(cpu) && cpu >= 0 && cpu <= 100 ? cpu / 100 : null
  const memory = memoryUse(node)
  const disk = diskUse(node)
  const desktop = node.engineKind === 'docker-desktop'

  return <div className="relative z-10 mt-4">
    <div className="grid gap-2 sm:grid-cols-3">
      <Meter label="Host load" value={cpuRatio === null ? 'Unavailable' : `${Math.round(cpu)}%`} ratio={cpuRatio} />
      <Meter
        label={desktop ? 'Docker RAM limit' : 'RAM'}
        value={memory ? `${mb(memory.usedMb)} / ${mb(memory.totalMb)}` : desktop ? mb(node.ramMb) : 'Unavailable'}
        ratio={memory?.ratio ?? null}
        note={desktop ? dockerState(node) === 'ready' ? 'Host usage is not comparable' : 'Last reported limit · usage unavailable' : undefined}
      />
      <Meter label="Host disk" value={disk ? `${mb(disk.usedMb)} / ${mb(disk.totalMb)}` : 'Unavailable'} ratio={disk?.ratio ?? null} />
    </div>
    <Link to={`/nodes/${node.id}`} className="mt-2 inline-block font-mono text-[10.5px] text-[var(--color-fg-muted)] hover:text-[var(--color-signal)]">View history and detailed metrics →</Link>
  </div>
}
