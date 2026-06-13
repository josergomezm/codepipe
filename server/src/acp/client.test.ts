import { describe, it, expect, vi } from 'vitest'
import { AcpClient } from './client.js'
import { parseMessage, encodeMessage, type JsonRpcMessage } from './jsonrpc.js'

/** Collects frames the client writes, and lets the test feed responses back. */
function makeHarness() {
  const sent: JsonRpcMessage[] = []
  const client = new AcpClient({
    write: (frame) => {
      const m = parseMessage(frame.trimEnd())
      if (m) sent.push(m)
    },
  })
  return { client, sent }
}

describe('AcpClient.request', () => {
  it('resolves with the result of a matching response', async () => {
    const { client, sent } = makeHarness()
    const p = client.request('session/new', { cwd: '/x' })
    const id = (sent[0] as { id: number }).id
    client.handleLine(encodeMessage({ jsonrpc: '2.0', id, result: { sessionId: 'sess_1' } }).trimEnd())
    await expect(p).resolves.toEqual({ sessionId: 'sess_1' })
  })

  it('rejects on an error response', async () => {
    const { client, sent } = makeHarness()
    const p = client.request('initialize')
    const id = (sent[0] as { id: number }).id
    client.handleLine(encodeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message: 'boom' } }).trimEnd())
    await expect(p).rejects.toThrow(/boom/)
  })

  it('times out when no response arrives', async () => {
    vi.useFakeTimers()
    const { client } = makeHarness()
    const p = client.request('initialize', undefined, 50)
    const assertion = expect(p).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(60)
    await assertion
    vi.useRealTimers()
  })

  it('assigns distinct ids to concurrent requests', () => {
    const { client, sent } = makeHarness()
    void client.request('a')
    void client.request('b')
    expect((sent[0] as { id: number }).id).not.toBe((sent[1] as { id: number }).id)
  })
})

describe('AcpClient notifications & inbound requests', () => {
  it('dispatches notifications to the handler', () => {
    const { client } = makeHarness()
    const handler = vi.fn()
    client.onNotification(handler)
    client.handleLine(encodeMessage({ jsonrpc: '2.0', method: 'session/update', params: { x: 1 } }).trimEnd())
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]![0]).toMatchObject({ method: 'session/update', params: { x: 1 } })
  })

  it('replies to inbound requests via the request handler', async () => {
    const { client, sent } = makeHarness()
    client.onRequest(() => ({ approved: true }))
    client.handleLine(encodeMessage({ jsonrpc: '2.0', id: 99, method: 'session/request_permission' }).trimEnd())
    await Promise.resolve()
    const reply = sent.find((m) => (m as { id?: number }).id === 99) as { result?: unknown }
    expect(reply?.result).toEqual({ approved: true })
  })

  it('returns method-not-found when no request handler is set', async () => {
    const { client, sent } = makeHarness()
    client.handleLine(encodeMessage({ jsonrpc: '2.0', id: 7, method: 'fs/read' }).trimEnd())
    await Promise.resolve()
    const reply = sent.find((m) => (m as { id?: number }).id === 7) as { error?: { code: number } }
    expect(reply?.error?.code).toBe(-32601)
  })

  it('ignores responses with unknown ids', () => {
    const { client } = makeHarness()
    expect(() =>
      client.handleLine(encodeMessage({ jsonrpc: '2.0', id: 12345, result: {} }).trimEnd()),
    ).not.toThrow()
  })
})

describe('AcpClient.dispose', () => {
  it('rejects in-flight requests', async () => {
    const { client } = makeHarness()
    const p = client.request('session/prompt')
    client.dispose('gone')
    await expect(p).rejects.toThrow(/gone/)
  })

  it('rejects new requests after disposal', async () => {
    const { client } = makeHarness()
    client.dispose()
    await expect(client.request('x')).rejects.toThrow(/disposed/)
  })
})
