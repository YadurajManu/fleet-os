import { useMemo, useState } from 'react'
import { geoEqualEarth, geoPath, geoCentroid } from 'd3-geo'
import { feature } from 'topojson-client'
import atlas from 'world-atlas/countries-110m.json'
import countries from 'world-countries'
import { api } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'

type Count = { day: string; count: number }
type Summary = {
  days: number
  counts: Record<string, number>
  activation: Record<string, number>
  health: Record<string, number>
  geography: Array<{ country: string; users: number }>
  nodePlatforms: Array<{ platform: string; nodes: number }>
  trends: { signups: Count[]; deployments: Count[]; builds: Count[] }
  storage: { databaseBytes: string; registryBytes: null; networkBytes: null }
}
type OpsUser = { id: string; email: string; createdAt: string; verified: boolean; organizations: number; country: string; lastSeen: string | null }
type OpsUserDetail = OpsUser & { fleets: number; nodes: number; services: number; deployments: number }
type OpsNode = { id: string; name: string; platform: string | null; agentVersion: string | null; lastHeartbeatAt: string | null; organization: string; fleet: string; country: null; diskUsedMb: number | null; diskTotalMb: number | null; netRxKbps: number | null; netTxKbps: number | null }

const countryByNumeric = new Map(countries.map((country) => [country.ccn3, country]))
const countryByCode = new Map(countries.map((country) => [country.cca2, country.name.common]))
const shapes = feature(atlas as unknown as Parameters<typeof feature>[0], (atlas as unknown as { objects: { countries: Parameters<typeof feature>[1] } }).objects.countries)
const features = shapes.type === 'FeatureCollection' ? shapes.features : [shapes]
const projection = geoEqualEarth().fitExtent([[16, 16], [984, 476]], shapes)
const path = geoPath(projection)

