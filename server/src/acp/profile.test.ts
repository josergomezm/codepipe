import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { AcpSessionDriver, type AcpChildLike } from './driver.js'
import { GEMINI_ACP_PROFILE, SPEC_ACP_PROFILE } from './profile.js'
import type { AdapterEvent } from '../adapters/types.js'

/** Fake agent that records frames and answers using a given method set. */
class FakeAgent extends EventEmitter implements AcpChildLike {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly sentFrames: Array<Record<string, unknown>> = []
  killed = false
  readonly stdin = {
    write: (frame: string) => {
      const msg = JSON.parse(frame.trim()) as Record<string, unknown>
      this.sentFrames.push(msg)
      if (typeof msg['method'] === 'string' && 'id' in msg) setImmediate(() => this.reply(msg))
    },
  }
  constructor(private readonly newSessionMethod: string, private readonly promptMethod: string) {
    super()
  }
  // Optional models advertised in the newSession result.
  newSessionModels: unknown = undefined

  private reply(msg: Record<string, unknown>): void {
    const { method, id } = msg as { method: string; id: unknown }
    if (method === 'initialize') this.emitLine({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } })
    else if (method === this.newSessionMethod)
      this.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 'gem_1', ...(this.newSessionModels ? { models: this.newSessionModels } : {}) } })
    else if (method === this.promptMethod) this.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    else this.emitLine({ jsonrpc: '2.0', id, result: {} }) // e.g. setSessionMode / set_model
  }
  emitLine(obj: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  }
  kill(): void {
    this.killed = true
  }
}

describe('profiles', () => {
  it('Gemini profile uses --acp and its own method names', () => {
    expect(GEMINI_ACP_PROFILE.args).toEqual(['--acp'])
    expect(GEMINI_ACP_PROFILE.methods.newSession).toBe('newSession')
    expect(GEMINI_ACP_PROFILE.methods.prompt).toBe('prompt')
    expect(SPEC_ACP_PROFILE.methods.newSession).toBe('session/new')
  })

  it('drives a Gemini-dialect agent: newSession, setSessionMode, prompt', async () => {
    const agent = new FakeAgent('newSession', 'prompt')
    const events: AdapterEvent[] = []
    const onIdle = vi.fn()
    const driver = new AcpSessionDriver({
      binary: 'gemini',
      cwd: '/p',
      profile: GEMINI_ACP_PROFILE,
      spawn: () => agent,
      callbacks: { onEvent: (e) => events.push(e), onIdle },
    })

    await driver.start()
    expect(driver.getSessionId()).toBe('gem_1')

    const methods = agent.sentFrames.map((f) => f['method'])
    expect(methods).toContain('newSession')
    expect(methods).toContain('setSessionMode') // afterSession auto-approve hook

    await driver.prompt('hello gemini')
    expect(onIdle).toHaveBeenCalledOnce()
    expect(events.some((e) => e.type === 'message_complete')).toBe(true)
  })

  it('emits model_info when the agent advertises models, and switches via setModel', async () => {
    const agent = new FakeAgent('newSession', 'prompt')
    agent.newSessionModels = { available: [{ id: 'gemini-pro' }, { id: 'gemini-flash' }], current: 'gemini-pro' }
    const events: AdapterEvent[] = []
    const driver = new AcpSessionDriver({
      binary: 'gemini',
      cwd: '/p',
      profile: GEMINI_ACP_PROFILE,
      spawn: () => agent,
      callbacks: { onEvent: (e) => events.push(e) },
    })

    await driver.start()
    const modelInfo = events.find((e) => e.type === 'model_info') as
      | { available?: { id: string }[]; current?: string }
      | undefined
    expect(modelInfo?.available?.map((m) => m.id)).toEqual(['gemini-pro', 'gemini-flash'])
    expect(modelInfo?.current).toBe('gemini-pro')

    await driver.setModel('gemini-flash')
    const setFrame = agent.sentFrames.find((f) => f['method'] === 'unstable_setSessionModel')
    expect(setFrame).toBeTruthy()
    const params = setFrame!['params'] as { modelId?: string; model?: string }
    expect(params.modelId ?? params.model).toBe('gemini-flash')
  })

  it('launches with the profile args, not a hardcoded acp subcommand', async () => {
    const seen: { binary?: string; args?: string[] } = {}
    const agent = new FakeAgent('newSession', 'prompt')
    const driver = new AcpSessionDriver({
      binary: 'gemini',
      cwd: '/p',
      profile: GEMINI_ACP_PROFILE,
      spawn: (binary, args) => {
        seen.binary = binary
        seen.args = args
        return agent
      },
      callbacks: { onEvent: () => {} },
    })
    await driver.start()
    expect(seen.binary).toBe('gemini')
    expect(seen.args).toEqual(['--acp'])
  })
})
