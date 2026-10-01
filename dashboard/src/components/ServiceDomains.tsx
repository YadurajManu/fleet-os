import { useState } from 'react'
import { api } from '../lib/api'
import { usePoll } from '../lib/auth'
import { Button, ConfirmDialog, Copyable, ErrorNote, Panel } from './ui'

type Domain = {
  id: string
  host: string
  kind: 'managed_alias' | 'custom'
  source: 'api' | 'manifest' | 'legacy'
  challenge: string | null
  verifiedAt: string | null
  tlsVerifiedAt: string | null
  primary: boolean
  status: string
}
type DomainList = { managed: string | null; primary: string | null; target: string; targetAddresses: string[]; domains: Domain[] }
type Check = { ownership: boolean; routing: boolean; tls: boolean; observedA: string[]; observedAAAA: string[]; status: string }

export default function ServiceDomains({ serviceId, canEdit }: { serviceId: string; canEdit: boolean }) {
  const path = `/services/${serviceId}/domains`
  const { data, error, refetch } = usePoll(() => api<DomainList>(path), path, 10000)
  const [host, setHost] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [observed, setObserved] = useState<Record<string, Check>>({})
  const [remove, setRemove] = useState<Domain | null>(null)

  async function action(id: string, run: () => Promise<unknown>) {
    setBusy(id)
    setActionError(null)
    try { await run(); refetch() } catch (err) { setActionError(err) } finally { setBusy(null) }
  }

  return <Panel title="domains" right={<span className="font-mono text-[10px] text-[var(--color-fg-dim)]">HTTPS · follows this service across nodes</span>}>
    <div className="space-y-5 p-5">
      <div className="font-mono text-[11px] text-[var(--color-fg-muted)]">Primary URL: <span className="text-[var(--color-fg)]">{data?.primary ?? 'loading…'}</span></div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--color-line)] bg-[var(--color-ink-900)] p-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-fg-dim)]">Permanent Fleet address</div>
          {data?.managed ? <a href={`https://${data.managed}`} target="_blank" rel="noreferrer" className="mt-1 block break-all font-mono text-[12px] text-[var(--color-signal)]">{data.managed}</a> : <span className="text-[var(--color-fg-dim)]">Internal service · no public address</span>}
        </div>
        {data?.managed && <Copyable text={`https://${data.managed}`} />}
        {canEdit && data?.managed && data.primary !== data.managed && <Button disabled={busy !== null}
          onClick={() => void action('managed', () => api(`${path}/managed/primary`, { method: 'POST' }))}>Make primary</Button>}
      </div>

      {data?.managed && <>
        <div className="flex flex-wrap gap-2">
          <input aria-label="New domain or Fleet address" value={host} onChange={(event) => setHost(event.target.value)}
            placeholder="app.example.com or a Fleet name" className="min-w-[220px] flex-1 rounded border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-3 py-2 font-mono text-[12px] outline-none focus:border-[var(--color-signal)]" disabled={!canEdit || busy !== null} />
          {canEdit && <Button variant="primary" disabled={!host.trim() || busy !== null} onClick={() => void action('add', async () => {
            await api(path, { method: 'POST', body: { host: host.trim() } }); setHost('')
          })}>{busy === 'add' ? 'Adding…' : 'Add domain'}</Button>}
        </div>
        <p className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">A Fleet name works under this zone. For your own domain, prove ownership with DNS first; the existing address stays live.</p>
        <ErrorNote error={error ?? actionError} />
        <div className="space-y-3">
          {data?.domains.map((domain) => {
            const check = observed[domain.id]
            const status = check?.status ?? domain.status
            return <div key={domain.id} className="rounded border border-[var(--color-line)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={`https://${domain.host}`} target="_blank" rel="noreferrer" className="break-all font-mono text-[12px] text-[var(--color-fg)] hover:text-[var(--color-signal)]">{domain.host}</a>
                    {domain.primary && <span className="rounded border border-[var(--color-signal)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-signal)]">PRIMARY</span>}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-[var(--color-fg-dim)]">{status.replaceAll('_', ' ')} · {domain.kind === 'managed_alias' ? 'Fleet address' : 'your domain'}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Copyable text={`https://${domain.host}`} />
                  {canEdit && domain.kind === 'custom' && <Button disabled={busy !== null} onClick={() => void action(domain.id, async () => {
                    const result = await api<Check>(`${path}/${domain.id}/check`, { method: 'POST' })
                    setObserved((current) => ({ ...current, [domain.id]: result }))
                  })}>Check DNS</Button>}
                  {canEdit && !domain.primary && <Button disabled={busy !== null || (domain.kind === 'custom' && !domain.tlsVerifiedAt)} onClick={() => void action(domain.id, () => api(`${path}/${domain.id}/primary`, { method: 'POST' }))}>Make primary</Button>}
                  {canEdit && domain.source !== 'manifest' && <Button variant="danger" disabled={busy !== null} onClick={() => setRemove(domain)}>Remove</Button>}
                </div>
              </div>
              {domain.kind === 'custom' && <div className="mt-4 grid gap-3 border-t border-[var(--color-line)] pt-3 md:grid-cols-2">
                <div className="font-mono text-[10.5px] text-[var(--color-fg-muted)]"><span className="block uppercase text-[var(--color-fg-dim)]">1 · Prove ownership · TXT</span><span className="mt-1 block break-all">_fleet-challenge.{domain.host}</span><Copyable text={`_fleet-challenge.${domain.host}`} /><span className="mt-1 block break-all">{domain.challenge}</span>{domain.challenge && <Copyable text={domain.challenge} />}</div>
                <div className="font-mono text-[10.5px] text-[var(--color-fg-muted)]"><span className="block uppercase text-[var(--color-fg-dim)]">2 · Point DNS</span><span className="mt-1 block break-all">Subdomain: CNAME {domain.host} → {data.target}</span><Copyable text={data.target} /><span className="mt-1 block break-all">Apex: A {data.targetAddresses.join(', ') || 'look up the ingress IP'}</span>{data.targetAddresses.length > 0 && <Copyable text={data.targetAddresses.join(', ')} />}<span className="mt-1 block">DNS-only; proxy off. Remove other A/AAAA records. Direct TLS exposes the ingress IP.</span>{check && !check.routing && <span className="mt-1 block text-[var(--color-warn)]">Current A: {check.observedA.join(', ') || 'not found'} · AAAA: {check.observedAAAA.join(', ') || 'none'}</span>}</div>
              </div>}
            </div>
          })}
          {!data?.domains.length && <p className="font-mono text-[11px] text-[var(--color-fg-dim)]">No additional addresses yet. The permanent Fleet URL is already serving.</p>}
        </div>
      </>}
    </div>
    <ConfirmDialog open={!!remove} title="Remove domain" body={remove ? `Remove ${remove.host}? The permanent Fleet URL remains available.` : ''}
      confirmLabel="Remove domain" busy={busy !== null} onCancel={() => setRemove(null)} onConfirm={() => {
        if (!remove) return
        const selected = remove
        setRemove(null)
        void action(selected.id, () => api(`${path}/${selected.id}`, { method: 'DELETE' }))
      }} />
  </Panel>
}
