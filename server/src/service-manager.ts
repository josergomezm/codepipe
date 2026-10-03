import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import { log } from './logger.js'
import type { ProjectServiceConfig } from './schemas.js'
import { ISOLATED_CHILD } from './child-options.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceStatus = 'running' | 'stopped' | 'error'

export interface ServicePortInfo {
  host: string
  port: number
}

export interface ServiceState {
  status: ServiceStatus
  pid?: number
  ports: Record<string, ServicePortInfo>
  uiUrl?: string
  logs: string[]
  error?: string
}

export type PortParser = (line: string, state: ServiceState) => void

// ---------------------------------------------------------------------------
// Ring buffer for logs
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 200

/**
 * Firebase (and most CLIs) colorize output, and the escape codes sit between
 * the box-drawing characters and the values — enough to defeat the port-table
 * regexes and to smuggle terminal junk into the UI's log tail.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

export function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, '')
}

function pushLog(logs: string[], line: string): void {
  logs.push(line)
  if (logs.length > MAX_LOG_LINES) logs.shift()
}

/**
 * Service configs saved by an earlier detector carry both a `cwd` and a
 * redundant `--prefix <cwd>` / `--cwd <cwd>` flag. npm then resolves
 * `<cwd>/<cwd>/package.json` and dies with ENOENT before anything starts, so
 * strip the flag when it only repeats the directory we already chdir into.
 */
export function normalizeStartCommand(config: ProjectServiceConfig): string {
  if (!config.cwd) return config.startCommand
  const dir = config.cwd.replace(/[\\/]+$/, '')
  if (!dir) return config.startCommand
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return config.startCommand
    .replace(new RegExp(`\\s+--(?:prefix|cwd)[\\s=]+["']?${escaped}["']?(?=\\s|$)`), '')
    .trim()
}

// ---------------------------------------------------------------------------
// ServiceManager
// ---------------------------------------------------------------------------

interface ServiceProcess {
  process: ChildProcess
  projectId: string
  serviceId: string
  label: string
  state: ServiceState
  portParser?: PortParser
  exited: boolean
}

export interface RunningService {
  projectId: string
  serviceId: string
  label: string
  state: ServiceState
}

export class ServiceManager {
  private readonly processes = new Map<string, ServiceProcess>()
  /**
   * State of the last run of each service, kept after the process is gone so a
   * crash keeps its exit code and log tail instead of reading as a plain stop.
   */
  private readonly lastStates = new Map<string, ServiceState>()

  private key(projectId: string, serviceId: string): string {
    return `${projectId}::${serviceId}`
  }

  start(
    projectId: string,
    projectPath: string,
    config: ProjectServiceConfig,
    portParser?: PortParser,
  ): ServiceState {
    const key = this.key(projectId, config.id)

    // Stop existing if running
    if (this.processes.has(key)) {
      this.stop(projectId, config.id)
    }

    const cwd = config.cwd
      ? path.resolve(projectPath, config.cwd)
      : projectPath

    const startCommand = normalizeStartCommand(config)
    log.info('service', `Starting service "${config.label}" for project ${projectId}: ${startCommand} in ${cwd}`)

    const state: ServiceState = {
      status: 'running',
      ports: {},
      logs: [],
    }
    this.lastStates.set(key, state)

    const child = spawn(startCommand, [], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      ...ISOLATED_CHILD,
    })

    if (child.pid === undefined) {
      state.status = 'error'
      state.error = 'Failed to spawn process'
      return state
    }

    state.pid = child.pid

    const entry: ServiceProcess = {
      process: child,
      projectId,
      serviceId: config.id,
      label: config.label,
      state,
      portParser,
      exited: false,
    }

    this.processes.set(key, entry)

    const handleOutput = (data: Buffer) => {
      const lines = data.toString().split('\n')
      for (const raw of lines) {
        const line = stripAnsi(raw).replace(/\r$/, '').trimEnd()
        if (!line) continue
        pushLog(state.logs, line)
        if (portParser) portParser(line, state)
      }
    }

    child.stdout?.on('data', handleOutput)
    child.stderr?.on('data', handleOutput)

    child.on('close', (code) => {
      entry.exited = true
      if (code !== 0 && code !== null) {
        state.status = 'error'
        state.error = `Process exited with code ${code}`
      } else {
        state.status = 'stopped'
      }
      log.info('service', `Service "${config.label}" exited with code ${code}`)
      if (this.processes.get(key) === entry) {
        this.processes.delete(key)
      }
    })

    child.on('error', (err) => {
      entry.exited = true
      state.status = 'error'
      state.error = err.message
      log.error('service', `Service "${config.label}" error`, err)
      if (this.processes.get(key) === entry) {
        this.processes.delete(key)
      }
    })

    return state
  }

  stop(projectId: string, serviceId: string): boolean {
    const key = this.key(projectId, serviceId)
    const entry = this.processes.get(key)
    if (!entry) return false

    this.killProcess(entry)
    entry.state.status = 'stopped'
    this.processes.delete(key)
    return true
  }

  /** All currently running services across every project. */
  listRunning(): RunningService[] {
    const out: RunningService[] = []
    for (const entry of this.processes.values()) {
      if (entry.exited) continue
      out.push({
        projectId: entry.projectId,
        serviceId: entry.serviceId,
        label: entry.label,
        state: entry.state,
      })
    }
    return out
  }

  getState(projectId: string, serviceId: string): ServiceState {
    const key = this.key(projectId, serviceId)
    const entry = this.processes.get(key)
    if (entry && !entry.exited) return entry.state
    const last = this.lastStates.get(key)
    if (last) return last
    return { status: 'stopped', ports: {}, logs: [] }
  }

  private killProcess(entry: ServiceProcess): void {
    if (entry.exited) return
    const pid = entry.process.pid
    if (pid === undefined) return

    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore', ...ISOLATED_CHILD })
      } else {
        entry.process.kill('SIGTERM')
      }
    } catch {
      // Already dead
    }
  }

  async shutdownAll(): Promise<void> {
    for (const [key, entry] of this.processes) {
      this.killProcess(entry)
      this.processes.delete(key)
    }
  }
}
