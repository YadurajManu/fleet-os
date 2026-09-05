import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits } from '../src/ai/edits.js'

const DRAFT = `fleet: homelab

services:
  api:
    build: ./api
    placement: flexible
    container_port: 3000
    resources: { ram: 512Mi, cpu: 0.5 }
    # No health check: container state decides whether this
    # is up. Add one once you know a path that returns 2xx.
    node: n1

  web:
    build: ./web
    placement: flexible
    container_port: 80
    resources: { ram: 512Mi, cpu: 0.5 }
`

describe('applying a review as edits', () => {
  test('changes what it names and nothing else', () => {
    const out = applyEdits(DRAFT, [
      { service: 'api', field: 'health', value: '/healthz', why: 'server.js defines it' },
    ])
    assert.equal(out.applied.length, 1)
    // Normalised: `health: /healthz` is what a model writes, and the
    // manifest wants `health: { path: /healthz }`.
    assert.match(out.manifest, /path: \/healthz/)
    assert.match(out.manifest, /build: \.\/web/, 'the service it was not shown is untouched')
  })

  test('keeps the comments init wrote', () => {
    // A generated file's comments are the only explanation it carries, and a
    // round-trip through parse and re-serialise destroys them.
    const out = applyEdits(DRAFT, [
      { service: 'api', field: 'container_port', value: 8000, why: 'EXPOSE 8000' },
    ])
    assert.match(out.manifest, /# No health check/)
  })

  test('refuses the fields a repository cannot decide', () => {
    // Each of these is a real incident: an invented node, a build swapped for
    // a public image.
    const out = applyEdits(DRAFT, [
      { service: 'api', field: 'node', value: 'mongo', why: 'compose has a mongo service' },
      { service: 'web', field: 'build', value: null, why: 'compose uses an image' },
    ])
    assert.equal(out.applied.length, 0)
    assert.equal(out.refused.length, 2)
    assert.match(out.manifest, /node: n1/, 'the manifest is unchanged')
    assert.match(out.manifest, /build: \.\/web/)
  })

  test('refuses a service that does not exist', () => {
    const out = applyEdits(DRAFT, [
      { service: 'ghost', field: 'container_port', value: 99, why: 'invented' },
    ])
    assert.equal(out.applied.length, 0)
    assert.match(out.refused[0]!.reason, /no service named/)
  })

  test('null removes a field', () => {
    // How a health check guessed onto a service that has no such route gets
    // taken back out.
    const out = applyEdits(
      DRAFT.replace('    node: n1', '    health: { path: / }\n    node: n1'),
      [{ service: 'api', field: 'health', value: null, why: 'no route at /' }]
    )
    assert.ok(!/health:/.test(out.manifest.split('web:')[0]!), 'gone from api')
  })
})
describe('renaming a database to what the source calls it', () => {
  const draft = `services:
  vote:
    build: ./vote
    uses: [cache]
  worker:
    build: ./worker
    uses: [cache, db]
databases:
  cache:
    engine: redis
    node: box
  db:
    engine: postgres
    node: box
`

  const rename = { service: 'cache', field: 'name', value: 'redis', why: 'the source connects to redis' }

  test('renames it and every reference to it', async () => {
    // The failure this exists for. `init` named a Redis database "cache"
    // because the compose file did, while the application says
    // Redis(host="redis") — and Fleet resolves a database by the name the
    // manifest gives it, so every request failed while the container ran and
    // reported itself unhealthy.
    //
    // A rename that changed only the key would leave every `uses:` pointing at
    // something that no longer exists: a manifest that parses and cannot work,
    // which is worse than refusing.
    const out = applyEdits(draft, [rename])
    assert.equal(out.applied.length, 1)
    assert.match(out.manifest, /^  redis:/m, 'the database is renamed')
    assert.ok(!/^  cache:/m.test(out.manifest), 'and the old name is gone')
    // Whitespace-tolerant: editing a flow sequence re-serialises it with
    // spaces, which is cosmetic and not worth pinning.
    assert.match(out.manifest, /uses: \[\s*redis\s*\]/, 'vote follows it')
    assert.match(out.manifest, /uses: \[\s*redis,\s*db\s*\]/, 'and so does worker, without disturbing db')
  })

  test('refuses to rename something that already holds data', async () => {
    // The forbidden list is calibrated for a running fleet: a rename there
    // points a service at a new volume, which is nothing for a cache and data
    // loss for a database. So the rule is not "never rename" but "never rename
    // something with data", and the fleet is asked rather than guessed at.
    const out = applyEdits(draft, [rename], new Set(['cache']))
    assert.equal(out.applied.length, 0)
    assert.match(out.refused[0]!.reason, /already holds data/)
    assert.match(out.manifest, /^  cache:/m, 'and the draft is untouched')
  })

  test('a service is renamed the same way', async () => {
    const out = applyEdits(draft, [
      { service: 'vote', field: 'name', value: 'voting', why: 'clearer' },
    ])
    assert.equal(out.applied.length, 1)
    assert.match(out.manifest, /^  voting:/m)
  })

  test('renaming something that is not there is refused, not invented', async () => {
    const out = applyEdits(draft, [
      { service: 'ghost', field: 'name', value: 'phantom', why: 'no' },
    ])
    assert.equal(out.applied.length, 0)
    assert.match(out.refused[0]!.reason, /no service or database named/)
  })
})

