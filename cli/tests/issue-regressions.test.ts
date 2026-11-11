import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { secretsCommand } from '../src/commands/secrets.js'
import { useCommand } from '../src/commands/config.js'

test('secret import skips empty values without printing credentials or contacting the API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-empty-secrets-'))
  const file = join(dir, '.env')
  const output: string[] = []
  const log = console.log
  console.log = (...args) => { output.push(args.join(' ')) }
  try {
    await writeFile(file, 'EMPTY=\nSPACE="   "\nGOOD=private-test-value\n')
    await secretsCommand.run(['import', file], { all: true, 'dry-run': true })
    assert.match(output.join('\n'), /skipping empty.*EMPTY/)
    assert.match(output.join('\n'), /skipping empty.*SPACE/)
    assert.match(output.join('\n'), /1 key\(s\)/)
    assert.doesNotMatch(output.join('\n'), /private-test-value/)
    output.length = 0
    await writeFile(file, 'EMPTY=\n')
    await secretsCommand.run(['import', file], { all: true })
    assert.match(output.join('\n'), /No non-empty secrets/)
  } finally {
    console.log = log
    await rm(dir, { recursive: true, force: true })
  }
})

test('fleet use without a name lists fleets and keeps the current profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-list-'))
  const profile = join(dir, 'profile.json')
  const source = JSON.stringify({ fleetId: 'one', fleetName: 'first' })
  await writeFile(profile, source)
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/fleets')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ fleets: [{ id: 'one', name: 'first', role: 'owner' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const saved = { FLEET_API: process.env.FLEET_API, FLEET_TOKEN: process.env.FLEET_TOKEN, FLEET_CONFIG: process.env.FLEET_CONFIG }
  process.env.FLEET_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.FLEET_TOKEN = 'test-only'
  process.env.FLEET_CONFIG = profile
  const output: string[] = []
  const log = console.log
  console.log = (...args) => { output.push(args.join(' ')) }
  try {
    await useCommand.run([], { json: true })
    const result = JSON.parse(output.at(-1)!)
    assert.equal(result.activeFleetId, 'one')
    assert.equal(result.fleets[0].name, 'first')
    const { readFile } = await import('node:fs/promises')
    assert.equal(await readFile(profile, 'utf8'), source)
  } finally {
    console.log = log
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
