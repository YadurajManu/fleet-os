import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { AuditEntry } from '../lib/api'
import { since } from '../lib/format'

const VERBS: Record<string, string> = {
  created: 'created', deleted: 'deleted', deployed: 'deployed', stopped: 'stopped',
  restarted: 'restarted', rolled_back: 'rolled back', manifest_applied: 'manifest applied',
  pair_token_issued: 'pairing token issued',
}

function description(entry: AuditEntry) {
  const [noun, ...parts] = entry.action.split('.')
  const verb = VERBS[parts.join('.')] ?? parts.join(' ').replaceAll('_', ' ')
  const name = entry.targetName ?? (typeof entry.metadata?.name === 'string' ? entry.metadata.name : null)
  return `${(noun ?? entry.targetType).replaceAll('_', ' ')} ${name ?? entry.targetId ?? ''} ${verb}`.trim()
}

function targetLink(entry: AuditEntry) {
  if (entry.targetType === 'service' && entry.targetId && entry.action !== 'service.deleted') return `/services/${entry.targetId}`
  if (entry.targetType === 'node' && entry.targetId && entry.action !== 'node.deleted') return `/nodes/${entry.targetId}`
  return null
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false)
  const link = targetLink(entry)
  // Never render arbitrary metadata: it may contain credentials or request details.
  const safeDetails = ['name', 'count', 'node', 'deployment', 'gitSha', 'reason']
    .flatMap((key) => {
      const value = entry.metadata?.[key]
      return typeof value === 'string' || typeof value === 'number' ? [[key, String(value)] as const] : []
    })
  return (
    <div className="border-b border-[var(--color-line)] px-5 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <time dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()} className="w-20 shrink-0 font-mono text-[var(--color-fg-dim)]">{since(entry.createdAt)}</time>
        <span className="min-w-0 flex-1 text-[var(--color-fg)]">{description(entry)}</span>
        <span className="text-[var(--color-fg-muted)]">{entry.actorEmail ?? entry.actorKind}</span>
        {link && <Link className="text-[var(--color-signal)] hover:underline" to={link}>Open</Link>}
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="font-mono text-[10px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">{open ? 'Less' : 'Details'}</button>
      </div>
      {open && <dl className="mt-3 grid gap-1.5 border-t border-[var(--color-line)] pt-3 font-mono text-[10.5px] text-[var(--color-fg-muted)]">
        <div><dt className="inline text-[var(--color-fg-dim)]">Time: </dt><dd className="inline">{new Date(entry.createdAt).toLocaleString()}</dd></div>
        <div><dt className="inline text-[var(--color-fg-dim)]">Action: </dt><dd className="inline">{entry.action}</dd></div>
        <div><dt className="inline text-[var(--color-fg-dim)]">Target ID: </dt><dd className="inline break-all">{entry.targetId ?? '—'}</dd></div>
        <div><dt className="inline text-[var(--color-fg-dim)]">Record ID: </dt><dd className="inline break-all">{entry.id}</dd></div>
        {safeDetails.map(([key, value]) => <div key={key}><dt className="inline text-[var(--color-fg-dim)]">{key}: </dt><dd className="inline break-all">{value}</dd></div>)}
      </dl>}
    </div>
  )
}

export default function AuditEntries({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) return <p className="px-5 py-8 text-center text-[12px] text-[var(--color-fg-muted)]">No audit entries found.</p>
  const groups: AuditEntry[][] = []
  for (const entry of entries) {
    const last = groups.at(-1)
    if (last && last[0]!.action === entry.action && last[0]!.targetType === entry.targetType &&
      Math.abs(new Date(last.at(-1)!.createdAt).getTime() - new Date(entry.createdAt).getTime()) < 5 * 60_000) last.push(entry)
    else groups.push([entry])
  }
  return <div>{groups.map((group) => group.length === 1
    ? <AuditRow key={group[0]!.id} entry={group[0]!} />
    : <GroupedRows key={group[0]!.id} entries={group} />)}</div>
}

function GroupedRows({ entries }: { entries: AuditEntry[] }) {
  const [open, setOpen] = useState(false)
  return <div className="border-b border-[var(--color-line)] last:border-b-0">
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-5 py-3 text-left text-[12px] hover:bg-[var(--color-ink-900)]">
      <time className="w-20 shrink-0 font-mono text-[var(--color-fg-dim)]">{since(entries[0]!.createdAt)}</time>
      <span className="flex-1">{entries.length} {entries[0]!.targetType} actions · {entries[0]!.action}</span>
      <span className="font-mono text-[10px] text-[var(--color-fg-muted)]">{open ? 'Hide records' : 'Show every record'}</span>
    </button>
    {open && <div className="border-t border-[var(--color-line)] bg-[var(--color-ink-950)]">{entries.map((entry) => <AuditRow key={entry.id} entry={entry} />)}</div>}
  </div>
}
