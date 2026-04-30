import { describe, it, expect, beforeEach } from 'vitest'
import fc from 'fast-check'
import { KiroAdapter } from './kiro.js'
import { stripAnsi } from './strip-ansi.js'
import { registerAdapter, getAdapter, clearAdapters } from './registry.js'

/** Simulate CLI startup by sending a prompt pattern. */
function simulateStartup(adapter: KiroAdapter): void {
  adapter.onData('1% > Ready')
}

// ---------------------------------------------------------------------------
// Unit tests — stripAnsi
// ---------------------------------------------------------------------------

describe('stripAnsi', () => {
  it('strips CSI sequences (SGR, cursor movement)', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m').trim()).toBe('green')
    expect(stripAnsi('\x1b[1;34mbold blue\x1b[0m').trim()).toBe('bold blue')
  })

  it('strips OSC sequences (window title)', () => {
    expect(stripAnsi('\x1b]0;My Title\x07some text').trim()).toBe('some text')
  })

  it('strips carriage returns', () => {
    expect(stripAnsi('hello\r\nworld')).toBe('hello\nworld')
  })

  it('strips charset and mode sequences', () => {
    expect(stripAnsi('\x1b(Bhello\x1b>world').trim()).toBe('helloworld')
  })

  it('passes through plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('replaces escape sequences with spaces to preserve word boundaries', () => {
    // When escape sequences sit between words, collapsing should leave a single space
    const input = 'word1\x1b[32m\x1b[0mword2'
    const result = stripAnsi(input).trim()
    // Words should be separated, not merged
    expect(result).toContain('word1')
    expect(result).toContain('word2')
  })

  it('collapses multiple spaces into one', () => {
    const input = 'hello\x1b[1m\x1b[2m\x1b[3mworld'
    const result = stripAnsi(input)
    // Should not have runs of multiple spaces
    expect(result).not.toMatch(/  +/)
  })
})

// ---------------------------------------------------------------------------
// Unit tests — KiroAdapter state machine
// ---------------------------------------------------------------------------

describe('KiroAdapter — basic behavior', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('has correct provider, command, and args', () => {
    expect(adapter.provider).toBe('kiro')
    expect(adapter.command).toBe('kiro-cli.exe')
    expect(adapter.args).toEqual(['chat', '--legacy-ui', '--wrap', 'never'])
  })

  it('has no system prompt (undefined)', () => {
    expect(adapter.systemPrompt).toBeUndefined()
  })

  it('ignores all output in waiting_for_first_input state', () => {
    // Before any prompt is seen, all output is startup noise
    const events = adapter.onData('Welcome to Kiro CLI!\nLoading...')
    expect(events).toEqual([])
  })

  it('ignores empty/whitespace input', () => {
    const events = adapter.onData('   \n  \n  ')
    expect(events).toEqual([])
  })
})

