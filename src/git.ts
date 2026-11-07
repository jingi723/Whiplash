import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MAX_OUTPUT = 4 * 1024 * 1024

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: MAX_OUTPUT })
  return stdout
}

export type ChangedFile = { status: string; path: string }
export type GitInfo = { branch: string; isWorktree: boolean; root: string; files: ChangedFile[] }

export function parseStatus(porcelain: string): ChangedFile[] {
  return porcelain
    .split('\0')
    .filter(Boolean)
    .map((row) => ({ status: row.slice(0, 2).trim(), path: row.slice(3) }))
}

export async function gitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    const [branch, gitDir, commonDir, root, status] = await Promise.all([
      git(cwd, 'branch', '--show-current'),
      git(cwd, 'rev-parse', '--absolute-git-dir'),
      git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      git(cwd, 'rev-parse', '--show-toplevel'),
      git(cwd, 'status', '--porcelain=v1', '-z')
    ])
    return {
      branch: branch.trim() || '(detached)',
      isWorktree: gitDir.trim() !== commonDir.trim(),
      root: root.trim(),
      files: parseStatus(status)
    }
  } catch {
    return null
  }
}

/** Only paths git itself reports are diffed, so a request cannot read arbitrary files. */
export async function fileDiff(cwd: string, path: string): Promise<string> {
  const info = await gitInfo(cwd)
  const file = info?.files.find((candidate) => candidate.path === path)
  if (!info || !file) {
    throw new Error('notChanged')
  }
  if (file.status === '??') {
    return await run('git', ['diff', '--no-index', '--', '/dev/null', path], {
      cwd: info.root,
      maxBuffer: MAX_OUTPUT
    }).then(
      ({ stdout }) => stdout,
      // `--no-index` exits 1 whenever the files differ, which is the expected case here.
      (error: { stdout?: string }) => error.stdout ?? ''
    )
  }
  return await git(info.root, 'diff', 'HEAD', '--', path)
}

export async function createWorktree(
  repoCwd: string,
  worktreeRoot: string,
  channel: string,
  name: string,
  suffix: string
): Promise<string> {
  const path = join(worktreeRoot, `${channel}-${name}-${suffix}`)
  await mkdir(worktreeRoot, { recursive: true })
  await git(repoCwd, 'worktree', 'add', '-b', `whiplash/${name}-${suffix}`, path)
  return path
}
