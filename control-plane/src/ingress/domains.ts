import { randomBytes } from 'node:crypto'
import { resolve4, resolve6, resolveTxt } from 'node:dns/promises'
import { connect } from 'node:tls'

const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

export function normalizeDomain(input: string): string {
  const host = input.trim().toLowerCase()
  if (host.length > 253 || !host.includes('.') || host.endsWith('.') ||
      host.split('.').some((part) => !label.test(part)) ||
      !/^[a-z]{2,}$/.test(host.split('.').at(-1)!) ||
      /\.(?:localhost|local|internal|test|invalid)$/.test(host) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    throw new Error('Enter a hostname such as app.example.com, without https://, a port, path, or wildcard')
  }
  return host
}

export function domainKind(host: string, zone: string): 'managed_alias' | 'custom' {
  const suffix = `.${zone.toLowerCase()}`
  if (host.endsWith(suffix)) {
    if (host.slice(0, -suffix.length).includes('.')) {
      throw new Error(`Fleet addresses must be one label below ${zone}`)
    }
    const reserved = /^(fleet|fleetapi|fleetapp|fleetregistry|fleetbuilds|www|api|admin)$/
    if (reserved.test(host.slice(0, -suffix.length))) throw new Error('That Fleet address is reserved')
    return 'managed_alias'
  }
  if (host === zone.toLowerCase()) throw new Error('The Fleet ingress zone is reserved')
  return 'custom'
}

export function newDomainChallenge(): string {
  return `fleet-verification=${randomBytes(24).toString('hex')}`
}

export async function domainDns(host: string, challenge: string | null, target: string) {
  let ownership = false
  let actualTxt: string[] = []
  if (challenge) {
    try { actualTxt = (await resolveTxt(`_fleet-challenge.${host}`)).map((parts) => parts.join('')) } catch { /* DNS not published yet */ }
    ownership = actualTxt.includes(challenge)
  } else ownership = true
  let routing = false
  let actualA: string[] = []
  const actualAAAA = await resolve6(host).catch(() => [] as string[])
  let targetA: string[] = []
  try {
    const [hostA, resolvedTarget] = await Promise.all([resolve4(host), resolve4(target)])
    actualA = hostA
    targetA = resolvedTarget
    routing = hostA.length > 0 && hostA.every((ip) => targetA.includes(ip)) && actualAAAA.length === 0
  } catch { /* DNS not published yet */ }
  return { ownership, routing, actualA, actualAAAA, targetA, actualTxt }
}

/** Verify the public ingress presents a trusted certificate for this exact name. */
export async function domainTls(host: string, targetAddress: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: targetAddress, port: 443, servername: host, rejectUnauthorized: true, timeout: 15000 })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.once('secureConnect', () => done(socket.authorized))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}
