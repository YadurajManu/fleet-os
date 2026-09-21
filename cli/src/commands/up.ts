/**
 * fleet up — one command that takes any repo from zero to a live HTTPS URL.
 *
 * Chains: detect → init → apply → deploy → wait → URL.
 *
 * Every step re-uses the existing CLI primitives (`task`, `splash`, `request`)
 * so the experience is consistent with the granular commands; this just removes
 * the operator from the loop between them.
 */
import { readFile, writeFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c } from '../render.js'
import { task, glyph } from '../ui.js'
import { withLadder } from '../ladder.js'
import { DEPLOY_STEPS, phaseWalker } from '../progress.js'
import { requireRunning } from '../deploy-wait.js'
import { planFromManifest, deployOrder, projectNameFor } from '../plan.js'
import { uploadContext, humanBytes } from '../archive.js'
import type { Flags } from '../args.js'

type Service = {
  id: string
  name: string
  domain: string | null
  hostname: string | null
  current: { status: string } | null
}

export const upCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const rootDir = typeof flags.dir === 'string' ? flags.dir : process.cwd()
    const manifestPath =
      typeof flags.file === 'string'
        ? flags.file
        : typeof flags.manifest === 'string'
        ? flags.manifest
        : join(rootDir, 'fleet.yaml')

    // ── Step 1: scaffold if needed ────────────────────────────────────
    try {
      await access(manifestPath)
    } catch {
      // No fleet.yaml — run the smart init inline.
      const { detect, manifestTemplate } = await import('../detect.js')
      const d = await task('detecting project framework', async () => detect(rootDir))

      const name =
        (typeof flags.name === 'string' ? flags.name : '') ||
        args[0] ||
        rootDir.split('/').pop()?.toLowerCase().replace(/[^a-z0-9-]+/g, '-') ||
        'app'

      // Write Dockerfile if generated
      if (d.dockerfile) {
        await writeFile(join(rootDir, 'Dockerfile'), d.dockerfile)
        console.log(`${glyph.ok} ${c.green('created')} Dockerfile  ${c.dim(`(${d.label}, port ${d.port})`)}`)
      }

      // Write manifest
      await writeFile(manifestPath, manifestTemplate(name, d))
      console.log(`${glyph.ok} ${c.green('created')} ${manifestPath}  ${c.dim(`(${d.label})`)}`)
    }

    // ── Step 2: read and apply the manifest ───────────────────────────
    const manifest = await readFile(manifestPath, 'utf8')

    const applyResult = await task(
      `applying ${manifestPath}`,
      async () =>
        (
          await request<{
            project: string
            created: string[]
            updated: string[]
            orphaned: string[]
            warnings: string[]
          }>('POST', `/fleets/${fleetId}/services`, {
            body: { manifest, project: projectNameFor(rootDir) },
          })
        ).body,
      {
        done: (b) =>
          b.created.length || b.updated.length
            ? `applied ${b.created.length + b.updated.length} service(s) to project ${b.project}`
            : `no changes in project ${b.project}`,
      }
    )

    for (const w of applyResult.warnings) {
      console.log(`${glyph.warn} ${c.yellow('warning')}  ${w}`)
    }

    // ── Step 3: decide what to deploy, and in what order ──────────────
    const planned = planFromManifest(manifest)
    const buildContexts = new Map(planned.map((p) => [p.name, p.build]))

    // No argument means the whole stack. A manifest describes a system, and
    // deploying one service of it and leaving the rest was never what anybody
    // wanted — it just meant typing the command again in the right order.
    const targets = args[0] ? [args[0]] : deployOrder(planned)
    const isDatabase = new Set(planned.filter((p) => p.database).map((p) => p.name))
    if (!targets.length) {
      throw new CliError(
        'The manifest declares no services to deploy.',
        EXIT.usage
      )
    }

    const { body: listBody } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
    const resolved = targets.map((name) => {
      const service = listBody.services.find((s) => s.name === name || s.id === name)
      if (!service) {
        throw new CliError(
          `Service "${name}" not found after apply. Known: ${listBody.services.map((s) => s.name).join(', ')}`,
          EXIT.usage
        )
      }
      return service
    })

    // A database that is already serving is left alone.
    const skipped = args[0]
      ? []
      : resolved.filter((s) => isDatabase.has(s.name) && s.current?.status === 'running')
    const toDeploy = resolved.filter((s) => !skipped.includes(s))
    for (const s of skipped) {
      console.log(`  ${c.dim('already running')}  ${c.bold(s.name)}`)
    }

    if (toDeploy.length > 1) {
      console.log(
        `\n  ${c.dim('deploying')} ${toDeploy.map((s) => c.bold(s.name)).join(c.dim(' → '))}\n`
      )
    }

    const gitSha = typeof flags.sha === 'string' ? flags.sha : undefined
    const deployed: Array<{ service: Service; url: string | null }> = []

    for (const service of toDeploy) {
      const url = await deployOne(service, {
        fleetId,
        gitSha,
        buildContext: buildContexts.get(service.name),
        wait: !flags['no-wait'],
        ...(typeof flags.node === 'string' ? { node: flags.node } : {}),
        rootDir: typeof flags.file === 'string' ? dirname(flags.file) : rootDir,
      })
      deployed.push({ service, url })
    }

    // ── Step 6: print the URLs ────────────────────────────────────────
    for (const { service, url } of deployed) {
      const target = url ?? service.domain ?? service.hostname
      if (!target) continue
      const fullUrl = target.startsWith('http') ? target : `https://${target}`
      console.log(`\n${flags['no-wait'] ? glyph.info : glyph.ok} ${flags['no-wait'] ? 'scheduled URL (readiness unverified)' : c.green('live')}  ${c.bold(c.cyan(fullUrl))}`)
    }

    const last = deployed[deployed.length - 1]?.service
    if (last) {
      console.log(c.dim(`\n  fleet open ${last.name}   open in browser`))
      console.log(c.dim(`  fleet logs ${last.name}   follow logs`))
      console.log(c.dim(`  fleet down ${last.name}   tear down`))
    }
  },
}

