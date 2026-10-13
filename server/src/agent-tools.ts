/**
 * How a CLI CodePipe spawns finds CodePipe's own MCP server
 * (mcp/codepipe-mcp.mjs) — the tools an agent can call from any chat, such
 * as adding an item to the user's action items.
 *
 * The server is a tiny stdio process the CLI launches; it forwards each call
 * to this backend over loopback (backend-to-backend — the browser never
 * talks to it). Which chat a call belongs to travels in the environment:
 * CODEPIPE_SESSION_ID is set both in the MCP server spec (CLIs that take one
 * per session: Claude Code, Kiro over ACP) and on the CLI process itself, so
 * a CLI with the server registered globally (`npm run agent-tool:install`)
 * passes it down too.
 */

import { fileURLToPath } from 'url'

import type { SessionKind } from './schemas.js'

/** A stdio MCP server, in the shape every CLI config format can be built from. */
export interface McpServerSpec {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export const CODEPIPE_MCP_NAME = 'codepipe'

/** The tool's fully-qualified name in Claude Code (`mcp__<server>__<tool>`). */
export const CLAUDE_ADD_ACTION_TOOL = `mcp__${CODEPIPE_MCP_NAME}__add_action_item`

/** Absolute path of the MCP server script (same relative spot from src/ and dist/). */
export const CODEPIPE_MCP_SCRIPT = fileURLToPath(new URL('../mcp/codepipe-mcp.mjs', import.meta.url))

/** Loopback URL of this backend, as the MCP server should call it. */
export function backendUrl(): string {
  const port = process.env['PORT'] ?? '5551'
  const host = process.env['HOST']?.trim()
  // A wildcard bind is reachable on loopback; a specific address only on itself.
  const reachable = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${port}`
}

/** Environment that ties an agent's tool calls to its CodePipe chat. */
export function agentToolEnv(sessionId: string): Record<string, string> {
  return { CODEPIPE_SESSION_ID: sessionId, CODEPIPE_API_URL: backendUrl() }
}

/**
 * The tools are for sessions the user works in. Reviewer sessions are
 * throwaway and read-only — nothing they find should reach the user's list
 * except through the standup that digests their takes.
 */
export function sessionGetsAgentTools(kind: SessionKind | undefined): boolean {
  return kind !== 'review'
}

/** CodePipe's MCP server for one chat. */
export function codepipeMcpServer(sessionId: string): McpServerSpec {
  return {
    name: CODEPIPE_MCP_NAME,
    command: process.execPath,
    args: [CODEPIPE_MCP_SCRIPT],
    env: agentToolEnv(sessionId),
  }
}
