import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CliError, EXIT, requireFleet, request } from '../api.js'
import { loadProfile } from '../config.js'
import { canPrompt } from '../prompt.js'
import { c } from '../render.js'
import type { Flags } from '../args.js'
import { authCommand } from './auth.js'
import { pairNode } from '../pairing.js'
import { upCommand } from './up.js'

const SAMPLE_MANIFEST = `fleet: quickstart

services:
  hello:
    image: nginx:1.27-alpine
    placement: flexible
    container_port: 80
    resources: { ram: 128Mi, cpu: 0.2 }
    health: { path: / }
`

export const quickstartCommand = {
  async run(args: string[], flags: Flags) {
    if (args.length) throw new CliError('usage: fleet quickstart [--fleet <id>] [--target windows|macos|linux|git-bash]', EXIT.usage)
    if (!canPrompt() || flags.json) {
      throw new CliError('fleet quickstart needs an interactive terminal. Run it directly in your terminal, not in a script or with --json.', EXIT.usage)
    }

    const projectDir = join(process.cwd(), 'fleet-quickstart')
    try {
      await access(projectDir)
      throw new CliError(`${projectDir} already exists. To continue that sample, run fleet up from inside it; quickstart will not overwrite files.`, EXIT.usage)
    } catch (err) {
      if (err instanceof CliError) throw err
    }

    console.log(`${c.bold('Fleet quickstart')} will sign in, connect a machine if needed, and deploy an Nginx sample in ${projectDir}.`)
    const profile = await loadProfile()
    if (!profile.accessToken) await authCommand.run(['login'], flags)

    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const { body } = await request<{ nodes: Array<{ live: boolean }> }>('GET', `/fleets/${fleetId}/nodes`)
    if (flags.target || !body.nodes.some((node) => node.live)) {
      console.log(`\n${flags.target ? `Pairing a ${flags.target} machine.` : 'No online machine is connected. Pair one now.'} Run the printed one-time command on the target machine while this command waits.`)
      await pairNode(fleetId, flags)
    } else {
      console.log('\nUsing an online machine already connected to this fleet.')
    }

    await mkdir(projectDir)
    await writeFile(join(projectDir, 'fleet.yaml'), SAMPLE_MANIFEST, { flag: 'wx' })
    console.log(`\n${c.green('created')} ${join(projectDir, 'fleet.yaml')}`)
    await upCommand.run([], { ...flags, dir: projectDir, file: join(projectDir, 'fleet.yaml'), 'no-wait': false })
  },
}
