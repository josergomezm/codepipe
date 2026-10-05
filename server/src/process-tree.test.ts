import { describe, it, expect } from 'vitest'
import { spawn, spawnSync } from 'child_process'

import { killProcessTree, listTurnProcesses, wasStoppedByUs } from './process-tree.js'
import { ISOLATED_CHILD } from './child-options.js'

const isWindows = process.platform === 'win32'

function isAlive(pid: number): boolean {
  if (!isWindows) {
    try { process.kill(pid, 0); return true } catch { return false }
  }
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true }).stdout
  return out.includes(String(pid))
}

/** A child that starts a long-lived grandchild and prints the grandchild's pid. */
function spawnParentWithGrandchild(detachGrandchild: boolean, parentExits: boolean) {
  const script = `
    const { spawn } = require('child_process')
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true${detachGrandchild ? ', detached: true' : ''} })
    ${detachGrandchild ? 'g.unref();' : ''}
    console.log(g.pid)
    ${parentExits ? 'setTimeout(() => process.exit(0), 300)' : 'setTimeout(() => {}, 60000)'}
  `
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], ...ISOLATED_CHILD })
  const grandchildPid = new Promise<number>((resolve) => {
    child.stdout.on('data', (d) => resolve(Number(String(d).trim())))
  })
  return { child, grandchildPid }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.runIf(isWindows)('process trees (Windows)', () => {
  it('killProcessTree ends grandchildren, not just the top process', async () => {
    // Detached: Node's own children die with it via a job object, but native
    // CLIs (Kiro) don't do that — their children survive a plain kill.
    const { child, grandchildPid } = spawnParentWithGrandchild(true, false)
    const gpid = await grandchildPid
    expect(isAlive(gpid)).toBe(true)
    killProcessTree(child)
    await wait(500)
    expect(isAlive(gpid)).toBe(false)
    expect(wasStoppedByUs(child)).toBe(true)
  })

  it('listTurnProcesses reports a process the turn left orphaned', async () => {
    // Shape of the real case: the CLI (here: this test process, alive) ran a
    // shell (the child) that started an emulator (the grandchild) and exited.
    const since = Date.now() - 1000
    const { child, grandchildPid } = spawnParentWithGrandchild(true, true)
    const gpid = await grandchildPid
    await new Promise((r) => child.on('close', r)) // the parent is gone; the grandchild lives on
    try {
      const procs = await listTurnProcesses(process.pid, since)
      expect(procs).toContainEqual(expect.objectContaining({ pid: gpid, relation: 'orphaned' }))
    } finally {
      try { process.kill(gpid) } catch { /* gone */ }
    }
  })
})

describe('wasStoppedByUs', () => {
  it('is false for a child that exited on its own', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore', ...ISOLATED_CHILD })
    await new Promise((r) => child.on('close', r))
    expect(wasStoppedByUs(child)).toBe(false)
  })
})
