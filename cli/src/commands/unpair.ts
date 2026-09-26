import { CliError, EXIT } from '../api.js'
import type { Flags } from '../args.js'
import { uninstallCommand } from './uninstall.js'

// Keep the old spelling, with the same complete cleanup rather than the old
// Windows process kill that allowed the FleetAgent service to restart.
export const unpairCommand = uninstallCommand

export const agentCommand = {
  async run(args: string[], flags: Flags) {
    if (args[0] === 'unpair' || args[0] === 'uninstall') return uninstallCommand.run(args.slice(1), flags)
    throw new CliError('usage: fleet agent uninstall [--force] [--purge-data] [--stop-docker]', EXIT.usage)
  },
}
