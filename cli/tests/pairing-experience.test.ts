import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pairingCommand, waitForPairing } from '../src/pairing.js'
import { compactWelcome, descriptionRows, pairingHelp } from '../src/presentation.js'
import { spawnSync } from 'node:child_process'
import { parseArgs } from '../src/args.js'

test('target, not generator OS, selects the installer; arguments are quoted', () => {
  const win = pairingCommand('windows', 'https://example.test', "test'token")
  assert.match(win, /Invoke-WebRequest/)
  assert.match(win, /install\/windows.ps1/)
  assert.match(win, /'test''token'/)
  assert.doesNotMatch(win, /ExecutionPolicy|\| sh/)
  for (const target of ['macos', 'linux', 'git-bash'] as const) {
    assert.match(pairingCommand(target, 'https://example.test', 'synthetic'), /\| sh -s --/)
  }
  assert.throws(() => pairingCommand('windows', 'http://example.test', 'synthetic'), /HTTPS/)
  assert.throws(() => pairingCommand('linux', 'file:///tmp/x', 'synthetic'), /invalid/)
})

test('registration alone is not pairing success', async () => {
  let calls = 0
  const state = await waitForPairing(async () => ({ status: ++calls < 3 ? 'registered' : 'connected' }), { timeoutMs: 100, pollMs: 1 })
  assert.equal(calls, 3)
  assert.equal(state.status, 'connected')
})

test('expired receipts terminate and missing heartbeat times out honestly', async () => {
  assert.equal((await waitForPairing(async () => ({ status: 'expired' }), { timeoutMs: 100 })).status, 'expired')
  await assert.rejects(waitForPairing(async () => ({ status: 'registered' }), { timeoutMs: 1, pollMs: 2 }), /Installation was not cancelled/)
})

test('help is compact and description layouts fit 40, 80 and 120 columns', () => {
  assert.ok(compactWelcome().split('\n').length < 25)
  assert.match(pairingHelp(), /different machine/)
  for (const width of [40, 80, 120]) {
    const rendered = descriptionRows([['fleet nodes pair', 'Connect another machine and verify its first heartbeat before declaring success.']], width)
    assert.ok(rendered.split('\n').every(line => line.length <= width), rendered)
  }
})

test('presentation flags before commands remain boolean; piped output has no cursor escapes', () => {
  assert.deepEqual(parseArgs(['--ascii', '--no-animation', 'nodes', 'pair']).positional, ['nodes', 'pair'])
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--ascii', '--no-animation', '--color', 'never'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, FLEET_CONFIG: '/nonexistent/fleet-test-config', FLEET_ANIMATION: '1' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /o-@-o/)
  assert.doesNotMatch(result.stdout + result.stderr, /\x1b\[/)
})
