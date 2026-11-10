import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConductor, runShellCheck } from './conductor.ts'
import { createProject, createWorktree, fileDiff, gitInfo, listFiles, readLog, readProjectFile, resolveInside, searchProject, showCommit } from './git.ts'
import { claudeAccount, codexAccount } from './accounts.ts'
import { probeCommands, runTurn, type StudioEvent } from './harness.ts'
import {
  english,
  ATTACHMENT_TOKEN,
  isValidMemberName,
  type Attachment,
  linkEveryoneChannel,
  projectFolder,
  toLocale,
  type Channel,
  type Harness,
  type Member
} from './model.ts'
import { findTranscript, listSessions } from './sessions.ts'
import { createSaver, loadState, serverPort, whiplashHome } from './store.ts'
import { type BrowserWatch, ChromeNotFound, closeBrowser, ensureBrowser, goHistory, watchBrowser, writeBrowserWrapper } from './browser.ts'
import { agentEnv } from './env.ts'
import { grantClaudeWorkspaceTrust, resolveLocalClaudeTrustConfig } from './orca/claude-folder-trust-file.ts'
import { readOrcaTerminalAppearance } from './orca-appearance.ts'
import { readUsage } from './usage.ts'
import { codexPrompts, expandCodexPrompt, listModels } from './models.ts'
import { createTerminalHub } from './terminal.ts'
import { readTranscriptTurn } from './transcript.ts'

const PORT = serverPort
const HOST = '127.0.0.1'
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = join(ROOT_DIR, 'public')
/** Only these files leave node_modules, so the page can load xterm without a bundler. */
const VENDOR_FILES: Record<string, string> = {
  '/vendor/xterm.mjs': join(ROOT_DIR, 'node_modules/@xterm/xterm/lib/xterm.mjs'),
  '/vendor/xterm.css': join(ROOT_DIR, 'node_modules/@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.mjs': join(ROOT_DIR, 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs'),
  '/vendor/addon-unicode11.mjs': join(ROOT_DIR, 'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs'),
  '/vendor/addon-webgl.mjs': join(ROOT_DIR, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs')
}
const TERMINAL_MIN = 2
const TERMINAL_MAX = 1000
const MAX_BODY_BYTES = 1024 * 1024
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
// ponytail: Studio logs live in memory; the CLI transcript stays the durable record after a restart.
const LOG_LIMIT = 500
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
}

/** Errors carry a code the browser translates; `message` is English for API clients. */
class HttpError extends Error {
  status: number
  code: string
  params: Record<string, string>
  constructor(status: number, code: string, params: Record<string, string> = {}) {
    const field = params.field ? { field: english(`fields.${params.field}`) } : {}
    super(english(`errors.${code}`, { ...params, ...field }))
    this.status = status
    this.code = code
    this.params = params
  }
}

const state = loadState()
const everyone = linkEveryoneChannel(state)
const saver = createSaver(state)
const logs = new Map<string, (StudioEvent & { at: number })[]>()
const streams = new Set<ServerResponse>()

function broadcast(type: string, data: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const stream of streams) {
    stream.write(frame)
  }
}

let stateFrame: NodeJS.Immediate | null = null
function publishState(): void {
  saver.schedule()
  stateFrame ??= setImmediate(() => {
    stateFrame = null
    broadcast('state', snapshot())
  })
}

const terminals = createTerminalHub((memberId, sessionId) => {
  const member = conductor.channelOf(memberId)?.members.find(({ id }) => id === memberId)
  if (member) {
    member.sessionId = sessionId
    publishState()
  }
}, publishState, (memberId) => {
  const member = conductor.channelOf(memberId)?.members.find(({ id }) => id === memberId)
  if (member) {
    member.lastTurnEndedAt = Date.now()
    publishState()
  }
})

const conductor = createConductor({
  state,
  // An open terminal owns its session; resuming it headlessly beside the TUI would split the conversation.
  runTurn: (member, prompt, onEvent, signal) =>
    terminals.isOpen(member.id)
      ? terminals.typeTurn(member, prompt, signal)
      : runTurn(member, prompt, onEvent, signal),
  isAttached: (member) => terminals.isOpen(member.id),
  // A turn that already ended would take the words as a new turn nobody reads back, so they wait instead.
  canInject: (member) => terminals.statusOf(member.id)?.state === 'working',
  inject: (member, prompt) => terminals.inject(member.id, prompt),
  // An open TUI keeps the old conversation in memory, so it closes first; reopening resumes the new state.
  async sessionCommand(member, command, args, onEvent, signal) {
    if (command === 'clear') {
      clearSession(member)
      return { ok: true, text: '' }
    }
    if (command === 'model' || command === 'compact') {
      terminals.close(member.id)
    }
    if (command === 'model') {
      return { ok: true, text: '' }
    }
    const prompt = member.harness === 'codex' ? await expandCodexPrompt(command, args) : `/${command} ${args}`.trim()
    return runTurn(member, prompt, onEvent, signal)
  },
  commandsOf,
  runCheck: runShellCheck,
  async readSession(member) {
    const path = member.sessionId ? await findTranscript(member.harness, member.sessionId) : null
    if (!path) {
      return null
    }
    const [turn, info] = await Promise.all([readTranscriptTurn(path), stat(path)])
    return { ...turn, updatedAt: info.mtimeMs }
  },
  onChange: publishState,
  onStudioEvent(memberId, event) {
    const entry = { ...event, at: Date.now() }
    const log = logs.get(memberId) ?? []
    log.push(entry)
    log.splice(0, log.length - LOG_LIMIT)
    logs.set(memberId, log)
    broadcast('log', { memberId, entry })
  }
})

/** A Claude member that has not started since this was added borrows another's list; most commands are global. */
function commandsOf(member: Member): string[] {
  if (member.harness === 'codex') return codexPrompts()
  return member.slashCommands ?? everyone.members.find(({ slashCommands }) => slashCommands)?.slashCommands ?? []
}

function snapshot(): unknown {
  return {
    channels: state.channels,
    commands: Object.fromEntries(everyone.members.map((member) => [member.id, commandsOf(member)])),
    activity: conductor.activityOf(),
    queued: conductor.queuedOf(),
    terminals: terminals.openIds(),
    terminalStatus: terminals.statuses()
  }
}

function channelById(id: string): Channel {
  const channel = state.channels.find((candidate) => candidate.id === id)
  if (!channel) {
    throw new HttpError(404, 'channelNotFound')
  }
  return channel
}

/** #all borrows every agent but owns no folder, so hiring, importing and file views stay in the home channels. */
function folderChannelById(id: string): Channel {
  const channel = channelById(id)
  if (channel.everyone) {
    throw new HttpError(400, 'everyoneChannel')
  }
  return channel
}

function memberById(id: string): { channel: Channel; member: Member } {
  const channel = conductor.channelOf(id)
  const member = channel?.members.find((candidate) => candidate.id === id)
  if (!channel || !member) {
    throw new HttpError(404, 'memberNotFound')
  }
  return { channel, member }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'required', { field })
  }
  return value.trim()
}

