import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConductor, runShellCheck } from './conductor.ts'
import { createWorktree, fileDiff, gitInfo } from './git.ts'
import { runTurn, type StudioEvent } from './harness.ts'
import { isValidMemberName, type Channel, type Harness, type Member } from './model.ts'
import { findTranscript, listSessions } from './sessions.ts'
import { createSaver, loadState, whiplashHome } from './store.ts'
import { readTranscriptTurn } from './transcript.ts'

const PORT = Number(process.env.PORT ?? 4717)
const HOST = '127.0.0.1'
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const MAX_BODY_BYTES = 1024 * 1024
// ponytail: Studio logs live in memory; the CLI transcript stays the durable record after a restart.
const LOG_LIMIT = 500
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
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

const conductor = createConductor({
  state,
  runTurn,
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
  return { channels: state.channels, activity: conductor.activityOf() }
}

function channelById(id: string): Channel {
  const channel = state.channels.find((candidate) => candidate.id === id)
  if (!channel) {
    throw new HttpError(404, '채널이 없습니다.')
  }
  return channel
}

function memberById(id: string): { channel: Channel; member: Member } {
  const channel = conductor.channelOf(id)
  const member = channel?.members.find((candidate) => candidate.id === id)
  if (!channel || !member) {
    throw new HttpError(404, '멤버가 없습니다.')
  }
  return { channel, member }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${label}이(가) 필요합니다.`)
  }
  return value.trim()
}

function requireFolder(value: unknown): string {
  const path = requireText(value, '폴더')
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new HttpError(400, `폴더를 찾을 수 없습니다: ${path}`)
  }
  return path
}

function requireMemberName(channel: Channel, value: unknown): string {
  const name = requireText(value, '이름')
  if (!isValidMemberName(name)) {
    throw new HttpError(400, '이름은 글자, 숫자, -, _만 쓸 수 있고 all은 예약어입니다.')
  }
  if (channel.members.some((member) => member.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(400, '이미 있는 이름입니다.')
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
      throw new HttpError(400, '이미 가져온 세션입니다.')
    }
    const session = (await listSessions(undefined, Number.MAX_SAFE_INTEGER)).find(
      (candidate) => candidate.id === body.sessionId && candidate.harness === harness
    )
    if (!session) {
      throw new HttpError(404, '세션을 찾을 수 없습니다.')
    }
    return {
      ...base,
      harness,
      cwd: session.cwd,
      sessionId: session.id,
      deliveredThrough: joinedAt
    }
  }
  if (body.harness !== 'claude' && body.harness !== 'codex') {
    throw new HttpError(400, '에이전트 종류는 claude 또는 codex입니다.')
  }
  const cwd = body.worktree
    ? await createWorktree(
        channel.cwd,
        join(whiplashHome, 'worktrees'),
        channel.name,
        name,
        id.slice(0, 6)
      )
    : channel.cwd
  return { ...base, harness: body.harness, cwd }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'JSON만 받습니다.')
  }
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > MAX_BODY_BYTES) {
      throw new HttpError(413, '요청이 너무 큽니다.')
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
  if (route === 'GET /api/sessions') {
    const taken = new Set(
      state.channels.flatMap(({ members }) => members.map(({ sessionId }) => sessionId))
    )
    const sessions = (await listSessions()).filter(({ id: sessionId }) => !taken.has(sessionId))
    return sendJson(response, 200, { sessions })
  }
  if (request.method === 'GET' && parts[1] === 'members' && parts[3] === 'studio') {
    const { member } = memberById(id)
    return sendJson(response, 200, { log: logs.get(id) ?? [], git: await gitInfo(member.cwd) })
  }
  if (request.method === 'GET' && parts[1] === 'members' && parts[3] === 'diff') {
    const { member } = memberById(id)
    const diff = await fileDiff(member.cwd, url.searchParams.get('path') ?? '').catch((error) => {
      throw new HttpError(400, error.message)
    })
    return sendJson(response, 200, { diff })
  }
  if (request.method !== 'POST') {
    throw new HttpError(404, '없는 경로입니다.')
  }

  const body = await readJson(request)
  if (route === 'POST /api/channels') {
    const channel: Channel = {
      id: randomUUID(),
      name: requireText(body.name, '채널 이름'),
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
    const member = await addMember(channel, body).catch((error) => {
      throw error instanceof HttpError ? error : new HttpError(400, error.message)
    })
    channel.members.push(member)
    publishState()
    return sendJson(response, 201, { id: member.id })
  }
  if (parts[1] === 'channels' && parts[3] === 'messages') {
    conductor.sendHumanMessage(channelById(id), requireText(body.text, '메시지'))
    return sendJson(response, 202, {})
  }
  if (parts[1] === 'members' && parts[3] === 'reject') {
    memberById(id)
    conductor.reject(id)
    return sendJson(response, 202, {})
  }
  if (parts[1] === 'members' && parts[3] === 'stop') {
    memberById(id)
    conductor.stop(id)
    return sendJson(response, 202, {})
  }
  if (parts[1] === 'members' && parts[3] === 'remove') {
    const { channel } = memberById(id)
    conductor.stop(id)
    channel.members = channel.members.filter((member) => member.id !== id)
    publishState()
    return sendJson(response, 200, {})
  }
  throw new HttpError(404, '없는 경로입니다.')
}

async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
  const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1))
  const path = join(PUBLIC_DIR, relative)
  if (!path.startsWith(PUBLIC_DIR + sep)) {
    throw new HttpError(404, '없는 경로입니다.')
  }
  const content = await readFile(path).catch(() => {
    throw new HttpError(404, '없는 경로입니다.')
  })
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
    'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff'
  })
  response.end(content)
}

const server = createServer((request, response) => {
  void (async () => {
    if (!isTrustedRequest(request)) {
      throw new HttpError(403, '허용되지 않은 출처입니다.')
    }
    const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url)
    } else {
      await serveStatic(response, url.pathname)
    }
  })().catch((error: Error) => {
    if (error instanceof SyntaxError) {
      sendJson(response, 400, { error: 'JSON 형식이 잘못됐습니다.' })
      return
    }
    const status = error instanceof HttpError ? error.status : 500
    if (status === 500) {
      console.error(error)
    }
    sendJson(response, status, { error: status === 500 ? '서버 오류입니다.' : error.message })
  })
})

server.listen(PORT, HOST, () => {
  console.log(`Whiplash: http://${HOST}:${PORT}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    conductor.stopAll()
    saver.flush()
    process.exit(0)
  })
}
