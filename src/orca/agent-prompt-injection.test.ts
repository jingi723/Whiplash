// Lifted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.): src/shared/agent-launch/startup/agent-prompt-injection.test.ts @ stablyai/orca 0069492b
// Changes: cases for chunking and draft detection, which Whiplash does not lift, are left out.
import { describe, expect, it } from './vitest.ts'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs
} from './agent-prompt-injection.ts'

const BEGIN = AGENT_PROMPT_BRACKETED_PASTE_START
const END = AGENT_PROMPT_BRACKETED_PASTE_END

describe('agent prompt injection bytes', () => {
  it('types the lead line ahead of the paste frame on one line', () => {
    expect(buildAgentPromptPasteBytes('brief', 'Please\r\nfollow\x03\x1b[201~\x7f')).toBe(
      `Please follow [201~  ${BEGIN}brief${END}`
    )
    expect(buildAgentPromptPasteBytes('brief', '')).toBe(`${BEGIN}brief${END}`)
  })

  it.each([
    // Pin the slower measured Win11 ingest samples so Enter cannot race incomplete paste.
    [2_000, 25],
    [8_000, 89],
    [40_000, 440],
    [80_000, 858],
    [160_000, 1_662],
    [320_000, 3_342]
  ])('outlasts the slowest measured ConPTY ingest of %i bytes', (bytes, measuredMs) => {
    expect(getTerminalPasteIngestMs('win32', bytes)).toBeGreaterThan(measuredMs)
    expect(getAgentPromptSubmitDelayMs('win32', bytes)).toBeGreaterThan(measuredMs)
  })

  it('sanitizes embedded escape bytes before framing', () => {
    const bytes = buildAgentPromptPasteBytes('before\x1b[201~after\x1b')
    expect(bytes).toBe(`${BEGIN}before<ESC>[201~after<ESC>${END}`)
    expect(bytes.slice(BEGIN.length, -END.length)).not.toContain('\x1b')
  })
})
