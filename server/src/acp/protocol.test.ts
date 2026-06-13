import { describe, it, expect } from 'vitest'
import {
  extractText,
  translateSessionUpdate,
  isEndOfTurnResult,
  parseAcpModels,
} from './protocol.js'

describe('extractText', () => {
  it('handles plain strings', () => {
    expect(extractText('hello')).toBe('hello')
  })

  it('handles a single text content block', () => {
    expect(extractText({ type: 'text', text: 'hi' })).toBe('hi')
  })

  it('concatenates an array of blocks', () => {
    expect(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
  })

  it('ignores non-text content', () => {
    expect(extractText({ type: 'image', data: 'xxx' })).toBe('')
    expect(extractText(null)).toBe('')
    expect(extractText(undefined)).toBe('')
  })
})

describe('translateSessionUpdate — agent message chunks', () => {
  it('translates ACP-spec snake_case agent_message_chunk', () => {
    const events = translateSessionUpdate({
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello there' } },
    })
    expect(events).toEqual([{ type: 'chunk', content: 'Hello there', role: 'assistant' }])
  })

  it('translates Kiro doc PascalCase AgentMessageChunk', () => {
    const events = translateSessionUpdate({
      update: { type: 'AgentMessageChunk', content: 'streamed text' },
    })
    expect(events).toEqual([{ type: 'chunk', content: 'streamed text', role: 'assistant' }])
  })

  it('drops empty chunks', () => {
    expect(translateSessionUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: '' } })).toEqual([])
  })
})

describe('translateSessionUpdate — tool calls', () => {
  it('maps a tool_call to a tool_use event with name + description', () => {
    const events = translateSessionUpdate({
      update: { sessionUpdate: 'tool_call', title: 'Read file', kind: 'read', status: 'in_progress', toolCallId: 't1' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'tool_use', tool: 'Read file' })
    expect((events[0] as { content: string }).content).toContain('Read file')
  })

  it('falls back to a compact view of raw input when no title', () => {
    const events = translateSessionUpdate({
      update: { sessionUpdate: 'tool_call', kind: 'fs_read', rawInput: { path: '/a/b.ts' } },
    })
    expect(events[0]).toMatchObject({ type: 'tool_use', tool: 'fs_read' })
    expect((events[0] as { content: string }).content).toContain('/a/b.ts')
  })

  it('always produces non-empty content (schema requires min length 1)', () => {
    const events = translateSessionUpdate({ update: { sessionUpdate: 'tool_call' } })
    expect((events[0] as { content: string }).content.length).toBeGreaterThan(0)
    expect((events[0] as { tool: string }).tool.length).toBeGreaterThan(0)
  })

  it('skips pure tool_call_update status pings (no new content)', () => {
    expect(translateSessionUpdate({ update: { sessionUpdate: 'tool_call_update', status: 'completed' } })).toEqual([])
  })

  it('surfaces tool_call_update output when present', () => {
    const events = translateSessionUpdate({
      update: { sessionUpdate: 'tool_call_update', status: 'completed', output: 'done: 3 files' },
    })
    expect(events[0]).toMatchObject({ type: 'tool_use', content: 'done: 3 files' })
  })
})

describe('translateSessionUpdate — thinking and turn end', () => {
  it('maps agent_thought_chunk to thinking', () => {
    expect(translateSessionUpdate({ update: { sessionUpdate: 'agent_thought_chunk', content: 'pondering' } }))
      .toEqual([{ type: 'thinking', content: 'pondering' }])
  })

  it('maps TurnEnd to message_complete', () => {
    expect(translateSessionUpdate({ update: { type: 'TurnEnd' } }))
      .toEqual([{ type: 'message_complete', role: 'assistant' }])
  })

  it('returns [] for unknown / non-visible update kinds', () => {
    expect(translateSessionUpdate({ update: { sessionUpdate: 'plan', entries: [] } })).toEqual([])
    expect(translateSessionUpdate({ update: { sessionUpdate: 'available_commands_update' } })).toEqual([])
    expect(translateSessionUpdate({})).toEqual([])
    expect(translateSessionUpdate({ update: null })).toEqual([])
  })
})

describe('parseAcpModels', () => {
  it('parses an array of model id strings', () => {
    expect(parseAcpModels({ models: ['sonnet', 'opus'] })).toEqual({
      available: [{ id: 'sonnet' }, { id: 'opus' }],
      current: null,
    })
  })

  it('parses an array of model objects with names', () => {
    const parsed = parseAcpModels({ models: [{ modelId: 'm1', name: 'Model One' }, { id: 'm2' }] })
    expect(parsed).toEqual({ available: [{ id: 'm1', name: 'Model One' }, { id: 'm2' }], current: null })
  })

  it('parses an object form with available + current', () => {
    const parsed = parseAcpModels({ models: { available: [{ id: 'a' }, { id: 'b' }], current: 'b' } })
    expect(parsed).toEqual({ available: [{ id: 'a' }, { id: 'b' }], current: 'b' })
  })

  it('reads a top-level currentModelId even without a list', () => {
    expect(parseAcpModels({ currentModelId: 'gpt-x' })).toEqual({ available: [], current: 'gpt-x' })
  })

  it('returns null when no model info is present', () => {
    expect(parseAcpModels({ sessionId: 'x' })).toBeNull()
    expect(parseAcpModels(null)).toBeNull()
  })
})

describe('isEndOfTurnResult', () => {
  it('recognizes end-of-turn stop reasons', () => {
    expect(isEndOfTurnResult({ stopReason: 'end_turn' })).toBe(true)
    expect(isEndOfTurnResult({ stopReason: 'cancelled' })).toBe(true)
    expect(isEndOfTurnResult({ stopReason: 'max_tokens' })).toBe(true)
  })

  it('returns false otherwise', () => {
    expect(isEndOfTurnResult({ stopReason: 'tool_use' })).toBe(false)
    expect(isEndOfTurnResult({})).toBe(false)
    expect(isEndOfTurnResult(null)).toBe(false)
  })
})
