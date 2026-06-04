import { spawn, type ChildProcess } from 'child_process'
import { log } from './logger.js'
import type { ProjectDevServer } from './schemas.js'
import {
  buildTailscaleUrl,
  getTailscaleHostname,
  hasServeMapping,
  createServeMapping,
} from './tailscale.js'
import path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DevServerStatus = 'running' | 'stopped'

export interface DevServerInfo {
  status: DevServerStatus
  port: number
  tailscalePort: number
  url: string | null
  tailscaleMapped: boolean
}

interface DevServerProcess {
  process: ChildProcess
  projectId: string
  config: ProjectDevServer
  projectPath: string
  /** Set to true once the process has exited — prevents stale close handlers from corrupting state. */
  exited: boolean
}

// ---------------------------------------------------------------------------
// DevServerManager
// ---------------------------------------------------------------------------

export class DevServerManager {
  private readonly processes = new Map<string, DevServerProcess>()

  /**
   * Start a dev server for a project.
   * If one is already running, stops it first and waits for it to exit.
   * Ensures a Tailscale Serve mapping exists, creating one if needed.
   */
  async start(projectId: string, projectPath: string, config: ProjectDevServer): Promise<DevServerInfo> {
    // Stop existing and wait for it to fully exit before spawning a new one
    if (this.processes.has(projectId)) {
      await this.stopAndWait(projectId)
    }

    const tailscalePort = config.tailscalePort ?? 443

    // Ensure Tailscale Serve mapping exists
    const existingMapping = hasServeMapping(config.port, tailscalePort)
    if (!existingMapping) {
      log.info('dev-server', `No Tailscale mapping for port ${config.port} on TS port ${tailscalePort}, creating one...`)
      const created = await createServeMapping(tailscalePort, config.port)
      if (!created) {
        log.warn('dev-server', `Could not create Tailscale mapping — dev server will start but remote access may not work`)
      }
    }

    const cwd = config.cwd
      ? path.resolve(projectPath, config.cwd)
      : projectPath

    const hostname = getTailscaleHostname() ?? ''

    log.info('dev-server', `Starting dev server for project ${projectId}: ${config.startCommand} in ${cwd}`)

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TAILSCALE_HOST: hostname,
      TAILSCALE_PORT: String(tailscalePort),
    }

    const child = spawn(config.startCommand, [], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    })

    const entry: DevServerProcess = {
      process: child,
      projectId,
      config,
      projectPath,
      exited: false,
    }

    // Only register if the process got a PID (spawn succeeded synchronously)
    if (child.pid === undefined) {
      log.error('dev-server', `Failed to spawn dev server for project ${projectId} — no PID`)
      return {
        status: 'stopped',
        port: config.port,
        tailscalePort,
        url: buildTailscaleUrl(tailscalePort),
        tailscaleMapped: !!existingMapping,
      }
    }

    this.processes.set(projectId, entry)

    child.stdout?.on('data', (data: Buffer) => {
      log.debug('dev-server', `[${projectId}] ${data.toString().trim()}`)
    })

    child.stderr?.on('data', (data: Buffer) => {
      log.debug('dev-server', `[${projectId}] ${data.toString().trim()}`)
    })

    child.on('close', (exitCode) => {
      entry.exited = true
      log.info('dev-server', `Dev server for project ${projectId} exited with code ${exitCode}`)
      if (this.processes.get(projectId) === entry) {
        this.processes.delete(projectId)
      }
    })

    child.on('error', (err) => {
      entry.exited = true
      log.error('dev-server', `Dev server error for project ${projectId}`, err)
      if (this.processes.get(projectId) === entry) {
        this.processes.delete(projectId)
      }
    })

    return {
      status: 'running',
      port: config.port,
      tailscalePort,
      url: buildTailscaleUrl(tailscalePort),
      tailscaleMapped: true,
    }
  }

  /**
   * Stop a running dev server. Returns immediately (does not wait for exit).
   */
  stop(projectId: string): boolean {
    const entry = this.processes.get(projectId)
    if (!entry) return false

    this.killProcess(entry)
    this.processes.delete(projectId)

    // Also try to kill anything on the configured port as a safety net
    // (handles case where our PID tracking lost the process)
    this.killByPort(entry.config.port)

    return true
  }

  /**
   * Stop a running dev server and wait for the process to fully exit.
   */
  private stopAndWait(projectId: string): Promise<void> {
    const entry = this.processes.get(projectId)
    if (!entry || entry.exited) {
      if (entry) this.processes.delete(projectId)
      return Promise.resolve()
    }

    this.processes.delete(projectId)

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        log.warn('dev-server', `Timeout waiting for dev server ${projectId} to exit`)
        resolve()
      }, 5000)

      const done = () => {
        clearTimeout(timeout)
        resolve()
      }

      if (entry.exited) {
        done()
        return
      }

      entry.process.on('close', done)
      entry.process.on('error', done)

      this.killProcess(entry)
    })
  }

  /**
   * Kill a process and its tree.
   */
  private killProcess(entry: DevServerProcess): void {
    if (entry.exited) return

    const pid = entry.process.pid
    if (pid === undefined) return

    log.info('dev-server', `Killing dev server for project ${entry.projectId} (PID ${pid})`)

    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
          stdio: 'ignore',
        })
      } else {
        entry.process.kill('SIGTERM')
      }
    } catch {
      // Already dead
    }
  }

  /**
   * Fallback: kill whatever is listening on a port.
   * Handles cases where our tracked PID is stale but the process is still running.
   */
  private killByPort(port: number): void {
    try {
      if (process.platform === 'win32') {
        // Find PIDs listening on this port and kill them
        const result = spawn('cmd', ['/c', `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port} ^| findstr LISTENING') do taskkill /pid %a /f /t`], {
          stdio: 'ignore',
          shell: false,
        })
        result.on('error', () => { /* ignore */ })
      }
    } catch {
      // Best-effort
    }
  }

  /**
   * Get the status of a project's dev server.
   * Verifies the process is actually alive, not just tracked.
   */
  getStatus(projectId: string, config?: ProjectDevServer): DevServerInfo {
    const entry = this.processes.get(projectId)
    const tailscalePort = config?.tailscalePort ?? entry?.config.tailscalePort ?? 443
    const port = config?.port ?? entry?.config.port ?? 0
    const mapped = port > 0 ? !!hasServeMapping(port, tailscalePort) : false

    if (entry && !entry.exited) {
      // Double-check: if the process has no PID or the exitCode is set, it's dead
      if (entry.process.pid === undefined || entry.process.exitCode !== null) {
        entry.exited = true
        this.processes.delete(projectId)
      } else {
        return {
          status: 'running',
          port: entry.config.port,
          tailscalePort,
          url: buildTailscaleUrl(tailscalePort),
          tailscaleMapped: mapped,
        }
      }
    }

    return {
      status: 'stopped',
      port,
      tailscalePort,
      url: buildTailscaleUrl(tailscalePort),
      tailscaleMapped: mapped,
    }
  }

  /**
   * Shut down all running dev servers.
   */
  async shutdownAll(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const projectId of [...this.processes.keys()]) {
      promises.push(this.stopAndWait(projectId))
    }
    await Promise.all(promises)
  }
}
