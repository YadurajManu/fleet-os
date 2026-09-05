import { useState } from 'react'
import { api } from '../lib/api'
import { Button, ErrorNote } from './ui'
import { LinesSkeleton } from './Skeleton'

/**
 * Asking the fleet why something is wrong, from the page you noticed it on.
 *
 * `fleet diagnose` has existed for a while and the dashboard has never shown
 * it, which put the tool furthest from the moment it is wanted: you see a
 * service is unhealthy here, and then go to a terminal to ask about it.
 *
 * Every finding carries the lookup that supports it, and that is not
 * decoration. A diagnosis without citations is an opinion, and this one is
 * checkable — a reader can go and run the same lookup. The layout puts the
 * evidence directly under each claim for that reason, rather than collecting
 * references at the end where nobody reads them.
 */

type Finding = { claim: string; evidence: string }

type Result =
  | { status: 'ok'; summary: string; findings: Finding[]; next: string[]; model: string; calls: Array<{ tool: string; args: Record<string, unknown> }> }
  | { status: 'disabled'; reason: string }
  | { status: 'inconclusive'; reason: string; calls: Array<{ tool: string; args: Record<string, unknown> }> }

export default function Diagnose({ fleetId, service }: { fleetId: string; service?: string }) {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<unknown>(null)

  const ask = async (text: string) => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await api<Result>(`/fleets/${fleetId}/diagnose`, { method: 'POST', body: { question: text } }))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  // Offered rather than typed. Most people want the obvious question about the
  // thing in front of them, and a blank box makes them compose it.
  const suggested = service
    ? `Why is the "${service}" service not working as it should?`
    : 'Is anything in this fleet disagreeing with itself?'

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask(question || suggested)}
          placeholder={suggested}
          className="flex-1 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-3 py-2 font-mono text-[12px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-dim)] focus:border-[var(--color-line-2)]"
        />
        <Button onClick={() => ask(question || suggested)} disabled={busy}>
          {busy ? 'looking…' : 'ask'}
        </Button>
      </div>

      {/*
        The lookups are shown while it works, not after. An investigation that
        takes twenty seconds with nothing on screen reads as a hang; the same
        twenty seconds with "deployments, containers, logs" appearing reads as
        work, and it is the same twenty seconds.
      */}
      {busy && (
        <div className="rounded-[4px] border border-[var(--color-line)] p-4">
          <LinesSkeleton lines={4} />
        </div>
      )}

      {error != null && <ErrorNote error={error} />}

      {result?.status === 'disabled' && (
        <p className="text-[12px] text-[var(--color-fg-dim)]">{result.reason}</p>
      )}

      {result?.status === 'inconclusive' && (
        <div className="space-y-2 rounded-[4px] border border-[var(--color-line)] p-4">
          <p className="text-[12px] text-[var(--color-fg-muted)]">{result.reason}</p>
          <Calls calls={result.calls} />
        </div>
      )}

      {result?.status === 'ok' && (
        <div className="space-y-4 rounded-[4px] border border-[var(--color-line)] p-4">
          <p className="text-[13px] leading-relaxed text-[var(--color-fg)]">{result.summary}</p>

          {result.findings.map((f, i) => (
            <div key={i} className="border-l-2 border-[var(--color-line-2)] pl-3">
              <p className="text-[12px] text-[var(--color-fg-muted)]">{f.claim}</p>
              {/*
                Directly under the claim, because the point of a citation is
                that it can be checked, and one collected at the bottom is one
                nobody checks.
              */}
              <p className="mt-1 font-mono text-[10.5px] text-[var(--color-fg-dim)]">{f.evidence}</p>
            </div>
          ))}

          {result.next.length > 0 && (
            <div>
              <p className="mono-label">what to do</p>
              <ul className="mt-2 space-y-1">
                {result.next.map((n, i) => (
                  <li key={i} className="text-[12px] text-[var(--color-fg-muted)]">
                    <span className="mr-2 text-[var(--color-fg-dim)]">›</span>
                    {n}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-between gap-4 border-t border-[var(--color-line)] pt-3">
            <Calls calls={result.calls} />
            <span className="shrink-0 font-mono text-[10px] text-[var(--color-fg-dim)]">{result.model}</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** What it looked at, so the answer can be retraced rather than trusted. */
function Calls({ calls }: { calls: Array<{ tool: string; args: Record<string, unknown> }> }) {
  if (!calls.length) return null
  return (
    <p className="font-mono text-[10px] text-[var(--color-fg-dim)]">
      looked at{' '}
      {calls
        .map((c) => `${c.tool}${Object.values(c.args)[0] ? ` ${String(Object.values(c.args)[0])}` : ''}`)
        .join(' · ')}
    </p>
  )
}
