import { useState } from 'react'
import { api } from '../lib/api'
import { usePoll } from '../lib/auth'
import { since } from '../lib/format'
import { Button, Dot, ErrorNote, Panel } from './ui'

export type SessionItem = {
  id: string
  deviceHash: string
  device: { browser: string; os: string }
  userAgent: string | null
  ip: string | null
  country: string | null
  firstSeen: string
  lastSeen: string
  loginCount: number
  isCurrent: boolean
}

function DeviceIcon({ os, browser }: { os: string; browser: string }) {
  const isMobile = os === 'iOS' || os === 'Android'
  const isCli = browser.toLowerCase().includes('cli') || browser.toLowerCase().includes('curl')

  if (isCli) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-signal)]">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    )
  }

  if (isMobile) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-fg-muted)]">
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
        <line x1="12" y1="18" x2="12.01" y2="18" />
      </svg>
    )
  }

  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-fg-muted)]">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

export default function SessionsSettings() {
  const sessions = usePoll(
    () => api<{ sessions: SessionItem[] }>('/auth/sessions'),
    '/auth/sessions',
    15_000
  )

  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokingAll, setRevokingAll] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const items = sessions.data?.sessions ?? []
  const hasOtherSessions = items.some((s) => !s.isCurrent)

  async function revokeOne(id: string) {
    setRevokingId(id)
    setError(null)
    try {
      await api(`/auth/sessions/${id}`, { method: 'DELETE' })
      await sessions.refetch()
    } catch (err) {
      setError(err)
    } finally {
      setRevokingId(null)
    }
  }

  async function revokeOthers() {
    setRevokingAll(true)
    setError(null)
    try {
      await api('/auth/sessions/revoke-others', { method: 'POST' })
      await sessions.refetch()
    } catch (err) {
      setError(err)
    } finally {
      setRevokingAll(false)
    }
  }

  return (
    <Panel
      title="security & active sessions"
      right={
        hasOtherSessions ? (
          <button
            type="button"
            disabled={revokingAll}
            onClick={revokeOthers}
            className="font-mono text-[11px] text-[var(--color-down)] transition-opacity hover:underline disabled:opacity-50"
          >
            {revokingAll ? 'revoking…' : 'Revoke all other sessions'}
          </button>
        ) : (
          <span className="mono-label normal-case tracking-[0.06em]">
            {items.length} remembered {items.length === 1 ? 'device' : 'devices'}
          </span>
        )
      }
    >
      <div className="space-y-4 p-5">
        <p className="text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
          Devices and browsers that have authenticated with your credentials. Revoking a device prompts for a security alert on its next sign-in.
        </p>

        {error ? <ErrorNote error={error} /> : null}

        {sessions.error ? <ErrorNote error={sessions.error} /> : null}

        <div className="divide-y divide-[var(--color-line)] rounded-[4px] border border-[var(--color-line)] bg-[var(--color-ink-950)]">
          {items.map((session) => (
            <div
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-4 p-4 transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink-900)_50%,transparent)]"
            >
              <div className="flex items-start gap-3.5">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)]">
                  <DeviceIcon os={session.device.os} browser={session.device.browser} />
                </div>

                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-medium tracking-[-0.01em]">
                      {session.device.browser} on {session.device.os}
                    </span>

                    {session.isCurrent && (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_oklab,var(--color-signal)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-signal)_10%,transparent)] px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-signal)]">
                        <Dot tone="ok" size={4.5} />
                        this device
                      </span>
                    )}

                    {session.country && (
                      <span className="rounded border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
                        {session.country}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-fg-dim)]">
                    {session.ip && <span>{session.ip}</span>}
                    <span>•</span>
                    <span>
                      {session.isCurrent ? (
                        <span className="text-[var(--color-signal)] font-medium">active now</span>
                      ) : (
                        `last seen ${since(session.lastSeen)}`
                      )}
                    </span>
                    <span>•</span>
                    <span>
                      first seen {new Date(session.firstSeen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                    {session.loginCount > 1 && (
                      <>
                        <span>•</span>
                        <span>{session.loginCount} logins</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div>
                {session.isCurrent ? (
                  <span className="font-mono text-[11px] text-[var(--color-fg-dim)]">
                    (current)
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="danger"
                    disabled={revokingId === session.id}
                    onClick={() => revokeOne(session.id)}
                    className="py-1 px-2.5 text-[11px]"
                  >
                    {revokingId === session.id ? 'revoking…' : 'Revoke'}
                  </Button>
                )}
              </div>
            </div>
          ))}

          {!items.length && !sessions.error && (
            <div className="p-8 text-center font-mono text-[11.5px] text-[var(--color-fg-dim)]">
              loading active sessions…
            </div>
          )}
        </div>
      </div>
    </Panel>
  )
}
