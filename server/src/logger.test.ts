import { describe, it, expect } from 'vitest'
import { serialize, describeError, recentLogLines, log } from './logger.js'
import { lastMeaningfulLine } from './session-manager.js'
import { sampleHealth } from './health.js'

describe('serialize', () => {
  it('expands Errors instead of logging {}', () => {
    const err = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    const out = JSON.parse(serialize(err))
    expect(out).toMatchObject({ name: 'Error', message: 'disk full', code: 'ENOSPC' })
    expect(out.stack).toContain('disk full')
  })

  it('expands Errors nested in objects, with their cause', () => {
    const err = new Error('save failed', { cause: new Error('EPERM: rename') })
    const out = JSON.parse(serialize({ sessionId: 's1', err }))
    expect(out.err.message).toBe('save failed')
    expect(out.err.cause.message).toBe('EPERM: rename')
  })

  it('survives circular data', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a['self'] = a
    expect(JSON.parse(serialize(a))).toEqual({ name: 'a', self: '[circular]' })
  })

  it('describes non-Error throwables', () => {
    expect(describeError('boom')).toEqual({ value: 'boom' })
  })
})

describe('recentLogLines', () => {
  it('keeps the latest lines for crash reports', () => {
    log.warn('test', 'remember me')
    expect(recentLogLines().at(-1)).toMatch(/\[WARN \] \[test\] remember me$/)
  })
})

describe('lastMeaningfulLine', () => {
  it('skips CLI log noise and returns the last real line', () => {
    const stderr = 'error: Individual quota reached.\n[INFO] [KRS] done\n▸ Credits: 0.05 • Time: 1s\n'
    expect(lastMeaningfulLine(stderr)).toBe('error: Individual quota reached.')
  })

  it('returns null when there is nothing useful', () => {
    expect(lastMeaningfulLine('\n[INFO] starting\n')).toBeNull()
  })
})

describe('sampleHealth', () => {
  it('reports memory, loop delay and the given counts', () => {
    const s = sampleHealth({ liveSessions: 2, shells: 1 }, false)
    expect(s.rssMb).toBeGreaterThan(0)
    expect(typeof s.maxLoopDelayMs).toBe('number')
    expect(s).toMatchObject({ liveSessions: 2, shells: 1 })
  })
})
