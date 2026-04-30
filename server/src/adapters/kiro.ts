import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'

/** Kiro credits patterns. */
const CREDITS_PATTERNS = [
  /▸\s*Credits:\s*([\d.]+)\s*•\s*Time:\s*(\S+)/,
  /Est\.\s*Credits\s*Used:\s*([\d.]+)\s+Elapsed\s*time:\s*(\S+)/,
]

function parseCredits(text: string): { credits: string; time: string } | null {
  for (const pattern of CREDITS_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return { credits: match[1], time: match[2] }
  }
  return null
}

/** Braille spinner characters used by Kiro CLI. */
const SPINNER_CHARS = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

type AdapterState =
  | 'waiting_for_first_input'
  | 'waiting_for_response'
  | 'responding'
  | 'idle'
  | 'consuming_system_response'

/**
 * CLI adapter for the Kiro CLI (legacy UI mode).
 *
 * Processes raw PTY output (ANSI stripped) using a state machine.
 * Key principle: preserve the original text spacing — don't trim content chunks.
 * Only filter known noise patterns (spinners, prompts, echo, credits).
 */
export class KiroAdapter implements ICLIAdapter {
  readonly provider: ProviderType = 'kiro'
  readonly command = 'kiro-cli.exe'
  readonly args: string[] = ['chat', '--legacy-ui', '--wrap', 'never']
  readonly systemPrompt: string | undefined = undefined

  private state: AdapterState = 'waiting_for_first_input'
  private lastUserInput = ''
  private pendingCredits: { credits: string; time: string } | null = null
  /** Track if we've seen a spinner recently to filter split spinner chunks. */
  private recentSpinner = false

  private readonly promptPattern = /\d+%\s*>\s*$/

  onData(cleanText: string): AdapterEvent[] {
    if (this.state === 'waiting_for_first_input') return []
    if (this.state === 'idle') return []

    if (this.state === 'consuming_system_response') {
      if (this.promptPattern.test(cleanText)) {
        this.state = 'idle'
      }
      return []
    }

    const events: AdapterEvent[] = []

    // --- Classify the chunk ---

    // Is this a spinner line? (braille char + "Thinking...")
    const isFullSpinner = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Thinking/i.test(cleanText.trim())
    // Is this just a lone spinner char? (split chunk — spinner char arrived separately)
    const isLoneSpinnerChar = cleanText.trim().length === 1 && SPINNER_CHARS.includes(cleanText.trim())
    // Is this "Thinking..." without the spinner char? (other half of split)
    const isThinkingText = /^Thinking\.{0,3}$/.test(cleanText.trim())

    if (isFullSpinner || isLoneSpinnerChar || isThinkingText) {
      this.recentSpinner = true
      if (this.state === 'waiting_for_response') {
        events.push({ type: 'thinking', content: 'Thinking...' })
      }
      return events
    }

    // Does this contain a credits line?
    const credits = parseCredits(cleanText)
    if (credits) {
      this.pendingCredits = credits
      // The credits line might also contain the prompt (e.g., "▸ Credits: 0.03 • Time: 3s2% >")
      if (this.promptPattern.test(cleanText)) {
        if (this.state === 'responding') {
          events.push({
            type: 'message_complete',
            role: 'assistant',
            metadata: this.pendingCredits ?? undefined,
          })
          events.push({ type: 'prompt_detected' })
          this.pendingCredits = null
          this.state = 'idle'
        }
      }
      return events
    }

    // Does this contain a prompt?
    const hasPrompt = this.promptPattern.test(cleanText)

    // Is this the echoed user input? (prompt + user text, or just user text)
    if (this.state === 'waiting_for_response' && this.lastUserInput.trim().length > 0) {
      const stripped = cleanText.trim()
      // "N% > user input" or just "user input"
      const withoutPrompt = stripped.replace(/^\d+%\s*>\s*/, '')
      if (withoutPrompt === this.lastUserInput.trim() || stripped === this.lastUserInput.trim()) {
        // This is the echo — check if it also has a spinner
        if (/Thinking/i.test(cleanText)) {
          events.push({ type: 'thinking', content: 'Thinking...' })
        }
        return events
      }
    }

    // --- Process content ---

    if (this.state === 'waiting_for_response') {
      // Remove leading "> " that Kiro puts before response start
      let content = cleanText
      if (content.trimStart().startsWith('> ')) {
        content = content.trimStart().slice(2)
      }

      // Remove any prompt at the end
      if (hasPrompt) {
        content = content.replace(/\d+%\s*>\s*$/, '')
      }

      if (content.trim().length > 0) {
        this.state = 'responding'
        this.recentSpinner = false
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
      let content = cleanText

      // Remove any prompt at the end
      if (hasPrompt) {
        content = content.replace(/\d+%\s*>\s*$/, '')
      }

      // Don't trim! Preserve spaces — they're word boundaries between chunks
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
    this.lastUserInput = text
    this.pendingCredits = null
    this.recentSpinner = false
    if (this.state === 'waiting_for_first_input' || this.state === 'idle') {
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
    this.recentSpinner = false
  }
}
