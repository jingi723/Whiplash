import { exec } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { StudioEvent, TurnResult } from './harness.ts'
import {
  AGENT_CHAIN_LIMIT,
  buildTurnPrompt,
  CHANNEL_MESSAGE_LIMIT,
  findMentions,
  parseTempoCommand,
  planHandoffs,
  tempoMessage,
  type Author,
  type Channel,
  type Member,
  type State
} from './model.ts'
import type { TurnRead } from './transcript.ts'

export type Activity = 'working' | 'queued'

export type ConductorDeps = {
  state: State
  runTurn: (
    member: Member,
    prompt: string,
    onEvent: (event: StudioEvent) => void,
    signal: AbortSignal
  ) => Promise<TurnResult>
  /** Newest context numbers for a finished session, and when its transcript last changed. */
  readSession: (member: Member) => Promise<(TurnRead & { updatedAt: number }) | null>
  runCheck: (command: string, cwd: string) => Promise<string | null>
  onChange: () => void
  onStudioEvent: (memberId: string, event: StudioEvent) => void
}

const CHECK_OUTPUT_LIMIT = 1500
const CHECK_TIMEOUT_MS = 10 * 60 * 1000
const FOREIGN_ACTIVITY_MS = 60_000
const OWN_WRITE_GRACE_MS = 3000

/** Returns the failure output, or null when the command passes. */
export async function runShellCheck(command: string, cwd: string): Promise<string | null> {
  try {
    await promisify(exec)(command, { cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
    return null
  } catch (error) {
    const { stdout = '', stderr = '', message } = error as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
    }
    return (`${stdout}${stderr}`.trim() || message).slice(-CHECK_OUTPUT_LIMIT)
  }
}

export function createConductor(deps: ConductorDeps) {
  const { state } = deps
  const running = new Map<string, AbortController>()
  const pending = new Set<string>()
  const activity = new Map<string, Activity>()

  const channelOf = (memberId: string): Channel | undefined =>
    state.channels.find(({ members }) => members.some(({ id }) => id === memberId))

  function append(channel: Channel, author: Author, text: string, alertMemberId?: string): void {
    channel.messages.push({
      id: randomUUID(),
      seq: channel.nextSeq++,
      author,
      text,
      at: Date.now(),
      ...(alertMemberId ? { alertMemberId } : {})
    })
    channel.messages.splice(0, channel.messages.length - CHANNEL_MESSAGE_LIMIT)
    deps.onChange()
  }

  function setActivity(memberId: string, value: Activity | null): void {
    if (value) {
      activity.set(memberId, value)
    } else {
      activity.delete(memberId)
    }
    deps.onChange()
  }

  function alert(channel: Channel, member: Member, detail: string): void {
    append(
      channel,
      { kind: 'system' },
      `[System] ${member.name}가 박자를 놓쳤습니다. 의자를 던지세요.\n${detail}`,
      member.id
    )
  }

  /** A mention that landed before the prompt was built is already answered. */
  function hasUnseenMessage(channel: Channel, member: Member): boolean {
    return channel.messages.some(
      ({ seq, author }) =>
        seq > member.deliveredThrough &&
        !(author.kind === 'agent' && author.memberId === member.id) &&
        author.kind !== 'system'
    )
  }

  function requestTurn(channel: Channel, member: Member): void {
    if (running.has(member.id)) {
      pending.add(member.id)
      setActivity(member.id, 'queued')
      return
    }
    const controller = new AbortController()
    running.set(member.id, controller)
    setActivity(member.id, 'working')
    void playTurn(channel, member, controller).finally(() => {
      running.delete(member.id)
      setActivity(member.id, null)
      if (pending.delete(member.id) && hasUnseenMessage(channel, member)) {
        requestTurn(channel, member)
      }
    })
  }

  async function warnIfUsedElsewhere(channel: Channel, member: Member): Promise<void> {
    const session = member.sessionId ? await deps.readSession(member) : null
    const quietUntil = (member.lastTurnEndedAt ?? 0) + OWN_WRITE_GRACE_MS
    if (session && Date.now() - session.updatedAt < FOREIGN_ACTIVITY_MS && session.updatedAt > quietUntil) {
      append(
        channel,
        { kind: 'system' },
        `[System] @${member.name} 세션이 방금 다른 콘솔에서 쓰였습니다. 그쪽에 열려 있다면 대화가 갈라질 수 있습니다.`
      )
    }
  }

  async function playTurn(
    channel: Channel,
    member: Member,
    controller: AbortController
  ): Promise<void> {
    await warnIfUsedElsewhere(channel, member)
    const prompt = buildTurnPrompt(channel, member)
    member.deliveredThrough = channel.nextSeq - 1
    const result = await deps.runTurn(
      member,
      prompt,
      (event) => deps.onStudioEvent(member.id, event),
      controller.signal
    )
    member.sessionId = result.sessionId ?? member.sessionId
    member.lastTurnEndedAt = Date.now()
    if (controller.signal.aborted) {
      append(channel, { kind: 'system' }, `[System] @${member.name} 턴을 멈췄습니다.`)
      return
    }
    if (result.text) {
      append(channel, { kind: 'agent', memberId: member.id, name: member.name }, result.text)
    }
    const session = await deps.readSession(member)
    member.contextTokens = session?.contextTokens ?? member.contextTokens
    member.windowTokens = session?.windowTokens ?? member.windowTokens
    if (!result.ok) {
      alert(channel, member, result.error ?? '턴이 실패했습니다.')
      return
    }
    if (channel.checkCommand) {
      const failure = await deps.runCheck(channel.checkCommand, member.cwd)
      if (failure) {
        alert(channel, member, `검사 실패: ${channel.checkCommand}\n${failure}`)
        return
      }
    }
    handOff(channel, member, result.text)
  }

  function handOff(channel: Channel, member: Member, reply: string): void {
    const { names, chainBroken } = planHandoffs(channel, member.name, reply)
    if (chainBroken) {
      append(
        channel,
        { kind: 'system' },
        `[System] 에이전트끼리 ${AGENT_CHAIN_LIMIT}번 주고받아 체인을 끊었습니다. 지휘자가 다시 지시해야 이어갑니다.`
      )
    }
    if (names.length > 0) {
      channel.agentChain += 1
    }
    wake(channel, names)
  }

  function wake(channel: Channel, names: string[]): void {
    for (const name of names) {
      const member = channel.members.find((candidate) => candidate.name === name)
      if (member) {
        requestTurn(channel, member)
      }
    }
  }

  function sendHumanMessage(channel: Channel, text: string): void {
    const tempo = parseTempoCommand(text)
    const body = tempo ? tempoMessage(tempo.name, tempo.reason) : text
    channel.agentChain = 0
    append(channel, { kind: 'human' }, body)
    const mentioned = findMentions(
      body,
      channel.members.map(({ name }) => name)
    )
    if (tempo && mentioned.length === 0) {
      append(channel, { kind: 'system' }, `[System] @${tempo.name} 멤버를 찾을 수 없습니다.`)
    }
    wake(channel, mentioned)
  }

  return {
    sendHumanMessage,
    channelOf,
    activityOf: (): Record<string, Activity> => Object.fromEntries(activity),
    reject(memberId: string): void {
      const channel = channelOf(memberId)
      const member = channel?.members.find(({ id }) => id === memberId)
      if (channel && member) {
        sendHumanMessage(channel, tempoMessage(member.name, ''))
      }
    },
    stop(memberId: string): void {
      pending.delete(memberId)
      running.get(memberId)?.abort()
    },
    stopAll(): void {
      running.forEach((controller) => controller.abort())
    }
  }
}
