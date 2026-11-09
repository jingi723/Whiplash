import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentEnv } from './env.ts'
import type { TurnResult } from './harness.ts'
import { buildAgentPromptPasteBytes, getAgentPromptSubmitDelayMs } from './orca/agent-prompt-injection.ts'
import { createProgramStatusOscScanner } from './orca/program-status/osc-scanner.ts'
import { createColorQueryResponder } from './terminal-color-queries.ts'
import { PROGRAM_STATUS_QUERY_REPLY, type ProgramStatusState } from './orca/program-status/protocol.ts'
import type { Harness, Member } from './model.ts'
import { findTranscript } from './sessions.ts'
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

const require = createRequire(import.meta.url)
const BUFFER_LIMIT = 256 * 1024
const POLL_MS = 800
/** A dialog that reports itself as blocked has clearly swallowed the prompt; no need to wait the full timeout. */
const BLOCKED_GRACE_MS = 3000
const SESSION_DISCOVERY_MS = 60_000
/** A typed prompt shows up in the transcript within seconds unless a dialog swallowed it. */
const PROMPT_ACCEPT_MS = 20_000

let ptyModule: { spawn: (file: string, args: string[], options: object) => Pty } | null = null

/** node-pty 1.1.0 ships its macOS spawn helper without the execute bit, which fails every spawn.
 *  Same repair as Orca's local-pty-executable-spawn.ts: macOS only, keep the other mode bits, never throw. */
function loadPty(): NonNullable<typeof ptyModule> {
  if (ptyModule) {
    return ptyModule
  }
  const root = dirname(require.resolve('node-pty/package.json'))
  const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  try {
    if (process.platform === 'darwin' && existsSync(helper)) {
      const mode = statSync(helper).mode
      if ((mode & 0o111) === 0) {
        chmodSync(helper, mode | 0o755)
      }
    }
  } catch (error) {
    console.warn('[whiplash] could not make node-pty spawn-helper executable', error)
  }
  ptyModule = require('node-pty')
  return ptyModule!
}

/** The interactive CLI for a member; a new Claude session gets its id up front so Stage can follow it. */
export function interactiveCommand(
  member: Pick<Member, 'harness' | 'sessionId' | 'writableRoots'>,
  newSessionId: () => string = randomUUID
): { command: string; args: string[]; sessionId?: string } {
  const roots = member.writableRoots ?? []
  if (member.harness === 'claude') {
    const sessionId = member.sessionId ?? newSessionId()
    return {
      command: 'claude',
      args: [
        ...roots.flatMap((root) => ['--add-dir', root]),
        ...(member.sessionId ? ['--resume', sessionId] : ['--session-id', sessionId])
      ],
      sessionId
    }
  }
  const config = roots.length ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`] : []
  return {
    command: 'codex',
    args: [...config, ...(member.sessionId ? ['resume', member.sessionId] : [])],
    sessionId: member.sessionId
  }
}

type TurnEnd = { prompted: boolean; done: boolean; aborted: boolean }

/** A turn ends with a stop marker written after the prompt we typed; earlier markers belong to old turns. */
export function findTurnEnd(harness: Harness, appended: string): TurnEnd {
  let prompted = false
  for (const line of appended.split('\n')) {
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
        return { prompted, done: true, aborted: false }
      }
    } else {
      // Turn markers and their aliases follow Orca's reconcileCodexTranscriptTurn (src/orca/codex-turn-transcript.ts).
      const payload = row.type === 'event_msg' ? (row.payload as { type?: string; reason?: string } | undefined) : undefined
      const kind = payload?.type
      prompted ||= kind === 'task_started' || kind === 'turn_started'
      if (prompted && (kind === 'task_complete' || kind === 'turn_complete')) {
        return { prompted, done: true, aborted: false }
      }
      if (prompted && kind === 'turn_aborted') {
        return { prompted, done: true, aborted: payload?.reason === 'interrupted' || payload?.reason === undefined }
      }
    }
  }
  return { prompted, done: false, aborted: false }
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
  onTurnEnd: (memberId: string) => void = () => {}
) {
  const sessions = new Map<string, Session>()

  function emit(session: Session, event: TerminalEvent): void {
    session.listeners.forEach((listener) => listener(event))
  }

  function openTerminal(member: Member, cols: number, rows: number): void {
    if (sessions.has(member.id)) {
      sessions.get(member.id)!.pty.resize(cols, rows)
      return
    }
    const { command, args, sessionId } = interactiveCommand(member)
    const startedAt = Date.now()
    const pty = loadPty().spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: member.cwd,
      env: { ...agentEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    })
    const session: Session = { pty, buffer: '', listeners: new Set(), sessionId }
    sessions.set(member.id, session)
    const scan = createProgramStatusOscScanner()
    const answerColorQueries = createColorQueryResponder((reply) => pty.write(reply))
    pty.onData((raw) => {
      const data = answerColorQueries(raw)
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT)
      emit(session, { type: 'data', data })
      for (const event of scan(data)) {
        if (event.type === 'query') {
          // Claude reports program status only to a terminal that answers this probe.
          pty.write(PROGRAM_STATUS_QUERY_REPLY)
        } else if (event.type === 'report' && event.report.id === null && event.report.state !== 'clear') {
          const next: TerminalStatus = { state: event.report.state, ...(event.report.kind ? { kind: event.report.kind } : {}) }
          if (next.state !== session.status?.state || next.kind !== session.status?.kind) {
            if (session.status?.state === 'working' && next.state !== 'working') onTurnEnd(member.id)
            session.status = next
            onChange()
          }
        } else if (event.type === 'report' && event.report.id === null) {
          session.status = undefined
          onChange()
        }
      }
    })
    pty.onExit(({ exitCode }) => {
      sessions.delete(member.id)
      emit(session, { type: 'exit', code: exitCode })
      onChange()
    })
    if (sessionId !== member.sessionId || !sessionId) {
      // A pinned id is only recorded once the CLI writes it; a terminal closed before the first prompt leaves nothing to resume.
      void (async () => {
        for (let waited = 0; waited < SESSION_DISCOVERY_MS && sessions.get(member.id) === session; waited += 2000) {
          await delay(2000)
          const found = sessionId
            ? (await findTranscript(member.harness, sessionId)) && sessionId
            : await findNewCodexSession(member.cwd, startedAt)
          if (found) {
            session.sessionId = found
            onSessionId(member.id, found)
            return
          }
        }
      })()
    }
    onChange()
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
      const end = findTurnEnd(member.harness, await readFrom(path, offset))
      const dialogShowing = session.status?.state === 'blocked' && Date.now() - sentAt > BLOCKED_GRACE_MS
      if (!end.prompted && (waitedTooLong || dialogShowing)) {
        return { ok: false, text: '', blocked: true }
      }
      if (end.done) {
        const turn = parseTranscriptTurn(await readFrom(path, offset))
        const sessionId = session.sessionId ?? member.sessionId
        return end.aborted
          ? { ok: false, text: turn.text, error: 'Turn interrupted', sessionId }
          : { ok: true, text: turn.text, sessionId }
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
    closeAll(): void {
      sessions.forEach((session) => session.pty.kill('SIGHUP'))
    },
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
