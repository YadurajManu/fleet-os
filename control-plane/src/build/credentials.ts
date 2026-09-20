import { createHmac, timingSafeEqual } from 'node:crypto'
export type BuildGrant = { job: string; attempt: number; node: string; repo: string; exp: number; purpose: 'source' | 'push' }
export function signGrant(grant: BuildGrant, secret: string): string {
 const body = Buffer.from(JSON.stringify(grant)).toString('base64url')
 return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
export function verifyGrant(token: string, secret: string, purpose: BuildGrant['purpose'], now = Date.now()): BuildGrant | null {
 try {
  if (token.length > 2048) return null
  const [body,signature,extra] = token.split('.')
  if (!body || !signature || extra) return null
  const expected = createHmac('sha256', secret).update(body).digest()
  const supplied = Buffer.from(signature,'base64url')
  if (expected.length !== supplied.length || !timingSafeEqual(expected,supplied)) return null
  const g = JSON.parse(Buffer.from(body,'base64url').toString()) as BuildGrant
  if (g.purpose !== purpose || !Number.isSafeInteger(g.exp) || g.exp <= now || !Number.isInteger(g.attempt) || g.attempt < 1 || g.attempt > 3
   || !/^[a-f0-9-]{36}$/.test(g.job) || !/^[a-f0-9-]{36}$/.test(g.node) || !/^fleet-builds\/[a-f0-9-]{36}$/.test(g.repo)) return null
  return g
 } catch { return null }
}