describe('KiroAdapter — state machine transitions', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('transitions from waiting_for_first_input → waiting_for_response on user input', () => {
    // Startup noise is ignored
    adapter.onData('Welcome to Kiro!')
    adapter.onData('Loading plugins...')

    // Simulate CLI becoming ready
    simulateStartup(adapter)

    // User sends first message
    adapter.notifyUserInput('hello')

    // Now CLI output should be captured (after skipping echo)
    const events = adapter.onData('Hi there! How can I help?')
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].type).toBe('chunk')
    if (events[0].type === 'chunk') {
      expect(events[0].content).toContain('Hi there')
      expect(events[0].role).toBe('assistant')
    }
  })

  it('skips echoed user input in waiting_for_response state', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('hello world')

    // CLI echoes back the user input first
    const echoEvents = adapter.onData('hello world')
    expect(echoEvents).toEqual([])

    // Then the actual response comes
    const responseEvents = adapter.onData('I can help with that!')
    expect(responseEvents.length).toBe(1)
    expect(responseEvents[0].type).toBe('chunk')
    if (responseEvents[0].type === 'chunk') {
      expect(responseEvents[0].content).toContain('I can help with that')
    }
  })

  it('detects prompt pattern and emits message_complete + prompt_detected', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('hello')

    // Response followed by prompt
    const events = adapter.onData('Here is my answer\n42% > ')
    // Should have: chunk (the answer), message_complete, prompt_detected
    const types = events.map(e => e.type)
    expect(types).toContain('chunk')
    expect(types).toContain('message_complete')
    expect(types).toContain('prompt_detected')
  })

  it('accumulates chunks in responding state', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('explain something')

    // First chunk of response
    const events1 = adapter.onData('First part of the answer')
    expect(events1.length).toBe(1)
    expect(events1[0].type).toBe('chunk')

    // Second chunk of response
    const events2 = adapter.onData(' and more details')
    expect(events2.length).toBe(1)
    expect(events2[0].type).toBe('chunk')
  })

  it('transitions to idle after prompt detected, ignores further output', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('hello')
    adapter.onData('Response text\n50% > ')

    // Now in idle state — output should be ignored
    const events = adapter.onData('some random output')
    expect(events).toEqual([])
  })

  it('handles full conversation cycle: input → response → prompt → input → response', () => {
    simulateStartup(adapter)

    // First message
    adapter.notifyUserInput('first question')
    const r1 = adapter.onData('First answer\n50% > ')
    expect(r1.map(e => e.type)).toContain('prompt_detected')

    // Second message
    adapter.notifyUserInput('second question')
    const r2 = adapter.onData('Second answer\n75% > ')
    expect(r2.map(e => e.type)).toContain('chunk')
    expect(r2.map(e => e.type)).toContain('prompt_detected')
  })

  it('reset() returns to waiting_for_first_input state', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('hello')
    adapter.onData('response\n50% > ')

    adapter.reset()

    // After reset, all output is ignored again (startup noise)
    const events = adapter.onData('Welcome back!')
    expect(events).toEqual([])

    // notifyUserInput should queue (cliReady is false after reset)
    adapter.notifyUserInput('queued message')
    // No response yet because CLI hasn't shown prompt
    const events2 = adapter.onData('some noise')
    expect(events2).toEqual([])

    // Once prompt arrives, queued input is processed
    adapter.onData('1% > ')
    const events3 = adapter.onData('Response to queued\n2% > ')
    expect(events3.map(e => e.type)).toContain('chunk')
  })

  it('queues user input when called before CLI is ready', () => {
    // Don't call simulateStartup — CLI not ready yet
    adapter.notifyUserInput('early message')

    // Output is still ignored (waiting_for_first_input, but input is queued)
    const events1 = adapter.onData('startup noise')
    expect(events1).toEqual([])

    // Prompt arrives — queued input is processed, transitions to waiting_for_response
    adapter.onData('1% > Ready')

    // Now the adapter is in waiting_for_response with the queued input
    const events2 = adapter.onData('Response to early message\n2% > ')
    expect(events2.map(e => e.type)).toContain('chunk')
    expect(events2.map(e => e.type)).toContain('prompt_detected')
  })
})

// ---------------------------------------------------------------------------
// System input tests
// ---------------------------------------------------------------------------

describe('KiroAdapter — system input (notifySystemInput)', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('silently consumes all output after notifySystemInput until prompt', () => {
    // CLI must be ready before system input so that subsequent user input works
    simulateStartup(adapter)

    adapter.notifySystemInput('Format responses in markdown')

    // CLI echoes the system prompt — should be silently consumed
    const echoEvents = adapter.onData('Format responses in markdown')
    expect(echoEvents).toEqual([])

    // CLI responds to the system prompt — should be silently consumed
    const responseEvents = adapter.onData('Understood, I will format in markdown.')
    expect(responseEvents).toEqual([])

    // CLI shows prompt again — should transition to idle, still no events
    const promptEvents = adapter.onData('50% > ')
    expect(promptEvents).toEqual([])

    // Now a real user input should work normally
    adapter.notifyUserInput('hello')
    const userEvents = adapter.onData('Hi there!\n60% > ')
    const types = userEvents.map(e => e.type)
    expect(types).toContain('chunk')
    expect(types).toContain('message_complete')
    expect(types).toContain('prompt_detected')
  })

  it('notifySystemInput from waiting_for_first_input consumes output silently', () => {
    // System input can be sent before CLI is ready (no startup needed)
    adapter.notifySystemInput('Format responses in markdown')

    // All output is silently consumed
    const echoEvents = adapter.onData('Format responses in markdown')
    expect(echoEvents).toEqual([])

    const responseEvents = adapter.onData('Understood.')
    expect(responseEvents).toEqual([])

    // Prompt transitions to idle
    const promptEvents = adapter.onData('50% > ')
    expect(promptEvents).toEqual([])
  })

  it('transitions from idle to consuming_system_response', () => {
    // Get to idle state first
    simulateStartup(adapter)
    adapter.notifyUserInput('hello')
    adapter.onData('Response\n50% > ')

    // Now send system input from idle
    adapter.notifySystemInput('system instruction')

    // All output should be consumed silently
    const events = adapter.onData('OK got it\n55% > ')
    expect(events).toEqual([])

    // Should be back in idle, ready for user input
    adapter.notifyUserInput('real question')
    const realEvents = adapter.onData('Real answer\n60% > ')
    expect(realEvents.map(e => e.type)).toContain('chunk')
  })
})

