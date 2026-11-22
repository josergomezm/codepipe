import { describe, it, expect } from 'vitest'
import { computeReplyUsage, formatUsd, type RawClaudeUsage } from './reply-usage.js'
import { translateStreamJsonLine } from './adapters/claude-stream-json.js'

const run = (cliTotalUsd: number, cliCumulativeTokens: number, tokens = { inputTokens: 2, cacheReadTokens: 30_000, cacheWriteTokens: 10_000, outputTokens: 500 }): RawClaudeUsage =>
  ({ cliTotalUsd, cliCumulativeTokens, ...tokens })

describe('computeReplyUsage', () => {
  it('first reply: the CLI total is the reply cost', () => {
    const u = computeReplyUsage(run(0.25, 40_502), null)
    expect(u.costUsd).toBeCloseTo(0.25)
    expect(u.sessionCostUsd).toBeCloseTo(0.25)
  })

  it('resumed run that carried the total over: subtracts the previous total', () => {
    const first = computeReplyUsage(run(0.25, 40_502), null)
    // The CLI reports 0.25 + 0.30, and cumulative tokens include the first run.
    const second = computeReplyUsage(run(0.55, 81_004), { usage: first })
    expect(second.costUsd).toBeCloseTo(0.30)
    expect(second.sessionCostUsd).toBeCloseTo(0.55)
    expect(second.cliTotalUsd).toBeCloseTo(0.55)
  })

  it('resumed run that started from zero (another session ran in between): no subtraction', () => {
    const first = computeReplyUsage(run(0.25, 40_502), null)
    // Total happens to exceed the previous one, but tokens show it's this run only.
    const second = computeReplyUsage(run(0.40, 40_502), { usage: first })
    expect(second.costUsd).toBeCloseTo(0.40)
    expect(second.sessionCostUsd).toBeCloseTo(0.65)
  })

  it('a total smaller than the previous one is never subtracted (no negative costs)', () => {
    const first = computeReplyUsage(run(5, 400_000), null)
    const second = computeReplyUsage(run(0.1, 900_000), { usage: first })
    expect(second.costUsd).toBeCloseTo(0.1)
  })

  it('after a legacy reply (raw "$x" running total), subtracts it when carried over', () => {
    const u = computeReplyUsage(run(88.549, 5_000_000), { legacyCredits: '$88.0226' })
    expect(u.costUsd).toBeCloseTo(0.5264)
    expect(u.sessionCostUsd).toBeCloseTo(88.549)
  })

  it('after a legacy reply, leaves a fresh (not carried) total alone', () => {
    const u = computeReplyUsage(run(90, 40_502), { legacyCredits: '$88.0226' })
    expect(u.costUsd).toBeCloseTo(90)
  })
})

describe('formatUsd', () => {
  it('uses 4 decimals under a dollar, 2 above', () => {
    expect(formatUsd(0.52641)).toBe('$0.5264')
    expect(formatUsd(12.3456)).toBe('$12.35')
  })
})

describe('claude stream-json result → claudeUsage', () => {
  it('reports this run\'s tokens and the cumulative model tokens', () => {
    const line = JSON.stringify({
      type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0.0052, duration_ms: 2400,
      usage: { input_tokens: 2, cache_creation_input_tokens: 11185, cache_read_input_tokens: 32850, output_tokens: 3 },
      modelUsage: { 'claude-haiku-5-5': { inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 62515, cacheCreationInputTokens: 23092 } },
    })
    const complete = translateStreamJsonLine(line).find((e) => e.type === 'message_complete')
    expect(complete).toMatchObject({
      metadata: {
        credits: '$0.0052',
        time: '2s',
        claudeUsage: { cliTotalUsd: 0.0052, cliCumulativeTokens: 85_617, inputTokens: 2, cacheReadTokens: 32850, cacheWriteTokens: 11185, outputTokens: 3 },
      },
    })
  })
})
