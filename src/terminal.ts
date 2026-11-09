import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { memberEnv } from './env.ts'
import type { TurnResult } from './harness.ts'
import { buildAgentPromptPasteBytes, getAgentPromptSubmitDelayMs } from './orca/agent-prompt-injection.ts'
import { createProgramStatusOscScanner } from './orca/program-status/osc-scanner.ts'
import { PROGRAM_STATUS_QUERY_REPLY, type ProgramStatusState } from './orca/program-status/protocol.ts'
import { modelArgs, type Harness, type Member } from './model.ts'
import { BUFFER_LIMIT, createLineSplitter, PTY_HOST_VERSION, socketPath } from './pty-host.ts'
import { findTranscript } from './sessions.ts'
import { whiplashHome } from './store.ts'
import { parseTranscriptTurn } from './transcript.ts'

type Pty = {
  cols: number
  rows: number
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (event: { exitCode: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
}

const POLL_MS = 800
/** A dialog that reports itself as blocked has clearly swallowed the prompt; no need to wait the full timeout. */
const BLOCKED_GRACE_MS = 3000
const SESSION_DISCOVERY_MS = 60_000
/** A typed prompt shows up in the transcript within seconds unless a dialog swallowed it. */
const PROMPT_ACCEPT_MS = 20_000
/** Claude Code starts a queued follow-up the moment a turn ends; this is long enough to see its prompt row. */
const FOLLOW_UP_SETTLE_MS = 1500
const HOST_START_MS = 10_000
const HOST_RECONNECT_MS = 1000
const HOST_PATH = fileURLToPath(new URL('./pty-host.ts', import.meta.url))

/** Starts the PTY host detached, on our runtime and env (ELECTRON_RUN_AS_NODE included), so it outlives us. */
function spawnHost(home: string): void {
  mkdirSync(home, { recursive: true })
  const log = openSync(join(home, 'pty-host.log'), 'a')
  spawn(process.execPath, [HOST_PATH], {
    cwd: home,
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, WHIPLASH_HOME: home }
  }).unref()
  closeSync(log)
}

const connectOnce = (path: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })

/** Connects to the host, starting one only when nobody listens; a timeout or unknown error is not a dead host. */
export async function connectPtyHost(home: string = whiplashHome): Promise<Socket> {
  const deadline = Date.now() + HOST_START_MS
  let spawned = false
  while (true) {
    try {
      return await connectOnce(socketPath(home))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error
      if (!spawned) spawnHost(home)
      spawned = true
      if (Date.now() > deadline) throw new Error(`PTY host did not start; see ${join(home, 'pty-host.log')}`)
      await delay(100)
    }
  }
}

/** What the host keeps beside a session so a restarted server can pick up where it left off. */
type SessionMeta = { harness: Harness; cwd: string; startedAt: number; sessionId?: string; discover: boolean }

