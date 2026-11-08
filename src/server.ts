import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConductor, runShellCheck } from './conductor.ts'
import { createWorktree, fileDiff, gitInfo, listFiles, readLog, readProjectFile, resolveInside, searchProject, showCommit } from './git.ts'
import { claudeAccount, codexAccount } from './accounts.ts'
import { runTurn, type StudioEvent } from './harness.ts'
import {
  english,
  isValidMemberName,
  projectFolder,
  toLocale,
  type Channel,
  type Harness,
  type Member
} from './model.ts'
import { findTranscript, listSessions } from './sessions.ts'
import { createSaver, loadState, whiplashHome } from './store.ts'
import { agentEnv } from './env.ts'
import { grantClaudeWorkspaceTrust, resolveLocalClaudeTrustConfig } from './orca/claude-folder-trust-file.ts'
import { readOrcaTerminalAppearance } from './orca-appearance.ts'
import { readUsage } from './usage.ts'
import { createTerminalHub } from './terminal.ts'
import { readTranscriptTurn } from './transcript.ts'

const PORT = Number(process.env.PORT ?? 4717)
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
}, publishState)

const conductor = createConductor({
  state,
  // An open terminal owns its session; resuming it headlessly beside the TUI would split the conversation.
  runTurn: (member, prompt, onEvent, signal) =>
    terminals.isOpen(member.id)
      ? terminals.typeTurn(member, prompt, signal)
      : runTurn(member, prompt, onEvent, signal),
  isAttached: (member) => terminals.isOpen(member.id),
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

function snapshot(): unknown {
  return {
    channels: state.channels,
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

function requireFolder(value: unknown): string {
  const path = requireText(value, 'folder')
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new HttpError(400, 'folderNotFound', { path })
  }
  return path
}

function requireMemberName(channel: Channel, value: unknown): string {
  const name = requireText(value, 'name')
  if (!isValidMemberName(name)) {
    throw new HttpError(400, 'invalidName')
  }
  if (channel.members.some((member) => member.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(400, 'nameTaken')
  }
  return name
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
  if (request.method === 'GET' && (parts[1] === 'channels' || parts[1] === 'members') && parts[3]) {
    // The side panels look at the folder the open tab works in: the channel's, or the agent's own.
    const folder = parts[1] === 'channels' ? channelById(id).cwd : projectFolder(memberById(id).member)
    return sendJson(response, 200, await readFolder(folder, parts[3], url.searchParams))
  }
  if (request.method !== 'POST') {
    throw new HttpError(404, 'notFound')
  }

  const body = await readJson(request)
  if (route === 'POST /api/channels') {
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
    const channel = channelById(id)
    const member = await addMember(channel, body)
    channel.members.push(member)
    publishState()
    return sendJson(response, 201, { id: member.id })
  }
  if (parts[1] === 'channels' && parts[3] === 'messages') {
    conductor.sendHumanMessage(
      channelById(id),
      requireText(body.text, 'message'),
      toLocale(body.locale)
    )
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
    const folder = parts[1] === 'channels' ? channelById(id).cwd : projectFolder(memberById(id).member)
    const path = typeof body.path === 'string' && body.path ? body.path : ''
    const target = path
      ? await resolveInside(folder, path).catch(() => {
          throw new HttpError(404, 'notFound')
        })
      : folder
    revealInFileManager(target)
    return sendJson(response, 200, {})
  }
  if (parts[1] === 'members' && parts[3] === 'remove') {
    const { channel } = memberById(id)
    conductor.stop(id)
    terminals.close(id)
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
    // xterm positions its rows with inline styles; scripts stay limited to this origin.
    'content-security-policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
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

server.listen(PORT, HOST, () => {
  console.log(`Whiplash: http://${HOST}:${PORT}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    conductor.stopAll()
    terminals.closeAll()
    saver.flush()
    process.exit(0)
  })
}
