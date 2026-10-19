import { describe, it, expect } from 'vitest'
import { explainStartFailure, portsInOutput } from './dev-server-manager.js'

const failed = (announced: number[], exited = false, exitCode: number | null = null) =>
  ({ exited, exitCode, announcedPorts: new Set(announced) })

describe('portsInOutput', () => {
  it('reads the ports from colored startup banners', () => {
    expect(portsInOutput('\x1b[32m➜\x1b[39m Local:    \x1b[36mhttp://localhost:3000/\x1b[39m')).toEqual([3000])
    expect(portsInOutput('  ➜  Network: http://192.168.1.4:5173/\n  ➜  Local: http://[::1]:5173/')).toEqual([5173, 5173])
  })

  it('ignores output without a URL', () => {
    expect(portsInOutput('● Building server (2.51s · 19.9s)')).toEqual([])
  })
})

describe('explainStartFailure', () => {
  it('names the port the server came up on instead', () => {
    expect(explainStartFailure(2999, failed([3000]))).toContain('came up on port 3000, but CodePipe waits for port 2999')
  })

  it('points at the bind host when the right port only reached ::1', () => {
    expect(explainStartFailure(5180, failed([5180]))).toContain('bound only to ::1')
  })

  it('reports an early exit', () => {
    expect(explainStartFailure(5180, failed([], true, 1))).toContain('exited with code 1')
  })
})
