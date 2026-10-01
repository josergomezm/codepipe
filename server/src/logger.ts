/**
 * Structured logger for CodePipe.
 *
 * Levels: debug, info, warn, error, fatal. Set LOG_LEVEL to control verbosity
 * (default: info). Lines go to the console and to data/server.log with a full
 * ISO timestamp. The file rotates at LOG_MAX_BYTES (server.1.log … .N.log).
 *
 * Errors passed as `data` are serialized with their message, code and stack —
 * `JSON.stringify(new Error())` is `{}`, which used to hide every failure.
 *
 * Crash reports (see writeCrashReport) bundle the error with the most recent
 * log lines and a snapshot of what the server was doing, one file per crash
 * in data/crashes/.
 *
 * Under Vitest nothing is written to disk, so test runs never pollute the
 * real log.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import path from 'path'

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 } as const
type LogLevel = keyof typeof LEVELS

const currentLevel: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) in LEVELS
  ? (process.env['LOG_LEVEL'] as LogLevel)
  : 'info'

export const DATA_DIR = path.resolve('data')
export const LOG_FILE = path.join(DATA_DIR, 'server.log')
export const CRASH_DIR = path.join(DATA_DIR, 'crashes')

const LOG_MAX_BYTES = Number(process.env['LOG_MAX_BYTES'] ?? 10 * 1024 * 1024)
const LOG_KEEP_FILES = 5
const RECENT_LINES = 300
const MAX_CRASH_REPORTS = 50

const writeToDisk = !process.env['VITEST']

/** Most recent formatted lines, kept in memory for crash reports. */
const recent: string[] = []
let bytesSinceCheck = 0

if (writeToDisk) mkdirSync(DATA_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** A plain object describing an error, including its cause chain. */
export function describeError(err: unknown, depth = 0): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) }
  const out: Record<string, unknown> = { name: err.name, message: err.message }
  const extra = err as Error & { code?: unknown; errno?: unknown; syscall?: unknown; path?: unknown; cause?: unknown }
  for (const k of ['code', 'errno', 'syscall', 'path'] as const) {
    if (extra[k] !== undefined) out[k] = extra[k]
  }
  if (err.stack) out['stack'] = err.stack
  if (extra.cause !== undefined && depth < 3) out['cause'] = describeError(extra.cause, depth + 1)
  return out
}

/** JSON for log data: Errors are expanded, cycles and odd values don't throw. */
export function serialize(data: unknown): string {
  if (data instanceof Error) return JSON.stringify(describeError(data))
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(data, (_key, value: unknown) => {
      if (value instanceof Error) return describeError(value)
      if (typeof value === 'bigint') return value.toString()
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[circular]'
        seen.add(value)
      }
      return value
    })
  } catch {
    return JSON.stringify(String(data))
  }
}

// ---------------------------------------------------------------------------
// File output + rotation
// ---------------------------------------------------------------------------

function rotateIfNeeded(): void {
  if (bytesSinceCheck < 256 * 1024) return
  bytesSinceCheck = 0
  try {
    if (statSync(LOG_FILE).size < LOG_MAX_BYTES) return
    for (let i = LOG_KEEP_FILES - 1; i >= 1; i--) {
      const from = path.join(DATA_DIR, `server.${i}.log`)
      if (existsSync(from)) renameSync(from, path.join(DATA_DIR, `server.${i + 1}.log`))
    }
    renameSync(LOG_FILE, path.join(DATA_DIR, 'server.1.log'))
    const oldest = path.join(DATA_DIR, `server.${LOG_KEEP_FILES + 1}.log`)
    if (existsSync(oldest)) rmSync(oldest)
  } catch {
    // Rotation is best-effort (e.g. the file is locked by an editor).
  }
}

function emit(level: LogLevel, tag: string, msg: string, data?: unknown): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return
  const label = level.toUpperCase().padEnd(5)
  const line = `${new Date().toISOString()} [${label}] [${tag}] ${msg}${data !== undefined ? ' ' + serialize(data) : ''}`

  recent.push(line)
  if (recent.length > RECENT_LINES) recent.shift()

  const toConsole = level === 'error' || level === 'fatal' ? console.error : level === 'warn' ? console.warn : console.log
  toConsole(line)

  if (!writeToDisk) return
  try {
    appendFileSync(LOG_FILE, line + '\n')
    bytesSinceCheck += line.length + 1
    rotateIfNeeded()
  } catch {
    // Never let logging itself take the server down.
  }
}

export const log = {
  debug(tag: string, msg: string, data?: unknown) { emit('debug', tag, msg, data) },
  info(tag: string, msg: string, data?: unknown) { emit('info', tag, msg, data) },
  warn(tag: string, msg: string, data?: unknown) { emit('warn', tag, msg, data) },
  error(tag: string, msg: string, data?: unknown) { emit('error', tag, msg, data) },
  fatal(tag: string, msg: string, data?: unknown) { emit('fatal', tag, msg, data) },
}

/** The last few hundred log lines (newest last). */
export function recentLogLines(): string[] {
  return [...recent]
}

// ---------------------------------------------------------------------------
// Crash reports
// ---------------------------------------------------------------------------

let crashContext: () => Record<string, unknown> = () => ({})

/** Register a callback that describes what the server was doing, for crash reports. */
export function setCrashContext(fn: () => Record<string, unknown>): void {
  crashContext = fn
}

/**
 * Write a crash report synchronously (safe to call from an uncaughtException
 * handler). Returns the report path, or null when nothing was written.
 */
export function writeCrashReport(kind: string, err: unknown): string | null {
  let context: Record<string, unknown>
  try {
    context = crashContext()
  } catch (e) {
    context = { contextError: describeError(e) }
  }

  const report = {
    kind,
    time: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    memory: process.memoryUsage(),
    error: describeError(err),
    context,
  }
  const body = `${serialize(report)}\n\n--- last ${recent.length} log lines ---\n${recent.join('\n')}\n`

  if (!writeToDisk) return null
  try {
    mkdirSync(CRASH_DIR, { recursive: true })
    const file = path.join(CRASH_DIR, `${report.time.replace(/[:.]/g, '-')}-${kind}.log`)
    writeFileSync(file, body)
    pruneCrashReports()
    return file
  } catch {
    return null
  }
}

function pruneCrashReports(): void {
  const files = readdirSync(CRASH_DIR).filter((f) => f.endsWith('.log')).sort()
  for (const f of files.slice(0, Math.max(0, files.length - MAX_CRASH_REPORTS))) {
    rmSync(path.join(CRASH_DIR, f), { force: true })
  }
}
