import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import {
  databasePath,
  databaseRequestKey,
  operationActive,
  useDatabaseEvents,
  type DatabaseOperation,
  type DatabaseProgress,
  type DatabaseView,
} from '../lib/databases'
import { mb, since } from '../lib/format'
import {
  Button,
  ConfirmDialog,
  Copyable,
  Empty,
  ErrorNote,
  Panel,
  StatusPill,
} from '../components/ui'

export default function DatabaseDetail() {
  const { fleet } = useAuth()
  const { project, databaseId } = useParams()
  if (!fleet || !project || !databaseId)
    return (
      <Empty
        title="Choose a database"
        hint="Select a database from the fleet's database list."
      />
    )
  return (
    <DatabaseDetailContent
      key={`${fleet.id}:${project}:${databaseId}`}
      fleetId={fleet.id}
      project={project}
      databaseId={databaseId}
      canOperate={fleet.role !== 'viewer'}
    />
  )
}

function DatabaseDetailContent({
  fleetId,
  project,
  databaseId,
  canOperate,
}: {
  fleetId: string
  project: string
  databaseId: string
  canOperate: boolean
}) {
  const path = databasePath(fleetId, project, databaseId)
  const result = usePoll(
    () =>
      api<{ database: DatabaseView; operations: DatabaseOperation[] }>(path),
    path,
    5000,
  )
  const [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'stop' | 'restart' | null>(null)
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, DatabaseProgress>>({})
  const attempt = useRef<{ action: string; key: string } | null>(null)
  const stream = useDatabaseEvents(
    result.data ? `${path}/events` : null,
    (event) => {
      setProgress((current) => {
        const next = { ...current, [event.operationId]: event }
        const oldest = Object.keys(next)[0]
        if (Object.keys(next).length > 100 && oldest) delete next[oldest]
        return next
      })
      result.refetch()
    },
  )
  const database = result.data?.database
  const operations = result.data?.operations ?? []
  const active =
    operations.some(operationActive) ||
    !!(
      submitted &&
      !operations.some(
        (operation) =>
          operation.id === submitted && !operationActive(operation),
      )
    )
  const available = database?.nodeStatus === 'online' && !database.deletedAt
  async function action(name: 'start' | 'stop' | 'restart') {
    if (busy || active) return
    if (attempt.current?.action !== name)
      attempt.current = { action: name, key: databaseRequestKey() }
    setBusy(true)
    setError(null)
    try {
      const accepted = await api<{ operation: DatabaseOperation }>(
        `${path}/actions`,
        {
          method: 'POST',
          body: { action: name },
          idempotencyKey: attempt.current.key,
        },
      )
      setSubmitted(accepted.operation.id)
      attempt.current = null
      setConfirm(null)
      result.refetch()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  if (!database)
    return (
      <div className="space-y-4">
        <Link
          to="/databases"
          className="font-mono text-xs text-[var(--color-fg-muted)]"
        >
          ← Databases
        </Link>
        <ErrorNote error={result.error} />
        <p role="status" className="text-sm text-[var(--color-fg-muted)]">
          {result.loading ? 'Loading database…' : 'Database unavailable.'}
        </p>
      </div>
    )
  return (
    <div className="space-y-6">
      <Link
        to={`/databases?project=${encodeURIComponent(project)}`}
        className="font-mono text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      >
        ← {project} databases
      </Link>
      <header className="flex flex-wrap justify-between gap-4">
        <div>
          <p className="mono-label">
            {project} / {database.engine} {database.version}
          </p>
          <h1 className="mt-2 text-2xl font-semibold">{database.name}</h1>
          <div className="mt-3">
            <StatusPill status={database.status} />
          </div>
        </div>
        {canOperate && (
          <div className="flex flex-wrap items-start gap-2">
            {database.status !== 'running' && (
              <Button
                variant="primary"
                disabled={busy || active || !available}
                onClick={() => void action('start')}
              >
                Start
              </Button>
            )}
            {database.status === 'running' && (
              <>
                <Button
                  disabled={busy || active || !available}
                  onClick={() => setConfirm('restart')}
                >
                  Restart
                </Button>
                <Button
                  variant="danger"
                  disabled={busy || active || !available}
                  onClick={() => setConfirm('stop')}
                >
                  Stop
                </Button>
              </>
            )}
          </div>
        )}
      </header>
      <ErrorNote error={error ?? result.error} />
      {!database.backupConfigured && (
        <div
          className="border-l-2 border-[var(--color-warn)] bg-[var(--color-ink-900)] p-5"
          role="status"
        >
          <p className="font-mono text-xs uppercase tracking-wider text-[var(--color-warn)]">
            No off-node backups
          </p>
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-fg-muted)]">
            Losing this node can lose the database. There is no verified
            off-node recovery point.
          </p>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Data location">
          <div className="space-y-4 p-5">
            <div className="flex justify-between gap-4">
              <div>
                <p className="text-lg font-medium">
                  {database.nodeName ?? 'No node assigned'}
                </p>
                <p className="mt-1 font-mono text-xs text-[var(--color-fg-dim)]">
                  Generation {database.generation} · volume pinned
                </p>
              </div>
              {database.nodeStatus && (
                <StatusPill status={database.nodeStatus} />
              )}
            </div>
            <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
              The data stays on this node when it disconnects. Fleet will not
              create an empty replacement on another machine.
            </p>
            {!available && (
              <p className="text-sm text-[var(--color-warn)]">
                Lifecycle actions need the pinned node online. Reconnect it
                before retrying.
              </p>
            )}
            {database.nodeId && <Copyable text={database.nodeId} />}
          </div>
        </Panel>
        <Panel title="Allocation">
          <dl className="grid grid-cols-2 gap-5 p-5">
            {[
              ['Memory', `${mb(database.memoryMb)}`],
              ['CPU', `${database.cpu} cores`],
              ['Disk reservation', mb(database.diskMb)],
              ['Profile / mode', `${database.profile} / ${database.mode}`],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="mono-label">{label}</dt>
                <dd className="mt-2 font-mono text-sm">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
      {database.warnings.length > 0 && (
        <Panel title="Placement and engine warnings">
          <ul className="space-y-3 p-5 text-sm text-[var(--color-warn)]">
            {database.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Panel>
      )}
      <Panel
        title="Operations"
        right={
          <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">
            {stream === 'live'
              ? 'Live progress'
              : stream === 'connecting'
                ? 'Connecting progress…'
                : stream === 'unavailable'
                  ? 'Progress unavailable'
                  : 'Reconnecting progress…'}
          </span>
        }
      >
        {!operations.length ? (
          <p className="p-5 text-sm text-[var(--color-fg-muted)]">
            No operations recorded.
          </p>
        ) : (
          <div className="divide-y divide-[var(--color-line)]">
            {operations.map((operation) => {
              const event = progress[operation.id]
              const value = event?.progress ?? operation.progress
              const state = event?.state ?? operation.state
              return (
                <div key={operation.id} className="p-5">
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-mono text-sm capitalize">
                      {operation.kind}
                    </span>
                    <StatusPill status={state} />
                  </div>
                  <div
                    className="mt-3 h-1 overflow-hidden rounded bg-[var(--color-ink-800)]"
                    role="progressbar"
                    aria-label={`${operation.kind} progress`}
                    aria-valuenow={value}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full bg-[var(--color-signal)] transition-[width]"
                      style={{ width: `${value}%` }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap justify-between gap-2 font-mono text-[10px] text-[var(--color-fg-dim)]">
                    <span>
                      {value}% · {event?.code ?? state}
                    </span>
                    <span>{since(operation.createdAt)}</span>
                  </div>
                  {operation.errorCode && (
                    <p className="mt-3 text-sm text-[var(--color-down)]">
                      {operation.errorCode.replace(/_/g, ' ')}. Check the pinned
                      node and operation before retrying.
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Panel>
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === 'stop'
            ? `Stop ${database.name}?`
            : `Restart ${database.name}?`
        }
        body={
          <div className="space-y-3">
            <p>
              {confirm === 'stop'
                ? 'Connections will close and linked applications may fail until this database starts again.'
                : 'Connections will close briefly while the database restarts cleanly on its pinned node.'}
            </p>
            <ErrorNote error={error} />
          </div>
        }
        consequences={['The data volume stays on the same node.']}
        confirmLabel={confirm === 'stop' ? 'Stop database' : 'Restart database'}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) void action(confirm)
        }}
      />
    </div>
  )
}
