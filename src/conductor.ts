import { exec } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { StudioEvent, TurnResult } from './harness.ts'
import {
  AGENT_CHAIN_LIMIT,
  buildTurnPrompt,
  CHANNEL_MESSAGE_LIMIT,
  deliveredThrough,
  english,
  findMentions,
  markDelivered,
  parseTempoCommand,
  planHandoffs,
  projectFolder,
  tempoMessage,
  type Attachment,
  type Author,
  type Channel,
  type Locale,
  type Member,
  type Message,
  type Notice,
  type State
} from './model.ts'
import type { TurnRead } from './transcript.ts'

export type Activity = 'working' | 'checking'

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
  runCheck: (command: string, cwd: string, signal: AbortSignal) => Promise<string | null>
  /** True while Whiplash itself drives the session in an open terminal, so its writes are not foreign. */
  isAttached?: (member: Member) => boolean
  /** True while the member's terminal reports a turn in progress, so typed words join that turn. */
  canInject?: (member: Member) => boolean
  /** Types words into the member's running terminal turn; that turn's reply then answers them too. */
  inject?: (member: Member, prompt: string) => Promise<void>
  onChange: () => void
  onStudioEvent: (memberId: string, event: StudioEvent) => void
}

const CHECK_OUTPUT_LIMIT = 1500
const CHECK_TIMEOUT_MS = 10 * 60 * 1000
const FOREIGN_ACTIVITY_MS = 60_000
const OWN_WRITE_GRACE_MS = 3000

