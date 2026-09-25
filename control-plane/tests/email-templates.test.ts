import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newSignInEmail, signedOutEmail } from '../src/email/templates.js'

test('routine sign-in email explains the opt-in and gives approximate context', () => {
  const { body } = newSignInEmail({
    device: 'Chrome on macOS', ip: '203.0.113.9', country: 'IN',
    at: new Date('2026-09-02T10:30:00Z'), reason: 'known',
  })
  assert.match(body, /you enabled email for every sign-in/)
  assert.match(body, /approximate location/)
  assert.match(body, /203.0.113.9/)
  assert.doesNotMatch(body, /device we have not seen before/)
  assert.doesNotMatch(body, /href=/)
})

test('optional sign-out notice has useful facts and no login link', () => {
  const { body } = signedOutEmail({
    device: 'Safari on iOS', ip: '203.0.113.5', country: 'IN',
    at: new Date('2026-09-02T10:30:00Z'),
  })
  assert.match(body, /Safari on iOS/)
  assert.match(body, /203.0.113.5/)
  assert.match(body, /2026-09-02 10:30:00/)
  assert.doesNotMatch(body, /href=/)
})
