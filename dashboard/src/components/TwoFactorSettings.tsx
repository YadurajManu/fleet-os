import { useState } from 'react'
import QRCode from 'qrcode'
import { api } from '../lib/api'
import { Button, Copyable, Dot, ErrorNote, Panel } from './ui'

export default function TwoFactorSettings({
  enabled,
  onRefresh,
}: {
  enabled: boolean
  onRefresh: () => void
}) {
  const [setupData, setSetupData] = useState<{ secret: string; uri: string; qrDataUrl: string } | null>(null)
  const [setupCode, setSetupCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  // Disable flow states
  const [disabling, setDisabling] = useState(false)
  const [disableCode, setDisableCode] = useState('')
  const [disableBusy, setDisableBusy] = useState(false)
  const [disableError, setDisableError] = useState<unknown>(null)

  async function startSetup() {
    setBusy(true)
    setError(null)
    try {
      const res = await api<{ secret: string; uri: string }>('/auth/totp/setup', {
        method: 'POST',
      })
      const qrDataUrl = await QRCode.toDataURL(res.uri, {
        margin: 1,
        width: 170,
        color: {
          dark: '#08090b',
          light: '#ffffff',
        },
      })
      setSetupData({ secret: res.secret, uri: res.uri, qrDataUrl })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function confirmEnable(e: React.FormEvent) {
    e.preventDefault()
    if (!setupCode || setupCode.length < 6) return
    setBusy(true)
    setError(null)
    try {
      await api('/auth/totp/enable', {
        method: 'POST',
        body: { code: setupCode.trim() },
      })
      setSetupData(null)
      setSetupCode('')
      onRefresh()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function confirmDisable(e: React.FormEvent) {
    e.preventDefault()
    if (!disableCode) return
    setDisableBusy(true)
    setDisableError(null)
    try {
      await api('/auth/totp/disable', {
        method: 'POST',
        body: { code: disableCode.trim() },
      })
      setDisabling(false)
      setDisableCode('')
      onRefresh()
    } catch (err) {
      setDisableError(err)
    } finally {
      setDisableBusy(false)
    }
  }

  return (
    <Panel
      title="two-factor authentication"
      right={
        <span className="mono-label normal-case tracking-[0.06em]">
          {enabled ? 'rfc 6238 active' : 'optional security layer'}
        </span>
      }
    >
      <div className="space-y-5 p-5">
        {/* Status bar */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-medium tracking-[-0.01em]">
                Authenticator app (TOTP)
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] ${
                  enabled
                    ? 'border-[color-mix(in_oklab,var(--color-signal)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-signal)_10%,transparent)] text-[var(--color-signal)]'
                    : 'border-[var(--color-line-2)] bg-[var(--color-ink-800)] text-[var(--color-fg-dim)]'
                }`}
              >
                <Dot tone={enabled ? 'ok' : 'idle'} size={5} />
                {enabled ? 'active' : 'disabled'}
              </span>
            </div>
            <p className="max-w-xl text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
              {enabled
                ? 'Your account requires a 6-digit code from your authenticator app (Google Authenticator, 1Password, Bitwarden, etc.) whenever you sign in.'
                : 'Protect cluster access against credential reuse. When enabled, signing in requires both your password and a temporary verification code.'}
            </p>
          </div>

          {!enabled && !setupData && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={startSetup}
              className="shrink-0"
            >
              {busy ? 'generating…' : 'Configure 2FA'}
            </Button>
          )}

          {enabled && !disabling && (
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setDisabling(true)
                setDisableError(null)
              }}
              className="shrink-0"
            >
              Disable 2FA
            </Button>
          )}
        </div>

        {error ? <ErrorNote error={error} /> : null}

        {/* Enrollment Wizard */}
        {setupData && !enabled && (
          <div className="rounded-[4px] border border-[var(--color-line-2)] bg-[var(--color-ink-850)] p-5 fade-up">
            <div className="flex items-center justify-between border-b border-[var(--color-line)] pb-3">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-signal)] text-[10px] font-bold text-[#04140c]">
                  1
                </span>
                <span className="font-mono text-[11.5px] font-medium uppercase tracking-[0.06em]">
                  Scan QR code or enter secret
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSetupData(null)
                  setError(null)
                }}
                className="font-mono text-[11px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]"
              >
                Cancel
              </button>
            </div>

            <div className="mt-5 grid gap-6 sm:grid-cols-[auto_1fr]">
              {/* QR Code Container */}
              <div className="flex flex-col items-center justify-center rounded-[4px] border border-[var(--color-line)] bg-white p-3 shadow-inner">
                <img
                  src={setupData.qrDataUrl}
                  alt="TOTP QR Code"
                  className="h-[150px] w-[150px] select-none"
                />
              </div>

              {/* Secret Key & Verification */}
              <div className="flex flex-col justify-between space-y-4">
                <div>
                  <label className="mono-label text-[10px] text-[var(--color-fg-dim)]">
                    MANUAL SECRET KEY
                  </label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Copyable text={setupData.secret} className="font-mono text-[12px] tracking-[0.08em]" />
                  </div>
                  <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
                    If you cannot scan the QR code, type or paste this secret key into your authenticator app.
                  </p>
                </div>

                <form onSubmit={confirmEnable} className="space-y-3 pt-2">
                  <label className="mono-label text-[10px] text-[var(--color-fg-dim)]">
                    ENTER 6-DIGIT CODE TO VERIFY
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      autoFocus
                      required
                      placeholder="000000"
                      value={setupCode}
                      onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className="w-36 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-950)] px-3 py-1.5 font-mono text-[15px] tracking-[0.3em] text-[var(--color-fg)] text-center transition-colors focus:border-[var(--color-signal)] focus:outline-none"
                    />
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={busy || setupCode.length < 6}
                    >
                      {busy ? 'verifying…' : 'Activate 2FA'}
                    </Button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* Disable Confirmation Form */}
        {disabling && enabled && (
          <div className="rounded-[4px] border border-[var(--color-line-2)] bg-[var(--color-ink-850)] p-4 fade-up">
            <p className="text-[13px] font-medium text-[var(--color-down)]">
              Disable Two-Factor Authentication
            </p>
            <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
              Enter your current 6-digit code from your authenticator app to confirm disabling.
            </p>

            {disableError ? (
              <div className="mt-3">
                <ErrorNote error={disableError} />
              </div>
            ) : null}

            <form onSubmit={confirmDisable} className="mt-4 flex flex-wrap items-center gap-3">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoFocus
                required
                placeholder="000000"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="w-36 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-950)] px-3 py-1.5 font-mono text-[14px] tracking-[0.25em] text-[var(--color-fg)] text-center transition-colors focus:border-[var(--color-down)] focus:outline-none"
              />
              <Button
                type="submit"
                variant="danger"
                disabled={disableBusy || disableCode.length < 6}
              >
                {disableBusy ? 'disabling…' : 'Confirm disable'}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setDisabling(false)
                  setDisableCode('')
                  setDisableError(null)
                }}
                className="rounded-[3px] border border-[var(--color-line)] px-3 py-1.5 font-mono text-[11px] text-[var(--color-fg-dim)] hover:border-[var(--color-line-2)] hover:text-[var(--color-fg-muted)]"
              >
                Cancel
              </button>
            </form>
          </div>
        )}
      </div>
    </Panel>
  )
}
