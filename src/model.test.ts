import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildTurnPrompt,
  findAgentHandoffs,
  findMentions,
  linkEveryoneChannel,
  markDelivered,
  messageBody,
  deliveredThrough,
  parseTempoCommand,
  planHandoffs,
  reorderChannels,
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
    assert.deepEqual(findAgentHandoffs('"@리뷰어"라고 적어서 “@coder-agent” 불림', names, 'x'), [])
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

  it("hands a live session the master's words as typed, and the briefing once someone else speaks", () => {
    const live = { ...member, sessionId: 's', deliveredThrough: 2 }
    assert.equal(buildTurnPrompt(channel, live), '이후')
    const other = { id: 'z', seq: 4, author: { kind: 'agent' as const, memberId: 'm2', name: 'Reviewer' }, text: '봐줘', at: 4 }
    const busy = { ...channel, messages: [...channel.messages, other], nextSeq: 5 }
    const prompt = buildTurnPrompt(busy, live)
    assert.ok(prompt.startsWith('You are @Coder'))
    assert.ok(prompt.includes('[@Reviewer, not for you, cut short]\n봐줘'))
  })

  it('cuts talk between others short but keeps what concerns the member in full', () => {
    const live = { ...member, sessionId: 's', deliveredThrough: 3 }
    const long = 'x'.repeat(300)
    const say = (seq: number, memberId: string, name: string, text: string) =>
      ({ id: `m${seq}`, seq, author: { kind: 'agent' as const, memberId, name }, text, at: seq })
    const room = {
      ...channel,
      members: [member, { ...member, id: 'm2', name: 'Reviewer' }, { ...member, id: 'm3', name: 'Other' }],
      messages: [
        ...channel.messages.slice(0, 2).map((m, i) => (i === 1 ? { ...m, text: '@Reviewer 봐줘' } : m)),
        say(4, 'm3', 'Other', `first line ${long}\nsecond line`),
        say(5, 'm2', 'Reviewer', `done ${long}`),
        say(6, 'm3', 'Other', `@Coder ${long}`)
      ],
      nextSeq: 7
    }
    const prompt = buildTurnPrompt(room, live)
    assert.ok(prompt.includes('[@Other, not for you, cut short]\nfirst line'))
    assert.ok(!prompt.includes('second line'))
    assert.ok(prompt.includes(`done ${long}`))
    assert.ok(prompt.includes(`@Coder ${long}`))
  })

  it('keeps system notices out of the prompt', () => {
    const live = { ...member, sessionId: 's', deliveredThrough: 2 }
    const notice = { id: 'n', seq: 4, author: { kind: 'system' as const }, text: 'Compacted', at: 4 }
    const noisy = { ...channel, messages: [...channel.messages, notice], nextSeq: 5 }
    assert.equal(buildTurnPrompt(noisy, live), '이후')
  })

  it('drains stamina against the known window and infers 1M past 200k', () => {
    assert.equal(staminaPercent({}), 100)
    assert.equal(staminaPercent({ contextTokens: 100_000 }), 50)
    assert.equal(staminaPercent({ contextTokens: 500_000 }), 50)
    assert.equal(staminaPercent({ contextTokens: 300_000, windowTokens: 200_000 }), 0)
  })
})

describe('#all', () => {
  it('lends every agent a second room without copying it or sharing delivery marks', () => {
    const member: Member = { id: 'm1', name: 'Coder', harness: 'claude', instructions: '', cwd: '/repo', deliveredThrough: 5 }
    const home: Channel = { id: 'c1', name: 'dev', cwd: '/repo', checkCommand: '', members: [member], messages: [], nextSeq: 6, agentChain: 0 }
    const state = { channels: [home] }
    const all = linkEveryoneChannel(state)
    assert.equal(state.channels[0], all)
    assert.equal(all.members[0], member)
    home.members.push({ ...member, id: 'm2', name: 'Late' })
    assert.equal(all.members.length, 2)
    all.nextSeq = 3
    markDelivered(all, member)
    assert.equal(deliveredThrough(all, member), 2)
    assert.equal(member.deliveredThrough, 5)
    // A saved state reloads into the same single #all.
    const reloaded = JSON.parse(JSON.stringify(state))
    assert.equal(linkEveryoneChannel(reloaded).id, all.id)
    assert.equal(reloaded.channels.length, 2)
    assert.equal(reloaded.channels[0].members[1], reloaded.channels[1].members[1])
  })
})

describe('channel order', () => {
  it('moves the channels the master named and leaves #all in its slot', () => {
    const channel = (id: string, everyone?: true): Channel => ({ id, name: id, cwd: '', checkCommand: '', members: [], messages: [], nextSeq: 1, agentChain: 0, everyone })
    const channels = [channel('all', true), channel('a'), channel('b'), channel('c')]
    assert.deepEqual(reorderChannels(channels, ['c', 'a', 'b'])?.map(({ id }) => id), ['all', 'c', 'a', 'b'])
    for (const bad of [['a', 'b'], ['a', 'b', 'c', 'all'], ['a', 'a', 'b'], ['a', 'b', 'x'], 'a,b,c', undefined]) assert.equal(reorderChannels(channels, bad), null)
  })
})

describe('pastes', () => {
  it('swaps paste tokens back for the image path and the pasted text', () => {
    const body = messageBody({
      text: '@A 봐 [Image #1] 그리고 [Pasted text #1 +12 lines]',
      attachments: [
        { token: '[Image #1]', kind: 'image', path: '/tmp/a b.png' },
        { token: '[Pasted text #1 +12 lines]', kind: 'text', text: '긴 글' }
      ]
    })
    assert.equal(body, '@A 봐 `/tmp/a b.png` 그리고 \n긴 글\n')
  })
})
