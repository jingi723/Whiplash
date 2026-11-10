import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createProject, createWorktree, listFiles, parseLog, readLog, readProjectFile, searchProject, showCommit } from './git.ts'

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'whiplash-git-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, '.gitignore'), 'secret.txt\n')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'login.ts'), 'export const label = "Login"\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'Add login')
  writeFileSync(join(root, 'notes.md'), '로그인 메모\n')
  writeFileSync(join(root, 'secret.txt'), 'token\n')
  writeFileSync(join(root, 'image.bin'), Buffer.from([0, 1, 2]))
  return root
}

describe('project browsing', () => {
  it('lists tracked and untracked files but not ignored ones', async () => {
    const root = repo()
    const { paths } = await listFiles(root)
    assert.ok(paths.includes('src/login.ts') && paths.includes('notes.md'))
    assert.ok(!paths.includes('secret.txt'))
  })

  it('reads text, flags binaries, and refuses paths outside the project', async () => {
    const root = repo()
    assert.equal((await readProjectFile(root, 'src/login.ts')).text, 'export const label = "Login"\n')
    assert.equal((await readProjectFile(root, 'image.bin')).binary, true)
    await assert.rejects(readProjectFile(root, '../etc/passwd'))
    await assert.rejects(readProjectFile(root, '/etc/passwd'))
    symlinkSync('/etc', join(root, 'escape'))
    await assert.rejects(readProjectFile(root, 'escape/hosts'))
  })

  it('searches case-insensitively, including untracked files', async () => {
    const root = repo()
    const { hits } = await searchProject(root, 'login')
    assert.deepEqual(hits.map(({ path, line }) => `${path}:${line}`), ['src/login.ts:1'])
    assert.equal((await searchProject(root, '로그인')).hits[0]?.path, 'notes.md')
    assert.deepEqual((await searchProject(root, 'nothing-here')).hits, [])
  })

  it('reads the log and shows a commit, rejecting anything that is not a hash', async () => {
    const root = repo()
    const [commit] = await readLog(root)
    assert.equal(commit.subject, 'Add login')
    assert.ok((await showCommit(root, commit.short)).includes('src/login.ts'))
    await assert.rejects(showCommit(root, '--output=/tmp/x'))
    assert.deepEqual(parseLog('a\x1fb\x1fc\x1f10\x1fsubject\x1e\n'), [
      { sha: 'a', short: 'b', author: 'c', at: 10_000, subject: 'subject' }
    ])
  })
})

describe('createProject', () => {
  it('makes a repository members can branch worktrees from', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whiplash-new-'))
    await createProject(join(root, 'app'))
    const worktree = await createWorktree(join(root, 'app'), join(root, 'trees'), 'app', 'coder', 'abc123')
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: worktree }).toString().trim(), 'whiplash/coder-abc123')
  })
})
