/** Terminal rendering. Colour is dropped when output is piped or NO_COLOR is set. */
const colorArg = process.argv.indexOf('--color')
const colorMode = colorArg < 0 ? 'auto' : process.argv[colorArg + 1]
const useColour = !process.argv.includes('--no-color') && process.env.NO_COLOR === undefined &&
  Boolean(process.stdout.isTTY) && colorMode !== 'never'

/**
 * 0 none, 1 the sixteen ANSI colours, 2 twenty-four bit. The brand palette only
 * survives intact at level 2; below that every shade collapses onto the nearest
 * basic colour, which is why nothing here encodes meaning in shade alone.
 */
export const colourDepth: 0 | 1 | 2 = !useColour
  ? 0
  : /truecolor|24bit/i.test(process.env.COLORTERM ?? '')
    ? 2
    : 1

/**
 * Whether the terminal can be trusted with braille, box-drawing and block
 * glyphs. This is a separate question from colour: a terminal that renders
 * `⠋` as a replacement box makes the CLI look broken, whereas plain ASCII only
 * looks plain. So the guess errs toward ASCII and takes overrides in both
 * directions — `FLEET_ASCII=1` forces the fallback, `FLEET_UNICODE=1` forces the
 * glyphs on for the many Linux shells that simply never set a locale.
 */
export const unicode: boolean = process.env.FLEET_ASCII || process.argv.includes('--ascii')
  ? false
  : process.env.FLEET_UNICODE
    ? true
    : process.env.TERM === 'dumb'
      ? false
      : /utf-?8/i.test(
            `${process.env.LC_ALL ?? ''} ${process.env.LC_CTYPE ?? ''} ${process.env.LANG ?? ''}`
          )

/**
 * One vocabulary, chosen once, so no caller ever branches on `unicode`. Every
 * entry is a single terminal cell wide in both sets — the progress UI redraws in
 * place and a two-cell glyph would shift everything after it.
 */
export const glyphs = unicode
  ? {
      frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
      ok: '✔',
      online: '●',
      idle: '○',
      fail: '✖',
      warn: '▲',
      info: '›',
      pending: '◌',
      stepActive: '◆',
      stepTodo: '○',
      pointer: '❯',
      barFill: '█',
      barEmpty: '░',
      branch: '└',
      rule: '─',
    }
  : {
      frames: ['-', '\\', '|', '/'],
      ok: 'v',
      online: '*',
      idle: 'o',
      fail: 'x',
      warn: '!',
      info: '>',
      pending: 'o',
      stepActive: '>',
      stepTodo: '.',
      pointer: '>',
      barFill: '#',
      barEmpty: '.',
      branch: '\\',
      rule: '-',
    }

const ESC = '\x1b['
const wrap = (code: string) => (s: string) => (useColour ? `${ESC}${code}m${s}${ESC}0m` : s)

/** Truecolour when the terminal has it, otherwise the supplied fallback. */
export const rgb =
  (r: number, g: number, b: number, fallback: (s: string) => string = (s) => s) =>
  (s: string) =>
    colourDepth === 2 ? `${ESC}38;2;${r};${g};${b}m${s}${ESC}0m` : fallback(s)

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  green: rgb(0x3f, 0xe0, 0x8b, wrap('32')),
  yellow: rgb(0xf2, 0xc6, 0x6d, wrap('33')),
  red: rgb(0xff, 0x6b, 0x6b, wrap('31')),
  cyan: rgb(0x56, 0xcf, 0xe1, wrap('36')),
  /** The one accent from the marketing site, reserved for live things. */
  signal: rgb(0x3f, 0xe0, 0x8b, wrap('32')),
  grey: rgb(0x6b, 0x72, 0x80, wrap('2')),
}

export const cursor = {
  // Cursor controls are terminal capabilities, not colour capabilities. The
  // progress UI writes to stderr, so stdout may be piped to jq while stderr is
  // still an interactive terminal that needs its cursor restored.
  hide: () => `${ESC}?25l`,
  show: () => `${ESC}?25h`,
  up: (n: number) => `${ESC}${n}A`,
  // Moving down with a control sequence rather than a newline matters at the
  // bottom of the screen: `\n` there scrolls the region out from under the
  // cursor arithmetic, `ESC[nB` cannot.
  down: (n: number) => `${ESC}${n}B`,
  clearLine: () => `\r${ESC}2K`,
  clearBelow: () => `${ESC}0J`,
}