const ATTACHMENT_LIMIT = 20
const PASTED_TEXT_LIMIT = 500_000

/** Paste tokens the composer made; each must still be in the text, and stand for an image path or pasted text. */
function requireAttachments(value: unknown, text: string): Attachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMIT) throw new HttpError(400, 'badAttachment')
  return value.map((item): Attachment => {
    const token = item?.token
    if (typeof token !== 'string' || !ATTACHMENT_TOKEN.test(token) || !text.includes(token)) throw new HttpError(400, 'badAttachment')
    if (item.kind === 'image' && typeof item.path === 'string' && isAbsolute(item.path)) return { token, kind: 'image', path: item.path }
    if (item.kind === 'text' && typeof item.text === 'string' && item.text.length <= PASTED_TEXT_LIMIT) return { token, kind: 'text', text: item.text }
    throw new HttpError(400, 'badAttachment')
  })
}

const expandHome = (path: string): string => path.replace(/^~(?=\/|$)/, homedir())

function requireFolder(value: unknown): string {
  const path = expandHome(requireText(value, 'folder'))
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new HttpError(400, 'folderNotFound', { path })
  }
  return path
}

function requireMemberName(channel: Channel, value: unknown, renaming?: string): string {
  const name = requireText(value, 'name')
  if (!isValidMemberName(name)) {
    throw new HttpError(400, 'invalidName')
  }
  // Names are unique across channels, since #all puts every agent in one room.
  if (everyone.members.some((member) => member.id !== renaming && member.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(400, 'nameTaken')
  }
  return name
}

/** Claude Code's /clear for a member: its next turn starts a new session with the room briefing; files stay. */
function clearSession(member: Member): void {
  terminals.close(member.id)
  member.sessionId = undefined
  member.contextTokens = undefined
  member.windowTokens = undefined
}

async function addMember(channel: Channel, body: Record<string, unknown>): Promise<Member> {
  const name = requireMemberName(channel, body.name)
  const id = randomUUID()
  const base = { id, name, instructions: String(body.instructions ?? ''), deliveredThrough: 0 }
  // Imported agents hear only what is said from now on; their own session is their memory.
  const joinedAt = channel.nextSeq - 1
  if (typeof body.sessionId === 'string') {
    const harness = body.harness as Harness
    if (state.channels.some(({ members }) => members.some((m) => m.sessionId === body.sessionId))) {
      throw new HttpError(400, 'sessionTaken')
    }
    const session = (await listSessions(undefined, Number.MAX_SAFE_INTEGER)).find(
      (candidate) => candidate.id === body.sessionId && candidate.harness === harness
    )
    if (!session) {
      throw new HttpError(404, 'sessionNotFound')
    }
    return {
      ...base,
      harness,
      cwd: session.cwd,
      // A session must resume from its original folder, so the channel's project is granted on top.
      ...(session.cwd === channel.cwd ? {} : { writableRoots: [channel.cwd] }),
      sessionId: session.id,
      deliveredThrough: joinedAt
    }
  }
  if (body.harness !== 'claude' && body.harness !== 'codex') {
    throw new HttpError(400, 'invalidHarness')
  }
  const cwd = body.worktree
    ? await createWorktree(
        channel.cwd,
        join(whiplashHome, 'worktrees'),
        channel.name,
        name,
        id.slice(0, 6)
      ).catch((error: Error) => {
        throw new HttpError(400, 'worktreeFailed', { detail: error.message.trim() })
      })
    : channel.cwd
  if (body.worktree && body.harness === 'claude') {
    // As Orca does: a folder Whiplash just made needs no trust prompt. A busy config only means the prompt still shows.
    await grantClaudeWorkspaceTrust(resolveLocalClaudeTrustConfig(agentEnv()), cwd).catch(() => 'unreadable')
  }
  return { ...base, harness: body.harness, cwd }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'jsonOnly')
  }
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > MAX_BODY_BYTES) {
      throw new HttpError(413, 'tooLarge')
    }
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

