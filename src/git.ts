import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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
      // -uall lists the files inside new folders, so each one can be opened and diffed.
      git(cwd, 'status', '--porcelain=v1', '-z', '-uall')
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

const FILE_LIST_LIMIT = 20_000
const READ_LIMIT_BYTES = 1024 * 1024
const SEARCH_RESULT_LIMIT = 300
const LOG_LIMIT = 100
const GIT_TIMEOUT_MS = 10_000

/** Tracked and untracked files git does not ignore, the same set Orca's quick open shows by default. */
export async function listFiles(root: string): Promise<{ paths: string[]; truncated: boolean }> {
  const paths = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS
  }).then(
    ({ stdout }) => [...new Set(stdout.split('\0').filter(Boolean))].sort(),
    // A plain folder workspace has no index; walk it, skipping what git would usually ignore.
    () => walkFolder(root)
  )
  return { paths: paths.slice(0, FILE_LIST_LIMIT), truncated: paths.length > FILE_LIST_LIMIT }
}

const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', '.venv'])

async function walkFolder(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const { relative, join: joinPath, sep } = await import('node:path')
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, joinPath(entry.parentPath, entry.name)))
    .filter((path) => !path.split(sep).some((part) => SKIPPED_DIRS.has(part)))
    .sort()
}

/** A relative path from the browser, resolved strictly inside the project; symlinks out of it are refused. */
export async function resolveInside(root: string, relative: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  const { isAbsolute, resolve, sep } = await import('node:path')
  if (!relative || isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new Error('outside')
  }
  const realRoot = await realpath(root)
  const target = await realpath(resolve(realRoot, relative))
  if (target !== realRoot && !target.startsWith(realRoot + sep)) {
    throw new Error('outside')
  }
  return target
}

export type FileContent = { path: string; text?: string; binary?: boolean; tooLarge?: boolean; size: number; version?: string }

/** What the editor saw when it loaded; a save against any other version would overwrite someone's change. */
const versionOf = (buffer: Buffer) => createHash('sha1').update(buffer).digest('hex')

export async function readProjectFile(root: string, relative: string): Promise<FileContent> {
  const { open } = await import('node:fs/promises')
  const file = await open(await resolveInside(root, relative), 'r')
  try {
    const { size } = await file.stat()
    if (size > READ_LIMIT_BYTES) {
      return { path: relative, tooLarge: true, size }
    }
    const buffer = Buffer.alloc(size)
    await file.read(buffer, 0, size, 0)
    // A NUL byte near the start is how git itself decides a file is binary.
    if (buffer.subarray(0, 8000).includes(0)) {
      return { path: relative, binary: true, size }
    }
    return { path: relative, text: buffer.toString('utf8'), size, version: versionOf(buffer) }
  } finally {
    await file.close()
  }
}

export class FileChanged extends Error {}

/** Saves an existing text file, refusing if it changed since `base` was read. */
export async function writeProjectFile(root: string, relative: string, text: string, base: string): Promise<string> {
  const { writeFile } = await import('node:fs/promises')
  const target = await resolveInside(root, relative)
  const current = await readProjectFile(root, relative)
  if (current.text === undefined) throw new Error('not text')
  // ponytail: check-then-write, not atomic; a write landing in between is lost. A lock or rename-swap if that ever bites.
  if (current.version !== base) throw new FileChanged()
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length > READ_LIMIT_BYTES) throw new Error('too large')
  await writeFile(target, buffer)
  return versionOf(buffer)
}

export type SearchHit = { path: string; line: number; text: string }

/** Plain-text, case-insensitive search over tracked and untracked files, skipping binaries. */
export async function searchProject(root: string, query: string): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  if (!query.trim()) {
    return { hits: [], truncated: false }
  }
  const grep = (scope: string) =>
    run('git', ['grep', '-z', '-n', '-I', '-i', scope, '--fixed-strings', '--max-count=20', '-e', query], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS
    }).then(
      ({ stdout }) => stdout,
      // git grep exits 1 when nothing matches, 128 outside a repository.
      (error: { code?: number }) => {
        if (error.code === 1) return ''
        throw error
      }
    )
  // A folder workspace is not a repository; --no-index searches it as plain files.
  const output = await grep('--untracked').catch(() => grep('--no-index'))
  const hits: SearchHit[] = []
  for (const row of output.split('\n')) {
    const [path, line, ...rest] = row.split('\0')
    if (path && line) {
      hits.push({ path, line: Number(line), text: rest.join('\0').slice(0, 300) })
    }
  }
  return { hits: hits.slice(0, SEARCH_RESULT_LIMIT), truncated: hits.length > SEARCH_RESULT_LIMIT }
}

export type Commit = { sha: string; short: string; author: string; at: number; subject: string }

export function parseLog(raw: string): Commit[] {
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, short, author, at, subject] = record.split('\x1f')
      return { sha, short, author, at: Number(at) * 1000, subject }
    })
}

export async function readLog(root: string): Promise<Commit[]> {
  const output = await run('git', ['log', `-n${LOG_LIMIT}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e'], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS
  }).then(
    ({ stdout }) => stdout,
    // A repository without commits has no log yet.
    () => ''
  )
  return parseLog(output)
}

export async function showCommit(root: string, sha: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error('badCommit')
  }
  return await git(root, 'show', '--stat', '--patch', '--format=%H%n%an <%ae>%n%ad%n%n%B', sha)
}
