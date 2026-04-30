/**
 * Kiro CLI output processing pipeline.
 *
 * Pure functions that transform raw (ANSI-stripped) CLI text into
 * classified, cleaned content. Each step has a single responsibility:
 *
 *   cleanNoise()     → remove spinners, prompts, credits, startup junk
 *   stripEcho()      → remove echoed user input from the start
 *   classifyLines()  → split text into { content, toolOutput }
 *
 * The adapter's state machine calls these in sequence. Because they're
 * pure functions, they're trivial to unit test independently.
 */

import {
  PROMPT_ANYWHERE,
  SPINNER_WITH_TEXT,
  THINKING_ONLY,
  SPINNER_CHARS,
  CREDITS_PATTERNS,
  BRAILLE_LINE,
  BOX_DRAWING_LINE,
  MODEL_LINE,
  TIP_TEXT,
  CREDITS_LINE,
  RESPONSE_MARKER,
  isToolLine,
} from './kiro-patterns.js'

// ---------------------------------------------------------------------------
// Step 1: Clean noise
// ---------------------------------------------------------------------------

/**
 * Remove terminal noise that is never user-facing content:
 * spinners, prompt patterns, credits, box-drawing, model info.
 *
 * Does NOT touch tool output or assistant text — that's classifyLines' job.
 */
export function cleanNoise(text: string): string {
  let result = text

  // Spinners
  result = result.replace(SPINNER_WITH_TEXT, '')
  result = result.replace(THINKING_ONLY, '')
  result = result.replace(SPINNER_CHARS, '')

  // Prompt patterns (e.g. "42% > ")
  result = result.replace(PROMPT_ANYWHERE, '')

  // Credits display
  for (const pattern of CREDITS_PATTERNS) {
    result = result.replace(pattern, '')
  }
  result = result.replace(CREDITS_LINE, '')

  // Response markers ("> " at start of line)
  result = result.replace(RESPONSE_MARKER, '')

  // Startup noise
  result = result.replace(BRAILLE_LINE, '')
  result = result.replace(BOX_DRAWING_LINE, '')
  result = result.replace(MODEL_LINE, '')
  result = result.replace(TIP_TEXT, '')

  return result
}

// ---------------------------------------------------------------------------
// Step 2: Strip echo
// ---------------------------------------------------------------------------

/**
 * Remove echoed user input from the start of text.
 * The CLI echoes back whatever the user typed before responding.
 */
export function stripEcho(text: string, userInput: string): string {
  if (userInput.trim().length === 0) return text

  const echo = userInput.trim()
  const trimmed = text.trimStart()
  if (trimmed.startsWith(echo)) {
    return trimmed.slice(echo.length)
  }
  return text
}

// ---------------------------------------------------------------------------
// Step 3: Classify lines
// ---------------------------------------------------------------------------

/**
 * Result of classifying a chunk of text.
 */
export interface ClassifiedContent {
  /** User-facing assistant text. */
  content: string
  /** Tool-related output (invocations, results, errors). */
  toolOutput: string
}

/**
 * Split text into assistant content and tool output by classifying
 * each line independently.
 */
export function classifyLines(text: string): ClassifiedContent {
  const lines = text.split('\n')
  const contentLines: string[] = []
  const toolLines: string[] = []

  for (const line of lines) {
    if (isToolLine(line)) {
      toolLines.push(line)
    } else {
      contentLines.push(line)
    }
  }

  // Collapse runs of 3+ newlines into 2
  const content = contentLines.join('\n').replace(/\n{3,}/g, '\n\n')
  const toolOutput = toolLines.join('\n')

  return { content, toolOutput }
}

// ---------------------------------------------------------------------------
// Combined pipeline
// ---------------------------------------------------------------------------

/**
 * Full pipeline: clean noise → strip echo → classify lines.
 *
 * This is the convenience wrapper the adapter calls. For testing
 * individual steps, import them directly.
 */
export function processChunk(
  text: string,
  userInput: string,
): ClassifiedContent {
  const cleaned = cleanNoise(text)
  const stripped = stripEcho(cleaned, userInput)
  return classifyLines(stripped)
}
