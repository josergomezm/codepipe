/**
 * Human-readable one-line summaries for tool calls.
 *
 * CLIs report tool calls with a structured input object. Dumping the raw
 * `JSON.stringify(input)` into the chat is noisy — multi-line fields (like an
 * Agent/Task tool's `prompt`) show up as escaped `\n` and flood the bubble.
 * Instead we surface the single most meaningful field per tool, collapsed to
 * one tidy line. The UI shows the tool *name* separately (as a badge), so the
 * summary is just the argument.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Collapse whitespace and truncate to a single readable line. */
export function oneLine(value: unknown, max = 140): string {
  let s: string
  if (typeof value === 'string') s = value
  else {
    try {
      s = JSON.stringify(value)
    } catch {
      s = String(value)
    }
  }
  s = (s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Summarize a tool call's input as a single line. Recognizes common
 * Claude Code / ACP tool shapes (Bash, Read/Write/Edit, Grep, WebFetch,
 * Agent/Task) and falls back to a compact view of the first few fields.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!isRecord(input)) return name
  const i = input
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined)

  const command = str('command')
  if (command) return oneLine(command)

  const filePath = str('file_path') ?? str('path') ?? str('notebook_path')
  if (filePath) return oneLine(filePath)

  const search = str('pattern') ?? str('query')
  if (search) return oneLine(search)

  const url = str('url')
  if (url) return oneLine(url)

  // Agent/Task-style tools: prefer "<subagent>: <description>", ignore the prompt.
  const description = str('description')
  if (description) {
    const sub = str('subagent_type')
    return oneLine(sub ? `${sub}: ${description}` : description)
  }

  const entries = Object.entries(i)
  if (entries.length === 0) return name
  return oneLine(entries.slice(0, 3).map(([k, v]) => `${k}: ${oneLine(v, 40)}`).join(', '))
}