export const statusColour = (status: string): string => {
  switch (status) {
    case 'online':
    case 'running':
      return c.green(status)
    case 'offline':
    case 'failed':
      return c.red(status)
    case 'cordoned':
    case 'draining':
    case 'deploying':
    case 'pinned_unavailable':
      return c.yellow(status)
    default:
      return c.dim(status)
  }
}

/**
 * Column widths are measured on the visible text, not the escaped string —
 * otherwise colour codes count toward the width and every column drifts.
 */
// SGR is what Fleet emits today, but accept all CSI sequences so a value that
// arrives already decorated by a caller cannot make width accounting drift.
// OSC covers terminal hyperlinks, which are zero-width too.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g

const isZeroWidth = (code: number): boolean =>
  (code >= 0x0300 && code <= 0x036f) ||
  (code >= 0x1ab0 && code <= 0x1aff) ||
  (code >= 0x1dc0 && code <= 0x1dff) ||
  (code >= 0x20d0 && code <= 0x20ff) ||
  (code >= 0xfe00 && code <= 0xfe0f) ||
  (code >= 0xfe20 && code <= 0xfe2f) ||
  code === 0x200d

/** A pragmatic terminal-cell width for the CLI's labels and progress lines. */
const cellWidth = (grapheme: string): number => {
  const points = [...grapheme].map((char) => char.codePointAt(0)!)
  if (!points.length || points.every(isZeroWidth)) return 0

  // Emoji presentation and common wide East Asian ranges occupy two cells in
  // mainstream terminals. A grapheme stays one unit here, so ZWJ emoji do not
  // accidentally count once per constituent code point.
  if (
    points.some((code) =>
      code >= 0x1f000 ||
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    )
  ) return 2
  return 1
}

const graphemes = (text: string): string[] => {
  // Segmenter prevents a truncation point from splitting an emoji, accent, or
  // other user-visible character. The fallback remains correct enough on old
  // Node versions: it only loses the nicer grapheme boundary.
  const Segmenter = Intl.Segmenter
  return Segmenter
    ? [...new Segmenter().segment(text)].map((part) => part.segment)
    : [...text]
}

const visibleLength = (s: string) =>
  graphemes(s.replace(ANSI, '')).reduce((width, grapheme) => width + cellWidth(grapheme), 0)

export function table(headers: string[], rows: string[][], options: { priorities?: number[] } = {}): string {
  // Printing a header over nothing looks like a bug; callers handle the
  // empty case with a sentence instead.
  if (!rows.length) return ''

  const fullWidths = headers.map((h, i) =>
    Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? '')))
  )
  const available = Math.max(20, (process.stdout.columns || 80) - 1)
  const minWidth = (i: number) => Math.min(fullWidths[i]!, i === 0 ? 12 : 8)
  const priority = options.priorities ?? headers.map((_, i) => i)
  const kept = headers.map((_, i) => i)
  const desiredTotal = () => kept.reduce((sum, i) => sum + fullWidths[i]!, 0) + Math.max(0, kept.length - 1) * 2
  while (kept.length > 1 && desiredTotal() > available) {
    const drop = [...kept].sort((a, b) => (priority[b] ?? b) - (priority[a] ?? a))[0]!
    kept.splice(kept.indexOf(drop), 1)
  }
  const hidden = headers.length - kept.length
  const widths = kept.map((i) => fullWidths[i]!)
  let extra = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 2 - available
  if (extra > 0) {
    for (const [position, i] of [...kept].map((value, position) => [position, value] as const).sort((a, b) => (priority[b[1]] ?? b[1]) - (priority[a[1]] ?? a[1]))) {
      const reducible = Math.max(0, widths[position]! - minWidth(i))
      const reduction = Math.min(extra, reducible)
      widths[position]! -= reduction
      extra -= reduction
    }
  }
  const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - visibleLength(s)))

  const head = kept.map((i, column) => c.dim(pad(truncate(headers[i]!.toUpperCase(), widths[column]!), widths[column]!))).join('  ')
  const body = rows.map((row) => kept.map((i, column) => pad(truncate(row[i] ?? '', widths[column]!), widths[column]!)).join('  '))
  return [head, ...body, ...(hidden ? [c.dim(`… ${hidden} column${hidden === 1 ? '' : 's'} hidden`)] : [])].join('\n')
}

export function loadBar(percent: number, width = 8): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  const filled = Math.round((clamped / 100) * width)
  const tone = clamped >= 90 ? c.red : clamped >= 75 ? c.yellow : c.green
  return `${tone(glyphs.barFill.repeat(filled))}${c.dim(glyphs.barEmpty.repeat(width - filled))} ${Math.round(clamped)}%`
}

