import { readFile } from 'node:fs/promises'
import { request, requireFleet } from '../api.js'
import { loadProfile } from '../config.js'
import { c, table } from '../render.js'
import type { Flags } from '../args.js'

type Health = { status: string; version: string; revision?: string }
type Node = { name: string; agentVersion: string | null; live: boolean }
type Fleet = { agentAutoUpgrade: boolean }

export function nodeVersionLine(node: Node): string[] {
  return [node.name, node.agentVersion || 'not reported', node.live ? 'online' : 'offline · last reported']
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

    console.log(table(['component', 'installed', 'state'], [
      ['control plane', health?.revision || (profile.api ? 'unknown' : 'not configured'), health?.status || serverError || 'run fleet auth login'],
      ['CLI', local.version, 'on this computer'],
      ['agents', fleet ? `${nodes.filter((node) => node.live).length}/${nodes.length} online` : 'unknown', fleet ? `auto-upgrade ${fleet.agentAutoUpgrade ? 'on' : 'off'}` : nodeError || 'sign in to inspect'],
    ]))
    if (nodes.length) {
      console.log('\nnodes')
      console.log(table(['name', 'agent', 'heartbeat'], nodes.map(nodeVersionLine)))
    }
    console.log(`\n${c.dim('Server:')} run sudo ./deploy/upgrade.sh check on the Compose host; then sudo ./deploy/upgrade.sh apply.`)
    console.log(`${c.dim('CLI:')} npm install -g @yadurajfleetos/cli@latest`)
    console.log(`${c.dim('Agents:')} publish verified binaries, enable auto-upgrade for a canary fleet, and check fresh heartbeats.`)
    console.log(`${c.dim('Guide:')} https://github.com/YadurajManu/fleet-os/blob/main/docs/updates.md`)
  },
}
