#!/usr/bin/env node
/**
 * CodePipe supervisor — keeps the server running.
 *
 *   npm run serve
 *
 * Runs src/index.ts under tsx's loader (no file watching, so an agent editing CodePipe's
 * own code can't restart the server mid-turn) and restarts it whenever it
 * exits abnormally, with exponential backoff for crash loops.
 *
 * Every restart is recorded in data/restarts.jsonl and shown on the
 * Diagnostics page. If the server died without writing its own crash report
 * — a native crash or running out of memory, which JavaScript handlers can't
 * catch — the supervisor writes one from the server's last stderr output.
 *
 * Ctrl+C (or SIGTERM) stops the server gracefully and then the supervisor.
 *
 * CODEPIPE_CWD sets the folder the server runs in (and so where its data/
 * lives); it defaults to the server/ directory.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runDir = path.resolve(process.env.CODEPIPE_CWD || serverDir)
const entry = path.join(serverDir, 'src', 'index.ts')
const dataDir = path.join(runDir, 'data')
const crashDir = path.join(dataDir, 'crashes')
const restartsFile = path.join(dataDir, 'restarts.jsonl')
const logFile = path.join(dataDir, 'server.log')
// The server runs as ONE Node process with tsx's loader — no `tsx` CLI
// wrapper in between, so signals, exit codes and stdio reach it directly and
// killing it can't leave an orphaned grandchild holding the port.
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href

const MIN_DELAY_MS = 1000
const MAX_DELAY_MS = 60_000
/** Runs shorter than this count as a crash loop and back off harder. */
const QUICK_CRASH_MS = 60_000
const STDERR_TAIL_CHARS = 8000

mkdirSync(crashDir, { recursive: true })

let child = null
let stopping = false
let quickCrashes = 0

function note(level, msg) {
  const line = `${new Date().toISOString()} [${level.padEnd(5)}] [supervisor] ${msg}`
  console.log(line)
  try { appendFileSync(logFile, line + '\n') } catch { /* best effort */ }
}

const crashFiles = () => (existsSync(crashDir) ? readdirSync(crashDir).filter((f) => f.endsWith('.log')) : [])

function start() {
  const before = new Set(crashFiles())
  const startedAt = Date.now()
  let stderrTail = ''

  // Not windowsHide: the server deliberately shares this console, so your
  // Ctrl+C reaches it and it shuts down gracefully on its own. (The CLIs it
  // starts are isolated from this console — see src/child-options.ts.)
  child = spawn(process.execPath, ['--import', tsxLoader, entry], {
    cwd: runDir,
    env: { ...process.env, CODEPIPE_SUPERVISED: '1', TSX_TSCONFIG_PATH: path.join(serverDir, 'tsconfig.json') },
    stdio: ['inherit', 'inherit', 'pipe'],
  })
  note('INFO', `Started server (pid ${child.pid})`)

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS)
  })

  child.on('exit', (rawCode, signal) => {
    child = null
    const code = signedCode(rawCode)
    const uptimeSeconds = Math.round((Date.now() - startedAt) / 1000)

    if (stopping) {
      note('INFO', `Server stopped (code ${code ?? 'none'}${signal ? `, ${signal}` : ''}). Supervisor exiting.`)
      process.exit(0)
    }

    // The server's own crash handler writes a report for a fatal JS error
    // (uncaughtException). Only that kind explains a death: rejection reports
    // from earlier in the run were non-fatal. Anything else (OOM, native
    // crash, killed from outside) gets a report built from stderr.
    const newReports = crashFiles().filter((f) => !before.has(f) && f.endsWith('-uncaughtException.log'))
    let report = newReports.sort().at(-1) ?? null
    if (!report) {
      const time = new Date().toISOString()
      report = `${time.replace(/[:.]/g, '-')}-process-exit.log`
      const header = { kind: 'process-exit', time, exitCode: code, signal, uptimeSeconds, error: { message: headline(stderrTail) ?? `exited with code ${code}${signal ? ` (${signal})` : ''} and printed no error — killed from outside, or a native crash` } }
      try {
        writeFileSync(path.join(crashDir, report), `${JSON.stringify(header)}\n\n--- server stderr (last ${STDERR_TAIL_CHARS} chars) ---\n${stderrTail}\n`)
      } catch { report = null }
    }

    try {
      appendFileSync(restartsFile, JSON.stringify({ time: new Date().toISOString(), exitCode: code, signal, uptimeSeconds, report }) + '\n')
    } catch { /* best effort */ }

    quickCrashes = uptimeSeconds * 1000 < QUICK_CRASH_MS ? quickCrashes + 1 : 0
    const delay = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** quickCrashes)
    note('FATAL', `Server exited unexpectedly (code ${code ?? 'none'}${signal ? `, ${signal}` : ''}) after ${uptimeSeconds}s. Restarting in ${Math.round(delay / 1000)}s.${report ? ` Report: ${report}` : ''}`)
    setTimeout(start, delay)
  })
}

/**
 * Harmless stderr from child helpers, never the cause of a server death:
 * node-pty's Windows kill helper crashes with this when the shell had
 * already exited (the helper is a separate process).
 */
const KNOWN_NOISE = /AttachConsole failed|conpty_console_list_agent|getConsoleProcessList\(shellPid\)/

/** The server's own log lines (also mirrored to stderr for warnings/errors). */
const LOG_LINE = /^\d{4}-\d\d-\d\dT[\d:.]+Z \[(\w+)\s*\]/

/**
 * Best headline for a death: raw stderr output (a native crash or OOM message
 * isn't in log format), else the last ERROR/FATAL log line, else null.
 */
function headline(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const raw = lines.filter((l) => !LOG_LINE.test(l) && !l.startsWith('at ') && !l.startsWith('{') && !KNOWN_NOISE.test(l))
  // Native crashes print the message, then stack frames ("1: 00007FF6 …").
  const errorLike = raw.filter((l) => /FATAL ERROR|out of memory|Error\b|Exception|panic|Segmentation fault|Assertion/i.test(l))
  if (errorLike.length) return errorLike.at(-1)
  if (raw.length) return raw.at(-1)
  const errors = lines.filter((l) => /^\S+ \[(ERROR|FATAL)\]/.test(l))
  return errors.at(-1) ?? null
}

/** Windows reports some exit codes as unsigned 32-bit (e.g. 4294967295 for -1). */
const signedCode = (code) => (typeof code === 'number' && code > 0x7fffffff ? code - 0x100000000 : code)

const STOP_TIMEOUT_MS = 15_000

function stop(signal) {
  if (stopping) return
  stopping = true
  if (!child) process.exit(0)
  note('INFO', `Received ${signal} — waiting for the server to shut down…`)
  // Console events — Ctrl+C, Ctrl+Break, closing the window — reach the
  // server too (it shares this console), and it shuts down gracefully by
  // itself: saving messages, archiving chats. On Windows child.kill() is an
  // immediate hard kill, so don't cut that short. Elsewhere (or for SIGTERM),
  // forward the signal; Node handles it gracefully.
  const consoleEvent = ['SIGINT', 'SIGHUP', 'SIGBREAK'].includes(signal)
  if (!(process.platform === 'win32' && consoleEvent)) {
    try { child.kill(signal) } catch { /* already gone */ }
  }
  setTimeout(() => {
    if (child) {
      note('WARN', `Server did not stop within ${STOP_TIMEOUT_MS / 1000}s — killing it`)
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }, STOP_TIMEOUT_MS).unref()
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGHUP', () => stop('SIGHUP'))
if (process.platform === 'win32') process.on('SIGBREAK', () => stop('SIGBREAK'))

start()
