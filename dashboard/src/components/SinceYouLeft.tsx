import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type TimelineEvent } from '../lib/api'
import { usePoll } from '../lib/auth'
import { since } from '../lib/format'

/**
 * What happened while you were not looking.
 *
 * Overview shows what exists and Doctor shows what is broken. Neither answers
 * the question somebody actually opens a dashboard with, which is *what
 * changed* — a fleet that is fine now and was on fire an hour ago looks
 * identical to one that has been fine all week.
 *
 * The mark is kept in this browser rather than on the server, deliberately.
 * "When did I last look" is a fact about a person at a screen, not about the
 * fleet, and two people watching the same fleet have different answers. It is
 * also the sort of thing that would need a migration and a write on every page
 * load to do the other way, for something a browser can remember for free.
 */

const MARK = 'fleet:lastSeenEvents'

/** Nothing older than this, however long somebody has been away. */
const HORIZON_MS = 7 * 24 * 60 * 60 * 1000

function readMark(): number {
  try {
    const raw = localStorage.getItem(MARK)
    const at = raw ? Number(raw) : 0
    // A first visit is not "everything that ever happened". Somebody arriving
    // for the first time wants today, not a wall of history they have no
    // context for.
    return at > 0 ? Math.max(at, Date.now() - HORIZON_MS) : Date.now() - 24 * 60 * 60 * 1000
  } catch {
    // Private windows and blocked storage throw rather than return null.
    return Date.now() - 24 * 60 * 60 * 1000
  }
}

export default function SinceYouLeft({ fleetId }: { fleetId: string }) {
  // Read once, on mount. Re-reading would move the line forward under the
  // reader as the mark is written, and the list would empty itself while they
  // were still looking at it.
  const [mark] = useState(readMark)
  const [dismissed, setDismissed] = useState(false)

  const { data } = usePoll(
    () => api<{ events: TimelineEvent[] }>(`/fleets/${fleetId}/events?limit=100`),
    [fleetId],
    10_000
  )

  const fresh = (data?.events ?? []).filter((e) => new Date(e.at).getTime() > mark)

  useEffect(() => {
    // Written on unmount rather than on render: marking them seen the instant
    // they appear means a glance at the wrong moment loses them for good.
    return () => {
      try {
        localStorage.setItem(MARK, String(Date.now()))
      } catch {
        // Not being able to remember is a lost convenience, not an error.
      }
    }
  }, [])

  if (dismissed || !fresh.length) return null

  // Grouped, because five failovers of one service is one story and reads as
  // five problems when listed.
  const byService = new Map<string, TimelineEvent[]>()
  for (const e of fresh) byService.set(e.service, [...(byService.get(e.service) ?? []), e])

  const worrying = fresh.filter((e) => e.reason === 'failover' || e.reason === 'drain').length

  return (
    <section className="rounded-[4px] border border-[var(--color-line-2)]">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] px-4 py-2.5">
        <p className="text-[12px] text-[var(--color-fg-muted)]">
          <span className="text-[var(--color-fg)]">{fresh.length}</span>{' '}
          {fresh.length === 1 ? 'thing' : 'things'} happened since you last looked
          {worrying > 0 && (
            <span className="ml-2 text-[var(--color-warn)]">
              · {worrying} {worrying === 1 ? 'was a failover' : 'were failovers'}
            </span>
          )}
        </p>
        <button
          onClick={() => setDismissed(true)}
          className="font-mono text-[10.5px] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)]"
        >
          dismiss
        </button>
      </div>

      <ul className="divide-y divide-[var(--color-line)]">
        {[...byService.entries()].slice(0, 6).map(([service, events]) => (
          <li key={service} className="flex items-center justify-between gap-4 px-4 py-2">
            <span className="truncate text-[12px] text-[var(--color-fg)]">{service}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
              {events.length > 1 ? `${events.length}× ` : ''}
              {events[0]!.reason} · {since(events[0]!.at)}
            </span>
          </li>
        ))}
      </ul>

      {byService.size > 6 && (
        <Link
          to="/events"
          className="block border-t border-[var(--color-line)] px-4 py-2 text-center font-mono text-[10.5px] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)]"
        >
          and {byService.size - 6} more →
        </Link>
      )}
    </section>
  )
}
