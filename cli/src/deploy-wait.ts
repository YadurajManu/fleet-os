/**
 * Waiting for a deploy to reach a terminal state, once, for every command.
 *
 * `fleet up` and `fleet deploy` both watched a deploy and drifted apart while
 * doing it. `up` was widened to 45 minutes when it took over the build, because
 * an arm64 image emulated on an amd64 control plane is measured in tens of
 * minutes. `deploy` kept a three-minute deadline nobody revisited.
 *
 * A real deploy of landing-page started at 15:44:54 and reported running at
 * 15:47:57 — 183 seconds. `fleet deploy` gave up at 181 and told the operator
 * the service "was scheduled but has not reported running", about a service
 * that was running. Two seconds of drift produced a false failure, and the
 * message sent somebody to debug a healthy container.
 *
 * So the deadline is one constant and the loop is one function. Two commands
 * waiting for the same thing in two places is how the drift happened, and
 * sharing the constant without sharing the loop would only slow it down.
 */
import { request, CliError, EXIT } from './api.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * How long a deploy may take before the CLI stops watching.
 *
 * Deliberately longer than the control plane's own BUILD_TIMEOUT_MS (20
 * minutes): the client must not call a deploy dead while the server is still
 * legitimately working on it. The server owns "this build is stuck"; this
 * number only owns "nobody is watching any more".
 */
export const DEPLOY_READY_TIMEOUT_MS = 45 * 60_000

export type DeployOutcome =
  | { state: 'running' }
  | { state: 'failed'; reason: string | null }
  | { state: 'timeout'; last: string | null; elapsedMs: number }

type ServiceRow = {
  id: string
  current?: { status?: string; failureReason?: string | null } | null
}

/**
 * How the waiter reads the service's status.
 *
 * Injectable so the deadline behaviour can be tested without a control plane —
 * the bug this file exists for is entirely about *when* the status is read, and
 * a test that cannot control the clock or the answers cannot pin it.
 */
export type ReadStatus = (
  fleetId: string,
  serviceId: string
) => Promise<{ status?: string; failureReason?: string | null } | null>

/** The service's current deployment status, or null when it cannot be read. */
const liveStatus: ReadStatus = (fleetId, serviceId) =>
  request<{ services: ServiceRow[] }>('GET', `/fleets/${fleetId}/services`)
    .then((r) => r.body.services.find((s) => s.id === serviceId)?.current ?? null)
    // Unreadable is not the same as failed: a blip must not end a deploy that
    // is going fine, so this reads as "no answer yet" and the loop continues.
    .catch(() => null)

/**
 * Wait until a service is running, has failed, or the deadline passes.
 *
 * Three behaviours the previous loops did not have:
 *
 * A service that is ALREADY running returns immediately. `fleet deploy` on an
 * unchanged service creates no new deployment, so waiting for a transition
 * meant waiting for something that could not happen.
 *
 * The deadline triggers one final authoritative read before failing. The bug
 * this file exists for was a state change three seconds the wrong side of the
 * deadline; a poll loop that gives up without looking one more time will always
 * be able to miss by a second.
 *
 * And a timeout is reported as a timeout, carrying the last status seen —
 * never as "has not reported running", which reads as a verdict on the service
 * rather than on the waiting.
 */
export async function waitForRunning(
  fleetId: string,
  serviceId: string,
  opts: {
    timeoutMs?: number
    /** Called with each poll, for the caller's own progress display. */
    onPoll?: (status: string | null, elapsedMs: number) => void | Promise<void>
    pollMs?: number
    read?: ReadStatus
  } = {}
): Promise<DeployOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEPLOY_READY_TIMEOUT_MS
  const pollMs = opts.pollMs ?? 2000
  const currentOf = opts.read ?? liveStatus
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let last: string | null = null

  // Before waiting at all. A deploy that changed nothing has nothing to wait
  // for, and the desired state is already the current one.
  const already = await currentOf(fleetId, serviceId)
  if (already?.status === 'running') return { state: 'running' }

  while (Date.now() < deadline) {
    await opts.onPoll?.(last, Date.now() - startedAt)

    const current = await currentOf(fleetId, serviceId)
    last = current?.status ?? last
    if (current?.status === 'running') return { state: 'running' }
    if (current?.status === 'failed') {
      return { state: 'failed', reason: current.failureReason ?? null }
    }

    await sleep(pollMs)
  }

  // One last look. The deadline is a decision to stop waiting, not evidence
  // about the service, and the two are only ever a poll interval apart.
  const settled = await currentOf(fleetId, serviceId)
  if (settled?.status === 'running') return { state: 'running' }
  if (settled?.status === 'failed') {
    return { state: 'failed', reason: settled.failureReason ?? null }
  }

  return { state: 'timeout', last: settled?.status ?? last, elapsedMs: Date.now() - startedAt }
}

/**
 * The same wait, as an exception for callers that want one.
 *
 * Keeps the outcome type available to anything that would rather branch than
 * catch, while giving the two commands the single line they had before.
 */
export async function requireRunning(
  fleetId: string,
  serviceId: string,
  name: string,
  opts: Parameters<typeof waitForRunning>[2] = {}
): Promise<void> {
  const outcome = await waitForRunning(fleetId, serviceId, opts)
  if (outcome.state === 'running') return

  if (outcome.state === 'failed') {
    throw new CliError(
      `"${name}" did not start${outcome.reason ? `: ${outcome.reason}` : '.'} ` +
        `\`fleet deployments ${name}\` has the reason.`,
      EXIT.healthCheckFailed
    )
  }

  const minutes = Math.round(outcome.elapsedMs / 60_000)
  throw new CliError(
    `Stopped watching "${name}" after ${minutes} minute${minutes === 1 ? '' : 's'}; ` +
      `it was last ${outcome.last ?? 'not reporting a status'}. The deploy may still be running — ` +
      `\`fleet deployments ${name}\` has the current state.`,
    EXIT.healthCheckFailed
  )
}