export function statusBadge(status: string): string {
  const label = status.replaceAll('_', ' ')
  const normalized = label.toLowerCase()
  if (['running', 'online', 'healthy', 'operational', 'ok', 'succeeded', 'completed', 'complete'].includes(normalized)) return `${c.green(glyphs.online)} ${c.green(label)}`
  if (['failed', 'offline', 'down', 'error'].includes(normalized)) return `${c.red(glyphs.fail)} ${c.red(label)}`
  if (['degraded', 'warning', 'cordoned', 'draining', 'pinned unavailable'].includes(normalized)) return `${c.yellow(glyphs.warn)} ${c.yellow(label)}`
  if (['pending', 'deploying', 'building', 'pushing', 'queued'].includes(normalized)) return `${c.yellow(glyphs.pending)} ${label}`
  if (['not deployed', 'idle', 'stopped'].includes(normalized)) return `${c.dim(glyphs.idle)} ${c.dim(label)}`
  return c.dim(label)
}

export const header = (title: string, status?: string): string => `${c.bold(title)}${status ? `  ${statusBadge(status)}` : ''}`
export const section = (title: string): string => c.bold(title.toUpperCase())
export const hint = (command: string): string => `  ${glyphs.info} ${c.cyan(command)}`
export const problemBlock = (title: string, cause: string, command: string): string =>
  `${c.red(`${glyphs.fail} ${title}`)}\n  ${cause}\n${hint(command)}`
export const terminalLink = (label: string, url: string): string => {
  if (!/^https?:\/\/[^\u0000-\u001f\u007f]+$/i.test(url)) return c.cyan(label)
  return process.stdout.isTTY && !process.argv.includes('--no-color') && process.env.NO_COLOR === undefined &&
    !(process.argv.includes('--color') && process.argv[process.argv.indexOf('--color') + 1] === 'never')
    ? `\x1b]8;;${url}\x1b\\${c.cyan(label)}\x1b]8;;\x1b\\`
    : c.cyan(label)
}

export function keyValues(pairs: Array<[string, string]>): string {
  const width = Math.max(...pairs.map(([k]) => k.length))
  return pairs.map(([k, v]) => `${c.dim(k.padEnd(width))}  ${v}`).join('\n')
}

/** Handles both directions: a heartbeat in the past, a token expiring ahead. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  const magnitude = Math.abs(seconds)
  const suffix = seconds >= 0 ? 'ago' : 'from now'

  if (magnitude < 60) return `${magnitude}s ${suffix}`
  if (magnitude < 3600) return `${Math.round(magnitude / 60)}m ${suffix}`
  if (magnitude < 86400) return `${Math.round(magnitude / 3600)}h ${suffix}`
  return `${Math.round(magnitude / 86400)}d ${suffix}`
}

export const mb = (value: number): string =>
  value >= 1024 ? `${(value / 1024).toFixed(1)}GB` : `${value}MB`

export const memoryPair = (firstMb: number, secondMb: number): string =>
  Math.max(firstMb, secondMb) >= 1024
    ? `${(firstMb / 1024).toFixed(1)} / ${(secondMb / 1024).toFixed(1)}GB`
    : `${Math.round(firstMb)} / ${Math.round(secondMb)}MB`

/**
 * Cut to a visible width, stepping over colour codes rather than counting them.
 * Anything that redraws in place depends on this: a line that wraps occupies two
 * terminal rows, and the cursor arithmetic above it silently goes wrong.
 */
export function truncate(text: string, width: number): string {
  const limit = Math.max(1, width)
  if (visibleLength(text) <= limit) return text

  let out = ''
  let visible = 0
  let hasSgr = false
  const ellipsisWidth = unicode ? 1 : 3
  for (let i = 0; i < text.length; i++) {
    const escape = text.slice(i).match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/)
    if (escape) {
      out += escape[0]
      hasSgr ||= /^\x1b\[[0-9;]*m$/.test(escape[0])
      i += escape[0].length - 1
      continue
    }
    const [grapheme] = graphemes(text.slice(i))
    const cells = cellWidth(grapheme!)
    if (visible + cells > limit - ellipsisWidth) break
    out += grapheme
    i += grapheme!.length - 1
    visible += cells
  }
  return `${out}${unicode ? '…' : '...'}${hasSgr ? `${ESC}0m` : ''}`
}

export { visibleLength }
