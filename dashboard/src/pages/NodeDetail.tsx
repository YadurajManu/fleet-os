import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, type Node } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, since } from '../lib/format'
import { Dot, ErrorNote, Panel, StatusPill } from '../components/ui'
import TimeSeriesChart, { type ChartSeries, type Marker } from '../components/TimeSeriesChart'
import { HeartbeatStrip, projectFull } from '../components/viz'
import { beatsFrom, dockerBeatsFrom, type NodeSample } from '../lib/useSamples'
import WebTerminal from '../components/WebTerminal'

/**
 * Everything known about one machine.
 *
 * One range control drives every chart. Comparing CPU over six hours against
 * memory over one is a way to reach a confident wrong conclusion, so the
 * selector is deliberately not per-chart — and it lives in the URL, because
 * /nodes/:id?range=24h is a link worth sending someone mid-incident.
 */

const RANGES = [
  { key: '1h', label: '1h', minutes: 60 },
  { key: '2h', label: '2h', minutes: 120 },
  { key: '6h', label: '6h', minutes: 360 },
  { key: '12h', label: '12h', minutes: 720 },
  { key: '24h', label: '24h', minutes: 1440 },
  { key: '7d', label: '7d', minutes: 10080 },
  { key: '30d', label: '30d', minutes: 43200 },
] as const

type Peaks = {
  cpuMax: number | null; cpuAvg: number | null
  ramMaxMb: number | null; ramAvgMb: number | null
  netRxMax: number | null; netTxMax: number | null
  tempMax: number | null; load1Max: number | null
  samples: number; coverage: number | null
}
type SamplesResponse = { grain: string; sinceMinutes: number; peaks: Peaks; samples: NodeSample[] }
type NodeEvent = { at: string; kind: string; label: string; tone: 'info' | 'warn' | 'down' }

const SERIES = { cpu: '#3987e5', ram: '#9a6bd8', disk: '#12a594', netRx: '#d6409f', netTx: '#a16207' }

const toneColour = (tone: string) =>
  tone === 'down' ? 'var(--color-down)' : tone === 'warn' ? 'var(--color-warn)' : 'var(--color-fg-muted)'

// ─── Mini Sparkline for Metric Tiles ──────────────────────────────────────────

