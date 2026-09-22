import { useState } from 'react'
import CopyLine from './CopyLine'

const INSTALLERS = [
  { id: 'npm', label: 'npm', command: 'npm install -g @yadurajfleetos/cli' },
  { id: 'pnpm', label: 'pnpm', command: 'pnpm add -g @yadurajfleetos/cli' },
  { id: 'bun', label: 'bun', command: 'bun add -g @yadurajfleetos/cli' },
  { id: 'npx', label: 'npx', command: 'npx @yadurajfleetos/cli@latest' },
]

export default function InstallCommand() {
  const [selected, setSelected] = useState(INSTALLERS[0])

  return (
    <div aria-label="Install Fleet CLI">
      <div
        className="flex items-center gap-0.5 border-x border-t border-[var(--color-line)] bg-[var(--color-ink-950)] px-1.5 pt-1.5"
        role="tablist"
        aria-label="Package manager"
      >
        {INSTALLERS.map(installer => {
          const active = installer.id === selected.id
          return (
            <button
              key={installer.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls="fleet-install-command"
              onClick={() => setSelected(installer)}
              className={`px-2.5 py-1.5 font-mono text-[10px] transition-colors duration-200 ${
                active
                  ? 'bg-[var(--color-ink-800)] text-[var(--color-signal)]'
                  : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]'
              }`}
            >
              {installer.label}
            </button>
          )
        })}
        <span className="ml-auto pr-2 font-mono text-[9px] tracking-[0.08em] text-[var(--color-fg-dim)]">
          INSTALL CLI
        </span>
      </div>
      <div id="fleet-install-command" role="tabpanel">
        <CopyLine
          key={selected.command}
          command={selected.command}
          className="rounded-t-none"
        />
      </div>
    </div>
  )
}
