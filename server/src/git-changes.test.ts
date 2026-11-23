import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parsePorcelainZ, parseNumstatZ, getChanges, getFileDiff, countChanges, getRepoActivity, parseLogLines } from './git-changes.js'

describe('parsePorcelainZ', () => {
  it('parses statuses, staging, spaces in names and renames', () => {
    const out = [' M src/app.ts', 'A  new file.ts', '?? notes/todo.md', 'R  after.ts', 'before.ts', ' D gone.ts', 'UU conflict.ts', ''].join('\0')
    expect(parsePorcelainZ(out)).toEqual([
      { path: 'src/app.ts', status: 'modified', staged: false },
      { path: 'new file.ts', status: 'added', staged: true },
      { path: 'notes/todo.md', status: 'untracked', staged: false },
      { path: 'after.ts', oldPath: 'before.ts', status: 'renamed', staged: true },
      { path: 'gone.ts', status: 'deleted', staged: false },
      { path: 'conflict.ts', status: 'conflicted', staged: true },
    ])
  })
})

describe('parseNumstatZ', () => {
  it('parses counts, binary files and renames', () => {
    const out = ['3\t1\tsrc/app.ts', '-\t-\tlogo.png', '2\t0\t', 'old.ts', 'new.ts', ''].join('\0')
    const stats = parseNumstatZ(out)
    expect(stats.get('src/app.ts')).toEqual({ additions: 3, deletions: 1, binary: false })
    expect(stats.get('logo.png')).toEqual({ additions: null, deletions: null, binary: true })
    expect(stats.get('new.ts')).toEqual({ additions: 2, deletions: 0, binary: false })
  })
})

