import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c, table, statusColour, relativeTime, mb } from '../render.js'
import type { Flags } from '../args.js'
import { pairNode } from '../pairing.js'

type Node = {
  id: string
  name: string
  arch: string
  status: string
  ramMb: number
  cpuCores: number
  reliabilityTier: string
  live: boolean
  lastHeartbeatAt: string | null
  telemetry: { cpuPct: number; ramUsedMb: number; containers: Array<{ name: string }> } | null
}

export const nodesCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [sub, target] = args

    if (!sub || sub === 'ls' || sub === 'list') {
      const { body } = await request<{ nodes: Node[] }>('GET', `/fleets/${fleetId}/nodes`)
      if (flags.json) return console.log(JSON.stringify(body.nodes, null, 2))
      if (!body.nodes.length) {
        console.log('No nodes yet. Run `fleet nodes pair` to add one.')
        return
      }
      console.log(
        table(
          ['name', 'arch', 'tier', 'cpu', 'ram', 'services', 'seen', 'status'],
          body.nodes.map((n) => [
            n.name,
            n.arch,
            n.reliabilityTier,
            n.telemetry ? `${Math.round(n.telemetry.cpuPct)}%` : c.dim('—'),
            n.telemetry ? `${mb(n.telemetry.ramUsedMb)}/${mb(n.ramMb)}` : mb(n.ramMb),
            String(n.telemetry?.containers.length ?? 0),
            relativeTime(n.lastHeartbeatAt),
            statusColour(n.status),
          ])
        )
      )
      return
    }

    if (sub === 'pair') {
      return pairNode(fleetId, flags)
    }

    if (sub === 'cordon' || sub === 'uncordon') {
      if (!target) throw new CliError(`usage: fleet nodes ${sub} <name>`, EXIT.usage)
      const node = await findNode(fleetId, target)
      await request('POST', `/fleets/${fleetId}/nodes/${node.id}/cordon`, {
        body: { cordoned: sub === 'cordon' },
      })
      console.log(
        sub === 'cordon'
          ? `${node.name} cordoned — running services stay put, nothing new is scheduled here`
          : `${node.name} is schedulable again`
      )
      return
    }

    if (sub === 'rm' || sub === 'remove') {
      if (!target) throw new CliError('usage: fleet nodes rm <name>', EXIT.usage)
      const node = await findNode(fleetId, target)
      if (!flags.force && !flags.f) {
        throw new CliError(
          `This revokes ${node.name}'s credentials and removes it from the fleet.\n` +
            `  Anything pinned to it will have nowhere to run. Re-run with --force if that is intended.`,
          EXIT.usage
        )
      }
      const { body } = await request<{
        removed: { id: string; name: string }
        evicted: Array<{ service: string; action: string; toNodeName?: string; reason?: string }>
        tunnelClosed: boolean
      }>('DELETE', `/fleets/${fleetId}/nodes/${node.id}`)

      if (flags.json) return console.log(JSON.stringify(body, null, 2))

      console.log(`${node.name} removed and its agent credentials revoked`)
      for (const e of body.evicted ?? []) {
        if (e.action === 'moved') {
          console.log(c.dim(`  ${e.service} → ${e.toNodeName ?? 'another node'}`))
        } else {
          // Pinned and stranded services need saying out loud: the node is
          // gone and these did not find a new home.
          console.log(c.yellow(`  ${e.service} could not move — ${e.reason ?? e.action}`))
        }
      }
      console.log(
        c.dim(
          `  To clean up that machine itself, run ` +
            `${c.cyan('fleet unpair')}${c.dim(' on it.')}`
        )
      )
      return
    }

    throw new CliError('usage: fleet nodes [ls|pair|cordon|uncordon|rm]', EXIT.usage)
  },
}

/** Names are what people type; ids are what the API wants. */
async function findNode(fleetId: string, name: string): Promise<Node> {
  const { body } = await request<{ nodes: Node[] }>('GET', `/fleets/${fleetId}/nodes`)
  const match = body.nodes.find((n) => n.name === name || n.id === name || n.id.startsWith(name))
  if (!match) {
    throw new CliError(
      `No node called "${name}". Known nodes: ${body.nodes.map((n) => n.name).join(', ') || 'none'}`,
      EXIT.usage
    )
  }
  return match
}

export { findNode }
