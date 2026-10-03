/**
 * Project terminals: one real shell (node-pty) per project, shared by every
 * connected client.
 *
 * A headless xterm mirrors the shell's output so a client that connects late
 * (tab reopened, phone reconnecting) receives the current screen and
 * scrollback as a snapshot before the live stream. The shell keeps running
 * when all clients disconnect; it ends on `exit`, an explicit kill, or server
 * shutdown.
 *
 * With several screens attached (e.g. desktop + phone), the shell is sized to
 * the smallest one, like tmux, so no screen sees lines wrapped for another.
 *
 * Nothing a shell or client does may throw out of an event handler: that
 * would be an uncaught exception and take the whole backend down with it.
 *
 * Wire protocol (JSON text frames over `/ws/terminal?projectId=<id>`):
 *   client → server  {type:'input', data} | {type:'resize', cols, rows} | {type:'kill'}
 *   server → client  {type:'snapshot', shellId, data} | {type:'output', data} | {type:'exit', code}
 *                    | {type:'error', message} (no shell could start; the socket then closes with 4500)
 */

import * as pty from 'node-pty'
import { existsSync, statSync } from 'fs'
import { platform } from 'os'
import { randomUUID } from 'crypto'
import type { WebSocket } from 'ws'
import xtermHeadless from '@xterm/headless'
import serializeAddon from '@xterm/addon-serialize'

import { log } from './logger.js'

// Both packages ship CommonJS, so their classes hang off the default export.
const { Terminal: HeadlessTerminal } = xtermHeadless
const { SerializeAddon } = serializeAddon

const SCROLLBACK_LINES = 5000
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30

/** Shell to launch: `CODEPIPE_SHELL` override, else PowerShell on Windows, else $SHELL. */
export function resolveShell(): { command: string; args: string[] } {
  const override = process.env['CODEPIPE_SHELL']?.trim()
  if (override) return { command: override, args: [] }
  if (platform() === 'win32') return { command: 'powershell.exe', args: ['-NoLogo'] }
  return { command: process.env['SHELL'] || 'bash', args: ['-l'] }
}

interface ProjectTerminal {
  /** Changes whenever a new shell starts, so clients can tell a restart. */
  id: string
  startedAt: number
  /** Why the shell is ending, when we ended it (for the exit log line). */
  killReason?: string
  pty: pty.IPty
  mirror: InstanceType<typeof HeadlessTerminal>
  serializer: InstanceType<typeof SerializeAddon>
  /** Each attached screen and the size it last reported. */
  clients: Map<WebSocket, { cols: number; rows: number } | null>
  cols: number
  rows: number
}

type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' }

function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>
    if (msg['type'] === 'input' && typeof msg['data'] === 'string') return { type: 'input', data: msg['data'] }
    if (msg['type'] === 'resize') {
      const cols = Number(msg['cols'])
      const rows = Number(msg['rows'])
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= 500 && rows <= 200) {
        return { type: 'resize', cols, rows }
      }
    }
    if (msg['type'] === 'kill') return { type: 'kill' }
  } catch {
    /* not JSON — ignore */
  }
  return null
}

/** Smallest size across the screens that have reported one. */
export function smallestSize(sizes: Iterable<{ cols: number; rows: number } | null>): { cols: number; rows: number } | null {
  let best: { cols: number; rows: number } | null = null
  for (const s of sizes) {
    if (!s) continue
    best = best ? { cols: Math.min(best.cols, s.cols), rows: Math.min(best.rows, s.rows) } : { ...s }
  }
  return best
}

/** A shell that couldn't be started, with a message fit to show the user. */
export class TerminalStartError extends Error {}

export class TerminalManager {
  private readonly terminals = new Map<string, ProjectTerminal>()

  /** Running shells, for health monitoring. */
  shellCount(): number {
    return this.terminals.size
  }

  /** Whether a shell is currently running for the project. */
  isRunning(projectId: string): boolean {
    return this.terminals.has(projectId)
  }

  /**
   * Connect a client socket to the project's shell, starting one if needed.
   * Throws TerminalStartError (with a user-facing message) if no shell can run.
   */
  attach(projectId: string, cwd: string, ws: WebSocket): void {
    const term = this.terminals.get(projectId) ?? this.start(projectId, cwd)
    term.clients.set(ws, null)
    log.info('terminal', `Client attached to shell for project ${projectId} (${term.clients.size} connected)`)

    // Replay the current screen + scrollback before streaming live output.
    let snapshot = ''
    try {
      snapshot = term.serializer.serialize()
    } catch (err) {
      log.warn('terminal', `Couldn't serialize scrollback for project ${projectId}`, err)
    }
    send(ws, { type: 'snapshot', shellId: term.id, data: snapshot })

    ws.on('message', (raw) => {
      const msg = parseClientMessage(raw.toString())
      if (!msg) return
      const live = this.terminals.get(projectId)
      if (!live || live !== term) return
      try {
        if (msg.type === 'input') live.pty.write(msg.data)
        else if (msg.type === 'resize') {
          live.clients.set(ws, { cols: msg.cols, rows: msg.rows })
          this.fitToClients(live)
        } else if (msg.type === 'kill') this.kill(projectId, 'killed from the Terminal tab')
      } catch (err) {
        // e.g. writing to or resizing a shell that exited a moment ago
        log.warn('terminal', `Ignored ${msg.type} for project ${projectId}: the shell didn't accept it`, err)
      }
    })

    // Socket 'error' events are handled where the socket is created (terminal-ws).
    ws.on('close', () => {
      term.clients.delete(ws)
      log.info('terminal', `Client detached from shell for project ${projectId} (${term.clients.size} connected)`)
      // The smallest screen may have left — let the others grow back.
      if (this.terminals.get(projectId) !== term) return
      try {
        this.fitToClients(term)
      } catch (err) {
        log.warn('terminal', `Couldn't resize shell for project ${projectId}`, err)
      }
    })
  }

