import { Terminal } from '/vendor/xterm.mjs'
import { FitAddon } from '/vendor/addon-fit.mjs'
import { Unicode11Addon } from '/vendor/addon-unicode11.mjs'
import { activateOrcaTerminalUnicodeProvider } from './orca/terminal-unicode-provider.js'
import { buildDefaultTerminalOptions } from './orca/terminal-options.js'
import { buildFontFamily } from './orca/monospace-font-family.js'
import { DEFAULT_TERMINAL_THEMES } from './orca/terminal-theme-defaults.js'

const RESIZE_DELAY_MS = 120
const FALLBACK_THEMES = { dark: 'Ghostty Default Style Dark', light: 'Builtin Tango Light' }

// The Studio terminal takes the font and theme from the user's Orca settings, so it reads the same as Orca.
const appearance = await fetch('/api/terminal-appearance')
  .then((response) => (response.ok ? response.json() : null))
  .catch(() => null)

/** The page's effective mode: an explicit choice, else the system setting. */
export function colorMode() {
  return document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
}

/** Orca keeps a dark and a light terminal theme and uses the one matching the window. */
export function terminalTheme(mode = colorMode()) {
  const name = mode === 'light' ? appearance?.themeLight : appearance?.themeDark
  return DEFAULT_TERMINAL_THEMES[name] ?? DEFAULT_TERMINAL_THEMES[FALLBACK_THEMES[mode]]
}

function terminalOptions() {
  const options = buildDefaultTerminalOptions()
  if (!appearance) return { ...options, theme: terminalTheme() }
  return {
    ...options,
    fontFamily: buildFontFamily(appearance.fontFamily),
    fontSize: appearance.fontSize,
    fontWeight: String(appearance.fontWeight),
    fontWeightBold: String(appearance.fontWeightBold),
    lineHeight: appearance.lineHeight,
    theme: terminalTheme()
  }
}

function post(path, body) {
  return fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/** The server answers the CLIs' color queries (OSC 10/11) with these, so their input box tint matches. */
export function reportTerminalColors(theme = terminalTheme()) {
  return post('terminal-colors', { foreground: theme.foreground, background: theme.background }).catch(() => {})
}

/**
 * Paths for files dropped on the page: the desktop app knows each file's real path; a browser tab
 * uploads the file to the server first and gets back where it was saved.
 */
export async function droppedPaths(dataTransfer) {
  const files = [...(dataTransfer?.files ?? [])]
  const desktop = window.whiplashDesktop?.pathForFile
  return (
    await Promise.all(
      files.map(async (file) => {
        const path = desktop?.(file)
        if (path) return path
        const response = await fetch('/api/uploads', {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'x-whiplash-upload': '1', 'x-whiplash-name': encodeURIComponent(file.name) },
          body: file
        })
        return response.ok ? (await response.json()).path : null
      })
    )
  ).filter(Boolean)
}

const hasFiles = (event) => event.dataTransfer?.types.includes('Files')

/** Lets files be dropped on an element; it shows a drop state and hands the paths over. */
export function acceptFileDrops(element, onPaths) {
  let depth = 0
  element.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return
    depth += 1
    element.classList.add('dropping')
  })
  element.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) element.classList.remove('dropping')
  })
  element.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })
  element.addEventListener('drop', async (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth = 0
    element.classList.remove('dropping')
    const paths = await droppedPaths(event.dataTransfer)
    if (paths.length) onPaths(paths)
  })
}

// A dropped path goes to the CLI shell-escaped, as a terminal pastes it.
export const shellEscape = (path) => path.replace(/([ \\'"()&;$`!*?[\]{}<>|#~])/g, '\\$1')

/** Mounts the member's live CLI. Keystrokes go straight to its PTY, so approvals work as in any terminal. */
export function mountTerminal(container, memberId, onExit) {
  const terminal = new Terminal(terminalOptions())
  const fit = new FitAddon()
  terminal.open(container)
  // Orca's load order: addons after open(), then its Unicode 11 provider so wide glyphs take two cells.
  terminal.loadAddon(fit)
  terminal.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(terminal)
  fit.fit()

  const stream = new EventSource(`/api/members/${memberId}/terminal`)
  stream.addEventListener('data', (event) => terminal.write(JSON.parse(event.data).data))
  stream.addEventListener('exit', () => {
    stream.close()
    onExit()
  })
  const input = terminal.onData((data) => void post(`members/${memberId}/terminal/input`, { data }))

  let resizeTimer = null
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      fit.fit()
      void post(`members/${memberId}/terminal/resize`, { cols: terminal.cols, rows: terminal.rows })
    }, RESIZE_DELAY_MS)
  })
  observer.observe(container)
  terminal.focus()

  return {
    size: () => ({ cols: terminal.cols, rows: terminal.rows }),
    setTheme: (theme) => {
      terminal.options.theme = theme
      void reportTerminalColors(theme)
    },
    focus: () => terminal.focus(),
    dispose() {
      clearTimeout(resizeTimer)
      observer.disconnect()
      input.dispose()
      stream.close()
      terminal.dispose()
    }
  }
}

/**
 * The CLI's screen as text right now. The PTY's replay is laid out by a terminal that is never shown,
 * at the PTY's own size, so the rows match what the Studio terminal would draw.
 */
export function readScreen(memberId) {
  return new Promise((resolve) => {
    const stream = new EventSource(`/api/members/${memberId}/terminal`)
    const done = (lines) => {
      stream.close()
      resolve(lines)
    }
    stream.addEventListener('exit', () => done([]))
    stream.addEventListener('error', () => done([]))
    stream.addEventListener(
      'data',
      (event) => {
        const { data, cols = 120, rows = 32 } = JSON.parse(event.data)
        const terminal = new Terminal({ ...buildDefaultTerminalOptions(), cols, rows })
        terminal.loadAddon(new Unicode11Addon())
        activateOrcaTerminalUnicodeProvider(terminal)
        terminal.write(data, () => {
          const buffer = terminal.buffer.active
          const lines = Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
          terminal.dispose()
          done(lines)
        })
      },
      { once: true }
    )
  })
}

/** Columns and rows a container fits before any terminal exists, so the PTY starts at the right size. */
export function measure(container) {
  const probe = new Terminal(terminalOptions())
  const fit = new FitAddon()
  probe.loadAddon(fit)
  probe.open(container)
  const size = fit.proposeDimensions() ?? { cols: 120, rows: 32 }
  probe.dispose()
  return { cols: Math.max(20, size.cols), rows: Math.max(8, size.rows) }
}
