/**
 * Kiro CLI output patterns — shared constants and matchers.
 *
 * Used by the KiroAdapter to classify stdout lines as tool output
 * vs assistant text, and to extract credits metadata.
 */

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
  if (trimmed.startsWith('↱')) return true
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
