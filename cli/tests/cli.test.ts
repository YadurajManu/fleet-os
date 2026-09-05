import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, KNOWN_FLAGS, nearestFlag } from '../src/args.js'
import { etaLine, progressLine } from '../src/progress.js'
import { alertCheck, healthPathCheck } from '../src/commands/doctor.js'
import { tuneRam, tuneHealth, asQuantity, type Observed } from '../src/tune.js'
import { editManifest } from '../src/manifest-edit.js'
import { sourceFor, localSource } from '../src/source.js'
import { checkEdit } from '../src/source-edit.js'
import { gunzipSync } from 'node:zlib'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { packContext } from '../src/archive.js'
import { table, relativeTime, mb, visibleLength, truncate, c } from '../src/render.js'
import { readFileSync, readdirSync } from 'node:fs'

describe('argument parsing', () => {
  test('separates positionals from flags', () => {
    const { positional, flags } = parseArgs(['deploy', 'web', '--sha', '4f1c9ae'])
    assert.deepEqual(positional, ['deploy', 'web'])
    assert.equal(flags.sha, '4f1c9ae')
  })

  test('a flag with no value is boolean', () => {
    const { flags } = parseArgs(['nodes', '--json'])
    assert.equal(flags.json, true)
  })

  test('a trailing flag does not swallow the next command', () => {
    const { positional, flags } = parseArgs(['nodes', 'rm', 'pi5', '--force'])
    assert.deepEqual(positional, ['nodes', 'rm', 'pi5'])
    assert.equal(flags.force, true)
  })

  test('short and long forms both work', () => {
    assert.equal(parseArgs(['-h']).flags.h, true)
    assert.equal(parseArgs(['--help']).flags.help, true)
  })

  test('a flag value that looks like a path is kept', () => {
    assert.equal(parseArgs(['apply', '--fleet', 'abc-123']).flags.fleet, 'abc-123')
  })
})

