import { CliError, EXIT, requireFleet, streamRequest } from '../api.js'
import { findService } from './services.js'
import type { Flags } from '../args.js'

export const runCommand = {
  async run(args: string[], flags: Flags) {
    if (!args[0] || args[1] !== '--' || !args[2]) throw new CliError('usage: fleet run <service> [--timeout <seconds>] -- <command> [arguments...]', EXIT.usage)
    const seconds = flags.timeout === undefined ? 60 : Number(flags.timeout)
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new CliError('--timeout must be 1 to 600 seconds.', EXIT.usage)
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const service = await findService(fleetId, args[0], typeof flags.project === 'string' ? flags.project : undefined)
    const result = await streamRequest<never, { exitCode: number; output: string; error?: string }>('POST', `/services/${service.id}/tasks`, {
      body: { command: args.slice(2), timeoutMs: seconds * 1000 },
    })
    if (flags.json) console.log(JSON.stringify(result, null, 2))
    else {
      if (result.output) process.stdout.write(result.output + (result.output.endsWith('\n') ? '' : '\n'))
      if (result.error) console.error(result.error)
    }
    if (result.error || result.exitCode !== 0) process.exitCode = result.exitCode > 0 && result.exitCode < 256 ? result.exitCode : EXIT.failure
  },
}
