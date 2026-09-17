import { useState, useEffect } from 'react'
import { useAuth } from '../lib/auth'
import { api } from '../lib/api'
import { Button, Field, Logo, Dot, ErrorNote } from '../components/ui'

const FACTS = [
  ['agent footprint', '< 50 MB'],
  ['architectures', 'arm64 · armv7 · amd64'],
  ['reschedule after heartbeat loss', '~4 s'],
  ['ports forwarded', '0'],
] as const

export default function SignIn() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [githubEnabled, setGithubEnabled] = useState(true)

  useEffect(() => {
    api<{ githubOAuth?: boolean }>('/auth/config', { auth: false })
      .then((cfg) => {
        if (cfg && typeof cfg.githubOAuth === 'boolean') {
          setGithubEnabled(cfg.githubOAuth)
        }
      })
      .catch(() => {})
  }, [])

  function continueWithGithub() {
    const apiBase = import.meta.env?.VITE_API ?? '/api'
    window.location.href = `${apiBase}/auth/github`
  }

  const tooShort = mode === 'up' && password.length > 0 && password.length < 12

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await (mode === 'in' ? signIn(email, password) : signUp(email, password))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* form */}
      <div className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-[380px] fade-up">
          <Logo size={26} word />

          <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
            {mode === 'in' ? 'Sign in' : 'Create an account'}
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
            {mode === 'in'
              ? 'Your fleet is where you left it.'
              : 'You get an org and a fleet called homelab. Add your first node straight after.'}
          </p>

          {githubEnabled && (
            <div className="mt-8">
              <Button
                type="button"
                variant="secondary"
                className="w-full flex items-center justify-center gap-2.5 py-2.5 border-[var(--color-line-2)] hover:border-[var(--color-fg-muted)] transition-all duration-200"
                onClick={continueWithGithub}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                </svg>
                <span>Continue with GitHub</span>
              </Button>

              <div className="relative my-6 text-center">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-[var(--color-line)]" />
                </div>
                <span className="relative bg-[var(--color-ink-950)] px-3 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">
                  or with email
                </span>
              </div>
            </div>
          )}

          <form onSubmit={submit} className={`${githubEnabled ? 'mt-0' : 'mt-8'} space-y-5`}>
            <Field
              label="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
            <Field
              label="password"
              type="password"
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'up' ? 'at least 12 characters' : ''}
              hint={
                mode === 'up'
                  ? tooShort
                    ? `${12 - password.length} more character${12 - password.length === 1 ? '' : 's'}`
                    : 'A passphrase beats a short complicated password.'
                  : undefined
              }
            />

            <ErrorNote error={error} />

            <Button type="submit" variant="primary" className="w-full" disabled={busy || tooShort}>
              {busy ? 'working…' : mode === 'in' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
            <button
              onClick={() => {
                setMode(mode === 'in' ? 'up' : 'in')
                setError(null)
              }}
              className="font-mono text-[11.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg-muted)]"
            >
              {mode === 'in' ? 'No account? Create one →' : 'Already have an account? Sign in →'}
            </button>
            {mode === 'in' && (
              <a
                href="/reset"
                className="font-mono text-[11.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg-muted)]"
              >
                Forgot your password?
              </a>
            )}
          </div>

          <p className="mt-10 border-t border-[var(--color-line)] pt-5 font-mono text-[10.5px] leading-relaxed text-[var(--color-fg-dim)]">
            Self-hosting? This dashboard talks to whichever control plane it was
            built against — there is no hosted account required.
          </p>
        </div>
      </div>

      {/* the product, stated plainly rather than decorated */}
      <div className="relative hidden overflow-hidden border-l border-[var(--color-line)] bg-[var(--color-ink-900)] lg:block">
        <div className="pointer-events-none absolute inset-0 grid-bg opacity-70" />
        <div className="relative flex h-full flex-col justify-center px-14">
          <div className="inline-flex w-fit items-center gap-2.5 border border-[var(--color-line)] bg-[var(--color-ink-950)] px-3 py-1.5">
            <Dot size={6} />
            <span className="font-mono text-[10.5px] tracking-[0.1em] text-[var(--color-fg-muted)]">
              CONTROL PLANE
            </span>
          </div>

          <h2 className="mt-7 max-w-[16ch] text-[clamp(2rem,3.2vw,2.9rem)] font-semibold leading-[0.98] tracking-[-0.04em]">
            Your hardware.
            <span className="block text-[var(--color-fg-dim)]">Orchestrated like a platform.</span>
          </h2>

          <dl className="mt-12 grid max-w-[440px] grid-cols-2 gap-x-8 gap-y-6">
            {FACTS.map(([label, value]) => (
              <div key={label}>
                <dt className="mono-label normal-case tracking-[0.08em]">{label}</dt>
                <dd className="mt-1.5 font-mono text-[15px] tracking-[-0.01em]">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  )
}