describe('rendering', () => {
  test('columns align on visible width, ignoring colour codes', () => {
    // Counting escape bytes toward the width makes every column drift.
    const coloured = c.green('online')
    assert.equal(visibleLength(coloured), 'online'.length)

    const out = table(['a', 'b'], [[coloured, 'x'], ['offline', 'y']])
    const [, first, second] = out.split('\n')
    // Both rows should place column b at the same visible offset.
    assert.equal(
      visibleLength(first!.slice(0, first!.lastIndexOf('x'))),
      visibleLength(second!.slice(0, second!.lastIndexOf('y')))
    )
  })

  test('an empty table renders nothing rather than a lonely header', () => {
    assert.equal(table(['name', 'status'], []), '')
  })

  test('relative time works in both directions', () => {
    const past = new Date(Date.now() - 90_000).toISOString()
    const future = new Date(Date.now() + 600_000).toISOString()
    assert.match(relativeTime(past), /2m ago/)
    // A pairing token expires ahead of now; "-600s from now" is nonsense.
    assert.match(relativeTime(future), /10m from now/)
    assert.equal(relativeTime(null), 'never')
  })

  test('memory is shown in the unit a human would use', () => {
    assert.equal(mb(512), '512MB')
    assert.equal(mb(16384), '16.0GB')
  })

  test('truncation respects terminal cells and keeps ANSI sequences balanced', () => {
    // Write the sequence explicitly: tests intentionally run without a TTY,
    // where the colour helpers correctly return plain text.
    const coloured = '\x1b[38;2;63;224;139mdeploying 🚀 東京\x1b[0m'
    const cut = truncate(coloured, 10)
    assert.ok(visibleLength(cut) <= 10)
    assert.match(cut, /…/)
    assert.match(cut, /\x1b\[0m$/)

    // Combining marks are one visible character, and plain text must not
    // acquire a control sequence just because it was shortened.
    assert.equal(visibleLength('e\u0301'), 1)
    assert.equal(truncate('abcdefgh', 4), 'abc…')
  })
})

describe('apply --dry-run', () => {
  test('is wired to the validate endpoint, not the apply one', () => {
    // It used to be accepted and ignored, so `fleet apply --dry-run` applied.
    // `fleet init` prints that exact command as the safe way to check its
    // output, which made the one command the tool recommends for looking
    // before you leap the command that leapt. This asserts the source, because
    // the failure mode is a flag silently doing nothing — which no output
    // assertion would have caught either.
    const src = readFileSync(new URL('../src/commands/services.ts', import.meta.url), 'utf8')
    const apply = src.slice(src.indexOf('export const applyCommand'))

    const dryRunAt = apply.indexOf("flags['dry-run']")
    const validateAt = apply.indexOf('/services/validate')
    const postAt = apply.indexOf("'POST', `/fleets/${fleetId}/services`")

    assert.ok(dryRunAt > -1, 'apply must read the dry-run flag')
    assert.ok(validateAt > -1, 'and send the manifest to the validate endpoint')
    assert.ok(
      validateAt < postAt,
      'the validate path must return before the applying one is reached'
    )
  })
})

describe('unknown flags', () => {
  test('every flag the CLI reads is in the registry', () => {
    // The registry only helps while it is complete. A flag added to a command
    // and forgotten here would be refused for everyone — worse than the
    // silence it replaced — so this reads the source rather than trusting it.
    const dir = new URL('../src/', import.meta.url)
    const files = readdirSync(dir, { recursive: true }) as string[]
    const used = new Set<string>()

    for (const f of files) {
      if (!String(f).endsWith('.ts')) continue
      const src = readFileSync(new URL(String(f), dir), 'utf8')
      for (const m of src.matchAll(/flags\.([a-zA-Z][a-zA-Z0-9]*)/g)) used.add(m[1]!)
      for (const m of src.matchAll(/flags\['([a-z-]+)'\]/g)) used.add(m[1]!)
    }

    const missing = [...used].filter((f) => !KNOWN_FLAGS.has(f))
    assert.deepEqual(missing, [], `these flags are read but not registered: ${missing.join(', ')}`)
  })

  test('a truncated or extended flag suggests the real one', () => {
    // `fleet init --ai` on a build without --ai was silently ignored, and read
    // as the feature being broken. The same shape of mistake — a flag with
    // something on the end — must point at the real one.
    assert.equal(nearestFlag('ai-typo'), 'ai')
    assert.equal(nearestFlag('node2'), 'node')
  })

  test('a mistyped flag suggests the real one', () => {
    assert.equal(nearestFlag('jsno'), 'json')
    assert.equal(nearestFlag('drt-run'), 'dry-run')
  })

  test('something with no relation suggests nothing', () => {
    // A confident wrong suggestion is worse than none.
    assert.equal(nearestFlag('nonsense'), null)
  })
})

describe('the deploy estimate', () => {
  test('is drawn from real history, and says how much is left', () => {
    const p = {
      deploymentId: 'd1',
      status: 'building',
      since: new Date(Date.now() - 60_000).toISOString(),
      gitSha: null,
      nodeName: null,
      failureReason: null,
      typicalMs: 180_000,
    }
    const line = etaLine(p)!
    assert.match(line, /1m/, 'elapsed')
    assert.match(line, /left/, 'and what remains')
  })

  test('says nothing at all on a first deploy', () => {
    // There is no honest estimate without history, and a bar filled from a
    // number nobody measured is the same lie as "not needed".
    const p = {
      deploymentId: 'd1',
      status: 'building',
      since: new Date().toISOString(),
      gitSha: null,
      nodeName: null,
      failureReason: null,
    }
    assert.equal(etaLine(p), undefined)
  })

  test('an overrun is reported as an overrun, not parked at the end', () => {
    // A deploy that is slower than usual is exactly when somebody needs to
    // know, and a bar stuck at 100% is how progress bars lose their meaning.
    const p = {
      deploymentId: 'd1',
      status: 'building',
      since: new Date(Date.now() - 300_000).toISOString(),
      gitSha: null,
      nodeName: null,
      failureReason: null,
      typicalMs: 120_000,
    }
    assert.match(etaLine(p)!, /over the usual/)
  })

  test('emulation is named on the build line', () => {
    // The answer to "why is this taking so long" for almost every slow build
    // in this system.
    const line = progressLine({
      deploymentId: 'd1',
      status: 'building',
      since: new Date().toISOString(),
      gitSha: null,
      nodeName: null,
      failureReason: null,
      detail: 'RUN npm ci',
      step: 4,
      ofSteps: 9,
      platform: 'linux/arm64',
      emulated: true,
    })!
    assert.match(line, /4\/9/)
    assert.match(line, /arm64/)
    assert.match(line, /emulated/)
  })
})

describe('the alerts check', () => {
  test('a fleet with no rules is warned about, and told what to run', () => {
    // The case that matters, and the one a live check against a working fleet
    // never reaches. This fleet had no rules while its services went down four
    // times in an afternoon.
    const c = alertCheck([])
    assert.equal(c.state, 'warn')
    assert.match(c.detail, /tell nobody/)
    assert.match(c.remedy!, /fleet alerts add/)
  })

  test('rules that exist but are all disabled say so specifically', () => {
    // Set up and switched off is a different mistake from never set up, and
    // the person reading needs to know which one they made.
    const c = alertCheck([{ channelType: 'email', enabled: false }])
    assert.equal(c.state, 'warn')
    assert.match(c.detail, /disabled/)
  })

  test('a working rule passes, naming the channels', () => {
    const c = alertCheck([
      { channelType: 'email', enabled: true },
      { channelType: 'email', enabled: true },
      { channelType: 'slack', enabled: false },
    ])
    assert.equal(c.state, 'ok')
    assert.match(c.detail, /2 rule/)
    assert.match(c.detail, /email/)
    assert.ok(!c.detail.includes('slack'), 'a disabled channel is not protection')
  })
})
describe('the health paths a service actually answers on', () => {
  const svc = (name: string, discoveredHealth: Array<{ path: string; status: number; bytes: number }> | null) => ({
    id: name, name, domain: null, hostname: null, current: null, discoveredHealth,
  })

  test('suggests the path a service answers on but does not declare', () => {
    // `fleet init` writes "Add one once you know a path that returns 2xx" and
    // leaves the reader to find out. The node found out.
    const check = healthPathCheck([
      svc('backend', [
        { path: '/health', status: 404, bytes: 0 },
        { path: '/healthz', status: 200, bytes: 2 },
        { path: '/', status: 404, bytes: 0 },
      ]),
    ])
    assert.equal(check.state, 'warn')
    assert.match(check.detail, /backend → \/healthz/)
    assert.match(check.remedy!, /health: \{ path: \/healthz \}/)
  })

  test('prefers a dedicated endpoint over root when both answer', () => {
    // A check that renders the whole application every ten seconds for the life
    // of the deployment is the worse of two working answers. The node tries
    // them in preference order; this must not re-sort them.
    const check = healthPathCheck([
      svc('web', [
        { path: '/healthz', status: 200, bytes: 2 },
        { path: '/', status: 200, bytes: 41_000 },
      ]),
    ])
    assert.match(check.detail, /web → \/healthz/)
  })

  test('a service where nothing answered is not a warning', () => {
    // Its manifest is already correct — it says container state decides, and
    // that is now a measured fact rather than a default. Telling somebody their
    // correct configuration is a problem is how a health report gets ignored.
    const check = healthPathCheck([
      svc('backend', [
        { path: '/health', status: 404, bytes: 0 },
        { path: '/', status: 404, bytes: 0 },
      ]),
    ])
    assert.equal(check.state, 'ok')
    assert.match(check.detail, /answered nothing/)
  })

  test('says nothing about services that were never swept', () => {
    const check = healthPathCheck([svc('api', null)])
    assert.equal(check.state, 'ok')
    assert.match(check.detail, /declares a health check, or none has been swept/)
  })
})


describe('what a service should reserve, from what it used', () => {
  const HOUR = 3_600_000
  const now = Date.parse('2026-09-05T12:00:00Z')
  const svc = (o: Partial<Observed> = {}): Observed => ({
    name: 'backend',
    requestRamMb: 512,
    observedRamPeakMb: 60,
    observedRamSince: new Date(now - 48 * HOUR).toISOString(),
    ...o,
  })

  test('advises shrinking a reservation the service never approaches', () => {
    // The real numbers from this fleet: 512Mi reserved, ~60MB used.
    const a = tuneRam(svc(), now)
    assert.equal(a.verdict, 'advise')
    if (a.verdict !== 'advise') return
    assert.equal(a.from, 512)
    assert.equal(a.to, 128, 'double the peak, rounded to a number a person would write')
  })

  test('refuses to advise from an observation too short to mean anything', () => {
    // A service watched for four minutes has not been observed, it has been
    // glanced at. Nothing that runs a nightly job has shown its peak yet, and
    // advising from that is how a tuned fleet starts OOM-killing at 3am.
    const a = tuneRam(svc({ observedRamSince: new Date(now - 4 * 60_000).toISOString() }), now)
    assert.equal(a.verdict, 'too-soon')
  })

  test('says nothing at all about a service never measured', () => {
    const a = tuneRam(svc({ observedRamPeakMb: null }), now)
    assert.equal(a.verdict, 'no-data')
  })

  test('never advises shrinking below the peak', () => {
    // The reservation is the container's hard limit. Trimming to the bone is
    // how a tuning tool gets run exactly once.
    for (const peak of [1, 30, 60, 100, 200, 255]) {
      const a = tuneRam(svc({ observedRamPeakMb: peak }), now)
      if (a.verdict !== 'advise') continue
      assert.ok(a.to > peak, `advised ${a.to}MB for a service that peaked at ${peak}MB`)
    }
  })

  test('warns rather than trims when a service is near its limit', () => {
    // Not a saving. A service peaking at four fifths of its reservation is one
    // traffic spike from being killed, and that is the finding.
    const a = tuneRam(svc({ observedRamPeakMb: 450 }), now)
    assert.equal(a.verdict, 'tight')
  })

  test('leaves a reservation that is already about right alone', () => {
    const a = tuneRam(svc({ requestRamMb: 128, observedRamPeakMb: 60 }), now)
    assert.equal(a.verdict, 'fits')
  })

  test('writes megabytes the way a manifest does', () => {
    assert.equal(asQuantity(128), '128Mi')
    assert.equal(asQuantity(1024), '1Gi')
  })
})

describe('the build context that leaves this machine', () => {
  /**
   * Parse tar member names from the raw bytes.
   *
   * Deliberately not `tar tzf`. On macOS that command does not list
   * AppleDouble members at all — bsdtar folds them back into xattrs on the
   * file they belong to — so the check this test exists to make is exactly the
   * one the obvious implementation cannot see. GNU tar on the Linux control
   * plane has no such notion and writes them out as files.
   */
  function memberNames(tgz: Buffer): string[] {
    const tar = gunzipSync(tgz)
    const names: string[] = []
    for (let off = 0; off + 512 <= tar.length; ) {
      const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '')
      if (!name) break
      const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8)
      names.push(name)
      off += 512 + Math.ceil(size / 512) * 512
    }
    return names
  }

  test('carries no AppleDouble files, whatever xattrs the source has', async (t) => {
    if (process.platform !== 'darwin') return t.skip('AppleDouble is a macOS behaviour')

    const dir = await mkdtemp(join(tmpdir(), 'fleet-ctx-'))
    await writeFile(join(dir, 'Dockerfile'), 'FROM scratch\n')
    await writeFile(join(dir, 'Worker.csproj'), '<Project />\n')
    // What a file downloaded or unzipped on a Mac carries automatically.
    execFileSync('xattr', ['-w', 'com.apple.test', '1', join(dir, 'Worker.csproj')])

    const names = memberNames(await packContext(dir)).map((n) => n.split('/').pop() ?? n)

    // `._Worker.csproj` matches Docker's `COPY *.csproj .` — Go's
    // filepath.Match counts a leading dot, unlike a shell — so a second
    // project file appears in the image and `dotnet restore` refuses to guess
    // between them. Five services built fine in the same deploy; the .NET one
    // did not.
    const appleDouble = names.filter((n) => n.startsWith('._'))
    assert.deepEqual(appleDouble, [], `AppleDouble members leaked into the context: ${appleDouble.join(', ')}`)
    assert.ok(names.includes('Worker.csproj'), 'and the real file is still there')

    await rm(dir, { recursive: true, force: true })
  })
})
describe('writing a measured fact back into the manifest', () => {
  const svc = (o: Partial<Observed>): Observed => ({
    name: 'api', requestRamMb: 512, observedRamPeakMb: null, observedRamSince: null, ...o,
  })

  test('a service that answers 2xx but declares no check gets the path', () => {
    // The gap this closes: the node measured exactly this and it reached one
    // line of advice telling a person to type it in themselves.
    const out = tuneHealth(svc({
      healthDisabled: true,
      discoveredHealth: [
        { path: '/health', status: 404, bytes: 0 },
        { path: '/healthz', status: 200, bytes: 2 },
        { path: '/', status: 200, bytes: 41_000 },
      ],
    }))
    assert.equal(out?.path, '/healthz', 'the dedicated endpoint, not the one that renders the app')
  })

  test('a check somebody declared is never overwritten', () => {
    // An operator's decision has a reason this cannot see. Replacing it with a
    // measurement is the tool deciding it knows better.
    assert.equal(tuneHealth(svc({ healthDisabled: false, discoveredHealth: [{ path: '/', status: 200, bytes: 5 }] })), null)
  })

  test('a service where nothing answered is left alone', () => {
    // Its manifest is already correct — container state is the only evidence,
    // and now that is measured rather than assumed.
    assert.equal(tuneHealth(svc({ healthDisabled: true, discoveredHealth: [{ path: '/', status: 404, bytes: 0 }] })), null)
  })

  test('a service never swept proposes nothing', () => {
    assert.equal(tuneHealth(svc({ healthDisabled: true, discoveredHealth: null })), null)
  })
})

