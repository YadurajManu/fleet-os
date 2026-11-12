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
