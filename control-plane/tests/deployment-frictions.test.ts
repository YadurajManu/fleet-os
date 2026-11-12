import 'dotenv/config'
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config.js'
import { createContext, closeContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { parseManifest, ManifestError } from '../src/manifest/parse.js'
import { orgs, users, nodes, services, deployments, orgMembers, auditLog } from '../src/db/schema.js'

test('build objects normalize without breaking old manifests or allowing a Dockerfile escape', () => {
  const service = parseManifest('fleet: test\nservices:\n  worker:\n    build: {context: ., dockerfile: docker/Worker, target: worker, args: {MODE: test}}\n    build_args: {EXISTING: keep}\n').services[0]!
  assert.equal(service.build, '.')
  assert.equal(service.buildDockerfile, 'docker/Worker')
  assert.equal(service.buildTarget, 'worker')
  assert.deepEqual(service.build_args, { EXISTING: 'keep', MODE: 'test' })
  assert.equal(parseManifest('fleet: test\nservices:\n  web: {build: ./web}\n').services[0]!.buildDockerfile, 'Dockerfile')
  for (const dockerfile of ['../Dockerfile', '/etc/passwd', 'C:/Dockerfile']) {
    assert.throws(() => parseManifest(`fleet: test\nservices:\n  web:\n    build: {context: ., dockerfile: ${JSON.stringify(dockerfile)}}\n`), ManifestError)
  }
})