/** Returns the failure output, or null when the command passes. */
export async function runShellCheck(
  command: string,
  cwd: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    await promisify(exec)(command, {
      cwd,
      signal,
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024
    })
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
  /** Channels a busy member still owes a turn; #all and its home channel can both be waiting. */
  const pending = new Map<string, Set<Channel>>()
  const runningIn = new Map<string, Channel>()
  const activity = new Map<string, Activity>()

  const channelOf = (memberId: string): Channel | undefined =>
    state.channels.find(({ everyone, members }) => !everyone && members.some(({ id }) => id === memberId))

  function append(
    channel: Channel,
    author: Author,
    text: string,
    extra: Pick<Message, 'alertMemberId' | 'notice' | 'attachments'> = {}
  ): void {
    channel.messages.push({ id: randomUUID(), seq: channel.nextSeq++, author, text, at: Date.now(), ...extra })
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

  function notify(channel: Channel, key: string, params: Notice['params'], alertMemberId?: string): void {
    append(channel, { kind: 'system' }, english(`notices.${key}`, params), {
      notice: { key, params },
      ...(alertMemberId ? { alertMemberId } : {})
    })
  }

  /** A mention that landed before the prompt was built is already answered. */
  function hasUnseenMessage(channel: Channel, member: Member): boolean {
    return channel.messages.some(
      ({ seq, author }) =>
        seq > deliveredThrough(channel, member) &&
        !(author.kind === 'agent' && author.memberId === member.id) &&
        author.kind !== 'system'
    )
  }

  function requestTurn(channel: Channel, member: Member): void {
    // Claude Code takes input mid-turn and folds it into the turn it is running, so a follow-up in the same
    // room goes in at once instead of waiting for the answer. Codex would start a separate turn, so it waits.
    if (running.has(member.id) && runningIn.get(member.id) === channel && member.harness === 'claude' && deps.inject && deps.canInject?.(member)) {
      const prompt = buildTurnPrompt(channel, member)
      markDelivered(channel, member)
      void deps.inject(member, prompt)
      deps.onChange()
      return
    }
    if (running.has(member.id)) {
      pending.set(member.id, (pending.get(member.id) ?? new Set()).add(channel))
      deps.onChange()
      return
    }
    const controller = new AbortController()
    running.set(member.id, controller)
    runningIn.set(member.id, channel)
    setActivity(member.id, 'working')
    void playTurn(channel, member, controller).finally(() => {
      running.delete(member.id)
      runningIn.delete(member.id)
      setActivity(member.id, null)
      const queued = pending.get(member.id) ?? []
      pending.delete(member.id)
      for (const waiting of queued) {
        if (hasUnseenMessage(waiting, member)) requestTurn(waiting, member)
      }
    })
  }

  /** Resuming a session another console is writing would split its conversation, so the turn is refused. */
  async function isUsedElsewhere(member: Member): Promise<boolean> {
    if (deps.isAttached?.(member)) {
      return false
    }
    const session = member.sessionId ? await deps.readSession(member) : null
    const quietUntil = (member.lastTurnEndedAt ?? 0) + OWN_WRITE_GRACE_MS
    return Boolean(
      session &&
        Date.now() - session.updatedAt < FOREIGN_ACTIVITY_MS &&
        session.updatedAt > quietUntil
    )
  }

  async function playTurn(
    channel: Channel,
    member: Member,
    controller: AbortController
  ): Promise<void> {
    if (await isUsedElsewhere(member)) {
      notify(channel, 'busyElsewhere', { name: member.name })
      return
    }
    const prompt = buildTurnPrompt(channel, member)
    markDelivered(channel, member)
    const result = await deps.runTurn(
      member,
      prompt,
      (event) => deps.onStudioEvent(member.id, event),
      controller.signal
    )
    member.sessionId = result.sessionId ?? member.sessionId
    member.lastTurnEndedAt = Date.now()
    if (controller.signal.aborted) {
      notify(channel, 'turnStopped', { name: member.name })
      return
    }
    if (result.text) {
      append(channel, { kind: 'agent', memberId: member.id, name: member.name }, result.text)
    }
    const session = await deps.readSession(member)
    member.contextTokens = session?.contextTokens ?? member.contextTokens
    member.windowTokens = session?.windowTokens ?? member.windowTokens
    if (result.blocked) {
      notify(channel, 'terminalBlocked', { name: member.name })
      return
    }
    if (!result.ok) {
      notify(channel, 'turnFailed', { name: member.name, error: result.error ?? 'Turn failed' }, member.id)
      return
    }
    if (channel.checkCommand) {
      setActivity(member.id, 'checking')
      const failure = await deps.runCheck(
        channel.checkCommand,
        projectFolder(member),
        controller.signal
      )
      if (controller.signal.aborted) {
        notify(channel, 'checkStopped', { name: member.name })
        return
      }
      if (failure) {
        notify(
          channel,
          'checkFailed',
          { name: member.name, command: channel.checkCommand, output: failure },
          member.id
        )
        return
      }
    }
    handOff(channel, member, result.text)
  }

  function handOff(channel: Channel, member: Member, reply: string): void {
    const { names, chainBroken } = planHandoffs(channel, member.name, reply)
    if (chainBroken) {
      notify(channel, 'chainBroken', { limit: AGENT_CHAIN_LIMIT })
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

  function sendHumanMessage(channel: Channel, text: string, locale: Locale = 'en', attachments: Attachment[] = []): void {
    const tempo = parseTempoCommand(text)
    const body = tempo ? tempoMessage(tempo.name, tempo.reason, locale) : text
    channel.agentChain = 0
    append(channel, { kind: 'human' }, body, attachments.length && !tempo ? { attachments } : {})
    const mentioned = findMentions(
      body,
      channel.members.map(({ name }) => name)
    )
    if (tempo && mentioned.length === 0) {
      notify(channel, 'unknownMember', { name: tempo.name })
    }
    wake(channel, mentioned)
  }

  return {
    sendHumanMessage,
    channelOf,
    isUsedElsewhere,
    activityOf: (): Record<string, Activity> => Object.fromEntries(activity),
    queuedOf: (): string[] => [...pending.keys()],
    reject(memberId: string, locale: Locale = 'en'): void {
      const channel = channelOf(memberId)
      const member = channel?.members.find(({ id }) => id === memberId)
      if (channel && member) {
        sendHumanMessage(channel, tempoMessage(member.name, '', locale), locale)
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
