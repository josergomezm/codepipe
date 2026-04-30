import { describe, it, expect } from 'vitest'
import { validateAdapterEvents, AdapterEventSchema } from './types.js'

// ---------------------------------------------------------------------------
// AdapterEvent Zod schema — contract tests
//
// These verify the runtime validation boundary between adapters and the
// session manager. The pipeline functions (cleanNoise, classifyLines, etc.)
// are tested indirectly through the adapter-level tests in kiro.test.ts,
// kiro-real-data.test.ts, and kiro-tool-interleave.test.ts.
// ---------------------------------------------------------------------------

describe('AdapterEventSchema', () => {
  it('accepts valid events for each type', () => {
    const cases = [
      { type: 'chunk', content: 'Hello', role: 'assistant' },
      { type: 'message_complete', role: 'assistant' },
      { type: 'message_complete', role: 'assistant', metadata: { credits: '0.05', time: '3s' } },
      { type: 'prompt_detected' },
      { type: 'tool_use', tool: 'read', content: 'Reading file' },
      { type: 'thinking', content: 'Thinking...' },
      { type: 'interactive_prompt', content: 'Allow?', options: ['y', 'n'] },
    ]
    for (const event of cases) {
      expect(AdapterEventSchema.safeParse(event).success, `Failed: ${JSON.stringify(event)}`).toBe(true)
    }
  })

  it('rejects events with empty required fields', () => {
    const cases = [
      { type: 'chunk', content: '', role: 'assistant' },
      { type: 'chunk', content: 'Hello', role: 'invalid' },
      { type: 'tool_use', tool: '', content: 'something' },
      { type: 'tool_use', tool: 'read', content: '' },
      { type: 'thinking', content: '' },
      { type: 'interactive_prompt', content: '' },
      { type: 'message_complete', role: 'assistant', metadata: { credits: '', time: '3s' } },
    ]
    for (const event of cases) {
      expect(AdapterEventSchema.safeParse(event).success, `Should reject: ${JSON.stringify(event)}`).toBe(false)
    }
  })

  it('rejects unknown event types', () => {
    expect(AdapterEventSchema.safeParse({ type: 'unknown' }).success).toBe(false)
  })
})

describe('validateAdapterEvents', () => {
  it('passes through valid events, drops invalid ones', () => {
    const events = [
      { type: 'chunk', content: 'Hello', role: 'assistant' },
      { type: 'chunk', content: '', role: 'assistant' },  // invalid
      { type: 'prompt_detected' },
      { garbage: true },                                    // invalid
      null,                                                 // invalid
    ]
    const warnings: string[] = []
    const result = validateAdapterEvents(events, (msg) => warnings.push(msg))
    expect(result).toHaveLength(2)
    expect(warnings).toHaveLength(3)
  })

  it('returns empty array when all events are invalid', () => {
    const result = validateAdapterEvents([
      { type: 'chunk', content: '', role: 'assistant' },
      { type: 'tool_use', tool: '', content: '' },
    ])
    expect(result).toHaveLength(0)
  })
})
