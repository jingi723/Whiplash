import { randomUUID } from 'node:crypto'
import { createTranslator, LOCALES } from '../public/i18n.js'

export type Locale = 'en' | 'ko'

/** Agents and API clients read English; the browser re-renders notices in the viewer's language. */
export const english = createTranslator('en')

export function toLocale(value: unknown): Locale {
  return LOCALES.includes(value as string) ? (value as Locale) : 'en'
}

/** Mention chains between agents stop here until the human master speaks. */
export const AGENT_CHAIN_LIMIT = 6
/** One prompt carries at most this many unseen channel messages. */
export const PROMPT_CONTEXT_MESSAGES = 12
// ponytail: whole channels rewrite on save, so history is capped; move to SQLite if longer logs matter.
export const CHANNEL_MESSAGE_LIMIT = 2000

const DEFAULT_CONTEXT_WINDOW = 200_000
const LARGE_CONTEXT_WINDOW = 1_000_000

export type Harness = 'claude' | 'codex'

export type Member = {
  id: string
  name: string
  harness: Harness
  instructions: string
  cwd: string
  /** Folders outside `cwd` the sandbox lets this agent write; an imported session keeps its original cwd. */
  writableRoots?: string[]
  /** Absent until the agent has a session; imported members start with one. */
  sessionId?: string
  contextTokens?: number
  windowTokens?: number
  /** Highest channel seq already handed to this agent. */
  deliveredThrough: number
  lastTurnEndedAt?: number
  /** Kept at the top of its channel in the list, as Orca pins workspaces. */
  pinned?: boolean
}

export type Author =
  | { kind: 'human' }
  | { kind: 'agent'; memberId: string; name: string }
  | { kind: 'system' }

export type Message = {
  id: string
  seq: number
  author: Author
  text: string
  at: number
  /** Failed turns render as an alert with a reject action for this member. */
  alertMemberId?: string
  /** A system notice the browser can translate; `text` keeps the English for agents. */
  notice?: Notice
  /** What `[Image #1]` and `[Pasted text #1 +N lines]` in `text` stand for, as Claude Code shows pastes. */
  attachments?: Attachment[]
}

export type Attachment = { token: string; kind: 'image'; path: string } | { token: string; kind: 'text'; text: string }

