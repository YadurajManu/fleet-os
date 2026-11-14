import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { STATUS_RANGES, defaultRange, formatUptime, monthGroups, staleSnapshot, statusColor, statusLabel } from '../lib/status'
import './status.css'

const API = import.meta.env.VITE_FLEET_API_URL ?? (import.meta.env.DEV ? 'http://localhost:8080' : 'https://fleetapi.plastikworld.xyz')
const SNAPSHOT = import.meta.env.VITE_STATUS_SNAPSHOT_URL
const stamp = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not yet recorded'
const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : 'the first recorded check'
const numeric = value => typeof value === 'number' ? value.toLocaleString() : '—'
function Chevron({ open }) { return <svg className={`status-chevron ${open ? 'is-open' : ''}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg> }
function TickBar({ ticks = [], compact = false }) {
  if (!ticks.length) return <span className="status-no-ticks">Awaiting measurements</span>
  return <div className={compact ? 'status-mini-bar' : 'status-tick-bar'} aria-label="Recorded uptime checks">{(compact ? ticks.slice(-30) : ticks).map(tick => {
    const title = `${stamp(tick.start)} · ${statusLabel(tick.status)} · ${formatUptime(tick.uptime)} uptime · ${numeric(tick.checks)} checks · ${tick.incidents?.length ?? 0} incidents`
    return <span key={tick.start} {...(!compact ? { tabIndex: 0, role: 'img', 'aria-label': title } : { 'aria-hidden': true })} title={title} className="status-tick" style={{ '--tick-color': statusColor(tick.status) }} />
  })}</div>
}
function ComponentCard({ component, asOf }) {
  const id = useId(); const reduce = useReducedMotion(); const chosen = useRef(false)
  const [open,setOpen] = useState(false); const [histories,setHistories] = useState({}); const [range,setRange] = useState('24h'); const [error,setError] = useState(false)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const get = async () => {
      try {
        const results = await Promise.all(STATUS_RANGES.map(async r => { const response = await fetch(`${API}/v1/status/components/${component.slug}/uptime?range=${r}`, { signal: controller.signal }); if (!response.ok) throw Error('History unavailable'); return [r,await response.json()] }))
        if (controller.signal.aborted) return
        const values = Object.fromEntries(results); setHistories(values); setError(false); if (!chosen.current) setRange(defaultRange(values))
      } catch (err) { if (err.name !== 'AbortError') setError(true) }
    }
    get(); return () => controller.abort()
  }, [open,component.slug,asOf])
  const history = histories[range]; const ticks = history?.ticks ?? []; const incidents = new Set(ticks.flatMap(t => t.incidents ?? [])).size
  return <article className="status-component" data-status={component.status}><div className="status-component-top">
    <button type="button" className="status-component-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><Chevron open={open} /><span className="status-component-name">{component.name}</span><span className="status-component-level" style={{ color: statusColor(component.status) }}>{statusLabel(component.status)}</span></button>
    <span className="status-info" tabIndex={0} role="img" aria-label={component.description || `${component.name}: health measured by platform probes.`} title={component.description || `${component.name}: health measured by platform probes.`}>ⓘ</span>
    <div className="status-component-compact"><TickBar ticks={component.ticks} compact /></div><span className="status-component-uptime">{formatUptime(component.uptime)} <span>uptime</span></span>
  </div><AnimatePresence initial={false}>{open && <motion.div id={id} key="details" initial={{ height:0,opacity:0 }} animate={{ height:'auto',opacity:1 }} exit={{ height:0,opacity:0 }} transition={{ duration:reduce ? 0 : .2 }} className="status-component-expand"><div className="status-component-body">
    <div className="status-range-row"><span className="status-label">Recorded availability</span><div className="status-ranges" role="group" aria-label={`${component.name} history range`}>{STATUS_RANGES.map(r => <button key={r} type="button" aria-pressed={range === r} onClick={() => { chosen.current = true; setRange(r) }}>{r}</button>)}</div></div>
    {error && <p className="status-history-warning" role="status">History could not be refreshed. Available readings keep their original timestamps.</p>}<TickBar ticks={ticks} />
    <p className="status-history-caption">Monitoring since {date(history?.monitoring_since ?? component.monitoring_since)}{history ? ` · ${(history.coverage * 100).toFixed(1)}% recorded coverage` : ' · Loading recorded history…'}</p>
    <dl className="status-stats"><div><dt>Uptime</dt><dd>{formatUptime(history?.uptime)}</dd></div><div><dt>Checks</dt><dd>{numeric(history?.checks)}</dd></div><div><dt>Last checked</dt><dd>{stamp(component.checked_at)}</dd></div><div><dt>Incidents</dt><dd>{history ? incidents : '—'}</dd></div></dl>
  </div></motion.div>}</AnimatePresence></article>
}
function IncidentList({ incidents,since }) {
  if (!incidents.length) return <div className="status-empty"><span className="status-empty-icon" aria-hidden="true">✓</span><div><h3>No incidents recorded</h3><p>{since ? `Monitoring began ${date(since)}.` : 'Monitoring begins with the first recorded check.'}</p></div></div>
  return <ol className="status-incidents">{incidents.map(incident => <li key={incident.id}><span className="status-incident-dot" style={{ background:statusColor(incident.status === 'resolved' ? 'operational' : incident.impact) }} aria-hidden="true" /><div><div className="status-incident-title"><h3>{incident.title}</h3><span className="status-label">{incident.status}</span></div><p><time dateTime={incident.started_at}>{stamp(incident.started_at)}</time>{incident.resolved_at ? ` · Resolved ${stamp(incident.resolved_at)}` : ' · Investigation in progress'}</p><p>{(incident.components ?? []).join(' · ')}</p></div></li>)}</ol>
}
export default function StatusPage() {
  const [data,setData] = useState(null); const [error,setError] = useState(false); const [refreshing,setRefreshing] = useState(false); const [tab,setTab] = useState('overview'); const [explain,setExplain] = useState(false)
  const mounted = useRef(false); const activeFetch = useRef(null); const bannerId = useId()
  const [history,setHistory] = useState(null); const [historyError,setHistoryError] = useState(false); const [historyCursor,setHistoryCursor] = useState(null); const [historyLoading,setHistoryLoading] = useState(false)
  const loadHistory = useCallback(async (cursor,signal) => {
    setHistoryLoading(true)
    try {
      const query = new URLSearchParams({ limit:'100' }); if (cursor) query.set('cursor',cursor)
      const response = await fetch(`${API}/v1/status/incidents?${query}`,{ signal }); if (!response.ok) throw Error('Incident history unavailable')
      const result = await response.json(); if (!Array.isArray(result.incidents)) throw Error('Invalid incident history')
      if (!signal?.aborted && mounted.current) { setHistory(previous => cursor ? [...(previous ?? []),...result.incidents] : result.incidents); setHistoryCursor(result.next_cursor ?? null); setHistoryError(false) }
    } catch (err) { if (err.name !== 'AbortError' && mounted.current) setHistoryError(true) }
    finally { if (mounted.current) setHistoryLoading(false) }
  },[])
  const refresh = useCallback(async () => {
    setData(previous => previous ? staleSnapshot(previous) : previous)
    activeFetch.current?.abort(); const controller = new AbortController(); activeFetch.current = controller; setRefreshing(true)
    try {
      let response
      try { response = await fetch(`${API}/v1/status`, { signal:controller.signal }); if (!response.ok) throw Error('Status unavailable') }
      catch (err) { if (err.name === 'AbortError' || !SNAPSHOT) throw err; response = await fetch(SNAPSHOT, { signal:controller.signal,cache:'no-cache' }); if (!response.ok) throw Error('Snapshot unavailable') }
      const value = staleSnapshot(await response.json()); if (mounted.current) { setData(value); setError(false) }
    } catch (err) { if (mounted.current && err.name !== 'AbortError') { setError(true); setData(previous => previous ? { ...previous,status:'unknown',stale:true,components:previous.components.map(c => ({ ...c,status:'unknown' })) } : null) } }
    finally { if (mounted.current) setRefreshing(false) }
  }, [])
  useEffect(() => {
    mounted.current = true; refresh(); const poll = setInterval(refresh,30000); const stream = new EventSource(`${API}/v1/status/stream`)
    stream.addEventListener('status-change',event => { try { if (mounted.current) { setData(staleSnapshot(JSON.parse(event.data))); setError(false) } } catch { /* Polling remains available for invalid stream events. */ } })
    return () => { mounted.current = false; activeFetch.current?.abort(); stream.close(); clearInterval(poll) }
  }, [refresh])
  useEffect(() => { if (tab !== 'history') return; const controller = new AbortController(); loadHistory(null,controller.signal); return () => controller.abort() },[tab,data?.as_of,loadHistory])
  const stale = data?.stale || error; const level = stale ? 'unknown' : data?.status ?? 'unknown'; const incidents = data?.incidents ?? []
  const recent = incidents.filter(i => Date.parse(i.started_at) >= Date.now() - 14*86400000).sort((a,b) => Date.parse(b.started_at)-Date.parse(a.started_at)).slice(0,3)
  const groups = [...new Set((data?.components ?? []).map(c => c.group))]
  const historicalIncidents = history ?? incidents
  const headings = { operational:'All systems operational',degraded:'Some systems are experiencing delays',partial_outage:'Some systems are unavailable',major_outage:'A service interruption is in progress',maintenance:'Scheduled maintenance is in progress',unknown:stale ? 'Live status is temporarily unavailable' : 'Waiting for monitoring data' }
  return <article className="fleet-status"><header className="status-page-header"><nav aria-label="Breadcrumb" className="status-breadcrumb"><a href="/">fleet·os</a><span aria-hidden="true">/</span><span>Service status</span></nav><div className="status-heading-row"><h1>Service status</h1><span className="status-version">public platform health</span></div><p>Live health for Fleet-operated infrastructure. Your nodes and services stay private.</p></header>
    <div className="status-tabs" role="tablist" aria-label="Status views">{['overview','history'].map(t => <button id={`status-tab-${t}`} key={t} role="tab" aria-selected={tab === t} aria-controls={`status-panel-${t}`} tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)} onKeyDown={event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'history' : t === 'overview' ? 'history' : 'overview'; setTab(next); document.getElementById(`status-tab-${next}`)?.focus() } }}>{t === 'overview' ? 'Overview' : 'History'}</button>)}</div>
    <section className="status-banner" style={{ '--status-color':statusColor(level) }} aria-live="polite"><button className="status-banner-toggle" type="button" aria-expanded={explain} aria-controls={bannerId} onClick={() => setExplain(!explain)}><span className={`status-banner-dot ${level === 'operational' ? 'is-pulsing' : ''}`} aria-hidden="true" /><span className="status-banner-heading">{headings[level] ?? headings.unknown}</span><span className="status-chip">{stale ? 'Stale readings' : statusLabel(level)}</span><Chevron open={explain} /></button>{explain && <div className="status-banner-explainer" id={bannerId}><p>Checks run every 30 seconds, with slower synthetic checks for builds and scheduling. Uptime uses recorded observations only. Unknown readings and monitoring gaps never count as downtime.</p><p>{stale ? 'Last known measurements keep their original timestamps.' : 'For your own fleet health, sign in to the dashboard or use the CLI.'}</p><code className="status-command">$ fleet status</code><a href="/docs/status-api">Status API documentation ↗</a></div>}</section>
    <div className="status-toolbar"><details className="status-method"><summary>How is uptime calculated?</summary><div><strong>Successful checks ÷ recorded checks.</strong><p>Unknown periods are excluded from both counts. Bars show actual measurements. Coverage shows how much of the selected range was measured.</p></div></details><div className="status-refresh"><span>Updated {data?.as_of ? stamp(data.as_of) : '—'} <span className="status-refresh-frequency">· auto-refresh 30s</span></span><button type="button" aria-label="Refresh service status" title="Refresh service status" disabled={refreshing} onClick={refresh}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 7a5 5 0 1 0-1 4M13 2v5H8" stroke="currentColor" strokeWidth="1.5" /></svg></button></div></div>
    {tab === 'overview' ? <div role="tabpanel" id="status-panel-overview" aria-labelledby="status-tab-overview"><section aria-label="Monitored components">{!data?.components?.length ? <div className="status-empty"><p>{refreshing ? 'Loading component measurements…' : 'No component measurements are available yet.'}</p></div> : groups.map(group => <div className="status-group" key={group}><h2 className="status-label">{group}</h2>{data.components.filter(c => c.group === group).map(c => <ComponentCard key={c.slug} component={c} asOf={data.as_of} />)}</div>)}</section><section className="status-recent"><div className="status-section-heading"><h2>Recent incidents</h2><span className="status-label">Last 14 days</span></div><IncidentList incidents={recent} since={data?.monitoring_since} /><button type="button" className="status-history-link" onClick={() => setTab('history')}>View incident history →</button></section></div> : <section role="tabpanel" id="status-panel-history" aria-labelledby="status-tab-history" className="status-history"><h2>Incident history</h2>{historyError && <p className="status-history-warning" role="status">Could not refresh the incident archive. Available incidents are shown below.</p>}{historyLoading && !history && <p role="status">Loading incident history…</p>}{historicalIncidents.length ? monthGroups(historicalIncidents).map(([month,entries]) => <section key={month}><h3 className="status-label">{new Intl.DateTimeFormat(undefined,{ month:'long',year:'numeric',timeZone:'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}</h3><IncidentList incidents={entries} since={data?.monitoring_since} /></section>) : <IncidentList incidents={[]} since={data?.monitoring_since} />}{historyCursor && <button type="button" className="status-history-link" disabled={historyLoading} onClick={() => loadHistory(historyCursor)}>Load earlier incidents →</button>}</section>}
    <aside className="status-private-note"><span className="status-label">Checking your fleet?</span><p>View your own nodes, deployments and services in the <a href="https://fleetapp.plastikworld.xyz">Fleet dashboard ↗</a>.</p></aside>
  </article>
}
