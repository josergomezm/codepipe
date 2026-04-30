import stripAnsiLib from 'strip-ansi'

/**
 * Strip ANSI escape codes and carriage returns from terminal output.
 * Shared utility used by the session manager and adapters.
 *
 * The `strip-ansi` library handles most sequences, but PTY output can
 * split escape sequences across chunks, leaving partial fragments like
 * "5;252m" (the tail of an SGR sequence whose "\x1b[38;" prefix arrived
 * in a previous chunk).  We clean those up with a second pass.
 */
export function stripAnsi(text: string): string {
  let result = stripAnsiLib(text)

  // Remove carriage returns (PTY sends \r\n, we normalize to \n)
  result = result.replace(/\r/g, '')

  // ── Second pass: catch partial / split ANSI fragments ──

  // Orphaned CSI parameter tails at the START of a chunk.
  // When an escape like "\x1b[38;5;252m" is split across PTY chunks:
  //   Chunk 1: "text\x1b[38;" → strip-ansi removes "\x1b[38;"
  //   Chunk 2: "5;252mmore text" → "5;252m" is left as orphan
  // These always appear at the very beginning of the cleaned text.
  // Require at least one digit before the command letter to avoid
  // false positives on words starting with m/s/etc.
  result = result.replace(/^(\d+;)*\d+[mHJKABCDEFGsu]/, '')

  // Bare escape character followed by common sequence starters
  // (in case strip-ansi missed an incomplete sequence)
  result = result.replace(/\x1b[\[\]()><=]?[^\x1b\n]*/g, '')

  // Also catch any remaining bare \x1b characters
  result = result.replace(/\x1b/g, '')

  return result
}
