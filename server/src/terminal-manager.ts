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
 * Wire protocol (JSON text frames over `/ws/terminal?projectId=<id>`):
 *   client → server  {type:'input', data} | {type:'resize', cols, rows} | {type:'kill'}
 *   server → client  {type:'snapshot', shellId, data} | {type:'output', data} | {type:'exit', code}
 */

import * as pty from 'node-pty'
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

export class TerminalManager {
  private readonly terminals = new Map<string, ProjectTerminal>()

  /** Whether a shell is currently running for the project. */
  isRunning(projectId: string): boolean {
    return this.terminals.has(projectId)
  }

  /** Connect a client socket to the project's shell, starting one if needed. */
  attach(projectId: string, cwd: string, ws: WebSocket): void {
    const term = this.terminals.get(projectId) ?? this.start(projectId, cwd)
    term.clients.set(ws, null)

    // Replay the current screen + scrollback before streaming live output.
    send(ws, { type: 'snapshot', shellId: term.id, data: term.serializer.serialize() })

    ws.on('message', (raw) => {
      const msg = parseClientMessage(raw.toString())
      if (!msg) return
      const live = this.terminals.get(projectId)
      if (!live || live !== term) return
      if (msg.type === 'input') live.pty.write(msg.data)
      else if (msg.type === 'resize') {
        live.clients.set(ws, { cols: msg.cols, rows: msg.rows })
        this.fitToClients(live)
      } else if (msg.type === 'kill') this.kill(projectId)
    })

    ws.on('close', () => {
      term.clients.delete(ws)
      // The smallest screen may have left — let the others grow back.
      if (this.terminals.get(projectId) === term) this.fitToClients(term)
    })
  }

  kill(projectId: string): void {
    const term = this.terminals.get(projectId)
    if (!term) return
    try { term.pty.kill() } catch { /* already exited */ }
  }

  killAll(): void {
    for (const id of [...this.terminals.keys()]) this.kill(id)
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
    log.info('terminal', `Starting ${shell.command} for project ${projectId} in ${cwd}`)

    const proc = pty.spawn(shell.command, shell.args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: { ...process.env } as Record<string, string>,
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
      pty: proc,
      mirror,
      serializer,
      clients: new Map(),
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    }
    this.terminals.set(projectId, term)

    proc.onData((data) => {
      mirror.write(data)
      for (const ws of term.clients.keys()) send(ws, { type: 'output', data })
    })

    proc.onExit(({ exitCode }) => {
      log.info('terminal', `Shell for project ${projectId} exited with code ${exitCode}`)
      // Only forget it if it's still the registered terminal for the project.
      if (this.terminals.get(projectId) === term) this.terminals.delete(projectId)
      for (const ws of term.clients.keys()) send(ws, { type: 'exit', code: exitCode })
      mirror.dispose()
    })

    return term
  }
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}
