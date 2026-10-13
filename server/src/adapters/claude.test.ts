import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { translateStreamJsonLine } from './claude-stream-json.js'
import { join } from 'path'
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

  it('grants each attachment folder once via --add-dir, before the prompt', () => {
    const { args } = new ClaudeAdapter().buildMessageCommand('look', null, [
      { path: join('/data', 'uploads', 'a.png'), mimeType: 'image/png' },
      { path: join('/data', 'uploads', 'b.jpg'), mimeType: 'image/jpeg' },
    ])
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(1)
    expect(args[args.indexOf('--add-dir') + 1]).toBe(join('/data', 'uploads'))
    expect(args.indexOf('--add-dir')).toBeLessThan(args.indexOf('-p'))
    expect(args[args.length - 1]).toContain(`@${join('/data', 'uploads', 'a.png')}`)
  })

  it('gives the agent the CodePipe MCP server inline, pre-approved, before the prompt', () => {
    const server = { name: 'codepipe', command: 'node', args: ['/x/codepipe-mcp.mjs'], env: { CODEPIPE_SESSION_ID: 's1' } }
    const { args } = new ClaudeAdapter().buildMessageCommand('hi', null, undefined, null, [server])
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    expect(config.mcpServers.codepipe).toEqual({ type: 'stdio', command: 'node', args: ['/x/codepipe-mcp.mjs'], env: { CODEPIPE_SESSION_ID: 's1' } })
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__codepipe')
    // Both flags are variadic: another option must follow before the prompt.
    expect(args[args.indexOf('--allowedTools') + 2]).toMatch(/^--/)
    expect(args[args.length - 1]).toBe('hi')
  })

  it('adds no MCP flags without servers', () => {
    const { args } = new ClaudeAdapter().buildMessageCommand('hi', null, undefined, null, [])
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--allowedTools')
  })

  it('omits --model when no model is selected', () => {
    const { args } = new ClaudeAdapter().buildMessageCommand('hi', null)
    expect(args).not.toContain('--model')
  })

  it('defaults to acceptEdits with no extra flags', () => {
    const { args } = new ClaudeAdapter().buildMessageCommand('hi', null)
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--disallowedTools')
  })

  it('honors CLAUDE_PERMISSION_MODE and CLAUDE_EXTRA_ARGS as fallbacks', () => {
    process.env['CLAUDE_PERMISSION_MODE'] = 'plan'
    process.env['CLAUDE_EXTRA_ARGS'] = '--dangerously-skip-permissions'
    const { args } = new ClaudeAdapter().buildMessageCommand('hi', null)
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(args).toContain('--dangerously-skip-permissions')
  })

  it('launch settings override the env fallbacks', () => {
    process.env['CLAUDE_PERMISSION_MODE'] = 'plan'
    const { args } = new ClaudeAdapter().buildMessageCommand('hi', null, undefined, null, [], {
      permissionMode: 'bypassPermissions',
      skipPermissions: true,
      disallowedTools: ['WebSearch', 'Bash(rm:*)'],
      appendSystemPrompt: 'Always answer in Spanish.',
      extraArgs: ['--max-turns', '3'],
    })
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    expect(args).toContain('--dangerously-skip-permissions')
    const d = args.indexOf('--disallowedTools')
    expect(args.slice(d + 1, d + 3)).toEqual(['WebSearch', 'Bash(rm:*)'])
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('Always answer in Spanish.')
    expect(args[args.indexOf('--max-turns') + 1]).toBe('3')
    expect(args.slice(-2)).toEqual(['-p', 'hi'])
  })

  it('merges the allowed tools from settings with the MCP tools on one flag', () => {
    const server = { name: 'codepipe', command: 'node', args: ['/x.mjs'], env: {} }
    const { args } = new ClaudeAdapter().buildMessageCommand('hi', null, undefined, null, [server], {
      allowedTools: ['Bash(git:*)', 'Read'],
    })
    expect(args.filter((a) => a === '--allowedTools')).toHaveLength(1)
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__codepipe,Bash(git:*),Read')
    // Variadic: an option must follow before the prompt.
    expect(args[args.indexOf('--allowedTools') + 2]).toMatch(/^--/)
  })

  it('allows the configured tools even without MCP servers', () => {
    const { args } = new ClaudeAdapter().buildMessageCommand('hi', null, undefined, null, [], { allowedTools: ['Read'] })
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read')
    expect(args).not.toContain('--mcp-config')
  })

  it('inlines attachments into the prompt with @paths', () => {
    const { args } = new ClaudeAdapter().buildMessageCommand('look at these', null, [
      { path: '/a/b.ts', mimeType: 'text/x-typescript' },
    ])
    expect(args[args.length - 1]).toBe('@/a/b.ts look at these')
  })
})
