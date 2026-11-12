import { readFile } from 'node:fs/promises'
import { request, requireFleet } from '../api.js'
import { loadProfile } from '../config.js'
import { c, table, section, statusBadge, terminalLink } from '../render.js'
import type { Flags } from '../args.js'

type Health = { status: string; version: string; revision?: string }
type Node = { name: string; agentVersion: string | null; live: boolean; agentAutoUpgrade: boolean | null }
type Fleet = { agentAutoUpgrade: boolean }

export function nodeVersionLine(node: Node, fleetPolicy = false): string[] {
  return [
    node.name,
    node.agentVersion || 'not reported',
    node.live ? 'online' : 'offline · last reported',
    node.agentAutoUpgrade == null ? `inherit · ${fleetPolicy ? 'on' : 'off'}` : node.agentAutoUpgrade ? 'on · canary' : 'off · paused',
  ]
}

export const updatesCommand = {
  async run(_args: string[], flags: Flags) {
    const local = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
    const profile = await loadProfile()
    let health: Health | null = null
    let serverError: string | null = null
    if (profile.api) {
      try {
        health = (await request<Health>('GET', '/healthz', { auth: false })).body
      } catch {
        serverError = 'unreachable'
      }
    }

    let fleet: Fleet | null = null
    let nodes: Node[] = []
    let nodeError: string | null = null
    if (profile.accessToken) {
      try {
        const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
        ;[fleet, nodes] = await Promise.all([
          request<{ fleet: Fleet }>('GET', `/fleets/${fleetId}`).then((res) => res.body.fleet),
          request<{ nodes: Node[] }>('GET', `/fleets/${fleetId}/nodes`).then((res) => res.body.nodes),
        ])
      } catch {
        nodeError = 'could not read fleet; check login and server access'
      }
    }

    if (flags.json) {
      console.log(JSON.stringify({ controlPlane: health, serverError, cli: local.version, agentAutoUpgrade: fleet?.agentAutoUpgrade ?? null, nodes, nodeError }, null, 2))
      return
    }

    console.log(`${section('Versions')}\n${table(['component', 'installed', 'state'], [
      ['control plane', health?.revision || (profile.api ? 'unknown' : 'not configured'), statusBadge(health?.status || serverError || 'not configured')],
      ['CLI', local.version, `${statusBadge('online')} local`],
      ['agents', fleet ? `${nodes.filter((node) => node.live).length}/${nodes.length} online` : 'unknown', fleet ? `auto-upgrade ${fleet.agentAutoUpgrade ? 'on' : 'off'}` : nodeError || 'sign in to inspect'],
    ], { priorities: [0, 2, 0] })}`)
    if (nodes.length) {
      console.log(`\n${section('Agents')}\n${table(['node', 'agent', 'heartbeat', 'auto-upgrade'], nodes.map((node) => {
        const [name, version, heartbeat, policy] = nodeVersionLine(node, fleet?.agentAutoUpgrade)
        return [name!, version!, statusBadge(node.live ? 'online' : 'offline'), policy!]
      }), { priorities: [0, 2, 0, 3] })}`)
    }
    console.log(`\n${section('Upgrade steps')}`)
    console.log(`${c.dim('Server')}  ${c.cyan('sudo ./deploy/upgrade.sh check')} then ${c.cyan('sudo ./deploy/upgrade.sh apply')}`)
    console.log(`${c.dim('CLI')}     ${c.cyan('npm install -g @yadurajfleetos/cli@latest')}`)
    console.log(`${c.dim('Agents')}  publish verified binaries, enable auto-upgrade for a canary fleet, then check fresh heartbeats.`)
    console.log(`${c.dim('Guide')}   ${terminalLink('updates documentation', 'https://github.com/YadurajManu/fleet-os/blob/main/docs/updates.md')}`)
  },
}
