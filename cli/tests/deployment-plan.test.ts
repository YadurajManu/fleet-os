import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { planFromDiscovery, renderPlan, toAssistPlan } from '../src/deployment-plan.js'
import type { Discovery } from '../src/discover.js'

const svc = (over: Partial<Discovery['services'][0]> = {}) =>
  ({
    name: 'backend',
    dir: './backend',
    detection: { framework: 'node', label: 'Node.js', port: 3000, healthPath: null },
    env: ['PORT'],
    secrets: [],
    gpu: null,
    ramMb: 512,
    engines: [],
    ...over,
  }) as Discovery['services'][0]

const discovery = (over: Partial<Discovery> = {}): Discovery => ({
  root: '/tmp/x',
  layout: null,
  services: [],
  databases: [],
  notes: [],
  ...over,
})

describe('the plan is a projection of discovery, not a second discovery', () => {
  test('services and databases both become entries', () => {
    const plan = planFromDiscovery(
      discovery({
        services: [svc()],
        databases: [{ name: 'db', engine: 'postgres', because: 'pg' }],
      }),
      { project: 'medlifecycle' }
    )
    assert.deepEqual(plan.entries.map((e) => e.name), ['backend', 'db'])
    assert.equal(plan.entries.find((e) => e.name === 'db')!.kind, 'database')
  })

  test('a service claims only the engines its own dependencies imply', () => {
    // Discovery is already careful that a frontend beside a backend does not
    // claim the database. Projecting must not undo that.
    const plan = planFromDiscovery(
      discovery({
        services: [svc({ name: 'frontend', engines: [] }), svc({ name: 'backend', engines: ['postgres'] })],
        databases: [{ name: 'db', engine: 'postgres', because: 'pg' }],
      }),
      { project: 'p' }
    )
    assert.deepEqual(plan.entries.find((e) => e.name === 'frontend')!.dependsOn, [])
    assert.deepEqual(plan.entries.find((e) => e.name === 'backend')!.dependsOn, ['db'])
  })

  test('databases are pinned and persistent; services are neither', () => {
    const plan = planFromDiscovery(
      discovery({ services: [svc()], databases: [{ name: 'db', engine: 'postgres', because: 'pg' }] }),
      { project: 'p', node: 'desktop-tc4vu9e', nodeWhy: '180GB free, reporting' }
    )
    const db = plan.entries.find((e) => e.kind === 'database')!
    const service = plan.entries.find((e) => e.kind === 'service')!
    assert.equal(db.placement, 'pinned')
    assert.equal(db.persistent, true)
    assert.equal(db.node, 'desktop-tc4vu9e')
    assert.equal(service.placement, 'flexible')
    assert.equal(service.persistent, false)
  })

  test('every RAM figure is labelled a recommendation', () => {
    // None of these are measurements, and a plan that implied otherwise would
    // be inventing precision.
    const plan = planFromDiscovery(discovery({ services: [svc()] }), { project: 'p' })
    assert.ok(plan.entries.every((e) => e.ramFrom === 'recommended'))
  })

  test('total memory is the sum of the entries', () => {
    const plan = planFromDiscovery(
      discovery({
        services: [svc({ ramMb: 512 }), svc({ name: 'web', ramMb: 256 })],
        databases: [{ name: 'db', engine: 'postgres', because: 'pg' }],
      }),
      { project: 'p' }
    )
    assert.equal(plan.totalRamMb, 512 + 256 + 512)
  })
})

describe('secrets reach the plan as names and nothing else', () => {
  test('names are collected, deduplicated and sorted', () => {
    const plan = planFromDiscovery(
      discovery({
        services: [
          svc({ secrets: ['JWT_SECRET', 'DATABASE_URL'] }),
          svc({ name: 'worker', secrets: ['DATABASE_URL', 'REDIS_PASSWORD'] }),
        ],
      }),
      { project: 'p' }
    )
    assert.deepEqual(plan.secrets, ['DATABASE_URL', 'JWT_SECRET', 'REDIS_PASSWORD'])
  })

  test('a rendered plan carries no secret values', () => {
    // The plan never receives values — discovery reports names — and this
    // pins that: a regression that started carrying values would show here.
    const lines = renderPlan(
      planFromDiscovery(discovery({ services: [svc({ secrets: ['JWT_SECRET'] })] }), { project: 'p' })
    ).join('\n')
    assert.match(lines, /JWT_SECRET/)
    assert.doesNotMatch(lines, /=/, 'nothing that looks like an assignment may appear')
  })
})

describe('what the plan refuses to invent', () => {
  test('storage size is reported as unknown when a database is planned', () => {
    const plan = planFromDiscovery(
      discovery({ databases: [{ name: 'db', engine: 'postgres', because: 'pg' }] }),
      { project: 'p' }
    )
    assert.ok(plan.limits.some((l) => /storage size: unknown/.test(l)))
  })

  test('no storage limit is mentioned when nothing is persistent', () => {
    const plan = planFromDiscovery(discovery({ services: [svc()] }), { project: 'p' })
    assert.deepEqual(plan.limits, [])
  })

  test('an unresolved node is stated rather than hidden', () => {
    const lines = renderPlan(
      planFromDiscovery(discovery({ databases: [{ name: 'db', engine: 'postgres', because: 'pg' }] }), {
        project: 'p',
      })
    ).join('\n')
    assert.match(lines, /no node chosen yet/)
  })

  test('the chosen node and its reason are both shown', () => {
    const lines = renderPlan(
      planFromDiscovery(discovery({ databases: [{ name: 'db', engine: 'postgres', because: 'pg' }] }), {
        project: 'p',
        node: 'desktop-tc4vu9e',
        nodeWhy: '180GB free, reporting',
      })
    ).join('\n')
    assert.match(lines, /→ desktop-tc4vu9e/)
    assert.match(lines, /180GB free, reporting/)
  })
})

describe('what crosses the wire to the model', () => {
  const full = () =>
    planFromDiscovery(
      discovery({
        services: [svc({ secrets: ['DATABASE_URL'], engines: ['postgres'] })],
        databases: [{ name: 'db', engine: 'postgres', because: 'pg' }],
      }),
      { project: 'p', node: 'desktop-tc4vu9e', nodeWhy: '180GB free, reporting' }
    )

  test('the facts cross, the explanations do not', () => {
    // ramFrom and nodeWhy exist to explain the plan to a person. Sending them
    // invites the model to argue with a confidence label rather than with the
    // evidence.
    const wire = toAssistPlan(full()) as Record<string, unknown>
    assert.ok(!('limits' in wire))
    const entry = (wire.entries as Array<Record<string, unknown>>)[0]!
    assert.ok(!('ramFrom' in entry))
    assert.ok(!('nodeWhy' in entry))
    assert.equal(entry.name, 'backend')
    assert.equal(entry.ramMb, 512)
  })

  test('the chosen node crosses, so the model is told not to move it', () => {
    const wire = toAssistPlan(full())
    assert.equal(wire.entries.find((e) => e.kind === 'database')!.node, 'desktop-tc4vu9e')
  })

  test('secrets cross as names only', () => {
    const wire = toAssistPlan(full())
    assert.deepEqual(wire.secrets, ['DATABASE_URL'])
    // Nothing in this process ever holds a value, and the whole payload is
    // checked for one rather than just the secrets field.
    assert.doesNotMatch(JSON.stringify(wire), /=/)
  })

  test('dependency edges cross intact', () => {
    const wire = toAssistPlan(full())
    assert.deepEqual(wire.entries.find((e) => e.name === 'backend')!.dependsOn, ['db'])
  })
})
