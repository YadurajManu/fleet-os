import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { session } from '../lib/api'
import '@xterm/xterm/css/xterm.css'

export interface WebTerminalProps {
  nodeId: string
  nodeName: string
  fleetId: string
  onClose: () => void
  initialCommand?: string
}

const QUICK_COMMANDS = [
  { label: 'docker ps', cmd: 'docker ps\n' },
  { label: 'df -h', cmd: 'df -h\n' },
  { label: 'free -m', cmd: 'free -m\n' },
  { label: 'uptime', cmd: 'uptime\n' },
  { label: 'uname -a', cmd: 'uname -a\n' },
  { label: 'top (summary)', cmd: 'top -bn1 | head -20\n' },
  { label: 'ip addr', cmd: 'ip -br a 2>/dev/null || ifconfig\n' },
]

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8')

function toBase64(str: string): string {
  const bytes = textEncoder.encode(str)
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function fromBase64(b64: string): string {
  const binary = atob(b64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return textDecoder.decode(bytes)
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

export default function WebTerminal({ nodeId, nodeName, fleetId, onClose, initialCommand }: WebTerminalProps) {
  const termRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // State
  const [connState, setConnState] = useState<ConnectionState>('connecting')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [drawerHeight, setDrawerHeight] = useState(440)
  const [showQuickBar, setShowQuickBar] = useState(true)
  const [latency, setLatency] = useState<number | null>(null)
  const [fontSize, setFontSize] = useState(13)
  const [copiedNote, setCopiedNote] = useState(false)

  // Refs for resize debouncing
  const lastResizeDims = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  const resizeTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Debounced resize to eliminate SIGWINCH redraw thrashing on the remote shell
  const sendResize = useCallback((cols: number, rows: number) => {
    if (cols <= 0 || rows <= 0) return
    if (lastResizeDims.current.cols === cols && lastResizeDims.current.rows === rows) {
      return
    }
    lastResizeDims.current = { cols, rows }

    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current)
    }

    resizeTimerRef.current = setTimeout(() => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'terminal_resize',
          cols,
          rows,
        }))
      }
    }, 150)
  }, [])

  // Simple direct send — no prediction, no batching, no local echo
  const handleTerminalInput = useCallback((data: string) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    ws.send(JSON.stringify({
      type: 'terminal_data',
      data: toBase64(data),
    }))
  }, [])

  const connect = useCallback(() => {
    const sess = session.get()
    if (!sess?.accessToken) {
      setConnState('error')
      return
    }

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
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
          terminalRef.current?.focus()
          const dims = fitRef.current?.proposeDimensions()
          if (dims) {
            sendResize(dims.cols, dims.rows)
          }
        } catch {}
      })

      // Send initial latency probe
      ws.send(JSON.stringify({ type: 'terminal_ping', t: Date.now() }))

      // If an initial command is specified (e.g. docker exec -it <container> sh), send it once connected
      if (initialCommand) {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'terminal_data',
              data: toBase64(initialCommand.endsWith('\n') ? initialCommand : initialCommand + '\n'),
            }))
          }
        }, 400)
      }
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'terminal_data' && msg.data) {
          // Simple: just decode and write directly — no reconciliation needed
          const text = fromBase64(msg.data)
          if (text.length > 0) {
            terminalRef.current?.write(text)
          }
        } else if (msg.type === 'terminal_pong' && msg.t) {
          const rtt = Date.now() - msg.t
          setLatency(rtt)
        } else if (msg.type === 'terminal_close') {
          setConnState('disconnected')
          setLatency(null)
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
      setLatency(null)
    }

    ws.onclose = () => {
      if (connState !== 'error') {
        setConnState('disconnected')
      }
      setLatency(null)
    }
  }, [nodeId, fleetId, connState, sendResize])

  // Latency Heartbeat ping
  useEffect(() => {
    const pingTimer = setInterval(() => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'terminal_ping',
          t: Date.now(),
        }))
      }
    }, 4000)

    return () => clearInterval(pingTimer)
  }, [])

  // Initialize terminal
  useEffect(() => {
    if (!termRef.current) return

    const terminal = new Terminal({
      fontSize,
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
      theme: {
        background: '#07080a',
        foreground: '#e8ebef',
        cursor: '#3fe08b',
        cursorAccent: '#07080a',
        selectionBackground: 'rgba(63, 224, 139, 0.25)',
        selectionForeground: '#ffffff',
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
      scrollback: 10000,
      convertEol: true,
      smoothScrollDuration: 0,
    })

    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(termRef.current)

    requestAnimationFrame(() => {
      try {
        fit.fit()
        terminal.focus()
      } catch {}
    })

    setTimeout(() => {
      try {
        fit.fit()
        terminal.focus()
      } catch {}
    }, 150)

    terminalRef.current = terminal
    fitRef.current = fit

    // Input handler — direct send, no local echo
    terminal.onData((data) => {
      handleTerminalInput(data)
    })

    // Resize handler
    terminal.onResize(({ cols, rows }) => {
      sendResize(cols, rows)
    })

    terminal.write('\x1b[90mConnecting to \x1b[37m' + nodeName + '\x1b[90m…\x1b[0m\r\n')

    connect()

    // ResizeObserver
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fit.fit()
        } catch {}
      })
    })
    ro.observe(termRef.current)

    const handleWindowResize = () => {
      requestAnimationFrame(() => {
        try {
          fit.fit()
        } catch {}
      })
    }
    window.addEventListener('resize', handleWindowResize)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', handleWindowResize)
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      terminal.dispose()
      wsRef.current?.close()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit when drawer height or fullscreen changes
  useEffect(() => {
    requestAnimationFrame(() => {
      fitRef.current?.fit()
    })
  }, [drawerHeight, isFullscreen, showQuickBar, fontSize])

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
    handleTerminalInput(cmd)
    terminalRef.current?.focus()
  }

  const handleCtrlC = () => {
    handleTerminalInput('\x03')
    terminalRef.current?.focus()
  }

  const handleCopySelection = async () => {
    const selection = terminalRef.current?.getSelection()
    if (selection) {
      await navigator.clipboard.writeText(selection)
      setCopiedNote(true)
      setTimeout(() => setCopiedNote(false), 2000)
    }
  }

  const handleZoom = (delta: number) => {
    setFontSize((prev) => {
      const next = Math.max(10, Math.min(18, prev + delta))
      if (terminalRef.current) {
        terminalRef.current.options.fontSize = next
        requestAnimationFrame(() => fitRef.current?.fit())
      }
      return next
    })
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
      setDrawerHeight(Math.max(220, Math.min(window.innerHeight - 80, dragStart.current.startH + delta)))
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
    connected: 'Live',
    disconnected: 'Disconnected',
    error: 'Error',
  }[connState]

  const latencyColor = !latency ? '#5a6270' : latency < 80 ? '#3fe08b' : latency < 200 ? '#fbbf24' : '#f87171'

  return (
    <div
      id="web-terminal-drawer"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-col font-sans"
      style={{
        height: isFullscreen ? '100vh' : `${drawerHeight}px`,
        background: '#07080a',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 -12px 48px -8px rgba(0,0,0,0.75)',
      }}
    >
      {/* ─── Resize Handle + Header ─── */}
      <div
        onMouseDown={!isFullscreen ? onDragStart : undefined}
        className="flex items-center justify-between gap-3 px-3.5 py-2 select-none shrink-0"
        style={{
          cursor: isFullscreen ? 'default' : 'ns-resize',
          background: 'rgba(255,255,255,0.02)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {/* Drag grip */}
        {!isFullscreen && (
          <div className="absolute inset-x-0 top-0 flex justify-center pt-1 pointer-events-none">
            <div className="w-10 h-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.2)' }} />
          </div>
        )}

        {/* Left: Node badge + Connection status + RTT latency */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.08]">
            <svg className="w-3.5 h-3.5 text-[#3fe08b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span className="font-mono text-[12px] font-semibold text-white/95 truncate">
              {nodeName}
            </span>
            <span className="font-mono text-[10px] text-white/40">(host)</span>
          </div>

          <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded font-mono text-[10.5px] uppercase tracking-wider font-medium"
            style={{ background: `${statusColor}14`, color: statusColor }}
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: statusColor }} />
            {statusText}
          </span>

          {/* Live RTT Latency badge */}
          {connState === 'connected' && latency !== null && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[11px] font-medium transition-colors"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: latencyColor }}
              title="End-to-end WebSocket round-trip latency to node agent"
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: latencyColor }} />
              {latency}ms
            </span>
          )}
        </div>

        {/* Right: Controls & Actions */}
        <div className="flex items-center gap-1">
          {/* Quick bar toggle */}
          <button
            onClick={() => setShowQuickBar(!showQuickBar)}
            className={`p-1.5 rounded transition-colors text-[11px] font-mono flex items-center gap-1 ${
              showQuickBar ? 'bg-white/[0.08] text-white/90' : 'hover:bg-white/[0.04] text-white/40 hover:text-white/70'
            }`}
            title="Toggle Quick Commands bar"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m4 6 8 8 8-8" />
            </svg>
            <span className="hidden md:inline">Commands</span>
          </button>

          <div className="w-px h-4 bg-white/[0.08] mx-1 hidden sm:block" />

          {/* Font Zoom Out */}
          <button
            onClick={() => handleZoom(-1)}
            disabled={fontSize <= 10}
            className="p-1.5 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/80 disabled:opacity-30 transition-colors font-mono text-[11px]"
            title="Decrease font size"
          >
            A-
          </button>

          {/* Font Zoom In */}
          <button
            onClick={() => handleZoom(1)}
            disabled={fontSize >= 18}
            className="p-1.5 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/80 disabled:opacity-30 transition-colors font-mono text-[11px]"
            title="Increase font size"
          >
            A+
          </button>

          {/* Copy Selection */}
          <button
            onClick={handleCopySelection}
            className="p-1.5 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/80 transition-colors relative"
            title="Copy selected text"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
            {copiedNote && (
              <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-[#3fe08b] text-[#07080a] text-[10px] font-mono font-bold shadow-lg">
                Copied!
              </span>
            )}
          </button>

          {/* Ctrl+C Interrupt */}
          <button
            onClick={handleCtrlC}
            className="px-1.5 py-0.5 rounded bg-white/[0.03] hover:bg-red-500/20 text-white/40 hover:text-red-400 border border-white/[0.06] hover:border-red-500/30 transition-colors font-mono text-[10.5px]"
            title="Send Ctrl+C (SIGINT)"
          >
            ^C
          </button>

          {/* Reconnect (when disconnected/error) */}
          {(connState === 'disconnected' || connState === 'error') && (
            <button
              onClick={handleReconnect}
              className="p-1.5 rounded bg-[#fbbf24]/10 text-[#fbbf24] hover:bg-[#fbbf24]/20 transition-colors flex items-center gap-1 px-2 font-mono text-[11px]"
              title="Reconnect to terminal"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
              Reconnect
            </button>
          )}

          {/* Clear screen */}
          <button
            onClick={handleClear}
            className="p-1.5 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/80 transition-colors"
            title="Clear terminal screen"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12H3" /><path d="m9 6-6 6 6 6" />
            </svg>
          </button>

          {/* Height Presets (when not fullscreen) */}
          {!isFullscreen && (
            <div className="hidden sm:flex items-center gap-0.5 bg-white/[0.03] p-0.5 rounded border border-white/[0.06]">
              <button
                onClick={() => setDrawerHeight(320)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                  drawerHeight === 320 ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
                }`}
                title="Compact height (320px)"
              >
                S
              </button>
              <button
                onClick={() => setDrawerHeight(480)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                  drawerHeight === 480 ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
                }`}
                title="Standard height (480px)"
              >
                M
              </button>
              <button
                onClick={() => setDrawerHeight(640)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                  drawerHeight === 640 ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
                }`}
                title="Tall height (640px)"
              >
                L
              </button>
            </div>
          )}

          {/* Fullscreen */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/80 transition-colors"
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
            className="p-1.5 rounded hover:bg-red-500/20 text-white/40 hover:text-red-400 transition-colors ml-1"
            title="Close terminal"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* ─── Quick Commands Bar (Chips) ─── */}
      {showQuickBar && (
        <div
          className="flex items-center gap-1.5 px-3.5 py-1.5 overflow-x-auto border-b select-none scrollbar-none"
          style={{
            background: 'rgba(255,255,255,0.015)',
            borderColor: 'rgba(255,255,255,0.04)',
          }}
        >
          <span className="font-mono text-[9px] uppercase tracking-wider text-white/30 shrink-0 mr-1">
            Quick:
          </span>
          {QUICK_COMMANDS.map((cmd) => (
            <button
              key={cmd.label}
              onClick={() => handlePreset(cmd.cmd)}
              className="shrink-0 px-2 py-0.5 rounded font-mono text-[11px] text-white/60 hover:text-[#3fe08b] bg-white/[0.025] hover:bg-[#3fe08b]/10 border border-white/[0.05] hover:border-[#3fe08b]/30 transition-all duration-150"
            >
              $ {cmd.label}
            </button>
          ))}
        </div>
      )}

      {/* ─── Terminal Canvas ─── */}
      <div
        ref={termRef}
        className="flex-1 overflow-hidden px-1"
        style={{ minHeight: 0 }}
        onClick={() => terminalRef.current?.focus()}
      />
      <style>{`
        #web-terminal-drawer .xterm {
          height: 100% !important;
          padding: 6px 12px;
        }
        #web-terminal-drawer .xterm-viewport {
          overflow-y: auto !important;
        }
        #web-terminal-drawer .xterm-screen {
          height: 100% !important;
        }
        #web-terminal-drawer .scrollbar-none::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
  )
}

