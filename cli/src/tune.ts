/**
 * What a service should reserve, from what it has been seen using.
 *
 * `fleet init` writes `resources: { ram: 512Mi }` because 512Mi is a round
 * number and nothing in a repository says otherwise. Measured on the fleet this
 * was written for: a steady 60MB and 20MB against exactly that reservation. The
 * scheduler plans capacity around the number in the manifest for the life of
 * the service, so the gap is invisible on one node and is the difference
 * between a service fitting and `no_eligible_node` on a fleet where it matters.
 *
 * The judgement lives here rather than in the command so both outcomes can be
 * tested without a control plane — and the outcome that matters is the refusal,
 * which a fleet with weeks of history never produces.
 */

export type Candidate = { path: string; status: number; bytes: number }

export type Observed = {
  name: string
  requestRamMb: number
  observedRamPeakMb: number | null
  observedRamSince: string | null
  /** What the node found when it asked which paths this answers. */
  discoveredHealth?: Candidate[] | null
  /** Whether the manifest says container state alone decides. */
  healthDisabled?: boolean
}

export type Advice =
  | { verdict: 'advise'; name: string; from: number; to: number; peak: number }
  /** Measured, and the reservation is already about right. */
  | { verdict: 'fits'; name: string; peak: number }
  /** Close enough to the limit that shrinking it would be the wrong move. */
  | { verdict: 'tight'; name: string; peak: number; requestRamMb: number }
  | { verdict: 'too-soon'; name: string; hours: number }
  | { verdict: 'no-data'; name: string }

/**
 * How long a service must have been watched before its peak means anything.
 *
 * A service observed for four minutes has not been observed; it has been
 * glanced at. Nothing that runs a nightly job, or serves a morning, has shown
 * its peak yet, and advising a reservation from that is how a tuned fleet
 * starts OOM-killing at 3am.
 */
export const MIN_OBSERVATION_HOURS = 24

/**
 * Headroom over the observed peak.
 *
 * Double, which is generous, and deliberately so. The cost of too much headroom
 * is capacity the scheduler reserves and does not use; the cost of too little
 * is the kernel killing a container in production. Those are not symmetric, and
 * a tool that trims to the bone the first time it is run does not get run twice.
 */
const HEADROOM = 2

/** Reservations are read by people. 118 is a measurement; 128 is a decision. */
function round(mb: number): number {
  const steps = [64, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096]
  return steps.find((s) => s >= mb) ?? Math.ceil(mb / 1024) * 1024
}

export function tuneRam(svc: Observed, now: number = Date.now()): Advice {
  if (svc.observedRamPeakMb === null || !svc.observedRamSince) {
    return { verdict: 'no-data', name: svc.name }
  }

  const hours = (now - new Date(svc.observedRamSince).getTime()) / 3_600_000
  if (hours < MIN_OBSERVATION_HOURS) {
    return { verdict: 'too-soon', name: svc.name, hours: Math.max(0, Math.round(hours * 10) / 10) }
  }

  const peak = svc.observedRamPeakMb

  // Near its limit. Not a saving, and worth saying out loud: the reservation is
  // also the container's hard limit, so a service peaking at four fifths of it
  // is one traffic spike from being killed.
  if (peak >= svc.requestRamMb * 0.8) {
    return { verdict: 'tight', name: svc.name, peak, requestRamMb: svc.requestRamMb }
  }

  const want = round(peak * HEADROOM)
  if (want >= svc.requestRamMb) return { verdict: 'fits', name: svc.name, peak }

  return { verdict: 'advise', name: svc.name, from: svc.requestRamMb, to: want, peak }
}

/** Megabytes as a manifest writes them. */
export function asQuantity(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024}Gi` : `${mb}Mi`
}


/**
 * The health check a service should declare, from what it was measured
 * answering.
 *
 * The gap this closes: the node sweeps candidate paths after every deploy and
 * records exactly which ones returned 2xx, and until now that reached one line
 * of advice telling a person to go and type it into the manifest. Fleet knew
 * the answer and asked for it back.
 *
 * Only for a service that declares no check. One that declares a path has an
 * operator's decision behind it, and overwriting that with a measurement would
 * be the tool deciding it knows better about a choice it cannot see the reason
 * for.
 */
export function tuneHealth(svc: Observed): { name: string; path: string } | null {
  if (!svc.healthDisabled) return null
  if (!svc.discoveredHealth?.length) return null

  // The first 2xx-3xx, in the order the node tried them: a dedicated endpoint
  // before "/", because a check that renders the whole application every ten
  // seconds is the worse of two working answers.
  const path = svc.discoveredHealth.find((c) => c.status >= 200 && c.status < 400)?.path
  return path ? { name: svc.name, path } : null
}
