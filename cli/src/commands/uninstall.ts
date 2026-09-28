import { access, readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { request, CliError, EXIT } from '../api.js'
import type { Flags } from '../args.js'

const exec = promisify(execFile)
const win = process.platform === 'win32'
const mac = process.platform === 'darwin'
const label = 'fleet-os.managed=true'
type Identity = { node_id?: string; fleet_id?: string; name?: string }

async function exists(path: string) { try { await access(path); return true } catch { return false } }
async function run(file: string, ...args: string[]) {
  return (await exec(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout
}
const docker = (...args: string[]) => run('docker', ...args)
const lines = (s: string) => s.split(/\r?\n/).map(x => x.trim()).filter(Boolean)

export function dockerCleanupMessage(error: unknown) {
  const message = (error as Error).message
  return /failed to connect to the docker API|Cannot connect to the Docker daemon/i.test(message)
    ? 'Docker cleanup incomplete: start Docker Desktop, then rerun `fleet uninstall --force` to remove Fleet-labelled containers and networks.'
    : `Docker cleanup failed: ${message}`
}

export function stateDirs(home = homedir(), programData = process.env.ProgramData) {
  if (process.env.FLEET_STATE_DIR) return [resolve(process.env.FLEET_STATE_DIR)]
  if (win) return [...(programData ? [join(programData, 'FleetOS')] : []), join(home, '.fleet-os')]
  return [mac ? join(home, 'Library', 'Application Support', 'fleet-os') : '/var/lib/fleet-os']
}

async function installedService() {
  if (win) return run('sc.exe', 'query', 'FleetAgent').then(() => true, () => false)
  return exists(mac ? join(homedir(), 'Library', 'LaunchAgents', 'dev.fleet-os.agent.plist') : '/etc/systemd/system/fleet-agent.service')
}

async function stopAgent() {
  if (win) {
    if (await installedService()) {
      await run('sc.exe', 'config', 'FleetAgent', 'start=', 'disabled')
      await run('sc.exe', 'stop', 'FleetAgent').catch(() => {})
      for (let i = 0; i < 15; i++) {
        if (/STATE\s*:\s*1\s+STOPPED/.test(await run('sc.exe', 'query', 'FleetAgent'))) return
        await new Promise(done => setTimeout(done, 1000))
      }
      throw new Error('FleetAgent did not stop. No files or containers were removed.')
    }
    await run('taskkill.exe', '/IM', 'fleet-agent.exe', '/F').catch(() => {}) // legacy Git Bash install
  } else if (mac) {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'dev.fleet-os.agent.plist')
    if (await exists(plist)) {
      await run('launchctl', 'unload', plist)
      await rm(plist)
    }
  } else if (await installedService()) {
    await run('systemctl', 'disable', '--now', 'fleet-agent')
  }
}

async function removeService() {
  if (win && await installedService()) await run('sc.exe', 'delete', 'FleetAgent')
  else if (!win && !mac && await installedService()) {
    await rm('/etc/systemd/system/fleet-agent.service')
    await run('systemctl', 'daemon-reload')
  }
}

export function namedVolumes(mounts: Array<{ Type: string; Name?: string }>) {
  return mounts.filter(m => m.Type === 'volume' && m.Name).map(m => m.Name!)
}

async function mounts(id: string): Promise<string[]> {
  return namedVolumes(JSON.parse(await docker('inspect', '--format', '{{json .Mounts}}', id)) as Array<{ Type: string; Name?: string }>)
}

async function previewDocker(purge: boolean) {
  try {
    const names = lines(await docker('ps', '-a', '--filter', `label=${label}`, '--format', '{{.Names}}'))
    console.log(`Fleet containers: ${names.length ? names.join(', ') : 'none'}`)
    if (purge) {
      const ids = lines(await docker('ps', '-aq', '--filter', `label=${label}`))
      const volumes = new Set<string>()
      for (const id of ids) for (const name of await mounts(id)) volumes.add(name)
      console.log(`Candidate data volumes: ${volumes.size ? [...volumes].join(', ') : 'none'}`)
    }
  } catch { console.log('Docker resources: unavailable; cleanup will be reported as incomplete') }
}

async function cleanupDocker(purge: boolean) {
  // Buildx builders are managed separately from application containers.
  const builders = lines(await docker('buildx', 'ls', '--format', '{{.Name}}').catch(() => ''))
    .filter(name => /^fleet-[a-f0-9]{24}$/.test(name))
  for (const name of builders) await docker('buildx', 'rm', '--force', name)
  if (builders.length) console.log(`${builders.length} Fleet builder(s) removed`)
  const ids = lines(await docker('ps', '-aq', '--filter', `label=${label}`))
  const volumes = new Set<string>()
  if (purge) for (const id of ids) for (const name of await mounts(id)) volumes.add(name)
  if (ids.length) await docker('rm', '-f', ...ids)
  console.log(`${ids.length} Fleet container(s) removed`)
  const networks = lines(await docker('network', 'ls', '-q', '--filter', `label=${label}`))
  for (const id of networks) await docker('network', 'rm', id)
  console.log(`${networks.length} Fleet network(s) removed`)
  if (purge) {
    // Preserve any volume also mounted by an unrelated container.
    const others = lines(await docker('ps', '-aq', '--filter', `label!=${label}`))
    for (const id of others) for (const name of await mounts(id)) volumes.delete(name)
    for (const name of volumes) await docker('volume', 'rm', name)
    console.log(`${volumes.size} unshared Fleet volume(s) removed`)
  }
}

async function stopDocker() {
  if (lines(await docker('ps', '-q')).length) {
    console.log('Docker left running because other containers are active')
    return
  }
  if (win) {
    const cli = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'DockerCli.exe')
    if (!await exists(cli)) throw new Error('Docker Desktop shutdown tool not found; quit it from the tray')
    await run(cli, '-Shutdown')
  } else if (mac) await run('osascript', '-e', 'tell application "Docker" to quit')
  else await run('systemctl', 'stop', 'docker')
  console.log('Docker stopped')
}

async function confirm() {
  if (!process.stdin.isTTY) return false
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return (await rl.question('Uninstall Fleet from this machine? [y/N] ')).trim().toLowerCase() === 'y' }
  finally { rl.close() }
}

