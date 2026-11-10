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
  parseSessionCommand,
  parseTempoCommand,
  planHandoffs,
  projectFolder,
  SESSION_COMMANDS,
  tempoMessage,
  type Attachment,
  type Author,
  type Channel,
  type Locale,
  type Member,
  type Message,
  type Notice,
  type SessionCommand,
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
  /** Runs a slash command on the member's session; the member is idle while it runs. */
  sessionCommand: (
    member: Member,
    command: SessionCommand['command'],
    args: string,
    onEvent: (event: StudioEvent) => void,
    signal: AbortSignal
  ) => Promise<TurnResult>
  /** Slash commands the member's CLI offers beyond the ones Whiplash runs itself. */
  commandsOf?: (member: Member) => string[]
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
  /** Commands wait for the member's turn to end; a `/clear` mid-turn would throw that turn's work away. */
  const commands = new Map<string, Array<{ channel: Channel; command: SessionCommand['command']; args: string }>>()

  const channelOf = (memberId: string): Channel | undefined =>
    state.channels.find(({ everyone, members }) => !everyone && members.some(({ id }) => id === memberId))

  function append(
    channel: Channel,
    author: Author,
    text: string,
    extra: Pick<Message, 'alertMemberId' | 'notice' | 'attachments' | 'command'> = {}
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
      ({ seq, author, command }) =>
        !command &&
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
    start(channel, member, (controller) => playTurn(channel, member, controller))
  }

  function requestCommand(channel: Channel, member: Member, command: SessionCommand['command'], args: string): void {
    if (running.has(member.id)) {
      commands.set(member.id, [...(commands.get(member.id) ?? []), { channel, command, args }])
      deps.onChange()
      return
    }
    start(channel, member, (controller) => playCommand(channel, member, command, args, controller))
  }

  function start(channel: Channel, member: Member, play: (controller: AbortController) => Promise<void>): void {
    const controller = new AbortController()
    running.set(member.id, controller)
    runningIn.set(member.id, channel)
    setActivity(member.id, 'working')
    void play(controller).finally(() => {
      running.delete(member.id)
      runningIn.delete(member.id)
      setActivity(member.id, null)
      const next = commands.get(member.id)?.shift()
      if (next) {
        requestCommand(next.channel, member, next.command, next.args)
        return
      }
      commands.delete(member.id)
      const queued = pending.get(member.id) ?? []
      pending.delete(member.id)
      for (const waiting of queued) {
        if (hasUnseenMessage(waiting, member)) requestTurn(waiting, member)
      }
    })
  }

  async function playCommand(
    channel: Channel,
    member: Member,
    command: SessionCommand['command'],
    args: string,
    controller: AbortController
  ): Promise<void> {
    if (command === 'model') {
      // `default` hands the choice back to the CLI's own settings.
      const [model, effort] = args.split(/\s+/).filter(Boolean).map((word) => (word === 'default' ? undefined : word))
      if (!args || [model, effort].some((word) => word && !/^[\w.[\]-]+$/.test(word))) {
        notify(channel, 'modelUsage', { name: member.name })
        return
      }
      member.model = model
      member.effort = effort
    }
    const own = SESSION_COMMANDS.includes(command)
    // The TUI runs every command itself, menus included, so an open terminal gets the command as typed.
    if (!own && deps.isAttached?.(member) && deps.inject) {
      await deps.inject(member, `/${command} ${args}`.trim())
      notify(channel, 'commandTyped', { name: member.name, command: `/${command}` })
      return
    }
    if (!own && (await isUsedElsewhere(member))) {
      notify(channel, 'busyElsewhere', { name: member.name })
      return
    }
    if (command === 'compact') {
      if (!member.sessionId || member.harness !== 'claude') {
        notify(channel, member.sessionId ? 'compactUnsupported' : 'nothingToCompact', { name: member.name })
        return
      }
      if (await isUsedElsewhere(member)) {
        notify(channel, 'busyElsewhere', { name: member.name })
        return
      }
    }
    const result = await deps.sessionCommand(
      member,
      command,
      args,
      (event) => deps.onStudioEvent(member.id, event),
      controller.signal
    )
    member.lastTurnEndedAt = Date.now()
    member.slashCommands = result.slashCommands ?? member.slashCommands
    if (controller.signal.aborted) {
      notify(channel, 'turnStopped', { name: member.name })
      return
    }
    if (!result.ok) {
      notify(channel, 'turnFailed', { name: member.name, error: result.error ?? 'Command failed' }, member.id)
      return
    }
    if (!own) {
      // A skill can start the member's first session; its answer is the command's output, not a handoff.
      member.sessionId = result.sessionId ?? member.sessionId
      if (result.text) append(channel, { kind: 'agent', memberId: member.id, name: member.name }, result.text, { command: true })
    }
    if (command !== 'clear' && command !== 'model') {
      const session = await deps.readSession(member)
      // After a compact the transcript has no usage yet, which means the old count is gone.
      if (session) member.contextTokens = session.contextTokens
    }
    if (!own) return
    if (command === 'model') {
      notify(channel, 'modelChanged', { name: member.name, model: member.model ?? 'default', effort: member.effort ?? 'default' })
      return
    }
    notify(channel, command === 'clear' ? 'sessionCleared' : 'sessionCompacted', { name: member.name })
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
    member.slashCommands = result.slashCommands ?? member.slashCommands
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
    const command = parseSessionCommand(
      text,
      channel.members.map(({ name }) => name),
      (name, typed) => {
        const member = channel.members.find((candidate) => candidate.name === name)
        return SESSION_COMMANDS.includes(typed) || Boolean(member && deps.commandsOf?.(member).includes(typed))
      }
    )
    if (command) {
      append(channel, { kind: 'human' }, text.trim(), { command: true })
      for (const name of command.names) {
        const member = channel.members.find((candidate) => candidate.name === name)
        if (member) requestCommand(channel, member, command.command, command.args)
      }
      return
    }
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
    queuedOf: (): string[] => [...new Set([...pending.keys(), ...commands.keys()])],
    reject(memberId: string, locale: Locale = 'en'): void {
      const channel = channelOf(memberId)
      const member = channel?.members.find(({ id }) => id === memberId)
      if (channel && member) {
        sendHumanMessage(channel, tempoMessage(member.name, '', locale), locale)
      }
    },
    stop(memberId: string): void {
      pending.delete(memberId)
      commands.delete(memberId)
      running.get(memberId)?.abort()
    },
    stopAll(): void {
      running.forEach((controller) => controller.abort())
    }
  }
}
