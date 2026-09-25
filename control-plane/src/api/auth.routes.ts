import { randomBytes } from 'node:crypto'
import { and, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { users, orgs, orgMembers, fleets, authSessions } from '../db/schema.js'
import { hashPassword, verifyPassword } from '../auth/passwords.js'
import { issueTokens, consumeRefresh, revokeAllRefresh, REFRESH_TTL_SEC } from '../auth/tokens.js'
import {
  issueEmailToken,
  consumeEmailToken,
  withinSendLimit,
  refundSendLimit,
  TTL_MS,
} from '../auth/email-tokens.js'
import {
  passwordResetEmail,
  verifyEmail,
  passwordChangedEmail,
  newSignInEmail,
  signedOutEmail,
  deletionConfirmEmail,
  deletionScheduledEmail,
  deletionCancelledEmail,
} from '../email/templates.js'
import { recordSignIn, loginContextFrom, describeDevice, listDevices, parseDevice, deviceHash } from '../auth/sessions.js'
import {
  deletionImpact,
  requestDeletion,
  scheduleDeletion,
  cancelDeletion,
  GRACE_DAYS,
} from '../auth/account-deletion.js'
import { recordAudit } from '../lib/audit.js'
import {
  getGitHubOAuthCredentials,
  buildAuthorizeUrl,
  exchangeCodeForAccessToken,
  fetchGitHubProfile,
} from '../auth/github-oauth.js'
import { generateTotpSecret, generateTotpUri, verifyTotpCode } from '../auth/totp.js'
import { publicOrigin } from './install.routes.js'
import { ApiError } from './errors.js'
import { requireUser } from './guards.js'

const credentials = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
  password: z.string().min(12, 'Password must be at least 12 characters').max(1024),
})

function setTokenCookies(reply: { setCookie: (name: string, value: string, opts: Record<string, unknown>) => void }, tokens: { accessToken: string; refreshToken: string }) {
  const isProd = process.env.NODE_ENV === 'production'
  reply.setCookie('fleet_access_token', tokens.accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/',
    maxAge: 15 * 60, // 15 minutes
  })
  reply.setCookie('fleet_refresh_token', tokens.refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/',
    maxAge: REFRESH_TTL_SEC, // aligned with JWT/Redis TTL
  })
}

function clearTokenCookies(reply: { setCookie: (name: string, value: string, opts: Record<string, unknown>) => void }) {
  reply.setCookie('fleet_access_token', '', { httpOnly: true, path: '/', maxAge: 0 })
  reply.setCookie('fleet_refresh_token', '', { httpOnly: true, path: '/', maxAge: 0 })
}

