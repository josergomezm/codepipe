#!/usr/bin/env node
/**
 * Register CodePipe's MCP server (mcp/codepipe-mcp.mjs) in the global MCP
 * config of CLIs that can't take one per invocation:
 *
 *   - Kiro in its default text mode (`kiro-cli chat --no-interactive`)
 *   - Antigravity (`agy`)
 *
 * Claude Code and Kiro over ACP need nothing — CodePipe hands them the
 * server on every spawn. Outside CodePipe (no CODEPIPE_SESSION_ID in the
 * environment) the server lists no tools, so the registration is invisible
 * when you use these CLIs from a plain terminal.
 *
 *   npm run agent-tool:install                 # kiro + agy
 *   npm run agent-tool:install -- kiro         # just one
 *   npm run agent-tool:install -- --uninstall  # remove it again
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../mcp/codepipe-mcp.mjs', import.meta.url))
const NAME = 'codepipe'
const NODE = process.execPath

const argv = process.argv.slice(2)
const uninstall = argv.includes('--uninstall')
const wanted = argv.filter((a) => !a.startsWith('--'))
const targets = wanted.length ? wanted : ['kiro', 'agy']

const CLIS = {
  kiro: {
    bin: process.env.KIRO_CLI_BIN || 'kiro-cli',
    install: ['mcp', 'add', '--name', NAME, '--scope', 'global', '--command', NODE, '--args', SCRIPT, '--force'],
    uninstall: ['mcp', 'remove', '--name', NAME, '--scope', 'global'],
  },
  agy: {
    bin: process.env.AGY_CLI_BIN || process.env.GEMINI_CLI_BIN || 'agy',
    install: ['mcp', 'add', NAME, NODE, SCRIPT],
    uninstall: ['mcp', 'remove', NAME],
  },
}

let failed = false
for (const target of targets) {
  const cli = CLIS[target]
  if (!cli) {
    console.error(`Unknown CLI "${target}" — expected one of: ${Object.keys(CLIS).join(', ')}`)
    failed = true
    continue
  }
  const args = uninstall ? cli.uninstall : cli.install
  const result = spawnSync(cli.bin, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    console.error(`${target}: ${result.error ? result.error.message : `exited with ${result.status}`}`)
    failed = true
  } else {
    console.log(`${target}: ${uninstall ? 'removed' : 'registered'} the CodePipe MCP server`)
  }
}
process.exit(failed ? 1 : 0)
