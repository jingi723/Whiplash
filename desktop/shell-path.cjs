// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/main/startup/hydrate-shell-path.ts and shell-path-probe.ts @ stablyai/orca 0069492b
// Changes: POSIX shells only, one probe at startup, no cache or Windows shells.
'use strict'

const { spawn } = require('node:child_process')
const { delimiter } = require('node:path')

const SHELL_PATH_DELIMITER = '__WHIPLASH_SHELL_PATH__'
const PROBE_TIMEOUT_MS = 10_000
// oxlint-disable-next-line no-control-regex -- rc banners and colored prompts leak ANSI escapes.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g

function parseCapturedPath(stdout) {
  const cleaned = stdout.replace(ANSI, '')
  const first = cleaned.indexOf(SHELL_PATH_DELIMITER)
  if (first === -1) return []
  const second = cleaned.indexOf(SHELL_PATH_DELIMITER, first + SHELL_PATH_DELIMITER.length)
  if (second === -1) return []
  const value = cleaned.slice(first + SHELL_PATH_DELIMITER.length, second).trim()
  // Preserve first-match-wins shell order while deduplicating.
  return [...new Set(value.split(delimiter).map((s) => s.trim()).filter(Boolean))]
}

/** A Finder or Dock launch gets launchd's bare PATH; the login shell knows where claude and codex live. */
function readLoginShellPath() {
  if (process.platform === 'win32') return Promise.resolve([])
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const command = `printf '%s' '${SHELL_PATH_DELIMITER}'; printf '%s' "$PATH"; printf '%s' '${SHELL_PATH_DELIMITER}'`
  return new Promise((resolve) => {
    let stdout = ''
    // Own session so an interactive probe cannot take a terminal's foreground.
    const child = spawn(shell, ['-ilc', command], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, PROBE_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.on('error', () => resolve([]))
    child.on('close', () => {
      clearTimeout(timer)
      resolve(parseCapturedPath(stdout))
    })
  })
}

async function hydrateShellPath(env = process.env) {
  const fromShell = await readLoginShellPath()
  const current = (env.PATH || '').split(delimiter).filter(Boolean)
  env.PATH = [...new Set([...fromShell, ...current])].join(delimiter)
  return fromShell.length > 0
}

module.exports = { hydrateShellPath, parseCapturedPath }
