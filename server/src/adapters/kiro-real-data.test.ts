import { describe, it, expect, beforeEach } from 'vitest'
import { KiroAdapter } from './kiro.js'
import { stripAnsi } from './strip-ansi.js'

/** Simulate CLI startup by sending a prompt pattern. */
function simulateStartup(adapter: KiroAdapter): void {
  adapter.onData('1% > Ready')
}

/**
 * Tests using REAL data captured from the Kiro CLI logs.
 * These reproduce the exact chunks the adapter receives in production.
 */

describe('KiroAdapter — real CLI data: "hi" conversation', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  // Simulate the exact sequence from the logs when user sends "hi"
  it('handles the full "hi" conversation flow correctly', () => {
    // --- Startup: all ignored ---
    adapter.onData('⠀⠀⠀⠀⠀⠀⠀\n⠀⠀⠀⠀⠀⠀⠀     ⢀⣴⣶⣶⣦⡀')  // braille logo
    adapter.onData('╭─── Did you know? ───╮\n│ some tip │')  // tip box
    adapter.onData('Model: auto (/model to change) | Plan: KIRO PRO+\n1% > Ask me anything!')  // prompt

    // --- User sends "hi" (CLI is now ready because prompt was seen above) ---
    adapter.notifyUserInput('hi')

    // Chunk 1: echo + spinner combined (this is the problematic chunk)
    const e1 = adapter.onData('1% > hi⠋ Thinking...')
    expect(e1.length).toBeLessThanOrEqual(1)  // either empty or just thinking
    const e1Types = e1.map(e => e.type)
    expect(e1Types).not.toContain('chunk')  // NO content should leak
    // Thinking event is OK
    if (e1.length > 0) {
      expect(e1[0].type).toBe('thinking')
    }

    // Chunk 2-N: pure spinner updates (may emit thinking events, that's fine)
    const s1 = adapter.onData('⠙ Thinking...')
    expect(s1.filter(e => e.type === 'chunk')).toHaveLength(0)  // no content chunks
    const s2 = adapter.onData('⠹ Thinking...')
    expect(s2.filter(e => e.type === 'chunk')).toHaveLength(0)
    const s3 = adapter.onData('⠸ Thinking...')
    expect(s3.filter(e => e.type === 'chunk')).toHaveLength(0)
    // Chunk: spinner char arrives alone (split chunk)
    const eLone = adapter.onData('⠴ ')
    expect(eLone.filter(e => e.type === 'chunk')).toHaveLength(0)

    // Chunk: "Thinking..." arrives alone (other half of split)
    const eThink = adapter.onData('Thinking...')
    expect(eThink.filter(e => e.type === 'chunk')).toHaveLength(0)

    // More spinners
    const s4 = adapter.onData('⠦ Thinking...')
    expect(s4.filter(e => e.type === 'chunk')).toHaveLength(0)

    // --- Response starts ---
    const r1 = adapter.onData('> Hey! I ')
    expect(r1.length).toBe(1)
    expect(r1[0].type).toBe('chunk')
    if (r1[0].type === 'chunk') {
      expect(r1[0].content).toContain('Hey! I')
      expect(r1[0].content).not.toContain('>')  // leading > should be stripped
    }

    // Response continues in fragments (preserve spacing!)
    const r2 = adapter.onData("see you'")
    expect(r2[0].type).toBe('chunk')
    if (r2[0].type === 'chunk') {
      expect(r2[0].content).toBe("see you'")
    }

    const r3 = adapter.onData('re working on ')
    expect(r3[0].type).toBe('chunk')
    if (r3[0].type === 'chunk') {
      expect(r3[0].content).toBe('re working on ')  // trailing space preserved!
    }

    const r4 = adapter.onData('CodePipe —')
    expect(r4[0].type).toBe('chunk')

    const r5 = adapter.onData('the ')
    expect(r5[0].type).toBe('chunk')
    if (r5[0].type === 'chunk') {
      expect(r5[0].content).toBe('the ')  // trailing space preserved!
    }

    const r6 = adapter.onData('chat-style ')
    expect(r6[0].type).toBe('chunk')

    const r7 = adapter.onData('wrapper for AI CLI tools. ')
    expect(r7[0].type).toBe('chunk')

    const r8 = adapter.onData('What ')
    expect(r8[0].type).toBe('chunk')

    // --- Credits + prompt in one chunk ---
    const rEnd = adapter.onData('can I help you with?\n\n ▸ Credits: 0.05 • Time: 3s\n\n2% > ')
    const endTypes = rEnd.map(e => e.type)
    expect(endTypes).toContain('chunk')  // "can I help you with?" content
    expect(endTypes).toContain('message_complete')
    expect(endTypes).toContain('prompt_detected')

    // Check credits metadata
    const complete = rEnd.find(e => e.type === 'message_complete')
    if (complete && complete.type === 'message_complete' && complete.metadata) {
      expect(complete.metadata.credits).toBe('0.05')
      expect(complete.metadata.time).toBe('3s')
    }

    // Check the chunk content doesn't include credits or prompt
    const lastChunk = rEnd.find(e => e.type === 'chunk')
    if (lastChunk && lastChunk.type === 'chunk') {
      expect(lastChunk.content).not.toContain('Credits')
      expect(lastChunk.content).not.toContain('2% >')
      expect(lastChunk.content).toContain('can I help you with?')
    }
  })

  it('does not echo user input in the second message', () => {
    // The startup prompt was already seen in the real flow
    simulateStartup(adapter)

    // First conversation
    adapter.notifyUserInput('hi')
    adapter.onData('> Hey!\n2% > ')

    // Second message
    adapter.notifyUserInput('I am having issues with the response handling process.')

    // Echo arrives
    const echoEvents = adapter.onData('I am having issues with the response handling process.')
    expect(echoEvents.filter(e => e.type === 'chunk')).toHaveLength(0)

    // Response starts
    const response = adapter.onData('> Let me take a look at the current state')
    expect(response.length).toBe(1)
    expect(response[0].type).toBe('chunk')
    if (response[0].type === 'chunk') {
      expect(response[0].content).not.toContain('I am having issues')
      expect(response[0].content).toContain('Let me take a look')
    }
  })

  it('handles echo with prompt prefix', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('hello')

    // CLI echoes with prompt prefix: "1% > hello"
    const events = adapter.onData('1% > hello')
    expect(events.filter(e => e.type === 'chunk')).toHaveLength(0)
  })

  it('handles echo + spinner in one chunk', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('hello')

    // This is the exact format from the real CLI
    const events = adapter.onData('1% > hello⠋ Thinking...')
    // Should NOT produce a chunk with "hello" in it
    const chunks = events.filter(e => e.type === 'chunk')
    expect(chunks).toHaveLength(0)
  })

  it('preserves spaces between word fragments', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('test')

    // Simulate word-by-word streaming
    adapter.onData('> Hello ')
    const e2 = adapter.onData('world ')
    const e3 = adapter.onData('how ')
    const e4 = adapter.onData('are you?')

    // Each chunk should preserve its spacing
    if (e2[0]?.type === 'chunk') expect(e2[0].content).toBe('world ')
    if (e3[0]?.type === 'chunk') expect(e3[0].content).toBe('how ')
    if (e4[0]?.type === 'chunk') expect(e4[0].content).toBe('are you?')
  })

  it('credits time field does not capture prompt percentage', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('test')
    adapter.onData('> Response text')

    // Credits line with prompt on next line
    const events = adapter.onData('▸ Credits: 0.05 • Time: 3s\n\n2% > ')
    const complete = events.find(e => e.type === 'message_complete')
    if (complete?.type === 'message_complete' && complete.metadata) {
      expect(complete.metadata.time).toBe('3s')
      expect(complete.metadata.time).not.toContain('2%')
    }
  })
})

