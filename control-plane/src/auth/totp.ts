import { createHmac, randomBytes } from 'node:crypto'

/**
 * Standard RFC 4648 Base32 alphabet for TOTP (Google Authenticator, 1Password, Authy).
 */
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function encodeBase32(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i]!
    bits += 8

    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31]
  }

  return output
}

export function decodeBase32(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []

  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_CHARS.indexOf(cleaned[i]!)
    if (idx === -1) continue

    value = (value << 5) | idx
    bits += 5

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }

  return Buffer.from(bytes)
}

/**
 * Generate a cryptographically secure 20-byte Base32 secret for TOTP.
 * 20 bytes = 160 bits (RFC 4226 recommended length), produces a 32-character string.
 */
export function generateTotpSecret(): string {
  const bytes = randomBytes(20)
  return encodeBase32(bytes)
}

/**
 * Build the otpauth:// URI for authenticator apps.
 */
export function generateTotpUri(email: string, secret: string, issuer = 'Fleet OS'): string {
  const label = encodeURIComponent(`${issuer}:${email}`)
  const encIssuer = encodeURIComponent(issuer)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`
}

/**
 * Compute the 6-digit TOTP code for a secret at a given counter (time step).
 */
export function computeTotp(secret: string, counter: number): string {
  const key = decodeBase32(secret)
  const buffer = Buffer.alloc(8)
  buffer.writeBigInt64BE(BigInt(counter))

  const hmac = createHmac('sha1', key)
  hmac.update(buffer)
  const digest = hmac.digest()

  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)

  const otp = binary % 1_000_000
  return otp.toString().padStart(6, '0')
}

/**
 * Verify a 6-digit TOTP code against a secret.
 * Allows a +/- window (default 1 step = 30 seconds before/after, 90 seconds total)
 * to accommodate device clock drift.
 */
export function verifyTotpCode(secret: string, code: string, window = 1): boolean {
  if (!code || typeof code !== 'string') return false
  const cleanCode = code.replace(/\s+/g, '').trim()
  if (!/^\d{6}$/.test(cleanCode)) return false

  const stepSeconds = 30
  const currentStep = Math.floor(Date.now() / 1000 / stepSeconds)

  for (let i = -window; i <= window; i++) {
    const expected = computeTotp(secret, currentStep + i)
    if (expected === cleanCode) {
      return true
    }
  }

  return false
}
