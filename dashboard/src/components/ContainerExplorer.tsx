import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { mb } from '../lib/format'

export interface ContainerItem {
  name: string
  id?: string
  image?: string
  state: string
  status?: string
  health?: string
  deployment_id?: string
  memory_mb?: number
  cpu_pct?: number
  restarts?: number
  // Derived metadata from services
  serviceId?: string
  serviceName?: string
  project?: string
}

interface ContainerExplorerProps {
  containers: ContainerItem[]
  totalNodeRamMb: number
  nodeName: string
  onViewLogs: (container: ContainerItem) => void
  onRestart: (container: ContainerItem) => void
  onExec: (container: ContainerItem) => void
}

export default function ContainerExplorer({
  containers,
  totalNodeRamMb,
  nodeName,
  onViewLogs,
  onRestart,
  onExec,
}: ContainerExplorerProps) {
  const [search, setSearch] = useState('')
  const [filterState, setFilterState] = useState<'all' | 'running' | 'other'>('all')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const handleCopyId = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await navigator.clipboard.writeText(id)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1800)
  }

  // Filter containers
  const filtered = useMemo(() => {
    return containers.filter((c) => {
      // Status filter
      if (filterState === 'running' && c.state.toLowerCase() !== 'running') return false
      if (filterState === 'other' && c.state.toLowerCase() === 'running') return false

      // Search query
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return (
        c.name.toLowerCase().includes(q) ||
        (c.serviceName && c.serviceName.toLowerCase().includes(q)) ||
        (c.image && c.image.toLowerCase().includes(q)) ||
        (c.id && c.id.toLowerCase().includes(q)) ||
        (c.status && c.status.toLowerCase().includes(q))
      )
    })
  }, [containers, filterState, search])

  const runningCount = useMemo(
    () => containers.filter((c) => c.state.toLowerCase() === 'running').length,
    [containers]
  )

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-ink-950)] overflow-hidden shadow-xl">
      {/* Header bar */}
      <div className="p-4 border-b border-[var(--color-line)] bg-[var(--color-ink-900)] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#3fe08b]/10 border border-[#3fe08b]/25 flex items-center justify-center text-[#3fe08b] text-[15px]">
            🐳
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-mono text-[13px] font-bold text-white tracking-tight uppercase">
                Container Process Explorer
              </h3>
              <span className="px-2 py-0.5 rounded-full text-[10.5px] font-mono font-semibold bg-[#3fe08b]/15 text-[#3fe08b] border border-[#3fe08b]/30">
                {runningCount} / {containers.length} Running
              </span>
            </div>
            <p className="font-mono text-[11px] text-[var(--color-fg-dim)]">
              Real-time resource allocation and process inspect on <span className="text-white/70">{nodeName}</span>
            </p>
          </div>
        </div>

        {/* Filters & Search */}
        <div className="flex flex-wrap items-center gap-2.5 ml-auto">
          {/* Quick Filter Pills */}
          <div className="flex items-center bg-black/40 p-0.5 rounded-lg border border-white/[0.08] font-mono text-[11px]">
            <button
              onClick={() => setFilterState('all')}
              className={`px-2.5 py-1 rounded-md transition-all ${
                filterState === 'all'
                  ? 'bg-white/15 text-white font-semibold shadow-sm'
                  : 'text-white/40 hover:text-white'
              }`}
            >
              All ({containers.length})
            </button>
            <button
              onClick={() => setFilterState('running')}
              className={`px-2.5 py-1 rounded-md transition-all ${
                filterState === 'running'
                  ? 'bg-[#3fe08b]/20 text-[#3fe08b] font-semibold shadow-sm'
                  : 'text-white/40 hover:text-[#3fe08b]'
              }`}
            >
              Running ({runningCount})
            </button>
            {containers.length - runningCount > 0 && (
              <button
                onClick={() => setFilterState('other')}
                className={`px-2.5 py-1 rounded-md transition-all ${
                  filterState === 'other'
                    ? 'bg-amber-500/20 text-amber-400 font-semibold shadow-sm'
                    : 'text-white/40 hover:text-amber-400'
                }`}
              >
                Other ({containers.length - runningCount})
              </button>
            )}
          </div>

          {/* Search Input */}
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search containers…"
              className="w-44 sm:w-56 px-3 py-1.5 pl-8 rounded-lg bg-black/50 border border-white/10 text-[12px] font-mono text-white placeholder-white/30 focus:outline-none focus:border-[#3fe08b]/50 focus:ring-1 focus:ring-[#3fe08b]/30 transition-all"
            />
            <svg
              className="w-3.5 h-3.5 text-white/40 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white font-mono text-[11px]"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Container Table */}
      {filtered.length === 0 ? (
        <div className="py-12 px-4 text-center font-mono text-[12px] text-[var(--color-fg-dim)]">
          {containers.length === 0
            ? 'No containers currently reporting on this node.'
            : 'No containers match your search query.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono border-collapse">
            <thead>
              <tr className="border-b border-white/[0.06] bg-white/[0.01] text-[9.5px] uppercase tracking-wider text-white/40">
                <th className="py-3 px-4 font-semibold">Container / Service</th>
                <th className="py-3 px-4 font-semibold">Image / Tag</th>
                <th className="py-3 px-4 font-semibold">Status & Health</th>
                <th className="py-3 px-4 font-semibold">Memory Usage</th>
                <th className="py-3 px-4 font-semibold">CPU</th>
                <th className="py-3 px-4 font-semibold">Restarts</th>
                <th className="py-3 px-4 font-semibold text-right">Quick Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04] text-[12px]">
              {filtered.map((c) => {
                const isRunning = c.state.toLowerCase() === 'running'
                const ramMb = c.memory_mb ?? 0
                const ramPct = totalNodeRamMb > 0 ? Math.round((ramMb / totalNodeRamMb) * 100) : 0
                const shortId = c.id ? c.id.slice(0, 12) : null
                const cleanName = c.name.replace(/^\//, '')
                const displayName = c.serviceName || cleanName.replace(/^fleet-/, '')

                return (
                  <tr
                    key={cleanName}
                    className="hover:bg-white/[0.02] transition-colors group"
                  >
                    {/* Container / Service Name */}
                    <td className="py-3 px-4">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          {c.serviceId ? (
                            <Link
                              to={`/services/${c.serviceId}`}
                              className="font-bold text-white hover:text-[#3fe08b] transition-colors flex items-center gap-1.5"
                              title="Go to service details"
                            >
                              <span>{displayName}</span>
                              <svg className="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M7 17l9.2-9.2M17 17V7H7" />
                              </svg>
                            </Link>
                          ) : (
                            <span className="font-bold text-white/95">{displayName}</span>
                          )}

                          {c.project && (
                            <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-white/[0.06] text-white/60 border border-white/[0.08]">
                              {c.project}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 text-[10.5px] text-white/40">
                          <span className="truncate max-w-[200px]" title={cleanName}>
                            {cleanName}
                          </span>
                          {shortId && (
                            <button
                              onClick={(e) => handleCopyId(c.id!, e)}
                              className="hover:text-white/80 transition-colors flex items-center gap-1 text-[10px] text-white/30"
                              title="Copy container ID"
                            >
                              <span>#{shortId}</span>
                              {copiedId === c.id ? (
                                <span className="text-[#3fe08b] font-bold">✓</span>
                              ) : (
                                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                                </svg>
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Image / Tag */}
                    <td className="py-3 px-4">
                      {c.image ? (
                        <div
                          className="font-mono text-[11px] text-white/70 truncate max-w-[180px] bg-white/[0.03] px-2 py-0.5 rounded border border-white/[0.05]"
                          title={c.image}
                        >
                          {c.image.includes('/') ? c.image.split('/').pop() : c.image}
                        </div>
                      ) : (
                        <span className="text-white/30 text-[11px]">—</span>
                      )}
                    </td>

                    {/* Status & Health */}
                    <td className="py-3 px-4">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              isRunning
                                ? 'bg-[#3fe08b] shadow-[0_0_8px_rgba(63,224,139,0.5)]'
                                : 'bg-red-400'
                            }`}
                          />
                          <span
                            className={`font-semibold capitalize text-[11px] ${
                              isRunning ? 'text-[#3fe08b]' : 'text-red-400'
                            }`}
                          >
                            {c.state}
                          </span>

                          {/* Health pill */}
                          {c.health && (
                            <span
                              className={`px-1.5 py-0.2 rounded text-[9.5px] font-semibold uppercase tracking-wider ${
                                c.health === 'healthy'
                                  ? 'bg-[#3fe08b]/15 text-[#3fe08b] border border-[#3fe08b]/30'
                                  : c.health === 'starting'
                                  ? 'bg-amber-400/15 text-amber-400 border border-amber-400/30'
                                  : 'bg-red-400/15 text-red-400 border border-red-400/30'
                              }`}
                            >
                              {c.health}
                            </span>
                          )}
                        </div>

                        {c.status && (
                          <span className="text-[10px] text-white/40 truncate max-w-[170px]" title={c.status}>
                            {c.status}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Memory Usage */}
                    <td className="py-3 px-4">
                      {ramMb > 0 ? (
                        <div className="min-w-[110px]">
                          <div className="flex items-center justify-between text-[11px] mb-1">
                            <span className="font-semibold text-white tabular-nums">
                              {mb(ramMb)}
                            </span>
                            <span className="text-white/40 text-[10px] tabular-nums">
                              {ramPct}%
                            </span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{
                                width: `${Math.min(100, Math.max(2, ramPct))}%`,
                                background:
                                  ramPct > 85 ? '#f87171' : ramPct > 65 ? '#fbbf24' : '#9a6bd8',
                              }}
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="text-white/30 text-[11px]">measuring…</span>
                      )}
                    </td>

                    {/* CPU % */}
                    <td className="py-3 px-4">
                      {c.cpu_pct != null ? (
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-white tabular-nums text-[11.5px]">
                            {c.cpu_pct.toFixed(1)}%
                          </span>
                          <div className="w-12 h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.min(100, c.cpu_pct)}%`,
                                background: c.cpu_pct > 80 ? '#f87171' : '#3987e5',
                              }}
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="text-white/30 text-[11px]">—</span>
                      )}
                    </td>

                    {/* Restarts */}
                    <td className="py-3 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10.5px] font-mono tabular-nums ${
                          (c.restarts ?? 0) > 0
                            ? 'bg-amber-500/20 text-amber-400 font-bold border border-amber-500/30'
                            : 'text-white/40'
                        }`}
                      >
                        {c.restarts ?? 0}
                      </span>
                    </td>

                    {/* Quick Actions */}
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* 📄 Logs */}
                        <button
                          onClick={() => onViewLogs(c)}
                          className="px-2.5 py-1 rounded bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.08] text-white/80 hover:text-white text-[10.5px] font-semibold transition-colors flex items-center gap-1"
                          title="Open streaming logs"
                        >
                          <span>📄</span> Logs
                        </button>

                        {/* ↺ Restart */}
                        {c.serviceId && (
                          <button
                            onClick={() => onRestart(c)}
                            className="px-2.5 py-1 rounded bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/25 text-amber-400 hover:text-amber-300 text-[10.5px] font-semibold transition-colors flex items-center gap-1"
                            title="Restart service container"
                          >
                            <span>↺</span> Restart
                          </button>
                        )}

                        {/* >_ Exec Terminal */}
                        <button
                          onClick={() => onExec(c)}
                          className="px-2.5 py-1 rounded bg-[#3fe08b]/10 hover:bg-[#3fe08b]/20 border border-[#3fe08b]/25 text-[#3fe08b] hover:text-emerald-300 text-[10.5px] font-semibold transition-colors flex items-center gap-1"
                          title={`Launch terminal directly inside ${cleanName}`}
                        >
                          <span>&gt;_</span> Exec
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
