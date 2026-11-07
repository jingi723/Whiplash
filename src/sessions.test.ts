import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { findTranscript, listSessions, parseClaudeHead, parseCodexHead } from './sessions.ts'

const jsonl = (...rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n')

describe('session heads', () => {
  it('reads a Claude session and skips injected context for the title', () => {
    const head = jsonl(
      { type: 'mode', cwd: undefined },
      { type: 'user', cwd: '/repo', message: { content: '<system-reminder>x</system-reminder>' } },
      { type: 'user', cwd: '/repo', message: { content: [{ type: 'text', text: '로그인 고쳐줘' }] } }
    )
    assert.deepEqual(parseClaudeHead(`${head}\n{"cut`, 'abc'), {
      id: 'abc',
      cwd: '/repo',
      title: '로그인 고쳐줘'
    })
  })

  it('reads a Codex session from its metadata and first message', () => {
    const head = jsonl(
      { type: 'session_meta', payload: { id: 'thread', cwd: '/repo' } },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'text', text: '버그 찾아줘' }] }
        }
      }
    )
    assert.deepEqual(parseCodexHead(head), { id: 'thread', cwd: '/repo', title: '버그 찾아줘' })
  })
})

describe('listSessions', () => {
  it('finds both consoles, skips subagents and sessions whose folder is gone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'whiplash-'))
    const claudeDir = join(home, '.claude', 'projects', '-repo')
    const codexDir = join(home, '.codex', 'sessions', '2026', '11', '07')
    mkdirSync(join(claudeDir, 'subagents'), { recursive: true })
    mkdirSync(codexDir, { recursive: true })
    const user = (cwd: string, text: string): string =>
      jsonl({ type: 'user', cwd, message: { content: text } })
    writeFileSync(join(claudeDir, 'live.jsonl'), user(home, '살아 있음'))
    writeFileSync(join(claudeDir, 'gone.jsonl'), user('/no/such/folder', '폴더 없음'))
    writeFileSync(join(claudeDir, 'subagents', 'child.jsonl'), user(home, '자식'))
    writeFileSync(
      join(codexDir, 'rollout-1-thread.jsonl'),
      jsonl({ type: 'session_meta', payload: { id: 'thread', cwd: home } })
    )

    const sessions = await listSessions(home)
    assert.deepEqual(sessions.map(({ harness, id }) => `${harness}:${id}`).toSorted(), [
      'claude:live',
      'codex:thread'
    ])
    assert.equal(await findTranscript('claude', 'live', home), join(claudeDir, 'live.jsonl'))
    assert.equal(
      await findTranscript('codex', 'thread', home),
      join(codexDir, 'rollout-1-thread.jsonl')
    )
  })
})
