import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildCommand, parseStreamLine } from './harness.ts'

const line = (row: unknown): string => JSON.stringify(row)

describe('buildCommand', () => {
  it('sandboxes every turn and resumes an existing session', () => {
    const claude = buildCommand({ harness: 'claude', sessionId: 's1' }, 'hi').args
    assert.ok(claude.includes('--settings'))
    assert.deepEqual(claude.slice(-2), ['--resume', 's1'])
    assert.deepEqual(buildCommand({ harness: 'codex' }, 'hi').args, [
      'exec',
      '--json',
      '-s',
      'workspace-write',
      'hi'
    ])
    const codex = buildCommand({ harness: 'codex', sessionId: 's2' }, 'hi').args
    assert.deepEqual(codex.slice(0, 3), ['exec', 'resume', '--json'])
    assert.ok(codex.includes('sandbox_mode="workspace-write"'))
    assert.deepEqual(codex.slice(-2), ['s2', 'hi'])
  })
})

describe('model choice', () => {
  it('passes the chosen model and effort to each CLI, and nothing for the defaults', () => {
    const claude = buildCommand({ harness: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, 'hi').args
    assert.deepEqual(claude.slice(claude.indexOf('--model'), claude.indexOf('--model') + 4), ['--model', 'claude-sonnet-5-5', '--effort', 'high'])
    assert.ok(!buildCommand({ harness: 'claude' }, 'hi').args.includes('--model'))
    const codex = buildCommand({ harness: 'codex', sessionId: 's', model: 'gpt-6-sol', effort: 'max' }, 'hi').args
    assert.ok(codex.includes('-m') && codex.includes('model_reasoning_effort="max"'))
    assert.deepEqual(codex.slice(-2), ['s', 'hi'])
  })
})

describe('writable roots', () => {
  it('extends each sandbox to the listed folders', () => {
    const claude = buildCommand({ harness: 'claude', sessionId: 's', writableRoots: ['/p'] }, 'hi').args
    assert.deepEqual(claude.slice(-4), ['--add-dir', '/p', '--resume', 's'])
    const codex = buildCommand({ harness: 'codex', sessionId: 's', writableRoots: ['/p'] }, 'hi').args
    assert.ok(codex.includes('sandbox_workspace_write.writable_roots=["/p"]'))
    assert.deepEqual(codex.slice(-2), ['s', 'hi'])
  })
})

describe('parseStreamLine', () => {
  it('reads Claude session, tool use, tool errors, replies and failures', () => {
    assert.equal(
      parseStreamLine('claude', line({ type: 'system', subtype: 'init', session_id: 's' })).sessionId,
      's'
    )
    assert.deepEqual(
      parseStreamLine('claude', line({ type: 'system', subtype: 'init', session_id: 's', slash_commands: ['cost', 'ponytail:ponytail'] })).slashCommands,
      ['cost', 'ponytail:ponytail']
    )
    assert.deepEqual(
      parseStreamLine(
        'claude',
        line({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }
        })
      ).events,
      [{ kind: 'command', text: 'Bash: ls' }]
    )
    assert.deepEqual(
      parseStreamLine(
        'claude',
        line({
          type: 'user',
          message: { content: [{ type: 'tool_result', is_error: true, content: 'nope' }] }
        })
      ).events,
      [{ kind: 'output', text: 'nope', isError: true }]
    )
    assert.equal(
      parseStreamLine('claude', line({ type: 'result', is_error: false, result: '끝' })).reply,
      '끝'
    )
    assert.equal(
      parseStreamLine('claude', line({ type: 'result', is_error: true, result: '망함' })).failure,
      '망함'
    )
  })

  it('reads Codex threads, commands and the last message', () => {
    assert.equal(
      parseStreamLine('codex', line({ type: 'thread.started', thread_id: 't' })).sessionId,
      't'
    )
    assert.deepEqual(
      parseStreamLine(
        'codex',
        line({
          type: 'item.completed',
          item: { type: 'command_execution', aggregated_output: 'x', exit_code: 1 }
        })
      ).events,
      [{ kind: 'output', text: 'x', isError: true }]
    )
    assert.equal(
      parseStreamLine(
        'codex',
        line({ type: 'item.completed', item: { type: 'agent_message', text: '끝' } })
      ).reply,
      '끝'
    )
  })

  it('ignores non-JSON noise', () => {
    assert.deepEqual(parseStreamLine('codex', 'Reading additional input').events, [])
  })
})
