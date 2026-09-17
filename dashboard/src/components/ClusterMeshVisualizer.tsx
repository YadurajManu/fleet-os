import { useState, useMemo, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { type Node, type PlacementMapNode } from '../lib/api'
import { mb, pct, toneOf } from '../lib/format'
import { Dot, Meter, RingGauge } from './ui'

export interface ClusterMeshVisualizerProps {
  mapNodes: PlacementMapNode[]
  nodes: Node[]
  fleetName?: string
  className?: string
  onSelectNode?: (nodeId: string) => void
  onSelectService?: (serviceName: string) => void
}

/* ── Geometry helpers ────────────────────────────────────────── */

function layoutNodes(count: number, cx: number, cy: number, rx: number, ry: number) {
  if (count === 0) return []
  if (count === 1) return [{ x: cx + rx * 0.85, y: cy }]
  if (count === 2) {
    return [
      { x: cx - rx, y: cy },
      { x: cx + rx, y: cy },
    ]
  }
  if (count <= 4) {
    return Array.from({ length: count }, (_, i) => {
      const spread = Math.PI * 0.82
      const angle = Math.PI / 2 + spread / 2 - (spread * i) / (count - 1)
      return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) * 0.75 }
    })
  }
  return Array.from({ length: count }, (_, i) => {
    const angle = Math.PI + (2 * Math.PI * i) / count
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }
  })
}

function layoutServices(count: number, nx: number, ny: number, cx: number, cy: number) {
  if (count === 0) return []
  const away = Math.atan2(ny - cy, nx - cx)
  const ring = 40
  const spread = Math.min(Math.PI * 0.62, 0.34 * count)
  return Array.from({ length: count }, (_, i) => {
    const angle = count === 1 ? away : away - spread / 2 + (spread * i) / (count - 1)
    return { x: nx + ring * Math.cos(angle), y: ny + ring * Math.sin(angle) }
  })
}

function curvedPath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.sqrt(dx * dx + dy * dy)
  const bow = Math.min(len * 0.12, 28)
  const nx = -dy / len
  const ny = dx / len
  return `M ${x1} ${y1} Q ${mx + nx * bow} ${my + ny * bow} ${x2} ${y2}`
}

/* ── Tooltip ─────────────────────────────────────────────────── */

function Tooltip({ children, x, y, visible }: { children: ReactNode; x: number; y: number; visible: boolean }) {
  if (!visible) return null
  return (
    <div
      className="pointer-events-none absolute z-50 max-w-[260px] rounded-[4px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-4 py-3 font-mono text-[11px] shadow-2xl transition-opacity duration-150"
      style={{
        left: x,
        top: y,
        transform: 'translate(-50%, calc(-100% - 12px))',
        opacity: visible ? 1 : 0,
      }}
    >
      {children}
    </div>
  )
}

