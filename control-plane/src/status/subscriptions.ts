import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import type { AppContext } from '../api/context.js'
import { publicIncidents } from './public.js'

export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number)
    return a !== 0 && a !== 10 && a !== 127 && a !== 169 && a !== 192 && !(a === 172 && b! >= 16 && b! <= 31) && !(a === 100 && b! >= 64 && b! <= 127) && a! < 224
  }
  // Reject mapped IPv4, local, multicast and reserved IPv6; allow global unicast only.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !address.startsWith('2001:db8:')
}
export async function webhook(target: string, body: unknown) {
  const url = new URL(target)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw Error('Public HTTPS target required')
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw Error('Private webhook targets are forbidden')
  const address = addresses[0]!
  const payload = JSON.stringify(body)
  return await new Promise<string>((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, lookup: (_host, _opts, cb) => cb(null, address.address, address.family), timeout: 5000 }, res => {
      let result = ''; res.on('data', chunk => { result += String(chunk); if (result.length > 4096) req.destroy(Error('Webhook response too large')) }); res.on('end', () => res.statusCode && res.statusCode >= 200 && res.statusCode < 300 ? resolve(result) : reject(Error('Webhook delivery rejected')))
    }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('Webhook timed out'))); req.end(payload)
  })
}
export async function notifySubscribers(ctx: AppContext) {
  const incidents = await publicIncidents(ctx, 100)
  const subscribers = await ctx.sql`select id,channel,target,component_ids from status_subscribers where verified_at is not null limit 1000`
  for (const subscriber of subscribers) for (const incident of incidents) {
    if (subscriber.component_ids.length && !incident.components.some((c: string) => subscriber.component_ids.includes(c))) continue
    const key = `status:delivery:${subscriber.id}:${incident.id}:${incident.status}`
    if (!await ctx.redis.set(key, 'pending', 'EX', 30, 'NX')) continue
    try {
      if (subscriber.channel === 'webhook') await webhook(subscriber.target, { event: 'incident', incident })
      else if (ctx.config.RESEND_API_KEY && ctx.config.MAIL_FROM) await ctx.email.send(subscriber.target, `Fleet status: ${incident.status}`, `${incident.title}\n${incident.status}`)
      else { await ctx.redis.del(key); continue }
      await ctx.redis.set(key, 'sent', 'EX', 90 * 86400)
    } catch { await ctx.redis.del(key) }
  }
}