describe('KiroAdapter — message immutability', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('second message does not append to first message (handleInput finalizes)', () => {
    simulateStartup(adapter)

    // First conversation
    adapter.notifyUserInput('first')
    const r1 = adapter.onData('> First response\n2% > ')
    expect(r1.map(e => e.type)).toContain('message_complete')

    // After message_complete, adapter should be in idle state
    // Second message
    adapter.notifyUserInput('second')
    const r2 = adapter.onData('> Second response\n3% > ')
    
    // The second response should be a new chunk, not appended to the first
    const chunks = r2.filter(e => e.type === 'chunk')
    expect(chunks.length).toBe(1)
    if (chunks[0].type === 'chunk') {
      expect(chunks[0].content).toContain('Second response')
      expect(chunks[0].content).not.toContain('First response')
    }
  })
})

describe('extractContent — noise removal', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('removes prompt patterns from content', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('test')
    const events = adapter.onData('1% > some text here')
    // "1% > " and "test" should be removed, "some text here" should remain
    // But "some text here" is not the echo, so it should be a chunk
    const chunks = events.filter(e => e.type === 'chunk')
    if (chunks.length > 0 && chunks[0].type === 'chunk') {
      expect(chunks[0].content).not.toMatch(/^\d+%\s*>/)
    }
  })

  it('removes spinner characters from mixed content', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('test')
    // Spinner mixed with actual content
    const events = adapter.onData('⠋ Thinking...> Hello!')
    const chunks = events.filter(e => e.type === 'chunk')
    if (chunks.length > 0 && chunks[0].type === 'chunk') {
      expect(chunks[0].content).not.toContain('⠋')
      expect(chunks[0].content).not.toContain('Thinking')
      expect(chunks[0].content).toContain('Hello!')
    }
  })

  it('handles credits line mixed with content and prompt', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('test')
    adapter.onData('> Some response')

    const events = adapter.onData('\n\n▸ Credits: 0.03 • Time: 2s\n\n2% > ')
    const types = events.map(e => e.type)
    expect(types).toContain('message_complete')
    expect(types).toContain('prompt_detected')
    
    // Any chunk emitted should not contain credits text
    const chunks = events.filter(e => e.type === 'chunk')
    for (const chunk of chunks) {
      if (chunk.type === 'chunk') {
        expect(chunk.content).not.toContain('Credits')
        expect(chunk.content).not.toContain('2% >')
      }
    }
  })
})
