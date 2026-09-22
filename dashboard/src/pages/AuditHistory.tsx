import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type AuditEntry, type AuditPage } from '../lib/api'
import { useAuth } from '../lib/auth'
import AuditEntries from '../components/AuditEntries'

const ACTIONS = ['', 'service.deleted', 'service.deployed', 'service.stopped', 'service.restarted', 'service.rolled_back', 'service.manifest_applied', 'node.pair_token_issued', 'secret.created', 'secret.deleted']

export default function AuditHistory() {
  const { fleet } = useAuth()
  const allowed = fleet?.role === 'owner' || fleet?.role === 'admin'
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [targetType, setTargetType] = useState('')
  const [target, setTarget] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [cursor, setCursor] = useState<AuditPage['nextCursor']>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!fleet || !allowed) return
    const controller = new AbortController()
    const params = new URLSearchParams({ limit: '25' })
    if (action) params.set('action', action)
    if (actor) params.set('actor', actor)
    if (targetType) params.set('targetType', targetType)
    if (target.trim()) params.set('target', target.trim())
    if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString())
    if (to) params.set('to', new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString())
    setLoading(true)
    setError('')
    api<AuditPage>(`/fleets/${fleet.id}/audit?${params}`, { signal: controller.signal })
      .then((page) => { if (!controller.signal.aborted) { setEntries(page.entries); setCursor(page.nextCursor) } })
      .catch((err: Error) => { if (!controller.signal.aborted) setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [fleet?.id, allowed, action, actor, targetType, target, from, to, version])

  async function loadMore() {
    if (!fleet || !cursor || loading) return
    const params = new URLSearchParams({ limit: '25', before: cursor.before, beforeId: cursor.beforeId })
    if (action) params.set('action', action)
    if (actor) params.set('actor', actor)
    if (targetType) params.set('targetType', targetType)
    if (target.trim()) params.set('target', target.trim())
    if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString())
    if (to) params.set('to', new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString())
    setLoading(true)
    setError('')
    try {
      const page = await api<AuditPage>(`/fleets/${fleet.id}/audit?${params}`)
      setEntries((current) => [...current, ...page.entries])
      setCursor(page.nextCursor)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load audit history') }
    finally { setLoading(false) }
  }

  if (!allowed) return <div className="text-[13px] text-[var(--color-fg-muted)]">Audit history is available to fleet owners and admins.</div>
  const field = 'rounded border border-[var(--color-line)] bg-[var(--color-ink-900)] px-3 py-2 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-signal)]'
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><Link to="/settings" className="font-mono text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">← Settings</Link><h1 className="mt-2 text-[22px] font-semibold">Audit history</h1><p className="text-[13px] text-[var(--color-fg-muted)]">Who changed what, and when. Every record remains available.</p></div>
      <button type="button" onClick={() => setVersion((v) => v + 1)} className={field}>Refresh</button>
    </div>
    <div className="flex flex-wrap gap-2" aria-label="Audit filters">
      <select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)} className={field}><option value="">All actions</option>{ACTIONS.filter(Boolean).map((value) => <option key={value} value={value}>{value}</option>)}</select>
      <select aria-label="Actor" value={actor} onChange={(e) => setActor(e.target.value)} className={field}><option value="">All actors</option><option value="user">User</option><option value="agent">Agent</option><option value="system">System</option></select>
      <select aria-label="Target type" value={targetType} onChange={(e) => setTargetType(e.target.value)} className={field}><option value="">All targets</option><option value="service">Service</option><option value="node">Node</option><option value="fleet">Fleet</option><option value="secret">Secret</option></select>
      <input aria-label="Service, node or target ID" placeholder="Service, node or ID" value={target} onChange={(e) => setTarget(e.target.value)} className={field} />
      <label className="flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} /></label>
      <label className="flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} /></label>
    </div>
    <div className="border border-[var(--color-line)]"><AuditEntries entries={entries} /></div>
    {error && <p role="alert" className="text-[12px] text-[var(--color-down)]">{error}</p>}
    <div className="flex justify-center">{cursor && <button type="button" disabled={loading} onClick={loadMore} className={`${field} disabled:opacity-50`}>Load more</button>}{loading && <span className="px-3 py-2 text-[12px] text-[var(--color-fg-muted)]">Loading…</span>}</div>
  </div>
}
