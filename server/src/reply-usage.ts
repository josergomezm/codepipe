import type { ReplyUsage } from './schemas.js'

/**
 * Per-reply cost for Claude Code turns.
 *
 * CodePipe runs one `claude -p --resume <id>` per message. Claude Code's
 * `total_cost_usd` (and `modelUsage`) are *carried over* on resume when that
 * session was the last one run in the project, so the raw number is the
 * conversation's running total — but not always: when another session ran in
 * the same project in between, the CLI starts from zero. `usage` (tokens) is
 * always this run only.
 *
 * So: subtract the previous reply's raw total only when the CLI evidently
 * carried it over — its cumulative token count includes the previous run's
 * on top of this run's.
 */

export interface RawClaudeUsage {
  /** result.total_cost_usd, as reported (possibly carried over). */
  cliTotalUsd: number
  /** Sum of modelUsage tokens (all token kinds), as reported (possibly carried over). */
  cliCumulativeTokens: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** What we know about the previous reply in the same conversation. */
export type PreviousReply =
  | { usage: ReplyUsage }
  /** A reply recorded before per-reply costs existed: just its "$x" string. */
  | { legacyCredits: string }
  | null

export function runTokens(u: Pick<RawClaudeUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens'>): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens
}

export function computeReplyUsage(raw: RawClaudeUsage, prev: PreviousReply): ReplyUsage {
  const thisRun = runTokens(raw)
  let carriedTotal = 0
  let prevSession = 0

  if (prev && 'usage' in prev && prev.usage.cliTotalUsd != null) {
    prevSession = prev.usage.sessionCostUsd ?? 0
    const carried =
      raw.cliTotalUsd + 1e-9 >= prev.usage.cliTotalUsd &&
      prev.usage.cliCumulativeTokens != null &&
      raw.cliCumulativeTokens >= prev.usage.cliCumulativeTokens + thisRun
    if (carried) carriedTotal = prev.usage.cliTotalUsd
  } else if (prev && 'legacyCredits' in prev) {
    const legacy = /^\$([\d.]+)$/.exec(prev.legacyCredits.trim())
    const prevTotal = legacy ? Number(legacy[1]) : NaN
    // Old replies stored the CLI's raw (usually running) total.
    if (Number.isFinite(prevTotal) && raw.cliTotalUsd + 1e-9 >= prevTotal && raw.cliCumulativeTokens > thisRun) {
      carriedTotal = prevTotal
      prevSession = prevTotal
    }
  }

  const costUsd = Math.max(0, raw.cliTotalUsd - carriedTotal)
  return {
    costUsd,
    sessionCostUsd: prevSession + costUsd,
    cliTotalUsd: raw.cliTotalUsd,
    cliCumulativeTokens: raw.cliCumulativeTokens,
    inputTokens: raw.inputTokens,
    cacheReadTokens: raw.cacheReadTokens,
    cacheWriteTokens: raw.cacheWriteTokens,
    outputTokens: raw.outputTokens,
  }
}

/** "$0.5264" — 4 decimals under $1, 2 above. */
export function formatUsd(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`
}
