/**
 * Uncommitted changes in a project's git working tree.
 *
 * "Changes" = everything that differs from HEAD: staged, unstaged and
 * untracked files. Git is always invoked with execFile (no shell) and paths
 * are passed after `--`, so file names can never be read as options.
 */

import { execFile } from 'child_process'
import { open } from 'fs/promises'
import { join } from 'path'
import { ISOLATED_CHILD } from './child-options.js'

/** Git's well-known empty tree — the base for repos with no commits yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** Diffs larger than this are cut off (the UI says so). */
const MAX_DIFF_BYTES = 512 * 1024
/** Untracked files beyond this are listed without +/- counts. */
const MAX_UNTRACKED_COUNTED = 500
/** Untracked files larger than this are listed without +/- counts. */
const MAX_COUNTED_BYTES = 2 * 1024 * 1024
/** Parallel file reads when counting untracked lines. */
const COUNT_CONCURRENCY = 16
/**
 * Most files the list returns. An unignored build or dependency folder can
 * add tens of thousands of untracked files; the total is still reported.
 */
const MAX_LISTED_FILES = 1000

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'typechange'

export interface ChangedFile {
  path: string
  /** Previous path, for renames. */
  oldPath?: string
  status: ChangeStatus
  staged: boolean
  /** null when unknown or binary. */
  additions: number | null
  deletions: number | null
  binary: boolean
}

export type ChangesResult =
  | { isRepo: false }
  | {
      isRepo: true
      branch: string | null
      files: ChangedFile[]
      /** Total changed files, when more than `files.length` exist. */
      totalFiles: number
    }

export interface FileDiff {
  path: string
  diff: string
  truncated: boolean
  binary: boolean
}

interface GitResult {
  code: number
  stdout: string
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, ...ISOLATED_CHILD, encoding: 'utf8' },
      (err, stdout) => {
        // A non-zero exit is data (e.g. `diff --no-index` exits 1 on changes);
        // only a failure to spawn git at all is an error.
        if (err && typeof (err as NodeJS.ErrnoException).code === 'string') return reject(err)
        resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout })
      },
    )
  })
}

/** Map a porcelain XY pair to a single status. */
function statusFromXY(x: string, y: string): ChangeStatus {
  if (x === '?' && y === '?') return 'untracked'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflicted'
  const code = x !== ' ' ? x : y
  switch (code) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R':
    case 'C': return 'renamed'
    case 'T': return 'typechange'
    default: return 'modified'
  }
}

/**
 * Parse `git status --porcelain=v1 -z`. Renames/copies carry the original
 * path as the following NUL-separated field.
 */
export function parsePorcelainZ(out: string): Omit<ChangedFile, 'additions' | 'deletions' | 'binary'>[] {
  const fields = out.split('\0')
  const files: Omit<ChangedFile, 'additions' | 'deletions' | 'binary'>[] = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    const file: Omit<ChangedFile, 'additions' | 'deletions' | 'binary'> = {
      path,
      status: statusFromXY(x, y),
      staged: x !== ' ' && x !== '?',
    }
    if (x === 'R' || x === 'C') file.oldPath = fields[++i]
    files.push(file)
  }
  return files
}

/**
 * Parse `git diff --numstat -z`. Renames come as `add\tdel\t` followed by
 * the old and new paths in separate fields.
 */
export function parseNumstatZ(out: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const stats = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>()
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[i])
    if (!m) continue
    let path = m[3]
    if (path === '') {
      // Rename: next two fields are old path, new path
      i += 2
      path = fields[i] ?? ''
    }
    const binary = m[1] === '-'
    stats.set(path, {
      additions: binary ? null : Number(m[1]),
      deletions: binary ? null : Number(m[2]),
      binary,
    })
  }
  return stats
}

async function baseRef(cwd: string): Promise<string> {
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  return head.code === 0 ? 'HEAD' : EMPTY_TREE
}

async function isRepo(cwd: string): Promise<boolean> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return inside.code === 0 && inside.stdout.trim() === 'true'
}

async function statusEntries(cwd: string) {
  return parsePorcelainZ((await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout)
}

export async function getChanges(cwd: string): Promise<ChangesResult> {
  if (!(await isRepo(cwd))) return { isRepo: false }

  const [entries, branch, base] = await Promise.all([
    statusEntries(cwd),
    git(cwd, ['branch', '--show-current']),
    baseRef(cwd),
  ])
  const tracked = parseNumstatZ((await git(cwd, ['diff', base, '--numstat', '-z', '-M'])).stdout)

  // Tracked files first (they're what the agent edited), then untracked.
  entries.sort((a, b) => Number(a.status === 'untracked') - Number(b.status === 'untracked') || a.path.localeCompare(b.path))
  const listed = entries.slice(0, MAX_LISTED_FILES)

  const toCount = listed.filter((e) => e.status === 'untracked').slice(0, MAX_UNTRACKED_COUNTED)
  const untrackedStats = new Map(
    await mapLimit(toCount, COUNT_CONCURRENCY, async (e) => [e.path, await countNewFile(join(cwd, e.path))] as const),
  )

  const files = listed.map((e): ChangedFile => {
    if (e.status === 'untracked') {
      const s = untrackedStats.get(e.path)
      return { ...e, additions: s?.additions ?? null, deletions: s ? 0 : null, binary: s?.binary ?? false }
    }
    const s = tracked.get(e.path)
    return { ...e, additions: s?.additions ?? null, deletions: s?.deletions ?? null, binary: s?.binary ?? false }
  })

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { isRepo: true, branch: branch.stdout.trim() || null, files, totalFiles: entries.length }
}

/**
 * Line count for a new file, read directly instead of spawning git per file.
 * Binary (a NUL byte in the first 8 KB, git's own heuristic) and oversized
 * files get no count.
 */
async function countNewFile(absPath: string): Promise<{ additions: number | null; binary: boolean } | null> {
  let handle
  try {
    handle = await open(absPath, 'r')
    const { size } = await handle.stat()
    const head = Buffer.alloc(Math.min(size, 8192))
    await handle.read(head, 0, head.length, 0)
    if (head.includes(0)) return { additions: null, binary: true }
    if (size > MAX_COUNTED_BYTES) return null
    const text = (await handle.readFile()).toString('utf8')
    if (text.length === 0) return { additions: 0, binary: false }
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    return { additions: lines, binary: false }
  } catch {
    return null // unreadable, deleted meanwhile, or a directory (submodule)
  } finally {
    await handle?.close()
  }
}

/** Promise.all with at most `limit` tasks in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Unified diff for one changed file. Only paths that appear in the current
 * change list are accepted, so this can't be used to read arbitrary files.
 */
export async function getFileDiff(cwd: string, path: string): Promise<FileDiff | null> {
  // Validate against `git status` alone — no need for every file's counts.
  if (!(await isRepo(cwd))) return null
  const file = (await statusEntries(cwd)).find((f) => f.path === path)
  if (!file) return null

  let out: string
  if (file.status === 'untracked') {
    out = (await git(cwd, ['diff', '--no-index', '--', '/dev/null', path])).stdout
  } else {
    const base = await baseRef(cwd)
    const paths = file.oldPath ? [file.oldPath, path] : [path]
    out = (await git(cwd, ['diff', base, '-M', '--', ...paths])).stdout
  }

  const truncated = out.length > MAX_DIFF_BYTES
  return {
    path,
    diff: truncated ? out.slice(0, MAX_DIFF_BYTES) : out,
    truncated,
    binary: /^Binary files .* differ$/m.test(out),
  }
}
