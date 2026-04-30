import { describe, it, expect } from 'vitest'
import * as pty from 'node-pty'
import { KiroAdapter } from './kiro.js'
import { stripAnsi } from './strip-ansi.js'
import type { AdapterEvent } from './types.js'

/**
 * Live integration test that spawns a real kiro-cli process,
 * sends multiple messages, and validates the adapter's output per message.
 *
 * This test consumes real API credits — run it intentionally.
 * Run with: npx vitest run src/adapters/kiro-live.test.ts
 */

function waitFor(
  condition: () => boolean,
  timeout = 30000,
  interval = 100,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (condition()) return resolve()
      if (Date.now() - start > timeout) return reject(new Error('Timed out'))
      setTimeout(check, interval)
    }
    check()
  })
}

interface MessageResult {
  content: string
  events: AdapterEvent[]
  credits?: { credits: string; time: string }
  thinkingCount: number
}

function validateMessage(label: string, result: MessageResult, userInput: string): void {
  console.log(`\n--- ${label} ---`)
  console.log(`Content: ${JSON.stringify(result.content).slice(0, 300)}`)
  console.log(`Events: ${result.events.map(e => e.type).join(', ')}`)
  console.log(`Credits: ${JSON.stringify(result.credits)}`)
  console.log(`Thinking events: ${result.thinkingCount}`)

  // Content should not contain noise
  expect(result.content).not.toMatch(/\d+%\s*>/)           // no prompts
  expect(result.content).not.toContain('Thinking')          // no spinner text
  expect(result.content).not.toContain('Credits')           // no credits
  expect(result.content).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)  // no spinner chars
  expect(result.content).not.toContain('▸')                 // no credits marker

  // Content should have actual text
  expect(result.content.trim().length).toBeGreaterThan(5)

  // Echoed user input should not be at the start
  if (userInput.length <= 20) {
    // For short inputs, check they don't appear as standalone at the start
    expect(result.content.trimStart()).not.toMatch(new RegExp(`^${userInput.trim()}[^a-zA-Z]`))
  }

  // Should have message_complete and prompt_detected
  const types = result.events.map(e => e.type)
  expect(types).toContain('message_complete')
  expect(types).toContain('prompt_detected')
}

describe('KiroAdapter — live 3-message conversation', () => {
  it('handles a 3-message conversation with clean output per message', async () => {
    const adapter = new KiroAdapter()
    let currentEvents: AdapterEvent[] = []
    let promptDetected = false
    const rawChunks: string[] = []

    const proc = pty.spawn(adapter.command, adapter.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
    })

    proc.onData((data: string) => {
      rawChunks.push(data)
      const clean = stripAnsi(data)
      if (clean.trim().length === 0) return
      const events = adapter.onData(clean)
      currentEvents.push(...events)
      if (events.some(e => e.type === 'prompt_detected')) {
        promptDetected = true
      }
    })

    // Wait for CLI to start
    await waitFor(() => rawChunks.length > 0, 10000)
    await new Promise(resolve => setTimeout(resolve, 5000))

    /** Send a message and collect the response. */
    async function sendMessage(text: string, debug = false): Promise<MessageResult> {
      // Reset per-message tracking
      currentEvents = []
      promptDetected = false

      // Send
      adapter.notifyUserInput(text)
      proc.write(text + '\r')

      // Wait for response
      try {
        await waitFor(() => promptDetected, 60000)
      } catch {
        console.log(`\n=== TIMEOUT for "${text}" ===`)
        console.log(`Events so far: ${currentEvents.length}`)
        console.log(`Last events: ${currentEvents.slice(-5).map(e => `${e.type}`).join(', ')}`)
        throw new Error(`Timed out waiting for response to "${text}"`)
      }

      // Reconstruct message
      const chunks = currentEvents.filter(e => e.type === 'chunk')
      const content = chunks
        .map(e => (e as { type: 'chunk'; content: string }).content)
        .join('')

      const complete = currentEvents.find(e => e.type === 'message_complete')
      const credits = complete?.type === 'message_complete' ? complete.metadata : undefined

      return {
        content,
        events: [...currentEvents],
        credits: credits ?? undefined,
        thinkingCount: currentEvents.filter(e => e.type === 'thinking').length,
      }
    }

    // === MESSAGE 1 ===
    const m1 = await sendMessage('hi')
    validateMessage('Message 1: "hi"', m1, 'hi')

    // === MESSAGE 2 ===
    // Debug: log first chunks to see what arrives
    let m2ChunkCount = 0
    const origOnData = proc.onData
    const m2DebugChunks: string[] = []
    
    const m2 = await sendMessage('what is this project about?')
    validateMessage('Message 2: "what is this project about?"', m2, 'what is this project about?')
    
    // Log the first few chunk events for debugging
    const m2Chunks = m2.events.filter(e => e.type === 'chunk').slice(0, 5)
    console.log('\nMessage 2 — first 5 chunks:')
    for (const chunk of m2Chunks) {
      if (chunk.type === 'chunk') {
        console.log(`  ${JSON.stringify(chunk.content).slice(0, 150)}`)
      }
    }

    // Message 2 should NOT contain message 1's content
    expect(m2.content).not.toContain(m1.content.slice(0, 20))

    // === MESSAGE 3 ===
    const m3 = await sendMessage('thanks, that helps')
    validateMessage('Message 3: "thanks, that helps"', m3, 'thanks, that helps')

    // Message 3 should NOT contain message 2's content
    expect(m3.content).not.toContain(m2.content.slice(0, 20))

    // Kill the process
    proc.kill()

    // Summary
    console.log('\n=== CONVERSATION SUMMARY ===')
    console.log(`M1 (${m1.content.length} chars): ${m1.content.slice(0, 80)}...`)
    console.log(`M2 (${m2.content.length} chars): ${m2.content.slice(0, 80)}...`)
    console.log(`M3 (${m3.content.length} chars): ${m3.content.slice(0, 80)}...`)

  }, 120000) // 2 minute timeout for 3 messages
})
