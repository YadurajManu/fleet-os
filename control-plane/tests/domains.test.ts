import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDomain, domainKind, newDomainChallenge } from '../src/ingress/domains.js'

test('domains accept only hostnames and reserve Fleet infrastructure', () => {
  assert.equal(normalizeDomain(' APP.Example.com '), 'app.example.com')
  for (const bad of ['https://app.example.com', 'app.example.com/path', 'app.example.com:443', '*.example.com', '127.0.0.1', 'x..example.com']) {
    assert.throws(() => normalizeDomain(bad))
  }
  assert.equal(domainKind('shop.plastikworld.xyz', 'plastikworld.xyz'), 'managed_alias')
  assert.equal(domainKind('shop.example.com', 'plastikworld.xyz'), 'custom')
  assert.throws(() => domainKind('fleetapi.plastikworld.xyz', 'plastikworld.xyz'))
  assert.throws(() => domainKind('fleet.plastikworld.xyz', 'plastikworld.xyz'))
  assert.throws(() => domainKind('a.b.plastikworld.xyz', 'plastikworld.xyz'))
  assert.match(newDomainChallenge(), /^fleet-verification=[a-f0-9]{48}$/)
})
