import type { Config } from '../config.js'

export type GitHubOAuthCredentials = {
  clientId: string
  clientSecret: string
}

export type GitHubProfile = {
  id: string
  login: string
  name: string | null
  avatarUrl: string
  email: string
}

export class GitHubOAuthError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message)
  }
}

export function getGitHubOAuthCredentials(config: Config): GitHubOAuthCredentials | null {
  const clientId = config.GITHUB_APP_CLIENT_ID || process.env.GITHUB_CLIENT_ID
  const clientSecret = config.GITHUB_APP_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return null
  }
  return { clientId, clientSecret }
}

export function buildAuthorizeUrl(opts: {
  clientId: string
  state: string
  redirectUri?: string
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    state: opts.state,
    scope: 'read:user user:email',
  })
  if (opts.redirectUri) {
    params.set('redirect_uri', opts.redirectUri)
  }
  return `https://github.com/login/oauth/authorize?${params.toString()}`
}

export async function exchangeCodeForAccessToken(opts: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri?: string
}): Promise<string> {
  const body: Record<string, string> = {
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
  }
  if (opts.redirectUri) {
    body.redirect_uri = opts.redirectUri
  }

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Fleet-OS',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new GitHubOAuthError(
      `GitHub OAuth token exchange failed with status ${res.status}`,
      'github_exchange_failed',
      res.status
    )
  }

  const data = (await res.json()) as {
    access_token?: string
    error?: string
    error_description?: string
  }

  if (data.error || !data.access_token) {
    throw new GitHubOAuthError(
      data.error_description || data.error || 'Failed to obtain access token from GitHub',
      'github_oauth_error'
    )
  }

  return data.access_token
}

export async function fetchGitHubProfile(accessToken: string): Promise<GitHubProfile> {
  const [userRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Fleet-OS',
      },
    }),
    fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Fleet-OS',
      },
    }),
  ])

  if (!userRes.ok) {
    throw new GitHubOAuthError('Failed to fetch user profile from GitHub', 'github_profile_failed')
  }

  const userData = (await userRes.json()) as {
    id: number | string
    login: string
    name?: string | null
    avatar_url: string
    email?: string | null
  }

  let verifiedEmail: string | null = null

  if (emailsRes.ok) {
    const emails = (await emailsRes.json()) as Array<{
      email: string
      primary: boolean
      verified: boolean
    }>
    if (Array.isArray(emails)) {
      const primaryVerified = emails.find((e) => e.primary && e.verified)
      const anyVerified = emails.find((e) => e.verified)
      verifiedEmail = primaryVerified?.email ?? anyVerified?.email ?? null
    }
  }

  const finalEmail = (verifiedEmail || userData.email || '').toLowerCase().trim()
  if (!finalEmail) {
    throw new GitHubOAuthError(
      'No verified email address found on your GitHub account. Please verify your email on GitHub and try again.',
      'no_verified_email'
    )
  }

  return {
    id: String(userData.id),
    login: userData.login,
    name: userData.name ?? null,
    avatarUrl: userData.avatar_url,
    email: finalEmail,
  }
}
