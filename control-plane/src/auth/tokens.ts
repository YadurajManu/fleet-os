import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { FastifyInstance } from 'fastify'

export const ACCESS_TTL_SEC = 15 * 60
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60

export type AccessClaims = { sub: string; typ: 'access'; sid: string }
export type RefreshClaims = { sub: string; typ: 'refresh'; jti: string; sid: string }

const refreshKey = (jti: string) => `refresh:${jti}`
const sessionKey = (userId: string, sid: string) => `authsession:${userId}:${sid}`

/** Access and refresh credentials share a revocable session, including after rotation. */
export async function sessionActive(redis: Redis, claims: { sub: string; sid?: string }): Promise<boolean> {
  return !!claims.sid && await redis.exists(sessionKey(claims.sub, claims.sid)) === 1
}

export async function revokeSessions(redis: Redis, userId: string, opts: { deviceHash?: string; exceptSid?: string } = {}) {
  let cursor = '0'
  let removed = 0
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `authsession:${userId}:*`, 'COUNT', 200)
    cursor = next
    if (!keys.length) continue
    const devices = await redis.mget(...keys)
    const revoke = keys.filter((key, i) => key !== sessionKey(userId, opts.exceptSid ?? '') &&
      (opts.deviceHash === undefined || devices[i] === opts.deviceHash))
    if (revoke.length) removed += await redis.del(...revoke)
  } while (cursor !== '0')
  return removed
}

/**
 * Refresh tokens are JWTs whose jti is also recorded in Redis. Signing alone
 * would make them impossible to revoke, so the Redis entry is the source of
 * truth for "is this still valid" — deleting it logs the session out for real.
 */
export async function issueTokens(app: FastifyInstance, redis: Redis, userId: string, opts: { sid?: string; deviceHash?: string } = {}) {
  const jti = randomUUID()
  const sid = opts.sid ?? randomUUID()
  const accessToken = app.jwt.sign({ sub: userId, typ: 'access', sid } satisfies AccessClaims, {
    expiresIn: ACCESS_TTL_SEC,
  })
  const refreshToken = app.jwt.sign(
    { sub: userId, typ: 'refresh', jti, sid } satisfies RefreshClaims,
    { expiresIn: REFRESH_TTL_SEC }
  )
  if (opts.sid) {
    // Check and rotate atomically: a concurrent revocation must never recreate a session.
    const rotated = await redis.eval(
      "if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end redis.call('EXPIRE', KEYS[1], ARGV[2]); redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2]); return 1",
      2, sessionKey(userId, sid), refreshKey(jti), userId, REFRESH_TTL_SEC,
    )
    if (!rotated) throw new Error('Session revoked')
  } else {
    await redis.multi()
      .set(sessionKey(userId, sid), opts.deviceHash ?? '', 'EX', REFRESH_TTL_SEC)
      .set(refreshKey(jti), userId, 'EX', REFRESH_TTL_SEC).exec()
  }
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SEC }
}

/** Single-use: consuming a refresh token immediately invalidates it. */
export async function consumeRefresh(redis: Redis, jti: string): Promise<string | null> {
  const key = refreshKey(jti)
  // getdel is atomic — prevents two concurrent requests from both consuming
  // the same token (race condition that allowed token replay).
  const userId = await redis.getdel(key)
  return userId || null
}

export async function revokeAllRefresh(redis: Redis, userId: string): Promise<number> {
  await revokeSessions(redis, userId)
  // Session counts per user are tiny; a scan is cheaper than a second index.
  let cursor = '0'
  let removed = 0
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'refresh:*', 'COUNT', 200)
    cursor = next
    if (keys.length) {
      const owners = await redis.mget(...keys)
      const mine = keys.filter((_, i) => owners[i] === userId)
      if (mine.length) removed += await redis.del(...mine)
    }
  } while (cursor !== '0')
  return removed
}
