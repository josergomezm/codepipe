import { describe, it, expect } from 'vitest'
import {
  encodeMessage,
  parseMessage,
  isResponse,
  isRequest,
  isNotification,
  LineBuffer,
  type JsonRpcMessage,
} from './jsonrpc.js'

describe('encodeMessage', () => {
  it('serializes to a single newline-terminated frame', () => {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'initialize' }
    const out = encodeMessage(msg)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.indexOf('\n')).toBe(out.length - 1) // exactly one, at the end
    expect(JSON.parse(out)).toEqual(msg)
  })
})

describe('parseMessage', () => {
  it('parses a valid response', () => {
    const m = parseMessage('{"jsonrpc":"2.0","id":2,"result":{"ok":true}}')
    expect(m).toEqual({ jsonrpc: '2.0', id: 2, result: { ok: true } })
  })

  it('returns null for blank lines', () => {
    expect(parseMessage('')).toBeNull()
    expect(parseMessage('   ')).toBeNull()
  })

  it('returns null for invalid JSON instead of throwing', () => {
    expect(parseMessage('{not json')).toBeNull()
  })

  it('returns null for JSON that is not a jsonrpc 2.0 message', () => {
    expect(parseMessage('{"hello":"world"}')).toBeNull()
    expect(parseMessage('42')).toBeNull()
  })
})

describe('message discriminators', () => {
  it('identifies requests, responses, and notifications', () => {
    const req: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'session/prompt' }
    const res: JsonRpcMessage = { jsonrpc: '2.0', id: 1, result: {} }
    const note: JsonRpcMessage = { jsonrpc: '2.0', method: 'session/update', params: {} }

    expect(isRequest(req)).toBe(true)
    expect(isResponse(req)).toBe(false)
    expect(isNotification(req)).toBe(false)

    expect(isResponse(res)).toBe(true)
    expect(isRequest(res)).toBe(false)

    expect(isNotification(note)).toBe(true)
    expect(isResponse(note)).toBe(false)
  })
})

describe('LineBuffer', () => {
  it('yields complete lines and retains a partial', () => {
    const lb = new LineBuffer()
    expect(lb.push('{"a":1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}'])
    expect(lb.push(':3}\n')).toEqual(['{"c":3}'])
  })

  it('handles a frame split across many chunks', () => {
    const lb = new LineBuffer()
    expect(lb.push('{"jsonrpc"')).toEqual([])
    expect(lb.push(':"2.0",')).toEqual([])
    expect(lb.push('"id":1}\n')).toEqual(['{"jsonrpc":"2.0","id":1}'])
  })

  it('flush returns a trailing partial line, then nothing', () => {
    const lb = new LineBuffer()
    lb.push('partial')
    expect(lb.flush()).toBe('partial')
    expect(lb.flush()).toBeNull()
  })

  it('end-to-end: buffer + parse a streamed conversation', () => {
    const lb = new LineBuffer()
    const stream =
      '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1}}\n' +
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}\n'
    const messages = lb.push(stream).map(parseMessage).filter(Boolean) as JsonRpcMessage[]
    expect(messages).toHaveLength(2)
    expect(isResponse(messages[0]!)).toBe(true)
    expect(isNotification(messages[1]!)).toBe(true)
  })
})
