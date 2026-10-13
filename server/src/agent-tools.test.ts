import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { createServer, type Server } from 'http'
import { createInterface } from 'readline'
import type { AddressInfo } from 'net'

import { CODEPIPE_MCP_SCRIPT, codepipeMcpServer, sessionGetsAgentTools } from './agent-tools.js'
import { ISOLATED_CHILD } from './child-options.js'

let child: ChildProcess | null = null
let backend: Server | null = null

afterEach(() => {
  child?.kill()
  child = null
  backend?.close()
  backend = null
})

/** Run the real MCP server script and talk JSON-RPC to it over stdio. */
function startMcp(env: Record<string, string>) {
  const proc = spawn(process.execPath, [CODEPIPE_MCP_SCRIPT], {
    env: { ...process.env, CODEPIPE_SESSION_ID: '', ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
    ...ISOLATED_CHILD,
  })
  child = proc
  const pending = new Map<number, (msg: { result?: any; error?: any }) => void>()
  createInterface({ input: proc.stdout! }).on('line', (line) => {
    const msg = JSON.parse(line)
    pending.get(msg.id)?.(msg)
  })
  let nextId = 1
  return (method: string, params?: object) =>
    new Promise<{ result?: any; error?: any }>((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
}

/** A stand-in CodePipe backend: lists one tool and records what is forwarded. */
async function fakeBackend(reply: { status: number; body: object }) {
  const calls: { method: string; url: string; body: any }[] = []
  backend = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      calls.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null })
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tools: [{ name: 'add_idea', description: 'd', inputSchema: { type: 'object' } }] }))
        return
      }
      res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((r) => backend!.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, calls }
}

describe('codepipe MCP server', () => {
  it('lists no tools outside a CodePipe chat, or when CodePipe is unreachable', async () => {
    const rpc = startMcp({})
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(init.result.serverInfo.name).toBe('codepipe')
    expect((await rpc('tools/list')).result.tools).toEqual([])
    child?.kill()

    const offline = startMcp({ CODEPIPE_SESSION_ID: 'sess-1', CODEPIPE_API_URL: 'http://127.0.0.1:9' })
    expect((await offline('tools/list')).result.tools).toEqual([])
  })

  it('lists the backend tools for its chat and forwards calls verbatim', async () => {
    const result = { content: [{ type: 'text', text: 'Added it.' }] }
    const { url, calls } = await fakeBackend({ status: 200, body: result })
    const rpc = startMcp({ CODEPIPE_SESSION_ID: 'sess-1', CODEPIPE_API_URL: url })
    await rpc('initialize', { protocolVersion: '2025-06-18' })

    expect((await rpc('tools/list')).result.tools.map((t: { name: string }) => t.name)).toEqual(['add_idea'])
    const call = await rpc('tools/call', { name: 'add_idea', arguments: { text: 'Dark mode' } })
    expect(call.result).toEqual(result)
    expect(calls).toEqual([
      { method: 'GET', url: '/api/agent/sessions/sess-1/tools', body: null },
      { method: 'POST', url: '/api/agent/sessions/sess-1/tools/add_idea', body: { arguments: { text: 'Dark mode' } } },
    ])
  })

  it('reports backend failures as tool errors', async () => {
    const { url } = await fakeBackend({ status: 404, body: { error: 'This chat is not open in CodePipe' } })
    const rpc = startMcp({ CODEPIPE_SESSION_ID: 'sess-1', CODEPIPE_API_URL: url })
    const call = await rpc('tools/call', { name: 'add_idea', arguments: { text: 'x' } })
    expect(call.result.isError).toBe(true)
    expect(call.result.content[0].text).toContain('not open in CodePipe')
    expect((await rpc('no/such')).error.code).toBe(-32601)
  })
})

describe('agent tool wiring', () => {
  it('ties the server to its chat and skips reviewer sessions', () => {
    const spec = codepipeMcpServer('abc')
    expect(spec.args).toEqual([CODEPIPE_MCP_SCRIPT])
    expect(spec.env.CODEPIPE_SESSION_ID).toBe('abc')
    expect(spec.env.CODEPIPE_API_URL).toMatch(/^http:\/\//)
    expect(sessionGetsAgentTools('chat')).toBe(true)
    expect(sessionGetsAgentTools('team')).toBe(true)
    expect(sessionGetsAgentTools('review')).toBe(false)
  })
})
