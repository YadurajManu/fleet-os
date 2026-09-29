import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changesCommand } from '../src/commands/services.js'

test('fleet changes previews a local context without uploading or deploying it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-changes-'))
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/fleets/fleet/services') res.end(JSON.stringify({ services: [{ id: 'service', name: 'backend', project: 'test' }] }))
    else if (req.url === '/services/service/source-baseline') res.end(JSON.stringify({ release: null }))
    else { res.statusCode = 404; res.end('{}') }
  })
  await writeFile(join(dir, 'fleet.yaml'), 'services:\n  backend:\n    build: .\n')
  await writeFile(join(dir, 'Dockerfile'), 'FROM scratch\n')
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const saved = { api: process.env.FLEET_API, token: process.env.FLEET_TOKEN, config: process.env.FLEET_CONFIG }
  process.env.FLEET_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.FLEET_TOKEN = 'test-only'
  process.env.FLEET_CONFIG = join(dir, 'missing-config.json')
  try {
    await changesCommand.run(['backend'], { fleet: 'fleet', dir })
    assert.deepEqual(paths, ['GET /fleets/fleet/services', 'GET /services/service/source-baseline'])
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
