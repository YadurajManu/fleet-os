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
import type { TaskSpec } from '../src/tunnel/registry.js'

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

const ctx = createContext(loadConfig())
let app: Awaited<ReturnType<typeof buildServer>>
let account: { user: { id: string }; org: { id: string }; fleet: { id: string }; accessToken: string }
let outsider: typeof account
let serviceId: string
let nodeId: string
let calls = 0
let observed: TaskSpec | undefined
before(async () => {
  app = await buildServer(ctx)
  const signup = async () => (await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: `task-${randomUUID()}@example.test`, password: 'task-regression-passphrase' } })).json()
  account = await signup()
  outsider = await signup()
  const [node] = await ctx.db.insert(nodes).values({ fleetId: account.fleet.id, name: 'task-node', arch: 'arm64', platform: 'linux/arm64', taskRun: true, cpuCores: 2, ramMb: 2048, diskMb: 10000, agentTokenHash: randomUUID() }).returning()
  nodeId = node!.id
  const [service] = await ctx.db.insert(services).values({ fleetId: account.fleet.id, name: 'web', requestRamMb: 128, env: { DATABASE_URL: 'private-network-url' } }).returning()
  serviceId = service!.id
  await ctx.db.insert(deployments).values({ serviceId, nodeId, status: 'failed', imageTags: ['app@sha256:' + 'a'.repeat(64)] })
  ctx.tunnels.has = () => true
  ctx.tunnels.runTask = async (node, spec) => {
    calls++
    assert.equal(node, nodeId)
    observed = spec
    return { exitCode: 7, output: 'migration output' }
  }
})

test('registration persists memory ceilings and legacy reports default safely', async () => {
  for (const ceiling of [undefined, 8 * 1073741824]) {
    const issued = await app.inject({ method: 'POST', url: `/fleets/${account.fleet.id}/nodes/pair-token`, headers: { authorization: `Bearer ${account.accessToken}` }, payload: {} })
    const registered = await app.inject({ method: 'POST', url: '/agent/register', headers: { authorization: `Bearer ${issued.json().token}` }, payload: { hostname: `memory-report-${randomUUID()}`, arch: 'arm64', cpu_cores: 2, ram_mb: 16384, disk_mb: 10000, ...(ceiling === undefined ? {} : { build_memory_bytes: ceiling }) } })
    assert.equal(registered.statusCode, 201, registered.body)
    const [node] = await ctx.db.select().from(nodes).where(eq(nodes.id, registered.json().node_id))
    assert.equal(node!.buildMemoryBytes, ceiling ?? 2 * 1073741824)
    for (const updated of [4 * 1073741824, undefined]) {
      const beat = await app.inject({ method: 'POST', url: '/agent/heartbeat', headers: { authorization: `Bearer ${registered.json().agent_token}` }, payload: { cpu_pct: 0, ram_used_mb: 0, disk_used_mb: 0, containers: [], capabilities: { arch: 'arm64', cpu_cores: 2, ram_mb: 16384, disk_mb: 10000, ...(updated === undefined ? {} : { build_memory_bytes: updated }) } } })
      assert.equal(beat.statusCode, 200, beat.body)
      const [reported] = await ctx.db.select().from(nodes).where(eq(nodes.id, node!.id))
      assert.equal(reported!.buildMemoryBytes, updated ?? 2 * 1073741824)
    }
  }
})
after(async () => {
  await app.close()
  for (const a of [account, outsider]) {
    if (!a) continue
    await ctx.db.delete(orgs).where(eq(orgs.id, a.org.id))
    await ctx.db.delete(users).where(eq(users.id, a.user.id))
  }
  await closeContext(ctx)
})
const run = (token = account.accessToken, body: unknown = { command: ['pnpm', 'db:migrate'] }) => app.inject({ method: 'POST', url: `/services/${serviceId}/tasks`, headers: { authorization: `Bearer ${token}` }, payload: body as object })

test('one-off tasks use the latest built artifact even when initial rollout failed', async () => {
  const res = await run()
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type']!, /text\/event-stream/)
  assert.match(res.body, /event: result/)
  assert.match(res.body, /"exitCode":7/)
  assert.deepEqual(observed!.command, ['pnpm', 'db:migrate'])
  assert.equal(observed!.env.DATABASE_URL, 'private-network-url')
  assert.equal(observed!.platform, 'linux/arm64')
  assert.equal(observed!.memory_bytes, 128 * 1048576)
  const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.targetId, serviceId))
  assert.doesNotMatch(JSON.stringify(audit), /db:migrate|private-network-url/)
})

