import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { domainsCommand } from '../src/commands/domains.js'

test('domains can restore the permanent Fleet URL as primary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-domains-'))
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/fleets/fleet/services') res.end(JSON.stringify({ services: [{ id: 'service', name: 'web', project: 'demo' }] }))
    else if (req.url === '/services/service/domains') res.end(JSON.stringify({ managed: 'web.fleet.example', primary: 'custom.example.com', domains: [] }))
    else if (req.url === '/services/service/domains/managed/primary') res.end(JSON.stringify({ primary: 'web.fleet.example' }))
    else { res.statusCode = 404; res.end('{}') }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const saved = { api: process.env.FLEET_API, token: process.env.FLEET_TOKEN, config: process.env.FLEET_CONFIG }
  process.env.FLEET_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.FLEET_TOKEN = 'test-only'
  process.env.FLEET_CONFIG = join(dir, 'missing.json')
  try {
    await domainsCommand.run(['primary', 'web', 'web.fleet.example'], { fleet: 'fleet', json: true })
    assert.deepEqual(paths, [
      'GET /fleets/fleet/services', 'GET /services/service/domains',
      'POST /services/service/domains/managed/primary',
    ])
  } finally {
    for (const [key, value] of Object.entries({ FLEET_API: saved.api, FLEET_TOKEN: saved.token, FLEET_CONFIG: saved.config })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
