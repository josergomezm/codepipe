/**
 * Kiro CLI output patterns — shared constants and matchers.
 *
 * This module is the single source of truth for recognizing Kiro CLI
 * output patterns. Every regex lives here so adding a new pattern is
 * a one-file change.
 */

// ── Prompt patterns ────────────────────────────────────────────────────

/** Main prompt: "N% > " at end of text. */
export const PROMPT_PATTERN = /\d+%\s*>\s*$/

/** Prompt anywhere in text (for stripping). */
export const PROMPT_ANYWHERE = /\d+%\s*>\s*/g

/** Interactive prompts: [y/n/t], [y/n], (y/n), etc. */
export const INTERACTIVE_PROMPT = /\[([yntYNT/|, ]+)\]\s*:?\s*$/

/** "Allow this action?" style prompts. */
export const PERMISSION_PROMPT = /Allow this action\?.*\[([^\]]+)\]\s*:?\s*$/

// ── Spinner patterns ───────────────────────────────────────────────────

const SPINNER_CHARS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g
const SPINNER_WITH_TEXT = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Thinking\.{0,3}/g
const THINKING_ONLY = /Thinking\.{0,3}/g

export function isOnlySpinner(text: string): boolean {
  const cleaned = text
    .replace(SPINNER_WITH_TEXT, '')
    .replace(THINKING_ONLY, '')
    .replace(SPINNER_CHARS, '')
    .trim()
  return cleaned.length === 0
}

// ── Credits patterns ───────────────────────────────────────────────────

const CREDITS_PATTERNS = [
  /▸\s*Credits:\s*([\d.]+)\s*•\s*Time:\s*(\d+[smh])(?=\s|\d|$)/,
  /Est\.\s*Credits\s*Used:\s*([\d.]+)\s+Elapsed\s*time:\s*(\d+[smh])(?=\s|\d|$)/,
]

export function parseCredits(text: string): { credits: string; time: string } | null {
  for (const pattern of CREDITS_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return { credits: match[1], time: match[2] }
  }
  return null
}

// ── Tool output patterns ───────────────────────────────────────────────

/** Extracts tool name from "(using tool: read)" style markers. */
export const TOOL_NAME_PATTERN = /\(using tool:\s*(\w+)[^)]*\)/

/**
 * Patterns that identify a line as tool output (not assistant text).
 * Order doesn't matter — any match means "this is tool output."
 */
const TOOL_LINE_PATTERNS: RegExp[] = [
  // Tool invocation
  TOOL_NAME_PATTERN,
  // Result indicators
  /✓\s+Successfully\s+(.+)/,
  /●\s+Execution failed\s+(.+)/,
  /↱\s+Operation\s+\d+:\s+(.+)/,
  /⋮\s*$/,
  /- Summary:\s+(.+)/,
  /- Completed in\s+(.+)/,
  /Loading\.\.\.\s*Loading\.\.\.\s*Loading\.\.\./,
  // Validation errors
  /Tool validation failed/,
  /Failed to validate tool parameters/,
  // File operation announcements
  /I'll modify the following file:/,
  /I'll create the following file:/,
  /Updating:/,
  /Replacing:/,
  /Reading (?:file|directory):/,
  /no occurrences of/,
  // Diff-style output (line numbers with +/- prefixes)
  /^[+-]\s*\d+\s*:/,
  /^Purpose:/,
]

/** Check if a single line is tool output. */
export function isToolLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  for (const pattern of TOOL_LINE_PATTERNS) {
    if (pattern.test(trimmed)) return true
  }
  // Lines starting with ↱ are tool operation details
  if (trimmed.startsWith('↱')) return true
  // Lines with [CodebaseMap ...] are tool results
  if (/\[CodebaseMap/.test(trimmed)) return true
  return false
}

/**
 * Extract the tool name from text, or return a fallback.
 */
export function extractToolName(text: string, fallback: string): string {
  const match = TOOL_NAME_PATTERN.exec(text)
  return match ? match[1] : fallback
}

// ── Noise patterns (for stripping) ─────────────────────────────────────

/** Braille art / logo lines (all braille + whitespace). */
const BRAILLE_LINE = /^[⠀-⣿\s]+$/gm

/** Box-drawing characters (tip boxes, borders). */
const BOX_DRAWING_LINE = /^[╭╮╰╯│─┌┐└┘├┤┬┴┼][^\n]*$/gm

/** Model info line. */
const MODEL_LINE = /^Model:.*$/gm

/** "Did you know?" tips. */
const TIP_TEXT = /Did you know\?/g

/** Credits display lines (full line). */
const CREDITS_LINE = /▸[^\n]*/g

/** Response marker at start of line. */
const RESPONSE_MARKER = /^>\s*/gm

export {
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
}
