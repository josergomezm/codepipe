import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'
import {
  PROMPT_PATTERN,
  INTERACTIVE_PROMPT,
  PERMISSION_PROMPT,
  TOOL_NAME_PATTERN,
  isOnlySpinner,
  parseCredits,
  extractToolName,
} from './kiro-patterns.js'
import { processChunk } from './kiro-pipeline.js'
import { homedir } from 'os'
import path from 'path'

// ── State machine ──────────────────────────────────────────────────────

type AdapterState =
  | 'waiting_for_first_input'
  | 'waiting_for_response'
  | 'responding'
  | 'idle'
  | 'consuming_system_response'

export class KiroAdapter implements ICLIAdapter {
  readonly provider: ProviderType = 'kiro'
  readonly command = 'kiro-cli.exe'
  readonly args: string[] = ['chat', '--legacy-ui', '--wrap', 'never']
  readonly systemPrompt: string | undefined = undefined
  readonly cliSessionDir: string = path.join(homedir(), '.kiro', 'sessions', 'cli')

  private state: AdapterState = 'waiting_for_first_input'
  private lastUserInput = ''
  private pendingCredits: { credits: string; time: string } | null = null
  private cliReady = false
  private queuedUserInput: string | null = null
  private echoConsumed = false
  private echoBuffer = ''
  private lastToolName = 'tool'
  private inToolSequence = false

  // ── Main entry point ─────────────────────────────────────────────────

  onData(cleanText: string): AdapterEvent[] {
    // Startup: ignore everything until first prompt
    if (this.state === 'waiting_for_first_input') {
      if (/\d+%\s*>/.test(cleanText)) {
        this.cliReady = true
        if (this.queuedUserInput) {
          this.lastUserInput = this.queuedUserInput
          this.queuedUserInput = null
          this.state = 'waiting_for_response'
        } else {
          this.state = 'idle'
        }
      }
      return []
    }

    if (this.state === 'idle') return []

    // System response: silently consume until next prompt
    if (this.state === 'consuming_system_response') {
      if (PROMPT_PATTERN.test(cleanText)) {
        this.state = 'idle'
      }
      return []
    }

    // ── Interactive prompts (checked before anything else) ──
    const interactiveEvents = this.checkInteractivePrompt(cleanText)
    if (interactiveEvents) return interactiveEvents

    // ── Standard processing ──
    const credits = parseCredits(cleanText)
    if (credits) this.pendingCredits = credits
    const hasPrompt = PROMPT_PATTERN.test(cleanText)

    // Pure spinner — emit thinking, nothing else
    if (isOnlySpinner(cleanText)) {
      if (this.state === 'waiting_for_response') {
        return [{ type: 'thinking', content: 'Thinking...' }]
      }
      return []
    }

    // Credits-only chunk with prompt (no real content)
    if (credits) {
      const { content } = processChunk(cleanText, '')
      if (content.trim().length === 0) {
        return this.maybeFinishOnPrompt(hasPrompt)
      }
    }

    // Echo buffering (waiting_for_response only)
    if (this.state === 'waiting_for_response' && !this.echoConsumed) {
      return this.bufferEcho(cleanText, hasPrompt)
    }

    // Normal content processing (waiting_for_response post-echo, or responding)
    if (this.state === 'waiting_for_response' || this.state === 'responding') {
      return this.processContent(cleanText, hasPrompt)
    }

    return []
  }

  // ── Interactive prompt handling ──────────────────────────────────────

  private checkInteractivePrompt(cleanText: string): AdapterEvent[] | null {
    const match = INTERACTIVE_PROMPT.exec(cleanText) || PERMISSION_PROMPT.exec(cleanText)
    if (!match) return null

    const events: AdapterEvent[] = []

    // Finalize any in-progress assistant message
    if (this.state === 'responding') {
      events.push({
        type: 'message_complete',
        role: 'assistant',
        ...(this.pendingCredits ? { metadata: this.pendingCredits } : {}),
      })
      this.pendingCredits = null
    }

    // Parse options
    const options = match[1].split(/[/|,]/).map(o => o.trim()).filter(Boolean)

    // Separate tool output from the prompt text
    const promptText = cleanText.slice(0, match.index).trim()
    const { content: displayContent, toolOutput } = processChunk(promptText || cleanText.trim(), '')

    if (toolOutput.trim().length > 0) {
      events.push({
        type: 'tool_use',
        tool: extractToolName(toolOutput, this.lastToolName),
        content: toolOutput.trim(),
      })
      const nameMatch = TOOL_NAME_PATTERN.exec(toolOutput)
      if (nameMatch) this.lastToolName = nameMatch[1]
    }

    events.push({
      type: 'interactive_prompt',
      content: displayContent.trim() || cleanText.trim(),
      options,
    })

    return events
  }

  // ── Echo buffering ──────────────────────────────────────────────────

