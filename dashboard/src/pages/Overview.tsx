import { freshTelemetry, loadRatio, serviceCounts } from '../lib/telemetry'
import { helpFor } from '../lib/failureReasons'
import { Link, useNavigate } from 'react-router-dom'
import { api, type Node, type PlacementMapNode, type Service, type TimelineEvent } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, since, toneOf } from '../lib/format'
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

  const allServices = services.data?.services ?? []
  const { running, deploying, attention } = serviceCounts(allServices)
  const maxAgeMs = fleet.heartbeatIntervalSec * fleet.heartbeatMissThreshold * 1000
  const fresh = all.filter(n => freshTelemetry(n, maxAgeMs))
  const reachable = all.filter(n => n.live)
  const unavailable = Boolean(nodes.error || services.error || !nodes.data || !services.data)
  const canAlert = (alerts.data?.rules ?? []).some(r => r.enabled)
  const latestSample = all.map(n => n.lastHeartbeatAt).filter((at): at is string => Boolean(at)).sort().at(-1)

  return (
    <div className="overview-page space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-line)] pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{fleet.name}</h1>
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
            {unavailable ? 'Fleet status unavailable' : attention.length ? `${attention.length} services need attention` : deploying.length ? `${deploying.length} services deploying` : 'No deployment issues reported'}
            {' · '}{nodes.error ? 'Telemetry refresh failed' : latestSample ? `Latest heartbeat ${since(latestSample)}` : 'Waiting for heartbeat'}
          </p>
          <details className="mt-2 text-xs text-[var(--color-fg-dim)]"><summary className="cursor-pointer">Fleet details</summary><p className="mt-2">ID: <code>{fleet.id}</code> · Expected heartbeat every {fleet.heartbeatIntervalSec}s</p></details>
        </div>
        <div className="flex gap-2"><Button variant="ghost" onClick={() => navigate('/doctor')}>Fleet Doctor</Button><Button onClick={() => navigate('/services')}>View services →</Button></div>
      </header>
      {nodes.data && services.data && !nodes.error && !services.error &&
        (!all.length || !allServices.length) && (
          <FirstRun
            key={`setup-${fleet.id}`}
            fleet={fleet}
            nodes={all}
            services={allServices}
            onChanged={() => services.refetch()}
          />
        )}
      {nodes.error && <ErrorNote error={nodes.error} />}
      {services.error && <ErrorNote error={services.error} />}

      {attention.length > 0 && <Panel title="Needs attention" right={<span className="text-[var(--color-warn)]">{attention.length} services</span>}>
        <ul className="divide-y divide-[var(--color-line)]">
          {attention.map(service => {
            const reason = service.last?.failureReason
            const help = helpFor(reason)
            const pinned = service.current?.status === 'pinned_unavailable' || reason?.startsWith('node_down_pinned')
            return <li key={service.id} className="flex flex-wrap items-start justify-between gap-4 p-5">
              <div className="min-w-0 flex-1">
                <Link to={`/services/${service.id}`} className="font-medium underline-offset-4 hover:underline">{service.name}</Link>
                <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{pinned ? 'The service is pinned to an unavailable node.' : help?.what ?? (service.last ? 'The latest deployment is not running. Review its status and logs.' : 'This service has not been deployed.')}</p>
                <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{pinned ? 'Check the node and its storage before changing placement.' : help?.next ?? 'Open service details to review the next step.'}</p>
                {reason && <details className="mt-2 text-xs text-[var(--color-fg-dim)]"><summary className="cursor-pointer">Technical reason</summary><p className="mt-1 break-words font-mono">{reason}</p></details>}
              </div>
              <Link to={`/services/${service.id}`} className="shrink-0 text-sm text-[var(--color-signal)] underline underline-offset-4">Review service →</Link>
            </li>
          })}
        </ul>
      </Panel>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Services running', value: services.error || !services.data ? '—' : `${running.length} / ${allServices.length}`, detail: `${deploying.length} deploying · deployment state, not health checks`, to: '/services' },
          { label: 'Nodes reachable', value: nodes.error || !nodes.data ? '—' : `${reachable.length} / ${all.length}`, detail: 'Agent heartbeat reachability', to: '/nodes' },
          { label: 'Unplaced workloads', value: String(map.data?.unplaced.length ?? 0), detail: 'Awaiting a placement decision', to: '/services' },
          { label: 'Fresh telemetry', value: nodes.error || !nodes.data ? '—' : `${fresh.length} / ${all.length}`, detail: `Samples within ${maxAgeMs / 1000}s · unavailable is not zero`, to: '/nodes' },
        ].map(card => <Link key={card.label} to={card.to} className="rounded border border-[var(--color-line)] bg-[var(--color-ink-900)] p-5 hover:border-[var(--color-line-2)]">
          <p className="text-sm text-[var(--color-fg-muted)]">{card.label}</p><p className="mt-3 text-3xl font-semibold tabular-nums">{card.value}</p><p className="mt-2 text-xs leading-relaxed text-[var(--color-fg-muted)]">{card.detail}</p>
        </Link>)}
      </div>
      {map.data?.unplaced.length ? <p className="text-sm text-[var(--color-warn)]">Awaiting placement: {map.data.unplaced.join(', ')}. <Link className="underline" to="/services">Review services</Link></p> : null}

      {/* ── Placement Map & Recent Activity ── */}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Placement map with Ring Gauges & Left Health Stripe */}
        <Panel
          title="Nodes and capacity"
          right={<span className="font-mono text-[10px] normal-case text-[var(--color-fg-dim)]">{fleet.name} topology</span>}
        >
          <div className="grid gap-px bg-[var(--color-line)] [&>*]:min-h-full sm:grid-cols-2">
            {mapNodes.map((n) => {
              const node = all.find((x) => x.id === n.id)
              const used = n.ramMb - n.freeRamMb
              const sample = node && !nodes.error ? freshTelemetry(node, maxAgeMs) : null
              const isOffline = n.status === 'offline'
              const isHighLoad = sample ? (loadRatio(sample.cpuPct) ?? 0) > 0.85 : false
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
                        to={`/nodes/${n.id}`}
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
                      label="Fleet memory reserved"
                      sublabel={`${mb(used)} / ${mb(n.ramMb)}`}
                      size={46}
                      strokeWidth={4}
                    />
                    <RingGauge
                      value={sample ? loadRatio(sample.cpuPct) : null}
                      max={1}
                      label="Normalized load"
                      sublabel={sample ? `1m load / cores · ${since(node?.lastHeartbeatAt)}` : 'Unavailable or stale'}
                      size={46}
                      strokeWidth={4}
                    />
                  </div>

                  <p className="mt-3 text-sm text-[var(--color-fg-muted)]">Host memory used: {sample ? `${mb(sample.ramUsedMb)} / ${mb(n.ramMb)}` : 'Unavailable or stale'}</p>
                  {/* Workloads placed on this node */}
                  <div className="mt-3.5">
                    <div className="flex items-center justify-between text-[9px] font-mono uppercase tracking-[0.08em] text-[var(--color-fg-dim)] mb-2">
                      <span>Placed services</span>
                      <span>{n.services.length} placed</span>
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
      {/* ── Interactive Cluster Mesh Topology ── */}
      <Panel
        title="Topology"
        right={<span className="text-xs text-[var(--color-fg-muted)]">Connections · select a node for details</span>}
      >
        <ClusterMeshVisualizer
          mapNodes={mapNodes}
          nodes={nodes.error ? [] : all}
          maxAgeMs={maxAgeMs}
          fleetName={fleet.name}
          onSelectNode={(nodeId) => navigate(`/nodes/${nodeId}`)}
          onSelectService={(name) => {
            const match = allServices.find((s) => s.name === name)
            navigate(match ? `/services/${match.id}` : '/services')
          }}
        />
      </Panel>

      <SinceYouLeft key={fleet.id} fleetId={fleet.id} />
      {alerts.data && !canAlert && <p className="text-sm text-[var(--color-fg-muted)]">External notifications are not configured. <Link to="/alerts" className="underline underline-offset-4">Configure email, Slack, Discord or webhook delivery</Link></p>}
    </div>
  )
}