test('task permission and fleet boundaries are checked before contacting an agent', async () => {
  const before = calls
  assert.equal((await run(outsider.accessToken)).statusCode, 404)
  await ctx.db.update(orgMembers).set({ role: 'viewer' }).where(eq(orgMembers.userId, account.user.id))
  try { assert.equal((await run()).statusCode, 403) }
  finally { await ctx.db.update(orgMembers).set({ role: 'owner' }).where(eq(orgMembers.userId, account.user.id)) }
  assert.equal(calls, before)
})

test('invalid commands and outdated agents fail clearly without starting work', async () => {
  const before = calls
  assert.equal((await run(account.accessToken, { command: [], timeoutMs: 1 })).statusCode, 400)
  await ctx.db.update(nodes).set({ taskRun: false }).where(eq(nodes.id, nodeId))
  try {
    const res = await run()
    assert.equal(res.statusCode, 422)
    assert.equal(res.json().error.code, 'task_agent_upgrade')
  } finally { await ctx.db.update(nodes).set({ taskRun: true }).where(eq(nodes.id, nodeId)) }
  assert.equal(calls, before)
})

test('public task images never receive private registry credentials', async () => {
  const original = { url: ctx.config.REGISTRY_URL, credentials: ctx.config.REGISTRY_CREDENTIALS }
  ctx.config.REGISTRY_URL = 'https://private.example.test'
  ctx.config.REGISTRY_CREDENTIALS = 'private-user:private-password'
  try {
    assert.equal((await run()).statusCode, 200)
    assert.equal(observed!.registry_auth, null)
  } finally {
    ctx.config.REGISTRY_URL = original.url
    ctx.config.REGISTRY_CREDENTIALS = original.credentials
  }
})

test('pairing errors and replacement preserve identity', async () => {
  const auth = { authorization: `Bearer ${account.accessToken}` }
  const path = `/fleets/${account.fleet.id}/nodes/${nodeId}`
  const renamed = await app.inject({ method: 'PATCH', url: path, headers: auth, payload: { name: 'renamed-node' } })
  assert.equal(renamed.statusCode, 200, renamed.body)
  assert.equal(renamed.json().node.id, nodeId)
  for (const [authorization, code] of [[undefined, 'pairing_token_missing'], ['Bearer truncated', 'pairing_token_malformed']] as const) {
    const res = await app.inject({ method: 'POST', url: '/agent/register', headers: authorization ? { authorization } : {}, payload: {} })
    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, code)
  }
  const has = ctx.tunnels.has
  ctx.tunnels.has = () => false
  try {
    const issue = await app.inject({ method: 'POST', url: `/fleets/${account.fleet.id}/nodes/pair-token`, headers: auth, payload: { replaceNodeId: nodeId } })
    assert.equal(issue.statusCode, 201, issue.body)
    const headers = { authorization: `Bearer ${issue.json().token}` }
    const payload = { hostname: 'different-host', arch: 'arm64', cpu_cores: 2, ram_mb: 2048, disk_mb: 10000 }
    const paired = await app.inject({ method: 'POST', url: '/agent/register', headers, payload })
    assert.equal(paired.statusCode, 201, paired.body)
    assert.equal(paired.json().node_id, nodeId)
    assert.equal((await app.inject({ method: 'POST', url: '/agent/register', headers, payload })).json().error.code, 'pairing_token_used')
  } finally { ctx.tunnels.has = has }
})

test('secret copies hide values, refuse overwrite and enforce fleet boundaries', async () => {
  const headers = { authorization: `Bearer ${account.accessToken}` }
  const base = `/fleets/${account.fleet.id}/secrets`
  assert.equal((await app.inject({ method: 'PUT', url: `${base}/CLONE_TEST`, headers, payload: { value: 'never-echo-this' } })).statusCode, 201)
  const payload = { key: 'CLONE_TEST', toServiceId: serviceId }
  const copied = await app.inject({ method: 'POST', url: `${base}/clone`, headers, payload })
  assert.equal(copied.statusCode, 201, copied.body)
  assert.doesNotMatch(copied.body, /never-echo-this|ciphertext|wrappedDek/)
  assert.equal((await app.inject({ method: 'POST', url: `${base}/clone`, headers, payload })).statusCode, 409)
  assert.equal((await app.inject({ method: 'POST', url: `/fleets/${outsider.fleet.id}/secrets/clone`, headers, payload })).statusCode, 404)
})

