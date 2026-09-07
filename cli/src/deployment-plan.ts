/**
 * What `init` is about to write, as a value rather than as printed lines.
 *
 * `discover.ts` already establishes what a repository contains — frameworks,
 * ports, engines, environment variables, credentials, which engines each
 * service's own dependencies imply — and `manifestFromDiscovery` already turns
 * that into YAML. What sat between them was nothing: a file appeared, and the
 * reader had to read it to find out what had been decided for them.
 *
 * This is that middle step, and it is deliberately a plain data structure. A
 * plan that is a value can be asserted against without capturing stdout, and it
 * keeps presentation out of manifest generation — the two were about to grow
 * into each other.
 *
 * Named for the deployment rather than the manifest, because `plan.ts` already
 * exists and plans a different thing: it reads a finished manifest to work out
 * deploy order. This one runs earlier, over the discovery model, before a
 * manifest exists at all.
 *
 * It discovers nothing of its own. Every field is a projection of what
 * discovery already found, and where discovery could not establish something
 * this says so rather than filling it in.
 */
import type { Discovery } from './discover.js'

/**
 * How much weight a reader should give a line.
 *
 * The distinction is the point: a port read out of a Dockerfile and a RAM
 * figure chosen by a default are both numbers in the same column, and only one
 * of them is a fact about the project.
 */
export type Confidence = 'detected' | 'inferred' | 'recommended' | 'unknown'

export type PlanEntry = {
  name: string
  /** A database is pinned to a node and holds data; a service is neither. */
  kind: 'service' | 'database'
  /** The framework label discovery settled on, or the engine for a database. */
  what: string
  ramMb: number
  ramFrom: Confidence
  placement: 'flexible' | 'pinned'
  /** Only databases carry one, and only once it has been resolved. */
  node?: string
  nodeWhy?: string
  /** What this reaches for, from discovery's own engine matching. */
  dependsOn: string[]
  persistent: boolean
}

export type DeploymentPlan = {
  project: string
  entries: PlanEntry[]
  /** Names only. Values are never read into this process, let alone printed. */
  secrets: string[]
  totalRamMb: number
  /** Things a reader should know that the plan itself cannot express. */
  limits: string[]
}

/**
 * Project the discovery model onto the plan.
 *
 * Pure, and takes an already-resolved node rather than looking one up: node
 * selection talks to the control plane and belongs to the caller, which leaves
 * this testable without a fleet.
 */
export function planFromDiscovery(
  discovery: Discovery,
  opts: { project: string; node?: string; nodeWhy?: string }
): DeploymentPlan {
  const entries: PlanEntry[] = []

  for (const svc of discovery.services) {
    entries.push({
      name: svc.name,
      kind: 'service',
      what: svc.detection.label,
      ramMb: svc.ramMb,
      // Discovery sizes a GPU service differently and gives everything else one
      // default. That is a recommendation, not a measurement, and labelling it
      // otherwise would be the invented precision this plan exists to avoid.
      ramFrom: 'recommended',
      placement: 'flexible',
      // The engines this service's OWN dependencies imply. Discovery is already
      // careful here — a frontend beside a backend must not claim to use the
      // database — so this is a projection, not a second inference.
      dependsOn: discovery.databases.filter((d) => svc.engines.includes(d.engine)).map((d) => d.name),
      persistent: false,
    })
  }

  for (const db of discovery.databases) {
    entries.push({
      name: db.name,
      kind: 'database',
      what: db.engine,
      // Matches what `manifestFromDiscovery` writes, so the plan cannot
      // describe a manifest different from the one produced.
      ramMb: 512,
      ramFrom: 'recommended',
      placement: 'pinned',
      ...(opts.node ? { node: opts.node } : {}),
      ...(opts.nodeWhy ? { nodeWhy: opts.nodeWhy } : {}),
      dependsOn: [],
      // A database holds data by definition; that is why it is pinned at all.
      persistent: true,
    })
  }

  const limits: string[] = []
  if (discovery.databases.length) {
    // Answered honestly rather than invented. `volume:` names a volume and
    // `backup:` schedules a copy; neither carries a size, so a plan printing
    // "20 GB" would describe a field the manifest cannot hold.
    limits.push(
      'storage size: unknown — a manifest can name a volume and a backup schedule, but has no field for its size'
    )
  }

  return {
    project: opts.project,
    entries,
    secrets: [...new Set(discovery.services.flatMap((s) => s.secrets))].sort(),
    totalRamMb: entries.reduce((sum, e) => sum + e.ramMb, 0),
    limits,
  }
}

const size = (mb: number): string =>
  mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 2)} GiB` : `${mb} MiB`

/**
 * The plan as lines, for the terminal.
 *
 * Returns them rather than printing, so a test can read exactly what a user
 * would see.
 */
export function renderPlan(plan: DeploymentPlan): string[] {
  const out: string[] = [`Deployment plan · ${plan.project}`]

  const services = plan.entries.filter((e) => e.kind === 'service')
  const databases = plan.entries.filter((e) => e.kind === 'database')

  if (services.length) {
    out.push('', 'Services')
    for (const s of services) {
      out.push(`  ${s.name}  ${s.what} · ${size(s.ramMb)} · ${s.placement}`)
      if (s.dependsOn.length) out.push(`    uses ${s.dependsOn.join(', ')}`)
    }
  }

  if (databases.length) {
    out.push('', 'Databases')
    for (const d of databases) {
      // An unresolved node is stated, not hidden. It is the one thing that
      // stops the manifest deploying, and the reader should meet it here
      // rather than three commands later.
      const where = d.node ? `→ ${d.node}` : '→ no node chosen yet'
      out.push(`  ${d.name}  ${d.what} · ${size(d.ramMb)} · pinned ${where}`)
      if (d.nodeWhy) out.push(`    ${d.nodeWhy}`)
    }
  }

  if (plan.secrets.length) {
    out.push('', `Secrets · ${plan.secrets.length} required`)
    out.push(`  ${plan.secrets.join(', ')}`)
    out.push('  values are never read or written into the manifest')
  }

  out.push('', `Memory · ${size(plan.totalRamMb)} across ${plan.entries.length} containers`)
  out.push('  every figure is a starting point, not a measurement')

  for (const limit of plan.limits) out.push(`  ${limit}`)
  return out
}

/**
 * The plan as the assist endpoint accepts it.
 *
 * A deliberate subset. `ramFrom`, `nodeWhy` and `limits` exist to explain the
 * plan to a person and say nothing to a model that the other fields do not —
 * sending them would invite it to argue with a confidence label. What crosses
 * the wire is the facts themselves.
 *
 * Secrets cross as names, which is all this process ever held: discovery reads
 * variable names out of .env files and never their values, and the endpoint's
 * schema refuses anything else.
 */
export type AssistPlan = {
  project: string
  entries: Array<{
    name: string
    kind: 'service' | 'database'
    what: string
    ramMb: number
    placement: 'flexible' | 'pinned'
    node?: string
    dependsOn: string[]
    persistent: boolean
  }>
  secrets: string[]
}

export function toAssistPlan(plan: DeploymentPlan): AssistPlan {
  return {
    project: plan.project,
    entries: plan.entries.map((e) => ({
      name: e.name,
      kind: e.kind,
      what: e.what,
      ramMb: e.ramMb,
      placement: e.placement,
      ...(e.node ? { node: e.node } : {}),
      dependsOn: e.dependsOn,
      persistent: e.persistent,
    })),
    secrets: plan.secrets,
  }
}
