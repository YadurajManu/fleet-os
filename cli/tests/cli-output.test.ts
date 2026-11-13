import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { statusBadge, loadBar, table, terminalLink, visibleLength, relativeTime } from '../src/render.js'
import { failureKey, translateFailure } from '../src/error-translation.js'
import { renderStatus, statusJson, statusCommand, type StatusSnapshot } from '../src/commands/status.js'

const at = '2026-11-01T00:00:00.000Z'
const fixedNow = Date.parse(at)
const base: StatusSnapshot = {
  fleet: { id: 'f1', name: 'homelab' },
  nodes: [{ id: 'n1', name: 'pi-builder', arch: 'arm64', platform: 'linux/arm64', engineKind: 'docker', status: 'online', reliabilityTier: 'standard', ramMb: 4096, effectiveCpu: 11, effectiveMemBytes: 4096 * 1048576, canBuild: true, live: true, lastHeartbeatAt: at, telemetry: { cpuPct: 21, ramUsedMb: 1200, ageMs: 5000, containers: [{ name: 'db' }, { name: 'cache' }] } }],
  mapNodes: [],
  services: [{ id: 's1', name: 'db', current: { nodeId: 'n1', nodeName: 'pi-builder', status: 'running' }, last: { status: 'running', failureReason: null, startedAt: at, nodeName: 'pi-builder' }, recentFailures: 0 }],
  unplaced: [], events: [], fetchedAt: at,
}

function assertSnapshot(name: string, render: () => string, width = 120) {
  const previousColumns = process.stdout.columns
  const previousNow = Date.now
  try {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: width })
    Date.now = () => fixedNow
    const normalized = render().replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, '')
      .replaceAll('█', '#').replaceAll('░', '.')
      .replace(/[●*](?= )/g, '●').replace(/[✖x](?= )/g, '✖').replace(/[▲!](?= )/g, '▲')
      .replace(/fleet (?:›|>) /g, 'fleet ▸ ').replace(/(^|\n)  > /g, '$1  → ').replace(/[ \t]+$/gm, '')
    const path = new URL(`./snapshots/status-${name}.snap`, import.meta.url)
    assert.equal(normalized, readFileSync(path, 'utf8'), `${name} status output changed; update the CLI snapshots deliberately`)
  } finally {
    Date.now = previousNow
    if (previousColumns === undefined) delete (process.stdout as NodeJS.WriteStream & { columns?: number }).columns
    else Object.defineProperty(process.stdout, 'columns', { configurable: true, value: previousColumns })
  }
}

test('status snapshots show concise healthy, failure, offline, cordoned, and empty views', () => {
  const healthy = renderStatus(base)
  assertSnapshot('healthy', () => renderStatus(base))
  assertSnapshot('narrow-status', () => renderStatus(base), 60)
  assert.match(healthy, /(?:●|\*) healthy/i)
  assert.match(healthy, /1 node online · 1 of 1 services running/)
  assert.match(healthy, /db, cache/)
  assert.doesNotMatch(healthy, /PROBLEMS/)

  const failed: StatusSnapshot = structuredClone(base)
  failed.services.push(...['web', 'wa-gateway'].map((name, i) => ({ id: `f${i}`, name, current: { nodeId: 'n1', nodeName: 'pi-builder', status: 'failed' }, last: { status: 'failed', failureReason: 'build disk monitor: context deadline exceeded', startedAt: at, nodeName: 'pi-builder' }, recentFailures: 2 })))
  const degraded = renderStatus(failed)
  assertSnapshot('degraded', () => renderStatus(failed))
  assert.match(degraded, /(?:▲|!) degraded/i)
  assert.match(degraded, /web, wa-gateway/)
  assert.equal((degraded.match(/build disk monitor timed out/g) ?? []).length, 1)
  assert.match(degraded, /fleet logs web --follow/)

  const offline: StatusSnapshot = structuredClone(base)
  offline.nodes[0]!.live = false
  offline.nodes[0]!.status = 'offline'
  const offlineView = renderStatus(offline)
  assertSnapshot('offline', () => renderStatus(offline))
  assert.match(offlineView, /pi-builder stopped reporting/)
  assert.match(offlineView, /fleet doctor/)

  const cordoned: StatusSnapshot = structuredClone(base)
  cordoned.nodes[0]!.status = 'cordoned'
  cordoned.services[0]!.current!.status = 'pinned_unavailable'
  const cordonedView = renderStatus(cordoned)
  assertSnapshot('cordoned', () => renderStatus(cordoned))
  assert.match(cordonedView, /fleet nodes uncordon pi-builder/)

  const empty = renderStatus({ ...base, nodes: [], services: [], mapNodes: [] })
  assertSnapshot('empty', () => renderStatus({ ...base, nodes: [], services: [], mapNodes: [] }))
  assert.match(empty, /No nodes in this fleet yet/)
})

