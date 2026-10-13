#!/usr/bin/env node
/**
 * CodePipe's MCP server — the tools an agent running inside a CodePipe chat
 * can call. Spoken over stdio (newline-delimited JSON-RPC), launched by the
 * CLI itself:
 *   - Claude Code: `--mcp-config` on every spawn (session-manager.ts)
 *   - Kiro over ACP: `mcpServers` on session/new and session/load
 *   - Kiro (text mode) / Antigravity: registered once in the CLI's global MCP
 *     config by `npm run agent-tool:install` (opt-in)
 *
 * A dependency-free proxy: the backend's tool registry
 * (src/agent-tool-registry.ts) decides which tools a chat gets, validates
 * every call and does the work — this only lists and forwards. The chat it
 * belongs to comes from the environment (CODEPIPE_SESSION_ID, set on the CLI
 * process CodePipe spawns). Without it — the same CLI run from a plain
 * terminal — or with CodePipe unreachable, it lists no tools, so a global
 * registration is invisible outside CodePipe.
 */

import { createInterface } from 'node:readline'

const SESSION_ID = process.env.CODEPIPE_SESSION_ID ?? ''
const API_URL = (process.env.CODEPIPE_API_URL ?? 'http://127.0.0.1:5551').replace(/\/+$/, '')
const SESSION_URL = `${API_URL}/api/agent/sessions/${encodeURIComponent(SESSION_ID)}`
const PROTOCOL_VERSION = '2025-06-18'

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

async function listTools() {
  if (!SESSION_ID) return []
  try {
    const res = await fetch(`${SESSION_URL}/tools`)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.tools) ? data.tools : []
  } catch {
    return []
  }
}

async function callTool(name, args) {
  if (!SESSION_ID) return toolError('Not running inside a CodePipe chat.')
  let res
  try {
    res = await fetch(`${SESSION_URL}/tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: args ?? {} }),
    })
  } catch (err) {
    return toolError(`CodePipe is unreachable (${err instanceof Error ? err.message : String(err)}).`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !Array.isArray(data.content)) {
    const reason = typeof data.error === 'string' ? data.error : res.statusText
    return toolError(`${name} failed: ${reason}`)
  }
  return data
}

async function handle(msg) {
  const { id, method, params } = msg
  const isRequest = id !== undefined && id !== null
  switch (method) {
    case 'initialize':
      return send({
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'codepipe', version: '2.0.0' },
        },
      })
    case 'ping':
      return send({ id, result: {} })
    case 'tools/list':
      return send({ id, result: { tools: await listTools() } })
    case 'tools/call':
      return send({ id, result: await callTool(params?.name, params?.arguments) })
    default:
      // Notifications (initialized, cancelled, …) need no reply.
      if (isRequest) send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

// In-flight calls finish even if the CLI closes stdin right after sending.
let pending = 0
let closed = false
const exitWhenIdle = () => {
  if (closed && pending === 0) process.exit(0)
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } })
  }
  pending++
  handle(msg)
    .catch((err) => {
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: String(err) } })
    })
    .finally(() => {
      pending--
      exitWhenIdle()
    })
})
rl.on('close', () => {
  closed = true
  exitWhenIdle()
})
