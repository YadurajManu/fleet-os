import { Link, useNavigate } from 'react-router-dom'
import { api, type Node, type PlacementMapNode, type Service, type TimelineEvent } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, pct, since, toneOf } from '../lib/format'
import { Dot, Empty, ErrorNote, GridFiller, Panel, StatusPill, Button, RingGauge } from '../components/ui'
import ClusterMeshVisualizer from '../components/ClusterMeshVisualizer'
import FirstRun from '../components/FirstRun'
import SinceYouLeft from '../components/SinceYouLeft'
import { OverviewSkeleton } from '../components/Skeleton'

function getEventIcon(reason: string) {
  switch (reason?.toLowerCase()) {
    case 'deploy':
      return {
        icon: '🚀',
        color: 'text-[var(--color-signal)]',
        bg: 'bg-[color-mix(in_oklab,var(--color-signal)_15%,transparent)]',
        border: 'border-[color-mix(in_oklab,var(--color-signal)_30%,transparent)]',
      }
    case 'failover':
      return {
        icon: '⚠️',
        color: 'text-[var(--color-warn)]',
        bg: 'bg-[color-mix(in_oklab,var(--color-warn)_15%,transparent)]',
        border: 'border-[color-mix(in_oklab,var(--color-warn)_30%,transparent)]',
      }
    case 'scale':
      return {
        icon: '📐',
        color: 'text-[var(--color-focus)]',
        bg: 'bg-[color-mix(in_oklab,var(--color-focus)_15%,transparent)]',
        border: 'border-[color-mix(in_oklab,var(--color-focus)_30%,transparent)]',
      }
    case 'drain':
      return {
        icon: '🧹',
        color: 'text-[var(--color-warn)]',
        bg: 'bg-[color-mix(in_oklab,var(--color-warn)_15%,transparent)]',
        border: 'border-[color-mix(in_oklab,var(--color-warn)_30%,transparent)]',
      }
    case 'restart':
      return {
        icon: '🔄',
        color: 'text-[var(--color-fg-muted)]',
        bg: 'bg-[color-mix(in_oklab,var(--color-fg-muted)_15%,transparent)]',
        border: 'border-[var(--color-line)]',
      }
    default:
      return {
        icon: '⚡',
        color: 'text-[var(--color-fg-dim)]',
        bg: 'bg-[var(--color-ink-900)]',
        border: 'border-[var(--color-line)]',
      }
  }
}

