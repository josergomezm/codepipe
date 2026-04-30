import stripAnsiLib from 'strip-ansi'

/**
 * Strip ANSI escape codes and carriage returns from terminal output.
 * Shared utility used by the session manager and adapters.
 */
export function stripAnsi(text: string): string {
  let result = stripAnsiLib(text)
  result = result.replace(/\r/g, '')
  return result
}
