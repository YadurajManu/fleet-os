import { resolveSecrets } from '../secrets/store.js'
import { repositoryBuildToken } from '../github/app.js'
import { and, asc, desc, eq, gt, inArray, lt, or } from 'drizzle-orm'
import { createHash, createHmac } from 'node:crypto'
import { mkdir, readFile, rm, stat, realpath } from 'node:fs/promises'
import { dirname, relative, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppContext } from '../api/context.js'
import { buildJobs, deployments, nodes, services } from '../db/schema.js'
import { fleetSnapshot } from '../scheduler/snapshot.js'
import { publishLog } from '../api/log-stream.js'
import { containedContext, planBuilds } from './buildx.js'
import { buildEvent, type BuildAssignment } from './protocol.js'
import { signGrant } from './credentials.js'
import { archivePath } from './transfers.js'
import { selectBuilder, type Builder } from './platforms.js'
import { mergeManifests } from './manifests.js'
import {
  BuildUnavailableError,
  type BuildRequest,
  type BuildResult,
  type BuildRunner,
} from './runner.js'
const exec = promisify(execFile)
export const LEASE_MS = 45_000
const ACTIVE = ['assigned', 'running'] as const
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class AgentBuildRunner implements BuildRunner {
  readonly name = 'agent'
  private inFlight = new Set<string>()
  private cancelled = new Set<string>()
  private timer: ReturnType<typeof setInterval>
  constructor(private ctx: AppContext) {
    this.timer = setInterval(() => {
      void this.reapOrphans().catch(() => {})
    }, 10000)
    this.timer.unref()
  }
  close() {
    clearInterval(this.timer)
  }
  async available() {
    return Boolean(
      this.ctx.config.PUBLIC_API_URL && this.ctx.config.REGISTRY_URL
    )
  }
  private send(nodeId: string, msg: unknown) {
    return this.ctx.tunnels.sendBuild(nodeId, msg)
  }
  private async progress(
    req: BuildRequest,
    text: string,
    nodeId = 'control-plane'
  ) {
    const entry = {
      service: req.serviceName,
      serviceId: req.serviceId,
      nodeId,
      deploymentId: req.deploymentId,
      text,
      at: Date.now(),
    }
    await this.ctx.redis
      .multi()
      .lpush(`build:logs:${req.serviceId}`, JSON.stringify(entry))
      .ltrim(`build:logs:${req.serviceId}`, 0, 199)
      .expire(`build:logs:${req.serviceId}`, 86400)
      .exec()
    await publishLog(this.ctx.redis, req.serviceName, entry)
  }
  async handleMessage(nodeId: string, raw: unknown) {
    const parsed = buildEvent.safeParse(raw)
    if (!parsed.success) return
    const event = parsed.data
    const [job] = await this.ctx.db
      .select()
      .from(buildJobs)
      .where(eq(buildJobs.id, event.job_id))
      .limit(1)
    if (!job || job.builderNodeId !== nodeId || job.attempt !== event.attempt)
      return
    const receipt = {
      type: 'build.receipt',
      version: 1,
      job_id: job.id,
      attempt: job.attempt,
    }
    if (!ACTIVE.includes(job.status as (typeof ACTIVE)[number])) {
      this.send(nodeId, receipt)
      return
    }
    if (
      !this.inFlight.has(job.deploymentId) ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt.getTime() <= Date.now()
    ) {
      this.send(nodeId, { ...receipt, type: 'build.cancel' })
      return
    }
    const fence = and(
      eq(buildJobs.id, job.id),
      eq(buildJobs.attempt, event.attempt),
      eq(buildJobs.builderNodeId, nodeId),
      inArray(buildJobs.status, [...ACTIVE]),
      gt(buildJobs.leaseExpiresAt, new Date())
    )
    if (event.type === 'build.ack' || event.type === 'build.renew') {
      await this.ctx.db
        .update(buildJobs)
        .set({
          status: 'running',
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        })
        .where(fence)
    } else if (event.type === 'build.log' && event.text) {
      const [service] = await this.ctx.db
        .select()
        .from(services)
        .where(eq(services.id, job.serviceId))
        .limit(1)
      if (!service) return
      const entry = {
        service: service.name,
        serviceId: service.id,
        nodeId,
        deploymentId: job.deploymentId,
        text: event.text,
        at: Date.now(),
      }
      await this.ctx.redis
        .multi()
        .lpush(`build:logs:${service.id}`, JSON.stringify(entry))
        .ltrim(`build:logs:${service.id}`, 0, 199)
        .expire(`build:logs:${service.id}`, 86400)
        .exec()
      await publishLog(this.ctx.redis, service.name, entry)
    } else if (event.type === 'build.result') {
      const status =
        event.status === 'succeeded' && event.digest
          ? 'succeeded'
          : event.status === 'cancelled'
            ? 'cancelled'
            : 'failed'
      await this.ctx.db
        .update(buildJobs)
        .set({
          status,
          imageDigest: status === 'succeeded' ? event.digest : null,
          error:
            event.error ??
            (status === 'failed' ? 'build failed or returned no digest' : null),
          finishedAt: new Date(),
          leaseExpiresAt: null,
        })
        .where(fence)
      this.send(nodeId, receipt)
    }
  }
  async cancel(deploymentId: string) {
    if (this.inFlight.has(deploymentId)) this.cancelled.add(deploymentId)
    const jobs = await this.ctx.db
      .update(buildJobs)
      .set({
        status: 'cancelled',
        finishedAt: new Date(),
        leaseExpiresAt: null,
        error: 'cancelled by operator',
      })
      .where(
        and(
          eq(buildJobs.deploymentId, deploymentId),
          inArray(buildJobs.status, ['queued', ...ACTIVE])
        )
      )
      .returning()
    for (const job of jobs)
      if (job.builderNodeId)
        this.send(job.builderNodeId, {
          type: 'build.cancel',
          version: 1,
          job_id: job.id,
          attempt: job.attempt,
        })
  }
  private async reapOrphans() {
    const expired = await this.ctx.db
      .select()
      .from(buildJobs)
      .where(
        or(
          and(
            inArray(buildJobs.status, [...ACTIVE]),
            lt(buildJobs.leaseExpiresAt, new Date())
          ),
          and(
            eq(buildJobs.status, 'queued'),
            lt(buildJobs.createdAt, new Date(Date.now() - LEASE_MS))
          )
        )
      )
    for (const job of expired) {
      if (this.inFlight.has(job.deploymentId)) continue
      await this.ctx.db
        .update(buildJobs)
        .set({
          status: 'timed_out',
          error: 'control plane restarted or build lease expired',
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(buildJobs.id, job.id),
            eq(buildJobs.attempt, job.attempt),
            or(
              and(
                lt(buildJobs.leaseExpiresAt, new Date()),
                inArray(buildJobs.status, [...ACTIVE])
              ),
              eq(buildJobs.status, 'queued')
            )
          )
        )
      await this.ctx.db
        .update(deployments)
        .set({
          status: 'failed',
          failureReason: 'build_lease_expired: retry the deployment',
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(deployments.id, job.deploymentId),
            inArray(deployments.status, ['queued', 'building', 'pushing'])
          )
        )
      if (job.builderNodeId)
        this.send(job.builderNodeId, {
          type: 'build.cancel',
          version: 1,
          job_id: job.id,
          attempt: job.attempt,
        })
    }
  }
  private async reserve(
    job: typeof buildJobs.$inferSelect,
    req: BuildRequest,
    excluded: Set<string>
  ) {
    if (this.cancelled.has(job.deploymentId)) throw new Error('build cancelled')
    return this.ctx.db.transaction(async (tx) => {
      // Serialize builder allocation across requests/processes using node rows.
      const rows = await tx
        .select()
        .from(nodes)
        .where(eq(nodes.fleetId, req.fleetId!))
        .orderBy(asc(nodes.id))
        .for('update')
      const snapshot = await fleetSnapshot(
        { ...this.ctx, db: tx as unknown as AppContext['db'] },
        req.fleetId!
      )
      const active = await tx
        .select()
        .from(buildJobs)
        .where(inArray(buildJobs.status, [...ACTIVE]))
      const [previous] = await tx
        .select()
        .from(buildJobs)
        .where(
          and(
            eq(buildJobs.serviceId, req.serviceId!),
            eq(buildJobs.platform, job.platform),
            eq(buildJobs.status, 'succeeded')
          )
        )
        .orderBy(desc(buildJobs.finishedAt))
        .limit(1)
      const pool: Builder[] = rows.map((n) => {
        const capacity = snapshot.nodes.find((x) => x.id === n.id)!
        return {
          id: n.id,
          platform: n.platform,
          canBuild: n.canBuild && n.status === 'online' && !excluded.has(n.id),
          connected: this.ctx.tunnels.has(n.id),
          active: active.filter((j) => j.builderNodeId === n.id).length,
          maxConcurrentBuilds: n.maxConcurrentBuilds,
          freeCpu: (n.effectiveCpu ?? 0) - (capacity.committedCpu ?? 0),
          freeMemBytes:
            (n.effectiveMemBytes ?? 0) - capacity.committedRamMb * 1048576,
          buildDiskBytes: n.buildDiskBytes,
          buildCacheFreeBytes: n.buildCacheFreeBytes,
          buildDiskReserveBytes: n.buildDiskReserveBytes,
          load: capacity.loadFactor ?? 0.5,
          reliabilityScore: n.reliabilityScore,
        }
      })
      const builder = selectBuilder(
        pool,
        job.platform,
        previous?.builderNodeId ?? null,
        this.ctx.config.ALLOW_QEMU_FALLBACK
      )
      if (!builder)
        throw new BuildUnavailableError(
          `no build-capable ${job.platform} agent online with available CPU/memory/concurrency and disk budget plus reserve`
        )
      const [assigned] = await tx
        .update(buildJobs)
        .set({
          status: 'assigned',
          builderNodeId: builder.id,
          attempt: job.attempt + 1,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          startedAt: new Date(),
          finishedAt: null,
          error: null,
        })
        .where(
          and(
            eq(buildJobs.id, job.id),
            eq(buildJobs.attempt, job.attempt),
            inArray(buildJobs.status, ['queued', 'timed_out'])
          )
        )
        .returning()
      if (!assigned) throw new Error('build cancelled before assignment')
      return { job: assigned, builder }
    })
  }
  private async runJob(
    initial: typeof buildJobs.$inferSelect,
    req: BuildRequest,
    checksum: string,
    origin: URL,
    repo: string,
    buildArgs: Record<string, string>,
    buildSecrets: Record<string, string>
  ) {
    let job = initial
    const excluded = new Set<string>()
    for (let retry = 0; retry < 3; retry++) {
      const assigned = await this.reserve(job, req, excluded)
      job = assigned.job
      const { builder } = assigned
      const exp =
        Date.now() + Math.min(this.ctx.config.BUILD_TIMEOUT_MS, 3600000) + 60000
      const grant = {
        job: job.id,
        attempt: job.attempt,
        node: builder.id,
        repo,
        exp,
      }
      const emulated = builder.platform !== job.platform
      await this.progress(
        req,
        `assigned ${job.platform} build to ${builder.id}${emulated ? ' (slow QEMU fallback)' : ''}`,
        builder.id
      )
      req.onProgress?.({
        phase: 'building',
        platform: job.platform,
        builder: builder.id,
        emulated,
        detail: `assigned to ${builder.id}${emulated ? ' (slow QEMU fallback)' : ''}`,
      })
      let sourceToken = signGrant(
        { ...grant, purpose: 'source' },
        this.ctx.config.JWT_SECRET
      )
      if (req.gitSource?.installationId && this.ctx.github) {
        const repository = new URL(req.gitSource.repository).pathname
          .split('/')
          .at(-1)!
          .replace(/\.git$/, '')
        sourceToken = await repositoryBuildToken(
          this.ctx.github,
          req.gitSource.installationId,
          repository
        )
      } else if (req.gitSource) sourceToken = ''
      const pushOrigin = new URL(
        this.ctx.config.BUILD_REGISTRY_URL ?? origin.href
      )
      const assignment: BuildAssignment = {
        type: 'build.assign',
        version: 1,
        job_id: job.id,
        attempt: job.attempt,
        platform: job.platform,
        cache_key: `${req.serviceId}:${job.platform}`,
        emulated,
        source: {
          url: new URL(`/agent/build-source/${job.id}`, origin).href,
          token: sourceToken,
          sha256: checksum,
          ...(req.gitSource
            ? {
                repository: req.gitSource.repository,
                commit: req.gitSource.commit,
                context: req.gitSource.context,
              }
            : {}),
        },
        build_args: buildArgs,
        secrets: buildSecrets,
        dockerfile: 'Dockerfile',
        registry_target: `${pushOrigin.host}/${repo}:${req.gitSha.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40) || 'source'}-${job.platform.replaceAll('/', '-')}-${job.id.slice(0, 8)}-${job.attempt}`,
        registry_username: 'build',
        registry_password: signGrant(
          { ...grant, purpose: 'push' },
          this.ctx.config.JWT_SECRET
        ),
        timeout_ms: Math.min(this.ctx.config.BUILD_TIMEOUT_MS, 3600000),
        cpu: 2,
        memory_bytes: 2147483648,
        disk_bytes: builder.buildDiskBytes ?? 20 * 1073741824,
      }
      if (!this.send(builder.id, assignment))
        await this.ctx.db
          .update(buildJobs)
          .set({ leaseExpiresAt: new Date(0) })
          .where(eq(buildJobs.id, job.id))
      const deadline = Date.now() + assignment.timeout_ms
      while (true) {
        await sleep(500)
        const [current] = await this.ctx.db
          .select()
          .from(buildJobs)
          .where(eq(buildJobs.id, job.id))
          .limit(1)
        if (!current) throw new Error('build was removed')
        job = current
        if (job.status === 'succeeded' && job.imageDigest)
          return job.imageDigest
        if (job.status === 'failed' || job.status === 'cancelled')
          throw new Error(job.error ?? `build ${job.status}`)
        if (
          Date.now() > deadline ||
          !job.leaseExpiresAt ||
          job.leaseExpiresAt.getTime() <= Date.now()
        ) {
          this.send(builder.id, {
            type: 'build.cancel',
            version: 1,
            job_id: job.id,
            attempt: job.attempt,
          })
          await this.ctx.db
            .update(buildJobs)
            .set({
              status: 'timed_out',
              error: 'builder lease expired or build timed out',
              finishedAt: new Date(),
              leaseExpiresAt: null,
            })
            .where(
              and(
                eq(buildJobs.id, job.id),
                eq(buildJobs.attempt, job.attempt),
                inArray(buildJobs.status, [...ACTIVE])
              )
            )
          excluded.add(builder.id)
          break
        }
      }
    }
    throw new Error('build timed out after 3 attempts')
  }
  async build(req: BuildRequest): Promise<BuildResult> {
    if (!req.deploymentId || !req.serviceId || !req.fleetId)
      throw new BuildUnavailableError(
        'agent builds require deployment, service and fleet identity'
      )
    if (!(await this.available()))
      throw new BuildUnavailableError(
        'agent builds require PUBLIC_API_URL and REGISTRY_URL'
      )
    const [deployment] = await this.ctx.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, req.deploymentId))
      .limit(1)
    if (
      !deployment ||
      !['queued', 'building', 'pushing'].includes(deployment.status)
    )
      throw new Error('deployment was cancelled or already finished')
    const origin = new URL(this.ctx.config.PUBLIC_API_URL!)
    if (origin.protocol !== 'https:' || origin.pathname !== '/')
      throw new BuildUnavailableError(
        'PUBLIC_API_URL must be an HTTPS origin serving /agent/build-source and /v2/'
      )
    const pushOrigin = new URL(
      this.ctx.config.BUILD_REGISTRY_URL ?? origin.href
    )
    if (pushOrigin.protocol !== 'https:' || pushOrigin.pathname !== '/')
      throw new BuildUnavailableError(
        'BUILD_REGISTRY_URL must be an HTTPS origin serving /v2/'
      )
    if (!req.platforms.length)
      throw new BuildUnavailableError('no eligible Linux platforms')
    const started = Date.now(),
      deploymentId = req.deploymentId,
      repo = `fleet-builds/${req.serviceId}`
    const archive = archivePath(this.ctx.config.BUILD_WORKDIR, deploymentId)
    if (!req.contextRoot)
      throw new BuildUnavailableError(
        'agent builds require an uploaded source context or a repository checkout; the shared build workdir is not a source context'
      )
    const root = await realpath(req.contextRoot)
    const context = await realpath(containedContext(root, req.buildContext))
    const contextRelative = relative(root, context)
    if (
      contextRelative === '..' ||
      contextRelative.startsWith('../') ||
      isAbsolute(contextRelative)
    )
      throw new BuildUnavailableError(
        'build context escapes the workspace through a symlink'
      )
    await mkdir(dirname(archive), { recursive: true, mode: 0o700 })
    this.inFlight.add(deploymentId)
    try {
      await this.progress(req, 'queued: preparing delegated build source')
      const archiveDirectory = relative(context, dirname(archive))
      const excludes =
        archiveDirectory &&
        !archiveDirectory.startsWith('..') &&
        !isAbsolute(archiveDirectory)
          ? [`--exclude=./${archiveDirectory}`]
          : []
      await exec(
        'tar',
        ['-czf', archive, '--exclude=.git', ...excludes, '-C', context, '.'],
        { timeout: 60000 }
      )
      if ((await stat(archive)).size > 256 * 1048576)
        throw new Error('source archive exceeds 256MiB')
      const checksum = createHash('sha256')
        .update(await readFile(archive))
        .digest('hex')
      const [service] = await this.ctx.db
        .select()
        .from(services)
        .where(
          and(eq(services.id, req.serviceId), eq(services.fleetId, req.fleetId))
        )
        .limit(1)
      if (!service)
        throw new Error('build service does not belong to this fleet')
      const secrets = await resolveSecrets(
        this.ctx,
        req.fleetId,
        req.serviceId,
        service.buildSecretRefs
      )
      if (secrets.missing.length)
        throw new Error(`missing build secrets: ${secrets.missing.join(', ')}`)
      // Credentials and secret values never enter the job row. Secret changes must
      // invalidate a cached output, so include only their keyed digest in this key.
      const sourceRef = createHmac('sha256', this.ctx.config.JWT_SECRET)
        .update(
          JSON.stringify([
            req.sourceKey ?? checksum,
            service.buildArgs,
            secrets.values,
          ])
        )
        .digest('hex')
      const groups = planBuilds(
        req.platforms,
        new Map(req.platforms.map((p) => [p, p]))
      )
      const jobs: Promise<PromiseSettledResult<string>>[] = []
      for (const group of groups) {
        if (this.cancelled.has(deploymentId)) throw new Error('build cancelled')
        const platform = group.platforms[0]!
        const [cached] = await this.ctx.db
          .select()
          .from(buildJobs)
          .where(
            and(
              eq(buildJobs.serviceId, req.serviceId),
              eq(buildJobs.platform, platform),
              eq(buildJobs.sourceRef, sourceRef),
              eq(buildJobs.status, 'succeeded')
            )
          )
          .orderBy(desc(buildJobs.finishedAt))
          .limit(1)
        if (cached?.imageDigest) {
          await this.ctx.db.insert(buildJobs).values({
            deploymentId,
            serviceId: req.serviceId,
            platform,
            sourceRef,
            status: 'succeeded',
            imageDigest: cached.imageDigest,
            finishedAt: new Date(),
          })
          req.onProgress?.({
            phase: 'building',
            platform,
            detail: 'reusing previously built digest',
          })
          jobs.push(
            Promise.resolve({ status: 'fulfilled', value: cached.imageDigest })
          )
          continue
        }
        const [job] = await this.ctx.db
          .insert(buildJobs)
          .values({
            deploymentId,
            serviceId: req.serviceId,
            platform,
            sourceRef,
          })
          .returning()
        jobs.push(
          this.runJob(
            job!,
            req,
            checksum,
            origin,
            repo,
            service.buildArgs,
            secrets.values
          ).then(
            (value) => ({ status: 'fulfilled', value }) as const,
            async (reason) => {
              await this.ctx.db
                .update(buildJobs)
                .set({
                  status: 'failed',
                  error:
                    reason instanceof Error ? reason.message : 'build failed',
                  finishedAt: new Date(),
                  leaseExpiresAt: null,
                })
                .where(
                  and(
                    eq(buildJobs.id, job!.id),
                    inArray(buildJobs.status, ['queued', ...ACTIVE])
                  )
                )
              await this.cancel(deploymentId)
              return { status: 'rejected', reason } as const
            }
          )
        )
      }
      const outcomes = await Promise.all(jobs)
      const failure = outcomes.find((x) => x.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      if (this.cancelled.has(deploymentId)) throw new Error('build cancelled')
      const digests = outcomes.map(
        (x) => (x as PromiseFulfilledResult<string>).value
      )
      const registry = this.ctx.config
        .REGISTRY_URL!.replace(/^https?:\/\//, '')
        .replace(/\/$/, '')
      const imageRepo = `${registry}/${repo}`
      const digest =
        digests.length === 1
          ? digests[0]!
          : await mergeManifests(
              imageRepo,
              `${deploymentId}`,
              digests,
              this.ctx.config.REGISTRY_CREDENTIALS
            )
      if (this.cancelled.has(deploymentId)) throw new Error('build cancelled')
      await this.ctx.db
        .update(services)
        .set({ imagePlatforms: req.platforms })
        .where(eq(services.id, req.serviceId))
      req.onProgress?.({
        phase: 'pushing',
        detail: `pushed immutable image ${digest}`,
      })
      await this.progress(req, `pushed ${imageRepo}@${digest}`)
      return {
        imageTags: [`${imageRepo}@${digest}`],
        digest,
        durationMs: Date.now() - started,
      }
    } finally {
      this.inFlight.delete(deploymentId)
      await this.cancel(deploymentId)
      this.cancelled.delete(deploymentId)
      await rm(archive, { force: true })
    }
  }
}
