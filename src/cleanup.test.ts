import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type CleanupItem, claudeProjectName, deleteTranscripts, findTranscripts, needsAsking, scanWorktrees, STALE_MS } from './cleanup.ts'
import { createWorktree } from './git.ts'
import type { Channel } from './model.ts'

const now = 100 * STALE_MS
const item = (overrides: Partial<CleanupItem> = {}): CleanupItem => ({
  path: '/w/a', name: 'a', repo: '/r', branch: 'whiplash/a', target: 'main', dirty: false, unmerged: 0, missing: false,
  lastActiveAt: now - STALE_MS, memberId: 'm', transcripts: [], ...overrides
})

describe('which worktrees to ask about', () => {
  it('asks after a week idle, or at once when no member uses it', () => {
    assert.equal(needsAsking(item(), undefined, now), true)
    assert.equal(needsAsking(item({ lastActiveAt: now - STALE_MS + 1 }), undefined, now), false)
    assert.equal(needsAsking(item({ lastActiveAt: now, memberId: undefined }), undefined, now), true)
  })

  it('never asks about a kept one, and waits out a snooze unless asked by hand', () => {
    assert.equal(needsAsking(item(), { keep: true }, now, true), false)
    assert.equal(needsAsking(item(), { snoozedUntil: now + 1 }, now), false)
    assert.equal(needsAsking(item(), { snoozedUntil: now + 1 }, now, true), true)
    assert.equal(needsAsking(item(), { snoozedUntil: now }, now), true)
  })
})

describe('transcripts', () => {
  it('matches by the cwd inside the file, since Korean names collide', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whiplash-claude-'))
    const folder = join(root, claudeProjectName('/w/채널'))
    mkdirSync(join(folder, 's1', 'subagents'), { recursive: true })
    writeFileSync(join(folder, 's1.jsonl'), '{"type":"x"}\n{"cwd":"/w/채널","sessionId":"s1"}\n')
    writeFileSync(join(folder, 's2.jsonl'), '{"cwd":"/w/팀방"}\n')
    assert.equal(claudeProjectName('/w/팀방'), claudeProjectName('/w/채널'))
    const found = await findTranscripts(['/w/채널'], root)
    assert.deepEqual(found, [join(folder, 's1.jsonl')])
    await deleteTranscripts(found)
    assert.deepEqual(await findTranscripts(['/w/팀방'], root), [join(folder, 's2.jsonl')])
  })
})

describe('scanWorktrees', () => {
  it('finds member worktrees and ones whose member is gone', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'whiplash-scan-')))
    const repo = join(home, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'start'], { cwd: repo })
    const trees = join(home, 'trees')
    const used = await createWorktree(repo, trees, 'app', 'coder', 'aaa111')
    const left = await createWorktree(repo, trees, 'app', 'old', 'bbb222')
    writeFileSync(join(left, 'draft.txt'), 'wip\n')
    const channel = { id: 'c', name: 'app', cwd: repo, members: [{ id: 'm', name: 'coder', cwd: used, lastTurnEndedAt: 5 }] } as unknown as Channel
    const items = await scanWorktrees([channel], trees, join(home, 'none'))
    const byPath = Object.fromEntries(items.map((entry) => [entry.path, entry]))
    assert.equal(byPath[used].memberId, 'm')
    assert.equal(byPath[used].lastActiveAt, 5)
    assert.equal(byPath[left].memberId, undefined)
    assert.equal(byPath[left].dirty, true)
    assert.equal(byPath[left].repo, repo)
    assert.equal(byPath[left].target, 'main')
  })
})
