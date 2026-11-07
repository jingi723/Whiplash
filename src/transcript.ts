import { open } from 'node:fs/promises'

export type TurnRead = { text: string; contextTokens?: number; windowTokens?: number }

const TAIL_BYTES = 8 * 1024 * 1024

type TranscriptLine = {
  type?: string
  isSidechain?: boolean
  message?: {
    content?: unknown
    usage?: Record<string, number | undefined>
  }
  payload?: {
    type?: string
    last_agent_message?: string
    message?: string
    info?: { last_token_usage?: { input_tokens?: number }; model_context_window?: number } | null
  }
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : ''
  }
  return content
    .flatMap((block: { type?: string; text?: string }) =>
      block?.type === 'text' && block.text ? [block.text] : []
    )
    .join('\n')
}

function isHumanPrompt(content: unknown): boolean {
  return (
    typeof content === 'string' ||
    (Array.isArray(content) && content.some((block) => block?.type === 'text'))
  )
}

/** The current turn's reply and context size from a Claude or Codex transcript; partial lines are skipped. */
export function parseTranscriptTurn(jsonl: string): TurnRead {
  const turn: TurnRead = { text: '' }
  for (const line of jsonl.split('\n')) {
    let parsed: TranscriptLine
    try {
      parsed = JSON.parse(line) as TranscriptLine
    } catch {
      continue
    }
    if (parsed.type === 'user' && !parsed.isSidechain && isHumanPrompt(parsed.message?.content)) {
      turn.text = ''
    } else if (parsed.type === 'assistant' && !parsed.isSidechain) {
      turn.text = assistantText(parsed.message?.content) || turn.text
      const usage = parsed.message?.usage
      if (usage) {
        // Everything the model read on that request is what fills the window.
        turn.contextTokens =
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0)
      }
    } else if (parsed.type === 'event_msg') {
      const payload = parsed.payload
      if (payload?.type === 'task_started') {
        turn.text = ''
      } else if (payload?.type === 'task_complete' || payload?.type === 'agent_message') {
        turn.text = payload.last_agent_message || payload.message || turn.text
      } else if (payload?.type === 'token_count' && payload.info) {
        turn.contextTokens = payload.info.last_token_usage?.input_tokens ?? turn.contextTokens
        turn.windowTokens = payload.info.model_context_window ?? turn.windowTokens
      }
    }
  }
  return turn
}

export async function readTranscriptTurn(path: string): Promise<TurnRead> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, size - length)
    return parseTranscriptTurn(buffer.toString('utf8'))
  } finally {
    await file.close()
  }
}