test('expired pairing credentials and duplicate hostnames give recovery paths', async () => {
  const { pairingTokens } = await import('../src/db/schema.js')
  const { hashToken, newPairingToken } = await import('../src/lib/tokens.js')
  const payload = { hostname: 'renamed-node', arch: 'arm64', cpu_cores: 2, ram_mb: 2048, disk_mb: 10000 }
  const expired = newPairingToken()
  await ctx.db.insert(pairingTokens).values({ fleetId: account.fleet.id, tokenHash: hashToken(expired), expiresAt: new Date(Date.now() - 1000) })
  assert.equal((await app.inject({ method: 'POST', url: '/agent/register', headers: { authorization: `Bearer ${expired}` }, payload })).json().error.code, 'pairing_token_expired')
  assert.equal((await app.inject({ method: 'POST', url: '/agent/register', headers: { authorization: `Bearer ${newPairingToken()}` }, payload })).json().error.code, 'pairing_token_invalid')
  const issue = await app.inject({ method: 'POST', url: `/fleets/${account.fleet.id}/nodes/pair-token`, headers: { authorization: `Bearer ${account.accessToken}` }, payload: {} })
  const res = await app.inject({ method: 'POST', url: '/agent/register', headers: { authorization: `Bearer ${issue.json().token}` }, payload })
  assert.equal(res.statusCode, 409, res.body)
  assert.equal(res.json().error.code, 'node_already_exists')
})

test('build secret preflight reports keys and guidance before any build', async () => {
  const { requireBuildSecrets } = await import('../src/secrets/store.js')
  await assert.rejects(requireBuildSecrets(ctx, { id: serviceId, fleetId: account.fleet.id, name: 'web', buildSecretRefs: ['MISSING_BUILD_TOKEN'] }), (err: any) => err.code === 'missing_build_secrets' && /--only MISSING_BUILD_TOKEN/.test(err.message))
})

test('image inspection failure still schedules an image-only deployment', async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fleet-inspect-failure-'))
  const path = process.env.PATH
  const mode = ctx.config.BUILD_MODE
  await writeFile(join(dir, 'docker'), '#!/bin/sh\necho "registry unavailable" >&2\nexit 1\n')
  await chmod(join(dir, 'docker'), 0o700)
  try {
    process.env.PATH = `${dir}:${path}`
    ctx.config.BUILD_MODE = 'agent'
    await ctx.db.update(services).set({ image: 'private.example/unavailable:latest', buildContext: null }).where(eq(services.id, serviceId))
    const res = await app.inject({ method: 'POST', url: `/services/${serviceId}/deploy`, headers: { authorization: `Bearer ${account.accessToken}` }, payload: {} })
    assert.equal(res.statusCode, 202, res.body)
    await ctx.deploysInFlight.get(res.json().deployment.id)
    const [deployment] = await ctx.db.select().from(deployments).where(eq(deployments.id, res.json().deployment.id))
    assert.equal(deployment!.status, 'deploying')
    assert.deepEqual(deployment!.imageTags, ['private.example/unavailable:latest'])
    assert.match(deployment!.warnings.join(' '), /compatibility could not be verified/)
    assert.match(res.json().warnings.join(' '), /compatibility could not be verified/)
    const preview = await app.inject({ method: 'GET', url: `/services/${serviceId}/placement-preview`, headers: { authorization: `Bearer ${account.accessToken}` } })
    assert.match(preview.json().decision.warnings.join(' '), /compatibility could not be verified/)
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path
    ctx.config.BUILD_MODE = mode
    await rm(dir, { recursive: true, force: true })
  }
})

test('cross-fleet copying authorizes both scopes and preserves encrypted values and destinations', async () => {
  const headers = { authorization: `Bearer ${account.accessToken}` }
  await app.inject({ method: 'PUT', url: `/fleets/${outsider.fleet.id}/secrets/CROSS_COPY`, headers: { authorization: `Bearer ${outsider.accessToken}` }, payload: { value: 'cross-fleet-private-value' } })
  const input = { method: 'POST' as const, url: `/fleets/${account.fleet.id}/secrets/clone`, headers, payload: { key: 'CROSS_COPY', fromFleetId: outsider.fleet.id, toServiceId: serviceId } }
  assert.equal((await app.inject(input)).statusCode, 404)
  await ctx.db.insert(orgMembers).values({ orgId: outsider.org.id, userId: account.user.id, role: 'viewer' })
  assert.equal((await app.inject(input)).statusCode, 403)
  await ctx.db.update(orgMembers).set({ role: 'deployer' }).where(eq(orgMembers.orgId, outsider.org.id))
  const copied = await app.inject(input)
  assert.equal(copied.statusCode, 201, copied.body)
  assert.doesNotMatch(copied.body, /cross-fleet-private-value|ciphertext|wrappedDek/)
  const { resolveSecrets } = await import('../src/secrets/store.js')
  assert.equal((await resolveSecrets(ctx, account.fleet.id, serviceId, ['CROSS_COPY'])).values.CROSS_COPY, 'cross-fleet-private-value')
  assert.equal((await app.inject(input)).statusCode, 409)
  const wrongScope = await app.inject({ ...input, payload: { ...input.payload, fromServiceId: serviceId } })
  assert.equal(wrongScope.statusCode, 404)
})
