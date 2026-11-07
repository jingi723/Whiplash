import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildTurnPrompt,
  findAgentHandoffs,
  findMentions,
  parseTempoCommand,
  planHandoffs,
  staminaPercent,
  type Channel,
  type Member
} from './model.ts'

const names = ['Coder-Agent', '리뷰어']

describe('mentions', () => {
  it('resolves names case-insensitively, including Korean, and ignores emails and code', () => {
    assert.deepEqual(findMentions('@coder-agent 고쳐, @리뷰어, 봐줘', names), names)
    assert.deepEqual(findMentions('mail me@Coder-Agent `@리뷰어`', names), [])
    assert.deepEqual(findMentions('```\n@리뷰어\n```', names), [])
  })

  it('broadcasts @all for humans but never for agents', () => {
    assert.deepEqual(findMentions('@all 시작', names), names)
    assert.deepEqual(findAgentHandoffs('@all 끝', names, 'Coder-Agent'), [])
    assert.deepEqual(findAgentHandoffs('@Coder-Agent @리뷰어 봐줘', names, 'Coder-Agent'), ['리뷰어'])
  })

  it('stops agent chains at the budget without flagging replies that hand off to nobody', () => {
    const members = [{ name: 'A' }, { name: 'B' }] as Member[]
    assert.deepEqual(planHandoffs({ members, agentChain: 5 }, 'A', '@B 봐줘'), {
      names: ['B'],
      chainBroken: false
    })
    assert.deepEqual(planHandoffs({ members, agentChain: 6 }, 'A', '@B 봐줘'), {
      names: [],
      chainBroken: true
    })
    assert.deepEqual(planHandoffs({ members, agentChain: 6 }, 'A', '끝'), {
      names: [],
      chainBroken: false
    })
  })

  it('parses /tempo with and without a reason', () => {
    assert.deepEqual(parseTempoCommand('/tempo @리뷰어 테스트 없음'), {
      name: '리뷰어',
      reason: '테스트 없음'
    })
    assert.deepEqual(parseTempoCommand('/tempo @리뷰어'), { name: '리뷰어', reason: '' })
    assert.equal(parseTempoCommand('tempo @리뷰어'), null)
  })
})

describe('turns', () => {
  const member: Member = {
    id: 'm1',
    name: 'Coder',
    harness: 'claude',
    instructions: '꼼꼼히',
    cwd: '/repo',
    deliveredThrough: 0
  }
  const channel: Channel = {
    id: 'c1',
    name: 'general',
    cwd: '/repo',
    checkCommand: '',
    members: [member],
    messages: [
      { id: 'a', seq: 1, author: { kind: 'human' }, text: '이전', at: 1 },
      { id: 'b', seq: 2, author: { kind: 'agent', memberId: 'm1', name: 'Coder' }, text: '내 답', at: 2 },
      { id: 'c', seq: 3, author: { kind: 'human' }, text: '이후', at: 3 }
    ],
    nextSeq: 4,
    agentChain: 0
  }

  it('briefs a memoryless agent with instructions and its own past replies', () => {
    const prompt = buildTurnPrompt(channel, member)
    for (const expected of ['꼼꼼히', '이전', '내 답', '이후']) {
      assert.ok(prompt.includes(expected), expected)
    }
  })

  it('sends a live session only what it has not seen', () => {
    const prompt = buildTurnPrompt(channel, { ...member, sessionId: 's', deliveredThrough: 1 })
    for (const unexpected of ['꼼꼼히', '이전', '내 답']) {
      assert.ok(!prompt.includes(unexpected), unexpected)
    }
    assert.ok(prompt.includes('이후'))
  })

  it('drains stamina against the known window and infers 1M past 200k', () => {
    assert.equal(staminaPercent({}), 100)
    assert.equal(staminaPercent({ contextTokens: 100_000 }), 50)
    assert.equal(staminaPercent({ contextTokens: 500_000 }), 50)
    assert.equal(staminaPercent({ contextTokens: 300_000, windowTokens: 200_000 }), 0)
  })
})
