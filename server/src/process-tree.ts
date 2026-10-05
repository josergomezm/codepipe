/**
 * Ending and inspecting a child process together with everything it started.
 *
 * `child.kill()` on Windows ends only the top process. CLIs run more under
 * themselves — Kiro an internal agent plus tool shells, which run test
 * runners, emulators, dev servers — and those survive, untracked.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { ISOLATED_CHILD } from './child-options.js'

/** Children CodePipe ended on purpose (Stop, restart, shutdown) — not failures. */
const stopped = new WeakSet<ChildProcess>()

export function wasStoppedByUs(child: ChildProcess): boolean {
  return stopped.has(child) || child.killed
}

/**
 * End a child and its whole process tree. Synchronous on Windows (taskkill
 * /T /F, usually well under a second) so callers can rely on it being done.
 */
export function killProcessTree(child: ChildProcess): void {
  stopped.add(child)
  const running = child.pid !== undefined && child.exitCode === null && child.signalCode === null
  if (running && process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000, ...ISOLATED_CHILD })
  }
  try { child.kill() } catch { /* already gone */ }
}

export interface TurnProcess {
  pid: number
  name: string
  commandLine: string
  /** 'descendant' of the CLI, or 'orphaned' (started during the turn, parent gone). */
  relation: 'descendant' | 'orphaned'
}

/**
 * What a CLI turn has running: the CLI's live descendants, plus processes
 * started since `sinceMs` whose parent has exited — orphans like a test
 * run's leftover emulator, which no longer show up under the CLI but can
 * keep its command from ever finishing. Windows only (empty elsewhere).
 */
export function listTurnProcesses(rootPid: number, sinceMs: number): Promise<TurnProcess[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  const since = new Date(sinceMs).toISOString()
  // One CIM query; the tree walk happens here in JS.
  const script = `Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; c = $_.CommandLine; t = $_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress`
  return new Promise((resolve) => {
    let out = ''
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], ...ISOLATED_CHILD })
    const timer = setTimeout(() => { try { ps.kill() } catch { /* gone */ } ; resolve([]) }, 15_000)
    ps.stdout.on('data', (d) => { out += d })
    ps.on('error', () => { clearTimeout(timer); resolve([]) })
    ps.on('close', () => {
      clearTimeout(timer)
      try {
        const all = JSON.parse(out) as { p: number; pp: number; n: string; c: string | null; t: string }[]
        const alive = new Set(all.map((x) => x.p))
        const byParent = new Map<number, typeof all>()
        for (const x of all) byParent.set(x.pp, [...(byParent.get(x.pp) ?? []), x])
        const result: TurnProcess[] = []
        const seen = new Set<number>()
        const walk = (pid: number) => {
          for (const c of byParent.get(pid) ?? []) {
            if (seen.has(c.p)) continue
            seen.add(c.p)
            if (c.n !== 'conhost.exe') result.push({ pid: c.p, name: c.n, commandLine: c.c ?? '', relation: 'descendant' })
            walk(c.p)
          }
        }
        walk(rootPid)
        for (const x of all) {
          if (seen.has(x.p) || x.p === rootPid || alive.has(x.pp) || x.t < since) continue
          if (x.n === 'conhost.exe' || (x.c ?? '').includes('Get-CimInstance Win32_Process')) continue // not this query
          result.push({ pid: x.p, name: x.n, commandLine: x.c ?? '', relation: 'orphaned' })
        }
        resolve(result)
      } catch {
        resolve([])
      }
    })
  })
}
