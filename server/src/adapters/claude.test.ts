import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { translateStreamJsonLine } from './claude-stream-json.js'
import { ClaudeAdapter, resolveClaudeBinary } from './claude.js'

describe('translateStreamJsonLine', () => {
  it('captures the session ID and model from a system/init event', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess_abc', model: 'claude-sonnet-4-6' })
    expect(translateStreamJsonLine(line)).toEqual([
      { type: 'cli_session', sessionId: 'sess_abc' },
      { type: 'model_info', current: 'claude-sonnet-4-6' },
    ])
  })

  it('translates assistant text blocks to chunks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'world' }] },
      session_id: 's',
    })
    expect(translateStreamJsonLine(line)).toEqual([
      { type: 'chunk', content: 'Hello', role: 'assistant' },
      { type: 'chunk', content: 'world', role: 'assistant' },
    ])
  })

  it('translates tool_use blocks with name + input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' }, id: 't1' }] },
    })
    const events = translateStreamJsonLine(line)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'tool_use', tool: 'Bash' })
    expect((events[0] as { content: string }).content).toContain('ls -la')
  })

  it('summarizes the Agent/Task tool concisely instead of dumping the prompt', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Agent',
            input: { subagent_type: 'Explore', description: 'Explore UI codebase for gaps', prompt: 'long\n\nmultiline\nprompt' },
          },
        ],
      },
    })
    const events = translateStreamJsonLine(line)
    expect(events[0]).toEqual({ type: 'tool_use', tool: 'Agent', content: 'Explore: Explore UI codebase for gaps' })
    expect((events[0] as { content: string }).content).not.toContain('\\n')
  })

  it('mixes text and tool_use blocks in order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Let me check' }, { type: 'tool_use', name: 'Read', input: {} }] },
    })
    expect(translateStreamJsonLine(line).map((e) => e.type)).toEqual(['chunk', 'tool_use'])
  })

  it('emits message_complete with cost metadata on result', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'sess_z',
      total_cost_usd: 0.0123,
      duration_ms: 4200,
      is_error: false,
    })
    const events = translateStreamJsonLine(line)
    expect(events).toContainEqual({ type: 'cli_session', sessionId: 'sess_z' })
    const complete = events.find((e) => e.type === 'message_complete') as {
      type: string
      metadata?: { credits: string; time: string }
    }
    expect(complete).toBeTruthy()
    expect(complete.metadata).toEqual({ credits: '$0.0123', time: '4s' })
  })

  it('emits message_complete without metadata when cost is absent', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success' })
    expect(translateStreamJsonLine(line)).toEqual([{ type: 'message_complete', role: 'assistant' }])
  })

  it('ignores tool_result, stream_event, and non-JSON noise', () => {
    expect(translateStreamJsonLine(JSON.stringify({ type: 'user', message: { content: [] } }))).toEqual([])
    expect(translateStreamJsonLine(JSON.stringify({ type: 'stream_event', event: {} }))).toEqual([])
    expect(translateStreamJsonLine('Loading model...')).toEqual([])
    expect(translateStreamJsonLine('')).toEqual([])
    expect(translateStreamJsonLine('{broken json')).toEqual([])
  })
})

describe('ClaudeAdapter', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env['CLAUDE_PERMISSION_MODE']
    delete process.env['CLAUDE_EXTRA_ARGS']
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('reports the claude provider and stream-json args', () => {
    const a = new ClaudeAdapter()
    expect(a.provider).toBe('claude')
    expect(a.command).toBe(resolveClaudeBinary())
    expect(a.args).toEqual(['--output-format', 'stream-json', '--verbose'])
    expect(a.transport).toBe('oneshot')
  })

  it('builds a first-message command with -p and the prompt as the positional', () => {
    const { command, args } = new ClaudeAdapter().buildMessageCommand('explain auth.ts', null)
    expect(command).toBe(resolveClaudeBinary())
    expect(args).toContain('stream-json')
    expect(args).toContain('--verbose')
    expect(args).toContain('--permission-mode')
    expect(args).not.toContain('--resume')
    expect(args[args.length - 2]).toBe('-p')
    expect(args[args.length - 1]).toBe('explain auth.ts')
  })

  it('adds --resume for multi-turn', () => {
    const { args } = new ClaudeAdapter().buildMessageCommand('continue', 'sess_xyz')
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('sess_xyz')
  })

  it('adds --model when a model is selected', () => {
    const { args } = new ClaudeAdapter().buildMessageCommand('hi', null, undefined, 'opus')
    expect(args[args.indexOf('--model') + 1]).toBe('opus')
  })

  it('omits --model when no model is selected', () => {
    const { args } = new ClaudeAdapter().buildMessageCommand('hi', null)
    expect(args).not.toContain('--model')
  })

  it('honors CLAUDE_PERMISSION_MODE and CLAUDE_EXTRA_ARGS', () => {
    process.env['CLAUDE_PERMISSION_MODE'] = 'plan'
    process.env['CLAUDE_EXTRA_ARGS'] = '--dangerously-skip-permissions'
    const { args } = new ClaudeAdapter().buildMessageCommand('hi', null)
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(args).toContain('--dangerously-skip-permissions')
  })

  it('inlines attachments into the prompt with @paths', () => {
    const { args } = new ClaudeAdapter().buildMessageCommand('look at these', null, [
      { path: '/a/b.ts', mimeType: 'text/x-typescript' },
    ])
    expect(args[args.length - 1]).toBe('@/a/b.ts look at these')
  })
})
