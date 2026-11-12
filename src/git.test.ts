import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createProject, createWorktree, FileChanged, listFiles, mergeWorktree, parseLog, readLog, readProjectFile, removeWorktree, searchProject, showCommit, worktreeRisk, writeProjectFile } from './git.ts'

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

  it('saves only over the version it read, and only text files inside the project', async () => {
    const root = repo()
    const { version } = await readProjectFile(root, 'notes.md')
    const next = await writeProjectFile(root, 'notes.md', 'edited\n', version!)
    assert.equal((await readProjectFile(root, 'notes.md')).text, 'edited\n')
    assert.equal((await readProjectFile(root, 'notes.md')).version, next)
    await assert.rejects(writeProjectFile(root, 'notes.md', 'stale', version!), FileChanged)
    await assert.rejects(writeProjectFile(root, 'image.bin', 'x', 'any'))
    await assert.rejects(writeProjectFile(root, '../outside.txt', 'x', 'any'))
    await assert.rejects(writeProjectFile(root, 'missing.txt', 'x', 'any'))
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

describe('worktree cleanup', () => {
  const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  Object.assign(process.env, gitEnv)
  const setup = async () => {
    const root = mkdtempSync(join(tmpdir(), 'whiplash-clean-'))
    const app = join(root, 'app')
    await createProject(app)
    const tree = await createWorktree(app, join(root, 'trees'), 'app', 'coder', 'abc123')
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd }).toString().trim()
    writeFileSync(join(tree, 'work.txt'), 'done\n')
    git(tree, 'add', '.')
    git(tree, 'commit', '-q', '-m', 'Work')
    return { app, tree, git, branch: 'whiplash/coder-abc123' }
  }

  it('merges with a merge commit, then removes the worktree and branch', async () => {
    const { app, tree, git, branch } = await setup()
    assert.deepEqual(await worktreeRisk(app, tree, branch), { target: git(app, 'branch', '--show-current'), dirty: false, unmerged: 1 })
    await mergeWorktree(app, tree, branch)
    assert.equal(git(app, 'log', '-1', '--format=%P').split(' ').length, 2)
    assert.deepEqual(await removeWorktree(app, tree, branch, false), {})
    assert.ok(!existsSync(tree))
    assert.equal(git(app, 'branch', '--list', branch), '')
  })

  it('aborts a conflicting merge and refuses dirty trees', async () => {
    const { app, tree, git, branch } = await setup()
    writeFileSync(join(app, 'work.txt'), 'other\n')
    git(app, 'add', '.')
    git(app, 'commit', '-q', '-m', 'Clash')
    const head = git(app, 'rev-parse', 'HEAD')
    await assert.rejects(mergeWorktree(app, tree, branch), /mergeFailed/)
    assert.equal(git(app, 'rev-parse', 'HEAD'), head)
    assert.equal(git(app, 'status', '--porcelain'), '')
    writeFileSync(join(tree, 'wip.txt'), 'wip\n')
    await assert.rejects(mergeWorktree(app, tree, branch), /worktreeDirty/)
    writeFileSync(join(app, 'work.txt'), 'edited\n')
    await assert.rejects(mergeWorktree(app, tree, branch), /repoDirty/)
  })

  it('keeps an unmerged branch on a plain delete and drops it when forced', async () => {
    const { app, tree, git, branch } = await setup()
    assert.deepEqual(await removeWorktree(app, tree, branch, false), { keptBranch: branch })
    assert.ok(!existsSync(tree))
    assert.equal(git(app, 'branch', '--list', branch).replace('*', '').trim(), branch)
    const second = await createWorktree(app, join(app, '..', 'trees'), 'app', 'x', 'def456')
    writeFileSync(join(second, 'wip.txt'), 'wip\n')
    await assert.rejects(removeWorktree(app, second, 'whiplash/x-def456', false))
    await removeWorktree(app, second, 'whiplash/x-def456', true)
    assert.ok(!existsSync(second))
    assert.equal(git(app, 'branch', '--list', 'whiplash/x-def456'), '')
  })
})
