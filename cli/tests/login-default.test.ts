import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('login uses hosted Fleet without a URL and keeps the self-hosted override', () => {
  for (const [flags, expected] of [
    [[], 'https://fleetapi.plastikworld.xyz'],
    [['--api', 'https://self-hosted.example'], 'https://self-hosted.example'],
  ] as const) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', 'auth', 'login', '--terminal', ...flags], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      input: '\n',
      encoding: 'utf8',
      timeout: 3_000,
      env: { ...process.env, FLEET_CONFIG: join(tmpdir(), `fleet-login-${randomUUID()}.json`), FLEET_API: '', NO_COLOR: '1' },
    })
    assert.equal(run.status, 2, run.stderr)
    assert.match(run.stdout, new RegExp(expected.replaceAll('.', '\\.')))
    assert.doesNotMatch(run.stdout, /control plane URL\s*$/m)
  }
})
