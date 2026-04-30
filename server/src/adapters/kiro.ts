import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'

/** Check if text is ONLY spinner content (no real response text). */
function isOnlySpinner(text: string): boolean {
  const cleaned = text
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Thinking\.{0,3}/g, '')
    .replace(/Thinking\.{0,3}/g, '')
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')
    .trim()
  return cleaned.length === 0
}

/** Kiro prompt pattern: "N% > " at end of text. */
const PROMPT_PATTERN = /\d+%\s*>\s*$/
/** Prompt pattern anywhere (for removal). */
const PROMPT_ANYWHERE = /\d+%\s*>\s*/g

/** Credits patterns. */
const CREDITS_PATTERNS = [
  /▸\s*Credits:\s*([\d.]+)\s*•\s*Time:\s*(\d+[smh])(?=\s|\d|$)/,
  /Est\.\s*Credits\s*Used:\s*([\d.]+)\s+Elapsed\s*time:\s*(\d+[smh])(?=\s|\d|$)/,
]

function parseCredits(text: string): { credits: string; time: string } | null {
  for (const pattern of CREDITS_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return { credits: match[1], time: match[2] }
  }
  return null
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  // Use character-by-character replacement to avoid $& issues
  let result = ''
  for (const ch of str) {
    if ('.*+?^${}()|[]\\'.includes(ch)) {
      result += '\\' + ch
    } else {
      result += ch
    }
  }
  return result
}

/**
 * Remove all known noise from a chunk, leaving only the actual response content.
 */
function extractContent(text: string, userInput: string): string {
  let result = text

  // Remove spinner content
  result = result
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Thinking\.{0,3}/g, '')
    .replace(/Thinking\.{0,3}/g, '')
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')

  // Remove prompt patterns
  result = result.replace(PROMPT_ANYWHERE, '')

  // Remove echoed user input — only from the START of the text
  // (the echo is always the first thing the CLI outputs after receiving input)
  if (userInput.trim().length > 0) {
    const echo = userInput.trim()
    const trimmedResult = result.trimStart()
    if (trimmedResult.startsWith(echo)) {
      result = trimmedResult.slice(echo.length)
    }
  }

  // Remove credits lines
  for (const pattern of CREDITS_PATTERNS) {
    result = result.replace(pattern, '')
  }
  result = result.replace(/▸[^\n]*/g, '')

  // Remove ">" response markers (with or without space)
  result = result.replace(/^>\s*/gm, '')

  // Remove braille art lines
  result = result.replace(/^[⠀-⣿\s]+$/gm, '')

  // Remove box-drawing lines
  result = result.replace(/^[╭╮╰╯│─┌┐└┘├┤┬┴┼][^\n]*$/gm, '')

  // Remove "Model:" info line
  result = result.replace(/^Model:.*$/gm, '')

  // Remove "Did you know?"
  result = result.replace(/Did you know\?/g, '')

  // Collapse multiple newlines
  result = result.replace(/\n{3,}/g, '\n\n')

  return result
}

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

  private state: AdapterState = 'waiting_for_first_input'
  private lastUserInput = ''
  private pendingCredits: { credits: string; time: string } | null = null
  private cliReady = false
  private queuedUserInput: string | null = null
  private echoConsumed = false
  /** Buffer for accumulating text while waiting for echo to complete. */
  private echoBuffer = ''
  private queuedUserInput: string | null = null
  /** Whether the echo of the current user input has been consumed. */
  private echoConsumed = false

  onData(cleanText: string): AdapterEvent[] {
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

    if (this.state === 'consuming_system_response') {
      if (PROMPT_PATTERN.test(cleanText)) {
        this.state = 'idle'
      }
      return []
    }

    const events: AdapterEvent[] = []
    const credits = parseCredits(cleanText)
    if (credits) this.pendingCredits = credits
    const hasPrompt = PROMPT_PATTERN.test(cleanText)

    if (isOnlySpinner(cleanText)) {
      if (this.state === 'waiting_for_response') {
        events.push({ type: 'thinking', content: 'Thinking...' })
      }
      return events
    }

    // Extract actual content (for responding state — waiting_for_response handles its own)
    const content = this.state === 'responding' ? extractContent(cleanText, '') : ''

    if (credits && content.trim().length === 0) {
      if (hasPrompt && this.state === 'responding') {
        events.push({
          type: 'message_complete',
          role: 'assistant',
          metadata: this.pendingCredits ?? undefined,
        })
        events.push({ type: 'prompt_detected' })
        this.pendingCredits = null
        this.state = 'idle'
      }
      return events
    }

    if (this.state === 'waiting_for_response') {
      // Buffer text until we've accumulated enough to check for the echo
      if (!this.echoConsumed) {
        this.echoBuffer += cleanText
        const echo = this.lastUserInput.trim()
        
        // If buffer is shorter than the echo, keep buffering
        if (this.echoBuffer.length < echo.length && !hasPrompt) {
          // But still detect spinners
          if (isOnlySpinner(cleanText)) {
            events.push({ type: 'thinking', content: 'Thinking...' })
          }
          return events
        }
        
        // We have enough text — strip the echo from the start of the buffer
        this.echoConsumed = true
        let buffered = extractContent(this.echoBuffer, echo)
        this.echoBuffer = ''
        
        if (buffered.trim().length > 0) {
          this.state = 'responding'
          events.push({ type: 'chunk', content: buffered, role: 'assistant' })
        }
        
        if (hasPrompt && this.state === 'responding') {
          events.push({
            type: 'message_complete',
            role: 'assistant',
            ...(this.pendingCredits ? { metadata: this.pendingCredits } : {}),
          })
          events.push({ type: 'prompt_detected' })
          this.pendingCredits = null
          this.state = 'idle'
        }
        return events
      }
      
      // Echo already consumed — process normally
      const content = extractContent(cleanText, '')
      if (content.trim().length > 0) {
        this.state = 'responding'
        events.push({ type: 'chunk', content, role: 'assistant' })
      }

      if (hasPrompt && this.state === 'responding') {
        events.push({
          type: 'message_complete',
          role: 'assistant',
          ...(this.pendingCredits ? { metadata: this.pendingCredits } : {}),
        })
        events.push({ type: 'prompt_detected' })
        this.pendingCredits = null
        this.state = 'idle'
      }
      return events
    }

    if (this.state === 'responding') {
      if (content.length > 0) {
        events.push({ type: 'chunk', content, role: 'assistant' })
      }
      if (hasPrompt) {
        events.push({
          type: 'message_complete',
          role: 'assistant',
          ...(this.pendingCredits ? { metadata: this.pendingCredits } : {}),
        })
        events.push({ type: 'prompt_detected' })
        this.pendingCredits = null
        this.state = 'idle'
      }
      return events
    }

    return events
  }

  notifyUserInput(text: string): void {
    this.pendingCredits = null
    this.echoConsumed = false
    this.echoBuffer = ''
    if (!this.cliReady) {
      this.queuedUserInput = text
      return
    }
    this.lastUserInput = text
    if (this.state === 'idle') {
      this.state = 'waiting_for_response'
    }
  }

  notifySystemInput(text: string): void {
    this.lastUserInput = text
    this.pendingCredits = null
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
  }
}
