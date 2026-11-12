import { useState } from 'react'
import { api } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { since } from '../lib/format'
import { Button, ConfirmDialog, Empty, ErrorNote, Panel } from '../components/ui'
import { TableSkeleton } from '../components/Skeleton'

/**
 * What credentials this fleet holds, and for what.
 *
 * `fleet secrets` has managed these since early on and the dashboard never
 * showed them, so the one view people keep open could not answer "is
 * DATABASE_URL set for this service" without opening a terminal.
 *
 * Names only, and that is not a limitation to be lifted later. The CLI is
 * careful never to echo a value — `fleet secrets set` reads it without printing
 * it — and a dashboard that displayed one would undo that from a different
 * direction: a value on screen is a value in a screenshot, a screen share, and
 * a browser's back-forward cache.
 *
 * Setting a value from here is deliberately absent for the same reason. It
 * would mean a credential travelling through a text input, a React state tree
 * and an autofill-eligible form. `fleet secrets set` exists and does none of
 * that.
 */

type Secret = {
  key: string
  scope: string
  /** Null for a fleet-wide secret; a service name when it is scoped to one. */
  service: string | null
  createdAt: string
  updatedAt: string
}

export default function Secrets() {
  const { fleet, fleets } = useAuth()
  const id = fleet?.id
  const { data, error, loading, refetch } = usePoll(
    () => api<{ secrets: Secret[] }>(`/fleets/${id}/secrets`),
    `/fleets/${id}/secrets`
  )
  // The secrets list names the service; the delete route takes its id. Without
  // this the scoped deletes would 404 while the fleet-wide ones worked, which
  // is the kind of half-broken that takes a while to notice.
  const services = usePoll(() => api<{ services: Array<{ id: string; name: string }> }>(`/fleets/${id}/services`), `/fleets/${id}/services`)
  const idOf = (name: string) => services.data?.services.find((x) => x.name === name)?.id

  const [copying, setCopying] = useState<Secret | null>(null)
  const [copyTo, setCopyTo] = useState('fleet')
  const [copyFleetId, setCopyFleetId] = useState('')
  const [copyKey, setCopyKey] = useState('')
  const [copyDone, setCopyDone] = useState('')
  const [removing, setRemoving] = useState<Secret | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<unknown>(null)
  const destinationFleetId = copyFleetId || id
  const destinationServices = usePoll(() => api<{ services: Array<{ id: string; name: string }> }>(`/fleets/${destinationFleetId}/services`), copying ? `/fleets/${destinationFleetId}/services` : null)

  const secrets = data?.secrets ?? []

  const remove = async (secret: Secret) => {
    setBusy(true)
    setActionError(null)
    try {
      // Scoped and fleet-wide secrets live at different paths, because a key
      // may exist as both and deleting the wrong one would look like nothing
      // happened.
      const serviceId = secret.service ? idOf(secret.service) : null
      if (secret.service && !serviceId) {
        throw new Error(
          `"${secret.service}" is no longer in this fleet, so its secrets cannot be removed from here. ` +
            `Use \`fleet secrets rm ${secret.key} --service ${secret.service}\`.`
        )
      }

      await api(
        serviceId
          ? `/services/${serviceId}/secrets/${encodeURIComponent(secret.key)}`
          : `/fleets/${id}/secrets/${encodeURIComponent(secret.key)}`,
        { method: 'DELETE' }
      )
      setRemoving(null)
      refetch()
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[19px] text-[var(--color-fg)]">Secrets</h1>
        <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
          Credentials this fleet holds, by name. Values are never shown here or
          anywhere else in this interface — set one with{' '}
          <code className="font-mono text-[12px]">fleet secrets set KEY</code>, which reads it
          without echoing it.
        </p>
      </div>

      {error != null && <ErrorNote error={error} />}
      {actionError != null && <ErrorNote error={actionError} />}

      <Panel title={`${secrets.length} stored`}>
        {loading && !secrets.length ? (
          <TableSkeleton rows={3} columns={[38, 24, 22, 16]} />
        ) : !secrets.length ? (
          <Empty
            title="No secrets stored"
            hint="A manifest declaring secrets: [DATABASE_URL] needs a value for each before it can deploy. Add them with `fleet secrets import .env`."
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--color-line)]">
                {['key', 'scope', 'updated', ''].map((h) => (
                  <th key={h} className="mono-label px-4 py-2 text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {secrets.map((s) => (
                <tr key={`${s.service ?? 'fleet'}:${s.key}`}>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-[var(--color-fg)]">{s.key}</td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-[var(--color-fg-muted)]">
                    {/* Which services can read it, which is the question people
                        actually have — not the internal scope enum. */}
                    {s.service ? s.service : 'every service'}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-[var(--color-fg-dim)]">
                    {since(s.updatedAt)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button variant="ghost" onClick={() => { setCopying(s); setCopyKey(s.key); setCopyTo('fleet'); setCopyFleetId(id ?? ''); setActionError(null); setCopyDone('') }}>copy</Button>
                    <Button variant="ghost" onClick={() => setRemoving(s)}>
                      remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {copyDone && <p role="status">{copyDone}</p>}
      {copying && <form className="rounded-lg border border-[var(--color-line)] p-4 space-y-3" onSubmit={async event => {
        event.preventDefault(); setBusy(true); setActionError(null)
        try {
          const fromServiceId = copying.service ? idOf(copying.service) : null
          if (copying.service && !fromServiceId) throw new Error('Source service is unavailable. Refresh and try again.')
          await api(`/fleets/${destinationFleetId}/secrets/clone`, { method: 'POST', body: { key: copying.key, fromFleetId: id, fromServiceId, toServiceId: copyTo === 'fleet' ? null : copyTo, toKey: copyKey } })
          setCopyDone(`${copyKey} copied. Declare it in the destination manifest's secrets or build_secrets, then redeploy affected services.`); setCopying(null); refetch()
        } catch (err) { setActionError(err) } finally { setBusy(false) }
      }}>
        <h2>Copy {copying.key}</h2>
        <p>The value stays hidden. Existing destination values are never overwritten.</p>
        <label>Destination fleet <select disabled={busy} value={destinationFleetId} onChange={e => { setCopyFleetId(e.target.value); setCopyTo('fleet') }}>{fleets.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label>Destination scope <select disabled={busy || destinationServices.loading} value={copyTo} onChange={e => setCopyTo(e.target.value)}><option value="fleet">Every service in destination fleet</option>{destinationServices.data?.services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <ErrorNote error={destinationServices.error} />
        <label>Key <input required pattern="[A-Z_][A-Z0-9_]{0,127}" value={copyKey} onChange={e => setCopyKey(e.target.value)} /></label>
        <button disabled={busy} type="submit">{busy ? 'Copying…' : 'Copy secret'}</button>{' '}
        <button disabled={busy} type="button" onClick={() => setCopying(null)}>Cancel</button>
      </form>}
      {removing && (
        <ConfirmDialog
          open
          title={`Remove ${removing.key}?`}
          // Said plainly, because the consequence is not obvious: the value is
          // gone and the next deploy of anything reading it fails.
          body={`The value is deleted and cannot be recovered. Any service whose manifest declares ${removing.key} will fail its next deploy until it is set again.`}
          confirmLabel="Remove"
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove(removing)}
        />
      )}
    </div>
  )
}