describe('getChanges / getFileDiff (real repo)', () => {
  let dir: string
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd: dir, stdio: 'pipe' })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'codepipe-changes-'))
    git('init', '-q')
    writeFileSync(join(dir, 'keep.txt'), 'one\ntwo\n')
    writeFileSync(join(dir, 'remove.txt'), 'bye\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    writeFileSync(join(dir, 'keep.txt'), 'one\n2\nthree\n')
    unlinkSync(join(dir, 'remove.txt'))
    writeFileSync(join(dir, 'with space.md'), 'hello\n')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('counts uncommitted files, and returns null outside a repo', async () => {
    expect(await countChanges(dir)).toBe(3)
    const plain = mkdtempSync(join(tmpdir(), 'codepipe-norepo-'))
    try {
      expect(await countChanges(plain)).toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
    expect(await countChanges(join(plain, 'missing'))).toBeNull()
  })

  it('lists modified, deleted and untracked files with counts', async () => {
    const result = await getChanges(dir)
    expect(result.isRepo).toBe(true)
    if (!result.isRepo) return
    expect(result.files).toEqual([
      { path: 'keep.txt', status: 'modified', staged: false, additions: 2, deletions: 1, binary: false },
      { path: 'remove.txt', status: 'deleted', staged: false, additions: 0, deletions: 1, binary: false },
      { path: 'with space.md', status: 'untracked', staged: false, additions: 1, deletions: 0, binary: false },
    ])
  })

  it('counts untracked files without git, flags binaries, and caps the list', async () => {
    // "a-" sorts before the generated files, so it survives the cap
    writeFileSync(join(dir, 'a-logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    for (let i = 0; i < 1005; i++) writeFileSync(join(dir, `gen-${String(i).padStart(4, '0')}.txt`), 'x\n')
    try {
      const result = await getChanges(dir)
      if (!result.isRepo) throw new Error('expected a repo')
      expect(result.totalFiles).toBe(1009)
      expect(result.files).toHaveLength(1000)
      // Tracked changes are always kept, whatever the untracked flood
      expect(result.files.map((f) => f.path)).toEqual(expect.arrayContaining(['keep.txt', 'remove.txt']))
      expect(result.files.find((f) => f.path === 'a-logo.bin')).toMatchObject({ binary: true, additions: null })
      expect(result.files.find((f) => f.path === 'gen-0000.txt')).toMatchObject({ additions: 1, deletions: 0 })
    } finally {
      unlinkSync(join(dir, 'a-logo.bin'))
      for (let i = 0; i < 1005; i++) unlinkSync(join(dir, `gen-${String(i).padStart(4, '0')}.txt`))
    }
  })

  it('returns a unified diff for tracked and untracked files', async () => {
    const tracked = await getFileDiff(dir, 'keep.txt')
    expect(tracked?.diff).toContain('-two')
    expect(tracked?.diff).toContain('+three')
    const untracked = await getFileDiff(dir, 'with space.md')
    expect(untracked?.diff).toContain('+hello')
  })

  it('refuses paths that are not in the change list', async () => {
    expect(await getFileDiff(dir, '../../etc/passwd')).toBeNull()
    expect(await getFileDiff(dir, '--output=x')).toBeNull()
  })

  it('reports non-repos', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'codepipe-plain-'))
    try {
      expect(await getChanges(plain)).toEqual({ isRepo: false })
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('parseLogLines', () => {
  it('returns nothing for empty output, and drops malformed lines', () => {
    expect(parseLogLines('')).toEqual([])
    expect(parseLogLines('no separators here\nabc1234\x1fnot-a-time\x1fSubject\n')).toEqual([])
  })

  it('splits hash, time and subject (subjects may contain anything)', () => {
    const out = ['abc1234\x1f1795000000\x1fPhase 7: approval | quiz', 'def5678\x1f1794000000\x1fDocs', ''].join('\n')
    expect(parseLogLines(out)).toEqual([
      { hash: 'abc1234', at: 1795000000000, subject: 'Phase 7: approval | quiz' },
      { hash: 'def5678', at: 1794000000000, subject: 'Docs' },
    ])
  })
})

describe('getRepoActivity (real repos)', () => {
  let origin: string
  let dir: string
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })

  beforeAll(() => {
    origin = mkdtempSync(join(tmpdir(), 'codepipe-origin-'))
    run(origin, 'init', '-q', '--bare')
    dir = mkdtempSync(join(tmpdir(), 'codepipe-activity-'))
    run(dir, 'init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    run(dir, 'add', '.')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'old work'], {
      cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' },
    })
    run(dir, 'remote', 'add', 'origin', origin)
    run(dir, 'push', '-q', '-u', 'origin', 'HEAD')
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    run(dir, 'add', '.')
    // Committer date drives --since, so set it for "new" work explicitly.
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'new work'], {
      cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: new Date().toISOString() },
    })
    writeFileSync(join(dir, 'c.txt'), 'uncommitted\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(origin, { recursive: true, force: true })
  })

  it('reports commits since, unpushed and uncommitted', async () => {
    const activity = await getRepoActivity(dir, Date.now() - 3_600_000)
    expect(activity).toMatchObject({ isRepo: true, unpushed: 1, uncommitted: 1 })
    if (!activity.isRepo) throw new Error('expected a repo')
    expect(activity.commits.map((c) => c.subject)).toEqual(['new work'])
  })

  it('reports unpushed as null without an upstream, and non-repos', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'codepipe-solo-'))
    try {
      run(solo, 'init', '-q')
      writeFileSync(join(solo, 'x.txt'), 'x\n')
      run(solo, 'add', '.')
      run(solo, 'commit', '-qm', 'x')
      expect(await getRepoActivity(solo, 0)).toMatchObject({ isRepo: true, unpushed: null, uncommitted: 0 })
      const plain = mkdtempSync(join(tmpdir(), 'codepipe-plain-'))
      expect(await getRepoActivity(plain, 0)).toEqual({ isRepo: false })
      // A project whose folder was removed: not a repo, not a crash.
      expect(await getRepoActivity(join(plain, 'gone'), 0)).toEqual({ isRepo: false })
      expect(await getChanges(join(plain, 'gone'))).toEqual({ isRepo: false })
      rmSync(plain, { recursive: true, force: true })
    } finally {
      rmSync(solo, { recursive: true, force: true })
    }
  })
})
