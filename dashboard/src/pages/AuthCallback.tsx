import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { session } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Button, ErrorNote, Logo } from '../components/ui'

export default function AuthCallback() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { refreshMe, refreshFleets } = useAuth()

  const [error, setError] = useState<string | null>(params.get('error'))
  const [processing, setProcessing] = useState(true)

  useEffect(() => {
    if (error) {
      setProcessing(false)
      return
    }

    const accessToken = params.get('accessToken')
    const refreshToken = params.get('refreshToken')
    const email = params.get('email')
    const returnTo = params.get('returnTo') || '/'

    async function handleAuth() {
      try {
        if (accessToken && refreshToken) {
          session.set({
            accessToken,
            refreshToken,
            email: email || undefined,
          })
        }

        // Verify session against backend /auth/me
        const ok = await refreshMe()
        if (ok) {
          await refreshFleets()
          // Use replace to remove OAuth query parameters from browser history
          navigate(returnTo, { replace: true })
        } else {
          setError('Authentication could not be verified. Please try again.')
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to complete authentication')
      } finally {
        setProcessing(false)
      }
    }

    void handleAuth()
  }, [params, error, refreshMe, refreshFleets, navigate])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6 py-16">
        <div className="w-full max-w-[380px] space-y-6 fade-up">
          <Logo size={26} word />
          <div className="mt-8">
            <h1 className="text-[24px] font-semibold tracking-[-0.035em]">Authentication Failed</h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
              We were unable to complete your sign in.
            </p>
          </div>

          <ErrorNote error={error} />

          <Button
            variant="primary"
            className="w-full mt-4"
            onClick={() => navigate('/', { replace: true })}
          >
            Back to Sign In
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center gap-4 fade-up">
        <Logo size={32} />
        <span className="font-mono text-[12px] tracking-[0.08em] text-[var(--color-fg-muted)]">
          AUTHENTICATING WITH GITHUB…
        </span>
      </div>
    </div>
  )
}
