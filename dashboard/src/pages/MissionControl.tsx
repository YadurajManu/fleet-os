import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Fleet, type Node, type PlacementMapNode, type Service, type TimelineEvent } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, since } from '../lib/format'
import { missionHealth, nodeRegion, REGIONS, type RegionId } from '../lib/mission'
import { freshTelemetry } from '../lib/telemetry'
import { Button, Dot, Empty, ErrorNote, Panel, StatusPill } from '../components/ui'

type Layer = 'nodes' | 'traffic' | 'incidents'
type Traffic = { requests: number; errors: number; meanMs: number | null; series: { at: string; requests: number; errors: number }[] }

function Globe({ nodes, layer, selected, onSelect, traffic }: {
  nodes: Node[]
  layer: Layer
  selected: RegionId | null
  onSelect: (region: RegionId | null) => void
  traffic: Traffic | null
}) {
  const peakRequests = Math.max(1, ...traffic?.series.map(point => point.requests) ?? [])
  return (
    <div className="relative min-h-[350px] overflow-hidden bg-[var(--color-ink-950)] grid-bg sm:min-h-[420px]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-[var(--color-ink-900)] to-transparent" />
      <svg viewBox="0 0 720 400" className="absolute inset-0 h-full w-full" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
        <defs>
          <clipPath id="mission-earth"><ellipse cx="360" cy="200" rx="290" ry="164" /></clipPath>
          <radialGradient id="mission-ocean"><stop stopColor="#10231d" /><stop offset="0.7" stopColor="#0b1715" /><stop offset="1" stopColor="#080d0e" /></radialGradient>
        </defs>
        <ellipse cx="360" cy="200" rx="296" ry="170" fill="none" stroke="#1b4232" strokeWidth="1" opacity=".6" />
        <ellipse cx="360" cy="200" rx="290" ry="164" fill="url(#mission-ocean)" stroke="#29533e" strokeWidth="1.2" />
        <g clipPath="url(#mission-earth)" fill="none" stroke="#3fe08b" opacity=".11">
          {[80, 140, 200, 260, 320].map(y => <ellipse key={y} cx="360" cy={y} rx="290" ry="25" />)}
          {[160, 260, 360, 460, 560].map(x => <ellipse key={x} cx={x} cy="200" rx="49" ry="164" />)}
          <path d="M70 200h580" />
        </g>
        <g clipPath="url(#mission-earth)" fill="#17392c" stroke="#286649" strokeWidth=".7" opacity=".66">
          <path d="M139 98l44-24 42 9 20 22 35 7-12 23-23 5-18 29-21 4-10 36-19-6-12-34-21-4-14-30z" />
          <path d="M231 208l32 7 26 24 6 29-20 22-12 49-20-11-10-40-19-30z" />
          <path d="M340 111l39-15 34 15 5 26-22 18-36-5-24-18z" />
          <path d="M361 164l49-2 29 27-6 50-34 59-30-21-13-52-17-25z" />
          <path d="M419 93l53-16 71 8 42 22 26 33-19 28-42-7-36 22-18 36-31-9-8-32-30-5-16-35z" />
          <path d="M542 248l46-6 28 21-4 38-40 14-40-21z" />
        </g>
      </svg>
      {layer === 'traffic' ? (
        <div className="absolute inset-x-6 bottom-6 border border-[var(--color-line-2)] bg-[var(--color-ink-900)]/95 p-4 text-sm text-[var(--color-fg-muted)] sm:left-1/2 sm:w-[330px] sm:-translate-x-1/2">
          <p className="font-medium text-[var(--color-fg)]">Ingress · last 60 minutes</p>
          <p className="mt-1">{traffic ? `${traffic.requests.toLocaleString()} completed requests · ${traffic.errors.toLocaleString()} server errors · ${traffic.meanMs ?? '—'} ms mean` : 'Traffic metrics unavailable'}</p>
          {traffic && <div className="mt-3 flex h-12 items-end gap-px" aria-label="Request volume by minute">{traffic.series.map(point => <div key={point.at} title={`${point.at}: ${point.requests} requests`} className={`min-w-0 flex-1 ${point.errors ? 'bg-[var(--color-warn)]' : 'bg-[var(--color-signal)]'}`} style={{ height: `${Math.max(2, point.requests / peakRequests * 100)}%` }} />)}</div>}
          <p className="mt-2 text-[11px]">Fleet totals only. Request origin is not collected.</p>
        </div>
      ) : REGIONS.map(region => {
        const members = nodes.filter(node => nodeRegion(node) === region.id)
        if (!members.length) return null
        const problem = members.some(node => !node.live)
        return <button key={region.id} type="button" aria-label={`${region.label}: ${members.length} node${members.length === 1 ? '' : 's'}`} onClick={() => onSelect(selected === region.id ? null : region.id)}
          className={`absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 border px-2 py-1 font-mono text-[10px] shadow-lg transition-colors ${selected === region.id ? 'border-[var(--color-fg)] bg-[var(--color-ink-800)]' : 'border-[var(--color-line-2)] bg-[var(--color-ink-900)]/95 hover:border-[var(--color-signal)]'}`}
          style={{ left: `${region.x}%`, top: `${region.y}%` }}>
          <Dot tone={problem ? 'down' : 'ok'} size={6} /><span>{members.length}</span><span className="hidden text-[var(--color-fg-muted)] lg:inline">{region.label}</span>
        </button>
      })}
      <div className="absolute bottom-4 left-4 flex items-center gap-2 border border-[var(--color-line)] bg-[var(--color-ink-900)]/95 px-3 py-2 font-mono text-[10px] text-[var(--color-fg-muted)]">
        <Dot tone={layer === 'incidents' && nodes.some(node => !node.live) ? 'down' : 'ok'} size={5} /> Approximate regions · set by fleet admins
      </div>
    </div>
  )
}

