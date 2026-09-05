import { request, requireFleet } from '../api.js'
import { c } from '../render.js'
import { glyph, rule } from '../ui.js'
import { confirm } from '../prompt.js'
import { editManifest, type ManifestEdit } from '../manifest-edit.js'
import {
  asQuantity,
  tuneHealth,
  tuneRam,
  MIN_OBSERVATION_HOURS,
  type Observed,
} from '../tune.js'
import type { Flags } from '../args.js'

type Service = Observed & { id: string }

/**
 * The manifest, checked against what the services actually did.
 *
 * Two measured facts, in one place because they are the same kind of thing: a
 * number a repository could not have told anyone, that Fleet found out by
 * running the program. How much memory it uses, and which path it answers on.
 *
 * Both used to end as advice — a line telling the reader to go and edit
 * `fleet.yaml` themselves, about something this already knew. `--apply` writes
 * them, with a confirmation and through the same guarded editor `fleet fix`
 * uses.
 *
 * It proposes and it asks. Every number here is the system inferring something
 * about a machine, and the lesson of every inference this project has shipped
 * is that one leaving its evidence needs a person between it and the manifest —
 * a review once invented a node from a compose service name, and once replaced
 * a `build:` with `image: nginx:alpine` and served the welcome page over
 * somebody's site. Both were caught by a guardrail. A person reading a diff is
 * the cheapest guardrail there is.
 */
export const tuneCommand = {
  async run(_args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const { body } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)

    const advice = body.services.map((s) => tuneRam(s))
    const health = body.services.map((s) => tuneHealth(s)).filter((h) => h !== null)

    if (flags.json) return console.log(JSON.stringify({ fleetId, advice, health }, null, 2))

    console.log(`\n${rule('tune · the manifest against what was measured')}`)

    const advised = advice.filter((a) => a.verdict === 'advise')
    const tight = advice.filter((a) => a.verdict === 'tight')
    const waiting = advice.filter((a) => a.verdict === 'too-soon' || a.verdict === 'no-data')

    for (const a of advice) {
      if (a.verdict === 'advise') {
        console.log(
          `${glyph.warn} ${c.bold(a.name.padEnd(18))} reserves ${asQuantity(a.from)}, peaks at ${a.peak}MB` +
            ` → ${c.bold(asQuantity(a.to))}`
        )
      } else if (a.verdict === 'tight') {
        console.log(
          `${glyph.warn} ${c.bold(a.name.padEnd(18))} peaks at ${a.peak}MB of ${asQuantity(a.requestRamMb)}` +
            ` — close to its limit, which is also where the kernel kills it`
        )
      } else if (a.verdict === 'fits') {
        console.log(`${glyph.ok} ${c.bold(a.name.padEnd(18))} peaks at ${a.peak}MB — about right`)
      } else if (a.verdict === 'too-soon') {
        console.log(
          `${glyph.info} ${c.dim(a.name.padEnd(18))} ${c.dim(`watched for ${a.hours}h; needs ${MIN_OBSERVATION_HOURS}h`)}`
        )
      } else {
        console.log(`${glyph.info} ${c.dim(a.name.padEnd(18))} ${c.dim('not measured yet')}`)
      }
    }

    for (const h of health) {
      console.log(
        `${glyph.warn} ${c.bold(h.name.padEnd(18))} answers 2xx on ${c.bold(h.path)} but declares no health check`
      )
    }

    // One list, because to the manifest they are the same edit.
    const edits: ManifestEdit[] = [
      ...advised.flatMap((a) =>
        a.verdict === 'advise'
          ? [
              {
                service: a.name,
                field: 'resources',
                value: { ram: asQuantity(a.to), cpu: 0.5 },
                why: `peaks at ${a.peak}MB against ${asQuantity(a.from)} reserved`,
              },
            ]
          : []
      ),
      ...health.map((h) => ({
        service: h.name,
        field: 'health',
        value: { path: h.path },
        why: `measured answering 2xx on ${h.path}`,
      })),
    ]

    if (!edits.length && !tight.length) {
      console.log(
        `\n  ${c.dim(
          waiting.length === advice.length && !health.length
            ? 'Nothing has been watched long enough to advise on yet.'
            : 'Every measured setting is about right.'
        )}`
      )
      return console.log()
    }

    if (!edits.length) return console.log()

    if (!flags.apply) {
      console.log(`\n  ${c.dim('write these with')} fleet tune --apply`)
      for (const e of edits) {
        console.log(`  ${c.dim(`${e.service}:`)} ${e.field}: ${JSON.stringify(e.value)}`)
      }
      return console.log()
    }

    console.log()
    for (const e of edits) {
      console.log(`  ${e.service}.${e.field} → ${JSON.stringify(e.value)}  ${c.dim(e.why)}`)
    }

    if (!flags.yes && !flags.y) {
      const ok = await confirm(`\nWrite ${edits.length} change(s) to fleet.yaml?`)
      if (!ok) return console.log(`  ${c.dim('left alone')}\n`)
    }

    const { applied, refused } = await editManifest('fleet.yaml', edits)
    for (const r of refused) {
      console.log(`${glyph.warn} ${r.edit.service}.${r.edit.field} — ${r.reason}`)
    }
    if (applied.length) {
      console.log(`${glyph.ok} fleet.yaml updated — ${applied.length} change(s)`)
      // Not deployed here on purpose. `tune` changes settings that only take
      // effect on the next rollout, and quietly restarting somebody's fleet
      // because they asked for a manifest edit is a surprise nobody wants.
      console.log(`\n  ${c.dim('review it, then')} fleet up`)
    }
    console.log()
  },
}