/**
 * A file dropped into a browser tab has no path on disk, so it is saved under ~/.whiplash/uploads and
 * its path goes into the message. The custom header keeps other origins out: it forces a CORS preflight.
 */
async function saveUpload(request: IncomingMessage): Promise<string> {
  if (request.headers['x-whiplash-upload'] !== '1') {
    throw new HttpError(400, 'badUpload')
  }
  const raw = decodeURIComponent(String(request.headers['x-whiplash-name'] ?? 'file'))
  const name = raw.replace(/[\\/\0]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file'
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, 'tooLarge')
    }
    chunks.push(chunk)
  }
  const folder = join(whiplashHome, 'uploads', randomUUID())
  await mkdir(folder, { recursive: true })
  const path = join(folder, name)
  await writeFile(path, Buffer.concat(chunks))
  return path
}

/** This server can drive agents on the machine, so pages from other origins must never reach it. */
function isTrustedRequest(request: IncomingMessage): boolean {
  const allowed = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
  const origin = request.headers.origin
  return (
    allowed.has(request.headers.host ?? '') &&
    (origin === undefined || allowed.has(origin.replace(/^https?:\/\//, '')))
  )
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function openEventStream(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive'
  })
  response.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`)
  streams.add(response)
  request.on('close', () => streams.delete(response))
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  const route = `${request.method} ${url.pathname}`
  const parts = url.pathname.split('/').filter(Boolean)
  const id = parts[2] ?? ''

  if (route === 'GET /api/events') {
    return openEventStream(request, response)
  }
  if (route === 'GET /api/usage') {
    return sendJson(response, 200, await readUsage(url.searchParams.has('force')))
  }
  if (route === 'GET /api/terminal-appearance') {
    return sendJson(response, 200, await readOrcaTerminalAppearance())
  }
  if (route === 'GET /api/sessions') {
    const taken = new Set(
      state.channels.flatMap(({ members }) => members.map(({ sessionId }) => sessionId))
    )
    const sessions = (await listSessions()).filter(({ id: sessionId }) => !taken.has(sessionId))
    return sendJson(response, 200, { sessions })
  }
  if (route === 'GET /api/models') {
    return sendJson(response, 200, await listModels())
  }
  if (route === 'GET /api/accounts') {
    const [claude, codex] = await Promise.all([claudeAccount(), codexAccount()])
    return sendJson(response, 200, { claude, codex })
  }
  if (request.method === 'GET' && parts[1] === 'members' && parts[3] === 'studio') {
    memberById(id)
    return sendJson(response, 200, { log: logs.get(id) ?? [] })
  }
  if (request.method === 'GET' && parts[1] === 'members' && parts[3] === 'terminal') {
    memberById(id)
    return openTerminalStream(request, response, id)
  }
  // Before the folder views below, which would read `browser` as one of theirs.
  if (request.method === 'GET' && parts[1] === 'members' && parts[3] === 'browser' && parts[4] === 'stream') {
    memberById(id)
    return openBrowserStream(request, response, id)
  }
  if (request.method === 'GET' && (parts[1] === 'channels' || parts[1] === 'members') && parts[3]) {
    // The side panels look at the folder the open tab works in: the channel's, or the agent's own.
    const folder = parts[1] === 'channels' ? folderChannelById(id).cwd : projectFolder(memberById(id).member)
    return sendJson(response, 200, await readFolder(folder, parts[3], url.searchParams))
  }
  if (request.method !== 'POST') {
    throw new HttpError(404, 'notFound')
  }

  if (route === 'POST /api/uploads') {
    return sendJson(response, 201, { path: await saveUpload(request) })
  }
  const body = await readJson(request)
  if (parts[1] === 'members' && parts[3] === 'browser') {
    memberById(id)
    if (parts[4] === 'ensure') {
      const port = await ensureBrowser(id).catch(browserError)
      // An agent's own use, not a viewer reconnecting: the page adds the browser tab so the master can watch.
      if (body.agent) broadcast('browserUsed', { memberId: id })
      return sendJson(response, 200, { port })
    }
    if (parts[4] === 'close') {
      await closeBrowser(id)
      return sendJson(response, 200, {})
    }
    if (parts[4] === 'input') {
      await browserInput(id, body)
      return sendJson(response, 200, {})
    }
    throw new HttpError(404, 'notFound')
  }
  if (route === 'POST /api/terminal-colors') {
    terminals.setColors(body)
    return sendJson(response, 200, {})
  }
  if (route === 'POST /api/channels') {
    if (body.create) {
      const path = expandHome(requireText(body.cwd, 'folder'))
      // Never turn someone's existing folder into a fresh repository.
      if (!isAbsolute(path) || existsSync(path)) throw new HttpError(400, 'folderExists', { path })
      await createProject(path).catch((error: Error) => {
        throw new HttpError(400, 'projectFailed', { detail: error.message.trim() })
      })
    }
    const channel: Channel = {
      id: randomUUID(),
      name: requireText(body.name, 'channelName'),
      cwd: requireFolder(body.cwd),
      checkCommand: String(body.checkCommand ?? '').trim(),
      members: [],
      messages: [],
      nextSeq: 1,
      agentChain: 0
    }
    state.channels.push(channel)
    publishState()
    return sendJson(response, 201, { channel })
  }
  if (parts[1] === 'channels' && parts[3] === 'members') {
    const channel = folderChannelById(id)
    const member = await addMember(channel, body)
    channel.members.push(member)
    publishState()
    return sendJson(response, 201, { id: member.id })
  }
  if (parts[1] === 'channels' && parts[3] === 'messages') {
    const text = requireText(body.text, 'message')
    conductor.sendHumanMessage(channelById(id), text, toLocale(body.locale), requireAttachments(body.attachments, text))
    return sendJson(response, 202, {})
  }
  if (parts[1] === 'members' && parts[3] === 'reject') {
    memberById(id)
    conductor.reject(id, toLocale(body.locale))
    return sendJson(response, 202, {})
  }
  if (parts[1] === 'members' && parts[3] === 'stop') {
    memberById(id)
    conductor.stop(id)
    return sendJson(response, 202, {})
  }
  if (parts[1] === 'members' && parts[3] === 'terminal') {
    const { member } = memberById(id)
    const action = parts[4]
    if (action === 'open') {
      if (conductor.activityOf()[id]) {
        throw new HttpError(409, 'busy')
      }
      // A second live copy of a session another console is using would split its conversation.
      if (!terminals.isOpen(id) && (await conductor.isUsedElsewhere(member))) {
        throw new HttpError(409, 'sessionBusy')
      }
      terminals.open(member, terminalSize(body.cols, 120), terminalSize(body.rows, 32))
    } else if (action === 'input' && typeof body.data === 'string') {
      terminals.write(id, body.data)
    } else if (action === 'resize') {
      terminals.resize(id, terminalSize(body.cols, 120), terminalSize(body.rows, 32))
    } else if (action === 'close') {
      terminals.close(id)
    } else {
      throw new HttpError(404, 'notFound')
    }
    return sendJson(response, 200, {})
  }
  if ((parts[1] === 'channels' || parts[1] === 'members') && parts[3] === 'reveal') {
    const folder = parts[1] === 'channels' ? folderChannelById(id).cwd : projectFolder(memberById(id).member)
    const path = typeof body.path === 'string' && body.path ? body.path : ''
    const target = path
      ? await resolveInside(folder, path).catch(() => {
          throw new HttpError(404, 'notFound')
        })
      : folder
    revealInFileManager(target)
    return sendJson(response, 200, {})
  }
  if (parts[1] === 'members' && parts[3] === 'reset') {
    const { member } = memberById(id)
    if (conductor.activityOf()[id]) {
      throw new HttpError(409, 'busy')
    }
    clearSession(member)
    publishState()
    return sendJson(response, 200, {})
  }
  if (parts[1] === 'members' && parts[3] === 'update') {
    const { channel, member } = memberById(id)
    if (body.name !== undefined) member.name = requireMemberName(channel, body.name, member.id)
    if (typeof body.pinned === 'boolean') member.pinned = body.pinned || undefined
    publishState()
    return sendJson(response, 200, {})
  }
  if (parts[1] === 'channels' && parts[3] === 'update') {
    const channel = channelById(id)
    if (body.name !== undefined) channel.name = requireText(body.name, 'channelName')
    publishState()
    return sendJson(response, 200, {})
  }
  if (parts[1] === 'channels' && parts[3] === 'remove') {
    const channel = folderChannelById(id)
    for (const member of channel.members) {
      conductor.stop(member.id)
      terminals.close(member.id)
      void closeBrowser(member.id)
    }
    state.channels = state.channels.filter((candidate) => candidate.id !== id)
    publishState()
    return sendJson(response, 200, {})
  }
  if (parts[1] === 'members' && parts[3] === 'remove') {
    const { channel } = memberById(id)
    conductor.stop(id)
    terminals.close(id)
    void closeBrowser(id)
    channel.members = channel.members.filter((member) => member.id !== id)
    publishState()
    return sendJson(response, 200, {})
  }
  throw new HttpError(404, 'notFound')
}

/** Orca's "Reveal in Finder": select the item in the platform's file manager. */
function revealInFileManager(target: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', ['-R', target]]
      : process.platform === 'win32'
        ? ['explorer.exe', [`/select,${target}`]]
        : ['xdg-open', [dirname(target)]]
  spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
}

async function readFolder(folder: string, view: string, params: URLSearchParams): Promise<unknown> {
  const path = params.get('path') ?? ''
  if (view === 'git') return { folder, git: await gitInfo(folder) }
  if (view === 'files') return { folder, ...(await listFiles(folder)) }
  if (view === 'search') return searchProject(folder, params.get('q') ?? '')
  if (view === 'log') return { commits: await readLog(folder) }
  if (view === 'file') {
    return readProjectFile(folder, path).catch(() => {
      throw new HttpError(404, 'notFound')
    })
  }
  if (view === 'diff') {
    const diff = await fileDiff(folder, path).catch(() => {
      throw new HttpError(400, 'notChanged')
    })
    return { diff }
  }
  if (view === 'commit') {
    const text = await showCommit(folder, params.get('sha') ?? '').catch(() => {
      throw new HttpError(404, 'notFound')
    })
    return { text }
  }
  throw new HttpError(404, 'notFound')
}

function terminalSize(value: unknown, fallback: number): number {
  const size = Math.round(Number(value))
  return Number.isFinite(size) ? Math.min(TERMINAL_MAX, Math.max(TERMINAL_MIN, size)) : fallback
}

function openTerminalStream(request: IncomingMessage, response: ServerResponse, memberId: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  const unsubscribe = terminals.subscribe(memberId, (event) => {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  })
  if (!unsubscribe) {
    response.end('event: exit\ndata: {"type":"exit","code":0}\n\n')
    return
  }
  request.on('close', unsubscribe)
}

function browserError(error: Error): never {
  throw error instanceof ChromeNotFound ? new HttpError(503, 'chromeNotFound') : new HttpError(500, 'browserFailed', { detail: error.message })
}

/** Open browser views by the id their stream was given, so input reaches the page that viewer sees. */
const viewers = new Map<string, { memberId: string; watch: BrowserWatch }>()
/** What the owner's hands may send a page; nothing that reads it back or runs script. */
const BROWSER_INPUT = new Set(['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Page.navigate', 'Page.reload'])

/** The member's Chrome as SSE: `viewer` (this view's id), `pages`, `frame` (a JPEG), ending with `closed`. */
async function openBrowserStream(request: IncomingMessage, response: ServerResponse, memberId: string): Promise<void> {
  // The CDP socket opens on a later tick, so the head is written before any event arrives.
  const watch = await watchBrowser(memberId, (event) => {
    if (response.writableEnded || response.destroyed) return
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    if (event.type === 'closed') response.end()
  }).catch(browserError)
  // Chrome can take seconds to start; a viewer who left meanwhile must not leave the CDP socket behind.
  if (request.socket.destroyed) return watch.stop()
  const viewer = randomUUID()
  viewers.set(viewer, { memberId, watch })
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  response.write(`event: viewer\ndata: ${JSON.stringify({ viewer })}\n\n`)
  response.on('close', () => {
    viewers.delete(viewer)
    watch.stop()
  })
}

/**
 * The owner taking the wheel from a browser tab. Agent and owner may act at once.
 * ponytail: no lock between them; add one if they really trip over each other.
 */
async function browserInput(memberId: string, body: Record<string, unknown>): Promise<void> {
  const view = viewers.get(String(body.viewer))
  if (view?.memberId !== memberId) throw new HttpError(409, 'notWatching')
  if (typeof body.select === 'string') return view.watch.select(body.select)
  if (body.history === -1 || body.history === 1) return goHistory(view.watch, body.history)
  const params = body.params ?? {}
  if (typeof body.method !== 'string' || !BROWSER_INPUT.has(body.method) || typeof params !== 'object') throw new HttpError(400, 'badInput')
  await view.watch.call(body.method, params)
}

async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
  const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1))
  const path = VENDOR_FILES[pathname] ?? join(PUBLIC_DIR, relative)
  if (!VENDOR_FILES[pathname] && !path.startsWith(PUBLIC_DIR + sep)) {
    throw new HttpError(404, 'notFound')
  }
  const content = await readFile(path).catch(() => {
    throw new HttpError(404, 'notFound')
  })
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
    // The app's files change under a running server when it is rebuilt; always revalidate them.
    'cache-control': 'no-cache',
    // xterm positions its rows with inline styles; scripts stay limited to this origin.
    'content-security-policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff'
  })
  response.end(content)
}

const server = createServer((request, response) => {
  void (async () => {
    if (!isTrustedRequest(request)) {
      throw new HttpError(403, 'forbidden')
    }
    const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url)
    } else {
      await serveStatic(response, url.pathname)
    }
  })().catch((error: Error) => {
    const known =
      error instanceof HttpError
        ? error
        : error instanceof SyntaxError
          ? new HttpError(400, 'badJson')
          : null
    if (!known) {
      console.error(error)
    }
    const failure = known ?? new HttpError(500, 'server')
    sendJson(response, failure.status, {
      error: failure.code,
      params: failure.params,
      message: failure.message
    })
  })
})

// Agents left running by the previous server come back before anyone can ask for them.
await terminals.ready
writeBrowserWrapper()
// Members from before command lists were kept learn theirs now, so `/` offers everything before their next turn.
for (const member of everyone.members.filter(({ harness, slashCommands }) => harness === 'claude' && !slashCommands)) {
  void probeCommands(member).then((found) => {
    if (found.length) {
      member.slashCommands = found
      publishState()
    }
  })
}
server.listen(PORT, HOST, () => {
  console.log(`Whiplash: http://${HOST}:${PORT}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Terminals live in the PTY host and keep running; only closing one in the UI ends it.
    conductor.stopAll()
    saver.flush()
    process.exit(0)
  })
}
