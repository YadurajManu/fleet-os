import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { usePoll } from '../lib/auth'
import { Button, ConfirmDialog, ErrorNote, Field, Panel } from './ui'

type Target = {
  id: string
  name: string
  endpoint: string
  bucket: string
  prefix: string
  region: string
  isDefault: boolean
  lastTestedAt: string | null
}

export default function DatabaseTargets({
  fleetId,
  project,
  canManage,
}: {
  fleetId: string
  project: string
  canManage: boolean
}) {
  const path = `/fleets/${encodeURIComponent(fleetId)}/projects/${encodeURIComponent(project)}/backup-targets`
  const result = usePoll(() => api<{ targets: Target[] }>(path), path)
  const [form, setForm] = useState({
    name: '',
    endpoint: '',
    bucket: '',
    region: 'us-east-1',
    prefix: '',
    accessKeyId: '',
    secretAccessKey: '',
    isDefault: false,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState<Target | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice('')
    try {
      await api(path, {
        method: 'POST',
        body: {
          name: form.name,
          endpoint: form.endpoint,
          bucket: form.bucket,
          region: form.region,
          ...(form.prefix ? { prefix: form.prefix } : {}),
          credentials: {
            accessKeyId: form.accessKeyId,
            secretAccessKey: form.secretAccessKey,
          },
          isDefault: form.isDefault,
        },
      })
      setForm({ ...form, name: '', accessKeyId: '', secretAccessKey: '' })
      setNotice(
        'Backup target saved. Run its connection test before relying on it.',
      )
      result.refetch()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function testTarget(target: Target) {
    setBusy(true)
    setError(null)
    setNotice('')
    try {
      await api(`${path}/${target.id}/test`, { method: 'POST' })
      setNotice(`Connection test passed for ${target.name}.`)
      result.refetch()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function removeTarget() {
    if (!removing) return
    setBusy(true)
    setError(null)
    try {
      await api(`${path}/${removing.id}`, { method: 'DELETE' })
      setRemoving(null)
      setNotice(
        'Target removed. Any database using it no longer has an off-node target.',
      )
      result.refetch()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={`Backup targets · ${project}`}>
      <div className="space-y-5 p-5">
        <ErrorNote error={error ?? result.error} />
        {notice && (
          <p role="status" className="text-sm text-[var(--color-signal)]">
            {notice}
          </p>
        )}
        {!result.data?.targets.length && (
          <p className="text-sm text-[var(--color-fg-muted)]">
            No off-node backup target is configured for this project.
          </p>
        )}
        {!!result.data?.targets.length && (
          <div className="divide-y divide-[var(--color-line)]">
            {result.data.targets.map((target) => (
              <div
                key={target.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0"
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {target.name}
                    {target.isDefault ? ' · default' : ''}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--color-fg-dim)]">
                    {target.bucket} · {target.endpoint}
                    {target.prefix ? `/${target.prefix}` : ''}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                    {target.lastTestedAt
                      ? `Last tested ${new Date(target.lastTestedAt).toLocaleString()}`
                      : 'Not tested'}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={() => void testTarget(target)}
                    >
                      Test
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => setRemoving(target)}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {canManage && (
          <form
            onSubmit={(event) => void submit(event)}
            className="grid gap-3 border-t border-[var(--color-line)] pt-5 sm:grid-cols-2"
          >
            <Field
              label="Name"
              required
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
            />
            <Field
              label="S3 endpoint"
              required
              type="url"
              placeholder="https://s3.example.com"
              value={form.endpoint}
              onChange={(event) =>
                setForm({ ...form, endpoint: event.target.value })
              }
            />
            <Field
              label="Bucket"
              required
              value={form.bucket}
              onChange={(event) =>
                setForm({ ...form, bucket: event.target.value })
              }
            />
            <Field
              label="Region"
              required
              value={form.region}
              onChange={(event) =>
                setForm({ ...form, region: event.target.value })
              }
            />
            <Field
              label="Prefix"
              value={form.prefix}
              onChange={(event) =>
                setForm({ ...form, prefix: event.target.value })
              }
            />
            <Field
              label="Access key ID"
              required
              autoComplete="off"
              value={form.accessKeyId}
              onChange={(event) =>
                setForm({ ...form, accessKeyId: event.target.value })
              }
            />
            <Field
              label="Secret access key"
              required
              type="password"
              autoComplete="new-password"
              value={form.secretAccessKey}
              onChange={(event) =>
                setForm({ ...form, secretAccessKey: event.target.value })
              }
            />
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-[var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(event) =>
                  setForm({ ...form, isDefault: event.target.checked })
                }
              />
              Use as project default
            </label>
            <div className="flex items-end">
              <Button variant="primary" type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Add target'}
              </Button>
            </div>
          </form>
        )}
      </div>
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.name ?? 'backup target'}?`}
        body="This only removes the target configuration. It does not delete objects in the bucket. Databases referencing it will lose their configured off-node target."
        confirmLabel="Remove target"
        confirmPhrase={removing?.name}
        busy={busy}
        onConfirm={() => void removeTarget()}
        onCancel={() => setRemoving(null)}
      />
    </Panel>
  )
}
