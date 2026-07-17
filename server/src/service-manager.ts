import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import { log } from './logger.js'
import type { ProjectServiceConfig } from './schemas.js'

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

function pushLog(logs: string[], line: string): void {
  logs.push(line)
  if (logs.length > MAX_LOG_LINES) logs.shift()
}

// ---------------------------------------------------------------------------
// ServiceManager
// ---------------------------------------------------------------------------

interface ServiceProcess {
  process: ChildProcess
  projectId: string
  serviceId: string
  state: ServiceState
  portParser?: PortParser
  exited: boolean
}

export class ServiceManager {
  private readonly processes = new Map<string, ServiceProcess>()

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

    log.info('service', `Starting service "${config.label}" for project ${projectId}: ${config.startCommand} in ${cwd}`)

    const state: ServiceState = {
      status: 'running',
      ports: {},
      logs: [],
    }

    const child = spawn(config.startCommand, [], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
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
      state,
      portParser,
      exited: false,
    }

    this.processes.set(key, entry)

    const handleOutput = (data: Buffer) => {
      const lines = data.toString().split('\n')
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
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

  getState(projectId: string, serviceId: string): ServiceState {
    const key = this.key(projectId, serviceId)
    const entry = this.processes.get(key)
    if (entry && !entry.exited) return entry.state
    return { status: 'stopped', ports: {}, logs: entry?.state.logs ?? [] }
  }

  private killProcess(entry: ServiceProcess): void {
    if (entry.exited) return
    const pid = entry.process.pid
    if (pid === undefined) return

    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' })
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
