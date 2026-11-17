import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import {
  databasePath,
  databaseRequestKey,
  databaseRoute,
  type DatabaseCatalog,
  type DatabasePlacement,
  type DatabaseView,
} from '../lib/databases'
import { Button, ErrorNote, Field, Panel } from './ui'

const selectClass =
  'mt-2 w-full rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-signal)]'

export default function DatabaseCreate({
  fleetId,
  initialProject,
  onClose,
}: {
  fleetId: string
  initialProject: string
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [project, setProject] = useState(initialProject || '')
  const [name, setName] = useState('primary')
  const [engine, setEngine] = useState<'postgres' | 'redis'>('postgres')
  const [version, setVersion] = useState('17')
  const [mode, setMode] = useState('standard')
  const [profile, setProfile] = useState('standard')
  const [memory, setMemory] = useState('512'),
    [cpu, setCpu] = useState('0.5'),
    [disk, setDisk] = useState('10240')
  const [catalog, setCatalog] = useState<DatabaseCatalog | null>(null)
  const [placement, setPlacement] = useState<DatabasePlacement | null>(null)
  const [selected, setSelected] = useState('')
  const [selectedPlacement, setSelectedPlacement] =
    useState<DatabasePlacement | null>(null)
  const [checkingSelection, setCheckingSelection] = useState(false)
  const [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null)
  const attempt = useRef<{ body: string; key: string } | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const valid =
    project.length > 0 &&
    project.length <= 128 &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) &&
    Number.isInteger(Number(memory)) &&
    Number(memory) >= 128 &&
    Number(cpu) > 0 &&
    Number(cpu) <= 1024 &&
    Number.isInteger(Number(disk)) &&
    Number(disk) >= 1024

  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    if (!project.trim()) return
    const controller = new AbortController()
    setCatalog(null)
    void api<DatabaseCatalog>(`${databasePath(fleetId, project)}/catalog`, {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) setCatalog(next)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err)
      })
    return () => controller.abort()
  }, [fleetId, project])
  useEffect(() => {
    if (!review || !valid) return
    const controller = new AbortController()
    setPlacement(null)
    setError(null)
    const query = new URLSearchParams({ memoryMb: memory, cpu, diskMb: disk })
    void api<DatabasePlacement>(
      `${databasePath(fleetId, project)}/placement?${query}`,
      { signal: controller.signal },
    )
      .then((next) => {
        if (!controller.signal.aborted) setPlacement(next)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err)
      })
    return () => controller.abort()
  }, [fleetId, project, memory, cpu, disk, review, valid])

  useEffect(() => {
    if (!review || !placement || !selected || selected === placement.nodeId) {
      setSelectedPlacement(null)
      setCheckingSelection(false)
      return
    }
    const controller = new AbortController()
    setSelectedPlacement(null)
    setCheckingSelection(true)
    const query = new URLSearchParams({
      memoryMb: memory,
      cpu,
      diskMb: disk,
      nodeId: selected,
    })
    void api<DatabasePlacement>(
      `${databasePath(fleetId, project)}/placement?${query}`,
      { signal: controller.signal },
    )
      .then((next) => {
        if (!controller.signal.aborted) setSelectedPlacement(next)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err)
      })
      .finally(() => {
        if (!controller.signal.aborted) setCheckingSelection(false)
      })
    return () => controller.abort()
  }, [fleetId, project, memory, cpu, disk, review, selected, placement])

  const selectedEngine = catalog?.engines.find((item) => item.engine === engine)
  const catalogValid =
    !!selectedEngine?.versions.includes(version) &&
    selectedEngine.modes.includes(mode) &&
    (engine === 'redis' || selectedEngine.profiles.includes(profile))
  const candidate = placement?.candidates.find(
    (node) => node.nodeId === (selected || placement.nodeId),
  )
  const selectionValid =
    !selected ||
    selected === placement?.nodeId ||
    (selectedPlacement?.outcome === 'placed' &&
      selectedPlacement.nodeId === selected)
  const warnings =
    selected && selected !== placement?.nodeId
      ? (selectedPlacement?.warnings ?? [])
      : (placement?.warnings ?? [])
  async function submit() {
    if (
      !valid ||
      !catalogValid ||
      !candidate ||
      !selectionValid ||
      checkingSelection ||
      busy
    )
      return
    const body = {
      name,
      engine,
      version,
      mode,
      memoryMb: Number(memory),
      cpu: Number(cpu),
      diskMb: Number(disk),
      profile,
      nodeId: candidate.nodeId,
    }
    const encoded = JSON.stringify(body)
    if (attempt.current?.body !== encoded)
      attempt.current = { body: encoded, key: databaseRequestKey() }
    setBusy(true)
    setError(null)
    try {
      const result = await api<{ database: DatabaseView }>(
        databasePath(fleetId, project),
        { method: 'POST', body, idempotencyKey: attempt.current.key },
      )
      navigate(databaseRoute(result.database))
      onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      className="max-h-[90vh] w-[min(720px,calc(100vw-2rem))] overflow-auto rounded-[4px] border border-[var(--color-line-2)] bg-[var(--color-ink-950)] p-0 text-[var(--color-fg)] backdrop:bg-black/70"
      aria-labelledby="database-create-title"
    >
      <div className="border-b border-[var(--color-line)] p-5 flex items-start justify-between gap-4">
        <div>
          <p className="mono-label">
            {review ? '02 / placement' : '01 / database'}
          </p>
          <h2 id="database-create-title" className="mt-2 text-xl font-semibold">
            Create a database
          </h2>
        </div>
        <Button
          onClick={onClose}
          disabled={busy}
          aria-label="Close create database"
        >
          Close
        </Button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (review) void submit()
          else if (valid && catalogValid) setReview(true)
        }}
      >
        <div className="space-y-5 p-5">
          <ErrorNote error={error} />
          {!review ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Project"
                  value={project}
                  maxLength={128}
                  required
                  onChange={(event) => setProject(event.target.value)}
                  hint="The existing project name, matched exactly."
                />
                <Field
                  label="Database name"
                  value={name}
                  required
                  maxLength={63}
                  pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <label>
                  <span className="mono-label">Engine</span>
                  <select
                    className={selectClass}
                    value={engine}
                    onChange={(event) => {
                      const next = event.target.value as 'postgres' | 'redis'
                      setEngine(next)
                      setVersion(next === 'postgres' ? '17' : '7')
                      setMode(next === 'postgres' ? 'standard' : 'durable')
                      setProfile('standard')
                    }}
                  >
                    <option value="postgres">Postgres</option>
                    <option value="redis">Redis</option>
                  </select>
                </label>
                <label>
                  <span className="mono-label">Version</span>
                  <select
                    className={selectClass}
                    value={version}
                    onChange={(event) => setVersion(event.target.value)}
                  >
                    {selectedEngine?.versions.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="mono-label">Mode</span>
                  <select
                    className={selectClass}
                    value={mode}
                    onChange={(event) => setMode(event.target.value)}
                  >
                    {selectedEngine?.modes.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field
                  label="Memory · MiB"
                  type="number"
                  min="128"
                  max="1048576"
                  step="1"
                  required
                  value={memory}
                  onChange={(event) => setMemory(event.target.value)}
                />
                <Field
                  label="CPU cores"
                  type="number"
                  min="0.01"
                  max="1024"
                  step="0.01"
                  required
                  value={cpu}
                  onChange={(event) => setCpu(event.target.value)}
                />
                <Field
                  label="Disk reservation · MiB"
                  type="number"
                  min="1024"
                  step="1"
                  required
                  value={disk}
                  onChange={(event) => setDisk(event.target.value)}
                />
              </div>
              {engine === 'postgres' && (
                <label className="block">
                  <span className="mono-label">Tuning profile</span>
                  <select
                    className={selectClass}
                    value={profile}
                    onChange={(event) => setProfile(event.target.value)}
                  >
                    {selectedEngine?.profiles.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
              )}
              {engine === 'redis' && (
                <p className="border-l-2 border-[var(--color-warn)] pl-3 text-sm text-[var(--color-warn)]">
                  {mode === 'cache'
                    ? 'Cache mode has no persistence and can evict keys. A restart can lose all cached data.'
                    : 'Durable mode uses AOF and no eviction. When memory is full, writes fail instead of silently evicting data.'}
                </p>
              )}
              {!catalog && (
                <p
                  className="text-sm text-[var(--color-fg-muted)]"
                  role="status"
                >
                  {project
                    ? 'Loading supported engines…'
                    : 'Choose a project to load the engine catalog.'}
                </p>
              )}
            </>
          ) : (
            <>
              <Panel title={`${engine} ${version} · ${name}`}>
                <p className="p-4 text-sm text-[var(--color-fg-muted)]">
                  {project} · {memory} MiB RAM · {cpu} CPU · {disk} MiB disk
                  reservation
                </p>
              </Panel>
              {!placement && !error && (
                <p
                  role="status"
                  className="text-sm text-[var(--color-fg-muted)]"
                >
                  Checking node capacity and stability…
                </p>
              )}
              {placement?.outcome === 'no_eligible_node' && (
                <p role="alert" className="text-sm text-[var(--color-warn)]">
                  {placement.summary}
                </p>
              )}
              {!!placement?.candidates.length && (
                <fieldset>
                  <legend className="mono-label mb-3">
                    Where the data will live
                  </legend>
                  <div className="space-y-2">
                    {placement.candidates.map((node) => (
                      <label
                        key={node.nodeId}
                        className={`flex cursor-pointer gap-3 rounded-[3px] border p-4 ${candidate?.nodeId === node.nodeId ? 'border-[var(--color-signal)] bg-[var(--color-ink-900)]' : 'border-[var(--color-line)]'}`}
                      >
                        <input
                          type="radio"
                          name="database-node"
                          className="mt-1 accent-[var(--color-signal)]"
                          value={node.nodeId}
                          checked={candidate?.nodeId === node.nodeId}
                          onChange={() => setSelected(node.nodeId)}
                        />
                        <span>
                          <span className="font-mono text-sm">
                            {node.nodeName}
                            {node.nodeId === placement.nodeId && (
                              <span className="ml-2 text-xs text-[var(--color-signal)]">
                                recommended
                              </span>
                            )}
                          </span>
                          <span className="mt-1 block text-xs leading-relaxed text-[var(--color-fg-muted)]">
                            {node.reason ?? `${node.freeRamMb} MiB spare RAM`}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              {warnings.map((warning) => (
                <p
                  key={warning}
                  role="status"
                  className="text-sm text-[var(--color-warn)]"
                >
                  {warning}
                </p>
              ))}
              {checkingSelection && (
                <p
                  role="status"
                  className="text-sm text-[var(--color-fg-muted)]"
                >
                  Checking selected node…
                </p>
              )}
              {selectedPlacement?.outcome === 'no_eligible_node' && (
                <p role="alert" className="text-sm text-[var(--color-warn)]">
                  {selectedPlacement.summary}
                </p>
              )}
              {!!placement?.rejected.length && (
                <details className="text-sm text-[var(--color-fg-muted)]">
                  <summary className="cursor-pointer font-mono text-xs">
                    Unavailable nodes ({placement.rejected.length})
                  </summary>
                  <ul className="mt-2 space-y-2">
                    {placement.rejected.map((item) => (
                      <li key={`${item.nodeId}-${item.code}`}>
                        <strong>{item.nodeName}</strong>: {item.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="border-l-2 border-[var(--color-warn)] pl-3 text-sm leading-relaxed text-[var(--color-warn)]">
                No off-node backup target is configured. Losing this node can
                lose the database. The data stays pinned here if the node
                disconnects.
              </p>
            </>
          )}
        </div>
        <div className="flex justify-between gap-3 border-t border-[var(--color-line)] p-5">
          <Button
            type="button"
            onClick={() => (review ? setReview(false) : onClose())}
            disabled={busy}
          >
            {review ? 'Back' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={
              busy ||
              !valid ||
              !catalogValid ||
              (review && (!candidate || !selectionValid || checkingSelection))
            }
          >
            {busy
              ? 'Creating…'
              : review
                ? 'Create database'
                : 'Choose placement'}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
