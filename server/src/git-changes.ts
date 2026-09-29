/**
 * Uncommitted changes in a project's git working tree.
 *
 * "Changes" = everything that differs from HEAD: staged, unstaged and
 * untracked files. Git is always invoked with execFile (no shell) and paths
 * are passed after `--`, so file names can never be read as options.
 */

import { execFile } from 'child_process'

/** Git's well-known empty tree — the base for repos with no commits yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** Diffs larger than this are cut off (the UI says so). */
const MAX_DIFF_BYTES = 512 * 1024
/** Untracked files beyond this are listed without +/- counts. */
const MAX_UNTRACKED_COUNTED = 300

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
  | { isRepo: true; branch: string | null; files: ChangedFile[] }

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
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
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

  let counted = 0
  const files = await Promise.all(
    entries.map(async (e): Promise<ChangedFile> => {
      if (e.status === 'untracked') {
        if (counted++ >= MAX_UNTRACKED_COUNTED) return { ...e, additions: null, deletions: null, binary: false }
        const stat = parseNumstatZ((await git(cwd, ['diff', '--no-index', '--numstat', '-z', '--', '/dev/null', e.path])).stdout)
        const s = [...stat.values()][0]
        return { ...e, additions: s?.additions ?? null, deletions: s?.deletions ?? 0, binary: s?.binary ?? false }
      }
      const s = tracked.get(e.path)
      return { ...e, additions: s?.additions ?? null, deletions: s?.deletions ?? null, binary: s?.binary ?? false }
    }),
  )

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { isRepo: true, branch: branch.stdout.trim() || null, files }
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
