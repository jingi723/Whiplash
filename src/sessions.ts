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
const TITLE_LENGTH = 90
const DEFAULT_LIMIT = 40

async function readHead(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await file.close()
  }
}

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

export function parseClaudeHead(head: string, fallbackId: string): SessionHead | null {
  let cwd = ''
  let title = ''
  for (const line of head.split('\n')) {
    try {
      const row = JSON.parse(line)
      cwd ||= row.cwd ?? ''
      if (row.type === 'user' && !row.isSidechain) {
        title ||= cleanTitle(firstText(row.message?.content))
      }
    } catch {
      continue
    }
    if (cwd && title) {
      break
    }
  }
  return cwd ? { id: fallbackId, cwd, title } : null
}

export function parseCodexHead(head: string): SessionHead | null {
  let id = ''
  let cwd = ''
  let title = ''
  for (const line of head.split('\n')) {
    try {
      const row = JSON.parse(line)
      const payload = row.payload ?? {}
      if (row.type === 'session_meta') {
        id = payload.id ?? ''
        cwd = payload.cwd ?? ''
      } else if (payload.type === 'user_message') {
        title ||= cleanTitle(payload.message ?? '')
      } else if (payload.type === 'item_completed' && payload.item?.type === 'UserMessage') {
        title ||= cleanTitle(firstText(payload.item.content))
      }
    } catch {
      continue
    }
    if (id && title) {
      break
    }
  }
  return id && cwd ? { id, cwd, title } : null
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

  const sessions: DiscoveredSession[] = []
  for (const { path, updatedAt, harness } of tagged) {
    if (sessions.length >= limit) {
      break
    }
    const head = await readHead(path).catch(() => null)
    const fileId = path.slice(path.lastIndexOf('/') + 1, -'.jsonl'.length)
    const parsed = head && (harness === 'claude' ? parseClaudeHead(head, fileId) : parseCodexHead(head))
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
