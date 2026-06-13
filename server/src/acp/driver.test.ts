import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { AcpSessionDriver, choosePermissionOption, type AcpChildLike } from './driver.js'
import type { AdapterEvent } from '../adapters/types.js'

/**
 * A fake `kiro-cli acp` process. Parses frames written to stdin and emits
 * canned JSON-RPC responses / session-update notifications on stdout, so the
 * full driver lifecycle can be exercised without a real binary.
 */
class FakeAgent extends EventEmitter implements AcpChildLike {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly sentFrames: Array<Record<string, unknown>> = []
  killed = false
  readonly stdin = {
    write: (frame: string) => {
      const msg = JSON.parse(frame.trim()) as Record<string, unknown>
      this.sentFrames.push(msg)
      if (typeof msg['method'] === 'string' && 'id' in msg) {
        setImmediate(() => this.handleRequest(msg))
      }
    },
  }

  // Notifications to stream in response to a session/prompt, set per test.
  promptUpdates: Array<Record<string, unknown>> = []
  promptStopReason = 'end_turn'

  private handleRequest(msg: Record<string, unknown>): void {
    const method = msg['method'] as string
    const id = msg['id']
    if (method === 'initialize') {
      this.respond(id, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
    } else if (method === 'session/new') {
      this.respond(id, { sessionId: 'sess_test' })
    } else if (method === 'session/load') {
      this.respond(id, {})
    } else if (method === 'session/prompt') {
      for (const update of this.promptUpdates) {
        this.notify('session/update', { sessionId: 'sess_test', update })
      }
      this.respond(id, { stopReason: this.promptStopReason })
    }
  }

  private respond(id: unknown, result: unknown): void {
    this.emitLine({ jsonrpc: '2.0', id, result })
  }

  notify(method: string, params: unknown): void {
    this.emitLine({ jsonrpc: '2.0', method, params })
  }

  emitLine(obj: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  }

  kill(): void {
    this.killed = true
  }
}

function makeDriver(agent: FakeAgent, onEvent: (e: AdapterEvent) => void, extra: Record<string, unknown> = {}) {
  const onIdle = vi.fn()
  const onSessionId = vi.fn()
  const driver = new AcpSessionDriver({
    binary: 'kiro-cli',
    cwd: '/project',
    spawn: () => agent,
    callbacks: { onEvent, onIdle, onSessionId },
    ...extra,
  })
  return { driver, onIdle, onSessionId }
}

describe('AcpSessionDriver lifecycle', () => {
  it('initializes and creates a session, capturing the session ID', async () => {
    const agent = new FakeAgent()
    const { driver, onSessionId } = makeDriver(agent, () => {})
    await driver.start()

    expect(driver.getSessionId()).toBe('sess_test')
    expect(onSessionId).toHaveBeenCalledWith('sess_test')
    const methods = agent.sentFrames.map((f) => f['method'])
    expect(methods).toContain('initialize')
    expect(methods).toContain('session/new')
  })

  it('loads an existing session when resuming', async () => {
    const agent = new FakeAgent()
    const { driver } = makeDriver(agent, () => {})
    await driver.start('sess_existing')

    expect(driver.getSessionId()).toBe('sess_existing')
    const loadFrame = agent.sentFrames.find((f) => f['method'] === 'session/load')
    expect(loadFrame).toBeTruthy()
    expect((loadFrame!['params'] as { sessionId: string }).sessionId).toBe('sess_existing')
  })

  it('streams chunk + tool + message_complete events from a prompt turn', async () => {
    const agent = new FakeAgent()
    agent.promptUpdates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it.' } },
      { sessionUpdate: 'tool_call', title: 'Read README', kind: 'fs_read', status: 'in_progress' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Done.' } },
    ]
    const events: AdapterEvent[] = []
    const { driver, onIdle } = makeDriver(agent, (e) => events.push(e))
    await driver.start()
    await driver.prompt('summarize the repo')

    const types = events.map((e) => e.type)
    expect(types).toEqual(['chunk', 'tool_use', 'chunk', 'message_complete'])
    expect((events[0] as { content: string }).content).toBe('Working on it.')
    expect((events[1] as { tool: string }).tool).toBe('Read README')
    expect(onIdle).toHaveBeenCalledOnce()
  })

  it('sends a session/cancel notification', async () => {
    const agent = new FakeAgent()
    const { driver } = makeDriver(agent, () => {})
    await driver.start()
    driver.cancel()

    const cancel = agent.sentFrames.find((f) => f['method'] === 'session/cancel')
    expect(cancel).toBeTruthy()
    expect((cancel!['params'] as { sessionId: string }).sessionId).toBe('sess_test')
  })

  it('auto-approves agent permission requests', async () => {
    const agent = new FakeAgent()
    const { driver } = makeDriver(agent, () => {})
    await driver.start()

    // Simulate the agent asking for permission mid-turn.
    agent.emitLine({
      jsonrpc: '2.0',
      id: 500,
      method: 'session/request_permission',
      params: { options: [{ optionId: 'reject', kind: 'reject_once' }, { optionId: 'ok', kind: 'allow_once' }] },
    })
    await new Promise((r) => setImmediate(r))

    const reply = agent.sentFrames.find((f) => f['id'] === 500) as { result?: { outcome?: { optionId?: string } } }
    expect(reply?.result?.outcome?.optionId).toBe('ok')
  })

  it('kills the process on dispose', async () => {
    const agent = new FakeAgent()
    const { driver } = makeDriver(agent, () => {})
    await driver.start()
    driver.dispose()
    expect(agent.killed).toBe(true)
  })
})

describe('choosePermissionOption', () => {
  it('prefers an allow-kind option', () => {
    expect(
      choosePermissionOption({ options: [{ optionId: 'no', kind: 'reject_once' }, { optionId: 'yes', kind: 'allow_always' }] }),
    ).toEqual({ optionId: 'yes' })
  })

  it('falls back to the first option', () => {
    expect(choosePermissionOption({ options: [{ optionId: 'first' }] })).toEqual({ optionId: 'first' })
  })

  it('handles missing options safely', () => {
    expect(choosePermissionOption({})).toEqual({})
    expect(choosePermissionOption(null)).toEqual({})
  })
})
