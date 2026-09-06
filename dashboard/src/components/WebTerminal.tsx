import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { session } from '../lib/api'
import { useAuth } from '../lib/auth'
import '@xterm/xterm/css/xterm.css'

export interface WebTerminalProps {
  nodeId: string
  nodeName: string
  fleetId: string
  onClose: () => void
}

const QUICK_COMMANDS = [
  { label: 'uptime', cmd: 'uptime\n' },
  { label: 'df -h', cmd: 'df -h\n' },
  { label: 'free -m', cmd: 'free -m\n' },
  { label: 'docker ps', cmd: 'docker ps\n' },
  { label: 'uname -a', cmd: 'uname -a\n' },
  { label: 'top -bn1 | head -20', cmd: 'top -bn1 | head -20\n' },
]

function toBase64(str: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)))
}

function fromBase64(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

export default function WebTerminal({ nodeId, nodeName, fleetId, onClose }: WebTerminalProps) {
  const termRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const { fleet } = useAuth()

  const [connState, setConnState] = useState<ConnectionState>('connecting')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [drawerHeight, setDrawerHeight] = useState(420)
  const [showPresets, setShowPresets] = useState(false)

  const connect = useCallback(() => {
    const sess = session.get()
    if (!sess?.accessToken) {
      setConnState('error')
      return
    }

    // Build the WebSocket URL from the API base
    const apiBase = import.meta.env?.VITE_API ?? '/api'
    let wsBase: string
    if (apiBase.startsWith('http')) {
      wsBase = apiBase.replace(/^http/, 'ws')
    } else {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      wsBase = `${proto}//${window.location.host}${apiBase}`
    }
    const cleanBase = wsBase.replace(/\/+$/, '')
    const wsUrl = `${cleanBase}/fleets/${fleetId}/nodes/${nodeId}/terminal?token=${encodeURIComponent(sess.accessToken)}`

    setConnState('connecting')
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setConnState('connected')
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'terminal_data' && msg.data) {
          const text = fromBase64(msg.data)
          terminalRef.current?.write(text)
        } else if (msg.type === 'terminal_close') {
          setConnState('disconnected')
          if (msg.error) {
            terminalRef.current?.write(`\r\n\x1b[31m[Session ended: ${msg.error}]\x1b[0m\r\n`)
          } else {
            terminalRef.current?.write('\r\n\x1b[90m[Session ended]\x1b[0m\r\n')
          }
        }
      } catch {
        // ignore
      }
    }

    ws.onerror = () => {
      setConnState('error')
    }

    ws.onclose = () => {
      if (connState !== 'error') {
        setConnState('disconnected')
      }
    }
  }, [nodeId, fleetId, connState])

  // Initialize terminal
  useEffect(() => {
    if (!termRef.current) return

    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
      theme: {
        background: '#07080a',
        foreground: '#e8ebef',
        cursor: '#3fe08b',
        cursorAccent: '#07080a',
        selectionBackground: 'rgba(63, 224, 139, 0.2)',
        selectionForeground: '#e8ebef',
        black: '#1a1d23',
        red: '#f87171',
        green: '#3fe08b',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e8ebef',
        brightBlack: '#5a6270',
        brightRed: '#fca5a5',
        brightGreen: '#6ee7b7',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f8fafc',
      },
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: true,
      scrollback: 5000,
      convertEol: true,
    })

    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(termRef.current)

    // Small delay so the DOM has settled before measuring
    requestAnimationFrame(() => {
      fit.fit()
    })

    terminalRef.current = terminal
    fitRef.current = fit

    // Handle user input → send to server
    terminal.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'terminal_data',
          data: toBase64(data),
        }))
      }
    })

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'terminal_resize',
          cols,
          rows,
        }))
      }
    })

    terminal.write('\x1b[90mConnecting to \x1b[37m' + nodeName + '\x1b[90m…\x1b[0m\r\n')

    // Connect
    connect()

    // Window resize handler
    const handleResize = () => {
      requestAnimationFrame(() => {
        fit.fit()
      })
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      terminal.dispose()
      wsRef.current?.close()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit when drawer height or fullscreen changes
  useEffect(() => {
    requestAnimationFrame(() => {
      fitRef.current?.fit()
    })
  }, [drawerHeight, isFullscreen])

  const handleClear = () => {
    terminalRef.current?.clear()
  }

  const handleReconnect = () => {
    wsRef.current?.close()
    terminalRef.current?.clear()
    terminalRef.current?.write('\x1b[90mReconnecting to \x1b[37m' + nodeName + '\x1b[90m…\x1b[0m\r\n')
    connect()
  }

  const handlePreset = (cmd: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'terminal_data',
        data: toBase64(cmd),
      }))
    }
    setShowPresets(false)
    terminalRef.current?.focus()
  }

  const handleClose = () => {
    wsRef.current?.close()
    onClose()
  }

  // Drag-to-resize header
  const dragStart = useRef<{ startY: number; startH: number } | null>(null)

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragStart.current = { startY: e.clientY, startH: drawerHeight }

    const onMove = (ev: MouseEvent) => {
      if (!dragStart.current) return
      const delta = dragStart.current.startY - ev.clientY
      setDrawerHeight(Math.max(200, Math.min(window.innerHeight - 80, dragStart.current.startH + delta)))
    }
    const onUp = () => {
      dragStart.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const statusColor = {
    connecting: '#fbbf24',
    connected: '#3fe08b',
    disconnected: '#5a6270',
    error: '#f87171',
  }[connState]

  const statusText = {
    connecting: 'Connecting…',
    connected: 'Connected',
    disconnected: 'Disconnected',
    error: 'Error',
  }[connState]

  return (
    <div
      id="web-terminal-drawer"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-col"
      style={{
        height: isFullscreen ? '100vh' : `${drawerHeight}px`,
        background: '#07080a',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 -8px 40px -8px rgba(0,0,0,0.6)',
      }}
    >
      {/* ─── Resize Handle + Header ─── */}
      <div
        onMouseDown={!isFullscreen ? onDragStart : undefined}
        className="flex items-center justify-between gap-3 px-4 py-2 select-none shrink-0"
        style={{
          cursor: isFullscreen ? 'default' : 'ns-resize',
          background: 'rgba(255,255,255,0.02)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {/* Drag grip */}
        {!isFullscreen && (
          <div className="absolute inset-x-0 top-0 flex justify-center pt-1">
            <div className="w-8 h-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.15)' }} />
          </div>
        )}

        {/* Left: Target + Status */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-[#3fe08b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span className="font-mono text-[12px] font-medium text-white/90 truncate">
              {nodeName}
            </span>
            <span className="font-mono text-[10px] text-white/40">(host)</span>
          </div>
          <span
            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.1em]"
            style={{ color: statusColor }}
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: statusColor }} />
            {statusText}
          </span>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1">
          {/* Quick Presets */}
          <div className="relative">
            <button
              onClick={() => setShowPresets(!showPresets)}
              className="p-1.5 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/70 transition-colors"
              title="Quick commands"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
            {showPresets && (
              <div
                className="absolute bottom-full right-0 mb-1 rounded-lg overflow-hidden"
                style={{
                  background: '#13151a',
                  border: '1px solid rgba(255,255,255,0.1)',
                  boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                  minWidth: '180px',
                }}
              >
                <div className="px-3 py-1.5 border-b border-white/[0.06]">
                  <span className="font-mono text-[10px] text-white/40 uppercase tracking-wider">Quick Commands</span>
                </div>
                {QUICK_COMMANDS.map((cmd) => (
                  <button
                    key={cmd.label}
                    onClick={() => handlePreset(cmd.cmd)}
                    className="w-full text-left px-3 py-1.5 font-mono text-[12px] text-white/70 hover:bg-white/[0.06] hover:text-white transition-colors"
                  >
                    $ {cmd.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Reconnect (only when disconnected) */}
          {(connState === 'disconnected' || connState === 'error') && (
            <button
              onClick={handleReconnect}
              className="p-1.5 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/70 transition-colors"
              title="Reconnect"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
            </button>
          )}

          {/* Clear */}
          <button
            onClick={handleClear}
            className="p-1.5 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/70 transition-colors"
            title="Clear terminal"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12H3" /><path d="m9 6-6 6 6 6" />
            </svg>
          </button>

          {/* Fullscreen */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/70 transition-colors"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8V5a2 2 0 0 1 2-2h3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M21 16v3a2 2 0 0 1-2 2h-3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" />
              </svg>
            )}
          </button>

          {/* Close */}
          <button
            onClick={handleClose}
            className="p-1.5 rounded hover:bg-red-500/20 text-white/40 hover:text-red-400 transition-colors"
            title="Close terminal"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* ─── Terminal Canvas ─── */}
      <div
        ref={termRef}
        className="flex-1 overflow-hidden px-1"
        style={{ minHeight: 0 }}
        onClick={() => terminalRef.current?.focus()}
      />
    </div>
  )
}