describe('the manifest editor', () => {
  const write = async (body: string) => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-edit-'))
    const path = join(dir, 'fleet.yaml')
    await writeFile(path, body)
    return path
  }

  test('keeps the comments fleet init wrote', async () => {
    // They are the only explanation a generated manifest carries, and a round
    // trip through parse and stringify removes every one of them.
    const path = await write(`services:
  api:
    build: ./api
    # No health check: container state decides whether this is up.
    container_port: 3100
`)
    await editManifest(path, [{ service: 'api', field: 'health', value: { path: '/healthz' }, why: 'measured' }])
    const after = await readFile(path, 'utf8')
    assert.match(after, /# No health check/, 'the comment must survive the edit')
    assert.match(after, /healthz/)
  })

  test('finds a database under its own block', async () => {
    // To everything downstream a database is a service, and a reader correcting
    // one should not have to know which block the tool expects.
    const path = await write(`services:
  api: { build: ./api }
databases:
  db: { engine: postgres, node: box }
`)
    const { applied } = await editManifest(path, [
      { service: 'db', field: 'resources', value: { ram: '256Mi' }, why: 'measured' },
    ])
    assert.equal(applied.length, 1)
    assert.match(await readFile(path, 'utf8'), /256Mi/)
  })

  test('refuses a field it may not write, and says so', async () => {
    const path = await write('services:\n  api: { build: ./api }\n')
    const { applied, refused } = await editManifest(path, [
      { service: 'api', field: 'build', value: './other', why: 'no' },
    ])
    assert.equal(applied.length, 0)
    assert.match(refused[0]!.reason, /not a field this may write/)
  })

  test('refuses a service the manifest does not have', async () => {
    const path = await write('services:\n  api: { build: ./api }\n')
    const { refused } = await editManifest(path, [
      { service: 'ghost', field: 'replicas', value: 2, why: 'no' },
    ])
    assert.match(refused[0]!.reason, /no service or database named/)
  })
})
describe('the source an investigation is sent', () => {
  const project = async (files: Record<string, string>) => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-src-'))
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, body)
    }
    return dir
  }

  test('carries the line that explains a connection failure', async () => {
    // The exact blind spot. A service could not reach Redis; the logs said so
    // and nothing said what host it was reaching for.
    const dir = await project({
      'vote/app.py': 'from redis import Redis\ng.redis = Redis(host="redis", db=0)\n',
      'vote/requirements.txt': 'flask\nredis\n',
    })
    const out = await sourceFor(dir, './vote')
    assert.match(out!, /Redis\(host="redis"/, 'the hostname is the whole answer')
    assert.match(out!, /app\.py/, 'and the file it came from is named')
    await rm(dir, { recursive: true, force: true })
  })

  test('never sends dependencies or build output', async () => {
    // A node_modules tree is not evidence and would not fit in the budget the
    // loop was built to live inside.
    const dir = await project({
      'api/index.js': 'listen(3000)\n',
      'api/node_modules/left-pad/index.js': 'module.exports = 1\n',
      'api/dist/bundle.js': 'compiled\n',
    })
    const out = await sourceFor(dir, './api')
    assert.match(out!, /listen\(3000\)/)
    assert.ok(!/left-pad|bundle/.test(out!), 'dependencies and build output are not source')
    await rm(dir, { recursive: true, force: true })
  })

  test('is bounded, whatever the file holds', async () => {
    const dir = await project({ 'big/main.py': 'x = 1\n'.repeat(20_000) })
    const out = await sourceFor(dir, './big')
    assert.ok(out!.length < 5_000, `sent ${out!.length} chars into a tight token budget`)
    assert.match(out!, /truncated/)
    await rm(dir, { recursive: true, force: true })
  })

  test('a service with no build context contributes nothing', async () => {
    const dir = await project({
      'fleet.yaml': 'services:\n  api: { image: nginx:alpine }\n',
    })
    assert.deepEqual(await localSource(dir), {})
    await rm(dir, { recursive: true, force: true })
  })

  test('keys what it collects by service name', async () => {
    const dir = await project({
      'fleet.yaml': 'services:\n  vote: { build: ./vote }\n  worker: { build: ./worker }\n',
      'vote/app.py': 'Redis(host="redis")\n',
      'worker/Program.cs': 'class Program {}\n',
    })
    const found = await localSource(dir)
    assert.deepEqual(Object.keys(found).sort(), ['vote', 'worker'])
    await rm(dir, { recursive: true, force: true })
  })
})
describe('changing a line of somebody else\'s source', () => {
  const repo = async (files: Record<string, string>, opts: { commit?: boolean } = {}) => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-edit-'))
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true })
      await writeFile(join(dir, rel), body)
    }
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t.invalid'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
    if (opts.commit !== false) {
      execFileSync('git', ['add', '-A'], { cwd: dir })
      execFileSync('git', ['commit', '-qm', 'x'], { cwd: dir })
    }
    return dir
  }

  const manifest = 'services:\n  vote: { build: ./vote }\n'
  const app = 'from redis import Redis\ng.redis = Redis(host="redis", db=0)\n'
  const edit = {
    service: 'vote', file: 'app.py',
    find: 'Redis(host="redis", db=0)', replace: 'Redis(host="cache", db=0)',
    why: 'the manifest names it cache',
  }

  test('accepts a line that exists once in the service it belongs to', async () => {
    const dir = await repo({ 'fleet.yaml': manifest, 'vote/app.py': app })
    const out = await checkEdit(dir, edit)
    assert.equal(out.ok, true)
    if (out.ok) assert.equal(out.line, 2, 'and says where it is')
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a path outside the service it is fixing', async () => {
    // A fix for one service must not reach another's code, or anywhere else on
    // the disk. Checked after resolving, so ../ cannot walk out.
    const dir = await repo({ 'fleet.yaml': manifest, 'vote/app.py': app, 'other/secret.py': 'k = 1\n' })
    const out = await checkEdit(dir, { ...edit, file: '../other/secret.py', find: 'k = 1' })
    assert.equal(out.ok, false)
    if (!out.ok) assert.match(out.reason, /outside \.\/vote/)
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a line that is not there', async () => {
    // The exact failure this guards: a model quoted a line of Python that
    // existed nowhere in the file and named a hostname from it.
    const dir = await repo({ 'fleet.yaml': manifest, 'vote/app.py': app })
    const out = await checkEdit(dir, { ...edit, find: "os.getenv('REDIS_HOST', 'cache')" })
    assert.equal(out.ok, false)
    if (!out.ok) assert.match(out.reason, /quoted from memory/)
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a line that appears twice', async () => {
    const dir = await repo({
      'fleet.yaml': manifest,
      'vote/app.py': 'x = 1\nx = 1\n',
    })
    const out = await checkEdit(dir, { ...edit, find: 'x = 1', replace: 'x = 2' })
    assert.equal(out.ok, false)
    if (!out.ok) assert.match(out.reason, /appears 2 times/)
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a file with uncommitted work', async () => {
    // The undo is `git checkout`, so anything it would discard must not be
    // there. Losing somebody's unsaved change to fix a hostname is not a trade
    // worth offering.
    const dir = await repo({ 'fleet.yaml': manifest, 'vote/app.py': app })
    await writeFile(join(dir, 'vote/app.py'), `${app}# working on this\n`)
    const out = await checkEdit(dir, edit)
    assert.equal(out.ok, false)
    if (!out.ok) assert.match(out.reason, /uncommitted changes/)
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a file git does not track', async () => {
    const dir = await repo({ 'fleet.yaml': manifest, 'vote/app.py': app }, { commit: false })
    const out = await checkEdit(dir, edit)
    assert.equal(out.ok, false)
    if (!out.ok) assert.match(out.reason, /not tracked by git/)
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a service the manifest does not build', async () => {
    const dir = await repo({ 'fleet.yaml': 'services:\n  api: { image: nginx }\n', 'vote/app.py': app })
    const out = await checkEdit(dir, edit)
    assert.equal(out.ok, false)
    if (!out.ok) assert.match(out.reason, /does not say where/)
    await rm(dir, { recursive: true, force: true })
  })
})