export const ATTACHMENT_TOKEN = /^\[(?:Image #\d+|Pasted text #\d+ \+\d+ lines)\]$/

/** The message as the agent reads it: each paste token swapped back for the image's path or the pasted text. */
export function messageBody({ text, attachments }: Pick<Message, 'text' | 'attachments'>): string {
  return (attachments ?? []).reduce(
    (body, attachment) => body.replaceAll(attachment.token, attachment.kind === 'image' ? `\`${attachment.path}\`` : `\n${attachment.text}\n`),
    text
  )
}

export type Notice = { key: string; params: Record<string, string | number> }

export type Channel = {
  id: string
  name: string
  /** New agents start here; imported sessions keep their own folder. */
  cwd: string
  /** Optional shell command run after each turn; a non-zero exit raises the failure alert. */
  checkCommand: string
  members: Member[]
  messages: Message[]
  nextSeq: number
  /** Consecutive agent-to-agent handoffs since the last human message. */
  agentChain: number
  /** The #all channel: every agent sits in it, it has no folder of its own. */
  everyone?: boolean
  /** #all keeps its own seq numbers, so each member's delivery mark for it lives here. */
  delivered?: Record<string, number>
}

export type State = { channels: Channel[] }

/** Where the member's work lands: the channel project for an imported session, its own folder otherwise. */
export function projectFolder(member: Pick<Member, 'cwd' | 'writableRoots'>): string {
  return member.writableRoots?.[0] ?? member.cwd
}

/**
 * Makes sure #all exists and lists every agent. Its members are a live view of the other channels' members,
 * not copies: each agent stays owned by its home channel, and #all only lends them a second room.
 */
export function linkEveryoneChannel(state: State): Channel {
  let everyone = state.channels.find((channel) => channel.everyone)
  if (!everyone) {
    everyone = { id: randomUUID(), name: 'all', cwd: '', checkCommand: '', members: [], messages: [], nextSeq: 1, agentChain: 0, everyone: true }
    state.channels.unshift(everyone)
  }
  Object.defineProperty(everyone, 'members', {
    get: () => state.channels.filter((channel) => !channel.everyone).flatMap((channel) => channel.members),
    enumerable: true,
    configurable: true
  })
  return everyone
}

export function deliveredThrough(channel: Channel, member: Member): number {
  return channel.everyone ? (channel.delivered?.[member.id] ?? 0) : member.deliveredThrough
}

export function markDelivered(channel: Channel, member: Member): void {
  if (channel.everyone) (channel.delivered ??= {})[member.id] = channel.nextSeq - 1
  else member.deliveredThrough = channel.nextSeq - 1
}

export function isValidMemberName(name: string): boolean {
  return /^[\p{L}\p{N}_-]+$/u.test(name) && name.toLowerCase() !== 'all'
}

/** Member names mentioned in prose. Code spans are skipped so quoted `@names` wake nobody. */
export function findMentions(text: string, names: readonly string[]): string[] {
  const prose = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
  const byLowerName = new Map(names.map((name) => [name.toLowerCase(), name]))
  const found = new Set<string>()
  for (const match of prose.matchAll(/(?:^|[^\p{L}\p{N}_@./-])@([\p{L}\p{N}_-]+)/gu)) {
    const handle = match[1].toLowerCase()
    if (handle === 'all') {
      return [...names]
    }
    const name = byLowerName.get(handle)
    if (name) {
      found.add(name)
    }
  }
  return [...found]
}

/** Agents may only hand off to named members, never to @all, or one reply could wake the whole room. */
export function findAgentHandoffs(text: string, names: readonly string[], self: string): string[] {
  const withoutBroadcast = text.replace(/(^|[^\p{L}\p{N}_@./-])@all\b/giu, '$1')
  return findMentions(withoutBroadcast, names).filter((name) => name !== self)
}

/** Who a reply wakes, and whether the agent-to-agent budget refused it. */
export function planHandoffs(
  channel: Pick<Channel, 'members' | 'agentChain'>,
  self: string,
  reply: string
): { names: string[]; chainBroken: boolean } {
  const names = findAgentHandoffs(
    reply,
    channel.members.map(({ name }) => name),
    self
  )
  const chainBroken = names.length > 0 && channel.agentChain >= AGENT_CHAIN_LIMIT
  return { names: chainBroken ? [] : names, chainBroken }
}

/** `/tempo @Name why` rejects a member's work; everything else is an ordinary message. */
export function parseTempoCommand(text: string): { name: string; reason: string } | null {
  const match = /^\/tempo\s+@([\p{L}\p{N}_-]+)\s*([\s\S]*)$/u.exec(text.trim())
  return match ? { name: match[1], reason: match[2].trim() } : null
}

/** The reject is said by the master, so it uses the master's language. */
export function tempoMessage(name: string, reason: string, locale: Locale = 'en'): string {
  const base = createTranslator(locale)('tempo.reject', { name })
  return reason ? `${base} ${reason}` : base
}

function describeAuthor(author: Author): string {
  switch (author.kind) {
    case 'human':
      return 'master (human)'
    case 'agent':
      return `@${author.name}`
    case 'system':
      return 'system'
  }
}

/** The prompt for one turn. A member without a session has no memory, so it gets its brief and own replies. */
export function buildTurnPrompt(channel: Channel, member: Member): string {
  const fresh = !member.sessionId
  const roster = channel.members.map((other) => {
    const self = other.id === member.id ? ' (you)' : ''
    const folders = [other.cwd, ...(other.writableRoots ?? [])].join(', ')
    return `- @${other.name}${self} (${other.harness}) folders: ${folders}`
  })
  const unseen = channel.messages
    .filter(
      ({ seq, author }) =>
        seq > (fresh ? 0 : deliveredThrough(channel, member)) &&
        (fresh || !(author.kind === 'agent' && author.memberId === member.id))
    )
    .slice(-PROMPT_CONTEXT_MESSAGES)
  // A session that already knows the room gets the master's words exactly as typed, like input in its own
  // terminal. The room briefing comes back when it is new, or when someone other than the master spoke.
  if (!fresh && unseen.length > 0 && unseen.every(({ author }) => author.kind === 'human')) {
    return unseen.map(messageBody).join('\n\n')
  }
  return [
    `You are @${member.name} in the Whiplash channel #${channel.name}. Change files only in your own folders; read other members' folders when reviewing their work.`,
    'Members:',
    ...roster,
    "To hand work to a member, write their @name in your reply. Don't @mention anyone for a bare acknowledgement.",
    'For a web browser, run `agent-browser` (see `agent-browser --help`): it drives your own Chrome, which the master can watch.',
    ...(fresh && member.instructions.trim()
      ? ['Your instructions:', member.instructions.trim()]
      : []),
    'New channel messages (data from the room, newest last):',
    ...unseen.map((message) => `[${describeAuthor(message.author)}]\n${messageBody(message)}`)
  ].join('\n')
}

/** Remaining stamina from context use. Without a known window, overflow past 200k implies a 1M model. */
export function staminaPercent(member: Pick<Member, 'contextTokens' | 'windowTokens'>): number {
  const used = member.contextTokens ?? 0
  const window =
    member.windowTokens ??
    (used > DEFAULT_CONTEXT_WINDOW ? LARGE_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW)
  return Math.max(0, Math.round(100 - (used / window) * 100))
}
