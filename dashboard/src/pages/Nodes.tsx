import { useState, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, type Node } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, since, pct, toneOf } from '../lib/format'
import { Button, ConfirmDialog, Dot, Empty, ErrorNote, Meter, Panel, StatusPill } from '../components/ui'
import NodeTelemetry from '../components/NodeTelemetry'
import { TableSkeleton } from '../components/Skeleton'

type FilterOption = 'ALL' | 'ONLINE' | 'OFFLINE' | 'CORDONED' | 'DARWIN' | 'LINUX' | 'WINDOWS'
type PlatformTab = 'unix' | 'windows' | 'cli'
type ViewMode = 'grid' | 'table'

function AppleIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 170 170" fill="currentColor">
      <path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.35.13-9.16-1.9-14.42-6.08-3.7-3.04-7.59-7.79-11.67-14.25-5.87-9.35-10.43-19.98-13.68-31.91-3.26-11.93-4.89-23.36-4.89-34.3 0-14.35 3.82-26.09 11.46-35.21 7.64-9.13 17.1-13.79 28.37-13.99 4.8 0 10.15 1.25 16.05 3.76 5.9 2.5 9.77 3.86 11.61 4.09 1.43-.23 5.43-1.64 12.01-4.23 6.58-2.58 11.93-3.7 16.05-3.36 12.18.98 21.84 5.75 28.98 14.3-10.65 6.42-15.86 15.22-15.63 26.4.23 8.7 3.58 16.04 10.05 22.02 6.47 5.98 14.13 9.4 22.97 10.27-2.39 7.4-5.33 14.79-8.83 22.18zM119.22 31.84c0-7.07 2.56-13.7 7.68-19.89 5.12-6.19 11.39-10.38 18.81-12.58.55 6.85-1.78 13.53-6.99 20.04-5.21 6.51-11.71 10.65-19.5 12.43z"/>
    </svg>
  )
}

function LinuxIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C9.5 2 7.5 3.8 7.5 6.1c0 1.2.5 2.3 1.3 3.1-.3.8-.5 1.7-.5 2.6 0 1.5.5 2.8 1.4 3.9-.9.4-2.1 1.1-2.9 2.1-.9 1.1-1.3 2.5-1.3 4.2h13c0-1.7-.4-3.1-1.3-4.2-.8-1-2-1.7-2.9-2.1.9-1.1 1.4-2.4 1.4-3.9 0-.9-.2-1.8-.5-2.6.8-.8 1.3-1.9 1.3-3.1C16.5 3.8 14.5 2 12 2zm-1.5 4a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6zm3 0a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6zm-1.5 2.2c.8 0 1.5.5 1.5 1.2 0 .4-.2.7-.5.9-.3.2-.6.4-1 .4s-.7-.2-1-.4c-.3-.2-.5-.5-.5-.9 0-.7.7-1.2 1.5-1.2z"/>
    </svg>
  )
}

function WindowsIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.951-1.801"/>
    </svg>
  )
}

function ServerIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
      <line x1="6" y1="6" x2="6.01" y2="6"/>
      <line x1="6" y1="18" x2="6.01" y2="18"/>
    </svg>
  )
}

function GpuIcon({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
      <rect x="9" y="9" width="6" height="6"/>
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>
    </svg>
  )
}

function GridIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
    </svg>
  )
}

function TableIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18"/>
    </svg>
  )
}

function getOsIcon(os: string): { icon: React.ReactNode; name: string } {
  const lower = os.toLowerCase()
  if (lower.includes('darwin') || lower.includes('mac') || lower.includes('apple')) {
    return { icon: <AppleIcon />, name: 'macOS' }
  }
  if (lower.includes('win')) {
    return { icon: <WindowsIcon />, name: 'Windows' }
  }
  if (lower.includes('linux')) {
    return { icon: <LinuxIcon />, name: 'Linux' }
  }
  return { icon: <ServerIcon />, name: os || 'Unix' }
}