export const uninstallCommand = {
  async run(_args: string[], flags: Flags) {
    const dirs = stateDirs()
    let identity: Identity | null = null
    for (const dir of dirs) {
      const path = join(dir, 'agent.json')
      if (await exists(path)) { identity = JSON.parse(await readFile(path, 'utf8')) as Identity; break }
    }
    const service = await installedService()
    if (!identity && !service && !flags.force) throw new CliError('No local Fleet agent found. Use --force for a partial installation.', EXIT.usage)
    const purge = flags['purge-data'] === true
    console.log(`Fleet agent: ${identity?.name ?? 'local installation'}`)
    console.log(`Service: ${service ? 'installed' : 'not found'}`)
    console.log(`State: ${dirs.join(', ')}`)
    console.log('Fleet-labelled containers and networks will be removed. Application data and Docker are preserved by default.')
    if (purge) console.log('WARNING: --purge-data permanently removes unshared Fleet application volumes.')
    await previewDocker(purge)
    if (!flags.force && !flags.yes && !flags.y && !await confirm()) return

    // Disable the supervisor before revocation or container removal: it can restart Docker.
    await stopAgent()
    const problems: string[] = []
    if (identity?.node_id && identity.fleet_id) {
      try {
        await request('DELETE', `/fleets/${identity.fleet_id}/nodes/${identity.node_id}`)
        console.log('Node removed remotely and credential revoked')
      } catch (error) {
        problems.push(`Remote revocation failed: ${(error as Error).message}. From a signed-in machine run fleet nodes rm ${identity.name ?? '<node-name>'} --force.`)
      }
    }
    try { await cleanupDocker(purge) }
    catch (error) { problems.push(dockerCleanupMessage(error)) }
    await removeService()
    if (!win && !mac) await rm('/usr/local/bin/fleet-agent', { force: true })
    if (win) await rm(join(homedir(), 'bin', 'fleet-agent.exe'), { force: true })
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
    if (flags['stop-docker']) {
      try { await stopDocker() }
      catch (error) { problems.push(`Docker shutdown failed: ${(error as Error).message}`) }
    }
    console.log('Local Fleet agent removed. To remove the CLI: npm uninstall -g @yadurajfleetos/cli')
    if (problems.length) throw new CliError(problems.join('\n'), EXIT.failure)
  },
}