function MiniSparkline({ data, colour = '#3987e5' }: { data: number[]; colour?: string }) {
  if (!data || data.length < 2) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const width = 76
  const height = 26
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - ((v - min) / range) * (height - 6) - 3
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const pathD = `M ${pts.join(' L ')}`
  const areaD = `M 0,${height} L ${pts.join(' L ')} L ${width},${height} Z`
  const gradId = `spark-${colour.replace(/[^a-zA-Z0-9]/g, '')}`

  return (
    <svg width={width} height={height} className="overflow-visible shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity="0.25" />
          <stop offset="100%" stopColor={colour} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gradId})`} />
      <path d={pathD} fill="none" stroke={colour} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Tile({
  label,
  value,
  sub,
  tone,
  sparkline,
  sparkColor,
}: {
  label: string
  value: string
  sub?: string
  tone?: string
  sparkline?: number[]
  sparkColor?: string
}) {
  return (
    <div className="bg-[var(--color-ink-950)] p-4 flex items-center justify-between gap-2 group hover:bg-white/[0.02] transition-colors">
      <div className="min-w-0">
        <div className="mono-label text-[9px] text-[var(--color-fg-dim)]">{label}</div>
        <div
          className="mt-1.5 text-[19px] font-semibold tabular-nums tracking-[-0.02em]"
          style={{ color: tone ?? 'var(--color-fg)' }}
        >
          {value}
        </div>
        {sub && <div className="mt-0.5 font-mono text-[10.5px] text-[var(--color-fg-muted)] truncate">{sub}</div>}
      </div>
      {sparkline && sparkline.length >= 2 && (
        <MiniSparkline data={sparkline} colour={sparkColor ?? '#3987e5'} />
      )}
    </div>
  )
}

// ─── Circular SVG Resource Gauge ──────────────────────────────────────────────

function CircularGauge({
  label,
  pct,
  valueText,
  subText,
  colour = '#3fe08b',
  size = 112,
}: {
  label: string
  pct: number
  valueText: string
  subText?: string
  colour?: string
  size?: number
}) {
  const strokeWidth = 7
  const radius = (size - strokeWidth) / 2
  const circ = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, pct))
  const strokeDashoffset = circ - (clamped / 100) * circ

  return (
    <div className="flex flex-col items-center justify-center p-4 bg-[var(--color-ink-950)] border border-[var(--color-line)] rounded-lg relative overflow-hidden group hover:border-white/[0.12] transition-all">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="rotate-[-90deg]">
          {/* Background track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke="rgba(255, 255, 255, 0.06)"
            strokeWidth={strokeWidth}
          />
          {/* Active progress */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke={colour}
            strokeWidth={strokeWidth}
            strokeDasharray={circ}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            className="transition-all duration-700 ease-out"
            style={{
              filter: `drop-shadow(0 0 6px ${colour}40)`,
            }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="font-mono text-[17px] font-bold tracking-tight text-white/95 tabular-nums">
            {valueText}
          </span>
          <span className="font-mono text-[9px] uppercase tracking-wider text-white/40 mt-0.5">
            {label}
          </span>
        </div>
      </div>
      {subText && (
        <span className="mt-2.5 font-mono text-[11px] text-[var(--color-fg-muted)] text-center truncate max-w-full">
          {subText}
        </span>
      )}
    </div>
  )
}

/** One chart's identity, so the expanded view can cycle between them. */
type ChartDef = {
  key: string
  title: string
  note?: ReactNode
  series: ChartSeries[]
  ceiling?: number
  unit?: string
  format?: (v: number) => string
  emptyHint?: string
}

export default function NodeDetail() {
  const { nodeId } = useParams<{ nodeId: string }>()
  const { fleet } = useAuth()
  const [params, setParams] = useSearchParams()

  const rangeKey = params.get('range') ?? '6h'
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[2]

  /* Shared across every chart on the page. */
  const [hoverT, setHoverT] = useState<number | null>(null)
  const [zoom, setZoom] = useState<{ from: number; to: number } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showTerminal, setShowTerminal] = useState(false)
  const [copiedId, setCopiedId] = useState(false)

  // Reset zoom on range change
  useEffect(() => setZoom(null), [range.key])

  const nodes = usePoll(
    () => api<{ nodes: Node[] }>(`/fleets/${fleet!.id}/nodes`),
    fleet?.id ? `/fleets/${fleet.id}/nodes` : null,
    10_000
  )
  const node = nodes.data?.nodes.find((n) => n.id === nodeId)

  const hist = usePoll(
    () => api<SamplesResponse>(`/fleets/${fleet!.id}/nodes/${nodeId}/samples?since=${range.minutes}`),
    fleet?.id && nodeId ? `/fleets/${fleet.id}/nodes/${nodeId}/samples?since=${range.minutes}` : null,
    60_000
  )

  const evts = usePoll(
    () => api<{ events: NodeEvent[] }>(`/fleets/${fleet!.id}/nodes/${nodeId}/events?since=${range.minutes}`),
    fleet?.id && nodeId ? `/fleets/${fleet.id}/nodes/${nodeId}/events?since=${range.minutes}` : null,
    60_000
  )

  const allSamples = hist.data?.samples ?? []
  const t = node?.telemetry

  const samples = useMemo(() => {
    if (!zoom) return allSamples
    return allSamples.filter((s) => {
      const ts = +new Date(s.at)
      return ts >= zoom.from && ts <= zoom.to
    })
  }, [allSamples, zoom])

  const peaks: Peaks | undefined = useMemo(() => {
    if (!zoom) return hist.data?.peaks
    const num = (pick: (s: NodeSample) => number | null | undefined) =>
      samples.map(pick).filter((v): v is number => v != null)
    const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null)
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
    const cpu = num((s) => s.cpuPct)
    const ram = num((s) => s.ramUsedMb)
    return {
      cpuMax: max(num((s) => s.cpuMax ?? s.cpuPct)), cpuAvg: avg(cpu),
      ramMaxMb: max(num((s) => s.ramMaxMb ?? s.ramUsedMb)), ramAvgMb: avg(ram),
      netRxMax: max(num((s) => s.netRxKbps)), netTxMax: max(num((s) => s.netTxKbps)),
      tempMax: max(num((s) => s.tempC)), load1Max: max(num((s) => s.load1)),
      samples: samples.length, coverage: null,
    }
  }, [zoom, hist.data, samples])

  const events = evts.data?.events ?? []
  const markers: Marker[] = useMemo(
    () => events.map((e) => ({ at: +new Date(e.at), label: e.label, tone: e.tone })),
    [events]
  )

  const pt = useCallback(
    (pick: (s: NodeSample) => number | null | undefined) =>
      samples.map((s) => ({ t: +new Date(s.at), v: pick(s) ?? null })),
    [samples]
  )

  const diskTotal =
    t?.diskTotalMb ?? (t?.diskUsedMb != null && node?.diskMb ? t.diskUsedMb + node.diskMb : 0)

  const projection = useMemo(() => {
    const d = samples.filter((s) => s.diskUsedMb != null).map((s) => ({ t: +new Date(s.at), used: s.diskUsedMb! }))
    return diskTotal ? projectFull(d, diskTotal) : null
  }, [samples, diskTotal])

  const beatWindowMs = zoom ? Math.max(zoom.to - zoom.from, 60_000) : range.minutes * 60_000
  const beats = useMemo(() => beatsFrom(samples, 60, beatWindowMs), [samples, beatWindowMs])
  const recorded = beats.filter((b) => b !== 'nodata')
  const dockerBeats = useMemo(() => dockerBeatsFrom(samples, 60, beatWindowMs), [samples, beatWindowMs])
  const dockerRecorded = dockerBeats.filter((b) => b !== 'nodata')
  const uptime = recorded.length ? (recorded.filter((b) => b === 'ok').length / recorded.length) * 100 : null

  const hasNet = samples.some((s) => s.netRxKbps != null || s.netTxKbps != null)
  const hasTemp = samples.some((s) => s.tempC != null)
  const hasLoad = samples.some((s) => s.load1 != null)
  const hasDisk = samples.some((s) => s.diskUsedMb != null)
  const hasSwap = samples.some((s) => s.swapUsedMb != null)
  const hasContainers = samples.some((s) => s.containers != null)
  const hasDocker = samples.some((s) => s.dockerOk != null)

  const missing = [
    !hasNet && 'network',
    !hasSwap && 'swap',
    !hasTemp && 'temperature',
    !hasLoad && 'load',
  ].filter(Boolean) as string[]

  const diskCeiling = samples.reduce((m, s) => Math.max(m, s.diskTotalMb ?? 0), 0) || diskTotal

  // Sparkline data extracts from recent samples (up to 30 points)
  const recentSlice = useMemo(() => samples.slice(-30), [samples])
  const cpuSparkData = useMemo(() => recentSlice.map((s) => s.cpuPct ?? 0), [recentSlice])
  const ramSparkData = useMemo(() => recentSlice.map((s) => s.ramUsedMb ?? 0), [recentSlice])
  const diskSparkData = useMemo(() => recentSlice.map((s) => s.diskUsedMb ?? 0), [recentSlice])
  const uptimeSparkData = useMemo(
    () => recorded.slice(-30).map((b) => (b === 'ok' ? 100 : b === 'slow' ? 50 : 0)),
    [recorded]
  )

  const charts: ChartDef[] = useMemo(() => {
    if (!node) return []
    const list: ChartDef[] = [
      {
        key: 'cpu',
        title: 'cpu',
        note: 'band is min to max, line is the mean',
        ceiling: 100,
        format: (v) => `${Math.round(v)}%`,
        emptyHint: 'No CPU history in this window yet. It fills in as the node reports.',
        series: [{
          label: 'cpu', colour: SERIES.cpu,
          avg: pt((s) => s.cpuPct),
          min: pt((s) => s.cpuMin ?? s.cpuPct),
          max: pt((s) => s.cpuMax ?? s.cpuPct),
        }],
      },
      {
        key: 'memory',
        title: 'memory',
        ceiling: node.ramMb,
        format: (v) => mb(v),
        emptyHint: 'No memory history in this window yet.',
        series: [{
          label: 'memory', colour: SERIES.ram,
          avg: pt((s) => s.ramUsedMb),
          min: pt((s) => s.ramUsedMb),
          max: pt((s) => s.ramMaxMb ?? s.ramUsedMb),
        }],
      },
    ]
    if (hasNet) {
      list.push({
        key: 'network',
        title: 'network',
        unit: ' kB/s',
        format: (v) => (v >= 1024 ? `${(v / 1024).toFixed(1)}M` : String(Math.round(v))),
        series: [
          { label: 'in', colour: SERIES.netRx, avg: pt((s) => s.netRxKbps) },
          { label: 'out', colour: SERIES.netTx, avg: pt((s) => s.netTxKbps) },
        ],
      })
    }
    if (hasDisk) {
      list.push({
        key: 'disk',
        title: 'disk',
        ceiling: diskCeiling || undefined,
        format: (v) => mb(v),
        emptyHint: 'No disk history in this window yet.',
        series: [{ label: 'used', colour: SERIES.disk, avg: pt((s) => s.diskUsedMb) }],
      })
    }
    if (hasSwap) {
      list.push({
        key: 'swap',
        title: 'swap',
        note: 'rising swap is the warning before memory runs out',
        format: (v) => mb(v),
        series: [{ label: 'swap', colour: SERIES.netTx, avg: pt((s) => s.swapUsedMb) }],
      })
    }
    if (hasLoad || hasTemp) {
      list.push({
        key: 'load',
        title: 'load and temperature',
        format: (v) => v.toFixed(1),
        series: [
          ...(hasLoad ? [{ label: 'load', colour: SERIES.disk, avg: pt((s) => s.load1) }] : []),
          ...(hasTemp ? [{ label: '°C', colour: SERIES.netTx, avg: pt((s) => s.tempC) }] : []),
        ],
      })
    }
    if (hasContainers) {
      list.push({
        key: 'containers',
        title: 'containers',
        format: (v) => String(Math.round(v)),
        emptyHint: 'No container history in this window yet.',
        series: [{ label: 'running', colour: SERIES.ram, avg: pt((s) => s.containers) }],
      })
    }
    return list
  }, [node, pt, hasNet, hasLoad, hasTemp, hasDisk, hasSwap, hasContainers, diskCeiling])

  const expandedIndex = charts.findIndex((c) => c.key === expanded)
  const step = useCallback(
    (delta: number) => {
      if (!charts.length || expandedIndex < 0) return
      const next = (expandedIndex + delta + charts.length) % charts.length
      setExpanded(charts[next]!.key)
    },
    [charts, expandedIndex]
  )

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(null)
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [expanded, step])

  if (nodes.error) return <ErrorNote error={nodes.error} />
  if (!node) {
    return (
      <div className="space-y-4">
        <Link to="/nodes" className="font-mono text-[11.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
          ← nodes
        </Link>
        <p className="font-mono text-[12px] text-[var(--color-fg-dim)]">
          {nodes.data ? 'That node is not in this fleet.' : 'Loading…'}
        </p>
      </div>
    )
  }

  const staleWarning = !zoom && peaks && peaks.coverage != null && peaks.coverage < 0.5 && peaks.samples > 0

  const shared = {
    hoverT,
    onHoverT: setHoverT,
    onZoom: (from: number, to: number) => setZoom({ from, to }),
    markers,
  }

  const windowLabel = zoom
    ? `${new Date(zoom.from).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${new Date(zoom.to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : range.label

  const handleCopyNodeId = async () => {
    await navigator.clipboard.writeText(node.id)
    setCopiedId(true)
    setTimeout(() => setCopiedId(false), 2000)
  }

  // Live real-time gauge values
  const liveCpu = t?.cpuPct ?? (peaks?.cpuAvg != null ? Math.round(peaks.cpuAvg) : 0)
  const liveRamMb = t?.ramUsedMb ?? peaks?.ramAvgMb ?? 0
  const liveRamPct = node.ramMb ? Math.round((liveRamMb / node.ramMb) * 100) : 0
  const liveDiskMb = t?.diskUsedMb ?? 0
  const liveDiskPct = diskTotal ? Math.round((liveDiskMb / diskTotal) * 100) : 0

  const cpuColor = liveCpu > 85 ? '#f87171' : liveCpu > 70 ? '#fbbf24' : '#3fe08b'
  const ramColor = liveRamPct > 85 ? '#f87171' : liveRamPct > 70 ? '#fbbf24' : '#9a6bd8'
  const diskColor = liveDiskPct > 90 ? '#f87171' : liveDiskPct > 75 ? '#fbbf24' : '#12a594'

  return (
    <div className="space-y-6">
      {/* ─── Header & Primary Action Bar ─── */}
      <div>
        <Link to="/nodes" className="font-mono text-[11.5px] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)]">
          ← nodes
        </Link>
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-y-3 gap-x-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-[26px] font-semibold tracking-[-0.03em]">{node.name}</h1>
            <StatusPill status={node.status} />
            <span className="font-mono text-[11.5px] text-[var(--color-fg-dim)]">
              {node.os} ({node.arch}) · {node.cpuCores} cores · {mb(node.ramMb)} RAM
            </span>
          </div>

          {/* Action Buttons & Status */}
          <div className="flex items-center gap-2.5 ml-auto sm:ml-0">
            {/* Direct Launch Terminal Button */}
            <button
              onClick={() => setShowTerminal(true)}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-[#3fe08b]/10 hover:bg-[#3fe08b]/20 border border-[#3fe08b]/30 hover:border-[#3fe08b]/60 text-[#3fe08b] font-mono text-[12px] font-semibold transition-all shadow-[0_0_20px_rgba(63,224,139,0.15)] group"
              title="Open interactive remote web terminal"
            >
              <svg className="w-3.5 h-3.5 transition-transform group-hover:scale-110" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <span>Terminal</span>
              <span className="px-1 py-0.2 text-[9px] rounded bg-[#3fe08b]/20 text-[#3fe08b] border border-[#3fe08b]/30">
                &gt;_
              </span>
            </button>

            {/* Copy Node ID */}
            <button
              onClick={handleCopyNodeId}
              className="p-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.08] text-white/60 hover:text-white transition-colors relative"
              title="Copy Node UUID"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
              </svg>
              {copiedId && (
                <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-[#3fe08b] text-[#07080a] text-[10px] font-mono font-bold shadow-lg">
                  Copied!
                </span>
              )}
            </button>

            {/* Heartbeat status */}
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-fg-dim)] pl-2 border-l border-white/[0.08]">
              <Dot tone={node.status === 'online' ? 'ok' : 'down'} size={6} />
              {since(node.lastHeartbeatAt)}
            </span>
          </div>
        </div>
      </div>

      {/* ─── Real-Time Live Resource Gauges ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <CircularGauge
          label="CPU Load"
          pct={liveCpu}
          valueText={`${liveCpu}%`}
          subText={t?.load1 != null ? `1m load: ${t.load1.toFixed(2)}` : `${node.cpuCores} cores online`}
          colour={cpuColor}
        />
        <CircularGauge
          label="RAM Usage"
          pct={liveRamPct}
          valueText={`${liveRamPct}%`}
          subText={`${mb(liveRamMb)} of ${mb(node.ramMb)}`}
          colour={ramColor}
        />
        <CircularGauge
          label="Storage"
          pct={liveDiskPct}
          valueText={`${liveDiskPct}%`}
          subText={projection ? `full in ${Math.round(projection.days)}d` : `${mb(liveDiskMb)} used`}
          colour={diskColor}
        />
        <div className="flex flex-col justify-between p-4 bg-[var(--color-ink-950)] border border-[var(--color-line)] rounded-lg hover:border-white/[0.12] transition-colors">
          <div className="flex items-center justify-between">
            <span className="mono-label text-[9px] text-[var(--color-fg-dim)]">SYSTEM SPECS</span>
            <span className="w-2 h-2 rounded-full" style={{ background: node.status === 'online' ? '#3fe08b' : '#f87171' }} />
          </div>
          <div className="space-y-1.5 my-2">
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-white/40">Agent</span>
              <span className="text-white/80">{node.agentVersion ? `v${node.agentVersion}` : 'latest'}</span>
            </div>
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-white/40">Arch</span>
              <span className="text-white/80">{node.arch} ({node.os})</span>
            </div>
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-white/40">Containers</span>
              <span className="text-white/80">{t?.containers != null ? `${t.containers} running` : '—'}</span>
            </div>
          </div>
          <div className="font-mono text-[10px] text-white/30 truncate" title={node.id}>
            ID: {node.id.slice(0, 18)}…
          </div>
        </div>
      </div>

      {/* ─── Range Selector ─── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono-label text-[9px] text-[var(--color-fg-dim)]">RANGE</span>
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setParams({ range: r.key }, { replace: true })}
            aria-pressed={r.key === range.key}
            className={`px-2.5 py-1 font-mono text-[11px] rounded transition-colors duration-200 ${
              r.key === range.key
                ? 'bg-[var(--color-signal)] text-[#04140c] font-semibold'
                : 'border border-[var(--color-line-2)] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
            }`}
          >
            {r.label}
          </button>
        ))}
        {zoom && (
          <button
            onClick={() => setZoom(null)}
            className="flash-signal flex items-center gap-1.5 border border-[var(--color-signal)] px-2.5 py-1 font-mono text-[11px] text-[var(--color-signal)] rounded transition-colors hover:bg-[var(--color-signal)] hover:text-[#04140c]"
          >
            ✕ zoomed {windowLabel} · back to {range.label}
          </button>
        )}
        {hist.data && (
          <span className="ml-auto font-mono text-[10px] text-[var(--color-fg-dim)]">
            {hist.data.grain} grain · {samples.length} points
            {charts.length > 0 && <span className="ml-2 opacity-70">drag to zoom</span>}
          </span>
        )}
      </div>

      {/* ─── Change Events Timeline ─── */}
      {events.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <span className="mono-label shrink-0 text-[9px] text-[var(--color-fg-dim)]">CHANGES</span>
          {events.slice(0, 12).map((e, i) => (
            <button
              key={i}
              onMouseEnter={() => setHoverT(+new Date(e.at))}
              onMouseLeave={() => setHoverT(null)}
              title={new Date(e.at).toLocaleString()}
              className="shrink-0 border-l-2 bg-[var(--color-ink-950)] py-1 pl-2 pr-3 text-left rounded-r transition-colors hover:bg-[var(--color-ink-900)]"
              style={{ borderColor: toneColour(e.tone) }}
            >
              <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">
                {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="ml-2 font-mono text-[11px]" style={{ color: toneColour(e.tone) }}>
                {e.label}
              </span>
            </button>
          ))}
        </div>
      )}

      {staleWarning && (
        <p className="border-l-2 border-[var(--color-warn)] py-2 pl-3 font-mono text-[11px] text-[var(--color-fg-muted)]">
          Only {Math.round((peaks!.coverage ?? 0) * 100)}% of this window has data — the node was
          not reporting for most of it, so these figures describe part of the period, not all of it.
        </p>
      )}

      {/* ─── Summary Tiles with Embedded Mini-Sparklines ─── */}
      <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-2 lg:grid-cols-4 rounded-lg overflow-hidden border border-[var(--color-line)]">
        <Tile
          label={`cpu peak · ${windowLabel}`}
          value={peaks?.cpuMax != null ? `${Math.round(peaks.cpuMax)}%` : '—'}
          sub={peaks?.cpuAvg != null ? `avg ${Math.round(peaks.cpuAvg)}%` : undefined}
          tone={peaks?.cpuMax != null && peaks.cpuMax > 85 ? 'var(--color-warn)' : undefined}
          sparkline={cpuSparkData}
          sparkColor={SERIES.cpu}
        />
        <Tile
          label={`memory peak · ${windowLabel}`}
          value={peaks?.ramMaxMb != null ? mb(peaks.ramMaxMb) : '—'}
          sub={`of ${mb(node.ramMb)}`}
          tone={peaks?.ramMaxMb != null && peaks.ramMaxMb / node.ramMb > 0.9 ? 'var(--color-warn)' : undefined}
          sparkline={ramSparkData}
          sparkColor={SERIES.ram}
        />
        <Tile
          label="disk"
          value={t?.diskUsedMb != null ? mb(t.diskUsedMb) : '—'}
          sub={projection ? `full in ${Math.round(projection.days)} days` : diskTotal ? `of ${mb(diskTotal)}` : undefined}
          tone={projection && projection.days < 14 ? 'var(--color-warn)' : undefined}
          sparkline={diskSparkData}
          sparkColor={SERIES.disk}
        />
        <Tile
          label={`uptime · ${windowLabel}`}
          value={uptime != null ? `${uptime.toFixed(1)}%` : '—'}
          sub={recorded.length ? `${recorded.filter((b) => b === 'missed').length} gaps` : 'no history yet'}
          tone={uptime != null && uptime < 99 ? 'var(--color-warn)' : undefined}
          sparkline={uptimeSparkData}
          sparkColor="#3fe08b"
        />
      </div>

      {/* ─── Metric Time Series Charts ─── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {charts.map((c) => (
          <Panel
            key={c.key}
            title={`${c.title} · ${windowLabel}`}
            right={c.note ? <span className="normal-case">{c.note}</span> : undefined}
          >
            <div className="p-4">
              <TimeSeriesChart
                {...shared}
                height={170}
                series={c.series}
                ceiling={c.ceiling}
                unit={c.unit}
                format={c.format}
                emptyHint={c.emptyHint}
                onExpand={() => setExpanded(c.key)}
                expandLabel={`Expand ${c.title}`}
              />
            </div>
          </Panel>
        ))}
      </div>

      {missing.length > 0 && (
        <p className="border-l-2 border-[var(--color-line-2)] py-2 pl-3 font-mono text-[11px] leading-relaxed text-[var(--color-fg-dim)]">
          This node runs agent {node.agentVersion ? `v${node.agentVersion}` : 'an older build'}, which
          does not report {missing.join(', ')}. Re-run the installer with{' '}
          <span className="text-[var(--color-fg-muted)]">--reset</span> to start collecting{' '}
          {missing.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      {/* ─── Reporting History ─── */}
      <Panel title={`reporting · ${windowLabel}`}>
        <div className="space-y-2.5 p-4">
          <div className="flex items-center gap-3">
            <span className="mono-label w-[68px] shrink-0 text-[9px] text-[var(--color-fg-dim)]">
              HEARTBEAT
            </span>
            <HeartbeatStrip beats={beats} height={20} />
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--color-fg-dim)]">
              {recorded.length ? `${recorded.filter((b) => b === 'ok').length}/${recorded.length}` : 'no history'}
            </span>
          </div>

          {hasDocker && (
            <div className="flex items-center gap-3">
              <span className="mono-label w-[68px] shrink-0 text-[9px] text-[var(--color-fg-dim)]">
                DOCKER
              </span>
              <HeartbeatStrip beats={dockerBeats} height={20} label="Docker daemon reachability" />
              <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--color-fg-dim)]">
                {dockerRecorded.length
                  ? `${dockerRecorded.filter((b) => b === 'ok').length}/${dockerRecorded.length}`
                  : 'no history'}
              </span>
            </div>
          )}
        </div>
      </Panel>

      {/* ─── Expanded Chart Modal ─── */}
      {expanded && (
        <ExpandedModal
          chart={charts[expandedIndex]!}
          index={expandedIndex}
          total={charts.length}
          windowLabel={windowLabel}
          shared={shared}
          onStep={step}
          onClose={() => setExpanded(null)}
        />
      )}

      {/* ─── Interactive In-Browser Web Terminal Drawer ─── */}
      {showTerminal && fleet && (
        <WebTerminal
          nodeId={node.id}
          nodeName={node.name}
          fleetId={fleet.id}
          onClose={() => setShowTerminal(false)}
        />
      )}
    </div>
  )
}

