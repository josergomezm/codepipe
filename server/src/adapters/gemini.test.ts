import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { GeminiAdapter } from './gemini.js'
import type { AdapterEvent } from './types.js'

const CID = '1f3e1f8b-d27c-4de1-9aa1-5c77c0a45268'
const step = (s: Record<string, unknown>) => JSON.stringify({ event: 'step_update', step_update: { conversation_id: CID, ...s } })

/** A real agy 1.2.13 run: read a file with a tool, then answer in two deltas. */
const TOOL_RUN = [
  JSON.stringify({ event: 'init', conversation_id: CID, init: { model: 'gemini-3.8-flash-low', tools: [] } }),
  step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
  step({ step_index: 1, state: 'DONE', step_type: 'agent_response', duration_seconds: 1.5 }),
  step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: 'C:/tmp/note.txt' } } }),
  step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: 'C:/tmp/note.txt' }, output: '2 lines' } }),
  step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'According to note.txt, ' }),
  step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'the secret is kiwi.' }),
  step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n' }),
  JSON.stringify({ event: 'result', result: { conversation_id: CID, status: 'SUCCESS', duration_seconds: 3.6, usage: { total_tokens: 24741 } } }),
]

function run(lines: string[]): AdapterEvent[] {
  const adapter = new GeminiAdapter()
  return lines.flatMap((l) => adapter.onData(l))
}

describe('GeminiAdapter (agy stream-json)', () => {
  it('translates a tool-using turn into session, model, tool, one text chunk and completion', () => {
    expect(run(TOOL_RUN)).toEqual([
      { type: 'cli_session', sessionId: CID },
      { type: 'model_info', current: 'gemini-3.8-flash-low' },
      { type: 'tool_use', tool: 'view_file', content: 'C:/tmp/note.txt' },
      { type: 'chunk', role: 'assistant', content: 'According to note.txt, the secret is kiwi.' },
      { type: 'cli_session', sessionId: CID },
      { type: 'message_complete', role: 'assistant', metadata: { credits: '24.7k tokens', time: '4s' } },
    ])
  })

  it('surfaces errors and denied actions as system messages', () => {
    const events = run([
      JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'invalid model selection\nAvailable models: …' } }),
      JSON.stringify({ event: 'result', result: { conversation_id: CID, status: 'SUCCESS', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } }),
    ])
    expect(events).toContainEqual({ type: 'chunk', role: 'system', content: 'Antigravity error: invalid model selection' })
    expect(events).toContainEqual({ type: 'chunk', role: 'system', content: 'Antigravity denied: RunCommand' })
    // An empty conversation id is never reported as a session
    expect(events.filter((e) => e.type === 'cli_session')).toHaveLength(1)
  })

  it('ignores non-JSON noise', () => {
    expect(run(['', 'Fetching…', '{not json'])).toEqual([])
  })

  it('builds a headless command with model, resume and attachment folders', () => {
    const img = join('/data', 'uploads', 'a.png')
    const { args } = new GeminiAdapter().buildMessageCommand('look', CID, [{ path: img, mimeType: 'image/png' }], 'gemini-3.8-flash-high')
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--dangerously-skip-permissions']))
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.8-flash-high')
    expect(args[args.indexOf('--conversation') + 1]).toBe(CID)
    expect(args[args.indexOf('--add-dir') + 1]).toBe(join('/data', 'uploads'))
    expect(args.slice(-2)).toEqual(['-p', `@${img} look`])
  })

  it('applies launch settings: permission skipping off, mode, sandbox, effort, extra args', () => {
    const { args } = new GeminiAdapter().buildMessageCommand('hi', null, undefined, null, undefined, {
      skipPermissions: false,
      mode: 'accept-edits',
      sandbox: true,
      effort: 'low',
      extraArgs: ['--print-timeout', '30s'],
    })
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args[args.indexOf('--mode') + 1]).toBe('accept-edits')
    expect(args).toContain('--sandbox')
    expect(args[args.indexOf('--effort') + 1]).toBe('low')
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('30s')
    expect(args.slice(-2)).toEqual(['-p', 'hi'])
  })
})
