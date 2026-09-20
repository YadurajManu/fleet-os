import 'dotenv/config'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  createContext,
  closeContext,
  type AppContext,
} from '../src/api/context.js'
import { loadConfig } from '../src/config.js'
import {
  orgs,
  fleets,
  nodes,
  services,
  deployments,
  buildJobs,
} from '../src/db/schema.js'
import { signGrant } from '../src/build/credentials.js'
import { buildTransferRoutes, archivePath } from '../src/build/transfers.js'

const app = Fastify()
let ctx: AppContext,
  dir: string,
  orgId: string,
  nodeId: string,
  serviceId: string,
  jobId: string,
  deploymentId: string
const requests: { url: string; auth: string; body: string }[] = []
const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  requests.push({
    url: req.url!,
    auth: req.headers.authorization ?? '',
    body: Buffer.concat(chunks).toString(),
  })
  res.writeHead(202, {
    Location: `/v2/fleet-builds/${serviceId}/blobs/uploads/one`,
  })
  res.end()
})
before(async () => {
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  dir = await mkdtemp(join(tmpdir(), 'fleet-transfers-'))
  ctx = createContext({
    ...loadConfig(),
    BUILD_MODE: 'local',
    BUILD_WORKDIR: dir,
    REGISTRY_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    REGISTRY_CREDENTIALS: 'upstream:test-only',
  })
  app.decorate('ctx', ctx)
  await app.register(buildTransferRoutes)
  const [o] = await ctx.db
    .insert(orgs)
    .values({ name: 'transfer-tests' })
    .returning()
  orgId = o!.id
  const [f] = await ctx.db
    .insert(fleets)
    .values({ orgId, name: 'test' })
    .returning()
  const [n] = await ctx.db
    .insert(nodes)
    .values({
      fleetId: f!.id,
      name: 'builder',
      arch: 'arm64',
      cpuCores: 8,
      ramMb: 16384,
      diskMb: 100000,
      agentTokenHash: 'test-only',
    })
    .returning()
  nodeId = n!.id
  const [s] = await ctx.db
    .insert(services)
    .values({ fleetId: f!.id, name: 'app' })
    .returning()
  serviceId = s!.id
  const [d] = await ctx.db
    .insert(deployments)
    .values({ serviceId, nodeId, status: 'building' })
    .returning()
  deploymentId = d!.id
  const [j] = await ctx.db
    .insert(buildJobs)
    .values({
      deploymentId,
      serviceId,
      platform: 'linux/arm64',
      sourceRef: 'test',
      status: 'running',
      builderNodeId: nodeId,
      attempt: 1,
      leaseExpiresAt: new Date(Date.now() + 60000),
    })
    .returning()
  jobId = j!.id
  await mkdir(join(dir, 'delegated'))
  await writeFile(archivePath(dir, deploymentId), 'test archive')
})
after(async () => {
  await app.close()
  await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
  await closeContext(ctx)
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})
function grant(purpose: 'source' | 'push', attempt = 1) {
  return signGrant(
    {
      purpose,
      job: jobId,
      node: nodeId,
      attempt,
      repo: `fleet-builds/${serviceId}`,
      exp: Date.now() + 60000,
    },
    ctx.config.JWT_SECRET
  )
}
function auth() {
  return `Basic ${Buffer.from(`build:${grant('push')}`).toString('base64')}`
}
test('source grants are scoped to an active job and attempt', async () => {
  const result = await app.inject({
    url: `/agent/build-source/${jobId}`,
    headers: { authorization: `Bearer ${grant('source')}` },
  })
  assert.equal(result.statusCode, 200)
  assert.equal(result.body, 'test archive')
  for (const token of [grant('push'), grant('source', 2), 'invalid']) {
    assert.equal(
      (
        await app.inject({
          url: `/agent/build-source/${jobId}`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      403
    )
  }
})
test('registry grants cannot access other repositories or mount their blobs', async () => {
  const count = requests.length
  for (const url of [
    '/v2/other/blobs/uploads/',
    `/v2/fleet-builds/${serviceId}/blobs/uploads/?from=other&mount=sha256:abc`,
  ]) {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { authorization: auth() },
        })
      ).statusCode,
      403
    )
  }
  assert.equal(requests.length, count)
})
test('allowed uploads stream with upstream-only credentials and a gateway location', async () => {
  const result = await app.inject({
    method: 'PATCH',
    url: `/v2/fleet-builds/${serviceId}/blobs/uploads/one`,
    headers: {
      authorization: auth(),
      'content-type': 'application/octet-stream',
    },
    payload: 'layer bytes',
  })
  assert.equal(result.statusCode, 202)
  assert.equal(
    result.headers.location,
    `/v2/fleet-builds/${serviceId}/blobs/uploads/one`
  )
  assert.equal(requests.at(-1)!.body, 'layer bytes')
  assert.equal(
    requests.at(-1)!.auth,
    `Basic ${Buffer.from('upstream:test-only').toString('base64')}`
  )
})
test('completed attempts lose upload and source access immediately', async () => {
  await ctx.db
    .update(buildJobs)
    .set({ status: 'succeeded' })
    .where(eq(buildJobs.id, jobId))
  assert.equal(
    (await app.inject({ url: '/v2/', headers: { authorization: auth() } }))
      .statusCode,
    401
  )
  assert.equal(
    (
      await app.inject({
        url: `/agent/build-source/${jobId}`,
        headers: { authorization: `Bearer ${grant('source')}` },
      })
    ).statusCode,
    403
  )
})