function ExpandedModal({
  chart,
  index,
  total,
  windowLabel,
  shared,
  onStep,
  onClose,
}: {
  chart: ChartDef
  index: number
  total: number
  windowLabel: string
  shared: {
    hoverT: number | null
    onHoverT: (t: number | null) => void
    onZoom: (from: number, to: number) => void
    markers: Marker[]
  }
  onStep: (delta: number) => void
  onClose: () => void
}) {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      style={{ animation: 'fade-in 0.18s var(--ease-out-expo) both' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[1200px] border border-[var(--color-line-2)] bg-[var(--color-ink-950)] shadow-2xl rounded-lg overflow-hidden"
        style={{ animation: 'rise-in 0.28s var(--ease-out-expo) both' }}
      >
        <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-5 py-3">
          <h2 className="mono-label text-[11px] text-[var(--color-fg)]">
            {chart.title} · {windowLabel}
          </h2>
          {chart.note && (
            <span className="hidden font-mono text-[10.5px] text-[var(--color-fg-dim)] sm:inline">
              {chart.note}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => onStep(-1)}
              aria-label="Previous metric"
              className="flex h-7 w-7 items-center justify-center border border-[var(--color-line-2)] rounded font-mono text-[12px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]"
            >
              ←
            </button>
            <span className="px-1 font-mono text-[10.5px] tabular-nums text-[var(--color-fg-dim)]">
              {index + 1}/{total}
            </span>
            <button
              onClick={() => onStep(1)}
              aria-label="Next metric"
              className="flex h-7 w-7 items-center justify-center border border-[var(--color-line-2)] rounded font-mono text-[12px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]"
            >
              →
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="ml-2 flex h-7 w-7 items-center justify-center border border-[var(--color-line-2)] rounded font-mono text-[12px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-down)] hover:text-[var(--color-down)]"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="p-5">
          <div key={chart.key} style={{ animation: 'fade-up 0.24s var(--ease-out-expo) both' }}>
            <TimeSeriesChart
              {...shared}
              height={Math.max(320, Math.round(window.innerHeight * 0.62))}
              series={chart.series}
              ceiling={chart.ceiling}
              unit={chart.unit}
              format={chart.format}
              emptyHint={chart.emptyHint}
            />
          </div>
        </div>

        <div className="border-t border-[var(--color-line)] px-5 py-2.5 font-mono text-[10px] text-[var(--color-fg-dim)]">
          drag to zoom · ← → to change metric · esc to close
        </div>
      </div>
    </div>
  )
}