/**
 * Deploy one service: upload its build context if it has one, run the deploy,
 * and wait for it to report running.
 */
async function deployOne(
  service: Service,
  opts: {
    fleetId: string
    gitSha?: string
    buildContext?: string
    wait: boolean
    rootDir: string
    /** `--node`: deploy every service here, or say why one cannot go. */
    node?: string
  }
): Promise<string | null> {
  let contextId: string | undefined
  if (opts.buildContext) {
    const dir = join(opts.rootDir, opts.buildContext)
    const uploaded = await task(
      `packaging ${c.bold(service.name)}`,
      async () => uploadContext(service.id, dir),
      { done: (r) => `uploaded ${humanBytes(r.bytes)} of build context` }
    )
    contextId = uploaded.contextId
  }

  const deployResult = await withLadder(
    DEPLOY_STEPS,
    async (ladder) => {
      const walker = phaseWalker(ladder)
      {
        const result = (
          await request<{
            deployment: { id: string }
            placedOn: { name: string }
            score: number
            url: string | null
            warnings: string[]
          }>('POST', `/services/${service.id}/deploy`, {
            body: { gitSha: opts.gitSha, contextId, ...(opts.node ? { node: opts.node } : {}) },
          })
        ).body
        // Deliberately not walker.finish().
        //
        // The control plane answers as soon as a node is chosen and builds
        // afterwards, so this response arrives before the build starts.
        // Finishing here marked build, push, schedule and container as "not
        // needed" — while the build ran for three minutes — and left a silent
        // counter that reads as a hang. The steps are real; only the reply is
        // early. Progress keeps driving the ladder until the phases are
        // genuinely done.
        if (opts.wait) {
          if (!result.deployment?.id) throw new CliError('The control plane did not return a deployment ID. Upgrade it before relying on deploy success.', EXIT.failure)
          await requireRunning(opts.fleetId, service.id, service.name, {
            deploymentId: result.deployment.id,
            onProgress: p => walker.apply(p),
          })
          walker.finish()
        } else ladder.note('Deployment accepted; readiness has not been verified.')
        return result
      }
    },
    {
      mark: false,
      title: `deploying ${service.name}`,
      onCancel: `deploy is still running on the control plane; inspect with fleet deployments ${service.name}`,
    }
  )

  for (const w of deployResult.warnings ?? []) {
    console.log(`${glyph.warn} ${c.yellow('warning')}  ${w}`)
  }

  return deployResult.url
}
