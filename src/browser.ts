// Each agent gets its own headless Chrome, driven by agent-browser over CDP and watched through a screencast.
// Chrome runs detached, so it outlives a server restart; its port is read back from the profile, never stored.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { whiplashHome } from './store.ts'

const CHROME_APP = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/** Where `agent-browser install` puts Chrome for Testing. */
const TESTING_ROOT = join(homedir(), '.agent-browser', 'browsers')
const TESTING_BINARY = '**/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const START_TIMEOUT_MS = 15_000
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const browserBin = join(whiplashHome, 'bin')
const profileOf = (memberId: string): string => join(whiplashHome, 'browsers', memberId)

export class ChromeNotFound extends Error {}

/** The installed Google Chrome first, then the newest Chrome for Testing that agent-browser downloaded. */
export function findChrome(app = CHROME_APP, testingRoot = TESTING_ROOT): string {
  if (existsSync(app)) return app
  const found = existsSync(testingRoot) ? globSync(TESTING_BINARY, { cwd: testingRoot }).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })) : []
  if (found[0]) return join(testingRoot, found[0])
  throw new ChromeNotFound()
}

/** Chrome writes its chosen debugging port as the first line of DevToolsActivePort. */
export function readDevToolsPort(profile: string): number | null {
  try {
    const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  } catch {
    return null
  }
}

async function versionOf(port: number): Promise<{ webSocketDebuggerUrl: string } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
    return response.ok ? ((await response.json()) as { webSocketDebuggerUrl: string }) : null
  } catch {
    return null
  }
}

/** The member's live Chrome, if any. */
async function livePort(memberId: string): Promise<number | null> {
  const port = readDevToolsPort(profileOf(memberId))
  return port && (await versionOf(port)) ? port : null
}

const starting = new Map<string, Promise<number>>()

/** Starts the member's Chrome unless it already runs, and returns its debugging port. */
export function ensureBrowser(memberId: string): Promise<number> {
  const pending = starting.get(memberId)
  if (pending) return pending
  const start = (async () => {
    const running = await livePort(memberId)
    if (running) return running
    const profile = profileOf(memberId)
    mkdirSync(profile, { recursive: true })
    rmSync(join(profile, 'DevToolsActivePort'), { force: true })
    spawn(
      findChrome(),
      [
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`,
        // Headless, so it never takes focus from the owner's screen; Whiplash shows it instead.
        '--headless=new',
        '--window-size=1280,800',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
      ],
      { detached: true, stdio: 'ignore' }
    ).unref()
    for (const deadline = Date.now() + START_TIMEOUT_MS; Date.now() < deadline; ) {
      await new Promise((done) => setTimeout(done, 200))
      const port = await livePort(memberId)
      if (port) return port
    }
    throw new Error('Chrome did not start')
  })().finally(() => starting.delete(memberId))
  starting.set(memberId, start)
  return start
}

/** Ends the member's Chrome through CDP, so no pid has to be kept. Its profile (and sign-ins) stays. */
export async function closeBrowser(memberId: string): Promise<void> {
  const port = readDevToolsPort(profileOf(memberId))
  const version = port && (await versionOf(port))
  if (!version) return
  const socket = new WebSocket(version.webSocketDebuggerUrl)
  socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  socket.onerror = () => {}
}

/**
 * The `agent-browser` an agent finds first on its PATH: asks the server for its own Chrome, then runs the real
 * one against it. The session name keeps each member's agent-browser daemon apart.
 */
export function writeBrowserWrapper(): void {
  // The native binary itself, not the node shim: an app opened from Finder may have no node on its PATH.
  const real = join(ROOT_DIR, 'node_modules', 'agent-browser', 'bin', `agent-browser-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`)
  mkdirSync(browserBin, { recursive: true })
  const path = join(browserBin, 'agent-browser')
  writeFileSync(
    path,
    `#!/bin/sh
# Written by Whiplash on start. Runs agent-browser against this agent's own Chrome.
if [ -z "$WHIPLASH_MEMBER_ID" ] || [ -z "$WHIPLASH_URL" ]; then
  echo "agent-browser: run this from a Whiplash agent" >&2; exit 1
fi
reply=$(curl -sS -X POST -H 'content-type: application/json' -H "origin: $WHIPLASH_URL" -d '{}' \\
  "$WHIPLASH_URL/api/members/$WHIPLASH_MEMBER_ID/browser/ensure" 2>&1)
port=$(printf '%s' "$reply" | sed -n 's/.*"port":\\([0-9]*\\).*/\\1/p')
if [ -z "$port" ]; then
  echo "agent-browser: Whiplash could not start this agent's Chrome: $reply" >&2; exit 1
fi
exec ${JSON.stringify(real)} --cdp "$port" --session "whiplash-$WHIPLASH_MEMBER_ID" "$@"
`
  )
  chmodSync(path, 0o755)
}

type Target = { targetId: string; type: string; url: string; title: string }
export type BrowserEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'page'; url: string; title: string }
  | { type: 'closed' }

/**
 * Streams the member's newest page as JPEG frames, following it across new tabs and navigations.
 * One browser-level CDP socket: target events tell the page and its title, a flat session carries the screencast.
 */
export async function watchBrowser(memberId: string, emit: (event: BrowserEvent) => void): Promise<() => void> {
  const port = await ensureBrowser(memberId)
  const version = await versionOf(port)
  if (!version) throw new Error('Chrome is not running')
  const socket = new WebSocket(version.webSocketDebuggerUrl)
  const pages = new Map<string, Target>()
  let nextId = 1
  let watched = ''
  let session = ''
  const send = (method: string, params: object = {}, sessionId?: string): number => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return id
  }
  const attachIds = new Map<number, string>()
  // ponytail: the newest page is the one shown; a tab picker can come with phase 2's controls.
  const follow = (targetId: string): void => {
    if (targetId === watched) return
    if (session) send('Target.detachFromTarget', { sessionId: session })
    watched = targetId
    session = ''
    attachIds.set(send('Target.attachToTarget', { targetId, flatten: true }), targetId)
    const page = pages.get(targetId)
    if (page) emit({ type: 'page', url: page.url, title: page.title })
  }
  socket.onopen = () => send('Target.setDiscoverTargets', { discover: true })
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    if (attachIds.has(message.id)) {
      const targetId = attachIds.get(message.id)!
      attachIds.delete(message.id)
      if (targetId !== watched || !message.result) return
      session = message.result.sessionId
      send('Page.enable', {}, session)
      send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200 }, session)
      return
    }
    const { method, params } = message
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = params.targetInfo as Target
      if (info.type !== 'page') return
      const known = pages.has(info.targetId)
      pages.set(info.targetId, info)
      if (!known) follow(info.targetId)
      else if (info.targetId === watched) emit({ type: 'page', url: info.url, title: info.title })
    } else if (method === 'Target.targetDestroyed') {
      pages.delete(params.targetId)
      if (params.targetId === watched) {
        watched = ''
        session = ''
        const last = [...pages.keys()].at(-1)
        if (last) follow(last)
      }
    } else if (method === 'Page.screencastFrame' && message.sessionId === session) {
      send('Page.screencastFrameAck', { sessionId: params.sessionId }, session)
      emit({ type: 'frame', data: params.data, width: params.metadata.deviceWidth, height: params.metadata.deviceHeight })
    }
  }
  socket.onerror = () => {}
  socket.onclose = () => emit({ type: 'closed' })
  return () => socket.close()
}
