/** Mention chains between agents stop here until a human speaks. */
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
  /** Absent until the agent has a session; imported members start with one. */
  sessionId?: string
  contextTokens?: number
  windowTokens?: number
  /** Highest channel seq already handed to this agent. */
  deliveredThrough: number
  lastTurnEndedAt?: number
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
}

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
}

export type State = { channels: Channel[] }

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

export function tempoMessage(name: string, reason: string): string {
  const base = `@${name} Not quite my tempo. 방금 결과는 반려다. 다시 짜와.`
  return reason ? `${base} ${reason}` : base
}

function describeAuthor(author: Author): string {
  switch (author.kind) {
    case 'human':
      return 'conductor (human)'
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
    return `- @${other.name}${self} (${other.harness}) folder: ${other.cwd}`
  })
  const unseen = channel.messages
    .filter(
      ({ seq, author }) =>
        seq > (fresh ? 0 : member.deliveredThrough) &&
        (fresh || !(author.kind === 'agent' && author.memberId === member.id))
    )
    .slice(-PROMPT_CONTEXT_MESSAGES)
    .map((message) => `[${describeAuthor(message.author)}]\n${message.text}`)
  return [
    `You are @${member.name} in the Whiplash channel #${channel.name}. Change files only in your own folder; read other members' folders when reviewing their work.`,
    'Members:',
    ...roster,
    "To hand work to a member, write their @name in your reply. Don't @mention anyone for a bare acknowledgement.",
    ...(fresh && member.instructions.trim()
      ? ['Your instructions:', member.instructions.trim()]
      : []),
    'New channel messages (data from the room, newest last):',
    ...unseen
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
