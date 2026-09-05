import { CliError, EXIT, request, requireFleet } from '../api.js'
import { editManifest, restoreManifest } from '../manifest-edit.js'
import { localSource } from '../source.js'
import { checkEdit, applyEdit, revertEdit, type SourceEdit } from '../source-edit.js'
import { c } from '../render.js'
import { glyph, rule } from '../ui.js'
import { confirm } from '../prompt.js'
import { awaitRunning } from '../progress.js'
import type { Flags } from '../args.js'

/**
 * Diagnose, change one thing, deploy it, and put it back if that was worse.
 *
 * The loop can act here because it can undo. Every step is reversible: the
 * manifest edit is one field held in memory before it is written, and the
 * deploy that follows is a normal deploy, so a rollback is the same rollback
 * anybody else would run. Without that this would be a machine editing a
 * running system on the strength of a guess.
 *
 * It asks before applying. `--yes` skips the question for someone who wants it
 * unattended, and skips only the question -- the refusals below are not
 * confirmations and cannot be waived.
 */

type Fix = {
  service: string
  field: string
  value: string | number | boolean | null
  why: string
  applicable: boolean
  reason?: string
}

type Diagnosis =
  | {
      status: 'ok'
      summary: string
      findings: Array<{ claim: string; evidence: string }>
      next: string[]
      fix?: Fix
      edit?: SourceEdit
    }
  | { status: 'disabled'; reason: string }
  | { status: 'inconclusive'; reason: string }

type Service = { name: string; current: { status: string } | null }

/** How a manifest writes a value the model returned as a scalar. */
function shape(field: string, value: Fix['value']): unknown {
  // `health: /healthz` is the obvious way to say it and the manifest wants
  // `health: { path: /healthz }`. Same normalisation the server-side review
  // does, for the same reason: a difference in spelling should not cost a fix.
  if (field === 'health' && typeof value === 'string') return { path: value }
  return value
}

/** Whether a service is running right now, as the fleet sees it. */
async function statusOf(fleetId: string, name: string): Promise<string> {
  const { body } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
  return body.services.find((s) => s.name === name)?.current?.status ?? 'not running'
}

/**
 * Change one line of a service's source, deploy it, and put it back if that
 * made things worse.
 *
 * The furthest this reaches into somebody's work, so it is the most guarded
 * thing here. `checkEdit` refuses anything it could not undo — a file outside
 * the service's build context, one git does not track, one already carrying
 * uncommitted work, a line that is absent or appears twice — and the undo is
 * `git checkout`, which is exact rather than a best effort.
 */
async function applySourceEdit(fleetId: string, edit: SourceEdit, flags: Flags): Promise<void> {
  const root = process.cwd()
  const check = await checkEdit(root, edit)

  if (!check.ok) {
    console.log(`\n${glyph.warn} ${c.bold('This one has to be done by hand')}`)
    console.log(`  ${edit.service} · ${edit.file}`)
    console.log(`  ${c.dim(edit.why)}`)
    console.log(`  ${c.dim(check.reason)}`)
    return console.log()
  }

  console.log(`\n${glyph.info} ${c.bold('proposed')}  ${edit.file}:${check.line}  ${c.dim(edit.service)}`)
  console.log(`  ${c.dim('-')} ${edit.find.trim()}`)
  console.log(`  ${c.dim('+')} ${edit.replace.trim()}`)
  console.log(`  ${c.dim(edit.why)}\n`)

  if (!flags.yes && !flags.y) {
    const ok = await confirm(`Change this line and redeploy ${edit.service}?`)
    if (!ok) return console.log(`  ${c.dim('left alone')}\n`)
  }

  const wasRunning = (await statusOf(fleetId, edit.service)) === 'running'
  await applyEdit(check.path, edit)
  console.log(`${glyph.ok} ${edit.file} updated`)

  const { body: svc } = await request<{ services: Array<{ id: string; name: string }> }>(
    'GET',
    `/fleets/${fleetId}/services`
  )
  const target = svc.services.find((s) => s.name === edit.service)
  if (!target) {
    await revertEdit(root, check.path)
    console.log(`${glyph.warn} "${edit.service}" is not in this fleet — ${edit.file} put back\n`)
    return
  }

  console.log(`${glyph.pending} deploying…`)
  try {
    await request('POST', `/services/${target.id}/deploy`, { body: {} })
    await awaitRunning(target, { timeoutMs: 240_000 })
  } catch (err) {
    // Judged against where it started, like a manifest change: one already down
    // and still down has not been made worse, and reverting there would take
    // away a change that may well be right.
    if (wasRunning) {
      await revertEdit(root, check.path)
      console.log(`${glyph.warn} ${edit.service} was running before and did not come back — ${edit.file} put back`)
      console.log(`  ${c.dim(`Deploy the previous source with: fleet up ${edit.service}`)}\n`)
      return
    }
    console.log(`${glyph.warn} still not running — ${(err as Error).message}`)
    console.log(`  ${c.dim('The edit was kept: it was already down, so this did not make it worse.')}`)
    console.log(`  ${c.dim(`undo it with: git checkout ${edit.file} && fleet up ${edit.service}`)}\n`)
    return
  }

  console.log(`${glyph.ok} ${edit.service} is running`)
  console.log(`\n  ${c.dim('review the change:')} git diff`)
  console.log(`  ${c.dim('undo it:')} git checkout ${edit.file} && fleet up ${edit.service}\n`)
}

