import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createConductor, runShellCheck, type ConductorDeps } from './conductor.ts'
import type { Channel, Member, State } from './model.ts'

const member = (id: string, name: string): Member => ({
  id,
  name,
  harness: 'claude',
  instructions: '',
  cwd: '/repo',
  deliveredThrough: 0
})

function room(overrides: Partial<Channel> = {}): State {
  return {
    channels: [
      {
        id: 'c',
        name: 'general',
        cwd: '/repo',
        checkCommand: '',
        members: [member('a', 'Coder'), member('b', 'Reviewer')],
        messages: [],
        nextSeq: 1,
        agentChain: 0,
        ...overrides
      }
    ]
  }
}

type RunTurn = ConductorDeps['runTurn']

function conduct(state: State, runTurn: RunTurn, overrides: Partial<ConductorDeps> = {}) {
  let changes = 0
  let resolveIdle = (): void => {}
  const conductor = createConductor({
    state,
    runTurn,
    readSession: async () => null,
    runCheck: async () => null,
    onStudioEvent: () => {},
    onChange: () => {
      changes += 1
      setTimeout(() => {
        if (Object.keys(conductor.activityOf()).length === 0) {
          resolveIdle()
        }
      }, 5)
    },
    ...overrides
  })
  const idle = (): Promise<void> => new Promise((resolve) => (resolveIdle = resolve))
  return { conductor, idle, changes: () => changes }
}

const texts = (state: State): string[] => state.channels[0].messages.map(({ text }) => text)

describe('conductor', () => {
  it('runs one turn at a time per agent and carries later mentions into the next prompt', async () => {
    const state = room()
    const channel = state.channels[0]
    const prompts: string[] = []
    const { conductor, idle } = conduct(state, async (_member, prompt) => {
      prompts.push(prompt)
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { ok: true, text: `답${prompts.length}`, sessionId: 's' }
    })
    const done = idle()
    conductor.sendHumanMessage(channel, '@Coder 하나')
    await new Promise((resolve) => setTimeout(resolve, 5))
    conductor.sendHumanMessage(channel, '@Coder 둘')
    await done
    assert.equal(prompts.length, 2)
    assert.ok(prompts[1].includes('@Coder 둘'))
    assert.ok(!prompts[1].includes('@Coder 하나'))
    assert.equal(channel.members[0].sessionId, 's')
  })

  it('folds mentions that arrive before the prompt is built into one turn', async () => {
    const state = room()
    const channel = state.channels[0]
    let turns = 0
    const { conductor, idle } = conduct(state, async () => {
      turns += 1
      return { ok: true, text: '끝' }
    })
    const done = idle()
    conductor.sendHumanMessage(channel, '@Coder 하나')
    conductor.sendHumanMessage(channel, '@Coder 둘')
    await done
    assert.equal(turns, 1)
  })

  it('hands off between agents until the chain budget, and a human message resets it', async () => {
    const state = room()
    const channel = state.channels[0]
    let turns = 0
    const { conductor, idle } = conduct(state, async ({ name }) => {
      turns += 1
      return { ok: true, text: name === 'Coder' ? '@Reviewer 핑' : '@Coder 퐁' }
    })
    const done = idle()
    conductor.sendHumanMessage(channel, '@Coder 시작')
    await done
    assert.equal(turns, 7)
    assert.ok(texts(state).at(-1)?.includes('체인을 끊었습니다'))
    conductor.sendHumanMessage(channel, '여기까지')
    assert.equal(channel.agentChain, 0)
  })

  it('raises the chair alert for a failed turn, and a reject reaches that agent', async () => {
    const state = room()
    const channel = state.channels[0]
    const results = [{ ok: false, text: '', error: '터짐' }, { ok: true, text: '다시 함' }]
    const { conductor, idle } = conduct(state, async () => results.shift()!)
    let done = idle()
    conductor.sendHumanMessage(channel, '@Coder 해')
    await done
    const alert = channel.messages.at(-1)
    assert.equal(alert?.alertMemberId, 'a')
    assert.ok(alert?.text.includes('의자를 던지세요'))
    done = idle()
    conductor.reject('a')
    await done
    assert.ok(texts(state).some((text) => text.includes('Not quite my tempo')))
    assert.equal(texts(state).at(-1), '다시 함')
  })

  it('treats a failing check as a miss and stops the handoff', async () => {
    const state = room({ checkCommand: 'pnpm build' })
    const channel = state.channels[0]
    let turns = 0
    const { conductor, idle } = conduct(
      state,
      async () => {
        turns += 1
        return { ok: true, text: '@Reviewer 봐줘' }
      },
      { runCheck: async () => 'TS2322' }
    )
    const done = idle()
    conductor.sendHumanMessage(channel, '@Coder 해')
    await done
    assert.equal(turns, 1)
    assert.ok(texts(state).at(-1)?.includes('TS2322'))
  })

  it('warns when the session moved in another console, but not for its own writes', async () => {
    const state = room()
    const channel = state.channels[0]
    channel.members[0].sessionId = 's'
    const { conductor, idle } = conduct(state, async () => ({ ok: true, text: '끝' }), {
      readSession: async () => ({ text: '', updatedAt: Date.now() })
    })
    let done = idle()
    conductor.sendHumanMessage(channel, '@Coder 해')
    await done
    assert.ok(texts(state).some((text) => text.includes('다른 콘솔')))
    const warnings = texts(state).filter((text) => text.includes('다른 콘솔')).length
    done = idle()
    conductor.sendHumanMessage(channel, '@Coder 또')
    await done
    assert.equal(texts(state).filter((text) => text.includes('다른 콘솔')).length, warnings)
  })

  it('stops a running turn without an alert', async () => {
    const state = room()
    const channel = state.channels[0]
    const { conductor, idle } = conduct(state, (_member, _prompt, _onEvent, signal) =>
      new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ ok: false, text: '', error: 'killed' }))
      )
    )
    const done = idle()
    conductor.sendHumanMessage(channel, '@Coder 해')
    setTimeout(() => conductor.stop('a'), 5)
    await done
    assert.ok(texts(state).at(-1)?.includes('멈췄습니다'))
    assert.ok(!channel.messages.some(({ alertMemberId }) => alertMemberId))
  })
})

describe('runShellCheck', () => {
  it('returns output only on failure', async () => {
    assert.equal(await runShellCheck('true', '/'), null)
    assert.ok((await runShellCheck('echo 빌드실패; exit 2', '/'))?.includes('빌드실패'))
  })
})
