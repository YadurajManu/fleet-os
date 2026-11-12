import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import StatusDot from './ui/StatusDot'
import { EASE } from '../lib/motion'

const API = import.meta.env.VITE_FLEET_API_URL ?? (import.meta.env.DEV ? 'http://localhost:8080' : 'https://fleetapi.plastikworld.xyz')
const TITLES = { api: 'Control plane API', postgres: 'Postgres', redis: 'Redis', registry: 'Registry storage' }
const SECTIONS = [['current-status', 'Current status'], ['components', 'Components'], ['incident-history', 'Incident history']]
const MIN_DAILY_CHECKS = 24 * 60 * 2 * 0.95

function label(status) {
  return ({ operational: 'Operational', degraded: 'Degraded', outage: 'Outage', unknown: 'Checking' })[status] ?? 'Checking'
}
function tone(status) { return ({ operational: 'online', degraded: 'warn', outage: 'down', unknown: 'idle' })[status] ?? 'idle' }
function timestamp(value) {
  if (!value) return 'Waiting for first check'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
}
function percent(points) {
  const samples = points.reduce((sum, point) => sum + point.samples, 0)
  if (samples < MIN_DAILY_CHECKS) return null
  const healthy = points.reduce((sum, point) => sum + Math.round((point.uptime / 100) * point.samples), 0)
  return (healthy / samples * 100).toFixed(2)
}
function Toc({ active }) {
  return <aside className="hidden lg:col-span-3 lg:col-start-10 lg:block"><div className="sticky top-24"><span className="mono-label">on this page</span><ul className="mt-5 space-y-2.5 border-l border-[var(--color-line)]">{SECTIONS.map(([id, title]) => <li key={id} className="relative">{active === id && <motion.span layoutId="status-toc-marker" className="absolute -left-px top-0 h-full w-px bg-[var(--color-signal)]" transition={{ duration: .3, ease: EASE.expo }} />}<a href={`#${id}`} onClick={(event) => { event.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }) }} className={`block py-0.5 pl-4 text-[12.5px] leading-snug transition-colors ${active === id ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]'}`}>{title}</a></li>)}</ul><div className="mt-8 border-t border-[var(--color-line)] pt-6"><span className="mono-label">elsewhere</span><ul className="mt-4 space-y-2 text-[12.5px] text-[var(--color-fg-dim)]"><li><a className="transition-colors hover:text-[var(--color-fg)]" href="/docs">Documentation</a></li><li><a className="transition-colors hover:text-[var(--color-fg)]" href="/docs/cli">CLI reference</a></li><li><a className="transition-colors hover:text-[var(--color-fg)]" href="https://fleetapp.plastikworld.xyz">Fleet dashboard ↗</a></li></ul></div></div></aside>
}
function UptimeBars({ points }) {
  if (!points.length) return <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">Collecting history</span>
  const byDay = new Map(points.map((point) => [String(point.date).slice(0, 10), point]))
  const days = Array.from({ length: 90 }, (_, index) => {
    const date = new Date()
    date.setUTCHours(0, 0, 0, 0)
    date.setUTCDate(date.getUTCDate() - 89 + index)
    const key = date.toISOString().slice(0, 10)
    return byDay.get(key) ?? { date: key, uptime: null, samples: 0 }
  })
  return <div className="flex h-7 items-end gap-[2px]" aria-label={`Uptime measurements for ${points.length} days`}>
    {days.map((point) => { const complete = point.uptime !== null && point.samples >= MIN_DAILY_CHECKS; return <span key={point.date} title={complete ? `${point.date} · ${point.uptime}% of recorded checks passed` : `${point.date} · incomplete or missing measurements`} className={`min-w-[2px] flex-1 rounded-[1px] ${!complete ? 'bg-[var(--color-line-2)]' : point.uptime >= 99.9 ? 'bg-[var(--color-signal)]' : point.uptime >= 95 ? 'bg-[var(--color-warn)]' : 'bg-[var(--color-down)]'}`} style={{ height: `${complete ? Math.max(20, point.uptime) : 35}%` }} />})}
  </div>
}
function EventTimeline({ events, monitoredSince }) {
  if (!events.length) return <div className="border-l border-[var(--color-line)] py-1 pl-5 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">{monitoredSince ? 'No health changes have been recorded since monitoring began.' : 'The incident timeline will start after the first health check is recorded.'}</div>
  return <ol className="border-l border-[var(--color-line)]">{events.map((event) => <li key={event.id} className="relative grid gap-2 border-b border-[var(--color-line)] py-4 pl-5 sm:grid-cols-[150px_1fr]"><span className="absolute -left-[4px] top-[22px] h-[7px] w-[7px] rounded-full" style={{ background: event.status === 'operational' ? 'var(--color-signal)' : 'var(--color-down)' }} /><time className="font-mono text-[10px] text-[var(--color-fg-dim)]">{timestamp(event.occurred_at)}</time><div><h3 className="text-[13px] font-medium">{TITLES[event.component] ?? event.component} · {label(event.status)}</h3><p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">{event.message}</p></div></li>)}</ol>
}

export default function StatusPage() {
  const reduce = useReducedMotion()
  const [active, setActive] = useState(SECTIONS[0][0])
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const [refreshedAt, setRefreshedAt] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let live = true
    let controller
    const refresh = async () => {
      controller?.abort()
      controller = new AbortController()
      setRefreshing(true)
      try {
        const response = await fetch(`${API}/public/status`, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error(`Status API returned ${response.status}`)
        const result = await response.json()
        if (live) { setData(result); setError(false); setRefreshedAt(new Date()) }
      } catch (err) { if (live && err.name !== 'AbortError') setError(true) }
      finally { if (live) setRefreshing(false) }
    }
    refresh()
    const interval = window.setInterval(refresh, 30_000)
    const headings = SECTIONS.map(([id]) => document.getElementById(id)).filter(Boolean)
    const observer = new IntersectionObserver((entries) => { const visible = entries.find(entry => entry.isIntersecting); if (visible) setActive(visible.target.id) }, { rootMargin: '-80px 0px -70% 0px' })
    headings.forEach((heading) => observer.observe(heading))
    return () => { live = false; controller?.abort(); window.clearInterval(interval); observer.disconnect() }
  }, [])

  const status = error && !data ? 'unavailable' : data?.status ?? 'checking'
  const statusTone = status === 'operational' ? 'online' : status === 'degraded' ? 'warn' : status === 'unavailable' ? 'down' : 'idle'
  const statusText = ({ operational: 'All monitored systems operational', degraded: 'Some monitored systems need attention', outage: 'Service interruption detected', unavailable: 'Status service unreachable', checking: 'Checking platform health', unknown: 'Monitoring is collecting data' })[status] ?? 'Checking platform health'

  return <article className="relative"><div className="pointer-events-none absolute inset-x-0 top-0 h-[340px] dot-bg opacity-40" aria-hidden="true" />
    <header className="rail relative border-b border-[var(--color-line)] pb-12 pt-28 lg:pt-32">
      <motion.div initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .5, ease: EASE.expo }} className="flex items-center gap-2.5 font-mono text-[11px]"><a href="/#top" className="link-draw text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]">fleet·os</a><span className="text-[var(--color-line-2)]">/</span><span className="text-[var(--color-fg-dim)]">Company</span><span className="text-[var(--color-line-2)]">/</span><span className="text-[var(--color-signal)]">platform status</span></motion.div>
      <motion.h1 initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .55, delay: .06, ease: EASE.expo }} className="mt-6 text-[clamp(2.1rem,4.6vw,3.3rem)] font-semibold leading-[1.02] tracking-[-0.04em] text-balance">Service status</motion.h1>
      <p className="mt-5 max-w-[62ch] text-[15.5px] leading-[1.7] text-[var(--color-fg-muted)] text-pretty">Live health for Fleet-operated infrastructure. Customer nodes and deployed services remain private to your fleet dashboard.</p>
      <div className="mt-8 flex flex-wrap items-center gap-2.5 font-mono text-[10.5px] text-[var(--color-fg-dim)]"><StatusDot size={6} tone={statusTone} /><span>{statusText}</span><span className="text-[var(--color-line-2)]">·</span><span>{refreshedAt ? `refreshed ${timestamp(refreshedAt)}` : refreshing ? 'connecting to monitoring' : 'waiting for status API'}</span><button type="button" onClick={() => window.location.reload()} className="ml-1 underline decoration-[var(--color-line-2)] underline-offset-4 hover:text-[var(--color-fg)]">refresh</button></div>
    </header>
    <div className="rail relative grid gap-12 py-14 lg:grid-cols-12 lg:py-16"><div className="min-w-0 lg:col-span-8">
      <motion.section id="current-status" initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .45, delay: .12, ease: EASE.expo }} className="scroll-mt-24 border-l-2 pl-5" style={{ borderColor: status === 'operational' ? 'var(--color-signal)' : status === 'degraded' || status === 'unavailable' ? 'var(--color-warn)' : 'var(--color-line-2)' }} aria-live="polite">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-dim)]">Current status</span><h2 className="mt-2 text-[19px] font-medium tracking-[-0.025em]">{statusText}</h2><p className="mt-2 text-[13.5px] leading-[1.7] text-[var(--color-fg-muted)]">{error ? 'Could not reach the live status API. The last successful readings remain visible with their original timestamps.' : data?.monitoredSince ? `Checks run every ${data.refreshSeconds} seconds. Historical measurements are shown from ${timestamp(data.monitoredSince)}.` : 'Waiting for the first persisted health check.'}</p>
      </motion.section>
      <section id="components" className="mt-12 scroll-mt-24"><div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--color-line)] pb-3"><div><h2 className="text-[18px] font-medium tracking-[-0.025em]">Monitored components</h2><p className="mt-2 text-[13.5px] text-[var(--color-fg-muted)]">Health checks for Fleet platform services and their data dependencies. Percentages use recorded checks; gray days indicate missing measurements.</p></div><span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-fg-dim)]">90 day view</span></div>
        {!data?.components?.length ? <p className="border-b border-[var(--color-line)] py-5 text-[13px] text-[var(--color-fg-muted)]">{error ? 'Live component checks are temporarily unavailable.' : 'Waiting for monitoring data…'}</p> : <div className="border-t border-[var(--color-line)]">{data.components.map((component, index) => { const points = component.uptime90d ?? []; const uptime = percent(points); const sampleCount = points.reduce((sum, point) => sum + point.samples, 0); return <motion.article key={component.id} initial={reduce ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .32, delay: index * .04, ease: EASE.expo }} className="grid gap-3 border-b border-[var(--color-line)] py-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,0.8fr)_120px] sm:items-center">
          <div className="flex items-start gap-3"><StatusDot className="mt-1" tone={tone(component.status)} size={6} /><div><h3 className="text-[13px] font-medium">{component.name}</h3><p className="mt-1 text-[11px] text-[var(--color-fg-dim)]">{component.checkedAt ? `Checked ${timestamp(component.checkedAt)}` : 'First check pending'}</p></div></div><UptimeBars points={points} /><div className="font-mono text-[10px] text-[var(--color-fg-dim)] sm:text-right"><span className="block text-[var(--color-fg-muted)]">{uptime ? `${uptime}% · ${sampleCount} checks` : `Collecting · ${sampleCount} checks`}</span>{label(component.status)}</div>
        </motion.article> })}</div>}
      </section>
      <section id="incident-history" className="mt-12 scroll-mt-24 border-t border-[var(--color-line)] pt-6"><span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-dim)]">Incident history</span><h2 className="mt-2 text-[17px] font-medium tracking-[-0.02em]">Platform health events</h2><p className="mb-5 mt-2 text-[13.5px] leading-[1.7] text-[var(--color-fg-muted)]">Events are created automatically when a monitored component changes health.</p><EventTimeline events={data?.events ?? []} monitoredSince={data?.monitoredSince} /></section>
      <aside className="mt-12 border-t border-[var(--color-line)] pt-5 lg:hidden"><span className="mono-label">checking your fleet?</span><p className="mt-3 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">This public page covers Fleet infrastructure only. Inspect your own nodes and workloads in your dashboard.</p><a href="https://fleetapp.plastikworld.xyz" className="mt-3 inline-flex items-center gap-2 font-mono text-xs text-[var(--color-signal)]">Open dashboard ↗</a></aside>
    </div><Toc active={active} /></div>
  </article>
}
