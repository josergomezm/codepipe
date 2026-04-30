import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'

// ── Pattern detection ──────────────────────────────────────────────────

function isOnlySpinner(text: string): boolean {
  const cleaned = text
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Thinking\.{0,3}/g, '')
    .replace(/Thinking\.{0,3}/g, '')
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')
    .trim()
  return cleaned.length === 0
}

/** Main prompt: "N% > " at end of text. */
const PROMPT_PATTERN = /\d+%\s*>\s*$/
const PROMPT_ANYWHERE = /\d+%\s*>\s*/g

/** Interactive prompts: [y/n/t], [y/n], (y/n), etc. */
const INTERACTIVE_PROMPT = /\[([yntYNT/|, ]+)\]\s*:?\s*$/
/** Also match "Allow this action?" style prompts. */
const PERMISSION_PROMPT = /Allow this action\?.*\[([^\]]+)\]\s*:?\s*$/

/** Tool use patterns from Kiro CLI. */
const TOOL_USE_PATTERN = /\(using tool:\s*(\w+)[^)]*\)/
const TOOL_RESULT_PATTERNS = [
  /✓\s+Successfully\s+(.+)/,
  /●\s+Execution failed\s+(.+)/,
  /↱\s+Operation\s+\d+:\s+(.+)/,
  /⋮\s*$/,
  /- Summary:\s+(.+)/,
  /- Completed in\s+(.+)/,
  /Loading\.\.\.\s*Loading\.\.\.\s*Loading\.\.\./,
]

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

/** Check if a line looks like tool output (not user-facing response text). */
function isToolOutputLine(line: string): boolean {
  const trimmed = line.trim()
  if (TOOL_USE_PATTERN.test(trimmed)) return true
  for (const pattern of TOOL_RESULT_PATTERNS) {
    if (pattern.test(trimmed)) return true
  }
  // Lines starting with ↱ are tool operation details
  if (trimmed.startsWith('↱')) return true
  // Lines with [CodebaseMap ...] are tool results
  if (/\[CodebaseMap/.test(trimmed)) return true
  return false
}

// ── Content extraction ─────────────────────────────────────────────────

/**
 * Process a chunk of text and separate it into response content and tool output.
 * Returns { content, toolOutput } where content is the user-facing text
 * and toolOutput is the tool-related text to show separately.
 */
function separateContent(
  text: string,
  userInput: string,
): { content: string; toolOutput: string } {
  let result = text

  // Remove spinner content
  result = result
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Thinking\.{0,3}/g, '')
    .replace(/Thinking\.{0,3}/g, '')
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')

  // Remove prompt patterns
  result = result.replace(PROMPT_ANYWHERE, '')

  // Remove echoed user input from the start
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

  // Remove ">" response markers
  result = result.replace(/^>\s*/gm, '')

  // Remove startup noise
  result = result.replace(/^[⠀-⣿\s]+$/gm, '')
  result = result.replace(/^[╭╮╰╯│─┌┐└┘├┤┬┴┼][^\n]*$/gm, '')
  result = result.replace(/^Model:.*$/gm, '')
  result = result.replace(/Did you know\?/g, '')

  // Separate tool output from response content
  const lines = result.split('\n')
  const contentLines: string[] = []
  const toolLines: string[] = []

  for (const line of lines) {
    if (isToolOutputLine(line)) {
      toolLines.push(line)
    } else {
      contentLines.push(line)
    }
  }

  // Collapse multiple newlines
  const content = contentLines.join('\n').replace(/\n{3,}/g, '\n\n')
  const toolOutput = toolLines.join('\n')

  return { content, toolOutput }
}

// ── Adapter ────────────────────────────────────────────────────────────

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
  private echoBuffer = ''
  /** Last known tool name for continuation chunks. */
  private lastToolName = 'tool'

  onData(cleanText: string): AdapterEvent[] {
    // ── Startup: wait for first prompt ──
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

    // ── Check for interactive prompts (permission requests) ──
    const interactiveMatch = INTERACTIVE_PROMPT.exec(cleanText) || PERMISSION_PROMPT.exec(cleanText)
    if (interactiveMatch) {
      // Finalize any in-progress message first
      if (this.state === 'responding') {
        events.push({
          type: 'message_complete',
          role: 'assistant',
          ...(this.pendingCredits ? { metadata: this.pendingCredits } : {}),
        })
        this.pendingCredits = null
      }

      // Extract the options from the prompt
      const optionsStr = interactiveMatch[1]
      const options = optionsStr.split(/[/|,]/).map(o => o.trim()).filter(Boolean)

      // Extract the prompt text (everything before the [options])
      const promptText = cleanText.slice(0, interactiveMatch.index).trim()
      const displayText = promptText || cleanText.trim()

      events.push({
        type: 'interactive_prompt',
        content: displayText,
        options,
      })

      // Stay in responding state — user needs to answer
      return events
    }

    // ── Standard processing ──
    const credits = parseCredits(cleanText)
    if (credits) this.pendingCredits = credits
    const hasPrompt = PROMPT_PATTERN.test(cleanText)

    // Spinner only
    if (isOnlySpinner(cleanText)) {
      if (this.state === 'waiting_for_response') {
        events.push({ type: 'thinking', content: 'Thinking...' })
      }
      return events
    }

    // Credits-only chunk with prompt
    if (credits) {
      const { content } = separateContent(cleanText, '')
      if (content.trim().length === 0) {
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
    }

    // ── waiting_for_response: buffer echo then process ──
    if (this.state === 'waiting_for_response') {
      if (!this.echoConsumed) {
        this.echoBuffer += cleanText
        const echo = this.lastUserInput.trim()

        if (this.echoBuffer.length < echo.length && !hasPrompt) {
          if (isOnlySpinner(cleanText)) {
            events.push({ type: 'thinking', content: 'Thinking...' })
          }
          return events
        }

        this.echoConsumed = true
        const { content, toolOutput } = separateContent(this.echoBuffer, echo)
        this.echoBuffer = ''

        if (toolOutput.trim().length > 0) {
          const toolMatch = TOOL_USE_PATTERN.exec(toolOutput)
          const toolName = toolMatch ? toolMatch[1] : this.lastToolName
          if (toolMatch) this.lastToolName = toolMatch[1]
          events.push({
            type: 'tool_use',
            tool: toolName,
            content: toolOutput.trim(),
          })
        }

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

      // Echo consumed — normal processing
      const { content, toolOutput } = separateContent(cleanText, '')

      if (toolOutput.trim().length > 0) {
        const toolMatch = TOOL_USE_PATTERN.exec(toolOutput)
        const toolName = toolMatch ? toolMatch[1] : this.lastToolName
        if (toolMatch) this.lastToolName = toolMatch[1]
        events.push({
          type: 'tool_use',
          tool: toolName,
          content: toolOutput.trim(),
        })
      }

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

    // ── responding: accumulate chunks ──
    if (this.state === 'responding') {
      const { content, toolOutput } = separateContent(cleanText, '')

      if (toolOutput.trim().length > 0) {
        const toolMatch = TOOL_USE_PATTERN.exec(toolOutput)
        const toolName = toolMatch ? toolMatch[1] : this.lastToolName
        if (toolMatch) this.lastToolName = toolMatch[1]
        events.push({
          type: 'tool_use',
          tool: toolName,
          content: toolOutput.trim(),
        })
      }

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
    if (this.state === 'idle' || this.state === 'responding') {
      // responding → waiting_for_response handles the case where user answers
      // an interactive prompt while the CLI is still in "responding" mode
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
    this.lastToolName = 'tool'
  }
}
