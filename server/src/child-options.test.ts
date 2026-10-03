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

describe('every child process the server starts uses ISOLATED_CHILD', () => {
  const CALL = /\b(spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\(/g

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) return name === 'test-fixtures' ? [] : sourceFiles(full)
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : []
    })
  }

  it('has no spawn call without it', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(here)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(CALL)) {
        const before = src.slice(Math.max(0, m.index - 30), m.index)
        // Not child processes: RegExp#exec, node-pty (has its own console), imports.
        if (/\.$/.test(before) && !/child_process\.$/.test(before)) continue
        if (/(import|function|promisify)\s*[({]?\s*$/.test(before)) continue
        // The call's own text: up to its closing paren, generously bounded.
        const call = src.slice(m.index, m.index + 600)
        if (!/ISOLATED_CHILD/.test(call.slice(0, call.indexOf('\n})') > 0 ? call.indexOf('\n})') + 3 : 600))) {
          offenders.push(`${path.relative(here, file)}:${src.slice(0, m.index).split('\n').length}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
