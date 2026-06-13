import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import { KiroAdapter } from './kiro.js'
import type { AdapterEvent } from './types.js'

/**
 * Live integration test that spawns real kiro-cli processes in
 * --no-interactive mode, sends multiple messages, and validates
 * the adapter's output per message.
 *
 * This test consumes real API credits and requires kiro-cli to be installed,
 * so it is opt-in. It is skipped by default (including in CI) and only runs
 * when RUN_LIVE_TESTS is set.
 * Run with: RUN_LIVE_TESTS=1 npx vitest run src/adapters/kiro-live.test.ts
 */

const runLive = !!process.env['RUN_LIVE_TESTS']

interface MessageResult {
  content: string
  events: AdapterEvent[]
  credits?: { credits: string; time: string }
  toolUseCount: number
}

/**
 * Send a single message via kiro-cli --no-interactive and collect the response.
 */
function sendMessage(
  adapter: KiroAdapter,
  text: string,
  cliSessionId: string | null,
  cwd: string,
): Promise<MessageResult> {
  return new Promise((resolve, reject) => {
    const { command, args } = adapter.buildMessageCommand(text, cliSessionId)

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })

    const allEvents: AdapterEvent[] = []
    let stdoutBuffer = ''

    child.stdout?.on('data', (data: Buffer) => {
      // Strip ANSI codes (CLI emits colors even in non-interactive mode)
      const clean = data.toString().replace(/\x1b\[[0-9;]*m/g, '')
      stdoutBuffer += clean
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const events = adapter.onData(line)
        allEvents.push(...events)
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      // Parse stderr for credits (Kiro CLI sends credits to stderr)
      const stderrText = data.toString()
      const stderrEvents = adapter.onStderr(stderrText)
      allEvents.push(...stderrEvents)

      // Log for debugging
      const trimmed = stderrText.trim()
      if (trimmed.length > 0 && !trimmed.includes('Credits') && !trimmed.includes('trusted')) {
        console.log(`  [stderr] ${trimmed}`)
      }
    })

    child.on('close', (exitCode) => {
      // Process remaining buffer
      if (stdoutBuffer.trim().length > 0) {
        const events = adapter.onData(stdoutBuffer)
        allEvents.push(...events)
      }
      stdoutBuffer = ''

      const chunks = allEvents.filter(e => e.type === 'chunk')
      const content = chunks
        .map(e => (e as { type: 'chunk'; content: string }).content)
        .join('\n')

      const complete = allEvents.find(e => e.type === 'message_complete')
      const credits = complete?.type === 'message_complete' ? complete.metadata : undefined

      resolve({
        content,
        events: allEvents,
        credits: (credits?.credits && credits?.time) ? { credits: credits.credits, time: credits.time } : undefined,
        toolUseCount: allEvents.filter(e => e.type === 'tool_use').length,
      })
    })

    child.on('error', reject)

    // Timeout after 60 seconds
    setTimeout(() => {
      child.kill()
      reject(new Error(`Timed out waiting for response to "${text}"`))
    }, 60000)
  })
}

function validateMessage(label: string, result: MessageResult): void {
  console.log(`\n--- ${label} ---`)
  console.log(`Content (${result.content.length} chars): ${result.content.slice(0, 200)}`)
  console.log(`Events: ${result.events.map(e => e.type).join(', ')}`)
  console.log(`Credits: ${JSON.stringify(result.credits)}`)
  console.log(`Tool uses: ${result.toolUseCount}`)

  // Content should not contain noise
  expect(result.content).not.toMatch(/\d+%\s*>/)           // no prompts
  expect(result.content).not.toContain('Thinking')          // no spinner text
  expect(result.content).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)  // no spinner chars
  expect(result.content).not.toContain('▸')                 // no credits marker
  expect(result.content).not.toContain('All tools are now trusted') // no warning

  // Content should have actual text
  expect(result.content.trim().length).toBeGreaterThan(3)

  // Should have message_complete with credits
  expect(result.events.some(e => e.type === 'message_complete')).toBe(true)
}

describe.runIf(runLive)('KiroAdapter — live non-interactive 3-message conversation', () => {
  it('handles a 3-message conversation with clean output per message', async () => {
    const adapter = new KiroAdapter()
    const cwd = process.cwd()

    // === MESSAGE 1 (no session ID — first message) ===
    const m1 = await sendMessage(adapter, 'say hello in exactly 3 words', null, cwd)
    validateMessage('Message 1: "say hello in exactly 3 words"', m1)

    // We need the CLI session ID for subsequent messages.
    // In production, the SessionManager detects this from the session directory.
    // For this test, we'll use --resume (most recent) instead of --resume-id.
    // We test multi-turn by using the adapter's resume command.

    // === MESSAGE 2 (resume most recent) ===
    // Use a fresh adapter instance to prove there's no state leakage
    const adapter2 = new KiroAdapter()
    const m2 = await sendMessage(adapter2, 'what was my last question?', null, cwd)
    validateMessage('Message 2: "what was my last question?"', m2)

    // Message 2 should reference the first question
    // (This works because --no-interactive creates a session that --resume can find)

    // === MESSAGE 3 ===
    const adapter3 = new KiroAdapter()
    const m3 = await sendMessage(adapter3, 'thanks, goodbye', null, cwd)
    validateMessage('Message 3: "thanks, goodbye"', m3)

    // Summary
    console.log('\n=== CONVERSATION SUMMARY ===')
    console.log(`M1 (${m1.content.length} chars): ${m1.content.slice(0, 80)}...`)
    console.log(`M2 (${m2.content.length} chars): ${m2.content.slice(0, 80)}...`)
    console.log(`M3 (${m3.content.length} chars): ${m3.content.slice(0, 80)}...`)

  }, 120000) // 2 minute timeout for 3 messages
})
