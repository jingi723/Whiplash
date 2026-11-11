// Leftover worktrees, after Orca's "Delete Inactive Workspaces" (src/shared/workspace-cleanup, MIT,
// Copyright (c) 2026 Lovecast Inc.): idle ones and ones no member uses any more, asked about one by one.
import { existsSync, realpathSync } from 'node:fs'
import { open, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { listWorktrees, worktreeRisk, type WorktreeEntry } from './git.ts'
import type { Channel, WorktreeDecision } from './model.ts'

export const STALE_MS = 7 * 24 * 60 * 60 * 1000
/** Tests and scratch servers point this elsewhere so real transcripts are never scanned or deleted. */
export const claudeProjects = process.env.WHIPLASH_CLAUDE_PROJECTS ?? join(homedir(), '.claude', 'projects')

export type CleanupItem = {
  path: string
  name: string
  /** The main checkout the worktree belongs to; null when git no longer knows it. */
  repo: string | null
  branch: string | null
  target: string | null
  dirty: boolean
  unmerged: number
  missing: boolean
  lastActiveAt: number
  memberId?: string
  memberName?: string
  channelName?: string
  transcripts: string[]
}

/** Losing work: uncommitted files, unmerged commits, or a folder git cannot vouch for. */
export const isRisky = (item: CleanupItem): boolean => item.dirty || item.unmerged > 0 || !item.repo

/** Ask about a worktree nobody uses, or one idle for a week, unless the master kept or snoozed it. */
export function needsAsking(item: CleanupItem, decision: WorktreeDecision | undefined, now: number, ignoreSnooze = false): boolean {
  if (decision?.keep) return false
  if (!ignoreSnooze && (decision?.snoozedUntil ?? 0) > now) return false
  return !item.memberId || now - item.lastActiveAt >= STALE_MS
}

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Claude Code's project folder name: every character but ASCII letters and digits becomes `-` (lossy for Korean). */
export const claudeProjectName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

async function transcriptCwd(path: string): Promise<string | null> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buffer.toString('utf8', 0, bytesRead))
    return match ? (JSON.parse(`"${match[1]}"`) as string) : null
  } finally {
    await file.close()
  }
}

/** Sessions recorded in one of these folders; the `cwd` inside each file decides, since names can collide. */
export async function findTranscripts(cwds: string[], root = claudeProjects): Promise<string[]> {
  const wanted = new Set(cwds)
  const found: string[] = []
  for (const folder of new Set(cwds.map((cwd) => join(root, claudeProjectName(cwd))))) {
    for (const name of await readdir(folder).catch(() => [])) {
      const path = join(folder, name)
      if (name.endsWith('.jsonl') && wanted.has((await transcriptCwd(path).catch(() => null)) ?? '')) found.push(path)
    }
  }
  return found
}

/** Each session file with its subagent folder; the project folder goes too once nothing else is in it. */
export async function deleteTranscripts(paths: string[]): Promise<void> {
  for (const path of paths) {
    await rm(path, { force: true })
    await rm(path.slice(0, -'.jsonl'.length), { recursive: true, force: true })
    await rmdir(join(path, '..')).catch(() => {})
  }
}

/** Every worktree under `root`: its folders, plus ones the channel repos still list after the folder went. */
export async function scanWorktrees(channels: Channel[], root: string, transcriptsRoot = claudeProjects): Promise<CleanupItem[]> {
  const rootReal = real(root)
  const owners = new Map<string, { channel: Channel; memberId: string; memberName: string; cwd: string; lastTurnEndedAt?: number }>()
  for (const channel of channels.filter(({ everyone }) => !everyone)) {
    for (const member of channel.members) owners.set(real(member.cwd), { channel, memberId: member.id, memberName: member.name, cwd: member.cwd, lastTurnEndedAt: member.lastTurnEndedAt })
  }
  const folders = (await readdir(rootReal, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(rootReal, entry.name))
  const entries = new Map<string, { repo: string; entry: WorktreeEntry }>()
  const sources = new Set([...channels.filter(({ everyone, cwd }) => !everyone && cwd).map(({ cwd }) => cwd), ...folders])
  for (const source of sources) {
    const [main, ...linked] = await listWorktrees(source).catch(() => [])
    for (const entry of linked) {
      if (entry.path.startsWith(rootReal + sep)) entries.set(entry.path, { repo: main.path, entry })
    }
  }
  const items: CleanupItem[] = []
  for (const path of new Set([...folders, ...entries.keys()])) {
    const known = entries.get(path)
    const owner = owners.get(path)
    const missing = !existsSync(path)
    const branch = known?.entry.branch ?? null
    const risk = known ? await worktreeRisk(known.repo, path, branch).catch(() => null) : null
    items.push({
      path,
      name: basename(path),
      repo: risk ? known!.repo : null,
      branch,
      target: risk?.target ?? null,
      dirty: risk?.dirty ?? false,
      unmerged: risk?.unmerged ?? 0,
      missing,
      lastActiveAt: owner?.lastTurnEndedAt ?? (missing ? 0 : (await stat(path)).mtimeMs),
      ...(owner && { memberId: owner.memberId, memberName: owner.memberName, channelName: owner.channel.name }),
      transcripts: await findTranscripts([...new Set([path, owner?.cwd ?? path])], transcriptsRoot)
    })
  }
  return items
}
