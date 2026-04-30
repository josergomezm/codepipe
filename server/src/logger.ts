/**
 * Simple structured logger for CodePipe.
 * Levels: debug, info, warn, error
 * Set LOG_LEVEL env var to control verbosity (default: info).
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LEVELS

const currentLevel: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) ?? 'info'

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel]
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
}

export const log = {
  debug(tag: string, msg: string, data?: unknown) {
    if (shouldLog('debug')) {
      console.log(`${timestamp()} [DEBUG] [${tag}] ${msg}`, data !== undefined ? data : '')
    }
  },
  info(tag: string, msg: string, data?: unknown) {
    if (shouldLog('info')) {
      console.log(`${timestamp()} [INFO]  [${tag}] ${msg}`, data !== undefined ? data : '')
    }
  },
  warn(tag: string, msg: string, data?: unknown) {
    if (shouldLog('warn')) {
      console.warn(`${timestamp()} [WARN]  [${tag}] ${msg}`, data !== undefined ? data : '')
    }
  },
  error(tag: string, msg: string, data?: unknown) {
    if (shouldLog('error')) {
      console.error(`${timestamp()} [ERROR] [${tag}] ${msg}`, data !== undefined ? data : '')
    }
  },
}
