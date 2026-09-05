import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Node, type Service } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'

/**
 * Go anywhere, from anywhere.
 *
 * Fourteen pages and growing, and every one of them is reached by aiming at a
 * link. On a fleet with thirty services, finding one means loading the services
 * page, waiting, and scanning — three steps to arrive somewhere you already
 * knew the name of.
 *
 * The difference this makes is between a dashboard you navigate and one you
 * operate, and it costs almost nothing: the services and nodes are already
 * fetched and cached by `usePoll`, so this reads what other pages have already
 * asked for rather than asking again.
 */

type Item = { label: string; hint: string; to: string }

const PAGES: Item[] = [
  { label: 'Overview', hint: 'page', to: '/' },
  { label: 'Services', hint: 'page', to: '/services' },
  { label: 'Nodes', hint: 'page', to: '/nodes' },
  { label: 'Events', hint: 'page', to: '/events' },
  { label: 'Logs', hint: 'page', to: '/logs' },
  { label: 'Doctor', hint: 'page', to: '/doctor' },
  { label: 'Alerts', hint: 'page', to: '/alerts' },
  { label: 'Secrets', hint: 'page', to: '/secrets' },
  { label: 'Settings', hint: 'page', to: '/settings' },
]

export default function Palette() {
  const { fleet } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Only while it is open. Polling a fleet's services in the background from a
  // component that is almost always closed would put a request every four
  // seconds behind a panel nobody is looking at.
  const services = usePoll(
    () => (open && fleet ? api<{ services: Service[] }>(`/fleets/${fleet.id}/services`) : Promise.resolve(null)),
    [fleet?.id, open]
  )
  const nodes = usePoll(
    () => (open && fleet ? api<{ nodes: Node[] }>(`/fleets/${fleet.id}/nodes`) : Promise.resolve(null)),
    [fleet?.id, open]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Both, because this runs on machines with either modifier and a person
      // should not have to remember which one this particular app chose.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      // After paint, or the input does not exist yet to be focused.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const items = useMemo(() => {
    const all: Item[] = [
      ...PAGES,
      ...(services.data?.services ?? []).map((s) => ({
        label: s.name,
        hint: s.current?.status ?? 'not running',
        to: `/services/${s.id}`,
      })),
      ...(nodes.data?.nodes ?? []).map((n) => ({
        label: n.name,
        hint: n.live ? 'node' : 'node · offline',
        to: `/nodes/${n.id}`,
      })),
    ]
    const q = query.trim().toLowerCase()
    if (!q) return all.slice(0, 10)
    // Substring rather than fuzzy. A fleet's names are short and chosen by the
    // person searching, so the thing they typed is nearly always a prefix of
    // what they want — and fuzzy matching mostly adds surprising results.
    return all
      .filter((i) => i.label.toLowerCase().includes(q))
      .sort((a, b) => a.label.toLowerCase().indexOf(q) - b.label.toLowerCase().indexOf(q))
      .slice(0, 10)
  }, [query, services.data, nodes.data])

  if (!open) return null

  const go = (item: Item | undefined) => {
    if (!item) return
    setOpen(false)
    navigate(item.to)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[18vh]"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Go to"
        className="w-full max-w-[520px] overflow-hidden rounded-[5px] border border-[var(--color-line-2)] bg-[var(--color-ink-950)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(c + 1, items.length - 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            }
            if (e.key === 'Enter') go(items[cursor])
          }}
          placeholder="Go to a service, a node, or a page…"
          className="w-full border-b border-[var(--color-line)] bg-transparent px-4 py-3 text-[14px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-dim)]"
        />
        <ul className="max-h-[320px] overflow-y-auto">
          {items.map((item, i) => (
            <li key={`${item.to}-${item.label}`}>
              <button
                onClick={() => go(item)}
                onMouseEnter={() => setCursor(i)}
                className={`flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left ${
                  i === cursor ? 'bg-[var(--color-line)]/40' : ''
                }`}
              >
                <span className="truncate text-[13px] text-[var(--color-fg)]">{item.label}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                  {item.hint}
                </span>
              </button>
            </li>
          ))}
          {!items.length && (
            <li className="px-4 py-6 text-center text-[12px] text-[var(--color-fg-dim)]">
              Nothing matches “{query}”.
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}