export default function Overview() {
  const { fleet } = useAuth()
  const id = fleet?.id

  const map = usePoll(
    () => api<{ nodes: PlacementMapNode[]; unplaced: string[] }>(`/fleets/${id}/placement-map`),
    `/fleets/${id}/placement-map`
  )
  const nodes = usePoll(() => api<{ nodes: Node[] }>(`/fleets/${id}/nodes`), `/fleets/${id}/nodes`)
  const events = usePoll(() => api<{ events: TimelineEvent[] }>(`/fleets/${id}/events?limit=8`), `/fleets/${id}/events?limit=8`, 8000)
  // Needed to lead with what is wrong. The placement map only knows about
  // services that got placed, so a service whose deployment failed is simply
  // absent from it — which is how four of them were down with the Overview
  // reporting nothing at all.
  const services = usePoll(() => api<{ services: Service[] }>(`/fleets/${id}/services`), `/fleets/${id}/services`, 8000)
  // Polled slowly: this changes when somebody configures it, not on its own.
  const alerts = usePoll(
    () => api<{ rules: Array<{ enabled: boolean }> }>(`/fleets/${id}/alert-rules`),
    `/fleets/${id}/alert-rules`,
    60_000
  )
  const navigate = useNavigate()

  if (!id) return <Empty title="No fleet selected" />
  if (map.error) return <ErrorNote error={map.error} />
  if (map.loading && !map.data) return <OverviewSkeleton />

  const mapNodes = map.data?.nodes ?? []
  const all = nodes.data?.nodes ?? []

  // An empty fleet gets the guide rather than a dead end.
  if (!map.loading && fleet && (!mapNodes.length || !(services.data?.services ?? []).length)) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.03em]">Welcome to {fleet.name}</h1>
          <p className="mt-1 text-[13.5px] text-[var(--color-fg-muted)]">
            Two steps to something of your own running on hardware you control.
          </p>
        </div>
        <FirstRun
          fleet={fleet}
          nodes={all}
          services={services.data?.services ?? []}
          onChanged={() => services.refetch()}
        />
      </div>
    )
  }

  const offline = mapNodes.filter((n) => n.status === 'offline')
  const pinnedDown = mapNodes.flatMap((n) =>
    n.services.filter((s) => s.status === 'pinned_unavailable').map((s) => ({ node: n.name, service: s.name }))
  )
  const totalServices = mapNodes.reduce((sum, n) => sum + n.services.length, 0)

  // Declared but not running, and not already explained by a pinned node being down.
  const allServices = services.data?.services ?? []
  const broken = allServices.filter(
    (s) =>
      s.current?.status !== 'running' &&
      s.current?.status !== 'online' &&
      s.current?.status !== 'deploying' &&
      !pinnedDown.some((p) => p.service === s.name)
  )

  const canAlert = (alerts.data?.rules ?? []).some((r) => r.enabled)

  return (
    <div className="space-y-6">
      {/* ── Page Header with Fleet Context & Quick Actions ── */}
      {fleet && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--color-line)] pb-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--color-line)] bg-[var(--color-ink-900)] text-[var(--color-signal)] shadow-inner">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 2 7 12 12 22 7 12 2"/>
                <polyline points="2 17 12 22 22 17"/>
                <polyline points="2 12 12 17 22 12"/>
              </svg>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-[21px] font-semibold tracking-[-0.02em] text-[var(--color-fg)]">
                  {fleet.name}
                </h1>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-line)] bg-[var(--color-ink-900)] px-2.5 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      offline.length > 0 || broken.length > 0
                        ? 'bg-[var(--color-warn)] animate-pulse'
                        : 'bg-[var(--color-signal)]'
                    }`}
                  />
                  {offline.length > 0
                    ? `${offline.length} node offline`
                    : broken.length > 0
                    ? `${broken.length} service degraded`
                    : 'all systems operational'}
                </span>
              </div>
              <p className="mt-0.5 font-mono text-[11px] text-[var(--color-fg-dim)]">
                Fleet ID: <code className="text-[var(--color-fg-muted)]">{fleet.id}</code> · Heartbeat every {fleet.heartbeatIntervalSec}s
              </p>
            </div>
          </div>

          {/* Quick Actions Bar */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => navigate('/doctor')}
              className="flex items-center gap-1.5 text-[11px] py-1 px-2.5"
            >
              <span>🩺</span>
              <span>Fleet Doctor</span>
            </Button>
            <Button
              variant="ghost"
              onClick={() => navigate('/services')}
              className="flex items-center gap-1.5 text-[11px] py-1 px-2.5"
            >
              <span>📦</span>
              <span>Services</span>
            </Button>
            <Button
              variant="primary"
              onClick={() => window.dispatchEvent(new CustomEvent('fleet:open-palette'))}
              className="flex items-center gap-1.5 text-[11px] py-1 px-2.5"
            >
              <span>⚡</span>
              <span>Quick Actions</span>
              <kbd className="ml-1 rounded bg-black/30 px-1 py-0.5 font-mono text-[9px] text-[var(--color-fg-muted)]">⌘K</kbd>
            </Button>
          </div>
        </div>
      )}

      {/* What happened while you were away */}
      {fleet && <SinceYouLeft fleetId={fleet.id} />}

      {/* Warning if no alerts configured */}
      {alerts.data && !canAlert && (services.data?.services.length ?? 0) > 0 && (
        <div className="fade-up rounded-[4px] border border-[var(--color-warn)]/40 bg-[color-mix(in_oklab,var(--color-warn)_6%,var(--color-ink-950))] p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="text-[16px]">⚠️</span>
              <div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-warn)] font-medium">
                  no alert channels active
                </div>
                <p className="mt-1 text-[13px] text-[var(--color-fg-muted)]">
                  A node going down or deploy failing will not notify external channels. Configure Slack, Telegram, or Webhooks.
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              onClick={() => navigate('/alerts')}
              className="text-[11px] shrink-0 py-1 px-2.5"
            >
              Configure Alerts →
            </Button>
          </div>
        </div>
      )}

      {/* Something is wrong and nothing said so until you went looking */}
      {broken.length > 0 && (
        <div className="fade-up rounded-[4px] border border-[var(--color-down)]/40 bg-[color-mix(in_oklab,var(--color-down)_7%,var(--color-ink-950))] p-4 transition-all hover:border-[var(--color-down)]/70">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-down)] text-[var(--color-ink-950)] font-bold text-[12px]">
                !
              </div>
              <div>
                <div className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-down)]">
                  <span>{broken.length} service{broken.length === 1 ? '' : 's'} degraded</span>
                </div>
                <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--color-fg)]">
                  <span className="font-medium">
                    {broken.slice(0, 4).map((s) => s.name).join(', ')}
                  </span>
                  {broken.length > 4 && ` and ${broken.length - 4} more`}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-[var(--color-fg-muted)]">
                  {broken[0]?.last?.failureReason
                    ? broken[0].last.failureReason.split('\n')[0]?.slice(0, 120)
                    : 'Open Services or Fleet Doctor to diagnose root cause and apply auto-fix.'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 sm:self-center">
              <Button
                variant="danger"
                onClick={() => navigate('/doctor')}
                className="text-[11px] border-[var(--color-down)]/40 text-[var(--color-down)] hover:bg-[var(--color-down)]/10 py-1 px-2.5"
              >
                Run Doctor
              </Button>
              <Button
                variant="primary"
                onClick={() => navigate('/services')}
                className="text-[11px] py-1 px-2.5"
              >
                View Services →
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* What needs a human comes first, always */}
      {pinnedDown.length > 0 && (
        <div className="fade-up rounded-[4px] border-l-4 border-[var(--color-down)] bg-[color-mix(in_oklab,var(--color-down)_7%,transparent)] px-5 py-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-down)]">
            needs attention
          </div>
          {pinnedDown.map((p) => (
            <p key={p.service} className="mt-2 text-[14px] leading-relaxed">
              <span className="font-medium">{p.service}</span> is down and was{' '}
              <span className="text-[var(--color-down)]">not moved</span> — it is pinned to{' '}
              <span className="font-mono text-[13px]">{p.node}</span>.
              <span className="block text-[13px] text-[var(--color-fg-muted)]">
                Pinned services stay with their data. Bring that node back, or repin the service.
              </span>
            </p>
          ))}
        </div>
      )}

      {/* ── Fleet Summary Cards (Elevated Glassmorphism & High Contrast) ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Card 1: Nodes Online */}
        <div
          className={`stat-card rounded-[4px] p-4 ${
            offline.length ? 'stat-card-glow-warn' : 'stat-card-glow-ok'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[var(--color-fg-dim)]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-muted)]">
                Nodes Online
              </span>
            </div>
            <Dot tone={offline.length ? 'warn' : 'ok'} size={6} />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span
              className={`tabular text-[26px] font-bold tracking-[-0.03em] ${
                offline.length ? 'text-gradient-warn' : 'text-gradient-signal'
              }`}
            >
              {mapNodes.length - offline.length}
            </span>
            <span className="font-mono text-[13px] text-[var(--color-fg-dim)]">/ {mapNodes.length} total</span>
          </div>
          <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-[var(--color-fg-dim)]">
            <span>{offline.length ? `${offline.length} node offline` : 'All nodes responsive'}</span>
            <Link to="/nodes" className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors">
              view →
            </Link>
          </div>
        </div>

        {/* Card 2: Services Running */}
        <div
          className={`stat-card rounded-[4px] p-4 ${
            broken.length ? 'stat-card-glow-down' : 'stat-card-glow-ok'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[var(--color-fg-dim)]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.12 6.4-6.05-4.06a2 2 0 0 0-2.17-.05L2.95 8.41a2 2 0 0 0-.95 1.7v5.82a2 2 0 0 0 .95 1.7l9.95 6.08a2 2 0 0 0 2.1-.01l6.12-4.08a2 2 0 0 0 .88-1.69V8.08a2 2 0 0 0-.88-1.68Z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/></svg>
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-muted)]">
                Services Running
              </span>
            </div>
            <Dot tone={broken.length ? 'down' : 'ok'} size={6} />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span
              className={`tabular text-[26px] font-bold tracking-[-0.03em] ${
                broken.length ? 'text-[var(--color-down)]' : 'text-gradient-signal'
              }`}
            >
              {allServices.length ? allServices.length - broken.length : totalServices}
            </span>
            <span className="font-mono text-[13px] text-[var(--color-fg-dim)]">
              {allServices.length ? `/ ${allServices.length} deployed` : 'placed'}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between font-mono text-[10px]">
            <span className={broken.length ? 'text-[var(--color-down)] font-medium' : 'text-[var(--color-fg-dim)]'}>
              {broken.length ? `${broken.length} degraded` : '100% workloads active'}
            </span>
            <Link to="/services" className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors">
              manage →
            </Link>
          </div>
        </div>

        {/* Card 3: Unplaced Workloads */}
        <div
          className={`stat-card rounded-[4px] p-4 ${
            (map.data?.unplaced.length ?? 0) > 0 ? 'stat-card-glow-warn' : ''
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[var(--color-fg-dim)]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-muted)]">
                Unplaced
              </span>
            </div>
            <Dot tone={(map.data?.unplaced.length ?? 0) > 0 ? 'warn' : 'idle'} size={6} />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span
              className={`tabular text-[26px] font-bold tracking-[-0.03em] ${
                (map.data?.unplaced.length ?? 0) > 0 ? 'text-gradient-warn' : 'text-[var(--color-fg)]'
              }`}
            >
              {map.data?.unplaced.length ?? 0}
            </span>
            <span className="font-mono text-[12px] text-[var(--color-fg-dim)]">pending</span>
          </div>
          <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-[var(--color-fg-dim)]">
            <span>
              {(map.data?.unplaced.length ?? 0) > 0
                ? 'Requires placement'
                : 'Zero unassigned'}
            </span>
            {(map.data?.unplaced.length ?? 0) > 0 ? (
              <Link to="/services" className="text-[var(--color-warn)] font-medium hover:underline">
                place →
              </Link>
            ) : (
              <span className="text-[var(--color-fg-dim)]">optimal</span>
            )}
          </div>
        </div>

        {/* Card 4: Heartbeat & Telemetry */}
        <div className="stat-card rounded-[4px] p-4 stat-card-glow-ok">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[var(--color-signal)]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-muted)]">
                Heartbeat
              </span>
            </div>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-signal)]" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="tabular text-[26px] font-bold tracking-[-0.03em] text-gradient-signal">
              {fleet.heartbeatIntervalSec}s
            </span>
            <span className="font-mono text-[12px] text-[var(--color-fg-dim)]">cycle</span>
          </div>
          <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-[var(--color-fg-dim)]">
            <span>Tolerance: {fleet.heartbeatMissThreshold} misses</span>
            <span className="text-[var(--color-signal)]">healthy</span>
          </div>
        </div>
      </div>

      {/* ── Interactive Cluster Mesh Topology ── */}
      <Panel
        title="cluster mesh"
        right={
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] normal-case">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-signal)]" />
            live mesh telemetry
          </span>
        }
      >
        <ClusterMeshVisualizer
          mapNodes={mapNodes}
          nodes={all}
          fleetName={fleet.name}
          onSelectNode={() => navigate('/nodes')}
          onSelectService={(name) => {
            const match = allServices.find((s) => s.name === name)
            navigate(match ? `/services/${match.id}` : '/services')
          }}
        />
      </Panel>

      {/* ── Placement Map & Recent Activity ── */}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Placement map with Ring Gauges & Left Health Stripe */}
        <Panel
          title="placement map"
          right={<span className="font-mono text-[10px] normal-case text-[var(--color-fg-dim)]">{fleet.name} topology</span>}
        >
          <div className="grid gap-px bg-[var(--color-line)] [&>*]:min-h-full sm:grid-cols-2">
            {mapNodes.map((n) => {
              const node = all.find((x) => x.id === n.id)
              const used = n.ramMb - n.freeRamMb
              const isOffline = n.status === 'offline'
              const isHighLoad = (n.loadFactor ?? 0) > 0.85
              const stripeColor = isOffline
                ? 'border-l-[var(--color-down)]'
                : isHighLoad
                ? 'border-l-[var(--color-warn)]'
                : 'border-l-[var(--color-signal)]'

              return (
                <div
                  key={n.id}
                  className={`border-l-[3px] ${stripeColor} bg-[var(--color-ink-950)] p-5 transition-all duration-300 hover:bg-[color-mix(in_oklab,var(--color-ink-900)_50%,var(--color-ink-950))]`}
                  style={
                    isOffline
                      ? { background: 'color-mix(in oklab, var(--color-down) 6%, var(--color-ink-950))' }
                      : undefined
                  }
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        to="/nodes"
                        className="group flex items-center gap-2 font-mono text-[13px] font-medium text-[var(--color-fg)] hover:text-[var(--color-signal)] transition-colors"
                      >
                        <Dot tone={toneOf(n.status)} size={7} />
                        <span className="truncate">{n.name}</span>
                        <span className="text-[10px] text-[var(--color-fg-dim)] opacity-0 transition-opacity group-hover:opacity-100">→</span>
                      </Link>
                      <div className="mt-1 flex items-center gap-2 pl-[15px] font-mono text-[10px] text-[var(--color-fg-dim)]">
                        <span>{n.arch}</span>
                        <span>·</span>
                        <span className="capitalize">{n.reliabilityTier}</span>
                        {node?.hasGpu && (
                          <>
                            <span>·</span>
                            <span className="rounded bg-[color-mix(in_oklab,var(--color-signal)_15%,transparent)] px-1.5 py-0.2 font-semibold text-[var(--color-signal)]">
                              GPU
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] px-2 py-0.5 font-mono text-[9.5px] text-[var(--color-fg-muted)]">
                        <span>📦</span>
                        <span>{n.services.length}</span>
                      </span>
                      <StatusPill status={n.status} />
                    </div>
                  </div>

                  {/* Donut Gauges for RAM and CPU */}
                  <div className="mt-4 grid grid-cols-2 gap-3 border-y border-[var(--color-line)]/60 py-3">
                    <RingGauge
                      value={used}
                      max={n.ramMb}
                      label="RAM"
                      sublabel={`${mb(used)} / ${mb(n.ramMb)}`}
                      size={46}
                      strokeWidth={4}
                    />
                    <RingGauge
                      value={n.loadFactor ?? 0}
                      max={1}
                      label="CPU LOAD"
                      sublabel={pct(n.loadFactor)}
                      size={46}
                      strokeWidth={4}
                    />
                  </div>

                  {/* Workloads placed on this node */}
                  <div className="mt-3.5">
                    <div className="flex items-center justify-between text-[9px] font-mono uppercase tracking-[0.08em] text-[var(--color-fg-dim)] mb-2">
                      <span>Allocated Containers</span>
                      <span>{n.services.length} active</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {n.services.length ? (
                        n.services.map((s) => {
                          const match = allServices.find((x) => x.name === s.name)
                          const isPinnedWarn = s.status === 'pinned_unavailable'
                          return (
                            <button
                              key={s.name}
                              onClick={() => navigate(match ? `/services/${match.id}` : '/services')}
                              title={`Click to inspect service ${s.name} (${s.policy})`}
                              className={`inline-flex items-center gap-1.5 rounded-[3px] border px-2 py-1 font-mono text-[10px] transition-all hover:scale-[1.02] active:scale-[0.98] ${
                                isPinnedWarn
                                  ? 'border-[color-mix(in_oklab,var(--color-warn)_45%,var(--color-line))] bg-[color-mix(in_oklab,var(--color-warn)_9%,transparent)] text-[var(--color-warn)]'
                                  : 'border-[var(--color-line)] bg-[var(--color-ink-900)] text-[var(--color-fg-muted)] hover:border-[var(--color-line-2)] hover:text-[var(--color-fg)]'
                              }`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  isPinnedWarn ? 'bg-[var(--color-warn)]' : 'bg-[var(--color-signal)]'
                                }`}
                              />
                              <span>{s.name}</span>
                              <span className="text-[9px] text-[var(--color-fg-dim)]">
                                {s.policy === 'pinned' ? '📌' : ''}
                              </span>
                            </button>
                          )
                        })
                      ) : (
                        <div className="w-full rounded border border-dashed border-[var(--color-line)] py-2 text-center font-mono text-[10px] text-[var(--color-fg-dim)]">
                          ready for placement · zero workloads
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            <GridFiller count={mapNodes.length} />
          </div>
        </Panel>

        {/* ── Recent Activity / Event Timeline ── */}
        <Panel
          title="recent activity"
          right={
            <Link
              to="/events"
              className="font-mono text-[10.5px] normal-case text-[var(--color-fg-dim)] hover:text-[var(--color-signal)] transition-colors flex items-center gap-1"
            >
              <span>view all</span>
              <span>→</span>
            </Link>
          }
        >
          {events.data?.events.length ? (
            <div className="relative pl-6 pr-2 py-3">
              {/* Visual Timeline connector line */}
              <div className="absolute left-[23px] top-4 bottom-4 w-px bg-[var(--color-line)]" />

              <div className="space-y-4">
                {events.data.events.map((e, i) => {
                  const style = getEventIcon(e.reason)
                  return (
                    <div
                      key={`${e.at}-${i}`}
                      onClick={() => navigate('/events')}
                      className="group relative flex items-start gap-3 cursor-pointer rounded-[4px] p-2 -ml-2 transition-colors hover:bg-[var(--color-ink-900)]"
                    >
                      {/* Event Icon bullet */}
                      <div
                        className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] shadow-sm ${style.bg} ${style.border} ${style.color}`}
                      >
                        <span>{style.icon}</span>
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-[12px] font-medium text-[var(--color-fg)] group-hover:text-[var(--color-signal)] transition-colors">
                            {e.service}
                          </span>
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.2 font-mono text-[9px] uppercase tracking-[0.08em] font-medium ${
                              e.reason === 'failover'
                                ? 'bg-[color-mix(in_oklab,var(--color-warn)_15%,transparent)] text-[var(--color-warn)]'
                                : e.reason === 'deploy'
                                ? 'bg-[color-mix(in_oklab,var(--color-signal)_15%,transparent)] text-[var(--color-signal)]'
                                : 'bg-[var(--color-ink-850)] text-[var(--color-fg-muted)]'
                            }`}
                          >
                            {e.reason}
                          </span>
                        </div>

                        <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-[var(--color-fg-dim)]">
                          <span className="truncate">
                            {e.from ? (
                              <>
                                <span>{e.from}</span>
                                <span className="mx-1 text-[var(--color-fg-muted)]">→</span>
                                <span className="text-[var(--color-fg-muted)]">{e.to}</span>
                              </>
                            ) : (
                              <>
                                <span className="mr-1 text-[var(--color-fg-muted)]">placed on</span>
                                <span className="text-[var(--color-fg-muted)]">{e.to}</span>
                              </>
                            )}
                          </span>
                          <span className="shrink-0 ml-2">{since(e.at)}</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="px-4 py-8 text-center">
              <div className="mx-auto mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-ink-900)]">
                <span className="text-[14px] text-[var(--color-fg-dim)]">—</span>
              </div>
              <p className="font-mono text-[11px] text-[var(--color-fg-dim)]">no recent activity</p>
              <p className="mt-1 text-[10px] text-[var(--color-fg-dim)]">
                deploy, failover, and scale events will appear here
              </p>
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
