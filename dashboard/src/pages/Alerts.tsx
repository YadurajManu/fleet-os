import { useState } from 'react'
import { api, type AlertRule } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { Button, Empty, ErrorNote, Field, Panel, Dot } from '../components/ui'

const CHANNELS = ['webhook', 'discord', 'slack', 'email'] as const

export default function Alerts() {
  const { fleet } = useAuth()
  const id = fleet?.id
  const canEdit = fleet?.role === 'owner' || fleet?.role === 'admin'

  const { data, error, loading } = usePoll(
    () => api<{ rules: AlertRule[] }>(`/fleets/${id}/alert-rules`),
    `/fleets/${id}/alert-rules`,
    15000
  )

  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>('webhook')
  const [target, setTarget] = useState('')
  const [secret, setSecret] = useState('')
  const [cooldownMinutes, setCooldownMinutes] = useState(360)
  const [cooldownOverrides, setCooldownOverrides] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  async function add() {
    setBusy('add')
    setActionError(null)
    try {
      await api(`/fleets/${id}/alert-rules`, {
        method: 'POST',
        body: {
          channelType: channel,
          ...(channel === 'email' ? { to: target } : { url: target }),
          ...(secret ? { secret } : {}),
          eventTypes: [],
          ...(channel === 'email' ? { nodeDownCooldownMinutes: cooldownMinutes } : {}),
        },
      })
      setTarget('')
      setSecret('')
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  async function test() {
    setBusy('test')
    setTestResult(null)
    setActionError(null)
    try {
      const res = await api<{ delivered: number; results: Array<{ channel: string; ok: boolean; error?: string }> }>(
        `/fleets/${id}/alert-rules/test`,
        { method: 'POST', body: {} }
      )
      setTestResult(
        res.results.length
          ? res.results.map((r) => `${r.channel}: ${r.ok ? 'delivered' : (r.error ?? 'failed')}`).join(' · ')
          : 'no rules to test'
      )
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  async function remove(rule: AlertRule) {
    setBusy(rule.id)
    try {
      await api(`/fleets/${id}/alert-rules/${rule.id}`, { method: 'DELETE' })
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  async function updateCooldown(rule: AlertRule, minutes: number) {
    setBusy(rule.id)
    setActionError(null)
    try {
      await api(`/fleets/${id}/alert-rules/${rule.id}`, {
        method: 'PATCH', body: { nodeDownCooldownMinutes: minutes },
      })
      setCooldownOverrides((prev) => ({ ...prev, [rule.id]: minutes }))
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  if (error) return <ErrorNote error={error} />
  const rules = data?.rules ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.03em]">Alerts</h1>
          <p className="mt-1 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
            A routine reschedule and a pinned service going down are not the same news. Both are
            delivered, at different severities.
          </p>
        </div>
        {rules.length > 0 && (
          <Button onClick={() => void test()} disabled={busy !== null}>
            {busy === 'test' ? 'sending…' : 'Send a test alert'}
          </Button>
        )}
      </div>

      <ErrorNote error={actionError} />
      {testResult && (
        <p className="border-l-2 border-[var(--color-signal)] py-2 pl-3 font-mono text-[11.5px] text-[var(--color-fg-muted)]">
          {testResult}
        </p>
      )}

      {!loading && !rules.length && (
        <Empty
          title="No alert rules"
          hint="Without one, failover happens silently. You would find out from a user, not from us."
        />
      )}

      {rules.length > 0 && (
        <Panel title="rules">
          <div className="divide-y divide-[var(--color-line)]">
            {rules.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
                <span className="flex min-w-[90px] items-center gap-2 font-mono text-[12px]">
                  <Dot tone={r.enabled ? 'ok' : 'idle'} size={5} />
                  {r.channelType}
                </span>
                <span className="min-w-[220px] flex-1 truncate font-mono text-[11.5px] text-[var(--color-fg-muted)]">
                  {r.target}
                </span>
                <span className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                  {r.eventTypes.length ? r.eventTypes.join(', ') : 'all events'}
                </span>
                {r.channelType === 'email' && (
                  <label className="flex items-center gap-2 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                    node-down cooldown
                    <input
                      aria-label="Node-down email cooldown"
                      type="number"
                      min={0}
                      max={168}
                      step={0.5}
                      value={(cooldownOverrides[r.id] ?? r.nodeDownCooldownMinutes) / 60}
                      disabled={!canEdit || busy !== null}
                      onChange={(e) => setCooldownOverrides((prev) => ({ ...prev, [r.id]: Math.round(Number(e.target.value) * 60) }))}
                      className="w-[65px] rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-2 py-1 text-[11px]"
                    /> h
                    {cooldownOverrides[r.id] !== undefined && cooldownOverrides[r.id] !== r.nodeDownCooldownMinutes && (
                      <Button onClick={() => void updateCooldown(r, cooldownOverrides[r.id]!)} disabled={busy !== null}>Save</Button>
                    )}
                  </label>
                )}
                {canEdit && (
                  <Button variant="danger" onClick={() => void remove(r)} disabled={busy === r.id}>
                    remove
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {canEdit && (
        <Panel title="add a rule">
          <div className="grid gap-4 p-5 sm:grid-cols-[160px_1fr_auto] sm:items-end">
            <label className="block">
              <span className="mono-label">channel</span>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as typeof channel)}
                className="mt-2 w-full cursor-pointer rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-3 py-2.5 font-mono text-[13px] outline-none"
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>

            <Field
              label={channel === 'email' ? 'address' : 'url'}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={channel === 'email' ? 'you@example.com' : 'https://…'}
              hint={
                channel === 'email'
                  ? 'Email needs a provider configured on the control plane.'
                  : undefined
              }
            />
            <Button variant="primary" onClick={() => void add()} disabled={busy !== null || !target}>
              {busy === 'add' ? 'adding…' : 'Add'}
            </Button>

            {channel === 'webhook' && (
              <div className="sm:col-span-3">
                <Field
                  label="signing secret (optional)"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="at least 16 characters"
                  hint="Payloads are signed with HMAC-SHA256 in x-fleet-signature, so your receiver can verify the alert really came from your control plane."
                />
              </div>
            )}
            {channel === 'email' && (
              <label className="block sm:col-span-3">
                <span className="mono-label">repeat node-down email cooldown</span>
                <select
                  value={cooldownMinutes}
                  onChange={(e) => setCooldownMinutes(Number(e.target.value))}
                  className="mt-2 w-full cursor-pointer rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-3 py-2.5 font-mono text-[13px] outline-none sm:max-w-[300px]"
                >
                  <option value={0}>Every transition</option>
                  <option value={360}>6 hours</option>
                  <option value={720}>12 hours</option>
                  <option value={1440}>24 hours</option>
                  {!([0, 360, 720, 1440].includes(cooldownMinutes)) && (
                    <option value={cooldownMinutes}>Custom</option>
                  )}
                </select>
                <input
                  aria-label="Custom node-down cooldown in hours"
                  type="number" min={0} max={168} step={0.5}
                  value={cooldownMinutes / 60}
                  onChange={(e) => setCooldownMinutes(Math.round(Number(e.target.value) * 60))}
                  className="ml-2 w-[75px] rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-2 py-2.5 font-mono text-[13px]"
                /> h
                <p className="mt-2 text-[12px] text-[var(--color-fg-muted)]">
                  Repeated offline events for the same node are quiet during this window. Other alerts still arrive.
                </p>
              </label>
            )}
          </div>
        </Panel>
      )}
    </div>
  )
}
