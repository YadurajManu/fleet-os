import { c, unicode, visibleLength } from './render.js'

export function descriptionRows(rows: Array<[string, string]>, columns = process.stdout.columns || 80): string {
  const commandWidth = Math.min(32, Math.max(...rows.map(([command]) => visibleLength(command))))
  return rows.map(([command, description]) => {
    const stacked = columns < 70 || visibleLength(command) > commandWidth
    const indent = stacked ? 4 : commandWidth + 5
    const available = Math.max(16, columns - indent - 1)
    const words = description.split(/\s+/)
    const lines: string[] = []
    let line = ''
    for (const word of words) {
      if (line && visibleLength(`${line} ${word}`) > available) { lines.push(line); line = '' }
      line += `${line ? ' ' : ''}${word}`
    }
    if (line) lines.push(line)
    return stacked
      ? `  ${command}\n${lines.map(s => `    ${s}`).join('\n')}`
      : `  ${command.padEnd(commandWidth)}   ${lines.join(`\n${' '.repeat(indent)}`)}`
  }).join('\n')
}

export function compactWelcome(): string {
  return [
    `${c.signal(unicode ? '○─●─○' : 'o-@-o')}  ${c.bold('FLEET')}`,
    'Deploy to hardware you own.', '', c.bold('Start here'),
    descriptionRows([['fleet auth login', 'Sign in'], ['fleet nodes pair', 'Connect a machine'], ['fleet up', 'Deploy your project']]),
    '', c.bold('Your fleet'),
    descriptionRows([['fleet status', 'Check health'], ['fleet services', 'View applications'], ['fleet logs <service>', 'Read application logs']]),
    '', c.bold('Need help?'),
    descriptionRows([['fleet doctor', 'Check your setup'], ['fleet --help', 'Explore all commands']]), '',
  ].join('\n')
}

export function operationHeader(fleet: string, operation: string): string {
  return `${c.bold('Fleet')} ${unicode ? '·' : '-'} ${fleet}\n${operation}\n`
}

export function pairingHelp(): string {
  return [operationHeader('pairing', 'Connect a target machine'),
    'fleet nodes pair [--target windows|macos|linux|git-bash]',
    '', descriptionRows([
      ['--shell powershell|bash', 'Choose the Windows shell; macOS and Linux use sh.'],
      ['--no-wait', 'Print the command without watching for a heartbeat.'],
      ['--timeout <seconds>', 'Wait up to 1–1800 seconds; default 600.'],
      ['--json', 'Print the receipt and command without prompting or waiting. Treat output as a credential.'],
    ]), '', 'PowerShell: run as Administrator using the Docker Desktop account.',
    'The target can be a different machine from the one generating the command.',
    'Ctrl+C stops watching; it does not undo registration or stop the agent.', '',
  ].join('\n')
}
