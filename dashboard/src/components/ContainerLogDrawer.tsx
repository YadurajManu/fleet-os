import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { usePoll } from '../lib/auth'
import LogTerminal from './LogTerminal'

export interface ContainerLogDrawerProps {
  containerName: string
  containerId?: string
  serviceId?: string
  serviceName?: string
  nodeName: string
  onClose: () => void
}

export default function ContainerLogDrawer({
  containerName,
  containerId,
  serviceId,
  serviceName,
  nodeName,
  onClose,
}: ContainerLogDrawerProps) {
  const [isLive, setIsLive] = useState(true)

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Poll service logs if serviceId is known
  const logs = usePoll(
    () =>
      api<{ node: { name: string }; lines: string[]; diagnostic: string | null }>(
        `/services/${serviceId}/logs`
      ),
    serviceId ? `/services/${serviceId}/logs` : null,
    isLive ? 2000 : 0
  )

  const displayName = serviceName || containerName.replace(/^fleet-/, '')

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-end bg-black/75 p-0 backdrop-blur-sm"
      style={{ animation: 'fade-in 0.18s cubic-bezier(0.16, 1, 0.3, 1) both' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-4xl border-l border-[var(--color-line-2)] bg-[var(--color-ink-950)] shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: 'slide-in-right 0.25s cubic-bezier(0.16, 1, 0.3, 1) both' }}
      >
        {/* Drawer Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-5 py-3.5 bg-[var(--color-ink-900)]">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded bg-[#3fe08b]/10 border border-[#3fe08b]/30 flex items-center justify-center text-[#3fe08b] font-mono text-[13px] font-bold">
              📄
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-mono text-[13px] font-bold text-white tracking-tight">
                  {displayName}
                </h2>
                {containerId && (
                  <span className="font-mono text-[10px] text-white/40 px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.08]">
                    {containerId.slice(0, 12)}
                  </span>
                )}
              </div>
              <p className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                Live output on <span className="text-white/70 font-semibold">{nodeName}</span>
                {containerName !== displayName && ` · container: ${containerName}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              aria-label="Close"
              className="flex h-7 w-7 items-center justify-center rounded border border-[var(--color-line-2)] font-mono text-[12px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-down)] hover:text-[var(--color-down)]"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Drawer Terminal Body */}
        <div className="flex-1 p-4 overflow-hidden flex flex-col min-h-0 bg-[#07080a]">
          {serviceId ? (
            <LogTerminal
              serviceName={displayName}
              nodeName={nodeName}
              lines={logs.data?.lines ?? []}
              diagnostic={logs.data?.diagnostic ?? (logs.loading ? 'Fetching logs…' : null)}
              loading={logs.loading}
              isLive={isLive}
              onToggleLive={() => setIsLive(!isLive)}
              onRefresh={logs.refetch}
              height="100%"
              className="h-full"
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full p-8 text-center">
              <div className="w-12 h-12 rounded-full bg-white/[0.03] border border-white/10 flex items-center justify-center text-white/40 mb-3 text-xl">
                🐳
              </div>
              <h3 className="font-mono text-[14px] font-semibold text-white/90">
                Direct Container Log Stream
              </h3>
              <p className="mt-1 max-w-md font-mono text-[11.5px] text-[var(--color-fg-dim)] leading-relaxed">
                This container ({containerName}) is running directly on the host. To stream raw output directly from the Docker daemon, use the interactive web terminal:
              </p>
              <div className="mt-4 px-3 py-2 rounded bg-black border border-white/10 font-mono text-[12px] text-[#3fe08b]">
                docker logs -f --tail 200 {containerName}
              </div>
            </div>
          )}
        </div>

        {/* Drawer Footer */}
        <div className="border-t border-[var(--color-line)] px-5 py-2.5 bg-[var(--color-ink-950)] flex items-center justify-between text-[11px] font-mono text-[var(--color-fg-dim)]">
          <span>Press <kbd className="px-1 py-0.5 rounded bg-white/10 text-white/70">Esc</kbd> to close</span>
          {serviceId && <span>Auto-refreshing every 2s</span>}
        </div>
      </div>
    </div>
  )
}
