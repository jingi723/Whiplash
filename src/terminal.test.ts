import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findTurnEnd, interactiveCommand } from './terminal.ts'

const jsonl = (...rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n')

describe('interactiveCommand', () => {
  it('resumes known sessions and pins a new Claude session id', () => {
    assert.deepEqual(interactiveCommand({ harness: 'claude', sessionId: 's', writableRoots: ['/p'] }), {
      command: 'claude',
      args: ['--add-dir', '/p', '--resume', 's'],
      sessionId: 's'
    })
    assert.deepEqual(interactiveCommand({ harness: 'claude' }, () => 'fresh'), {
      command: 'claude',
      args: ['--session-id', 'fresh'],
      sessionId: 'fresh'
    })
    assert.deepEqual(interactiveCommand({ harness: 'codex', sessionId: 't' }).args, ['resume', 't'])
    assert.equal(interactiveCommand({ harness: 'codex' }).sessionId, undefined)
  })
})

/** The turn state without how far it reached, which the cases below do not care about. */
const turnEnd = (harness: 'claude' | 'codex', appended: string) => {
  const { length: _length, ...state } = findTurnEnd(harness, appended)
  return state
}

describe('findTurnEnd', () => {
  const stop = { type: 'system', subtype: 'stop_hook_summary' }

  it('ignores a stop marker that arrives before the typed prompt', () => {
    assert.deepEqual(turnEnd('claude', jsonl(stop)), { prompted: false, done: false, aborted: false })
    assert.deepEqual(
      turnEnd('claude', jsonl({ type: 'user', message: { content: [{ type: 'tool_result' }] } }, stop)),
      { prompted: false, done: false, aborted: false }
    )
  })

  it('ends a Claude turn on the stop marker after the prompt', () => {
    const appended = jsonl(
      stop,
      { type: 'user', message: { content: 'hello' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'system', subtype: 'turn_duration' }
    )
    assert.deepEqual(turnEnd('claude', appended), { prompted: true, done: true, aborted: false })
  })

  it('ends a Codex turn on completion or abort, after it started', () => {
    const event = (type: string) => ({ type: 'event_msg', payload: { type } })
    assert.deepEqual(turnEnd('codex', jsonl(event('task_complete'))), {
      prompted: false,
      done: false,
      aborted: false
    })
    assert.deepEqual(turnEnd('codex', jsonl(event('task_started'), event('task_complete'))), {
      prompted: true,
      done: true,
      aborted: false
    })
    assert.deepEqual(turnEnd('codex', jsonl(event('turn_started'), event('turn_complete'))), {
      prompted: true,
      done: true,
      aborted: false
    })
    assert.deepEqual(turnEnd('codex', jsonl(event('task_started'), event('turn_aborted'))), {
      prompted: true,
      done: true,
      aborted: true
    })
  })

  it('stops at its own stop marker, so a follow-up turn after it is not read as this one', () => {
    const first = jsonl({ type: 'user', message: { content: '하나' } }, { type: 'assistant', message: { content: [{ type: 'text', text: '1' }] } }, stop)
    const next = jsonl({ type: 'user', message: { content: '둘' } })
    const end = findTurnEnd('claude', `${first}\n${next}`)
    assert.equal(end.length, first.length + 1)
    assert.equal(turnEnd('claude', next).prompted, true)
  })
})
