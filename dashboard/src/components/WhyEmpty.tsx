import type { Node } from '../lib/api'

/**
 * Why a list is empty, when the fleet already knows.
 *
 * "No services in this fleet" is correct on a new fleet and wrong on a fleet
 * whose only node has Docker stopped — which is the state this was written in.
 * Both render identically today, so the dashboard tells somebody their fleet is
 * empty when what is true is that nothing can be scheduled onto it.
 *
 * That is the same class of mistake as an empty state shown during loading: a
 * statement about the fleet, made confidently, that happens to be false. The
 * Doctor page has known the difference all along; this asks it.
 *
 * Ordered by what blocks what. A fleet with no nodes cannot have an offline
 * one, and an offline node's Docker status is unknown rather than bad — so the
 * first true thing is the most fundamental one, and it is the only one worth
 * saying.
 */

export type Reason = {
  title: string
  hint: string
  /** True when the fleet is genuinely empty rather than blocked. */
  empty: boolean
}

export function whyEmpty(nodes: Node[] | undefined, subject: 'services' | 'deployments'): Reason {
  if (!nodes) {
    return {
      title: `No ${subject} in this fleet`,
      hint: 'Apply a fleet.yaml manifest to declare what should run.',
      empty: true,
    }
  }

  if (!nodes.length) {
    return {
      title: 'No machines paired yet',
      hint: `A fleet with no nodes has nowhere to put anything, so ${subject} would have nothing to run on. Pair a machine first with \`fleet nodes pair\`.`,
      empty: false,
    }
  }

  const live = nodes.filter((n) => n.live && n.status === 'online')
  if (!live.length) {
    const names = nodes.map((n) => n.name).join(', ')
    return {
      title: nodes.length === 1 ? `${names} is not reporting` : 'No node is reporting',
      // Deliberately not "your fleet is empty". What is true is that the
      // control plane cannot see the machines, and whatever is running on them
      // is invisible rather than absent.
      hint: `The control plane has not heard from ${nodes.length === 1 ? names : 'any node'} recently, so anything running there is invisible from here rather than gone. Start the agent and this fills in on its own.`,
      empty: false,
    }
  }

  const withoutDocker = live.filter((n) => !n.telemetry?.runtime?.dockerAvailable)
  if (withoutDocker.length === live.length) {
    const names = withoutDocker.map((n) => n.name).join(', ')
    return {
      title: `Docker is not running on ${names}`,
      hint: `The node is reporting, so Fleet can see it — but nothing can be scheduled onto a machine whose container runtime is down. Start Docker there and ${subject} will deploy normally.`,
      empty: false,
    }
  }

  return {
    title: `No ${subject} in this fleet`,
    hint:
      subject === 'services'
        ? 'Apply a fleet.yaml manifest to declare container workloads, ports, memory requirements, and placement rules.'
        : 'Deploys, failovers and reclaims all land here.',
    empty: true,
  }
}
