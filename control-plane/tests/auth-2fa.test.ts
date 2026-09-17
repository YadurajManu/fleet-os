import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { computeTotp } from '../src/auth/totp.js'

describe('Two-Factor Authentication & Active Sessions API', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let accessToken: string
  const email = `totp-${Date.now()}@example.test`
  const password = 'a-secure-master-passphrase'

  before(async () => {
    ctx = createContext(loadConfig())
    ctx.email = {
      send: async () => {},
    } as AppContext['email']
    app = await buildServer(ctx)

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    })
    assert.equal(signup.statusCode, 201)
    accessToken = signup.json().accessToken
  })

  after(async () => {
    await app?.close()
    await closeContext(ctx)
  })

  test('/auth/me reports totpEnabled: false initially', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().user.totpEnabled, false)
  })

  let totpSecret: string

  test('POST /auth/totp/setup generates secret and otpauth URI', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/totp/setup',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.ok(body.secret)
    assert.ok(body.uri.startsWith('otpauth://totp/Fleet%20OS%3A'))
    assert.ok(body.uri.includes(`secret=${body.secret}`))
    totpSecret = body.secret
  })

  test('POST /auth/totp/enable rejects invalid 6-digit codes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/totp/enable',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { code: '000000' },
    })
    assert.equal(res.statusCode, 400)
  })

  test('POST /auth/totp/enable confirms with valid TOTP code', async () => {
    const nowStep = Math.floor(Date.now() / 1000 / 30)
    const validCode = computeTotp(totpSecret, nowStep)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/totp/enable',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { code: validCode },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)

    // Now /auth/me should report totpEnabled: true
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(meRes.statusCode, 200)
    assert.equal(meRes.json().user.totpEnabled, true)
  })

  let challengeToken: string

  test('POST /auth/login returns requires2fa and challengeToken when 2FA is active', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.requires2fa, true)
    assert.ok(body.challengeToken)
    assert.equal(body.accessToken, undefined)
    challengeToken = body.challengeToken
  })

  test('POST /auth/totp/challenge rejects incorrect code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/totp/challenge',
      payload: { challengeToken, code: '111111' },
    })
    assert.equal(res.statusCode, 401)
  })

  test('POST /auth/totp/challenge accepts valid code and issues tokens', async () => {
    const nowStep = Math.floor(Date.now() / 1000 / 30)
    const validCode = computeTotp(totpSecret, nowStep)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/totp/challenge',
      payload: { challengeToken, code: validCode },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.ok(body.accessToken)
    assert.ok(body.refreshToken)
    assert.equal(body.user.email, email)

    // Update accessToken with fresh login
    accessToken = body.accessToken
  })

  test('GET /auth/sessions lists active sessions with isCurrent flag', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.ok(Array.isArray(body.sessions))
    assert.ok(body.sessions.length >= 1)
    const current = body.sessions.find((s: { isCurrent: boolean }) => s.isCurrent)
    assert.ok(current, 'Must flag current session')
  })

  test('POST /auth/totp/disable disables 2FA with current code', async () => {
    const nowStep = Math.floor(Date.now() / 1000 / 30)
    const validCode = computeTotp(totpSecret, nowStep)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/totp/disable',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { code: validCode },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)

    // /auth/me should be back to false
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(meRes.statusCode, 200)
    assert.equal(meRes.json().user.totpEnabled, false)
  })
})
