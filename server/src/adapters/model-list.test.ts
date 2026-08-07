import { describe, it, expect } from 'vitest'
import { parseKiroModelList, KiroAdapter } from './kiro.js'
import { parseAgyModelList } from './gemini.js'

describe('parseKiroModelList', () => {
  it('parses the --list-models JSON into picker options with rate + default markers', () => {
    const json = JSON.stringify({
      models: [
        { model_name: 'auto', description: 'Chosen by task', model_id: 'auto', context_window_tokens: 1000000, rate_multiplier: 1.0, rate_unit: 'Credit' },
        { model_name: 'claude-sonnet-5', description: 'Sonnet 5', model_id: 'claude-sonnet-5', context_window_tokens: 1000000, rate_multiplier: 1.3, rate_unit: 'Credit' },
      ],
      default_model: 'auto',
    })
    expect(parseKiroModelList(json)).toEqual([
      { id: 'auto', name: 'auto (1x) — default' },
      { id: 'claude-sonnet-5', name: 'claude-sonnet-5 (1.3x)' },
    ])
  })

  it('skips entries without a model_id and tolerates missing fields', () => {
    const json = JSON.stringify({ models: [{ model_name: 'ghost' }, { model_id: 'real' }] })
    expect(parseKiroModelList(json)).toEqual([{ id: 'real', name: 'real' }])
  })

  it('returns [] for invalid JSON or unexpected shapes', () => {
    expect(parseKiroModelList('not json')).toEqual([])
    expect(parseKiroModelList('{"models": "nope"}')).toEqual([])
    expect(parseKiroModelList('{}')).toEqual([])
  })
})

describe('KiroAdapter.buildMessageCommand model flag', () => {
  it('appends --model when a model is selected', () => {
    const adapter = new KiroAdapter()
    const { args } = adapter.buildMessageCommand('hello', 'sess-1', undefined, 'claude-sonnet-5')
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5')
    // Input must remain the last argument
    expect(args[args.length - 1]).toBe('hello')
  })

  it('omits --model when no model is selected', () => {
    const adapter = new KiroAdapter()
    const { args } = adapter.buildMessageCommand('hello', null, undefined, null)
    expect(args).not.toContain('--model')
  })
})

describe('parseAgyModelList', () => {
  it('parses one model ID per line, skipping blanks and banner lines', () => {
    const out = 'gemini-3.6-flash-high\ngemini-3.1-pro-low\n\nSome banner text\nclaude-sonnet-4-6\n'
    expect(parseAgyModelList(out)).toEqual([
      { id: 'gemini-3.6-flash-high' },
      { id: 'gemini-3.1-pro-low' },
      { id: 'claude-sonnet-4-6' },
    ])
  })

  it('returns [] for empty output', () => {
    expect(parseAgyModelList('')).toEqual([])
  })
})
