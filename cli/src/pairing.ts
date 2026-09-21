import { request, CliError, EXIT } from './api.js'
import { canPrompt, select } from './prompt.js'
import { glyph, task } from './ui.js'
import { c } from './render.js'
import type { Flags } from './args.js'

export type PairTarget = 'windows' | 'macos' | 'linux' | 'git-bash'
const quotePS = (s: string) => `'${s.replaceAll("'", "''")}'`
const quoteSH = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

export function pairingCommand(target: PairTarget, origin: string, token: string): string {
  const url = new URL(origin)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CliError('The control plane returned an invalid installer origin.', EXIT.failure)
  }
  const base = origin.replace(/\/+$/, '')
  if (target !== 'windows') return `curl -fsSL ${quoteSH(`${base}/install`)} | sh -s -- --token ${quoteSH(token)}`
  if (url.protocol !== 'https:') throw new CliError('Windows pairing requires an HTTPS control-plane URL.', EXIT.usage)
  // Download to a unique file; execution policy is not changed on the machine.
  return `$installer = Join-Path $env:TEMP ([guid]::NewGuid().ToString() + '.ps1'); try { Invoke-WebRequest -UseBasicParsing ${quotePS(`${base}/install/windows.ps1`)} -OutFile $installer -ErrorAction Stop; & $installer -ControlPlane ${quotePS(base)} -Token ${quotePS(token)} } catch { Write-Host $_.Exception.Message; $global:LASTEXITCODE = 1 } finally { Remove-Item $installer -ErrorAction SilentlyContinue }`
}

type Receipt = { token: string; expires_at: string; install_command: string; pairing_id?: string; api_url?: string }
export type PairingStatus = { status: 'pending' | 'expired' | 'registered' | 'connected' | 'removed'; node?: { id: string; name: string; platform: string | null; engineKind: string | null }; dockerAvailable?: boolean | null }

export async function waitForPairing(read: () => Promise<PairingStatus>, opts: { timeoutMs: number; pollMs?: number; onStatus?: (s: PairingStatus) => void }): Promise<PairingStatus> {
  const deadline = Date.now() + opts.timeoutMs
  do {
    const state = await read()
    opts.onStatus?.(state)
    if (['connected', 'expired', 'removed'].includes(state.status)) return state
    await new Promise(resolve => setTimeout(resolve, opts.pollMs ?? 2000))
  } while (Date.now() < deadline)
  throw new CliError('Stopped waiting for the first heartbeat. Installation was not cancelled. Check fleet nodes and Docker Desktop on the target machine.', EXIT.failure)
}

export async function pairNode(fleetId: string, flags: Flags) {
  let target = flags.target as PairTarget | undefined
  if (target && !['windows', 'macos', 'linux', 'git-bash'].includes(target)) throw new CliError('Use --target windows, macos, linux, or git-bash.', EXIT.usage)
  if (flags.shell && !['powershell', 'bash'].includes(String(flags.shell))) throw new CliError('Use --shell powershell or bash.', EXIT.usage)
  if (!target) {
    if (!canPrompt() || flags.json) throw new CliError('Specify the target machine: --target windows|macos|linux|git-bash.', EXIT.usage)
    target = await select<PairTarget>('Which machine are you connecting?', [
      { label: 'Windows · PowerShell', value: 'windows' },
      { label: 'macOS', value: 'macos' },
      { label: 'Linux', value: 'linux' },
      { label: 'Advanced · Windows Git Bash', value: 'git-bash' },
    ])
  }
  if (flags.shell === 'powershell' && target !== 'windows') throw new CliError('PowerShell pairing requires --target windows.', EXIT.usage)
  if (flags.shell === 'bash' && target === 'windows') target = 'git-bash'
  const timeout = flags.timeout === undefined ? 600 : Number(flags.timeout)
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 1800) throw new CliError('--timeout must be 1–1800 seconds.', EXIT.usage)
  const { body } = await request<Receipt>('POST', `/fleets/${fleetId}/nodes/pair-token`, { body: {} })
  if (!body.api_url && target === 'windows') throw new CliError('Upgrade the control plane to support native PowerShell pairing. No installer was run.', EXIT.failure)
  const command = body.api_url ? pairingCommand(target, body.api_url, body.token) : body.install_command
  if (flags.json) return console.log(JSON.stringify({ ...body, install_command: command, target }, null, 2))
  console.log(`Run on the target machine${target === 'windows' ? ' in PowerShell as Administrator, using the Docker Desktop account' : ''}:\n`)
  console.log(command)
  console.log(`\nSingle-use credential; expires ${body.expires_at}. Do not share this command.`)
  if (flags['no-wait'] || !canPrompt()) return
  if (!body.pairing_id) {
    console.log('This control plane cannot track this pairing attempt. Verify the node with fleet nodes; success has not been confirmed.')
    return
  }
  const state = await task('waiting for the target machine', async spinner => {
    const result = await waitForPairing(
    () => request<PairingStatus>('GET', `/fleets/${fleetId}/nodes/pairings/${body.pairing_id}`, { timeoutMs: Math.min(10000, timeout * 1000) }).then(r => r.body),
    { timeoutMs: timeout * 1000, onStatus: s => spinner.update(s.status === 'registered' ? 'registered; waiting for first heartbeat' : 'waiting for the target machine') },
    )
    if (result.status !== 'connected') throw new CliError(`Pairing ${result.status}. Generate a new command with fleet nodes pair.`, EXIT.failure)
    return result
  }, { done: () => 'first heartbeat received' })
  console.log(`${glyph.ok} Connected: ${state.node!.name}`)
  console.log(`Docker engine: ${state.node!.platform ?? 'not reported'} · ${state.node!.engineKind ?? 'not reported'}`)
  if (state.dockerAvailable !== true) throw new CliError('Heartbeat received, but Docker readiness is not confirmed. Start Docker and run fleet doctor.', EXIT.failure)
  console.log(`\n${c.bold('Next:')} deploy an app with fleet up`)
}
