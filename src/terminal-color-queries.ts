// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/shared/terminal/pty/ingress/pty-owner-color-query-replies.ts @ stablyai/orca efeee83b
// Changes: only OSC 10/11 and the ?996n color-scheme query, one host-wide theme, no override tracking.
//
// The PTY owner answers terminal color queries itself, as Orca does: a CLI asks right after it starts,
// before any viewer is attached, and uses the answer to tint its input box. Answered queries are taken
// out of the stream so a viewer replaying the backlog never answers them a second time.
import { DEFAULT_TERMINAL_THEMES } from '../public/orca/terminal-theme-defaults.js'

export type TerminalColors = { foreground: string; background: string }

const FALLBACK = DEFAULT_TERMINAL_THEMES['Ghostty Default Style Dark'] as TerminalColors
const QUERY = /\x1b\](1[01]);\?(\x07|\x1b\\)|\x1b\[\?996n/g
const QUERY_PREFIXES = ['\x1b]10;?\x07', '\x1b]11;?\x07', '\x1b]10;?\x1b\\', '\x1b]11;?\x1b\\', '\x1b[?996n']
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

let hostColors: TerminalColors = FALLBACK

/** The viewer's current terminal theme; malformed input keeps the previous colors. */
export function setTerminalColors(value: unknown): void {
  const { foreground, background } = (value ?? {}) as Partial<TerminalColors>
  if (typeof foreground === 'string' && HEX.test(foreground) && typeof background === 'string' && HEX.test(background)) {
    hostColors = { foreground, background }
  }
}

function channels(hex: string): number[] {
  const digits = hex.slice(1).length === 3 ? [...hex.slice(1)].map((digit) => digit + digit).join('') : hex.slice(1)
  return [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16))
}

/** xterm's reply form: each 8-bit channel widened to 16 bits. */
export function oscRgb(hex: string): string {
  return `rgb:${channels(hex).map((value) => value.toString(16).padStart(2, '0').repeat(2)).join('/')}`
}

const isDark = (hex: string): boolean => {
  const [r, g, b] = channels(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

export function replyFor(query: string, colors: TerminalColors = hostColors): string {
  if (query === '\x1b[?996n') return `\x1b[?997;${isDark(colors.background) ? 1 : 2}n`
  const slot = query.slice(2, 4)
  const terminator = query.endsWith('\x07') ? '\x07' : '\x1b\\'
  return `\x1b]${slot};${oscRgb(slot === '10' ? colors.foreground : colors.background)}${terminator}`
}

/** Returns the output with answered queries removed; a query torn across chunks is held for the next one. */
export function createColorQueryResponder(reply: (data: string) => void): (data: string) => string {
  let pending = ''
  return (data) => {
    let input = pending + data
    pending = ''
    const tail = input.lastIndexOf('\x1b')
    if (tail >= 0 && tail > input.length - 12) {
      const rest = input.slice(tail)
      if (rest !== '' && QUERY_PREFIXES.some((query) => query.startsWith(rest) && query !== rest)) {
        pending = rest
        input = input.slice(0, tail)
      }
    }
    return input.replace(QUERY, (query) => {
      reply(replyFor(query))
      return ''
    })
  }
}