function Legend({ enriched }: { enriched: Array<{ status: string; tunnelConnected: boolean; services: Array<{ status: string }> }> }) {
  const items: Array<{ swatch: string; label: string }> = []
  const add = (swatch: string, label: string) => {
    if (!items.some((i) => i.label === label)) items.push({ swatch, label })
  }

  for (const node of enriched) {
    const tone = toneOf(node.status)
    if (tone === 'ok') add('var(--color-signal)', 'node online')
    else if (tone === 'down') add('var(--color-down)', 'node offline')
    else if (tone === 'warn') add('var(--color-warn)', 'draining / cordoned')
    if (node.tunnelConnected) add('var(--color-signal-dim)', 'tunnel connected')

    for (const svc of node.services) {
      const st = toneOf(svc.status)
      if (st === 'ok') add('var(--color-signal)', 'service running')
      else if (st === 'down') add('var(--color-down)', 'service down')
      else if (st === 'warn') add('var(--color-warn)', 'service deploying')
    }
  }

  if (!items.length) return null
  return (
    <div className="flex flex-wrap items-center gap-5 border-t border-[var(--color-line)] px-5 py-2.5 font-mono text-[9.5px] text-[var(--color-fg-dim)]">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: i.swatch }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

/* ── Node Card (shown below mesh for small fleets) ────────────── */

function NodeCard({
  node,
  onClick,
}: {
  node: {
    name: string
    arch: string
    status: string
    services: Array<{ name: string; status: string }>
    telemetry?: { cpuPct: number; ramUsedMb: number; containers?: unknown[] } | null
    ramMb: number
    tunnelConnected: boolean
  }
  onClick?: () => void
}) {
  const tone = toneOf(node.status)
  const svcCount = node.services.length
  const containerCount = node.telemetry?.containers?.length ?? svcCount

  const stripeColor =
    tone === 'ok'
      ? 'border-l-[var(--color-signal)]'
      : tone === 'warn'
      ? 'border-l-[var(--color-warn)]'
      : 'border-l-[var(--color-down)]'

  return (
    <button
      onClick={onClick}
      className={`stat-card group flex items-start gap-3 rounded border border-[var(--color-line)] border-l-4 ${stripeColor} bg-[var(--color-ink-950)] px-4 py-3.5 text-left transition-all hover:border-[var(--color-line-2)] hover:bg-[var(--color-ink-900)]`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Dot tone={tone as 'ok' | 'warn' | 'down'} size={7} />
            <span className="truncate font-mono text-[13px] font-semibold text-[var(--color-fg)] transition-colors group-hover:text-[var(--color-signal)]">
              {node.name}
            </span>
          </div>
          <span className="shrink-0 rounded border border-[var(--color-line)] bg-[var(--color-ink-850)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">
            {node.arch}
          </span>
        </div>

        <div className="mt-2 flex items-center gap-2.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
          <span>
            {svcCount} svc{svcCount === 1 ? '' : 's'}
          </span>
          <span>·</span>
          <span>
            {containerCount} container{containerCount === 1 ? '' : 's'}
          </span>
          <span>·</span>
          <span className={node.tunnelConnected ? 'font-medium text-[var(--color-signal)]' : 'text-[var(--color-fg-dim)]'}>
            {node.tunnelConnected ? '● tunnel ok' : '○ no tunnel'}
          </span>
        </div>

        {node.telemetry && (
          <div className="mt-3 flex items-center gap-5 border-t border-[var(--color-line)] pt-2.5">
            <RingGauge
              value={node.telemetry.cpuPct}
              max={1}
              size={40}
              strokeWidth={3.5}
              label="CPU"
              sublabel={pct(node.telemetry.cpuPct)}
            />
            <RingGauge
              value={node.telemetry.ramUsedMb}
              max={node.ramMb}
              size={40}
              strokeWidth={3.5}
              label="RAM"
              sublabel={mb(node.telemetry.ramUsedMb)}
            />
          </div>
        )}

        {svcCount > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {node.services.map((s) => (
              <span
                key={s.name}
                className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[9px] ${
                  s.status === 'pinned_unavailable'
                    ? 'border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_8%,transparent)] text-[var(--color-warn)]'
                    : 'border-[var(--color-line)] bg-[var(--color-ink-900)] text-[var(--color-fg-muted)]'
                }`}
              >
                <Dot tone={toneOf(s.status)} size={3} />
                {s.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  )
}

/* ── Main Component ──────────────────────────────────────────── */

export default function ClusterMeshVisualizer({
  mapNodes,
  nodes,
  fleetName = 'Fleet',
  className = '',
  onSelectNode,
  onSelectService,
}: ClusterMeshVisualizerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const [expanded, setExpanded] = useState(false)

  const [zoom, setZoom] = useState(1)

  const COLLAPSED_H = 450
  const EXPANDED_H = 680
  const targetH = expanded ? EXPANDED_H : COLLAPSED_H

  const [dims, setDims] = useState({ w: 800, h: COLLAPSED_H })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width } = entry.contentRect
      setDims({ w: width, h: targetH })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [targetH])

  const enriched = useMemo(() => {
    return mapNodes.map((mn) => {
      const liveNode = nodes.find((n) => n.id === mn.id)
      return {
        ...mn,
        telemetry: liveNode?.telemetry ?? null,
        os: liveNode?.os ?? '?',
        arch: mn.arch,
        agentVersion: liveNode?.agentVersion ?? null,
        live: liveNode?.live ?? false,
        tunnelConnected: liveNode?.tunnelConnected ?? false,
        meshConnected: liveNode?.telemetry?.meshConnected ?? false,
      }
    })
  }, [mapNodes, nodes])

  const cx = dims.w / 2
  const cy = dims.h / 2
  const rx = Math.min(dims.w * 0.38, 320)
  const ry = Math.min(dims.h * 0.38, 200)
  const positions = layoutNodes(enriched.length, cx, cy, rx, ry)

  const [focused, setFocused] = useState<string | null>(null)
  const active = hovered ?? focused

  const handleNodeHover = useCallback(
    (nodeId: string | null, e?: React.MouseEvent) => {
      setHovered(nodeId)
      if (e && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      }
    },
    []
  )

  const hoveredNode = enriched.find((n) => n.id === hovered)
  const onlineCount = enriched.filter((n) => n.status === 'online').length
  const totalContainers = enriched.reduce(
    (sum, n) => sum + (n.telemetry?.containers?.length ?? n.services.length),
    0
  )
  const showCards = enriched.length <= 6

  return (
    <div ref={containerRef} className={`relative overflow-hidden ${className}`}>
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-line)] bg-[var(--color-ink-950)]">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)] font-medium">
            Cluster Topology
          </span>
          <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">·</span>
          <span className="font-mono text-[11px] text-[var(--color-fg)] font-medium">{fleetName}</span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] text-[var(--color-fg-dim)]">
          <span className="flex items-center gap-1.5 text-[var(--color-signal)]">
            <Dot tone="ok" size={6} />
            {onlineCount} online
          </span>
          <span>{totalContainers} container{totalContainers === 1 ? '' : 's'}</span>

          {/* Zoom controls */}
          <div className="hidden sm:flex items-center gap-1 border-l border-[var(--color-line)] pl-3">
            <button
              onClick={() => setZoom((z) => Math.max(0.7, +(z - 0.15).toFixed(2)))}
              title="Zoom out"
              className="rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-2)]"
            >
              −
            </button>
            <span className="w-8 text-center text-[9px] tabular text-[var(--color-fg-dim)]">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(1.8, +(z + 0.15).toFixed(2)))}
              title="Zoom in"
              className="rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-2)]"
            >
              +
            </button>
            {zoom !== 1 && (
              <button
                onClick={() => setZoom(1)}
                title="Reset zoom"
                className="rounded border border-[var(--color-line)] px-1 py-0.5 text-[8.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
              >
                reset
              </button>
            )}
          </div>

          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-2 rounded border border-[var(--color-line)] px-2.5 py-1 text-[9px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-line-2)] hover:text-[var(--color-fg-muted)]"
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        </div>
      </div>

      {/* ── SVG Canvas ──────────────────────────────────────── */}
      <div className="relative grid-bg overflow-hidden" style={{ height: dims.h, background: 'var(--color-ink-950)' }}>
        <svg
          width={dims.w}
          height={dims.h}
          viewBox={`0 0 ${dims.w} ${dims.h}`}
          className="absolute inset-0"
          style={{ overflow: 'visible' }}
        >
          <defs>
            <linearGradient id="tunnel-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--color-signal)" stopOpacity="0.85" />
              <stop offset="50%" stopColor="#2dd4bf" stopOpacity="0.4" />
              <stop offset="100%" stopColor="var(--color-signal)" stopOpacity="0.85" />
            </linearGradient>
            <linearGradient id="tunnel-offline" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--color-down)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--color-down)" stopOpacity="0.1" />
            </linearGradient>
            <radialGradient id="mesh-bg-radial" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--color-signal)" stopOpacity="0.12" />
              <stop offset="40%" stopColor="var(--color-signal)" stopOpacity="0.03" />
              <stop offset="100%" stopColor="var(--color-signal)" stopOpacity="0" />
            </radialGradient>
            <filter id="cp-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
            <filter id="node-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          <g transform={`scale(${zoom})`} style={{ transformOrigin: `${cx}px ${cy}px`, transition: 'transform 0.15s ease-out' }}>
            {/* Ambient background glow emanating from Control Plane */}
            <circle cx={cx} cy={cy} r={Math.max(rx, ry) * 1.4} fill="url(#mesh-bg-radial)" pointerEvents="none" />

            {/* ── Connection lines ─────────────────────────────── */}
            {positions.map((pos, i) => {
              const node = enriched[i]!
              const isOnline = node.status === 'online'
              const hasTunnel = node.meshConnected || node.tunnelConnected
              const pathD = curvedPath(cx, cy, pos.x, pos.y)
              const returnPathD = curvedPath(pos.x, pos.y, cx, cy)
              const midX = (cx + pos.x) / 2
              const midY = (cy + pos.y) / 2 - 12

              return (
                <g key={`edge-${node.id}`}>
                  {/* Base connection wire */}
                  <path
                    d={pathD}
                    fill="none"
                    stroke={isOnline ? 'var(--color-line-2)' : 'var(--color-line)'}
                    strokeWidth={1.5}
                    strokeDasharray={isOnline ? 'none' : '4 4'}
                    opacity={isOnline ? 0.7 : 0.25}
                  />
                  {/* Glowing active tunnel stream */}
                  {isOnline && hasTunnel && (
                    <path
                      d={pathD}
                      fill="none"
                      stroke="url(#tunnel-grad)"
                      strokeWidth={2.2}
                      strokeDasharray="8 12"
                      className="animate-dash-flow"
                    />
                  )}
                  {!isOnline && (
                    <path
                      d={pathD}
                      fill="none"
                      stroke="url(#tunnel-offline)"
                      strokeWidth={1.5}
                      strokeDasharray="3 6"
                    />
                  )}

                  {/* Flowing data particles along the active connection */}
                  {isOnline && (
                    <>
                      {/* Outbound telemetry/sync particle */}
                      <circle r={2.8} fill="var(--color-signal)">
                        <animateMotion path={pathD} dur={`${2.2 + (i % 3) * 0.5}s`} repeatCount="indefinite" />
                        <animate attributeName="opacity" values="0.1;1;1;0.2" dur={`${2.2 + (i % 3) * 0.5}s`} repeatCount="indefinite" />
                      </circle>
                      {/* Inbound return heartbeat packet */}
                      <circle r={2} fill="#5eead4">
                        <animateMotion path={returnPathD} dur={`${2.7 + (i % 2) * 0.6}s`} repeatCount="indefinite" />
                        <animate attributeName="opacity" values="0.1;0.9;0.9;0.1" dur={`${2.7 + (i % 2) * 0.6}s`} repeatCount="indefinite" />
                      </circle>
                    </>
                  )}

                  {/* Midpoint link status badge */}
                  {isOnline && (
                    <g opacity={active === node.id ? 1 : 0.75} style={{ transition: 'opacity 0.2s ease' }}>
                      <rect
                        x={midX - 22}
                        y={midY - 7}
                        width={44}
                        height={13}
                        rx={2.5}
                        fill="var(--color-ink-900)"
                        stroke={hasTunnel ? 'var(--color-signal-dim)' : 'var(--color-line)'}
                        strokeWidth={0.8}
                      />
                      <text
                        x={midX}
                        y={midY + 2.5}
                        textAnchor="middle"
                        fill={hasTunnel ? 'var(--color-signal)' : 'var(--color-fg-dim)'}
                        fontSize="7.5"
                        fontFamily="var(--font-mono)"
                      >
                        {hasTunnel ? '● mesh ok' : '○ direct'}
                      </text>
                    </g>
                  )}
                </g>
              )
            })}

            {/* ── Control Plane Centre ─────────────────────────── */}
            <g>
              {/* Outer pulsing radar ring */}
              <circle cx={cx} cy={cy} r={36} fill="none" stroke="var(--color-signal)" strokeWidth={1} opacity={0.25}>
                <animate attributeName="r" from="30" to="48" dur="2.8s" repeatCount="indefinite" />
                <animate attributeName="opacity" from="0.35" to="0" dur="2.8s" repeatCount="indefinite" />
              </circle>
              {/* Core Control Plane Orb */}
              <circle cx={cx} cy={cy} r={28} fill="var(--color-ink-850)" stroke="var(--color-signal)" strokeWidth={1.8} filter="url(#cp-glow)" />
              <circle cx={cx} cy={cy} r={5} fill="var(--color-signal)" />
              <text x={cx} y={cy - 40} textAnchor="middle" fill="var(--color-fg)" fontSize="10.5" fontFamily="var(--font-mono)" fontWeight="600" letterSpacing="0.08em">
                CONTROL PLANE
              </text>
              <text x={cx} y={cy + 48} textAnchor="middle" fill="var(--color-signal)" fontSize="9" fontFamily="var(--font-mono)">
                INGRESS EDGE
              </text>
            </g>

            {/* ── Worker Nodes ─────────────────────────────────── */}
            {positions.map((pos, i) => {
              const node = enriched[i]!
              const isOnline = node.status === 'online'
              const tone = toneOf(node.status)
              const isHovered = active === node.id
              const nodeRadius = isHovered ? 23 : 19
              const servicePos = layoutServices(node.services.length, pos.x, pos.y, cx, cy)
              const showServiceLabels = enriched.length <= 4 || isHovered

              const fillColor =
                tone === 'ok'
                  ? 'var(--color-ink-800)'
                  : tone === 'warn'
                  ? 'color-mix(in oklab, var(--color-warn) 12%, var(--color-ink-800))'
                  : tone === 'down'
                  ? 'color-mix(in oklab, var(--color-down) 12%, var(--color-ink-800))'
                  : 'var(--color-ink-850)'

              const strokeColor =
                tone === 'ok'
                  ? 'var(--color-signal-dim)'
                  : tone === 'warn'
                  ? 'var(--color-warn)'
                  : tone === 'down'
                  ? 'var(--color-down)'
                  : 'var(--color-line-2)'

              return (
                <g
                  key={`node-${node.id}`}
                  onMouseEnter={(e) => handleNodeHover(node.id, e)}
                  onMouseMove={(e) => handleNodeHover(node.id, e)}
                  onMouseLeave={() => handleNodeHover(null)}
                  role="link"
                  tabIndex={0}
                  aria-label={`${node.name}, ${node.status}, ${node.services.length} service${node.services.length === 1 ? '' : 's'}`}
                  onFocus={() => setFocused(node.id)}
                  onBlur={() => setFocused(null)}
                  onClick={() => onSelectNode?.(node.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelectNode?.(node.id)
                    }
                  }}
                  className="cursor-pointer outline-none [&:focus-visible>circle:nth-of-type(1)]:stroke-[var(--color-signal)]"
                  style={{ transition: 'transform 0.2s ease' }}
                >
                  {/* Hover ripple */}
                  {isHovered && (
                    <circle cx={pos.x} cy={pos.y} r={nodeRadius + 6} fill="none" stroke={strokeColor} strokeWidth={1} opacity={0.5}>
                      <animate attributeName="r" from={nodeRadius + 2} to={nodeRadius + 10} dur="1.5s" repeatCount="indefinite" />
                      <animate attributeName="opacity" from="0.5" to="0" dur="1.5s" repeatCount="indefinite" />
                    </circle>
                  )}

                  {/* Node Body */}
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={nodeRadius}
                    fill={fillColor}
                    stroke={strokeColor}
                    strokeWidth={isHovered ? 2 : 1.2}
                    style={{ transition: 'r 0.2s ease, stroke-width 0.2s ease' }}
                  />

                  {/* Mini CPU Load Ring HUD */}
                  {node.telemetry && (
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={nodeRadius + 3.5}
                      fill="none"
                      stroke={
                        node.telemetry.cpuPct > 0.85
                          ? 'var(--color-down)'
                          : node.telemetry.cpuPct > 0.65
                          ? 'var(--color-warn)'
                          : 'var(--color-signal)'
                      }
                      strokeWidth={1.8}
                      strokeDasharray={`${node.telemetry.cpuPct * 2 * Math.PI * (nodeRadius + 3.5)} ${
                        2 * Math.PI * (nodeRadius + 3.5)
                      }`}
                      strokeLinecap="round"
                      transform={`rotate(-90 ${pos.x} ${pos.y})`}
                      opacity={0.85}
                    />
                  )}

                  {/* Center status dot */}
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={3.5}
                    fill={
                      tone === 'ok'
                        ? 'var(--color-signal)'
                        : tone === 'warn'
                        ? 'var(--color-warn)'
                        : tone === 'down'
                        ? 'var(--color-down)'
                        : 'var(--color-fg-dim)'
                    }
                  />

                {/* Hostname label — bigger for readability */}
                <text
                  x={pos.x}
                  y={pos.y + nodeRadius + 16}
                  textAnchor="middle"
                  fill={isHovered ? 'var(--color-fg)' : 'var(--color-fg-muted)'}
                  fontSize="12"
                  fontFamily="var(--font-mono)"
                  fontWeight={isHovered ? '600' : '500'}
                  style={{ transition: 'fill 0.15s ease' }}
                >
                  {node.name}
                </text>

                {/* Architecture + service count */}
                <text
                  x={pos.x}
                  y={pos.y + nodeRadius + 28}
                  textAnchor="middle"
                  fill="var(--color-fg-dim)"
                  fontSize="9"
                  fontFamily="var(--font-mono)"
                >
                  {node.arch} · {node.services.length} svc{node.services.length === 1 ? '' : 's'}
                </text>

                {/* Tunnel badge */}
                {isOnline && (
                  <g>
                    <rect
                      x={pos.x - 36}
                      y={pos.y - nodeRadius - 18}
                      width={72}
                      height={14}
                      rx={3}
                      fill={node.tunnelConnected ? 'color-mix(in oklab, var(--color-signal) 12%, var(--color-ink-900))' : 'var(--color-ink-900)'}
                      stroke={node.tunnelConnected ? 'var(--color-signal-dim)' : 'var(--color-line)'}
                      strokeWidth={0.8}
                    />
                    <text
                      x={pos.x}
                      y={pos.y - nodeRadius - 9}
                      textAnchor="middle"
                      fill={node.tunnelConnected ? 'var(--color-signal)' : 'var(--color-fg-dim)'}
                      fontSize="7.5"
                      fontFamily="var(--font-mono)"
                      letterSpacing="0.04em"
                    >
                      {node.tunnelConnected ? '● Tunnel Active' : '○ No Tunnel'}
                    </text>
                  </g>
                )}

                {/* ── Services ──────────────────────────────── */}
                {servicePos.map((sp, si) => {
                  const svc = node.services[si]!
                  const svcTone = toneOf(svc.status)
                  const svcColor =
                    svcTone === 'ok'
                      ? 'var(--color-signal)'
                      : svcTone === 'warn'
                        ? 'var(--color-warn)'
                        : svcTone === 'down'
                          ? 'var(--color-down)'
                          : 'var(--color-fg-dim)'
                  return (
                    <g
                      key={`svc-${node.id}-${svc.name}`}
                      role="link"
                      tabIndex={0}
                      aria-label={`service ${svc.name} on ${node.name}, ${svc.status}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectService?.(svc.name)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          onSelectService?.(svc.name)
                        }
                      }}
                      className="cursor-pointer outline-none"
                    >
                      <line
                        x1={pos.x}
                        y1={pos.y}
                        x2={sp.x}
                        y2={sp.y}
                        stroke="var(--color-line-2)"
                        strokeWidth={0.7}
                        opacity={isHovered ? 0.9 : 0.45}
                        style={{ transition: 'opacity 0.2s ease' }}
                      />
                      <circle
                        cx={sp.x}
                        cy={sp.y}
                        r={isHovered ? 6 : 5}
                        fill={`color-mix(in oklab, ${svcColor} 18%, var(--color-ink-900))`}
                        stroke={svcColor}
                        strokeWidth={1}
                        style={{ transition: 'r 0.2s ease' }}
                      >
                        {svc.status === 'deploying' && (
                          <animate attributeName="opacity" values="1;0.35;1" dur="1.6s" repeatCount="indefinite" />
                        )}
                      </circle>
                      {showServiceLabels && (
                        <text
                          x={sp.x}
                          y={sp.y - 9}
                          textAnchor="middle"
                          fill="var(--color-fg-muted)"
                          fontSize="7.5"
                          fontFamily="var(--font-mono)"
                        >
                          {svc.name}
                        </text>
                      )}
                    </g>
                  )
                })}
              </g>
            )
          })}
          </g>
        </svg>

        {/* ── Tooltip ────────────────────────────────────────── */}
        <Tooltip x={tooltipPos.x} y={tooltipPos.y} visible={!!hoveredNode}>
          {hoveredNode && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-4">
                <span className="font-semibold text-[12px] text-[var(--color-fg)]">{hoveredNode.name}</span>
                <span className={`text-[9px] uppercase tracking-[0.1em] ${
                  hoveredNode.status === 'online' ? 'text-[var(--color-signal)]' :
                  hoveredNode.status === 'offline' ? 'text-[var(--color-down)]' :
                  'text-[var(--color-warn)]'
                }`}>
                  {hoveredNode.status}
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5 text-[9px] text-[var(--color-fg-dim)]">
                <span className="rounded-[2px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-1.5 py-0.5">{hoveredNode.os}</span>
                <span className="rounded-[2px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-1.5 py-0.5">{hoveredNode.arch}</span>
                {hoveredNode.agentVersion && (
                  <span className="rounded-[2px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-1.5 py-0.5">v{hoveredNode.agentVersion}</span>
                )}
              </div>

              {hoveredNode.telemetry && (
                <div className="space-y-1.5 pt-1">
                  <Meter
                    value={hoveredNode.telemetry.cpuPct}
                    max={1}
                    label={`CPU ${pct(hoveredNode.telemetry.cpuPct)}`}
                    warnAt={0.8}
                  />
                  <Meter
                    value={hoveredNode.telemetry.ramUsedMb}
                    max={hoveredNode.ramMb}
                    label={`RAM ${mb(hoveredNode.telemetry.ramUsedMb)} / ${mb(hoveredNode.ramMb)}`}
                    warnAt={0.85}
                  />
                </div>
              )}

              {hoveredNode.services.length > 0 && (
                <div className="pt-1 border-t border-[var(--color-line)]">
                  <div className="text-[8.5px] uppercase tracking-[0.12em] text-[var(--color-fg-dim)] mb-1.5">
                    Workloads
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {hoveredNode.services.map((s) => (
                      <span
                        key={s.name}
                        className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 text-[9px] ${
                          s.status === 'pinned_unavailable'
                            ? 'border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_8%,transparent)] text-[var(--color-warn)]'
                            : 'border-[var(--color-line)] bg-[var(--color-ink-950)] text-[var(--color-fg-muted)]'
                        }`}
                      >
                        <Dot tone={toneOf(s.status)} size={4} />
                        {s.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-1 border-t border-[var(--color-line)] flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${hoveredNode.tunnelConnected ? 'bg-[var(--color-signal)]' : 'bg-[var(--color-fg-dim)]'}`} />
                <span className="text-[9px] text-[var(--color-fg-muted)]">
                  Reverse tunnel: {hoveredNode.tunnelConnected ? 'connected' : 'not connected'}
                </span>
              </div>
              <div className="text-[9px] text-[var(--color-fg-dim)]">
                Enter opens this node · click a satellite for its service
              </div>
            </div>
          )}
        </Tooltip>
      </div>

      <Legend enriched={enriched} />

      <p className="border-t border-[var(--color-line)] px-5 py-2 font-mono text-[9.5px] text-[var(--color-fg-dim)]">
        Tab to move between nodes and services · Enter to open
      </p>

      {/* ── Node Cards (shown for small fleets) ─────────────── */}
      {showCards && enriched.length > 0 && (
        <div className="border-t border-[var(--color-line)] px-5 py-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {enriched.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                onClick={() => onSelectNode?.(node.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
