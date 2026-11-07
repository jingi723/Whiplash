import { existsSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Harness } from './model.ts'

export type DiscoveredSession = {
  harness: Harness
  id: string
  cwd: string
  title: string
  updatedAt: number
  path: string
}

const HEAD_BYTES = 1024 * 1024
/** Claude appends custom and generated titles as the session goes on, so the end is read too. */
const TAIL_BYTES = 256 * 1024
const TITLE_LENGTH = 90
const DEFAULT_LIMIT = 40

async function readRange(path: string, fromEnd: boolean, bytes: number): Promise<string> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, fromEnd ? size - length : 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await file.close()
  }
}

const readHead = (path: string): Promise<string> => readRange(path, false, HEAD_BYTES)
const readTail = (path: string): Promise<string> => readRange(path, true, TAIL_BYTES)

function firstText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const block = content.find((item) => typeof item?.text === 'string')
  return block?.text ?? ''
}

/** Injected context arrives as prompts too; it opens with a tag or a Whiplash brief, not the user's words. */
function cleanTitle(text: string): string {
  const title = text.replace(/\s+/g, ' ').trim()
  return title.startsWith('<') ? '' : title.slice(0, TITLE_LENGTH)
}

type SessionHead = { id: string; cwd: string; title: string }

function* jsonRecords(text: string): Generator<Record<string, any>> {
  for (const line of text.split('\n')) {
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') {
        yield value
      }
    } catch {
      continue
    }
  }
}

/** Title and id rules from Orca's consumeClaudeSessionRecord: an explicit rename wins, then Claude's
 *  generated title, then the first real prompt (meta and injected turns skipped), then the agent name. */
export function parseClaudeHead(head: string, fallbackId: string, tail = ''): SessionHead | null {
  let id = ''
  let cwd = ''
  let firstPrompt = ''
  let agentName = ''
  let customTitle = ''
  let generatedTitle = ''
  const consume = (record: Record<string, any>, fromHead: boolean): void => {
    if (typeof record.sessionId === 'string' && record.sessionId.trim()) {
      id = fromHead ? id || record.sessionId.trim() : id
    }
    if (fromHead) {
      cwd ||= record.cwd ?? ''
    }
    if (record.type === 'custom-title') {
      customTitle = cleanTitle(record.customTitle ?? '')
    } else if (record.type === 'ai-title') {
      generatedTitle = cleanTitle(record.aiTitle ?? '') || generatedTitle
    } else if (record.type === 'agent-name') {
      agentName ||= cleanTitle(record.agentName ?? '')
    } else if (fromHead && record.type === 'user' && !record.isSidechain && record.isMeta !== true) {
      firstPrompt ||= cleanTitle(firstText(record.message?.content))
    }
  }
  for (const record of jsonRecords(head)) consume(record, true)
  for (const record of jsonRecords(tail)) consume(record, false)
  const title = customTitle || generatedTitle || firstPrompt || agentName
  return cwd ? { id: id || fallbackId, cwd, title } : null
}

// From Orca's readCodexNonUserOrigin: helper threads that no person started.
const NON_USER_SOURCE_TAGS = new Set(['subagent', 'internal'])
const NON_USER_THREAD_SOURCES = new Set(['subagent', 'guardian_review', 'memory_consolidation'])

function isNonUserCodexThread(payload: Record<string, any>): boolean {
  const threadSource = String(payload.thread_source ?? payload.threadSource ?? '').toLowerCase()
  if (threadSource === 'user') {
    return false
  }
  const source = payload.source
  const tag = typeof source === 'string' ? source : source && typeof source === 'object' ? Object.keys(source)[0] : ''
  return NON_USER_SOURCE_TAGS.has(tag) || NON_USER_THREAD_SOURCES.has(threadSource)
}