function Metric({ label, value, detail, href, tone = 'normal' }: {
  label: string; value: string; detail: string; href: string; tone?: 'normal' | 'warn' | 'down'
}) {
  return <Link to={href} className="block border border-[var(--color-line)] bg-[var(--color-ink-900)] p-4 transition-colors hover:border-[var(--color-line-2)]">
    <p className="mono-label">{label}</p>
    <p className={`mt-3 text-3xl font-semibold tracking-tight tabular-nums ${tone === 'down' ? 'text-[var(--color-down)]' : tone === 'warn' ? 'text-[var(--color-warn)]' : ''}`}>{value}</p>
    <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{detail}</p>
  </Link>
}

export default function MissionControl() {
  const { fleet, email } = useAuth()
  return <MissionPage key={`${email}:${fleet?.id}`} fleet={fleet} account={email} />
}

function MissionPage({ fleet, account }: { fleet: Fleet | null; account: string | null }) {
  const id = fleet?.id
  const nodeUrl = id ? `/fleets/${id}/nodes` : null
  const serviceUrl = id ? `/fleets/${id}/services` : null
  const eventUrl = id ? `/fleets/${id}/events?limit=12` : null
  const mapUrl = id ? `/fleets/${id}/placement-map` : null
  const trafficUrl = id ? `/fleets/${id}/traffic?minutes=60` : null
  const nodes = usePoll(() => api<{ nodes: Node[] }>(nodeUrl!), nodeUrl && account ? `${account}:${nodeUrl}` : null, 10_000)
  const services = usePoll(() => api<{ services: Service[] }>(serviceUrl!), serviceUrl && account ? `${account}:${serviceUrl}` : null, 10_000)
  const events = usePoll(() => api<{ events: TimelineEvent[] }>(eventUrl!), eventUrl && account ? `${account}:${eventUrl}` : null, 15_000)
  const map = usePoll(() => api<{ nodes: PlacementMapNode[]; unplaced: string[] }>(mapUrl!), mapUrl && account ? `${account}:${mapUrl}` : null, 15_000)
  const traffic = usePoll(() => api<Traffic>(trafficUrl!), trafficUrl && account ? `${account}:${trafficUrl}` : null, 15_000)
  const control = usePoll(() => api<{ status: 'ok' | 'degraded'; postgres: boolean; redis: boolean }>('/healthz', { auth: false }), account ? `${account}:/healthz` : null, 15_000)
  const [layer, setLayer] = useState<Layer>('nodes')
  const [selected, setSelected] = useState<RegionId | null>(null)
  const [savingNode, setSavingNode] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<Error | null>(null)

  if (!fleet || !id) return <Empty title="Select a fleet to open Mission Control" />
  const allNodes = nodes.error ? [] : nodes.data?.nodes ?? []
  const allServices = services.error ? [] : services.data?.services ?? []
  const maxAgeMs = fleet.heartbeatIntervalSec * fleet.heartbeatMissThreshold * 1000
  const health = missionHealth(allNodes, allServices, maxAgeMs)
  const ready = Boolean(nodes.data && services.data && !nodes.error && !services.error)
  const mapped = allNodes.filter(node => nodeRegion(node))
  const visibleNodes = selected ? allNodes.filter(node => nodeRegion(node) === selected) : allNodes
  const unplaced = map.error ? [] : map.data?.unplaced ?? []
  const capacity = allNodes.filter(node => node.live && node.effectiveMemBytes && node.effectiveMemBytes > 0)
    .reduce((sum, node) => sum + node.effectiveMemBytes! / 1048576, 0)
  const reserved = allServices.filter(service => ['running', 'deploying'].includes(service.current?.status ?? ''))
    .reduce((sum, service) => sum + service.requestRamMb, 0)
  const canManage = fleet.role === 'admin' || fleet.role === 'owner'

  async function setRegion(node: Node, region: string) {
    setSavingNode(node.id)
    setSaveError(null)
    try {
      await api(`/fleets/${id}/nodes/${node.id}/region`, { method: 'PATCH', body: { region: region || null } })
      nodes.refetch()
    } catch (error) {
      setSaveError(error instanceof Error ? error : new Error('Could not save region'))
    } finally {
      setSavingNode(null)
    }
  }

  return <div className="space-y-6 pb-10">
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-line)] pb-5">
      <div>
        <p className="mono-label mb-2 text-[var(--color-signal)]">Fleet / Mission Control</p>
        <h1 className="text-3xl font-semibold tracking-[-0.04em]">{fleet.name}</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{ready ? health.issues.length ? `${health.issues.length} items need attention` : 'No reported incidents' : 'Waiting for fleet status'} · Latest heartbeat {health.latestHeartbeat ? since(health.latestHeartbeat) : 'unavailable'}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3"><span className="font-mono text-[11px] text-[var(--color-fg-muted)]"><Dot tone={control.error || control.data?.status === 'degraded' ? 'down' : control.data?.status === 'ok' ? 'ok' : 'idle'} size={6} /> {control.error ? 'Control plane unreachable' : control.data?.status === 'ok' ? 'Control plane ready' : control.data?.status === 'degraded' ? 'Control plane degraded' : 'Control plane unknown'}</span><span className="font-mono text-[11px] text-[var(--color-fg-muted)]"><Dot tone={ready && health.fresh.length ? 'ok' : 'idle'} size={6} /> {ready && health.fresh.length ? `${health.fresh.length} fresh node${health.fresh.length === 1 ? '' : 's'}` : 'Telemetry unknown'}</span><Button onClick={() => { nodes.refetch(); services.refetch(); events.refetch(); map.refetch(); traffic.refetch(); control.refetch() }}>Refresh</Button></div>
    </header>

    {nodes.error && <ErrorNote error={nodes.error} />}
    {services.error && <ErrorNote error={services.error} />}
    {map.error && <ErrorNote error={map.error} />}
    {traffic.error && <ErrorNote error={traffic.error} />}
    {saveError && <ErrorNote error={saveError} />}
    {!nodes.data && !services.data && !nodes.error && !services.error && <div className="border border-[var(--color-line)] p-8 text-sm text-[var(--color-fg-muted)]">Loading fleet signals…</div>}

    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Services serving" value={ready ? `${health.running.length} / ${allServices.length}` : '—'} detail={ready ? `${health.deploying.length} deploying` : 'Status unavailable'} href="/services" tone={health.notRunning.length ? 'warn' : 'normal'} />
      <Metric label="Nodes reachable" value={ready ? `${health.reachable.length} / ${allNodes.length}` : '—'} detail={ready ? `${health.fresh.length} with fresh telemetry` : 'Status unavailable'} href="/nodes" tone={health.offline.length ? 'down' : 'normal'} />
      <Metric label="Needs attention" value={ready && !map.error ? String(health.issues.length + unplaced.length) : '—'} detail={ready ? `${health.atRisk.length} services on unreachable nodes` : 'Status unavailable'} href="/doctor" tone={health.issues.length ? 'warn' : 'normal'} />
      <Metric label="Memory reserved" value={ready && capacity ? `${Math.round(reserved / capacity * 100)}%` : '—'} detail={capacity ? `${mb(reserved)} / ${mb(Math.round(capacity))} Docker-effective` : 'Effective capacity unavailable'} href="/nodes" tone={capacity && reserved > capacity ? 'warn' : 'normal'} />
    </div>

    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(290px,1fr)]">
      <Panel title="Earth view" right={<span>{mapped.length} / {allNodes.length} mapped</span>}>
        <div className="flex gap-1 border-b border-[var(--color-line)] p-2">
          {(['nodes', 'incidents', 'traffic'] as Layer[]).map(item => <button key={item} type="button" onClick={() => { setLayer(item); setSelected(null) }} className={`px-3 py-1.5 font-mono text-[11px] capitalize ${layer === item ? 'bg-[var(--color-ink-800)] text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}>{item}</button>)}
        </div>
        <Globe nodes={ready ? allNodes : []} layer={layer} selected={selected} onSelect={setSelected} traffic={traffic.error ? null : traffic.data ?? null} />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-line)] px-4 py-3 text-xs text-[var(--color-fg-muted)]"><span>{selected ? `${REGIONS.find(region => region.id === selected)?.label} selected` : `${allNodes.length - mapped.length} unmapped node${allNodes.length - mapped.length === 1 ? '' : 's'}`}</span>{selected && <button type="button" onClick={() => setSelected(null)} className="text-[var(--color-signal)]">Show all regions</button>}</div>
      </Panel>
      <Panel title="Needs attention" right={<Link to="/doctor" className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">Open Doctor →</Link>}>
        {ready && !map.error && !health.issues.length && !unplaced.length ? <p className="p-5 text-sm text-[var(--color-fg-muted)]">No issue reported by current fleet data.</p> : null}
        <div className="max-h-[500px] divide-y divide-[var(--color-line)] overflow-y-auto">
          {ready && health.issues.slice(0, 8).map(issue => <Link key={issue.id} to={issue.href} className="block p-4 hover:bg-[var(--color-ink-800)]"><p className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-warn)]">{issue.kind}</p><p className="mt-1 text-sm font-medium">{issue.label}</p><p className="mt-1 line-clamp-2 text-xs text-[var(--color-fg-muted)]">{issue.detail}</p></Link>)}
          {unplaced.map(name => <Link key={name} to="/services" className="block p-4 text-sm hover:bg-[var(--color-ink-800)]"><span className="font-mono text-[10px] uppercase text-[var(--color-warn)]">Awaiting placement</span><br />{name}</Link>)}
          {!ready && <p className="p-5 text-sm text-[var(--color-fg-muted)]">Status unavailable; no healthy state is assumed.</p>}
        </div>
      </Panel>
    </div>

    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(290px,1fr)]">
      <Panel title="Nodes by region" right={<Link to="/nodes" className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">All nodes →</Link>}>
        {!allNodes.length && ready ? <p className="p-5 text-sm text-[var(--color-fg-muted)]">Pair a node to see it here.</p> : null}
        <div className="divide-y divide-[var(--color-line)]">
          {visibleNodes.map(node => {
            const sample = freshTelemetry(node, maxAgeMs)
            const region = nodeRegion(node)
            return <div key={node.id} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_100px_100px_165px] sm:items-center">
              <div className="min-w-0"><Link to={`/nodes/${node.id}`} className="truncate text-sm font-medium hover:text-[var(--color-signal)]">{node.name}</Link><p className="mt-1 font-mono text-[10px] text-[var(--color-fg-dim)]">{node.platform || `${node.os}/${node.arch}`} · heartbeat {since(node.lastHeartbeatAt)}</p></div>
              <StatusPill status={node.live ? node.status : 'offline'} />
              <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">{sample ? `${Math.round(sample.cpuPct)}% load` : 'load unknown'}</span>
              {canManage ? <select aria-label={`Region for ${node.name}`} value={region ?? ''} disabled={savingNode === node.id} onChange={event => void setRegion(node, event.target.value)} className="w-full border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-2 py-2 font-mono text-[10px] text-[var(--color-fg)]"><option value="">Unmapped</option>{REGIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select> : <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">{REGIONS.find(item => item.id === region)?.label ?? 'Unmapped'}</span>}
            </div>
          })}
        </div>
      </Panel>
      <Panel title="Recent placement activity" right={<Link to="/events" className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">All events →</Link>}>
        {events.error && <div className="p-4"><ErrorNote error={events.error} /></div>}
        {!events.error && events.data?.events.length === 0 && <p className="p-5 text-sm text-[var(--color-fg-muted)]">No placement events yet.</p>}
        <div className="max-h-[480px] divide-y divide-[var(--color-line)] overflow-y-auto">{!events.error && events.data?.events.map((event, index) => <div key={`${event.at}-${event.service}-${index}`} className="p-4"><p className="text-sm">{event.service} <span className="text-[var(--color-fg-muted)]">· {event.reason}</span></p><p className="mt-1 font-mono text-[10px] text-[var(--color-fg-dim)]">{event.from ?? 'unplaced'} → {event.to ?? 'unplaced'} · {since(event.at)}</p></div>)}</div>
      </Panel>
    </div>
    <p className="border-t border-[var(--color-line)] pt-4 font-mono text-[10px] leading-relaxed text-[var(--color-fg-dim)]">Mission Control uses agent heartbeats, deployment records, and completed ingress requests. Region locations are approximate and owner-supplied. Geographic request origin and external availability are not measured.</p>
  </div>
}
