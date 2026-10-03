import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

import { ISOLATED_CHILD } from './child-options.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Run the fixture in a fresh, real (hidden) console window and report whether
 * a console Ctrl+C sent by its child reached it. Needs a real console, which
 * a test runner doesn't have, hence Start-Process.
 */
function childCtrlCReachesParent(options: object): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'codepipe-ctrlc-'))
  const result = path.join(dir, 'result.json')
  try {
    const args = [path.join(here, 'test-fixtures', 'ctrlc-parent.mjs'), result, JSON.stringify(options)]
    // PowerShell single-quoted literals: double any embedded single quotes.
    const argList = args.map((a) => `'"${a.replace(/"/g, '\\"').replace(/'/g, "''")}"'`).join(', ')
    const run = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Start-Process -FilePath '${process.execPath}' -ArgumentList ${argList} -WindowStyle Minimized -Wait`,
    ], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (run.status !== 0) throw new Error(`Start-Process failed: ${run.stderr}`)
    return JSON.parse(readFileSync(result, 'utf8')).gotSigint
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.runIf(process.platform === 'win32')('child process console isolation (Windows)', () => {
  it("ISOLATED_CHILD keeps a child's Ctrl+C away from the server", (ctx) => {
    // Control first: a normally spawned child must be able to deliver Ctrl+C,
    // or this environment can't show the bug at all. That happens when the
    // test runner was started from a process that ignores Ctrl+C (Windows
    // passes that flag down to everything it launches, even new consoles) —
    // e.g. some CI runners and Git Bash. A normal terminal shows it.
    if (!childCtrlCReachesParent({})) {
      ctx.skip("this environment ignores console Ctrl+C, so the bug can't be reproduced here — run from a normal terminal")
    }
    expect(childCtrlCReachesParent(ISOLATED_CHILD)).toBe(false)
  }, 60_000)
})

/** Child-process calls, including promisified wrappers (execFileAsync). */
const CALL = /\b(spawn|spawnSync|execFile|execFileSync|execFileAsync|execSync|exec|execAsync|fork)\(/g

/**
 * Index just past the `)` that closes the call whose `(` is at `open`,
 * skipping strings, template literals and comments. -1 if unbalanced.
 */
export function closingParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) return -1; continue }
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i + 1
  }
  return -1
}

/** "file:line" for every child-process call in `src` whose own arguments lack ISOLATED_CHILD. */
export function unisolatedCalls(src: string, file = 'src'): string[] {
  const offenders: string[] = []
  for (const m of src.matchAll(CALL)) {
    const before = src.slice(Math.max(0, m.index - 30), m.index)
    // Not child processes: RegExp#exec, node-pty's pty.spawn (its own console), declarations.
    if (/\.$/.test(before) && !/child_process\.$/.test(before)) continue
    if (/(import|function|promisify)\s*[({]?\s*$/.test(before)) continue
    const open = m.index + m[0].length - 1
    const end = closingParen(src, open)
    const args = end < 0 ? src.slice(open) : src.slice(open, end)
    if (!/ISOLATED_CHILD/.test(args)) offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`)
  }
  return offenders
}

describe('every child process the server starts uses ISOLATED_CHILD', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) return name === 'test-fixtures' ? [] : sourceFiles(full)
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : []
    })
  }

  it('has no spawn call without it', () => {
    const offenders = sourceFiles(here).flatMap((file) => unisolatedCalls(readFileSync(file, 'utf8'), path.relative(here, file)))
    expect(offenders).toEqual([])
  })

  it("judges each call by its own arguments, not a neighbour's", () => {
    const src = [
      "spawn('taskkill', ['/pid', pid, '/f', '/t'], { stdio: 'ignore' })",
      "spawn('taskkill', ['/pid', pid], { stdio: 'ignore', ...ISOLATED_CHILD })",
      'const out = execSync(`netstat -aon | findstr ")"`, {',
      "  encoding: 'utf-8', // a ) in a comment",
      '  ...ISOLATED_CHILD,',
      '})',
      "const { stdout } = await execFileAsync('agy', ['models'], { timeout: 1 })",
      '/x/.exec(text); pty.spawn(shell, [], {})',
    ].join('\n')
    expect(unisolatedCalls(src)).toEqual(['src:1', 'src:7'])
  })
})