/** Only the first session_meta counts, because a fork copies its parent's later (Orca's Codex parser). */
export function parseCodexHead(head: string, indexTitles: ReadonlyMap<string, string> = new Map()): SessionHead | null {
  let meta: Record<string, any> | null = null
  let firstPrompt = ''
  for (const record of jsonRecords(head)) {
    const payload = record.payload ?? {}
    if (record.type === 'session_meta' && !meta) {
      if (isNonUserCodexThread(payload)) {
        return null
      }
      meta = payload
    } else if (payload.type === 'user_message') {
      firstPrompt ||= cleanTitle(payload.message ?? '')
    } else if (payload.type === 'item_completed' && payload.item?.type === 'UserMessage') {
      firstPrompt ||= cleanTitle(firstText(payload.item.content))
    }
    if (meta && firstPrompt) {
      break
    }
  }
  if (!meta?.id || !meta.cwd) {
    return null
  }
  const title = cleanTitle(meta.title ?? meta.thread_name ?? '') || indexTitles.get(meta.id) || firstPrompt
  return { id: meta.id, cwd: meta.cwd, title }
}

/** Codex keeps renamed thread titles in session_index.jsonl as {id, thread_name}. */
async function readCodexIndexTitles(home: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const text = await readRange(join(home, '.codex', 'session_index.jsonl'), true, 4 * 1024 * 1024).catch(() => '')
  for (const record of jsonRecords(text)) {
    const title = cleanTitle(String(record.thread_name ?? ''))
    if (typeof record.id === 'string' && title) {
      titles.set(record.id, title)
    }
  }
  return titles
}

async function walkJsonl(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(entry.parentPath, entry.name))
}

async function withTimes(paths: string[]): Promise<{ path: string; updatedAt: number }[]> {
  const rows = await Promise.all(
    paths.map(async (path) => {
      const info = await stat(path).catch(() => null)
      return info ? { path, updatedAt: info.mtimeMs } : null
    })
  )
  return rows.filter((row) => row !== null)
}

function claudeRoot(home: string): string {
  return join(home, '.claude', 'projects')
}

function codexRoot(home: string): string {
  return join(home, '.codex', 'sessions')
}

function isClaudeTopLevelSession(path: string, root: string): boolean {
  // Subagent transcripts nest deeper and cannot be resumed.
  return path.slice(root.length + 1).split('/').length === 2
}

/** Recent sessions from every console: nothing is registered, because the CLIs already write these files. */
export async function listSessions(
  home = homedir(),
  limit = DEFAULT_LIMIT
): Promise<DiscoveredSession[]> {
  const root = claudeRoot(home)
  const claudePaths = (await walkJsonl(root)).filter((path) => isClaudeTopLevelSession(path, root))
  const tagged = [
    ...(await withTimes(claudePaths)).map((row) => ({ ...row, harness: 'claude' as const })),
    ...(await withTimes(await walkJsonl(codexRoot(home)))).map((row) => ({
      ...row,
      harness: 'codex' as const
    }))
  ].toSorted((a, b) => b.updatedAt - a.updatedAt)

  const indexTitles = await readCodexIndexTitles(home)
  const sessions: DiscoveredSession[] = []
  for (const { path, updatedAt, harness } of tagged) {
    if (sessions.length >= limit) {
      break
    }
    const head = await readHead(path).catch(() => null)
    const fileId = path.slice(path.lastIndexOf('/') + 1, -'.jsonl'.length)
    const parsed =
      head &&
      (harness === 'claude'
        ? parseClaudeHead(head, fileId, await readTail(path).catch(() => ''))
        : parseCodexHead(head, indexTitles))
    // A session whose folder is gone cannot be resumed, so it is not offered.
    if (parsed && existsSync(parsed.cwd)) {
      sessions.push({ ...parsed, harness, updatedAt, path })
    }
  }
  return sessions
}

export async function findTranscript(
  harness: Harness,
  id: string,
  home = homedir()
): Promise<string | null> {
  const root = harness === 'claude' ? claudeRoot(home) : codexRoot(home)
  const paths = await walkJsonl(root)
  return paths.find((path) => path.endsWith(harness === 'claude' ? `/${id}.jsonl` : `${id}.jsonl`)) ?? null
}
