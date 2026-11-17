import { describe, it, expect, vi } from 'vitest'
import { parseClaudeUsage, parseKiroUsage, parseAgyUsage, UsageService } from './usage.js'

describe('parseClaudeUsage', () => {
  it('reads every "% used" window, the plan and the activity lines', () => {
    const text = [
      'You are currently using your subscription to power your Claude Code usage',
      '',
      'Current session: 5% used · resets Nov 17, 4:50pm (America/New_York)',
      'Current week (all models): 56% used · resets Nov 21, 12am (America/New_York)',
      'Current week (Fable): 20% used · resets Nov 21, 12am (America/New_York)',
      '',
      "What's contributing to your usage?",
      'Last 24h · 4860 requests · 8 sessions',
      '  75%  Check which model subagents use',
      'Last 7d · 10117 requests · 32 sessions',
    ].join('\n')
    expect(parseClaudeUsage(text)).toEqual({
      plan: 'Subscription',
      windows: [
        { label: 'Current session', usedPercent: 5, resets: 'Nov 17, 4:50pm (America/New_York)' },
        { label: 'Current week (all models)', usedPercent: 56, resets: 'Nov 21, 12am (America/New_York)' },
        { label: 'Current week (Fable)', usedPercent: 20, resets: 'Nov 21, 12am (America/New_York)' },
      ],
      notes: ['Last 24h · 4860 requests · 8 sessions', 'Last 7d · 10117 requests · 32 sessions'],
    })
  })

  it('handles a window with no reset time', () => {
    expect(parseClaudeUsage('Current week: 0% used').windows).toEqual([
      { label: 'Current week', usedPercent: 0, resets: undefined },
    ])
  })
})

describe('parseKiroUsage', () => {
  it('reads the plan, reset date and credits', () => {
    const text = [
      '\u001b[1mEstimated Usage\u001b[0m | resets on 2026-12-01 | KIRO PRO+',
      'Credits (2000.00 of 2000 covered in plan), 100.0%',
      'Additional credits:',
      '  Add-on credits available for purchase',
      'Manage your plan or purchase add-on credits at https://app.kiro.dev/account/usage',
    ].join('\n')
    expect(parseKiroUsage(text)).toEqual({
      plan: 'KIRO PRO+',
      windows: [{ label: 'Credits', usedPercent: 100, detail: '2000.00 of 2000', resets: '2026-12-01' }],
      notes: [],
    })
  })
})

describe('parseAgyUsage', () => {
  it('notes when no quota groups are reported', () => {
    const json = '{"status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[]}}}'
    expect(parseAgyUsage(json)).toEqual({
      plan: undefined,
      windows: [],
      notes: ['Antigravity reported no quota groups for this account.'],
    })
  })

  it('finds labelled fractions anywhere in the groups', () => {
    const json = JSON.stringify({
      command: {
        data: {
          groups: [
            { name: 'Gemini Pro', quotas: [{ name: 'Daily', remainingFraction: 0.25, resetTime: '2026-11-18T00:00:00Z' }] },
            { title: 'Flash', usedPercent: 10 },
          ],
        },
      },
    })
    expect(parseAgyUsage(json).windows).toEqual([
      { label: 'Gemini Pro · Daily', usedPercent: 75, resets: '2026-11-18T00:00:00Z' },
      { label: 'Flash', usedPercent: 10, resets: undefined },
    ])
  })
})

describe('UsageService', () => {
  it('caches readings, shares in-flight reads and keeps old numbers on error', async () => {
    const reader = vi.fn()
      .mockResolvedValueOnce({ plan: 'P', windows: [{ label: 'W', usedPercent: 40 }], notes: [] })
      .mockRejectedValueOnce(new Error('offline'))
    const svc = new UsageService({ claude: reader })

    const [a, b] = await Promise.all([svc.getAll(), svc.getAll()])
    expect(reader).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(a[0]).toMatchObject({ provider: 'claude', status: 'ok', plan: 'P' })

    // Fresh enough: no re-read, even when asked to refresh.
    await svc.getAll({ refresh: true })
    expect(reader).toHaveBeenCalledTimes(1)

    vi.useFakeTimers({ now: Date.now() + 60_000 })
    try {
      const [c] = await svc.getAll({ refresh: true })
      expect(reader).toHaveBeenCalledTimes(2)
      expect(c).toMatchObject({ status: 'error', error: 'offline', plan: 'P', windows: [{ label: 'W', usedPercent: 40 }] })
    } finally {
      vi.useRealTimers()
    }
  })
})
