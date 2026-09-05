import type { Service } from '../lib/api'

/**
 * What a service reserved against what it actually used, and what it answers on.
 *
 * Both are facts no repository could have supplied. `fleet init` writes
 * `ram: 512Mi` because 512Mi is a round number, and the scheduler plans
 * capacity around that figure for the life of the service — on this fleet,
 * 512Mi reserved against a steady 60MB. The gap is invisible on one node and is
 * the difference between a service fitting and `no_eligible_node` on a fleet
 * where it matters.
 *
 * The CLI has said all of this since `fleet tune` existed. Nothing in the
 * dashboard did, which meant the one view people actually keep open was the one
 * that could not tell them.
 */

/** Megabytes as the manifest writes them, so the number is one you can paste. */
function quantity(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024}Gi` : `${mb}Mi`
}

/**
 * The reservation, with the measured peak drawn inside it.
 *
 * Deliberately one bar rather than two. The story is a proportion — how much of
 * what was set aside is ever touched — and two bars side by side make a reader
 * do that division themselves.
 */
export function Reservation({ service }: { service: Service }) {
  const reserved = service.requestRamMb
  const peak = service.observedRamPeakMb

  if (peak === null) {
    // Not measured is not zero, and must not draw as an empty bar: an empty bar
    // says "uses nothing", which is a claim, and a false one.
    return (
      <span className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
        {quantity(reserved)} reserved · not measured yet
      </span>
    )
  }

  const ratio = reserved > 0 ? Math.min(1, peak / reserved) : 0
  // Tight enough to matter: the reservation is also the container's hard limit,
  // so a service near it is one spike from being killed. That is the warning,
  // and it is a different thing from wasting room.
  const tight = ratio >= 0.8
  const wasteful = ratio < 0.35

  return (
    <span className="flex items-center gap-2.5">
      <span className="relative h-[3px] flex-1 bg-[var(--color-line)]">
        <span
          className="block h-full transition-[width] duration-700"
          style={{
            width: `${Math.max(2, ratio * 100)}%`,
            background: tight ? 'var(--color-warn)' : 'var(--color-signal-dim)',
          }}
        />
      </span>
      <span
        className="tabular w-[136px] shrink-0 whitespace-nowrap text-right font-mono text-[10px]"
        style={{ color: tight || wasteful ? 'var(--color-fg-muted)' : 'var(--color-fg-dim)' }}
        title={
          tight
            ? 'Close to its limit, which is also where the kernel kills it.'
            : wasteful
              ? 'Most of this reservation is never used; the scheduler still plans around it.'
              : undefined
        }
      >
        {peak}MB of {quantity(reserved)}
        {tight ? ' · tight' : wasteful ? ' · roomy' : ''}
      </span>
    </span>
  )
}

/**
 * The health path the node found, for a service that declares none.
 *
 * Three states, and the difference between the last two is the whole point:
 * a service nobody has swept, and one swept where nothing answered. The second
 * is a finding — true of an API behind a route prefix — and reporting it as
 * "unknown" would throw away the only work that established it.
 */
export function HealthPath({ service }: { service: Service }) {
  if (!service.healthDisabled) {
    return (
      <span className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
        {service.healthCheckPath ?? '/'}
        <span className="ml-1.5 text-[var(--color-fg-dim)]">declared</span>
      </span>
    )
  }

  const found = service.discoveredHealth
  if (!found) {
    return <span className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">not swept yet</span>
  }

  const answering = found.find((c) => c.status >= 200 && c.status < 400)
  if (!answering) {
    return (
      <span
        className="font-mono text-[10.5px] text-[var(--color-fg-dim)]"
        title={`Tried ${found.map((c) => `${c.path} → ${c.status || 'no answer'}`).join(', ')}`}
      >
        nothing answered · container state decides
      </span>
    )
  }

  return (
    <span
      className="font-mono text-[10.5px] text-[var(--color-signal)]"
      title="Measured by the node. Add it to fleet.yaml with `fleet tune --apply`."
    >
      answers {answering.path}
      <span className="ml-1.5 text-[var(--color-fg-dim)]">undeclared</span>
    </span>
  )
}