export const fixCommand = {
  async run(args: string[], flags: Flags) {
    const service = args[0]
    if (!service) throw new CliError('usage: fleet fix <service> [--yes]', EXIT.usage)

    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)

    console.log(`\n${rule(`fix · ${service}`)}`)
    console.log(`${glyph.pending} looking…`)

    // Source travels with the question. `fix` already requires a project
    // directory, so the files are right here — and the control plane, which
    // deletes every build context the moment a build ends, never has to hold
    // any of it.
    const source = await localSource(process.cwd())

    const { body: found } = await request<Diagnosis>('POST', `/fleets/${fleetId}/diagnose`, {
      body: {
        question: `Why is the "${service}" service not working as it should?`,
        ...(Object.keys(source).length ? { source } : {}),
      },
    })

    if (found.status !== 'ok') {
      throw new CliError(
        found.status === 'disabled' ? found.reason : `inconclusive — ${found.reason}`,
        EXIT.failure
      )
    }

    console.log(`\n${found.summary}\n`)
    for (const f of found.findings) {
      console.log(`  ${c.bold(f.claim)}`)
      console.log(`    ${c.dim(f.evidence)}`)
    }

    // A source edit, when the manifest cannot carry the change.
    //
    // Offered only after the manifest options are exhausted: a manifest is
    // Fleet's to alter and a repository is not, so the same fault fixed either
    // way should be fixed in the manifest.
    if (!found.fix && found.edit) {
      return await applySourceEdit(fleetId, found.edit, flags)
    }

    const fix = found.fix
    if (!fix) {
      // Most investigations do not end in one exact manifest change, and this
      // is not a failure. Saying what was found and stopping is the answer.
      console.log(`\n  ${c.dim('No single manifest change would fix this. What to do:')}`)
      for (const n of found.next) console.log(`  ${c.dim('›')} ${n}`)
      console.log()
      return
    }

    if (!fix.applicable) {
      // Reported in words, never performed. A person clicking through a prompt
      // is not a guardrail; not offering the button is.
      console.log(`\n${glyph.warn} ${c.bold('This one has to be done by hand')}`)
      console.log(`  ${fix.service}.${fix.field} → ${JSON.stringify(fix.value)}`)
      console.log(`  ${c.dim(fix.why)}`)
      console.log(`  ${c.dim(fix.reason ?? '')}`)
      console.log()
      return
    }

    console.log(`\n${glyph.info} ${c.bold('proposed')}  ${fix.service}.${fix.field} → ${JSON.stringify(fix.value)}`)
    console.log(`  ${c.dim(fix.why)}\n`)

    if (!flags.yes && !flags.y) {
      const ok = await confirm(`Apply this to fleet.yaml and redeploy ${fix.service}?`)
      if (!ok) return console.log(`  ${c.dim('left alone')}\n`)
    }

    // Read before writing, and keep the original in memory: this is what makes
    // the change reversible without a second file on disk.
    //
    // The same editor `fleet tune` uses. Two implementations of "write one
    // field into fleet.yaml" would drift — one would learn to keep the comments
    // and the other would not, and nobody would notice until a manifest came
    // back stripped of the only explanation it carried.
    const path = 'fleet.yaml'
    const wasRunning = (await statusOf(fleetId, fix.service)) === 'running'

    const { applied, refused, before } = await editManifest(path, [
      { service: fix.service, field: fix.field, value: shape(fix.field, fix.value), why: fix.why },
    ])

    if (!applied.length) {
      throw new CliError(
        refused[0]?.reason ?? `nothing could be applied to ${path}`,
        EXIT.failure
      )
    }
    console.log(`${glyph.ok} fleet.yaml updated`)

    const restore = async (why: string) => {
      await restoreManifest(path, before)
      console.log(`${glyph.warn} ${why} — fleet.yaml put back`)
      console.log(`  ${c.dim(`Deploy the previous manifest with: fleet up ${fix.service}`)}\n`)
    }

    console.log(`${glyph.pending} deploying…`)

    const { body: svc } = await request<{ services: Array<{ id: string; name: string }> }>(
      'GET',
      `/fleets/${fleetId}/services`
    )
    const target = svc.services.find((s) => s.name === fix.service)
    if (!target) {
      await restore(`"${fix.service}" is not in this fleet`)
      return
    }

    // Verification, and the reason the whole thing is defensible at all: a
    // change that did not help is undone rather than left behind.
    //
    // Followed to a conclusion rather than read once. The deploy request
    // returns when a node has been chosen, and the container starting is the
    // agent's job afterwards -- so reading the status here would find
    // "deploying" and call that success, which is a verification step that
    // verifies nothing.
    //
    // Judged against where it started. A service that was already down and is
    // still down has not been made worse by this edit, and putting the
    // manifest back would take away a change that may well be right while
    // leaving the real problem in place.
    try {
      await request('POST', `/services/${target.id}/deploy`, { body: {} })
      await awaitRunning(target, { timeoutMs: 240_000 })
    } catch (err) {
      if (wasRunning) {
        await restore(`${fix.service} was running before and did not come back: ${(err as Error).message}`)
        return
      }
      console.log(`${glyph.warn} still not running — ${(err as Error).message}`)
      console.log(`  ${c.dim('The edit was kept: it was already down, so this did not make it worse.')}`)
      console.log(`  ${c.dim(`undo it with: git checkout fleet.yaml && fleet up ${fix.service}`)}\n`)
      return
    }

    console.log(`${glyph.ok} ${fix.service} is running`)
    console.log(`\n  ${c.dim('check it settled:')} fleet deployments ${fix.service}`)
    console.log(`  ${c.dim('undo it:')} git checkout fleet.yaml && fleet up ${fix.service}\n`)
  },
}