// ---------------------------------------------------------------------------
// Credits metadata tests
// ---------------------------------------------------------------------------

describe('KiroAdapter — credits metadata parsing', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('parses credits line and attaches metadata to message_complete', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('hello')

    // Response chunk
    adapter.onData('Here is my answer')

    // Credits line followed by prompt
    const events = adapter.onData('▸ Credits: 0.08 • Time: 7s\n50% > ')
    const complete = events.find(e => e.type === 'message_complete')
    expect(complete).toBeDefined()
    if (complete && complete.type === 'message_complete') {
      expect(complete.metadata).toBeDefined()
      expect(complete.metadata!.credits).toBe('0.08')
      expect(complete.metadata!.time).toBe('7s')
    }
  })

  it('parses alternative credits format', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('hello')

    // Response chunk
    adapter.onData('Here is my answer')

    // Alternative credits format followed by prompt
    const events = adapter.onData('Est. Credits Used: 4.75 Elapsed time: 1m\n50% > ')
    const complete = events.find(e => e.type === 'message_complete')
    expect(complete).toBeDefined()
    if (complete && complete.type === 'message_complete') {
      expect(complete.metadata).toBeDefined()
      expect(complete.metadata!.credits).toBe('4.75')
      expect(complete.metadata!.time).toBe('1m')
    }
  })

  it('emits message_complete without metadata when no credits line', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('hello')

    const events = adapter.onData('Simple answer\n50% > ')
    const complete = events.find(e => e.type === 'message_complete')
    expect(complete).toBeDefined()
    if (complete && complete.type === 'message_complete') {
      expect(complete.metadata).toBeUndefined()
    }
  })
})

describe('KiroAdapter — edge cases', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('handles prompt pattern with different percentages', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('test')

    const events1 = adapter.onData('Answer\n0% > ')
    expect(events1.map(e => e.type)).toContain('prompt_detected')
  })

  it('handles prompt-only output (no content before prompt)', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('test')
    // Skip echo
    adapter.onData('test')

    // Response then prompt in separate chunks
    adapter.onData('Some response')
    const events = adapter.onData('\n100% > ')
    expect(events.map(e => e.type)).toContain('prompt_detected')
  })

  it('does not false-positive on text containing percent signs', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('test')

    // "50% done" should NOT trigger prompt detection (no " > " at end)
    const events = adapter.onData('The task is 50% done')
    expect(events.map(e => e.type)).not.toContain('prompt_detected')
    expect(events[0].type).toBe('chunk')
  })
})

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('KiroAdapter — property-based tests', () => {
  it('onData always returns an array', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (content) => {
          const adapter = new KiroAdapter()
          const result = adapter.onData(content)
          expect(Array.isArray(result)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('in waiting_for_first_input state, onData always returns empty', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        (content) => {
          const adapter = new KiroAdapter()
          // Don't call simulateStartup — stays in waiting_for_first_input
          const result = adapter.onData(content)
          expect(result).toEqual([])
        },
      ),
      { numRuns: 100 },
    )
  })

  it('in consuming_system_response state, onData always returns empty', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        (content) => {
          const adapter = new KiroAdapter()
          // notifySystemInput works from waiting_for_first_input without startup
          adapter.notifySystemInput('system prompt')
          const result = adapter.onData(content)
          expect(result).toEqual([])
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('Adapter registry', () => {
  beforeEach(() => {
    clearAdapters()
  })

  it('registerAdapter + getAdapter returns correct adapter', () => {
    registerAdapter('kiro', () => new KiroAdapter())
    const adapter = getAdapter('kiro')
    expect(adapter).toBeDefined()
    expect(adapter!.provider).toBe('kiro')
    expect(adapter!.command).toBe('kiro-cli.exe')
  })

  it('getAdapter for unregistered provider returns undefined', () => {
    const adapter = getAdapter('gemini')
    expect(adapter).toBeUndefined()
  })
})
