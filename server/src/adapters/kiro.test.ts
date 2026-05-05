import { describe, it, expect, beforeEach } from 'vitest'
import { KiroAdapter } from './kiro.js'
import { stripAnsi } from './strip-ansi.js'
import { registerAdapter, getAdapter, clearAdapters } from './registry.js'

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe('stripAnsi', () => {
  it('strips CSI sequences', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m').trim()).toBe('green')
    expect(stripAnsi('\x1b[1;34mbold blue\x1b[0m').trim()).toBe('bold blue')
  })

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;My Title\x07some text').trim()).toBe('some text')
  })

  it('strips carriage returns', () => {
    expect(stripAnsi('hello\r\nworld')).toBe('hello\nworld')
  })

  it('passes through plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('strips orphaned SGR fragments like "5;252m"', () => {
    const result = stripAnsi('5;252mLet me take a look')
    expect(result).not.toContain('5;252m')
    expect(result.trim()).toContain('Let me take a look')
  })

  it('does not strip normal text that looks like ANSI fragments', () => {
    expect(stripAnsi('the 100m sprint was fast')).toContain('100m')
  })
})

// ---------------------------------------------------------------------------
// KiroAdapter — properties
// ---------------------------------------------------------------------------

describe('KiroAdapter — properties', () => {
  it('has correct provider, command, and args', () => {
    const adapter = new KiroAdapter()
    expect(adapter.provider).toBe('kiro')
    expect(adapter.command).toBe('kiro-cli.exe')
    expect(adapter.args).toContain('--no-interactive')
    expect(adapter.args).toContain('--trust-all-tools')
    expect(adapter.args).toContain('--wrap')
  })

  it('is non-interactive', () => {
    expect(new KiroAdapter().nonInteractive).toBe(true)
  })

  it('has no system prompt', () => {
    expect(new KiroAdapter().systemPrompt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// KiroAdapter — onData parsing
// ---------------------------------------------------------------------------

describe('KiroAdapter — onData', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('parses assistant text as chunk', () => {
    const events = adapter.onData('Hello! How can I help?')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'chunk', content: 'Hello! How can I help?', role: 'assistant' })
  })

  it('strips "> " response marker', () => {
    const events = adapter.onData('> Hello!')
    expect(events[0]).toMatchObject({ type: 'chunk', content: 'Hello!' })
  })

  it('parses credits as message_complete with metadata', () => {
    const events = adapter.onData(' ▸ Credits: 0.05 • Time: 3s')
    expect(events[0]).toMatchObject({ type: 'message_complete', metadata: { credits: '0.05', time: '3s' } })
  })

  it('parses alternative credits format', () => {
    const events = adapter.onData('Est. Credits Used: 4.75 Elapsed time: 1m')
    expect(events[0]).toMatchObject({ type: 'message_complete', metadata: { credits: '4.75', time: '1m' } })
  })

  it('classifies tool invocations as tool_use', () => {
    const events = adapter.onData('Reading file: src/App.vue (using tool: read)')
    expect(events[0]).toMatchObject({ type: 'tool_use', tool: 'read' })
  })

  it('classifies tool success as tool_use', () => {
    const events = adapter.onData('✓ Successfully read 1000 bytes')
    expect(events[0].type).toBe('tool_use')
  })

  it('classifies tool completion as tool_use', () => {
    const events = adapter.onData('- Completed in 0.5s')
    expect(events[0].type).toBe('tool_use')
  })

  it('classifies "Tool validation failed" as tool_use', () => {
    const events = adapter.onData('Tool validation failed: file not found')
    expect(events[0].type).toBe('tool_use')
  })

  it('classifies file modification announcements as tool_use', () => {
    const events = adapter.onData("I'll modify the following file: src/App.vue (using tool: write)")
    expect(events[0]).toMatchObject({ type: 'tool_use', tool: 'write' })
  })

  it('classifies diff-style output as tool_use', () => {
    const events = adapter.onData('-  1    : <script setup lang="ts">')
    expect(events[0].type).toBe('tool_use')
  })

  it('skips trust-all-tools warning lines', () => {
    const warnings = [
      'All tools are now trusted (!). Kiro will execute tools without asking for confirmation.',
      'Agents can sometimes do unexpected things so understand the risks.',
      'Learn more at',
      'https://kiro.dev/docs/cli/chat/security/#using-tools-trust-all-safely',
    ]
    for (const line of warnings) {
      expect(adapter.onData(line)).toHaveLength(0)
    }
  })

  it('skips empty lines', () => {
    expect(adapter.onData('')).toHaveLength(0)
    expect(adapter.onData('   ')).toHaveLength(0)
  })

  it('handles multi-line input with mixed content', () => {
    const text = [
      'Reading file: src/App.vue (using tool: read)',
      '✓ Successfully read 500 bytes',
      '',
      '> The file contains a Vue component.',
      '',
      ' ▸ Credits: 0.07 • Time: 4s',
    ].join('\n')

    const events = adapter.onData(text)
    const types = events.map(e => e.type)

    expect(types.filter(t => t === 'tool_use')).toHaveLength(2)
    expect(types.filter(t => t === 'chunk')).toHaveLength(1)
    expect(types).toContain('message_complete')
  })

  it('tracks tool names across invocations', () => {
    adapter.onData('Reading file: src/App.vue (using tool: read)')
    const events = adapter.onData('✓ Successfully read 500 bytes')
    if (events[0]?.type === 'tool_use') {
      expect(events[0].tool).toBe('read')
    }
  })
})

// ---------------------------------------------------------------------------
// KiroAdapter — onStderr
// ---------------------------------------------------------------------------

describe('KiroAdapter — onStderr', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('parses credits from stderr', () => {
    const events = adapter.onStderr(' ▸ Credits: 0.03 • Time: 2s\n')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'message_complete', metadata: { credits: '0.03', time: '2s' } })
  })

  it('ignores non-credits stderr content', () => {
    const events = adapter.onStderr('some warning text\n')
    expect(events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// KiroAdapter — buildMessageCommand
// ---------------------------------------------------------------------------

describe('KiroAdapter — buildMessageCommand', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('first message has no --resume-id', () => {
    const { command, args } = adapter.buildMessageCommand('hello', null)
    expect(command).toBe('kiro-cli.exe')
    expect(args).not.toContain('--resume-id')
    expect(args[args.length - 1]).toBe('hello')
  })

  it('subsequent messages include --resume-id', () => {
    const { args } = adapter.buildMessageCommand('follow up', 'abc-123')
    expect(args).toContain('--resume-id')
    expect(args).toContain('abc-123')
    expect(args[args.length - 1]).toBe('follow up')
  })

  it('always includes --trust-all-tools', () => {
    expect(adapter.buildMessageCommand('hi', null).args).toContain('--trust-all-tools')
    expect(adapter.buildMessageCommand('hi', 'x').args).toContain('--trust-all-tools')
  })

  it('prepends attachment references', () => {
    const { args } = adapter.buildMessageCommand('check this', null, [
      { path: '/tmp/img.png', mimeType: 'image/png' },
      { path: '/tmp/code.ts', mimeType: 'text/typescript' },
    ])
    const input = args[args.length - 1]
    expect(input).toContain('/tmp/img.png')
    expect(input).toContain('@/tmp/code.ts')
    expect(input).toContain('check this')
  })
})

// ---------------------------------------------------------------------------
// KiroAdapter — formatAttachment
// ---------------------------------------------------------------------------

describe('KiroAdapter — formatAttachment', () => {
  const adapter = new KiroAdapter()

  it('returns bare path for images', () => {
    expect(adapter.formatAttachment('/tmp/img.png', 'image/png')).toBe('/tmp/img.png')
  })

  it('returns @path for text files', () => {
    expect(adapter.formatAttachment('/tmp/code.ts', 'text/typescript')).toBe('@/tmp/code.ts')
  })
})

// ---------------------------------------------------------------------------
// KiroAdapter — getResumeCommand
// ---------------------------------------------------------------------------

describe('KiroAdapter — getResumeCommand', () => {
  const adapter = new KiroAdapter()

  it('returns command with --resume-id when session ID provided', () => {
    const result = adapter.getResumeCommand('abc-123')
    expect(result).not.toBeNull()
    expect(result!.args).toContain('--resume-id')
    expect(result!.args).toContain('abc-123')
  })

  it('returns null when no session ID', () => {
    expect(adapter.getResumeCommand(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

describe('Adapter registry', () => {
  beforeEach(() => clearAdapters())

  it('registerAdapter + getAdapter works', () => {
    registerAdapter('kiro', () => new KiroAdapter())
    const adapter = getAdapter('kiro')
    expect(adapter?.provider).toBe('kiro')
  })

  it('getAdapter for unregistered provider returns undefined', () => {
    expect(getAdapter('gemini')).toBeUndefined()
  })
})
