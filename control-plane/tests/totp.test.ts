import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeBase32,
  decodeBase32,
  generateTotpSecret,
  generateTotpUri,
  computeTotp,
  verifyTotpCode,
} from '../src/auth/totp.js'

describe('TOTP Engine (RFC 6238)', () => {
  test('base32 encode and decode roundtrip', () => {
    const original = Buffer.from('hello fleet os! 12345')
    const encoded = encodeBase32(original)
    const decoded = decodeBase32(encoded)
    assert.deepEqual(decoded, original)
  })

  test('generateTotpSecret generates valid 32-char Base32 string', () => {
    const secret = generateTotpSecret()
    assert.equal(typeof secret, 'string')
    assert.equal(secret.length, 32)
    assert.match(secret, /^[A-Z2-7]+$/)
    const decoded = decodeBase32(secret)
    assert.equal(decoded.length, 20)
  })

  test('generateTotpUri formats standard otpauth URI', () => {
    const secret = 'JBSWY3DPEHPK3PXP'
    const uri = generateTotpUri('admin@example.com', secret, 'Fleet OS')
    assert.ok(uri.startsWith('otpauth://totp/Fleet%20OS%3Aadmin%40example.com?'))
    assert.ok(uri.includes(`secret=${secret}`))
    assert.ok(uri.includes('issuer=Fleet%20OS'))
    assert.ok(uri.includes('digits=6'))
  })

  test('computeTotp and verifyTotpCode validates current time', () => {
    const secret = generateTotpSecret()
    const nowStep = Math.floor(Date.now() / 1000 / 30)
    const currentCode = computeTotp(secret, nowStep)

    assert.equal(currentCode.length, 6)
    assert.match(currentCode, /^\d{6}$/)
    assert.equal(verifyTotpCode(secret, currentCode), true)
  })

  test('verifyTotpCode allows +- 1 step window', () => {
    const secret = generateTotpSecret()
    const nowStep = Math.floor(Date.now() / 1000 / 30)
    const prevCode = computeTotp(secret, nowStep - 1)
    const nextCode = computeTotp(secret, nowStep + 1)
    const farPastCode = computeTotp(secret, nowStep - 3)

    assert.equal(verifyTotpCode(secret, prevCode), true)
    assert.equal(verifyTotpCode(secret, nextCode), true)
    assert.equal(verifyTotpCode(secret, farPastCode), false)
  })

  test('verifyTotpCode rejects invalid formats and incorrect codes', () => {
    const secret = generateTotpSecret()
    assert.equal(verifyTotpCode(secret, '12345'), false)
    assert.equal(verifyTotpCode(secret, 'abcdef'), false)
    assert.equal(verifyTotpCode(secret, ''), false)
    assert.equal(verifyTotpCode(secret, '000000'), false)
  })
})
