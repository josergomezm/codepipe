/**
 * Simple structured logger for CodePipe.
 * Levels: debug, info, warn, error
 * Set LOG_LEVEL env var to control verbosity (default: info).
 * Logs to both console and data/server.log.
 */

import { appendFileSync, mkdirSync } from 'fs'
import path from 'path'

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LEVELS

const currentLevel: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) ?? 'info'

const logFile = path.resolve('data', 'server.log')
mkdirSync(path.dirname(logFile), { recursive: true })

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel]
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
}

function write(level: string, tag: string, msg: string, data?: unknown) {
  const line = `${timestamp()} [${level}] [${tag}] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`
  appendFileSync(logFile, line)
}

export const log = {
  debug(tag: string, msg: string, data?: unknown) {
    if (shouldLog('debug')) {
      console.log(`${timestamp()} [DEBUG] [${tag}] ${msg}`, data !== undefined ? data : '')
      write('DEBUG', tag, msg, data)
    }
  },
  info(tag: string, msg: string, data?: unknown) {
    if (shouldLog('info')) {
      console.log(`${timestamp()} [INFO]  [${tag}] ${msg}`, data !== undefined ? data : '')
      write('INFO ', tag, msg, data)
    }
  },
  warn(tag: string, msg: string, data?: unknown) {
    if (shouldLog('warn')) {
      console.warn(`${timestamp()} [WARN]  [${tag}] ${msg}`, data !== undefined ? data : '')
      write('WARN ', tag, msg, data)
    }
  },
  error(tag: string, msg: string, data?: unknown) {
    if (shouldLog('error')) {
      console.error(`${timestamp()} [ERROR] [${tag}] ${msg}`, data !== undefined ? data : '')
      write('ERROR', tag, msg, data)
    }
  },
}
