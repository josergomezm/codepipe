/**
 * Process-level crash handling. Imported first by index.ts so it's active
 * before anything else can fail.
 *
 * - uncaughtException: write a crash report (error + recent log lines +
 *   what the server was doing), log it as FATAL, then exit with code 1. The
 *   process state can't be trusted after this; the supervisor
 *   (scripts/supervise.mjs) restarts it.
 * - unhandledRejection: Node's default is to crash. These are usually a
 *   missed `.catch()` on some background task, so we report and keep serving
 *   instead of taking every chat down with it.
 * - Node warnings (e.g. listener leaks) and the final exit code are logged.
 */

import { log, writeCrashReport } from './logger.js'

/** At most this many rejection reports per window, so a hot loop can't fill the disk. */
const REJECTION_REPORTS_PER_WINDOW = 5
const REJECTION_WINDOW_MS = 10 * 60 * 1000

let exiting = false
let rejectionWindowStart = 0
let rejectionReports = 0

export function installCrashGuard(): void {
  process.on('uncaughtException', (err, origin) => {
    if (exiting) return
    exiting = true
    const file = writeCrashReport('uncaughtException', err)
    log.fatal('process', `Uncaught exception (${origin}) — exiting${file ? `. Report: ${file}` : ''}`, err)
    // Let stdio flush, then go; the supervisor restarts us.
    setTimeout(() => process.exit(1), 250)
  })

  process.on('unhandledRejection', (reason) => {
    const now = Date.now()
    if (now - rejectionWindowStart > REJECTION_WINDOW_MS) {
      rejectionWindowStart = now
      rejectionReports = 0
    }
    const file = rejectionReports++ < REJECTION_REPORTS_PER_WINDOW ? writeCrashReport('unhandledRejection', reason) : null
    log.error('process', `Unhandled promise rejection — server kept running${file ? `. Report: ${file}` : ''}`, reason)
  })

  process.on('warning', (warning) => {
    log.warn('process', `Node warning: ${warning.name}: ${warning.message}`)
  })

  process.on('exit', (code) => {
    log.info('process', `Process exiting with code ${code}`)
  })
}

// Install on import: index.ts imports this module first, so the handlers are
// in place before any other module's top-level code runs.
if (!process.env['VITEST']) installCrashGuard()