function ago(value: string | null) {
  if (!value) return 'never'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`
}
function bytes(value: string | null) {
  if (!value) return 'Not measured'
  const n = Number(value)
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`
}
function Metric({ label, value, note }: { label: string; value: number | string | undefined; note?: string }) {
  return <div className="border border-[var(--color-line-2)] bg-[var(--color-ink-900)] p-4">
    <p className="font-mono text-[10px] uppercase tracking-[.16em] text-[var(--color-fg-dim)]">{label}</p>
    <p className="mt-3 text-[26px] font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">{value ?? '—'}</p>
    {note && <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">{note}</p>}
  </div>
}
function Trend({ title, values, days }: { title: string; values: Count[]; days: number }) {
  const points = useMemo(() => {
    const byDay = new Map(values.map((row) => [row.day.slice(0, 10), row.count]))
    return Array.from({ length: days }, (_, i) => {
      const date = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10)
      return { day: date, count: byDay.get(date) ?? 0 }
    })
  }, [values, days])
  const peak = Math.max(1, ...points.map((p) => p.count))
  return <div className="border border-[var(--color-line-2)] bg-[var(--color-ink-900)] p-4">
    <div className="flex justify-between"><h3 className="font-mono text-[11px] text-[var(--color-fg)]">{title}</h3><span className="font-mono text-[11px] text-[var(--color-signal)]">{points.reduce((sum, p) => sum + p.count, 0)}</span></div>
    <svg className="mt-4 h-24 w-full" viewBox="0 0 600 96" role="img" aria-label={`${title} over ${days} days`} preserveAspectRatio="none">
      <path d={`M ${points.map((p, i) => `${(i * 600) / Math.max(1, points.length - 1)},${88 - p.count / peak * 76}`).join(' L ')}`} fill="none" stroke="var(--color-signal)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <line x1="0" y1="88" x2="600" y2="88" stroke="var(--color-line-2)" />
    </svg>
    <p className="mt-1 font-mono text-[10px] text-[var(--color-fg-dim)]">{days} days · daily count</p>
  </div>
}
function WorldMap({ geography }: { geography: Summary['geography'] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const counts = new Map(geography.map((row) => [row.country.toUpperCase(), row.users]))
  const max = Math.max(1, ...geography.map((row) => row.users))
  const unknown = counts.get('UNKNOWN') ?? 0
  return <div className="border border-[var(--color-line-2)] bg-[var(--color-ink-900)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-mono text-[12px] text-[var(--color-fg)]">Account geography</h2><span className="font-mono text-[10px] text-[var(--color-fg-dim)]">LATEST SESSION COUNTRY · NOT EXACT LOCATION</span></div>
    <svg viewBox="0 0 1000 492" className="mt-4 w-full" role="img" aria-label="World map showing users by country">
      <defs><pattern id="ops-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--color-line)" strokeWidth=".6" /></pattern></defs>
      <rect width="1000" height="492" fill="url(#ops-grid)" />
      {features.map((country, index) => {
        const id = String(country.id ?? '').padStart(3, '0')
        const meta = countryByNumeric.get(id)
        const code = meta?.cca2 ?? ''
        const count = counts.get(code) ?? 0
        const centroid = projection(geoCentroid(country))
        return <g key={`${id}-${index}`}>
          <path d={path(country) ?? ''} fill={count ? `color-mix(in srgb, var(--color-signal) ${20 + Math.round(55 * count / max)}%, var(--color-ink-800))` : 'var(--color-ink-800)'} stroke="var(--color-line-2)" strokeWidth=".7" vectorEffect="non-scaling-stroke" role="button" tabIndex={0} aria-label={`${meta?.name.common ?? code}: ${count} users`} onClick={() => setSelected(code)} onKeyDown={(event) => { if (event.key === 'Enter') setSelected(code) }} className="cursor-pointer focus:outline-[var(--color-signal)]"><title>{meta?.name.common ?? code}: {count} users</title></path>
          {count > 0 && centroid && <circle cx={centroid[0]} cy={centroid[1]} r={Math.min(10, 3 + Math.sqrt(count) * 2)} fill="var(--color-signal)" fillOpacity=".8" stroke="var(--color-ink-950)" strokeWidth="1.5"><title>{meta?.name.common ?? code}: {count} user{count === 1 ? '' : 's'}</title></circle>}
        </g>
      })}
    </svg>
    <div className="flex flex-wrap gap-2 font-mono text-[11px]">
      {geography.filter((row) => row.country !== 'unknown').slice(0, 12).map((row) => <button key={row.country} onClick={() => setSelected(row.country)} className="border border-[var(--color-line-2)] px-2 py-1 text-[var(--color-fg-muted)] hover:text-[var(--color-signal)]">{countryByCode.get(row.country.toUpperCase()) ?? row.country} · {row.users}</button>)}
      {unknown > 0 && <span className="px-2 py-1 text-[var(--color-fg-dim)]">Unknown · {unknown}</span>}
    </div>
    <p className="mt-3 text-[11px] text-[var(--color-fg-muted)]">{selected ? `${countryByCode.get(selected.toUpperCase()) ?? selected} is an approximate sign-in country, not a live position.` : 'Select a country to inspect the aggregate. Nodes have no recorded location and are not plotted.'}</p>
  </div>
}

export default function Ops() {
  const { signOut } = useAuth()
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const summary = usePoll(() => api<Summary>(`/ops/summary?days=${days}`), `/ops/summary?days=${days}`, 60_000)
  const users = usePoll(() => api<{ users: OpsUser[] }>(`/ops/users?q=${encodeURIComponent(query)}&page=${page}`), `/ops/users?q=${encodeURIComponent(query)}&page=${page}`, 30_000)
  const nodes = usePoll(() => api<{ nodes: OpsNode[] }>('/ops/nodes'), '/ops/nodes', 30_000)
  const userDetail = usePoll(() => selectedUserId ? api<{ user: OpsUserDetail }>(`/ops/users/${selectedUserId}`) : Promise.resolve(null), selectedUserId ?? 'no-user-selected', 60_000)
  const data = summary.data
  return <div className="min-h-screen bg-[var(--color-ink-950)] text-[var(--color-fg)]">
    <header className="sticky top-0 z-20 border-b border-[var(--color-line)] bg-[var(--color-ink-950)]/95 px-5 py-4 backdrop-blur"><div className="mx-auto flex max-w-[1500px] items-center justify-between"><div><span className="font-mono text-[10px] tracking-[.25em] text-[var(--color-signal)]">FLEET · INTERNAL</span><h1 className="text-xl font-semibold">Operations</h1></div><div className="flex items-center gap-4"><span className="font-mono text-[11px] text-[var(--color-fg-muted)]">Platform-wide · read only</span><button onClick={signOut} className="font-mono text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">Sign out</button></div></div></header>
    <main className="mx-auto max-w-[1500px] space-y-7 px-5 py-7">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-[22px] font-semibold">Mission overview</h2><p className="text-[12px] text-[var(--color-fg-muted)]">Observed activity and health across every organization.</p></div><div className="flex border border-[var(--color-line-2)]">{([7, 30, 90] as const).map((range) => <button key={range} onClick={() => setDays(range)} className={`px-3 py-2 font-mono text-[11px] ${days === range ? 'bg-[var(--color-signal)] text-[var(--color-ink-950)]' : 'text-[var(--color-fg-muted)]'}`}>{range}d</button>)}</div></div>
      {summary.error && <p role="alert" className="text-[var(--color-down)]">Could not load platform metrics: {String(summary.error)}</p>}
      <section aria-label="Growth" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Verified accounts" value={data?.counts.verified_users} note={`${data?.counts.newly_verified ?? '—'} newly verified`} /><Metric label="Active organizations" value={data?.counts.active_organizations} note="With a deployment in this period" /><Metric label="Fleets" value={data?.counts.fleets} note={`${data?.counts.new_fleets ?? '—'} created in period`} /><Metric label="Running releases" value={data?.counts.fleets_with_running_release} note="Fleets with a running deployment" /></section>
      <section aria-label="Activation" className="border border-[var(--color-line-2)] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-mono text-[12px]">Activation path</h2><span className="font-mono text-[10px] text-[var(--color-fg-dim)]">USERS WHO SIGNED UP IN THIS PERIOD</span></div><div className="mt-4 grid gap-2 sm:grid-cols-5">{([['signup', 'Signed up'], ['verified', 'Verified email'], ['first_fleet', 'First fleet'], ['first_node', 'Paired node'], ['first_deploy', 'First live deploy']] as const).map(([key, label], index) => <div key={key} className="border-l-2 border-[var(--color-signal)] bg-[var(--color-ink-900)] p-3"><p className="font-mono text-[10px] text-[var(--color-fg-dim)]">0{index + 1} · {label}</p><p className="mt-2 text-xl font-semibold tabular-nums">{data?.activation[key] ?? '—'}</p></div>)}</div></section>
      <section aria-label="Platform health" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Agents reporting" value={data?.health.online_nodes} note="Heartbeat within 30 seconds" /><Metric label="Stale agents" value={data?.health.stale_nodes} /><Metric label="Failed deploys" value={data?.health.failed_deployments_24h} note="Past 24 hours" /><Metric label="Failed builds" value={data?.health.failed_builds_24h} note="Past 24 hours" /></section>
      {data && <><section aria-label="Activity trends" className="grid gap-3 lg:grid-cols-3"><Trend title="Signups" values={data.trends.signups} days={days} /><Trend title="Deployments" values={data.trends.deployments} days={days} /><Trend title="Builds" values={data.trends.builds} days={days} /></section><WorldMap geography={data.geography} /></>}
      <section aria-label="Usage and storage" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Services" value={data?.counts.services} /><Metric label="Build jobs" value={data?.counts.builds} note={`${days}-day period`} /><Metric label="Postgres database" value={bytes(data?.storage.databaseBytes ?? null)} note="Measured database size" /><Metric label="Registry / network storage" value="Not measured" note="Collector needed before reporting" /></section>
      <section aria-label="Node platforms" className="border border-[var(--color-line-2)] p-4"><h2 className="font-mono text-[12px]">Node platforms</h2><div className="mt-3 flex flex-wrap gap-2">{data?.nodePlatforms.map((entry) => <span key={entry.platform} className="border border-[var(--color-line-2)] px-3 py-2 font-mono text-[11px]">{entry.platform} · {entry.nodes}</span>)}</div><p className="mt-3 text-[11px] text-[var(--color-fg-muted)]">API error rate, ingress incidents, and registry pressure need dedicated collectors. No fabricated health signal is shown.</p></section>
      <section aria-label="Accounts" className="border border-[var(--color-line-2)]"><div className="flex flex-wrap justify-between gap-3 border-b border-[var(--color-line)] p-4"><h2 className="font-mono text-[12px]">Accounts</h2><input aria-label="Search accounts" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder="Search email…" className="border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-3 py-2 font-mono text-[11px]" /></div><div className="max-h-[420px] overflow-auto divide-y divide-[var(--color-line)]">{users.data?.users.map((user) => <button type="button" onClick={() => setSelectedUserId(user.id)} key={user.id} className="grid w-full gap-2 p-3 text-left text-[11px] hover:bg-[var(--color-ink-900)] sm:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr]"><span className="truncate text-[var(--color-signal)]">{user.email}</span><span>{user.verified ? 'Verified' : 'Unverified'} · {user.organizations} org</span><span>{countryByCode.get(user.country.toUpperCase()) ?? user.country}</span><span>Last seen {ago(user.lastSeen)}</span></button>)}</div><div className="flex justify-end gap-2 p-3 font-mono text-[11px]"><button disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>{page}</span><button disabled={(users.data?.users.length ?? 0) < 50} onClick={() => setPage(page + 1)}>Next</button></div></section>
      {selectedUserId && <section aria-label="Selected account" className="border border-[var(--color-line-2)] bg-[var(--color-ink-900)] p-4"><div className="flex justify-between gap-3"><h2 className="font-mono text-[12px]">Account detail</h2><button onClick={() => setSelectedUserId(null)} aria-label="Close account detail" className="font-mono text-[11px]">Close ×</button></div>{userDetail.error && <p role="alert">Could not load this account.</p>}{userDetail.data?.user && <><p className="mt-3 break-all text-sm">{userDetail.data.user.email}</p><p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">Joined {new Date(userDetail.data.user.createdAt).toLocaleDateString()} · {userDetail.data.user.verified ? 'Verified' : 'Unverified'} · latest sign-in country {countryByCode.get(userDetail.data.user.country.toUpperCase()) ?? userDetail.data.user.country}</p><div className="mt-4 grid gap-2 sm:grid-cols-5">{(['organizations', 'fleets', 'nodes', 'services', 'deployments'] as const).map((key) => <Metric key={key} label={key} value={userDetail.data!.user[key]} />)}</div></>}</section>}
      <section aria-label="Nodes" className="border border-[var(--color-line-2)]"><h2 className="border-b border-[var(--color-line)] p-4 font-mono text-[12px]">Fleet nodes · location unknown</h2><div className="max-h-[420px] overflow-auto divide-y divide-[var(--color-line)]">{nodes.data?.nodes.map((node) => <div key={node.id} className="grid gap-2 p-3 text-[11px] sm:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]"><span>{node.name} <small className="text-[var(--color-fg-dim)]">{node.organization} / {node.fleet}</small></span><span>{node.platform ?? 'Platform unknown'}</span><span>Agent {node.agentVersion ?? 'unknown'}</span><span>Heartbeat {ago(node.lastHeartbeatAt)}</span><span>Disk {node.diskUsedMb != null && node.diskTotalMb ? `${(node.diskUsedMb / 1024).toFixed(1)} / ${(node.diskTotalMb / 1024).toFixed(1)} GiB` : 'unreported'} · ↓{node.netRxKbps ?? '—'} ↑{node.netTxKbps ?? '—'} KiB/s</span></div>)}</div></section>
    </main>
  </div>
}
