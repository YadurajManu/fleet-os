import { test, describe, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { eq } from 'drizzle-orm'
import { loadConfig } from '../src/config.js'
import { createContext, closeContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { users, orgs, orgMembers, services, nodes } from '../src/db/schema.js'
import { issueTokens, revokeSessions, revokeAllRefresh, sessionActive } from '../src/auth/tokens.js'
import { computeTotp, generateTotpSecret } from '../src/auth/totp.js'
import { fetchGitHubProfile } from '../src/auth/github-oauth.js'
import { logChannel } from '../src/api/log-stream.js'
import { once } from 'node:events'

describe('security audit top-five regressions', () => {
  const ctx = createContext(loadConfig())
  let app: Awaited<ReturnType<typeof buildServer>>
  let account: { user: { id: string }; org: { id: string }; fleet: { id: string }; accessToken: string }
  let outsider: typeof account
  let serviceId: string
  let nodeId: string
  let base: string
  const password = 'security-regression-passphrase'
  const email = `audit-${randomUUID()}@example.test`

  before(async () => {
    ctx.email = { send: async () => {} } as typeof ctx.email
    app = await buildServer(ctx)
    account = (await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password } })).json()
    outsider = (await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: `outside-${randomUUID()}@example.test`, password } })).json()
    const [service] = await ctx.db.insert(services).values({ fleetId: account.fleet.id, name: 'api', requestRamMb: 256 }).returning()
    const [node] = await ctx.db.insert(nodes).values({ fleetId: account.fleet.id, name: 'audit-node', arch: 'amd64', cpuCores: 2, ramMb: 2048, diskMb: 10000, agentTokenHash: randomUUID() }).returning()
    serviceId = service!.id
    nodeId = node!.id
    base = await app.listen({ host: '127.0.0.1', port: 0 })
  })

  after(async () => {
    mock.restoreAll()
    await app.close()
    for (const a of [account, outsider]) {
      await revokeAllRefresh(ctx.redis, a.user.id)
      await ctx.db.delete(orgs).where(eq(orgs.id, a.org.id))
      await ctx.db.delete(users).where(eq(users.id, a.user.id))
    }
    await closeContext(ctx)
  })

  test('log streams reject anonymous/cross-org callers and accept authorized cookies', async () => {
    const url = `/services/${serviceId}/logs/stream`
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${outsider.accessToken}` } })).statusCode, 404)
    await ctx.redis.lpush(`build:logs:${serviceId}`, JSON.stringify({ text: 'authorized-seed' }))
    const abort = new AbortController()
    try {
      const res = await fetch(`${base}${url}`, { headers: { cookie: `fleet_access_token=${account.accessToken}` }, signal: abort.signal })
      assert.equal(res.status, 200)
      const reader = res.body!.getReader()
      assert.match(new TextDecoder().decode((await reader.read()).value), /authorized-seed/)
      await ctx.redis.publish(logChannel(account.fleet.id, serviceId), JSON.stringify({ serviceId, text: 'live-line' }))
      assert.match(new TextDecoder().decode((await reader.read()).value), /live-line/)
    } finally {
      abort.abort()
      await ctx.redis.del(`build:logs:${serviceId}`)
    }
  })

  test('terminal upgrade rejects viewer/deployer and accepts admin/owner only', async () => {
    mock.method(ctx.tunnels, 'has', () => true)
    mock.method(ctx.tunnels, 'startTerminal', () => true)
    const headers = { authorization: `Bearer ${account.accessToken}` }
    for (const role of ['viewer', 'deployer', 'admin', 'owner'] as const) {
      await ctx.db.update(orgMembers).set({ role }).where(eq(orgMembers.userId, account.user.id))
      const status = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`${base.replace('http:', 'ws:')}/fleets/${account.fleet.id}/nodes/${nodeId}/terminal?token=${account.accessToken}`)
        ws.on('error', reject)
        ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.resume(); ws.terminate() })
        ws.on('open', () => { resolve(101); ws.close() })
      })
      assert.equal(status, role === 'viewer' || role === 'deployer' ? 403 : 101)
    }
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers })).statusCode, 200)
    mock.restoreAll()
  })

  test('revocation closes already-open log streams and host terminals', { timeout: 8000 }, async () => {
    const tokens = await issueTokens(app, ctx.redis, account.user.id)
    mock.method(ctx.tunnels, 'has', () => true)
    mock.method(ctx.tunnels, 'startTerminal', () => true)
    const abort = new AbortController()
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/fleets/${account.fleet.id}/nodes/${nodeId}/terminal?token=${tokens.accessToken}`)
    try {
      await once(ws, 'open')
      const closed = once(ws, 'close')
      const res = await fetch(`${base}/services/${serviceId}/logs/stream`, { headers: { authorization: `Bearer ${tokens.accessToken}` }, signal: abort.signal })
      const ended = res.body!.getReader().read()
      await revokeSessions(ctx.redis, account.user.id)
      const [end, close] = await Promise.all([ended, closed])
      assert.equal(end.done, true)
      assert.equal(close[0], 1008)
      assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${tokens.accessToken}` } })).statusCode, 401)
      assert.equal((await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: tokens.refreshToken } })).statusCode, 401)
    } finally {
      abort.abort()
      ws.terminate()
      mock.restoreAll()
    }
  })

  test('device revocation rejects both current access and rotated refresh credentials', async () => {
    const login = async (ua: string) => (await app.inject({ method: 'POST', url: '/auth/login', headers: { 'user-agent': ua }, payload: { email, password } })).json()
    const first = await login('Mozilla/5.0 Chrome/100 Windows NT 10.0')
    const other = await login('Mozilla/5.0 Firefox/100 Macintosh')
    const rotated = (await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: first.refreshToken } })).json()
    const headers = { authorization: `Bearer ${other.accessToken}` }
    const list = (await app.inject({ method: 'GET', url: '/auth/sessions', headers })).json().sessions
    const target = list.find((s: { isCurrent: boolean }) => !s.isCurrent)
    assert.ok(target)
    assert.equal((await app.inject({ method: 'DELETE', url: `/auth/sessions/${target.id}`, headers })).statusCode, 200)
    for (const token of [first.accessToken, rotated.accessToken]) {
      assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode, 401)
    }
    assert.equal((await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: rotated.refreshToken } })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers })).statusCode, 200)
  })

  test('revoke-others keeps only the actual caller, including same browser family', async () => {
    const first = await issueTokens(app, ctx.redis, account.user.id, { deviceHash: 'same-browser' })
    const second = await issueTokens(app, ctx.redis, account.user.id, { deviceHash: 'same-browser' })
    assert.equal((await app.inject({ method: 'POST', url: '/auth/sessions/revoke-others', headers: { authorization: `Bearer ${first.accessToken}` } })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${second.accessToken}` } })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${first.accessToken}` } })).statusCode, 200)
    const claims = app.jwt.verify<{ sub: string; sid: string }>(first.accessToken)
    await revokeSessions(ctx.redis, account.user.id)
    assert.equal(await sessionActive(ctx.redis, claims), false)
    await assert.rejects(issueTokens(app, ctx.redis, account.user.id, { sid: claims.sid }), /revoked/)
  })

  test('setup and stale pending enrollment cannot overwrite an enabled TOTP factor', async () => {
    const tokens = await issueTokens(app, ctx.redis, account.user.id)
    const headers = { authorization: `Bearer ${tokens.accessToken}` }
    const original = generateTotpSecret()
    const replacement = generateTotpSecret()
    await ctx.db.update(users).set({ totpSecret: original }).where(eq(users.id, account.user.id))
    assert.equal((await app.inject({ method: 'POST', url: '/auth/totp/setup', headers })).statusCode, 400)
    await ctx.redis.set(`totp:pending:${account.user.id}`, replacement, 'EX', 600)
    assert.equal((await app.inject({ method: 'POST', url: '/auth/totp/enable', headers, payload: { code: computeTotp(replacement, Math.floor(Date.now() / 30000)) } })).statusCode, 400)
    const [user] = await ctx.db.select().from(users).where(eq(users.id, account.user.id))
    assert.equal(user!.totpSecret, original)
    await ctx.db.update(users).set({ totpSecret: null }).where(eq(users.id, account.user.id))
    await ctx.redis.del(`totp:pending:${account.user.id}`)
  })

  test('GitHub linking refuses an unverified password account; verified linking still works', async () => {
    const originalFetch = globalThis.fetch
    ctx.config.GITHUB_APP_CLIENT_ID = 'test-client'
    ctx.config.GITHUB_APP_CLIENT_SECRET = 'test-secret'
    mock.method(globalThis, 'fetch', async (url: string | URL) => {
      if (String(url).endsWith('/access_token')) return Response.json({ access_token: 'test-provider-token' })
      if (String(url).endsWith('/user/emails')) return Response.json([{ email, verified: true, primary: true }])
      return Response.json({ id: `test-${randomUUID()}`, login: 'regression-user', avatar_url: 'https://example.test/avatar' })
    })
    try {
      const callback = async () => {
        const state = randomUUID()
        await ctx.redis.set(`oauth:github:${state}`, JSON.stringify({ returnTo: '/' }), 'EX', 60)
        return app.inject({ method: 'GET', url: `/auth/github/callback?code=test&state=${state}` })
      }
      const blocked = await callback()
      assert.equal(blocked.statusCode, 302)
      assert.match(decodeURIComponent(blocked.headers.location!), /verify the existing account email/)
      const [unlinked] = await ctx.db.select().from(users).where(eq(users.id, account.user.id))
      assert.equal(unlinked!.githubId, null)
      await ctx.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, account.user.id))
      const linked = await callback()
      assert.equal(linked.statusCode, 302)
      assert.ok(new URL(linked.headers.location!).searchParams.get('accessToken'))
      mock.method(globalThis, 'fetch', async (url: string | URL) => String(url).endsWith('/user/emails') ? Response.json([]) : Response.json({ id: 1, login: 'unverified', avatar_url: '', email }))
      await assert.rejects(fetchGitHubProfile('test'), /No verified email/)
    } finally {
      globalThis.fetch = originalFetch
      mock.restoreAll()
    }
  })
})