export default function Nodes() {
  const { fleet } = useAuth()
  const id = fleet?.id
  const canManage = fleet?.role === 'owner' || fleet?.role === 'admin'

  const { data, error, loading } = usePoll(() => api<{ nodes: Node[] }>(`/fleets/${id}/nodes`), `/fleets/${id}/nodes`)
  const [pairing, setPairing] = useState<{ token: string; install_command: string; expires_at: string } | null>(null)
  const [activePlatformTab, setActivePlatformTab] = useState<PlatformTab>('unix')
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [copiedIp, setCopiedIp] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  // The view lives in the address bar — see Services.tsx for why. Local state
  // was lost on every navigation, which is half of why coming back to a page
  // felt like starting over.
  const [params, setParams] = useSearchParams()
  const setParam = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(params)
    if (value === fallback) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }
  const search = params.get('q') ?? ''
  const setSearch = (v: string) => setParam('q', v, '')
  const filter = (params.get('filter') as FilterOption) || 'ALL'
  const setFilter = (v: FilterOption) => setParam('filter', v, 'ALL')
  const view = (params.get('view') as ViewMode) || 'grid'
  const setView = (v: ViewMode) => setParam('view', v, 'grid')
  const [confirmRemove, setConfirmRemove] = useState<Node | null>(null)

  const nodes = useMemo(() => data?.nodes ?? [], [data])
  const liveNodes = useMemo(() => nodes.filter((n) => n.live || n.status === 'online'), [nodes])

  // Cluster aggregate compute metrics
  const clusterMetrics = useMemo(() => {
    const totalNodes = nodes.length
    const onlineCount = liveNodes.length
    const totalCores = nodes.reduce((sum, n) => sum + (n.cpuCores || 0), 0)
    const totalRamMb = nodes.reduce((sum, n) => sum + (n.ramMb || 0), 0)
    const totalTunnels = nodes.filter((n) => n.telemetry?.meshConnected).length
    const totalWorkloads = nodes.reduce((sum, n) => sum + (n.telemetry?.containers?.length || 0), 0)
    return { totalNodes, onlineCount, totalCores, totalRamMb, totalTunnels, totalWorkloads }
  }, [nodes, liveNodes])

  // Filtered nodes
  const filteredNodes = useMemo(() => {
    return nodes.filter((n) => {
      // Status & Platform filters
      if (filter === 'ONLINE' && n.status !== 'online') return false
      if (filter === 'OFFLINE' && n.status !== 'offline') return false
      if (filter === 'CORDONED' && n.status !== 'cordoned') return false
      if (filter === 'DARWIN' && !n.os.toLowerCase().includes('darwin')) return false
      if (filter === 'LINUX' && !n.os.toLowerCase().includes('linux')) return false
      if (filter === 'WINDOWS' && !n.os.toLowerCase().includes('win')) return false

      // Search filter
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return (
        n.name.toLowerCase().includes(q) ||
        n.os.toLowerCase().includes(q) ||
        n.arch.toLowerCase().includes(q) ||
        (n.advertiseAddr ?? '').toLowerCase().includes(q) ||
        (n.agentVersion ?? '').toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)) ||
        (n.telemetry?.containers ?? []).some((c) => c.name.toLowerCase().includes(q))
      )
    })
  }, [nodes, filter, search])

  /**
   * One node gets the full width. Two columns for a single card leaves it
   * stranded in half the screen with its charts squeezed, which is worse than
   * no grid at all.
   */
  const gridClass = `grid gap-4 ${filteredNodes.length > 1 ? 'lg:grid-cols-2' : ''}`

  async function mintToken() {
    setBusy('pair')
    setActionError(null)
    try {
      setPairing(await api(`/fleets/${id}/nodes/pair-token`, { method: 'POST' }))
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  async function cordon(node: Node, cordoned: boolean) {
    setBusy(`cordon-${node.id}`)
    setActionError(null)
    setActionSuccess(null)
    try {
      await api(`/fleets/${id}/nodes/${node.id}/cordon`, { method: 'POST', body: { cordoned } })
      setActionSuccess(`Node ${node.name} ${cordoned ? 'cordoned' : 'uncordoned'}`)
      setTimeout(() => setActionSuccess(null), 3000)
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  /**
   * Remove a node. The API evicts its workloads first and reports what happened
   * to each one, so the success line says where things went rather than only
   * that the node is gone — a service that could not move is the one thing the
   * operator needs to hear about, and it is easy to miss on the Services page.
   */
  async function remove(node: Node) {
    setBusy(`remove-${node.id}`)
    setActionError(null)
    setActionSuccess(null)
    try {
      const res = await api<{
        evicted?: Array<{ service: string; action: string; toNodeName?: string; reason?: string }>
      }>(`/fleets/${id}/nodes/${node.id}`, { method: 'DELETE' })
      setConfirmRemove(null)

      const evicted = res.evicted ?? []
      const moved = evicted.filter((e) => e.action === 'moved')
      const held = evicted.filter((e) => e.action !== 'moved')
      const detail = [
        moved.length ? `${moved.length} service${moved.length === 1 ? '' : 's'} rescheduled` : null,
        held.length ? `${held.length} could not move: ${held.map((h) => h.service).join(', ')}` : null,
      ].filter(Boolean)

      setActionSuccess(
        `${node.name} removed and its credentials revoked` + (detail.length ? ` — ${detail.join('; ')}` : '')
      )
      // Held services are a standing problem, not a transient toast. Give the
      // operator time to read the names before it clears.
      setTimeout(() => setActionSuccess(null), held.length ? 12000 : 4000)
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  const copyInstallCommand = (cmd: string) => {
    void navigator.clipboard?.writeText(cmd)
    setCopiedCmd(true)
    setTimeout(() => setCopiedCmd(false), 2000)
  }

  if (error) return <ErrorNote error={error} />

  return (
    <div className="space-y-6">
      {/* ── Page Header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono text-[22px] font-semibold tracking-[-0.02em]">Nodes</h1>
          <p className="mt-1 text-[13.5px] text-[var(--color-fg-muted)]">
            Every machine in <span className="font-medium text-[var(--color-fg)]">{fleet?.name}</span>. Capability is detected automatically, not declared.
          </p>
        </div>
        {canManage && (
          <Button
            variant="primary"
            onClick={mintToken}
            disabled={busy === 'pair'}
            className="h-[34px] px-4 font-mono text-[11.5px]"
          >
            {busy === 'pair' ? 'Generating Token…' : '+ Add a Machine'}
          </Button>
        )}
      </div>

      {/* ── Notifications / Alerts ──────────────────────────────── */}
      <ErrorNote error={actionError} />

      {actionSuccess && (
        <div className="fade-up border-l-2 border-[var(--color-signal)] bg-[color-mix(in_oklab,var(--color-signal)_8%,transparent)] px-4 py-3 font-mono text-[12px] text-[var(--color-signal)]">
          ✓ {actionSuccess}
        </div>
      )}

      {/* ── Cluster Compute KPI Cards ────────────────────────────── */}
      <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-2 lg:grid-cols-5">
        {[
          ['Total Machines', String(clusterMetrics.totalNodes), 'idle'],
          ['Online Nodes', `${clusterMetrics.onlineCount} / ${clusterMetrics.totalNodes}`, clusterMetrics.onlineCount > 0 ? 'ok' : 'down'],
          ['Cluster Cores', `${clusterMetrics.totalCores} Cores`, 'idle'],
          ['Cluster RAM', mb(clusterMetrics.totalRamMb), 'idle'],
          ['Active Tunnels', `${clusterMetrics.totalTunnels} Connected`, clusterMetrics.totalTunnels > 0 ? 'ok' : 'idle'],
        ].map(([label, value, tone]) => (
          <div key={label} className="bg-[var(--color-ink-950)] px-5 py-3.5">
            <div className="mono-label normal-case tracking-[0.08em]">{label}</div>
            <div className="mt-1.5 flex items-center gap-2">
              {tone !== 'idle' && <Dot tone={tone as 'ok' | 'down' | 'warn'} size={6} />}
              <span className="tabular font-mono text-[18px] font-semibold tracking-[-0.02em]">{value}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Multi-Platform Pairing Modal / Drawer ────────────────── */}
      {pairing && (
        <Panel
          title="Pair a New Machine"
          right={
            <span className="font-mono text-[10.5px] text-[var(--color-warn)]">
              Token expires in {since(pairing.expires_at)}
            </span>
          }
          className="fade-up"
        >
          <div className="space-y-5 p-5">
            {/* Step Explanation Grid */}
            <div className="grid gap-px border border-[var(--color-line)] bg-[var(--color-line)] sm:grid-cols-3">
              {(
                [
                  ['01', 'Copy Command', 'Run the one-time command on the target laptop, server, or Pi.'],
                  ['02', 'Auto-Setup', 'Installer automatically verifies Docker engine and pairs the agent.'],
                  [
                    '03',
                    liveNodes.length ? 'Connected' : 'Handshake Waiting',
                    liveNodes.length
                      ? `✓ ${liveNodes.length} live node(s) currently heartbeating.`
                      : 'Listening for agent heartbeat over WebSocket reverse tunnel…',
                  ],
                ] as const
              ).map(([step, title, detail]) => (
                <div key={step} className="bg-[var(--color-ink-950)] px-4 py-3">
                  <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-dim)]">
                    <span className={title.includes('Connected') ? 'text-[var(--color-signal)] font-bold' : ''}>{step}</span>
                    <span className={title.includes('Connected') ? 'text-[var(--color-signal)] font-bold' : ''}>{title}</span>
                  </div>
                  <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{detail}</p>
                </div>
              ))}
            </div>

            {/* Platform Selector Tabs */}
            <div>
              <div className="flex items-center justify-between border-b border-[var(--color-line)] pb-2">
                <span className="mono-label">Target Platform</span>
                <div className="flex items-center gap-1 font-mono text-[11px]">
                  <button
                    onClick={() => setActivePlatformTab('unix')}
                    className={`rounded-[3px] px-2.5 py-1 transition-colors ${
                      activePlatformTab === 'unix'
                        ? 'bg-[var(--color-ink-800)] font-medium text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
                    }`}
                  >
                    🍏 macOS / 🐧 Linux
                  </button>
                  <button
                    onClick={() => setActivePlatformTab('windows')}
                    className={`rounded-[3px] px-2.5 py-1 transition-colors ${
                      activePlatformTab === 'windows'
                        ? 'bg-[var(--color-ink-800)] font-medium text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
                    }`}
                  >
                    🪟 Windows (Git Bash)
                  </button>
                  <button
                    onClick={() => setActivePlatformTab('cli')}
                    className={`rounded-[3px] px-2.5 py-1 transition-colors ${
                      activePlatformTab === 'cli'
                        ? 'bg-[var(--color-ink-800)] font-medium text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
                    }`}
                  >
                    📦 Fleet CLI / NPM
                  </button>
                </div>
              </div>

              {/* Install Command Display */}
              <div className="mt-3">
                <div className="relative flex items-center justify-between rounded-[3px] border border-[var(--color-line)] bg-[#07080a] p-3.5 font-mono text-[12px] text-[var(--color-signal)]">
                  <span className="truncate pr-4 select-all">
                    {activePlatformTab === 'cli'
                      ? 'npx @yadurajfleetos/cli nodes pair'
                      : pairing.install_command}
                  </span>
                  <button
                    onClick={() =>
                      copyInstallCommand(
                        activePlatformTab === 'cli'
                          ? 'npx @yadurajfleetos/cli nodes pair'
                          : pairing.install_command
                      )
                    }
                    className="shrink-0 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-850)] px-2.5 py-1 font-mono text-[11px] text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
                  >
                    {copiedCmd ? '✓ Copied' : '📋 Copy'}
                  </button>
                </div>

                {activePlatformTab === 'windows' && (
                  <p className="mt-2 font-mono text-[11px] text-[var(--color-fg-dim)]">
                    Tip: Run in Git Bash or WSL. If Docker Desktop is missing, the installer will automatically download and set it up via winget.
                  </p>
                )}
              </div>
            </div>

            {/* Radar status footer */}
            <div className="flex items-center justify-between border-t border-[var(--color-line)] pt-4">
              <div className="flex items-center gap-2.5 font-mono text-[11px]">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-signal)] opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--color-signal)]" />
                </span>
                <span className="text-[var(--color-fg-muted)]">
                  Listening for agent report… Token valid until {new Date(pairing.expires_at).toLocaleTimeString()}
                </span>
              </div>
              <Button onClick={() => setPairing(null)} className="h-[30px] text-[11px]">
                {liveNodes.length > 0 ? 'Done' : 'Dismiss'}
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {/* ── Search & Platform Filter Toolbar ─────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] pb-3">
        {/* Filter Pills */}
        <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
          {(
            [
              ['ALL', `All (${nodes.length})`, null],
              ['ONLINE', `Online (${clusterMetrics.onlineCount})`, null],
              ['OFFLINE', `Offline (${clusterMetrics.totalNodes - clusterMetrics.onlineCount})`, null],
              ['DARWIN', 'macOS', <AppleIcon key="apple" />],
              ['LINUX', 'Linux', <LinuxIcon key="linux" />],
              ['WINDOWS', 'Windows', <WindowsIcon key="win" />],
            ] as const
          ).map(([key, label, icon]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`flex items-center gap-1.5 rounded-[4px] px-2.5 py-1 transition-colors ${
                filter === key
                  ? 'bg-[var(--color-ink-800)] font-medium text-[var(--color-fg)] border border-[var(--color-line-2)]'
                  : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)] border border-transparent'
              }`}
            >
              {icon && <span className="opacity-80">{icon}</span>}
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Right side: Search & View Mode Switcher */}
        <div className="flex items-center gap-2.5">
          {/* View Mode Toggle */}
          <div className="flex items-center rounded-[4px] border border-[var(--color-line)] bg-[var(--color-ink-950)] p-0.5">
            <button
              onClick={() => setView('grid')}
              className={`flex items-center gap-1.5 rounded-[3px] px-2 py-1 font-mono text-[10.5px] transition-colors ${
                view === 'grid'
                  ? 'bg-[var(--color-ink-800)] text-[var(--color-fg)] font-medium shadow-sm'
                  : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]'
              }`}
              title="Grid View"
            >
              <GridIcon />
              <span>Grid</span>
            </button>
            <button
              onClick={() => setView('table')}
              className={`flex items-center gap-1.5 rounded-[3px] px-2 py-1 font-mono text-[10.5px] transition-colors ${
                view === 'table'
                  ? 'bg-[var(--color-ink-800)] text-[var(--color-fg)] font-medium shadow-sm'
                  : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]'
              }`}
              title="Table View"
            >
              <TableIcon />
              <span>Table</span>
            </button>
          </div>

          {/* Search Input */}
          <div className="relative flex items-center">
            <span className="pointer-events-none absolute left-2.5 text-[11px] text-[var(--color-fg-dim)]">🔍</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search hostname, OS, IP…"
              className="h-[30px] w-[200px] rounded-[4px] border border-[var(--color-line)] bg-[var(--color-ink-900)] pl-7 pr-7 font-mono text-[11px] text-[var(--color-fg)] outline-none transition-all placeholder:text-[var(--color-fg-dim)] focus:w-[260px] focus:border-[var(--color-line-2)]"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 text-[10px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Nodes Cards Grid / Table ───────────────────────────────── */}
      {loading && !nodes.length ? (
        <TableSkeleton rows={3} columns={[30, 18, 18, 17, 17]} />
      ) : !loading && !nodes.length ? (
        <Empty
          title="No machines paired yet"
          hint="Pair a laptop, desktop, or cloud VM you own to start scheduling container workloads onto your hardware."
          action={
            canManage ? (
              <Button variant="primary" onClick={mintToken}>
                Add your first machine
              </Button>
            ) : undefined
          }
        />
      ) : filteredNodes.length === 0 ? (
        <div className="py-12 text-center font-mono text-[12px] text-[var(--color-fg-dim)]">
          No machines match your filter "{search || filter}".
          <button
            onClick={() => {
              setSearch('')
              setFilter('ALL')
            }}
            className="ml-2 text-[var(--color-signal)] underline hover:text-[#55ee9c]"
          >
            Clear filters
          </button>
        </div>
      ) : view === 'table' ? (
        /* ── Dense Table View ── */
        <div className="overflow-x-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-ink-950)] shadow-sm">
          <table className="w-full border-collapse text-left font-mono text-[11px]">
            <thead>
              <tr className="border-b border-[var(--color-line)] bg-[var(--color-ink-900)] text-[10px] text-[var(--color-fg-dim)]">
                <th className="py-2.5 pl-4 pr-3 font-medium tracking-wider">NODE</th>
                <th className="py-2.5 px-3 font-medium tracking-wider">STATUS</th>
                <th className="py-2.5 px-3 font-medium tracking-wider">PLATFORM</th>
                <th className="py-2.5 px-3 font-medium tracking-wider">CORES / RAM</th>
                <th className="py-2.5 px-3 font-medium tracking-wider">DISK USAGE</th>
                <th className="py-2.5 px-3 font-medium tracking-wider">WORKLOADS</th>
                <th className="py-2.5 px-3 font-medium tracking-wider">IP / TUNNEL</th>
                <th className="py-2.5 px-3 font-medium tracking-wider">HEARTBEAT</th>
                {canManage && <th className="py-2.5 pl-3 pr-4 text-right font-medium tracking-wider">ACTIONS</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {filteredNodes.map((n) => {
                const isOnline = n.status === 'online'
                const osInfo = getOsIcon(n.os)
                const ramUsed = n.telemetry?.ramUsedMb ?? 0
                const ramRatio = n.ramMb > 0 ? ramUsed / n.ramMb : 0
                const diskTotal =
                  n.telemetry?.diskTotalMb ??
                  (n.telemetry?.diskUsedMb != null && n.diskMb ? n.telemetry.diskUsedMb + n.diskMb : 0)
                const diskUsed = n.telemetry?.diskUsedMb ?? 0
                const diskRatio = diskTotal > 0 ? diskUsed / diskTotal : 0
                const hasTunnel = n.telemetry?.meshConnected ?? false
                const isCordoning = busy === `cordon-${n.id}`
                const isRemoving = busy === `remove-${n.id}`

                return (
                  <tr key={n.id} className="transition-colors hover:bg-[var(--color-ink-900)]/80">
                    <td className="py-3 pl-4 pr-3">
                      <Link
                        to={`/nodes/${n.id}`}
                        className="flex items-center gap-2 font-sans text-[13.5px] font-semibold text-[var(--color-fg)] hover:text-[var(--color-signal)]"
                      >
                        <span className="text-[var(--color-fg-muted)]">{osInfo.icon}</span>
                        <span>{n.name}</span>
                        {n.hasGpu && (
                          <span className="flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-signal)] border border-[var(--color-signal-dim)] bg-[color-mix(in_oklab,var(--color-signal)_10%,transparent)]">
                            <GpuIcon className="h-2.5 w-2.5" /> GPU
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="py-3 px-3">
                      <StatusPill status={n.status} />
                    </td>
                    <td className="py-3 px-3 text-[var(--color-fg-muted)]">
                      {osInfo.name} ({n.arch})
                    </td>
                    <td className="py-3 px-3">
                      <div className="text-[var(--color-fg)] tabular-nums">{n.cpuCores}c · {mb(n.ramMb)}</div>
                      {n.telemetry && (
                        <div className="mt-1 flex items-center gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-line-2)]">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${ramRatio * 100}%`,
                                backgroundColor: ramRatio > 0.85 ? 'var(--color-warn)' : 'var(--color-signal)',
                              }}
                            />
                          </div>
                          <span className="text-[9.5px] tabular-nums text-[var(--color-fg-dim)]">
                            {Math.round(ramRatio * 100)}%
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      {diskTotal > 0 ? (
                        <div>
                          <div className="tabular-nums text-[var(--color-fg-muted)]">
                            {mb(diskUsed)} / {mb(diskTotal)}
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-line-2)]">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{
                                  width: `${diskRatio * 100}%`,
                                  backgroundColor:
                                    diskRatio > 0.9
                                      ? 'var(--color-down)'
                                      : diskRatio > 0.8
                                      ? 'var(--color-warn)'
                                      : 'var(--color-signal)',
                                }}
                              />
                            </div>
                            <span className="text-[9.5px] tabular-nums text-[var(--color-fg-dim)]">
                              {Math.round(diskRatio * 100)}%
                            </span>
                          </div>
                        </div>
                      ) : (
                        <span className="text-[var(--color-fg-dim)]">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      {(n.telemetry?.containers ?? []).length > 0 ? (
                        <span className="rounded-[4px] border border-[var(--color-line-2)] bg-[var(--color-ink-850)] px-2 py-0.5 text-[10px] text-[var(--color-fg)]">
                          {n.telemetry?.containers.length} container{n.telemetry?.containers.length === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="text-[var(--color-fg-dim)]">0</span>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-1.5">
                        <span className="max-w-[120px] truncate text-[var(--color-fg-muted)]">
                          {n.advertiseAddr || 'private'}
                        </span>
                        {isOnline && (
                          <span
                            className={`inline-flex items-center gap-1 rounded-[3px] px-1.5 py-0.5 text-[9.5px] ${
                              hasTunnel
                                ? 'border border-[var(--color-signal-dim)] bg-[color-mix(in_oklab,var(--color-signal)_10%,transparent)] text-[var(--color-signal)]'
                                : 'border border-[var(--color-line-2)] text-[var(--color-fg-dim)]'
                            }`}
                          >
                            {hasTunnel ? 'Tunnel' : 'Direct'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-[var(--color-fg-dim)]">
                      {since(n.lastHeartbeatAt)}
                    </td>
                    {canManage && (
                      <td className="py-3 pl-3 pr-4 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            onClick={() => void cordon(n, n.status !== 'cordoned')}
                            disabled={busy !== null}
                            className="h-[26px] px-2 text-[10px]"
                          >
                            {isCordoning ? '…' : n.status === 'cordoned' ? 'Uncordon' : 'Cordon'}
                          </Button>
                          {fleet?.role === 'owner' && (
                            <Button
                              variant="danger"
                              onClick={() => setConfirmRemove(n)}
                              disabled={busy !== null}
                              className="h-[26px] px-2 text-[10px]"
                            >
                              {isRemoving ? '…' : 'Remove'}
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        /* ── Modern SaaS Cards Grid ── */
        <div className={gridClass}>
          {filteredNodes.map((n) => {
            const isOnline = n.status === 'online'
            const osInfo = getOsIcon(n.os)
            const isCordoning = busy === `cordon-${n.id}`
            const isRemoving = busy === `remove-${n.id}`
            const hasTunnel = n.telemetry?.meshConnected ?? false

            return (
              <div
                key={n.id}
                className="panel group relative flex flex-col justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-ink-950)] p-5 transition-all duration-300 hover:border-white/[0.18] hover:shadow-[0_8px_30px_rgb(0,0,0,0.35)] has-[a:focus-visible]:border-[var(--color-signal)]"
                style={
                  !isOnline
                    ? { background: 'color-mix(in oklab, var(--color-down) 3%, var(--color-ink-950))' }
                    : undefined
                }
              >
                {/* ── Node Header Row ─────────────────────────────── */}
                <div>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="flex h-6 w-6 items-center justify-center rounded-[4px] border border-white/[0.08] bg-white/[0.04] text-[var(--color-fg-muted)] shadow-inner"
                          title={osInfo.name}
                        >
                          {osInfo.icon}
                        </span>

                        <Link
                          to={`/nodes/${n.id}`}
                          className="font-sans text-[16px] font-semibold tracking-tight text-[var(--color-fg)] transition-colors duration-200 after:absolute after:inset-0 after:content-[''] hover:text-[var(--color-signal)] group-hover:text-[var(--color-signal)]"
                        >
                          {n.name}
                          <span className="ml-1.5 inline-block text-[11px] text-[var(--color-fg-dim)] opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                            →
                          </span>
                        </Link>

                        {/* Reverse Tunnel Status Badge */}
                        {isOnline && (
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-0.5 font-mono text-[10px] ${
                              hasTunnel
                                ? 'border-[var(--color-signal-dim)] bg-[color-mix(in_oklab,var(--color-signal)_10%,transparent)] text-[var(--color-signal)]'
                                : 'border-[var(--color-line-2)] bg-[var(--color-ink-850)] text-[var(--color-fg-dim)]'
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${hasTunnel ? 'bg-[var(--color-signal)]' : 'bg-[var(--color-fg-dim)]'}`}
                            />
                            {hasTunnel ? 'Tunnel Active' : 'Direct'}
                          </span>
                        )}

                        {/* Reliability Tier */}
                        <span className="rounded-[4px] border border-[var(--color-line-2)] bg-[var(--color-ink-850)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
                          {n.reliabilityTier}
                        </span>

                        {/* GPU Badge */}
                        {n.hasGpu && (
                          <span className="flex items-center gap-1 rounded-[4px] border border-[var(--color-signal-dim)] bg-[color-mix(in_oklab,var(--color-signal)_10%,transparent)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-signal)]">
                            <GpuIcon className="h-2.5 w-2.5" /> GPU
                          </span>
                        )}
                      </div>

                      {/* Specs Subtitle */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                        <span className="text-[var(--color-fg-muted)]">{osInfo.name} ({n.arch})</span>
                        <span>·</span>
                        <span>{n.cpuCores} cores</span>
                        <span>·</span>
                        <span>{mb(n.ramMb)} physical RAM</span>
                      </div>
                    </div>

                    {/* Status Pill */}
                    <div className="shrink-0">
                      <StatusPill status={n.status} />
                    </div>
                  </div>

                  {/* Live numbers with the hour behind them */}
                  <NodeTelemetry node={n} fleetId={fleet?.id} />

                  {/* ── Workloads Section ─────────────────────────── */}
                  <div className="mt-3.5">
                    <div className="mono-label mb-1.5 text-[9px] text-[var(--color-fg-dim)]">
                      ACTIVE WORKLOADS ({(n.telemetry?.containers ?? []).length})
                    </div>
                    {(n.telemetry?.containers ?? []).length > 0 ? (
                      <div className="relative z-10 flex flex-wrap gap-1.5">
                        {n.telemetry?.containers.map((c) => (
                          <Link
                            key={c.name}
                            to={`/logs?service=${c.name}`}
                            className="inline-flex items-center gap-1.5 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-2.5 py-1 font-mono text-[10.5px] text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-signal-dim)] hover:text-[var(--color-fg)]"
                            title={`Inspect live logs for ${c.name}`}
                          >
                            <Dot tone={c.state === 'running' ? 'ok' : 'warn'} size={4} />
                            <span>{c.name}</span>
                            <span className="text-[9px] text-[var(--color-fg-dim)]">↗ logs</span>
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <span className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                        No containers allocated on this node.
                      </span>
                    )}
                  </div>

                  {/* ── Runtime Diagnostics Grid ──────────────────── */}
                  <div className="mt-4 grid grid-cols-2 gap-2.5 border-t border-[var(--color-line)] pt-3.5 font-mono text-[10.5px]">
                    <div>
                      <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">DOCKER ENGINE</span>
                      <span className="text-[var(--color-fg)]">
                        {n.telemetry?.runtime?.dockerAvailable ? (
                          <span className="text-[var(--color-signal)]">
                            ✓ {n.telemetry.runtime.dockerVersion || 'v27+'}
                          </span>
                        ) : (
                          <span className="text-[var(--color-down)]">✖ Unavailable</span>
                        )}
                      </span>
                    </div>

                    <div>
                      <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">REGISTRY ACCESS</span>
                      <span className="text-[var(--color-fg-muted)]">
                        {n.telemetry?.runtime?.registryStatus === 'ok' ? (
                          <span className="text-[var(--color-signal)]">✓ OK</span>
                        ) : (
                          <span>{n.telemetry?.runtime?.registryStatus || 'checked on pull'}</span>
                        )}
                      </span>
                    </div>

                    <div>
                      <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">IP ADDRESS</span>
                      <span className="group/ip relative z-10 flex items-center gap-1.5 truncate text-[var(--color-fg-muted)]">
                        <span>{n.advertiseAddr || 'private network'}</span>
                        {n.advertiseAddr && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void navigator.clipboard?.writeText(n.advertiseAddr)
                              setCopiedIp(n.id)
                              setTimeout(() => setCopiedIp(null), 1500)
                            }}
                            className="rounded p-0.5 text-[10px] text-[var(--color-fg-dim)] opacity-0 transition-opacity group-hover/ip:opacity-100 hover:text-[var(--color-fg)]"
                            title="Copy IP address"
                          >
                            {copiedIp === n.id ? '✓' : '📋'}
                          </button>
                        )}
                      </span>
                    </div>

                    <div>
                      <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">HEARTBEAT</span>
                      <span className={isOnline ? 'text-[var(--color-fg-muted)]' : 'text-[var(--color-down)]'}>
                        {since(n.lastHeartbeatAt)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* ── Action Bar Footer ──────────────────────────── */}
                <div className="relative z-10 mt-4 flex items-center justify-between border-t border-[var(--color-line)] pt-3">
                  <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">
                    Agent {n.agentVersion ? `v${n.agentVersion}` : 'v0.1.0'}
                  </span>

                  {canManage && (
                    <div className="flex items-center gap-2">
                      <Button
                        onClick={() => void cordon(n, n.status !== 'cordoned')}
                        disabled={busy !== null}
                        className="h-[28px] px-2.5 text-[10.5px]"
                        title={
                          n.status === 'cordoned'
                            ? 'Uncordon: resume scheduling new containers here'
                            : 'Cordon: prevent new containers from landing on this node'
                        }
                      >
                        {isCordoning ? 'Saving…' : n.status === 'cordoned' ? 'Uncordon' : 'Cordon'}
                      </Button>

                      {fleet?.role === 'owner' && (
                        <Button
                          variant="danger"
                          onClick={() => setConfirmRemove(n)}
                          disabled={busy !== null}
                          className="h-[28px] px-2.5 text-[10.5px]"
                          title="Revoke pairing credentials and remove from cluster"
                        >
                          {isRemoving ? 'Removing…' : 'Remove'}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        title={`Remove ${confirmRemove?.name ?? 'node'}`}
        body="This takes the machine out of the fleet. It can be paired again later, but with new credentials."
        consequences={[
          'Its agent credentials are revoked and its reverse tunnel is closed',
          'Flexible and preferred services are moved to other nodes',
          'Pinned services stay put and will have nowhere to run',
          `To clean up the machine itself, run "fleet unpair" on it`,
        ]}
        confirmPhrase={confirmRemove?.name}
        confirmLabel="Remove node"
        busy={busy === `remove-${confirmRemove?.id}`}
        onConfirm={() => { if (confirmRemove) void remove(confirmRemove) }}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  )
}
