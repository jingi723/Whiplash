import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseTranscriptTurn } from './transcript.ts'

const lines = (...rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n')

describe('parseTranscriptTurn', () => {
  it('reads the last Claude reply and context, ignoring subagents and tool-only rows', () => {
    const turn = parseTranscriptTurn(
      `{"cut off line\n${lines(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash' }],
            usage: {
              input_tokens: 2,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 8,
              output_tokens: 50
            }
          }
        },
        {
          type: 'assistant',
          isSidechain: true,
          message: { content: [{ type: 'text', text: 'child' }] }
        }
      )}`
    )
    assert.deepEqual(turn, { text: 'done', contextTokens: 110 })
  })

  it('forgets the old context size at a compact boundary', () => {
    const usage = { type: 'assistant', message: { content: [], usage: { input_tokens: 198_000 } } }
    const boundary = { type: 'system', subtype: 'compact_boundary' }
    assert.equal(parseTranscriptTurn(lines(usage, boundary)).contextTokens, undefined)
  })

  it('reports no reply until the current turn has one', () => {
    const previous = { type: 'assistant', message: { content: [{ type: 'text', text: 'old' }] } }
    const prompt = { type: 'user', message: { content: 'next' } }
    const toolResult = { type: 'user', message: { content: [{ type: 'tool_result' }] } }
    assert.equal(parseTranscriptTurn(lines(previous, prompt)).text, '')
    assert.equal(parseTranscriptTurn(lines(previous, toolResult)).text, 'old')
  })

  it('reads Codex completion and token events', () => {
    const turn = parseTranscriptTurn(
      lines(
        { type: 'event_msg', payload: { type: 'token_count', info: null } },
        {
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 900 }, model_context_window: 1000 }
          }
        },
        { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } }
      )
    )
    assert.deepEqual(turn, { text: 'done', contextTokens: 900, windowTokens: 1000 })
  })
})
