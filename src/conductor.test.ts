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
    sessionCommand: async () => ({ ok: true, text: '' }),
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
const notices = (state: State): (string | undefined)[] =>
  state.channels[0].messages.map(({ notice }) => notice?.key)

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

  it("types a follow-up into a Claude terminal turn that is still running, so it needs no second turn", async () => {
    const state = room()
    const channel = state.channels[0]
    const prompts: string[] = []
    const injected: string[] = []
    const { conductor, idle } = conduct(
      state,
      async (_member, prompt) => {
        prompts.push(prompt)
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { ok: true, text: '둘 다 했어요', sessionId: 's' }
      },
      { canInject: () => true, inject: async (_member, prompt) => void injected.push(prompt) }
    )
    channel.members[0].sessionId = 's'
    const done = idle()
    conductor.sendHumanMessage(channel, '@Coder 하나')
    await new Promise((resolve) => setTimeout(resolve, 5))
    conductor.sendHumanMessage(channel, '@Coder 둘')
    await done
    assert.deepEqual(prompts, ['@Coder 하나'])
    assert.deepEqual(injected, ['@Coder 둘'])
    assert.deepEqual(texts(state), ['@Coder 하나', '@Coder 둘', '둘 다 했어요'])
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
    assert.equal(notices(state).at(-1), 'chainBroken')
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
    assert.deepEqual(alert?.notice, { key: 'turnFailed', params: { name: 'Coder', error: '터짐' } })
    assert.ok(alert?.text.includes('Throw the chair'))
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

  it('refuses a session another console just wrote, but not after its own turns', async () => {
    const state = room()
    const channel = state.channels[0]
    channel.members[0].sessionId = 's'
    let turns = 0
    let updatedAt = Date.now()
    const { conductor, idle } = conduct(
      state,
      async () => {
        turns += 1
        return { ok: true, text: '끝' }
      },
      { readSession: async () => ({ text: '', updatedAt }) }
    )
    let done = idle()
    conductor.sendHumanMessage(channel, '@Coder 해')
    await done
    assert.equal(turns, 0)
    assert.equal(notices(state).at(-1), 'busyElsewhere')
    updatedAt = Date.now() - 120_000
    done = idle()
    conductor.sendHumanMessage(channel, '@Coder 다시')
    await done
    assert.equal(turns, 1)
    updatedAt = Date.now()
    done = idle()
    conductor.sendHumanMessage(channel, '@Coder 또')
    await done
    assert.equal(turns, 2)
  })

  it('checks the project folder of an imported session, shows it, and stop cancels it', async () => {
    const state = room({ checkCommand: 'npm test' })
    const channel = state.channels[0]
    channel.members[0].writableRoots = ['/project']
    const seen: { cwd: string; activity: string | undefined }[] = []
    const { conductor, idle } = conduct(state, async () => ({ ok: true, text: '끝' }), {
      runCheck: (_command, cwd, signal) => {
        seen.push({ cwd, activity: conductor.activityOf().a })
        setTimeout(() => conductor.stop('a'), 5)
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve('killed')))
      }
    })
    const done = idle()
    conductor.sendHumanMessage(channel, '@Coder 해')
    await done
    assert.deepEqual(seen, [{ cwd: '/project', activity: 'checking' }])
    assert.equal(notices(state).at(-1), 'checkStopped')
    assert.ok(!channel.messages.some(({ alertMemberId }) => alertMemberId))
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
    assert.equal(notices(state).at(-1), 'turnStopped')
    assert.ok(!channel.messages.some(({ alertMemberId }) => alertMemberId))
  })

  it('runs `@name /compact` after the running turn, and the command never reaches a prompt', async () => {
    const state = room()
    const channel = state.channels[0]
    channel.members[0].sessionId = 's'
    const order: string[] = []
    const prompts: string[] = []
    const { conductor, idle } = conduct(
      state,
      async (_member, prompt) => {
        prompts.push(prompt)
        order.push('turn')
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { ok: true, text: '답', sessionId: 's' }
      },
      {
        sessionCommand: async (_member, command, args) => {
          order.push(`${command}:${args}`)
          return { ok: true, text: '' }
        }
      }
    )
    const done = idle()
    conductor.sendHumanMessage(channel, '@Coder 해')
    await new Promise((resolve) => setTimeout(resolve, 3))
    conductor.sendHumanMessage(channel, '@Coder /compact 테스트 위주로')
    conductor.sendHumanMessage(channel, '@Coder 다음')
    await done
    assert.deepEqual(order, ['turn', 'compact:테스트 위주로', 'turn'])
    assert.ok(!prompts[1].includes('/compact'))
    assert.ok(notices(state).includes('sessionCompacted'))
  })

  it('sets and resets the model and effort with `@name /model`', async () => {
    const state = room()
    const channel = state.channels[0]
    const coder = channel.members[0]
    const { conductor, idle } = conduct(state, async () => ({ ok: true, text: '답' }))
    let done = idle()
    conductor.sendHumanMessage(channel, '@Coder /model claude-sonnet-5-5 high')
    await done
    assert.deepEqual([coder.model, coder.effort], ['claude-sonnet-5-5', 'high'])
    assert.equal(notices(state).at(-1), 'modelChanged')
    done = idle()
    conductor.sendHumanMessage(channel, '@Coder /model default')
    await done
    assert.deepEqual([coder.model, coder.effort], [undefined, undefined])
    done = idle()
    conductor.sendHumanMessage(channel, '@Coder /model')
    await done
    assert.equal(notices(state).at(-1), 'modelUsage')
  })

  it('reads `/clear` only right after @names, and answers /compact without a session', async () => {
    const state = room()
    const channel = state.channels[0]
    const prompts: string[] = []
    const { conductor, idle } = conduct(state, async (_member, prompt) => {
      prompts.push(prompt)
      return { ok: true, text: '답' }
    })
    let done = idle()
    conductor.sendHumanMessage(channel, '@Coder /clear')
    await done
    assert.equal(notices(state).at(-1), 'sessionCleared')
    done = idle()
    conductor.sendHumanMessage(channel, '@Reviewer /compact')
    await done
    assert.equal(notices(state).at(-1), 'nothingToCompact')
    done = idle()
    conductor.sendHumanMessage(channel, '@Coder 이거 /clear 해')
    await done
    done = idle()
    conductor.sendHumanMessage(channel, '@Coder /clear 말고 이거 해')
    await done
    assert.equal(prompts.length, 2)
  })
})

describe('conductor language', () => {
  it("rejects in the conductor's language while notices stay English for agents", async () => {
    const state = room()
    const { conductor, idle } = conduct(state, async () => ({ ok: true, text: '' }))
    const done = idle()
    conductor.reject('a', 'ko')
    await done
    assert.ok(texts(state).includes('@Coder Not quite my tempo. 방금 결과는 반려다. 다시 짜와.'))
    conductor.sendHumanMessage(state.channels[0], '/tempo @Nobody', 'ko')
    assert.equal(texts(state).at(-1), '[System] There is no member called @Nobody.')
    assert.equal(texts(state).at(-2), '@Nobody Not quite my tempo. 방금 결과는 반려다. 다시 짜와.')
  })
})

describe('runShellCheck', () => {
  it('returns output only on failure', async () => {
    assert.equal(await runShellCheck('true', '/'), null)
    assert.ok((await runShellCheck('echo 빌드실패; exit 2', '/'))?.includes('빌드실패'))
  })
})
