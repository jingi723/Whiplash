import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Harness, Member } from './model.ts'

export type StudioEvent =
  | { kind: 'text'; text: string }
  | { kind: 'command'; text: string }
  | { kind: 'output'; text: string; isError: boolean }
  | { kind: 'status'; text: string }

export type TurnResult = { ok: boolean; text: string; sessionId?: string; error?: string }

type Parsed = {
  events: StudioEvent[]
  sessionId?: string
  reply?: string
  failure?: string
}

const OUTPUT_LIMIT = 4000
const CLAUDE_SANDBOX = JSON.stringify({
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: true }
})

function clip(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (잘림)` : text
}

/** Writes outside the agent's folder are refused by the OS sandbox of each CLI, even for imported sessions. */
export function buildCommand(
  member: Pick<Member, 'harness' | 'sessionId'>,
  prompt: string
): { command: string; args: string[] } {
  if (member.harness === 'claude') {
    return {
      command: 'claude',
      args: [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--settings',
        CLAUDE_SANDBOX,
        ...(member.sessionId ? ['--resume', member.sessionId] : [])
      ]
    }
  }
  return {
    command: 'codex',
    args: member.sessionId
      ? ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', member.sessionId, prompt]
      : ['exec', '--json', '-s', 'workspace-write', prompt]
  }
}

function toolInput(input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>
  const value = record.command ?? record.file_path ?? record.path ?? record.pattern
  return typeof value === 'string' ? value : JSON.stringify(input).slice(0, 200)
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  return Array.isArray(content)
    ? content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
    : ''
}

function parseClaude(row: any): Parsed {
  if (row.type === 'system' && row.subtype === 'init') {
    return { events: [{ kind: 'status', text: '세션 연결' }], sessionId: row.session_id }
  }
  if (row.type === 'assistant') {
    return {
      events: (row.message?.content ?? []).flatMap((block: any): StudioEvent[] => {
        if (block.type === 'text' && block.text) {
          return [{ kind: 'text', text: block.text }]
        }
        return block.type === 'tool_use'
          ? [{ kind: 'command', text: `${block.name}: ${toolInput(block.input)}` }]
          : []
      })
    }
  }
  if (row.type === 'user') {
    return {
      events: (Array.isArray(row.message?.content) ? row.message.content : []).flatMap(
        (block: any): StudioEvent[] =>
          block.type === 'tool_result'
            ? [
                {
                  kind: 'output',
                  text: clip(toolResultText(block.content)),
                  isError: block.is_error === true
                }
              ]
            : []
      )
    }
  }
  if (row.type === 'result') {
    return row.is_error
      ? { events: [], failure: String(row.result ?? row.subtype ?? '턴 실패') }
      : { events: [], reply: row.result ?? '', sessionId: row.session_id }
  }
  return { events: [] }
}

function parseCodex(row: any): Parsed {
  const item = row.item
  if (row.type === 'thread.started') {
    return { events: [{ kind: 'status', text: '세션 연결' }], sessionId: row.thread_id }
  }
  if (row.type === 'turn.failed' || row.type === 'error') {
    return { events: [], failure: String(row.error?.message ?? row.message ?? '턴 실패') }
  }
  if (row.type === 'item.started' && item?.type === 'command_execution') {
    return { events: [{ kind: 'command', text: item.command }] }
  }
  if (row.type !== 'item.completed') {
    return { events: [] }
  }
  if (item?.type === 'agent_message') {
    return { events: [{ kind: 'text', text: item.text }], reply: item.text }
  }
  if (item?.type === 'command_execution') {
    const output: StudioEvent = {
      kind: 'output',
      text: clip(item.aggregated_output ?? ''),
      isError: item.exit_code !== 0
    }
    return { events: [output] }
  }
  return { events: [] }
}

export function parseStreamLine(harness: Harness, line: string): Parsed {
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return { events: [] }
  }
  return harness === 'claude' ? parseClaude(row) : parseCodex(row)
}

/** Runs one headless turn. A resumed session keeps its id, so the original console can reopen it later. */
export function runTurn(
  member: Member,
  prompt: string,
  onEvent: (event: StudioEvent) => void,
  signal: AbortSignal
): Promise<TurnResult> {
  const { command, args } = buildCommand(member, prompt)
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: member.cwd,
      signal,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const result: TurnResult = { ok: true, text: '', sessionId: member.sessionId }
    let failure = ''
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-OUTPUT_LIMIT)
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      const parsed = parseStreamLine(member.harness, line)
      parsed.events.forEach(onEvent)
      result.sessionId = parsed.sessionId ?? result.sessionId
      result.text = parsed.reply ?? result.text
      failure = parsed.failure ?? failure
    })
    child.on('error', (error) => {
      resolve({ ...result, ok: false, error: error.message })
    })
    child.on('close', (code) => {
      const ok = code === 0 && !failure
      resolve({ ...result, ok, ...(ok ? {} : { error: failure || stderr.trim() || `exit ${code}` }) })
    })
  })
}
