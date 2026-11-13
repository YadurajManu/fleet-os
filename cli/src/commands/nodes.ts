import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c, table, glyphs, statusBadge, relativeTime, memoryPair, loadBar } from '../render.js'
import type { Flags } from '../args.js'
import { pairNode } from '../pairing.js'

type Node = {
  id: string
  name: string
  arch: string
  status: string
  schedulable?: boolean
  ramMb: number
  effectiveMemBytes?: number | null
  cpuCores: number
  reliabilityTier: string
  live: boolean
  platform?: string | null
  canBuild?: boolean
  effectiveCpu?: number | null
  agentAutoUpgrade: boolean | null
  lastHeartbeatAt: string | null
  telemetry: { cpuPct: number; ramUsedMb: number; containers: Array<{ name: string }>; ageMs?: number } | null
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
          ['node', 'platform', 'role', 'load', 'memory', 'runs', 'seen', 'status'],
          body.nodes.map((n) => {
            const memoryTotal = n.effectiveMemBytes ? n.effectiveMemBytes / 1048576 : n.ramMb
            const memory = n.live && n.telemetry && n.telemetry.ramUsedMb <= memoryTotal
              ? memoryPair(Math.max(0, memoryTotal - n.telemetry.ramUsedMb), memoryTotal)
              : '—'
            return [
              `${n.live ? c.green(glyphs.online) : c.red(glyphs.fail)} ${n.name}${n.status === 'cordoned' ? ` ${c.yellow('[cordoned]')}` : ''}`,
              n.platform || `linux/${n.arch}`,
              n.canBuild ? 'builder' : n.reliabilityTier,
              n.live && n.telemetry ? loadBar(n.telemetry.cpuPct, (process.stdout.columns ?? 80) >= 100 ? 8 : 5) : '—',
              memory,
              n.live ? n.telemetry?.containers.map((container) => container.name).join(', ') || '—' : '—',
              relativeTime(n.lastHeartbeatAt),
              statusBadge(n.status === 'cordoned' ? 'cordoned' : n.live ? 'online' : 'offline'),
            ]
          }),
          { priorities: [0, 3, 6, 5, 4, 2, 7, 0] }
        )
      )
      return
    }

    if (sub === 'rename') {
      if (!target || !args[2]) throw new CliError('usage: fleet nodes rename <node> <new-name>', EXIT.usage)
      const node = await findNode(fleetId, target)
      const { body } = await request('PATCH', `/fleets/${fleetId}/nodes/${node.id}`, { body: { name: args[2] } })
      return console.log(flags.json ? JSON.stringify(body) : `${node.name} renamed to ${args[2]}; identity and service placement preserved\n${body.guidance ?? `Update node: ${node.name} to node: ${args[2]} in fleet.yaml before applying again. Rename back if you need to recover an unchanged manifest.`}`)
    }
    if (sub === 'pair') {
      return pairNode(fleetId, flags)
    }

    if (sub === 'upgrade') {
      const mode = args[2]
      if (!target || !['on', 'off', 'inherit'].includes(mode ?? '')) {
        throw new CliError('usage: fleet nodes upgrade <name> on|off|inherit', EXIT.usage)
      }
      const node = await findNode(fleetId, target)
      const enabled = mode === 'inherit' ? null : mode === 'on'
      await request('PATCH', `/fleets/${fleetId}/nodes/${node.id}/auto-upgrade`, { body: { enabled } })
      console.log(`${node.name}: agent auto-upgrade ${mode === 'inherit' ? 'inherits the fleet policy' : mode === 'on' ? 'enabled' : 'paused'}`)
      if (mode === 'on') console.log(c.dim('The node checks the control-plane-served checksums on its next desired-state poll. Verify its next heartbeat and version with fleet updates.'))
      return
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

    throw new CliError('usage: fleet nodes [ls|pair|rename|upgrade|cordon|uncordon|rm]', EXIT.usage)
  },
}

/** Names are what people type; ids are what the API wants. */
async function findNode(fleetId: string, name: string): Promise<Node> {
  const { body } = await request<{ nodes: Node[] }>('GET', `/fleets/${fleetId}/nodes`)
  const exact = body.nodes.find((n) => n.id === name) ?? body.nodes.find((n) => n.name === name)
  if (exact) return exact
  const candidates = name ? body.nodes.filter(n => n.id.startsWith(name)) : []
  if (candidates.length > 1) throw new CliError(`Node ID "${name}" is ambiguous. Use a full ID or exact name:\n${candidates.map(n => `  ${n.name} (${n.id})`).join('\n')}`, EXIT.usage)
  const match = candidates[0]
  if (!match) {
    throw new CliError(
      `No node called "${name}". Known nodes: ${body.nodes.map((n) => n.name).join(', ') || 'none'}`,
      EXIT.usage
    )
  }
  return match
}

export { findNode }