/** The interactive CLI for a member; a new Claude session gets its id up front so Stage can follow it. */
export function interactiveCommand(
  member: Pick<Member, 'harness' | 'sessionId' | 'writableRoots' | 'model' | 'effort'>,
  newSessionId: () => string = randomUUID
): { command: string; args: string[]; sessionId?: string } {
  const roots = member.writableRoots ?? []
  if (member.harness === 'claude') {
    const sessionId = member.sessionId ?? newSessionId()
    return {
      command: 'claude',
      args: [
        ...roots.flatMap((root) => ['--add-dir', root]),
        ...modelArgs(member),
        ...(member.sessionId ? ['--resume', sessionId] : ['--session-id', sessionId])
      ],
      sessionId
    }
  }
  const config = roots.length ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`] : []
  return {
    command: 'codex',
    args: [...config, ...modelArgs(member), ...(member.sessionId ? ['resume', member.sessionId] : [])],
    sessionId: member.sessionId
  }
}

/** `length` is how much of `appended` the turn took, through its stop marker's line. */
type TurnEnd = { prompted: boolean; done: boolean; aborted: boolean; length: number }

/** A turn ends with a stop marker written after the prompt we typed; earlier markers belong to old turns. */
export function findTurnEnd(harness: Harness, appended: string): TurnEnd {
  let prompted = false
  let length = 0
  for (const line of appended.split('\n')) {
    length += line.length + 1
    let row: { type?: string; subtype?: string; isSidechain?: boolean; message?: { content?: unknown }; payload?: { type?: string } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (harness === 'claude') {
      const content = row.message?.content
      const isPrompt =
        row.type === 'user' &&
        !row.isSidechain &&
        (typeof content === 'string' ||
          (Array.isArray(content) && content.some((block) => block?.type === 'text')))
      prompted ||= isPrompt
      if (prompted && row.type === 'system' && (row.subtype === 'turn_duration' || row.subtype === 'stop_hook_summary')) {
        return { prompted, done: true, aborted: false, length }
      }
    } else {
      // Turn markers and their aliases follow Orca's reconcileCodexTranscriptTurn (src/orca/codex-turn-transcript.ts).
      const payload = row.type === 'event_msg' ? (row.payload as { type?: string; reason?: string } | undefined) : undefined
      const kind = payload?.type
      prompted ||= kind === 'task_started' || kind === 'turn_started'
      if (prompted && (kind === 'task_complete' || kind === 'turn_complete')) {
        return { prompted, done: true, aborted: false, length }
      }
      if (prompted && kind === 'turn_aborted') {
        return { prompted, done: true, aborted: payload?.reason === 'interrupted' || payload?.reason === undefined, length }
      }
    }
  }
  return { prompted, done: false, aborted: false, length: appended.length }
}

async function readFrom(path: string, offset: number): Promise<string> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const length = Math.max(0, size - offset)
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, offset)
    return buffer.toString('utf8')
  } finally {
    await file.close()
  }
}

/** Codex picks its own thread id, so a fresh terminal session is matched by folder and start time. */
async function findNewCodexSession(cwd: string, since: number, home = homedir()): Promise<string | null> {
  const root = join(home, '.codex', 'sessions')
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue
    }
    const path = join(entry.parentPath, entry.name)
    if ((await stat(path)).birthtimeMs < since) {
      continue
    }
    const head = (await readFrom(path, 0)).split('\n', 1)[0]
    try {
      const meta = JSON.parse(head)
      if (meta.type === 'session_meta' && meta.payload?.cwd === cwd) {
        return meta.payload.id
      }
    } catch {
      continue
    }
  }
  return null
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type TerminalStatus = { state: ProgramStatusState; kind?: string }

type Session = {
  pty: Pty
  buffer: string
  /** Root status the CLI reports over OSC 7501; absent until it answers our probe reply. */
  status?: TerminalStatus
  listeners: Set<(event: TerminalEvent) => void>
  /** Known to the terminal before the member records it, which waits until the transcript exists. */
  sessionId?: string
}
export type TerminalEvent = { type: 'data'; data: string; cols?: number; rows?: number } | { type: 'exit'; code: number }

export function createTerminalHub(
  onSessionId: (memberId: string, sessionId: string) => void,
  onChange: () => void,
  /** A turn typed straight into the terminal finished: its OSC 7501 status left 'working'. */
  onTurnEnd: (memberId: string) => void = () => {},
  home: string = whiplashHome
) {
  const sessions = new Map<string, Session>()
  /** Live PTYs by member id, fed by host events; a session may outlive the server that opened it. */
  const remotes = new Map<string, { data: (data: string) => void; exit: (code: number) => void }>()
  let host: Socket | null = null

  const send = (message: object): void => {
    host?.write(JSON.stringify(message) + '\n')
  }

  /** A PTY that lives in the host: same shape as node-pty's, every call becomes a request. */
  function remotePty(id: string, cols: number, rows: number): Pty {
    let onData = (_data: string): void => {}
    let onExit = (_event: { exitCode: number }): void => {}
    remotes.set(id, { data: (data) => onData(data), exit: (exitCode) => onExit({ exitCode }) })
    const pty: Pty = {
      cols,
      rows,
      onData: (listener) => (onData = listener),
      onExit: (listener) => (onExit = listener),
      write: (data) => send({ type: 'write', id, data }),
      resize(cols, rows) {
        pty.cols = cols
        pty.rows = rows
        send({ type: 'resize', id, cols, rows })
      },
      kill: () => send({ type: 'kill', id })
    }
    return pty
  }

  function emit(session: Session, event: TerminalEvent): void {
    session.listeners.forEach((listener) => listener(event))
  }

  /** Follows a PTY's output; `replay` is a reattached session's backlog, read only to recover its last status. */
  function attach(memberId: string, session: Session, meta: SessionMeta, replay = ''): void {
    const { pty } = session
    sessions.set(memberId, session)
    const scan = createProgramStatusOscScanner()
    const track = (data: string, live: boolean): void => {
      for (const event of scan(data)) {
        if (event.type === 'query') {
          // Claude reports program status only to a terminal that answers this probe.
          if (live) pty.write(PROGRAM_STATUS_QUERY_REPLY)
        } else if (event.type === 'report' && event.report.id === null && event.report.state !== 'clear') {
          const next: TerminalStatus = { state: event.report.state, ...(event.report.kind ? { kind: event.report.kind } : {}) }
          if (next.state !== session.status?.state || next.kind !== session.status?.kind) {
            if (live && session.status?.state === 'working' && next.state !== 'working') onTurnEnd(memberId)
            session.status = next
            if (live) onChange()
          }
        } else if (event.type === 'report' && event.report.id === null) {
          session.status = undefined
          if (live) onChange()
        }
      }
    }
    track(replay, false)
    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT)
      emit(session, { type: 'data', data })
      track(data, true)
    })
    pty.onExit(({ exitCode }) => {
      remotes.delete(memberId)
      sessions.delete(memberId)
      emit(session, { type: 'exit', code: exitCode })
      onChange()
    })
    if (meta.discover) {
      // A pinned id is only recorded once the CLI writes it; a terminal closed before the first prompt leaves nothing to resume.
      void (async () => {
        while (Date.now() - meta.startedAt < SESSION_DISCOVERY_MS && sessions.get(memberId) === session) {
          await delay(2000)
          const found = meta.sessionId
            ? (await findTranscript(meta.harness, meta.sessionId)) && meta.sessionId
            : await findNewCodexSession(meta.cwd, meta.startedAt)
          if (found) {
            session.sessionId = found
            onSessionId(memberId, found)
            return
          }
        }
      })()
    }
    onChange()
  }

  function openTerminal(member: Member, cols: number, rows: number): void {
    if (sessions.has(member.id)) {
      sessions.get(member.id)!.pty.resize(cols, rows)
      return
    }
    if (!host) throw new Error('PTY host is not connected')
    const { command, args, sessionId } = interactiveCommand(member)
    const meta: SessionMeta = {
      harness: member.harness,
      cwd: member.cwd,
      startedAt: Date.now(),
      sessionId,
      discover: sessionId !== member.sessionId || !sessionId
    }
    const pty = remotePty(member.id, cols, rows)
    send({
      type: 'open',
      id: member.id,
      command,
      args,
      cwd: member.cwd,
      env: { ...memberEnv(member.id), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      cols,
      rows,
      meta
    })
    attach(member.id, { pty, buffer: '', listeners: new Set(), sessionId }, meta)
  }

  /** Connects (starting the host if needed) and takes back every session still running there. */
  async function connectHost(): Promise<void> {
    const socket = await connectPtyHost(home)
    socket.setEncoding('utf8')
    let listed = (): void => {}
    const relisted = new Promise<void>((resolve) => {
      listed = resolve
      socket.on(
        'data',
        createLineSplitter((line) => {
          const message = JSON.parse(line)
          if (message.type === 'data') remotes.get(message.id)?.data(message.data)
          else if (message.type === 'exit') remotes.get(message.id)?.exit(message.code)
          else if (message.type === 'hello' && message.version !== PTY_HOST_VERSION) {
            console.warn(`[whiplash] PTY host speaks protocol ${message.version}, server ${PTY_HOST_VERSION}; restart it when no agent is working`)
          } else if (message.type === 'list') {
            // Output sent before this reply is already in each backlog; ids were unknown until now, so nothing is doubled.
            for (const { id, cols, rows, buffer, meta } of message.sessions as { id: string; cols: number; rows: number; buffer: string; meta: SessionMeta }[]) {
              if (sessions.has(id)) continue
              const pty = remotePty(id, cols, rows)
              attach(id, { pty, buffer, listeners: new Set(), sessionId: meta.sessionId }, meta, buffer)
            }
            resolve()
          }
        })
      )
    })
    socket.on('error', (error) => console.warn('[whiplash] PTY host connection', error.message))
    socket.on('close', () => {
      listed()
      if (host !== socket) return
      host = null
      // The host itself went away, and its PTYs with it.
      for (const remote of [...remotes.values()]) remote.exit(-1)
      reconnect()
    })
    host = socket
    send({ type: 'hello', version: PTY_HOST_VERSION })
    send({ type: 'list' })
    await relisted
  }

  function reconnect(): void {
    setTimeout(() => connectHost().catch((error) => {
      console.error('[whiplash] PTY host', error)
      reconnect()
    }), HOST_RECONNECT_MS)
  }

  /**
   * Orca's framing: ESC bytes inside the prompt are made inert so they cannot end the paste early,
   * and Enter goes in its own write after the ingest-scaled settle, or Claude can leave the draft unsent.
   */
  async function submit(pty: Pty, prompt: string): Promise<void> {
    const paste = buildAgentPromptPasteBytes(prompt)
    pty.write(paste)
    await delay(getAgentPromptSubmitDelayMs(process.platform, Buffer.byteLength(paste, 'utf8')))
    pty.write('\r')
  }

  /** Types a Stage turn into the open terminal and waits for the CLI to record the end of that turn. */
  async function typeTurn(member: Member, prompt: string, signal: AbortSignal): Promise<TurnResult> {
    const session = sessions.get(member.id)
    if (!session) {
      return { ok: false, text: '', error: 'Terminal closed' }
    }
    // A turn started in the terminal itself is still running. A prompt typed now would only be queued
    // inside that turn, never recorded as its own prompt, and reported as blocked; wait for the CLI.
    while (session.status?.state === 'working') {
      await delay(POLL_MS)
      if (signal.aborted) return { ok: false, text: '', error: 'Stopped' }
      if (sessions.get(member.id) !== session) return { ok: false, text: '', error: 'Terminal closed' }
    }
    const transcriptOf = async (): Promise<string | null> => {
      const id = session.sessionId ?? member.sessionId
      return id ? await findTranscript(member.harness, id) : null
    }
    let path = await transcriptOf()
    let offset = path ? (await stat(path)).size : 0
    await submit(session.pty, prompt)
    const sentAt = Date.now()
    const replies: string[] = []
    while (true) {
      await delay(POLL_MS)
      if (signal.aborted) {
        session.pty.write('\x1b')
        return { ok: false, text: '', error: 'Stopped' }
      }
      if (sessions.get(member.id) !== session) {
        return { ok: false, text: '', error: 'Terminal closed during the turn' }
      }
      const waitedTooLong = Date.now() - sentAt > PROMPT_ACCEPT_MS
      if (!path) {
        path = await transcriptOf()
        offset = 0
        if (!path && waitedTooLong) {
          return { ok: false, text: '', blocked: true }
        }
        continue
      }
      const appended = await readFrom(path, offset)
      const end = findTurnEnd(member.harness, appended)
      const dialogShowing = session.status?.state === 'blocked' && Date.now() - sentAt > BLOCKED_GRACE_MS
      if (!end.prompted && (waitedTooLong || dialogShowing)) {
        return { ok: false, text: '', blocked: true }
      }
      if (end.done) {
        // Only this turn's rows: a follow-up typed in during it may already have started the next one.
        const segment = appended.slice(0, end.length)
        replies.push(parseTranscriptTurn(segment).text)
        const sessionId = session.sessionId ?? member.sessionId
        const text = replies.filter(Boolean).join('\n\n')
        if (end.aborted) return { ok: false, text, error: 'Turn interrupted', sessionId }
        // A follow-up that arrived as the turn was ending runs as its own turn; its answer belongs here too.
        await delay(FOLLOW_UP_SETTLE_MS)
        const rest = (await readFrom(path, offset)).slice(end.length)
        if (!findTurnEnd(member.harness, rest).prompted) return { ok: true, text, sessionId }
        offset += Buffer.byteLength(segment, 'utf8')
      }
    }
  }

  return {
    open: openTerminal,
    typeTurn,
    /** Types more words into a turn that is already running, as the master could in the terminal itself. */
    async inject(memberId: string, prompt: string): Promise<void> {
      const session = sessions.get(memberId)
      if (session) await submit(session.pty, prompt)
    },
    isOpen: (memberId: string): boolean => sessions.has(memberId),
    statusOf: (memberId: string): TerminalStatus | undefined => sessions.get(memberId)?.status,
    statuses: (): Record<string, TerminalStatus> =>
      Object.fromEntries([...sessions].flatMap(([id, session]) => (session.status ? [[id, session.status]] : []))),
    openIds: (): string[] => [...sessions.keys()],
    write(memberId: string, data: string): void {
      sessions.get(memberId)?.pty.write(data)
    },
    resize(memberId: string, cols: number, rows: number): void {
      sessions.get(memberId)?.pty.resize(cols, rows)
    },
    close(memberId: string): void {
      sessions.get(memberId)?.pty.kill('SIGHUP')
    },
    /** The host answers the CLIs' color queries, so it needs the viewer's theme. */
    setColors(colors: unknown): void {
      send({ ...(colors as object), type: 'colors' })
    },
    /** Resolves once every session still running in the host is attached again. */
    ready: connectHost(),
    /** Replays recent output first, so a reload shows the screen as it was. */
    subscribe(memberId: string, listener: (event: TerminalEvent) => void): (() => void) | null {
      const session = sessions.get(memberId)
      if (!session) {
        return null
      }
      // The replay carries the PTY size, so a viewer can lay the screen out exactly as the CLI drew it.
      listener({ type: 'data', data: session.buffer, cols: session.pty.cols, rows: session.pty.rows })
      session.listeners.add(listener)
      return () => session.listeners.delete(listener)
    }
  }
}