export async function authRoutes(app: FastifyInstance) {
  const { db, redis } = app.ctx

  /**
   * Signup provisions the whole starting shape in one transaction: a user, an
   * org they own, and a default fleet. A user with no fleet has nothing to do,
   * and creating it lazily just moves the failure somewhere less obvious.
   */
  app.post('/auth/signup', async (req, reply) => {
    const parsed = credentials.safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('invalid_credentials', 'Check the submitted fields', parsed.error.issues)
    }
    const { email, password } = parsed.data

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
    if (existing.length) throw ApiError.conflict('email_taken', 'An account with that email already exists')

    const passwordHash = await hashPassword(password)

    const created = await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email, passwordHash }).returning()
      const orgName = email.split('@')[0] ?? 'personal'
      const [org] = await tx.insert(orgs).values({ name: `${orgName}'s org` }).returning()
      await tx.insert(orgMembers).values({ orgId: org!.id, userId: user!.id, role: 'owner' })
      const [fleet] = await tx.insert(fleets).values({ orgId: org!.id, name: 'homelab' }).returning()

      await recordAudit(tx, {
        orgId: org!.id,
        actorUserId: user!.id,
        action: 'org.created',
        targetType: 'org',
        targetId: org!.id,
        metadata: { via: 'signup' },
      })

      return { user: user!, org: org!, fleet: fleet! }
    })

    // Signup returns a working session either way: the address is confirmed
    // so the account can be recovered later, not to gate access on a mail
    // provider being reachable in this exact second.
    await sendVerification(created.user.id, created.user.email)

    const tokens = await issueTokens(app, redis, created.user.id)
    setTokenCookies(reply, tokens)
    return reply.code(201).send({
      ...tokens,
      user: { id: created.user.id, email: created.user.email },
      org: { id: created.org.id, name: created.org.name },
      fleet: { id: created.fleet.id, name: created.fleet.name },
    })
  })

  app.post('/auth/login', async (req, reply) => {
    const parsed = credentials.safeParse(req.body)
    // Deliberately vague: a validation error here must not reveal whether the
    // email exists or only the password was wrong.
    if (!parsed.success) throw ApiError.unauthorized('Invalid email or password')

    // Brute-force protection: lock the account after 10 failed attempts
    // within 15 minutes. Keyed by email so a single IP cannot rotate
    // through addresses to guess one.
    const loginKey = `login_fail:${parsed.data.email}`
    const failures = parseInt((await redis.get(loginKey)) ?? '0', 10)
    if (failures >= 10) {
      req.log.warn({ email: parsed.data.email }, 'login blocked: too many failures')
      throw ApiError.tooManyRequests('rate_limited', 'Too many failed attempts. Try again in 15 minutes.')
    }

    const rows = await db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash, totpSecret: users.totpSecret, emailEveryLogin: users.emailEveryLogin })
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1)

    const user = rows[0]
    // Hash even when the user is absent so a missing account is not detectable
    // by response time.
    const ok = user && user.passwordHash
      ? await verifyPassword(user.passwordHash, parsed.data.password)
      : await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', parsed.data.password)

    if (!user || !ok) {
      // Track failed attempts. Key expires in 15 minutes so a burst of
      // failures does not permanently lock the account.
      await redis.multi().incr(loginKey).expire(loginKey, 900).exec()
      throw ApiError.unauthorized('Invalid email or password')
    }

    // Clear failure counter on successful login.
    await redis.del(loginKey)

    // If Two-Factor Authentication is enabled, issue a short-lived challenge token.
    if (user.totpSecret) {
      const challengeToken = randomBytes(32).toString('base64url')
      await redis.set(
        `totp:challenge:${challengeToken}`,
        JSON.stringify({ userId: user.id }),
        'EX',
        300 // 5 minutes
      )
      return { requires2fa: true, challengeToken }
    }

    // Remember the device and tell the owner if this sign-in is unfamiliar.
    // Never let this fail a login: a mail outage must not lock anyone out.
    try {
      const login = loginContextFrom(req.headers as Record<string, unknown>, req.ip)
      const verdict = await recordSignIn(app.ctx, user.id, login)
      req.log.info(
        { userId: user.id, reason: verdict.reason, country: login.country },
        'sign-in recorded'
      )
      if (verdict.isNew || user.emailEveryLogin) {
        const { subject, body } = newSignInEmail({
          device: describeDevice(verdict.device),
          ip: login.ip,
          country: login.country,
          at: new Date(),
          reason: verdict.reason,
          method: 'password',
          dashboardUrl: app.ctx.config.PUBLIC_DASHBOARD_URL || undefined,
        })
        await app.ctx.email.send(user.email, subject, body)
      }
    } catch (err) {
      req.log.warn({ err, userId: user.id }, 'sign-in notification failed')
    }

    const tokens = await issueTokens(app, redis, user.id)
    setTokenCookies(reply, tokens)
    return { ...tokens, user: { id: user.id, email: user.email } }
  })

  app.post('/auth/refresh', async (req, reply) => {
    // Accept refresh token from body (CLI) or cookie (dashboard).
    const refreshToken = (req.body as Record<string, unknown>)?.refreshToken as string | undefined
      ?? req.cookies?.fleet_refresh_token
    if (!refreshToken) throw ApiError.badRequest('missing_refresh_token', 'refreshToken is required')

    let claims: { sub: string; typ: string; jti?: string }
    try {
      claims = app.jwt.verify(refreshToken)
    } catch {
      throw ApiError.unauthorized('Invalid or expired refresh token')
    }
    if (claims.typ !== 'refresh' || !claims.jti) {
      throw ApiError.unauthorized('Not a refresh token')
    }

    // Single use. A replayed token finds nothing in Redis and is rejected.
    const userId = await consumeRefresh(redis, claims.jti)
    if (!userId || userId !== claims.sub) {
      throw ApiError.unauthorized('Refresh token has already been used or revoked')
    }

    const tokens = await issueTokens(app, redis, userId)
    setTokenCookies(reply, tokens)
    return tokens
  })

  app.post('/auth/logout', async (req, reply) => {
    // An expired access cookie must still be able to log out. Consume the
    // refresh token so the browser session cannot silently renew after this.
    const token = req.cookies?.fleet_refresh_token
    if (token) {
      try {
        const claims = app.jwt.verify<{ sub: string; typ: string; jti?: string }>(token)
        if (claims.typ === 'refresh' && claims.jti && await consumeRefresh(redis, claims.jti) === claims.sub) {
          const [owner] = await db.select({ email: users.email, emailOnLogout: users.emailOnLogout })
            .from(users).where(eq(users.id, claims.sub)).limit(1)
          if (owner?.emailOnLogout) {
            const login = loginContextFrom(req.headers as Record<string, unknown>, req.ip)
            const { subject, body } = signedOutEmail({
              device: describeDevice(parseDevice(login.userAgent)), ip: login.ip,
              country: login.country, at: new Date(),
            })
            await app.ctx.email.send(owner.email, subject, body)
          }
        }
      } catch (err) {
        req.log.warn({ err }, 'logout notification skipped')
      }
    }
    clearTokenCookies(reply)
    return { ok: true }
  })

  app.get('/auth/config', async () => {
    const creds = getGitHubOAuthCredentials(app.ctx.config)
    return {
      githubOAuth: creds !== null,
    }
  })

  app.get('/auth/github', async (req, reply) => {
    const creds = getGitHubOAuthCredentials(app.ctx.config)
    if (!creds) {
      throw ApiError.badRequest(
        'github_oauth_not_configured',
        'GitHub OAuth is not configured on this control plane.'
      )
    }

    const state = randomBytes(32).toString('base64url')
    const returnTo = ((req.query as Record<string, string>)?.returnTo || '/').slice(0, 500)

    // Store state in Redis with 10 minute TTL
    await redis.set(`oauth:github:${state}`, JSON.stringify({ returnTo }), 'EX', 600)

    // The redirect_uri MUST point to the API's callback handler, not the
    // dashboard root. Without it, GitHub falls back to the App's default
    // callback URL — which is typically the dashboard origin. The dashboard's
    // nginx serves the SPA for every unknown path, so the OAuth code arrives
    // at the React sign-in page where nothing reads it and login silently
    // fails.
    //
    // The dashboard proxies /api/* to the control plane, so the callback URL
    // goes through that same proxy, keeping everything same-origin.
    const dashboardBase = appUrl() || publicOrigin(req)
    const redirectUri = `${dashboardBase}/api/auth/github/callback`

    const authorizeUrl = buildAuthorizeUrl({
      clientId: creds.clientId,
      state,
      redirectUri,
    })

    return reply.redirect(authorizeUrl)
  })

  app.get('/auth/github/callback', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>
    const code = query.code
    const state = query.state
    const error = query.error
    const errorDescription = query.error_description

    const dashboardBase = appUrl() || publicOrigin(req)

    if (error) {
      req.log.warn({ error, errorDescription }, 'github oauth returned error')
      const msg = encodeURIComponent(errorDescription || error)
      return reply.redirect(`${dashboardBase}/auth/callback?error=${msg}`)
    }

    if (!code || !state) {
      return reply.redirect(`${dashboardBase}/auth/callback?error=${encodeURIComponent('Missing code or state from GitHub')}`)
    }

    // Verify and consume state (single-use CSRF protection)
    const stateKey = `oauth:github:${state}`
    const rawState = await redis.get(stateKey)
    if (!rawState) {
      return reply.redirect(`${dashboardBase}/auth/callback?error=${encodeURIComponent('Expired or invalid OAuth state. Please try signing in again.')}`)
    }
    await redis.del(stateKey)

    let returnTo = '/'
    try {
      const parsedState = JSON.parse(rawState) as { returnTo?: string }
      if (parsedState.returnTo && parsedState.returnTo.startsWith('/')) {
        returnTo = parsedState.returnTo
      }
    } catch {}

    const creds = getGitHubOAuthCredentials(app.ctx.config)
    if (!creds) {
      return reply.redirect(`${dashboardBase}/auth/callback?error=${encodeURIComponent('GitHub OAuth credentials not configured')}`)
    }

    let accessToken: string
    let profile: Awaited<ReturnType<typeof fetchGitHubProfile>>
    try {
      // The redirect_uri must match the one sent during authorization, or
      // GitHub rejects the exchange with redirect_uri_mismatch.
      const redirectUri = `${dashboardBase}/api/auth/github/callback`
      accessToken = await exchangeCodeForAccessToken({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code,
        redirectUri,
      })
      profile = await fetchGitHubProfile(accessToken)
    } catch (err: unknown) {
      req.log.error({ err }, 'github oauth token exchange or profile fetch failed')
      const msg = encodeURIComponent(err instanceof Error ? err.message : 'GitHub OAuth failed')
      return reply.redirect(`${dashboardBase}/auth/callback?error=${msg}`)
    }

    // Find or create user
    const existingByGithub = await db
      .select()
      .from(users)
      .where(eq(users.githubId, profile.id))
      .limit(1)

    let user = existingByGithub[0]

    if (user) {
      // Update github metadata if changed
      if (user.githubUsername !== profile.login || user.avatarUrl !== profile.avatarUrl) {
        await db
          .update(users)
          .set({
            githubUsername: profile.login,
            avatarUrl: profile.avatarUrl,
            emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          })
          .where(eq(users.id, user.id))
      }
    } else {
      // Check if user exists by verified email
      const existingByEmail = await db
        .select()
        .from(users)
        .where(eq(users.email, profile.email))
        .limit(1)

      if (existingByEmail[0]) {
        // Link GitHub to existing account
        user = existingByEmail[0]
        await db
          .update(users)
          .set({
            githubId: profile.id,
            githubUsername: profile.login,
            avatarUrl: profile.avatarUrl,
            emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          })
          .where(eq(users.id, user.id))

        const [member] = await db
          .select({ orgId: orgMembers.orgId })
          .from(orgMembers)
          .where(eq(orgMembers.userId, user.id))
          .limit(1)

        if (member) {
          await recordAudit(db, {
            orgId: member.orgId,
            actorUserId: user.id,
            action: 'user.linked_github',
            targetType: 'user',
            targetId: user.id,
            metadata: { githubLogin: profile.login },
          })
        }
      } else {
        // Create new user, default org, and fleet
        user = await db.transaction(async (tx) => {
          const [newUser] = await tx
            .insert(users)
            .values({
              email: profile.email,
              githubId: profile.id,
              githubUsername: profile.login,
              avatarUrl: profile.avatarUrl,
              emailVerifiedAt: new Date(),
            })
            .returning()

          const orgName = profile.login || profile.email.split('@')[0] || 'personal'
          const [org] = await tx.insert(orgs).values({ name: `${orgName}'s org` }).returning()
          await tx.insert(orgMembers).values({ orgId: org!.id, userId: newUser!.id, role: 'owner' })
          const [fleet] = await tx.insert(fleets).values({ orgId: org!.id, name: 'homelab' }).returning()

          await recordAudit(tx, {
            orgId: org!.id,
            actorUserId: newUser!.id,
            action: 'org.created',
            targetType: 'org',
            targetId: org!.id,
            metadata: { via: 'github_oauth', githubLogin: profile.login },
          })

          return newUser!
        })
      }
    }

    // If the account has 2FA enabled, redirect to 2FA challenge rather than issuing full tokens
    if (user.totpSecret) {
      const challengeToken = randomBytes(32).toString('base64url')
      await redis.set(
        `totp:challenge:${challengeToken}`,
        JSON.stringify({ userId: user.id }),
        'EX',
        300
      )
      const callbackUrl = new URL(`${dashboardBase}/auth/callback`)
      callbackUrl.searchParams.set('requires2fa', 'true')
      callbackUrl.searchParams.set('challengeToken', challengeToken)
      if (returnTo && returnTo !== '/') {
        callbackUrl.searchParams.set('returnTo', returnTo)
      }
      return reply.redirect(callbackUrl.toString())
    }

    // Record sign in device
    try {
      const login = loginContextFrom(req.headers as Record<string, unknown>, req.ip)
      const verdict = await recordSignIn(app.ctx, user.id, login)
      if (verdict.isNew || user.emailEveryLogin) {
        const { subject, body } = newSignInEmail({
          device: describeDevice(verdict.device),
          ip: login.ip,
          country: login.country,
          at: new Date(),
          reason: verdict.reason,
          method: 'GitHub',
          dashboardUrl: app.ctx.config.PUBLIC_DASHBOARD_URL || undefined,
        })
        await app.ctx.email.send(user.email, subject, body)
      }
    } catch (err) {
      req.log.warn({ err, userId: user.id }, 'oauth sign-in recording failed')
    }

    // Issue tokens and set cookies
    const tokens = await issueTokens(app, redis, user.id)
    setTokenCookies(reply, tokens)

    // Redirect to dashboard callback handler
    const callbackUrl = new URL(`${dashboardBase}/auth/callback`)
    callbackUrl.searchParams.set('accessToken', tokens.accessToken)
    callbackUrl.searchParams.set('refreshToken', tokens.refreshToken)
    callbackUrl.searchParams.set('email', user.email)
    if (returnTo && returnTo !== '/') {
      callbackUrl.searchParams.set('returnTo', returnTo)
    }

    return reply.redirect(callbackUrl.toString())
  })

  app.get('/auth/me', { preHandler: requireUser }, async (req) => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
        emailVerifiedAt: users.emailVerifiedAt,
        githubUsername: users.githubUsername,
        avatarUrl: users.avatarUrl,
        totpSecret: users.totpSecret,
        emailEveryLogin: users.emailEveryLogin,
        emailOnLogout: users.emailOnLogout,
      })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1)
    if (!rows[0]) throw ApiError.notFound('User')

    const memberships = await db
      .select({ orgId: orgMembers.orgId, orgName: orgs.name, role: orgMembers.role, plan: orgs.plan })
      .from(orgMembers)
      .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
      .where(eq(orgMembers.userId, req.userId!))

    const { totpSecret, ...userProps } = rows[0]
    return {
      user: {
        ...userProps,
        totpEnabled: Boolean(totpSecret),
      },
      orgs: memberships,
    }
  })

  app.patch('/auth/email-preferences', { preHandler: requireUser }, async (req) => {
    const parsed = z.object({
      emailEveryLogin: z.boolean(),
      emailOnLogout: z.boolean(),
    }).safeParse(req.body)
    if (!parsed.success) throw ApiError.unprocessable('invalid_email_preferences', 'Choose which routine account emails to receive')
    const [updated] = await db.update(users).set(parsed.data)
      .where(eq(users.id, req.userId!))
      .returning({ emailEveryLogin: users.emailEveryLogin, emailOnLogout: users.emailOnLogout })
    if (!updated) throw ApiError.notFound('User')
    return { preferences: updated }
  })

  /* ── 2FA / TOTP ─────────────────────────────────────────────────── */

  const challengeSchema = z.object({
    challengeToken: z.string().min(1),
    code: z.string().min(6).max(8),
  })

  app.post('/auth/totp/challenge', async (req, reply) => {
    const parsed = challengeSchema.safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.badRequest('invalid_challenge_request', 'Invalid challenge request')
    }

    const { challengeToken, code } = parsed.data
    const key = `totp:challenge:${challengeToken}`
    const raw = await redis.get(key)
    if (!raw) {
      throw ApiError.unauthorized('Verification session expired or invalid. Please sign in again.')
    }

    let challenge: { userId: string }
    try {
      challenge = JSON.parse(raw) as { userId: string }
    } catch {
      await redis.del(key)
      throw ApiError.unauthorized('Invalid challenge state')
    }

    const [user] = await db
      .select({ id: users.id, email: users.email, totpSecret: users.totpSecret, emailEveryLogin: users.emailEveryLogin })
      .from(users)
      .where(eq(users.id, challenge.userId))
      .limit(1)

    if (!user || !user.totpSecret) {
      await redis.del(key)
      throw ApiError.unauthorized('User not found or 2FA not enabled')
    }

    // Rate limit attempts per challengeToken
    const attemptKey = `totp:attempts:${challengeToken}`
    const attempts = await redis.incr(attemptKey)
    if (attempts === 1) await redis.expire(attemptKey, 300)
    if (attempts > 5) {
      await redis.del(key)
      await redis.del(attemptKey)
      throw ApiError.unauthorized('Too many failed verification attempts. Please sign in again.')
    }

    const valid = verifyTotpCode(user.totpSecret, code)
    if (!valid) {
      throw ApiError.unauthorized('Invalid 6-digit verification code')
    }

    // Code verified: consume challenge
    await redis.del(key)
    await redis.del(attemptKey)

    // Record sign in device
    try {
      const login = loginContextFrom(req.headers as Record<string, unknown>, req.ip)
      const verdict = await recordSignIn(app.ctx, user.id, login)
      req.log.info({ userId: user.id, reason: verdict.reason, country: login.country }, 'sign-in recorded via 2fa')
      if (verdict.isNew || user.emailEveryLogin) {
        const { subject, body } = newSignInEmail({
          device: describeDevice(verdict.device),
          ip: login.ip,
          country: login.country,
          at: new Date(),
          reason: verdict.reason,
          method: 'two-factor',
          dashboardUrl: app.ctx.config.PUBLIC_DASHBOARD_URL || undefined,
        })
        await app.ctx.email.send(user.email, subject, body)
      }
    } catch (err) {
      req.log.warn({ err, userId: user.id }, 'sign-in notification failed')
    }

    const tokens = await issueTokens(app, redis, user.id)
    setTokenCookies(reply, tokens)
    return { ...tokens, user: { id: user.id, email: user.email } }
  })

  app.post('/auth/totp/setup', { preHandler: requireUser }, async (req) => {
    const [user] = await db
      .select({ id: users.id, email: users.email, totpSecret: users.totpSecret })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1)

    if (!user) throw ApiError.notFound('User')

    const secret = generateTotpSecret()
    const uri = generateTotpUri(user.email, secret, 'Fleet OS')

    // Store pending secret in Redis for 10 minutes
    await redis.set(`totp:pending:${req.userId!}`, secret, 'EX', 600)

    return { secret, uri }
  })

  const enableTotpSchema = z.object({
    code: z.string().min(6).max(8),
  })

  app.post('/auth/totp/enable', { preHandler: requireUser }, async (req) => {
    const parsed = enableTotpSchema.safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.badRequest('invalid_totp_code', 'Please provide a 6-digit verification code')
    }

    const pendingKey = `totp:pending:${req.userId!}`
    const secret = await redis.get(pendingKey)
    if (!secret) {
      throw ApiError.badRequest('totp_setup_expired', '2FA setup expired or was not initiated. Please try again.')
    }

    const valid = verifyTotpCode(secret, parsed.data.code)
    if (!valid) {
      throw ApiError.badRequest('invalid_totp_code', 'Invalid 6-digit verification code. Please check your authenticator app.')
    }

    await db
      .update(users)
      .set({ totpSecret: secret })
      .where(eq(users.id, req.userId!))

    await redis.del(pendingKey)

    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.userId!)).limit(1)
    const membership = await db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, req.userId!))
      .limit(1)

    if (membership[0]) {
      await recordAudit(db, {
        orgId: membership[0].orgId,
        actorUserId: req.userId!,
        action: 'user.totp_enabled',
        targetType: 'user',
        targetId: req.userId!,
        metadata: { email: user?.email },
      })
    }

    return { ok: true }
  })

  const disableTotpSchema = z.object({
    code: z.string().optional(),
    password: z.string().optional(),
  })

  app.post('/auth/totp/disable', { preHandler: requireUser }, async (req) => {
    const parsed = disableTotpSchema.safeParse(req.body)
    if (!parsed.success || (!parsed.data.code && !parsed.data.password)) {
      throw ApiError.badRequest('missing_confirmation', 'Verification code or password required to disable 2FA')
    }

    const [user] = await db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash, totpSecret: users.totpSecret })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1)

    if (!user || !user.totpSecret) {
      throw ApiError.badRequest('totp_not_enabled', 'Two-factor authentication is not enabled')
    }

    let confirmed = false
    if (parsed.data.code) {
      confirmed = verifyTotpCode(user.totpSecret, parsed.data.code)
    } else if (parsed.data.password && user.passwordHash) {
      confirmed = await verifyPassword(user.passwordHash, parsed.data.password)
    }

    if (!confirmed) {
      throw ApiError.badRequest('invalid_confirmation', 'Invalid verification code or password')
    }

    await db
      .update(users)
      .set({ totpSecret: null })
      .where(eq(users.id, req.userId!))

    const membership = await db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, req.userId!))
      .limit(1)

    if (membership[0]) {
      await recordAudit(db, {
        orgId: membership[0].orgId,
        actorUserId: req.userId!,
        action: 'user.totp_disabled',
        targetType: 'user',
        targetId: req.userId!,
        metadata: { email: user.email },
      })
    }

    return { ok: true }
  })

  /* ── Active Sessions ─────────────────────────────────────────────── */

  app.get('/auth/sessions', { preHandler: requireUser }, async (req) => {
    const rows = await listDevices(app.ctx, req.userId!)
    const currentLogin = loginContextFrom(req.headers as Record<string, unknown>, req.ip)
    const currentDevice = parseDevice(currentLogin.userAgent)
    const currentHash = deviceHash(currentDevice)

    const sessions = rows.map((r) => ({
      id: r.id,
      deviceHash: r.deviceHash,
      device: parseDevice(r.userAgent),
      userAgent: r.userAgent,
      ip: r.ip,
      country: r.country,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      loginCount: r.loginCount,
      isCurrent: r.deviceHash === currentHash,
    }))

    return { sessions }
  })

  app.delete('/auth/sessions/:id', { preHandler: requireUser }, async (req) => {
    const { id } = req.params as { id: string }
    const gone = await db
      .delete(authSessions)
      .where(and(eq(authSessions.userId, req.userId!), eq(authSessions.id, id)))
      .returning({ id: authSessions.id })

    if (!gone.length) {
      throw ApiError.notFound('Session')
    }

    const membership = await db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, req.userId!))
      .limit(1)

    if (membership[0]) {
      await recordAudit(db, {
        orgId: membership[0].orgId,
        actorUserId: req.userId!,
        action: 'user.session_revoked',
        targetType: 'session',
        targetId: id,
      })
    }

    return { ok: true }
  })

  app.post('/auth/sessions/revoke-others', { preHandler: requireUser }, async (req) => {
    const currentLogin = loginContextFrom(req.headers as Record<string, unknown>, req.ip)
    const currentDevice = parseDevice(currentLogin.userAgent)
    const currentHash = deviceHash(currentDevice)

    const deleted = await db
      .delete(authSessions)
      .where(and(eq(authSessions.userId, req.userId!), ne(authSessions.deviceHash, currentHash)))
      .returning({ id: authSessions.id })

    const membership = await db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, req.userId!))
      .limit(1)

    if (membership[0]) {
      await recordAudit(db, {
        orgId: membership[0].orgId,
        actorUserId: req.userId!,
        action: 'user.sessions_revoked_all_others',
        targetType: 'session',
        targetId: req.userId!,
        metadata: { revokedCount: deleted.length },
      })
    }

    return { ok: true, revokedCount: deleted.length }
  })

  /* ── password reset and email verification ──────────────────────────
     A forgotten password used to be unrecoverable: no reset path existed,
     so the only fix was editing password_hash in Postgres by hand. */

  const appUrl = () => app.ctx.config.PUBLIC_DASHBOARD_URL?.replace(/\/$/, '') ?? ''

  /**
   * Returns whether the message actually left. Callers decide what a failure
   * means: a signup swallows it, because nobody should be unable to create an
   * account while a mail provider is having a bad day. An explicit "send it
   * again" must not, because telling someone their mail is on the way when it
   * is not sends them to search an inbox that will never receive it — which is
   * exactly what a rejected sending domain looked like from the outside.
   */
  async function sendVerification(userId: string, email: string): Promise<boolean> {
    const token = await issueEmailToken(app.ctx, userId, 'email_verify')
    const { subject, body } = verifyEmail(`${appUrl()}/verify?token=${token}`)
    try {
      await app.ctx.email.send(email, subject, body)
      return true
    } catch (err) {
      app.log.warn({ err, email }, 'verification email failed to send')
      return false
    }
  }

  app.post('/auth/forgot', async (req, reply) => {
    const parsed = z
      .object({ email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()) })
      .safeParse(req.body)

    // Always 204, even for a malformed body. Any variation here turns this
    // endpoint into a way to test which addresses have accounts.
    if (!parsed.success) return reply.code(204).send()
    const { email } = parsed.data

    if (!(await withinSendLimit(app.ctx, 'password_reset', email))) {
      // Silent to the caller for the same reason, but loud in the logs: this
      // is what an inbox-flooding attempt through our domain looks like.
      req.log.warn({ email }, 'password reset rate limit hit')
      return reply.code(204).send()
    }

    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    if (user) {
      const token = await issueEmailToken(app.ctx, user.id, 'password_reset')
      const { subject, body } = passwordResetEmail(
        `${appUrl()}/reset?token=${token}`,
        Math.round(TTL_MS.password_reset / 60_000)
      )
      await app.ctx.email.send(user.email, subject, body).catch((err) => {
        req.log.warn({ err }, 'password reset email failed to send')
      })
    }

    return reply.code(204).send()
  })

  app.post('/auth/reset', async (req) => {
    const parsed = z
      .object({
        token: z.string().min(1).max(512),
        password: z.string().min(12, 'Password must be at least 12 characters').max(1024),
      })
      .safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('invalid_reset', 'Check the submitted fields', parsed.error.issues)
    }

    const result = await consumeEmailToken(app.ctx, parsed.data.token, 'password_reset')
    if (!result.ok) {
      // One message for all three reasons. "Expired" rather than "not found"
      // would confirm the token was once real.
      req.log.info({ reason: result.reason }, 'password reset token rejected')
      throw ApiError.unprocessable(
        'invalid_reset',
        'That reset link is no longer valid. Request a new one.'
      )
    }

    const passwordHash = await hashPassword(parsed.data.password)
    const [updated] = await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, result.userId))
      .returning({ id: users.id, email: users.email })

    // Every refresh token for this user dies with the password. A reset is
    // frequently a response to a compromise, and leaving old sessions alive
    // would leave the attacker signed in. Refresh tokens are keyed by jti, not
    // by user, so this needs the scan helper rather than a del.
    const revoked = await revokeAllRefresh(redis, result.userId)
    req.log.info({ revoked }, 'sessions revoked after password reset')

    if (updated) {
      const { subject, body } = passwordChangedEmail(new Date(), appUrl() || undefined)
      await app.ctx.email.send(updated.email, subject, body).catch((err) => {
        req.log.warn({ err }, 'password changed notice failed to send')
      })
    }

    return { ok: true }
  })

  app.post('/auth/verify', async (req) => {
    const parsed = z.object({ token: z.string().min(1).max(512) }).safeParse(req.body)
    if (!parsed.success) throw ApiError.unprocessable('invalid_token', 'Check the submitted fields')

    const result = await consumeEmailToken(app.ctx, parsed.data.token, 'email_verify')
    if (!result.ok) {
      throw ApiError.unprocessable(
        'invalid_token',
        'That confirmation link is no longer valid. Request a new one.'
      )
    }

    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, result.userId))

    return { ok: true }
  })

  app.post('/auth/resend-verification', { preHandler: requireUser }, async (req, reply) => {
    const [user] = await db
      .select({ id: users.id, email: users.email, verifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1)
    if (!user) throw ApiError.notFound('User')
    if (user.verifiedAt) return { ok: true, alreadyVerified: true }

    if (!(await withinSendLimit(app.ctx, 'email_verify', user.email))) {
      throw ApiError.tooManyRequests('rate_limited', 'Too many requests. Try again later.')
    }

    if (!(await sendVerification(user.id, user.email))) {
      // The attempt cost them nothing, so it must not cost them an allowance.
      await refundSendLimit(app.ctx, 'email_verify', user.email)
      throw ApiError.unavailable(
        'email_send_failed',
        'We could not send the email just now. Try again in a moment — if it keeps failing, the problem is on our side, not yours.'
      )
    }
    return reply.send({ ok: true })
  })

  /* ── closing an account ─────────────────────────────────────────────
     Deliberately slow. Deleting an org cascades to its fleets, and a fleet
     cascades to its nodes, services, deployments, secrets and backups, with
     no undo once it runs. */

  /** What would actually be destroyed. The dashboard shows this before asking. */
  app.get('/account/deletion', { preHandler: requireUser }, async (req) => {
    const [user] = await db
      .select({ scheduledFor: users.deletionScheduledFor })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1)
    return {
      graceDays: GRACE_DAYS,
      scheduledFor: user?.scheduledFor ?? null,
      impact: await deletionImpact(app.ctx, req.userId!),
    }
  })

  /**
   * Ask to close. Requires the password even though the caller is already
   * authenticated: a borrowed laptop with a live session must not be enough to
   * start destroying someone's infrastructure.
   */
  app.post('/account/deletion', { preHandler: requireUser }, async (req, reply) => {
    const parsed = z.object({ password: z.string().min(1).max(1024) }).safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('password_required', 'Confirm your password to continue')
    }

    const [user] = await db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1)
    if (!user) throw ApiError.notFound('User')

    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, parsed.data.password))) {
      throw ApiError.unauthorized('That password is not correct')
    }

    if (!(await withinSendLimit(app.ctx, 'password_reset', `del:${user.email}`))) {
      throw ApiError.tooManyRequests('rate_limited', 'Too many requests. Try again later.')
    }

    const impact = await deletionImpact(app.ctx, user.id)
    await requestDeletion(app.ctx, user.id)

    const token = await issueEmailToken(app.ctx, user.id, 'account_delete')
    const { subject, body } = deletionConfirmEmail(
      `${appUrl()}/account/close?token=${token}`,
      impact,
      GRACE_DAYS
    )
    await app.ctx.email.send(user.email, subject, body).catch((err) => {
      req.log.warn({ err }, 'deletion confirmation email failed to send')
    })

    req.log.warn({ userId: user.id }, 'account deletion requested')
    return reply.send({ ok: true, graceDays: GRACE_DAYS, impact })
  })

  /** Confirm from the emailed link. Starts the countdown; deletes nothing yet. */
  app.post('/account/deletion/confirm', async (req) => {
    const parsed = z.object({ token: z.string().min(1).max(512) }).safeParse(req.body)
    if (!parsed.success) throw ApiError.unprocessable('invalid_token', 'Check the submitted fields')

    const result = await consumeEmailToken(app.ctx, parsed.data.token, 'account_delete')
    if (!result.ok) {
      throw ApiError.unprocessable(
        'invalid_token',
        'That confirmation link is no longer valid. Start again from Settings.'
      )
    }

    const impact = await deletionImpact(app.ctx, result.userId)
    const due = await scheduleDeletion(app.ctx, result.userId)

    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, result.userId))
      .limit(1)
    if (user) {
      const { subject, body } = deletionScheduledEmail(due, impact, appUrl() || undefined)
      await app.ctx.email.send(user.email, subject, body).catch((err) => {
        req.log.warn({ err }, 'deletion scheduled email failed to send')
      })
    }

    req.log.warn({ userId: result.userId, due }, 'account deletion scheduled')
    return { ok: true, scheduledFor: due, graceDays: GRACE_DAYS }
  })

  /** Call it off. Signing in at all is enough - cancelling is never the risky direction. */
  app.delete('/account/deletion', { preHandler: requireUser }, async (req) => {
    const cancelled = await cancelDeletion(app.ctx, req.userId!)
    if (cancelled) {
      const [user] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, req.userId!))
        .limit(1)
      if (user) {
        const { subject, body } = deletionCancelledEmail()
        await app.ctx.email.send(user.email, subject, body).catch((err) => {
          req.log.warn({ err }, 'deletion cancelled email failed to send')
        })
      }
      req.log.info({ userId: req.userId }, 'account deletion cancelled')
    }
    return { ok: true, cancelled }
  })

  /** Start a CLI web login session. Mints a single-use code stored in Redis. */
  app.post('/auth/cli-session', async (req) => {
    const body = z.object({ port: z.number().int().optional() }).parse(req.body ?? {})
    const { randomBytes } = await import('node:crypto')
    const code = `clisec_${randomBytes(16).toString('hex')}`
    const sessionData = JSON.stringify({ code, port: body.port ?? null, status: 'pending' })
    await redis.set(`cli_session:${code}`, sessionData, 'EX', 600)
    return { code, expiresAt: new Date(Date.now() + 600_000).toISOString() }
  })

  /** Called by the web dashboard to approve a CLI session code for the current user. */
  app.post('/auth/cli-session/approve', { preHandler: requireUser }, async (req) => {
    const body = z.object({ code: z.string().min(1) }).parse(req.body)
    const key = `cli_session:${body.code}`
    const raw = await redis.get(key)
    if (!raw) throw ApiError.notFound('CLI login session has expired or is invalid')

    const tokens = await issueTokens(app, redis, req.userId!)
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.userId!)).limit(1)

    const payload = {
      status: 'approved',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: { id: req.userId!, email: user?.email ?? '' },
    }

    // Keep approved tokens in Redis for 5 minutes so CLI polling or callback can fetch them
    await redis.set(key, JSON.stringify(payload), 'EX', 300)
    return payload
  })

  /** Polling fallback endpoint for CLI in remote/SSH/no-callback environments. */
  app.get('/auth/cli-session/:code/poll', async (req) => {
    const { code } = req.params as { code: string }
    const key = `cli_session:${code}`
    const raw = await redis.get(key)
    if (!raw) throw ApiError.notFound('CLI login session expired')

    const session = JSON.parse(raw)
    if (session.status === 'approved') {
      // Consume session so tokens are fetched once
      await redis.del(key)
      return session
    }
    return { status: 'pending' }
  })
}