  private bufferEcho(cleanText: string, hasPrompt: boolean): AdapterEvent[] {
    this.echoBuffer += cleanText
    const echo = this.lastUserInput.trim()

    // Still accumulating — not enough data to match the echo yet
    if (this.echoBuffer.length < echo.length && !hasPrompt) {
      if (isOnlySpinner(cleanText)) {
        return [{ type: 'thinking', content: 'Thinking...' }]
      }
      return []
    }

    // Echo consumed — process the buffered text
    this.echoConsumed = true
    const { content, toolOutput } = processChunk(this.echoBuffer, echo)
    this.echoBuffer = ''

    const events: AdapterEvent[] = []

    if (toolOutput.trim().length > 0) {
      const name = extractToolName(toolOutput, this.lastToolName)
      const nameMatch = TOOL_NAME_PATTERN.exec(toolOutput)
      if (nameMatch) this.lastToolName = nameMatch[1]
      events.push({ type: 'tool_use', tool: name, content: toolOutput.trim() })
    }

    if (content.trim().length > 0) {
      this.state = 'responding'
      this.inToolSequence = false
      events.push({ type: 'chunk', content, role: 'assistant' })
    }

    if (hasPrompt && this.state === 'responding') {
      events.push(...this.finishMessage())
    }

    return events
  }

  // ── Content processing (shared by post-echo and responding) ─────────

  private processContent(cleanText: string, hasPrompt: boolean): AdapterEvent[] {
    const { content, toolOutput } = processChunk(cleanText, '')
    const events: AdapterEvent[] = []

    // Tool output
    if (toolOutput.trim().length > 0) {
      const name = extractToolName(toolOutput, this.lastToolName)
      const nameMatch = TOOL_NAME_PATTERN.exec(toolOutput)
      if (nameMatch) this.lastToolName = nameMatch[1]

      // If we were streaming assistant text and now see pure tool output,
      // finalize the assistant message first
      if (this.state === 'responding' && !this.inToolSequence && content.trim().length === 0) {
        events.push({
          type: 'message_complete',
          role: 'assistant',
          ...(this.pendingCredits ? { metadata: this.pendingCredits } : {}),
        })
        this.pendingCredits = null
        this.inToolSequence = true
      }

      events.push({ type: 'tool_use', tool: name, content: toolOutput.trim() })
    }

    // Assistant content
    if (content.trim().length > 0) {
      if (this.inToolSequence) this.inToolSequence = false
      this.state = 'responding'
      events.push({ type: 'chunk', content, role: 'assistant' })
    }

    // Prompt detected — finalize
    if (hasPrompt && this.state === 'responding') {
      events.push(...this.finishMessage())
    }

    return events
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /** Emit message_complete + prompt_detected and transition to idle. */
  private finishMessage(): AdapterEvent[] {
    const events: AdapterEvent[] = [
      {
        type: 'message_complete',
        role: 'assistant',
        ...(this.pendingCredits ? { metadata: this.pendingCredits } : {}),
      },
      { type: 'prompt_detected' },
    ]
    this.pendingCredits = null
    this.state = 'idle'
    this.inToolSequence = false
    return events
  }

  /** If we're responding and see a prompt, finish the message. */
  private maybeFinishOnPrompt(hasPrompt: boolean): AdapterEvent[] {
    if (hasPrompt && this.state === 'responding') {
      return this.finishMessage()
    }
    return []
  }

  // ── External notifications ───────────────────────────────────────────

  notifyUserInput(text: string): void {
    this.pendingCredits = null
    this.echoConsumed = false
    this.echoBuffer = ''
    this.inToolSequence = false
    if (!this.cliReady) {
      this.queuedUserInput = text
      return
    }
    this.lastUserInput = text
    if (this.state === 'idle' || this.state === 'responding') {
      this.state = 'waiting_for_response'
    }
  }

  notifySystemInput(text: string): void {
    this.lastUserInput = text
    this.pendingCredits = null
    this.inToolSequence = false
    if (this.state === 'waiting_for_first_input' || this.state === 'idle') {
      this.state = 'consuming_system_response'
    }
  }

  reset(): void {
    this.state = 'waiting_for_first_input'
    this.lastUserInput = ''
    this.pendingCredits = null
    this.cliReady = false
    this.queuedUserInput = null
    this.echoConsumed = false
    this.echoBuffer = ''
    this.lastToolName = 'tool'
    this.inToolSequence = false
  }

  formatAttachment(filePath: string, mimeType: string): string {
    // Kiro CLI: images are referenced by bare path, text files use @path syntax
    if (mimeType.startsWith('image/')) {
      return filePath
    }
    // Text files / documents — use @path syntax for inline expansion
    return `@${filePath}`
  }

  getResumeCommand(cliSessionId: string | null): { command: string; args: string[] } | null {
    if (cliSessionId) {
      // Precise resume using the CLI's own session ID
      return {
        command: this.command,
        args: ['chat', '--legacy-ui', '--wrap', 'never', '--resume-id', cliSessionId],
      }
    }
    // Fallback: resume the most recent conversation in the working directory
    return {
      command: this.command,
      args: ['chat', '--legacy-ui', '--wrap', 'never', '--resume'],
    }
  }
}
