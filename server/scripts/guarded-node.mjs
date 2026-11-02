#!/usr/bin/env node
/**
 * Runs a Node program under a renamed copy of node.exe, so CodePipe survives
 * agents that kill processes by name.
 *
 *   node scripts/guarded-node.mjs tsx watch src/index.ts   (a package's bin)
 *   node scripts/guarded-node.mjs scripts/supervise.mjs     (a script file)
 *
 * An agent running `Get-Process node | Stop-Process -Force` or
 * `taskkill /f /im node.exe` (e.g. to restart emulators) used to take the
 * CodePipe server and client down with it. On Windows the program runs as
 * %LOCALAPPDATA%\CodePipe\bin\codepipe-node-<version>.exe instead, which those
 * commands don't match. Children that spawn process.execPath (tsx watch, the
 * supervisor) inherit the renamed binary.
 *
 * This launcher (and npm above it) is still node.exe and can be killed; the
 * program keeps running in the same console when it is. Elsewhere it runs
 * under plain node.
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [target, ...args] = process.argv.slice(2)
if (!target) {
  console.error('usage: guarded-node.mjs <package-bin | script.mjs> [args...]')
  process.exit(2)
}

/** The script to run: a file path as given, or the named package's bin entry. */
function resolveEntry(name) {
  if (/\.[cm]?js$/.test(name) && existsSync(name)) return path.resolve(name)
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const pkgFile = path.join(dir, 'node_modules', name, 'package.json')
    if (existsSync(pkgFile)) {
      const { bin } = JSON.parse(readFileSync(pkgFile, 'utf8'))
      const rel = typeof bin === 'string' ? bin : bin?.[name]
      if (!rel) throw new Error(`${name} has no "${name}" bin`)
      return path.join(path.dirname(pkgFile), rel)
    }
    if (path.dirname(dir) === dir) throw new Error(`can't find package ${name} from ${process.cwd()}`)
  }
}

/** A renamed node binary (Windows), or the current one if that fails. */
function guardedNode() {
  if (process.platform !== 'win32') return process.execPath
  const binDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CodePipe', 'bin')
  // Versioned so a Node upgrade gets a fresh copy without touching one in use.
  const exe = path.join(binDir, `codepipe-node-${process.version}.exe`)
  try {
    if (!existsSync(exe)) {
      mkdirSync(binDir, { recursive: true })
      const tmp = `${exe}.${process.pid}.tmp`
      copyFileSync(process.execPath, tmp)
      renameSync(tmp, exe)
    }
    return exe
  } catch (err) {
    // The server and client launch together; the other one may have won the copy.
    if (existsSync(exe)) return exe
    console.warn(`[guarded-node] couldn't prepare ${exe} (${err.message}); running under node.exe`)
    return process.execPath
  }
}

const argv = [guardedNode(), resolveEntry(target), ...args]
// Node kills its direct children when it dies (libuv's kill-on-close job), so
// a direct child would still fall with this launcher. Going through cmd makes
// the program a grandchild, which the job doesn't hold.
const child = process.platform === 'win32'
  ? spawn('cmd.exe', ['/d', '/s', '/c', `"${argv.map((a) => `"${a}"`).join(' ')}"`], { stdio: 'inherit', windowsVerbatimArguments: true })
  : spawn(argv[0], argv.slice(1), { stdio: 'inherit' })
// Ctrl+C reaches the child through the shared console; wait for it to exit.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => {})
child.on('error', (err) => {
  console.error(`[guarded-node] ${err.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
