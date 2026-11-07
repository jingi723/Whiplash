// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/shared/codex-turn-transcript.ts @ stablyai/orca 0069492b
// Changes: record() inlined from codex-rollout-jsonl-cursor.ts

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

export type CodexTranscriptTurn = {
  turnId?: string
  interrupted: boolean
}

/** The root rollout, rather than a terminal key or painted notice, confirms cancellation. */
export function reconcileCodexTranscriptTurn(
  turn: CodexTranscriptTurn,
  records: readonly JsonRecord[]
): void {
  for (const item of records) {
    if (item.type !== 'event_msg') {
      continue
    }
    const payload = record(item.payload)
    if (!payload) {
      continue
    }
    const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined
    if (payload.type === 'task_started' || payload.type === 'turn_started') {
      turn.turnId = turnId
      turn.interrupted = false
    } else if (!turnId || !turn.turnId || turnId === turn.turnId) {
      if (payload.type === 'turn_aborted' && payload.reason === 'interrupted') {
        turn.interrupted = true
      } else if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
        turn.interrupted = false
      }
    }
  }
}