  kill(projectId: string, reason = 'killed'): void {
    const term = this.terminals.get(projectId)
    // Exited shells leave the map in onExit, so `term` is still running — or
    // exited a moment ago and onExit hasn't fired yet. In that window
    // node-pty's Windows kill helper prints a harmless "AttachConsole failed"
    // crash to stderr; the supervisor filters it out of crash headlines.
    if (!term) return
    term.killReason = reason
    log.info('terminal', `Ending shell for project ${projectId}: ${reason}`)
    try { term.pty.kill() } catch { /* already exited */ }
  }

  killAll(reason = 'server shutting down'): void {
    for (const id of [...this.terminals.keys()]) this.kill(id, reason)
  }

  private fitToClients(term: ProjectTerminal): void {
    const size = smallestSize(term.clients.values())
    if (!size || (size.cols === term.cols && size.rows === term.rows)) return
    term.cols = size.cols
    term.rows = size.rows
    term.pty.resize(size.cols, size.rows)
    term.mirror.resize(size.cols, size.rows)
  }

  private start(projectId: string, cwd: string): ProjectTerminal {
    const shell = resolveShell()

    // Fail with a clear reason rather than an opaque spawn error.
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      log.warn('terminal', `Not starting a shell for project ${projectId}: folder missing (${cwd})`)
      throw new TerminalStartError(`The project folder doesn't exist any more: ${cwd}`)
    }

    let proc: pty.IPty
    try {
      proc = pty.spawn(shell.command, shell.args, {
        name: 'xterm-256color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd,
        env: { ...process.env } as Record<string, string>,
      })
    } catch (err) {
      log.error('terminal', `Failed to start ${shell.command} for project ${projectId} in ${cwd}`, err)
      const detail = err instanceof Error ? err.message : String(err)
      const hint = process.env['CODEPIPE_SHELL'] ? ' (check CODEPIPE_SHELL)' : ''
      throw new TerminalStartError(`Couldn't start ${shell.command}: ${detail}${hint}`)
    }
    log.info('terminal', `Started ${shell.command} (pid ${proc.pid}) for project ${projectId} in ${cwd}`)

    // node-pty re-throws socket errors other than EIO (e.g. EPIPE, ECONNRESET)
    // unless a second 'error' listener exists — from inside an event handler,
    // i.e. as an uncaught exception that would crash the server. `on` exists
    // at runtime but isn't in node-pty's IPty type.
    ;(proc as unknown as { on(event: 'error', fn: (err: Error) => void): void }).on('error', (err) => {
      log.warn('terminal', `Shell I/O error for project ${projectId} (pid ${proc.pid})`, err)
    })

    const mirror = new HeadlessTerminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    })
    const serializer = new SerializeAddon()
    mirror.loadAddon(serializer)

    const term: ProjectTerminal = {
      id: randomUUID(),
      startedAt: Date.now(),
      pty: proc,
      mirror,
      serializer,
      clients: new Map(),
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    }
    this.terminals.set(projectId, term)

    let mirrorOk = true
    proc.onData((data) => {
      if (mirrorOk) {
        try {
          mirror.write(data)
        } catch (err) {
          // Lose scrollback replay for this shell rather than the server.
          mirrorOk = false
          log.warn('terminal', `Scrollback mirror failed for project ${projectId}; live output continues`, err)
        }
      }
      for (const ws of term.clients.keys()) send(ws, { type: 'output', data })
    })

    proc.onExit(({ exitCode, signal }) => {
      const uptime = Math.round((Date.now() - term.startedAt) / 1000)
      const how = term.killReason ?? (exitCode === 0 ? 'exited' : 'exited unexpectedly')
      const line = `Shell for project ${projectId} (pid ${proc.pid}) ${how}: code ${exitCode}${signal ? `, signal ${signal}` : ''}, after ${uptime}s`
      if (term.killReason || exitCode === 0) log.info('terminal', line)
      else log.warn('terminal', line)

      // Only forget it if it's still the registered terminal for the project.
      if (this.terminals.get(projectId) === term) this.terminals.delete(projectId)
      for (const ws of term.clients.keys()) send(ws, { type: 'exit', code: exitCode })
      try { mirror.dispose() } catch { /* already gone */ }
    })

    return term
  }
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState !== ws.OPEN) return
  try {
    ws.send(JSON.stringify(msg))
  } catch (err) {
    log.warn('terminal', 'Failed to send to a terminal client', err)
  }
}
