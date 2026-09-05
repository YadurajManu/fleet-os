import { useState } from 'react'
import { api } from '../lib/api'
import { usePoll } from '../lib/auth'
import { since } from '../lib/format'
import { Button, ConfirmDialog, ErrorNote } from './ui'
import { TableSkeleton } from './Skeleton'

/**
 * What copies of this service's data exist, and how old they are.
 *
 * `fleet backup`, `fleet backups` and `fleet restore` have existed for a while
 * and the dashboard never showed any of them, so the one view people keep open
 * could not answer *do I have a backup of this database, and how old is it* —
 * which is the question you ask at exactly the moment you are least able to
 * open a terminal calmly.
 *
 * Restore is deliberately the most guarded thing on this page. It overwrites a
 * volume with older contents, and unlike almost everything else Fleet does it
 * cannot be undone by running it again: the data that was there is gone. So it
 * asks for the service name to be typed, the way `fleet rm` does, and says what
 * will happen in words rather than trusting a red button to carry the meaning.
 */

type Backup = {
  id: string
  status: 'pending' | 'running' | 'complete' | 'failed'
  sizeBytes: number | null
  failureReason: string | null
  scheduled: boolean
  createdAt: string
  finishedAt: string | null
}

function size(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function Backups({
  fleetId,
  serviceId,
  serviceName,
  running,
}: {
  fleetId: string
  serviceId: string
  serviceName: string
  /** Restore needs the service stopped; the button says so rather than failing. */
  running: boolean
}) {
  const { data, error, loading, refetch } = usePoll(
    () => api<{ backups: Backup[] }>(`/fleets/${fleetId}/services/${serviceId}/backups`),
    [fleetId, serviceId]
  )
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState<Backup | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)

  const backups = data?.backups ?? []

  const take = async () => {
    setBusy(true)
    setActionError(null)
    try {
      await api(`/fleets/${fleetId}/services/${serviceId}/backups`, { method: 'POST', body: {} })
      refetch()
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (backup: Backup) => {
    setBusy(true)
    setActionError(null)
    try {
      await api(`/fleets/${fleetId}/backups/${backup.id}/restore`, { method: 'POST', body: {} })
      setRestoring(null)
      refetch()
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(false)
    }
  }

  const newest = backups.find((b) => b.status === 'complete')

  return (
    <div>
      <div className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] px-5 py-3">
        {/*
          The age of the newest good one, first and in words. It is the only
          thing anybody wants from this panel at a glance, and a table of rows
          makes a reader work it out.
        */}
        <p className="text-[12px] text-[var(--color-fg-muted)]">
          {newest ? (
            <>
              newest copy <span className="text-[var(--color-fg)]">{since(newest.createdAt)}</span>
              <span className="ml-2 font-mono text-[11px] text-[var(--color-fg-dim)]">
                {size(newest.sizeBytes)}
              </span>
            </>
          ) : loading ? (
            'looking…'
          ) : (
            <span className="text-[var(--color-warn)]">no completed backup of this volume</span>
          )}
        </p>
        <Button onClick={() => void take()} disabled={busy}>
          back up now
        </Button>
      </div>

      {error != null && <ErrorNote error={error} />}
      {actionError != null && <ErrorNote error={actionError} />}

      {loading && !backups.length ? (
        <TableSkeleton rows={3} columns={[26, 22, 22, 30]} />
      ) : !backups.length ? (
        <p className="px-5 py-6 text-[12px] text-[var(--color-fg-dim)]">
          Nothing has been backed up yet. A service with a volume can be copied off its node at any
          time, and a manifest saying <code className="font-mono">backup: daily</code> does it on a
          schedule.
        </p>
      ) : (
        <table className="w-full">
          <tbody className="divide-y divide-[var(--color-line)]">
            {backups.map((b) => (
              <tr key={b.id}>
                <td className="px-5 py-2.5 font-mono text-[11px] text-[var(--color-fg-muted)]">
                  {since(b.createdAt)}
                </td>
                <td className="px-2 py-2.5 font-mono text-[11px] text-[var(--color-fg-dim)]">
                  {b.scheduled ? 'scheduled' : 'manual'}
                </td>
                <td className="px-2 py-2.5 font-mono text-[11px] text-[var(--color-fg-dim)]">
                  {size(b.sizeBytes)}
                </td>
                <td className="px-2 py-2.5">
                  {b.status === 'complete' ? (
                    <Button variant="ghost" onClick={() => setRestoring(b)} disabled={busy}>
                      restore
                    </Button>
                  ) : b.status === 'failed' ? (
                    // The reason, not just the word. A failed backup is only
                    // actionable if you know whether the node was down or the
                    // volume was missing.
                    <span
                      className="font-mono text-[11px] text-[var(--color-down)]"
                      title={b.failureReason ?? undefined}
                    >
                      failed
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] text-[var(--color-fg-dim)]">{b.status}…</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {restoring && (
        <ConfirmDialog
          open
          title={`Restore ${serviceName} from ${since(restoring.createdAt)}?`}
          body={
            running
              ? `${serviceName} is running. Stop it first — restoring into a live volume is how a database ends up half one copy and half another.`
              : `Everything currently in this volume is replaced by the copy taken ${since(restoring.createdAt)}. Anything written since then is gone, and running this again will not bring it back.`
          }
          // Typed, not clicked. The same friction `fleet rm` has, for the same
          // reason: this is the one action here that destroys data.
          confirmPhrase={running ? undefined : serviceName}
          confirmLabel="Restore"
          busy={busy}
          onCancel={() => setRestoring(null)}
          onConfirm={() => void (running ? setRestoring(null) : restore(restoring))}
        />
      )}
    </div>
  )
}