test('status JSON keeps the established object shape and pretty printed bytes', () => {
  const expected = JSON.stringify({ ...base, health: 'healthy', affectedServices: [] }, null, 2)
  assert.equal(statusJson(base), expected)
})

test('table aligns, truncates and drops trailing low-priority columns at terminal widths', () => {
  const columns = process.stdout.columns
  try {
    for (const width of [60, 80, 120]) {
      Object.defineProperty(process.stdout, 'columns', { configurable: true, value: width })
      const out = table(['name', 'platform', 'role', 'load', 'memory', 'runs', 'status'], [
        ['sayyestoheaven-2', 'linux/arm64', 'builder', '██░░░░░░ 21%', '— / 7.7 GB', 'db, cache', statusBadge('online')],
        ['ip-172-26-11-9', 'linux/amd64', 'builder', '██░░░░░░ 28%', '1.3 / 3.7 GB', 'database, cache', statusBadge('failed')],
      ], { priorities: [0, 2, 6, 4, 3, 5, 0] })
      assert.ok(out.split('\n').every((line) => visibleLength(line) <= width), `table exceeded ${width} columns`)
      assert.match(out, /NAME/)
      assert.match(out, /STATUS/)
      if (width === 60) assertSnapshot('narrow', () => out, width)
    }
  } finally {
    if (columns === undefined) delete (process.stdout as NodeJS.WriteStream & { columns?: number }).columns
    else Object.defineProperty(process.stdout, 'columns', { configurable: true, value: columns })
  }
})

test('load bars clamp values and status badges always include a glyph', () => {
  assert.match(loadBar(140), /100%/)
  assert.match(loadBar(-1), /0%/)
  assert.match(statusBadge('failed'), /✖ failed|x failed/)
  assert.match(statusBadge('not deployed'), /○ not deployed|o not deployed/)
  assert.equal(terminalLink('service.example', 'https://service.example'), 'service.example')
  assert.equal(terminalLink('unsafe', 'https://bad.example\u001b]8;;attack'), 'unsafe')
})

test('relative time and known error translations stay readable', () => {
  assert.equal(relativeTime(null), 'never')
  assert.equal(translateFailure('build disk monitor: context deadline exceeded'), 'build disk monitor timed out')
  assert.equal(failureKey('CONTEXT DEADLINE EXCEEDED'), 'an operation timed out while waiting for a response')
  assert.equal(translateFailure('unrecognized raw failure'), 'unrecognized raw failure')
})

test('no-color suppresses ANSI even when color is forced and non-UTF-8 locales use ASCII glyphs', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    process.argv.push('--color', 'always', '--no-color')
    const { c, glyphs } = await import('./src/render.ts')
    console.log(c.red('failure'))
    console.log([glyphs.online, glyphs.fail, glyphs.warn, glyphs.idle].join(' '))
  `], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: '', LC_CTYPE: '', FLEET_ASCII: '' } })
  assert.equal(output, 'failure\n* x ! o\n')
  assert.doesNotMatch(output, /\x1b\[/)

  const pipedEnv = { ...process.env }
  delete pipedEnv.NO_COLOR
  const piped = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    process.argv.push('--color', 'always')
    const { c } = await import('./src/render.ts')
    console.log(c.red('piped'))
  `], { cwd: process.cwd(), encoding: 'utf8', env: pipedEnv })
  assert.equal(piped, 'piped\n')
  assert.doesNotMatch(piped, /\x1b\[/)

  const noColor = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    process.argv.push('--color', 'always')
    const { c } = await import('./src/render.ts')
    console.log(c.red('plain'))
  `], { cwd: process.cwd(), encoding: 'utf8', env: { ...pipedEnv, NO_COLOR: '1' } })
  assert.equal(noColor, 'plain\n')
})

test('status watch refuses to run when stdout is not a terminal', async () => {
  if (process.stdout.isTTY) return
  await assert.rejects(statusCommand.run([], { watch: true }), /needs an interactive terminal/)
})
