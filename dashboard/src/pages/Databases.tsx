import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { databaseRoute, type DatabaseView } from '../lib/databases'
import { mb } from '../lib/format'
import {
  Button,
  Empty,
  ErrorNote,
  Field,
  Panel,
  StatusPill,
} from '../components/ui'
import DatabaseCreate from '../components/DatabaseCreate'
import DatabaseTargets from '../components/DatabaseTargets'

export default function Databases() {
  const { fleet } = useAuth()
  const [params, setParams] = useSearchParams()
  const project = params.get('project') ?? ''
  if (!fleet)
    return (
      <Empty
        title="Choose a fleet"
        hint="Select a fleet to see its databases."
      />
    )
  return (
    <DatabaseList
      key={`${fleet.id}:${project}`}
      fleetId={fleet.id}
      role={fleet.role}
      project={project}
      onProject={(next) => setParams(next ? { project: next } : {})}
    />
  )
}

function DatabaseList({
  fleetId,
  role,
  project,
  onProject,
}: {
  fleetId: string
  role: string
  project: string
  onProject: (value: string) => void
}) {
  const [filter, setFilter] = useState(project),
    [creating, setCreating] = useState(false)
  const [older, setOlder] = useState<DatabaseView[]>([]),
    [cursor, setCursor] = useState<string | null | undefined>()
  const [loadingMore, setLoadingMore] = useState(false),
    [pageError, setPageError] = useState<unknown>(null)
  const path = `/fleets/${fleetId}/databases?${new URLSearchParams({ limit: '50', ...(project ? { project } : {}) })}`
  const result = usePoll(
    () => api<{ databases: DatabaseView[]; nextCursor: string | null }>(path),
    path,
  )
  const databases = [...(result.data?.databases ?? []), ...older].filter(
    (item, index, all) =>
      all.findIndex((other) => other.id === item.id) === index,
  )
  const canCreate = role === 'admin' || role === 'owner'
  const nextCursor = cursor === undefined ? result.data?.nextCursor : cursor
  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setPageError(null)
    try {
      const page = await api<{
        databases: DatabaseView[]
        nextCursor: string | null
      }>(`${path}&after=${encodeURIComponent(nextCursor)}`)
      setOlder((current) => [...current, ...page.databases])
      setCursor(page.nextCursor)
    } catch (error) {
      setPageError(error)
    } finally {
      setLoadingMore(false)
    }
  }
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mono-label">Stateful resources</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Databases
          </h1>
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
            Private data, pinned to your hardware.
          </p>
        </div>
        {canCreate && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            Create database
          </Button>
        )}
      </header>
      <form
        className="flex max-w-lg items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          onProject(filter)
        }}
      >
        <div className="min-w-0 flex-1">
          <Field
            label="Project"
            value={filter}
            maxLength={128}
            placeholder="All projects"
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <Button type="submit">Filter</Button>
      </form>
      <ErrorNote error={result.error ?? pageError} />
      <Panel
        title={`${project || 'All projects'} · ${databases.length} loaded`}
        right={<Button onClick={result.refetch}>Refresh</Button>}
      >
        {result.loading && !result.data ? (
          <p role="status" className="p-6 text-sm text-[var(--color-fg-muted)]">
            Loading databases…
          </p>
        ) : !databases.length ? (
          <Empty
            title="No databases in this scope"
            hint="Create a Postgres or Redis database, then link it to your application."
            action={
              canCreate ? (
                <Button onClick={() => setCreating(true)}>
                  Create database
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="divide-y divide-[var(--color-line)]">
            {databases.map((database) => (
              <Link
                key={database.id}
                to={databaseRoute(database)}
                className="group grid gap-3 p-5 transition-colors hover:bg-[var(--color-ink-900)] sm:grid-cols-[minmax(0,1.4fr)_1fr_1fr]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="truncate font-medium group-hover:text-[var(--color-signal)]">
                      {database.name}
                    </span>
                    <StatusPill status={database.status} />
                  </div>
                  <p className="mt-1 font-mono text-xs text-[var(--color-fg-dim)]">
                    {database.project} / {database.engine} {database.version}
                  </p>
                </div>
                <div>
                  <p className="mono-label">Data location</p>
                  <p className="mt-1 text-sm">
                    {database.nodeName ?? 'Awaiting placement'}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-fg-dim)]">
                    {database.nodeId ? 'Volume pinned' : 'No node assigned'}
                  </p>
                </div>
                <div className="font-mono text-xs text-[var(--color-fg-muted)]">
                  <p>
                    {mb(database.memoryMb)} RAM · {database.cpu} CPU
                  </p>
                  <p className="mt-2">{mb(database.diskMb)} disk reserved</p>
                  {!database.backupConfigured && (
                    <p className="mt-2 text-[var(--color-warn)]">
                      No off-node backups
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
        {nextCursor && (
          <div className="border-t border-[var(--color-line)] p-4 text-center">
            <Button onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </Panel>
      {project && (
        <DatabaseTargets
          fleetId={fleetId}
          project={project}
          canManage={canCreate}
        />
      )}
      {creating && (
        <DatabaseCreate
          fleetId={fleetId}
          initialProject={project}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  )
}
