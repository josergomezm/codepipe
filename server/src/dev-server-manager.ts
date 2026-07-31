import { spawn, execSync, type ChildProcess } from 'child_process'
import { log } from './logger.js'
import type { ProjectDevServer } from './schemas.js'
import {
  buildTailscaleUrl,
  getTailscaleHostname,
  getServeStatus,
  hasServeMapping,
  createServeMapping,
  removeServeMapping,
  invalidateServeCache,
} from './tailscale.js'
import { PortConflictError, CODEPIPE_TAILSCALE_PORT, isLocalPortListening } from './ports.js'
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

    // 443 serves the CodePipe frontend itself — creating a mapping there
    // would replace it and take down remote access to CodePipe.
    if (tailscalePort === CODEPIPE_TAILSCALE_PORT) {
      throw new PortConflictError(
        'Tailscale port 443 is reserved by CodePipe. Set a dedicated Tailscale port (e.g. 8443) in project settings.',
      )
    }

    // Invalidate cache so we get fresh Tailscale state after a stop/restart cycle
    invalidateServeCache()

    // Ensure Tailscale Serve mapping exists
    const existingMapping = hasServeMapping(config.port, tailscalePort)
    if (!existingMapping) {
      // `tailscale serve` silently replaces whatever was mapped on this HTTPS
      // port — refuse instead of clobbering someone else's mapping.
      const clash = getServeStatus().mappings.find((m) => m.tailscalePort === tailscalePort)
      if (clash) {
        throw new PortConflictError(
          `Tailscale port ${tailscalePort} already proxies to local port ${clash.localPort}. Pick a different Tailscale port in project settings.`,
        )
      }
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
      log.info('dev-server', `[${projectId}] stdout: ${data.toString().trim()}`)
    })

    child.stderr?.on('data', (data: Buffer) => {
      log.info('dev-server', `[${projectId}] stderr: ${data.toString().trim()}`)
    })

    child.on('close', (exitCode) => {
      entry.exited = true
      log.info('dev-server', `Dev server for project ${projectId} exited with code ${exitCode}`)
      if (this.processes.get(projectId) === entry) {
        this.processes.delete(projectId)
      }
      // Remove Tailscale mapping so the URL doesn't serve a 502
      const tsPort = entry.config.tailscalePort ?? 443
      if (tsPort !== 443) {
        removeServeMapping(tsPort).catch(() => {})
      }
    })

    child.on('error', (err) => {
      entry.exited = true
      log.error('dev-server', `Dev server error for project ${projectId}`, err)
      if (this.processes.get(projectId) === entry) {
        this.processes.delete(projectId)
      }
      const tsPort = entry.config.tailscalePort ?? 443
      if (tsPort !== 443) {
        removeServeMapping(tsPort).catch(() => {})
      }
    })

    // Wait for the port to be ready or the process to die
    const ready = await this.waitForPort(config.port, entry)

    if (!ready) {
      log.warn('dev-server', `Dev server for project ${projectId} failed to start (port ${config.port} never became ready)`)
      // Clean up if process is still somehow tracked
      if (this.processes.get(projectId) === entry) {
        this.processes.delete(projectId)
      }
      this.killProcess(entry)
      // Mapping cleanup happens in the close handler
      return {
        status: 'stopped',
        port: config.port,
        tailscalePort,
        url: buildTailscaleUrl(tailscalePort),
        tailscaleMapped: false,
      }
    }

    return {
      status: 'running',
      port: config.port,
      tailscalePort,
      url: buildTailscaleUrl(tailscalePort),
      tailscaleMapped: true,
    }
  }

  /**
   * Stop a running dev server. Kills the process and removes the Tailscale mapping.
   */
  async stop(projectId: string): Promise<boolean> {
    const entry = this.processes.get(projectId)
    if (!entry) return false

    this.killProcess(entry)
    this.processes.delete(projectId)

    // Also try to kill anything on the configured port as a safety net
    // (handles case where our PID tracking lost the process)
    this.killByPort(entry.config.port)

    // Remove the Tailscale Serve mapping so the port isn't left dangling
    const tsPort = entry.config.tailscalePort ?? 443
    // Don't remove port 443 — that's CodePipe itself
    if (tsPort !== 443) {
      await removeServeMapping(tsPort)
    }

    return true
  }

  /**
   * Stop a running dev server and wait for the process to fully exit.
   * Also removes the Tailscale Serve mapping (same as stop()).
   */
  private async stopAndWait(projectId: string): Promise<void> {
    const entry = this.processes.get(projectId)
    if (!entry || entry.exited) {
      if (entry) this.processes.delete(projectId)
      return
    }

    this.processes.delete(projectId)

    await new Promise<void>((resolve) => {
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

    // Remove the Tailscale Serve mapping so the port isn't left dangling
    const tsPort = entry.config.tailscalePort ?? 443
    if (tsPort !== 443) {
      await removeServeMapping(tsPort)
    }
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
   * Fallback: kill whatever is listening on a port on localhost.
   * Handles cases where our tracked PID is stale but the process is still running.
   * Only targets 127.0.0.1 and 0.0.0.0 bindings to avoid killing tailscaled.
   */
  private killByPort(port: number): void {
    try {
      if (process.platform === 'win32') {
        const output = execSync(`netstat -aon | findstr :${port} | findstr LISTENING`, {
          encoding: 'utf-8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        const pids = new Set<string>()
        for (const line of output.trim().split('\n')) {
          const trimmed = line.trim()
          // Only match local bindings, not Tailscale interface
          if (!trimmed.startsWith('TCP    127.0.0.1:') && !trimmed.startsWith('TCP    0.0.0.0:')) continue
          // Verify the port is in the local address column (column format: TCP    addr:port    ...)
          const parts = trimmed.split(/\s+/)
          const localAddr = parts[1] // e.g. "0.0.0.0:30222"
          if (!localAddr?.endsWith(`:${port}`)) continue
          const pid = parts[4]
          if (pid && pid !== '0') pids.add(pid)
        }
        for (const pid of pids) {
          spawn('taskkill', ['/pid', pid, '/f', '/t'], { stdio: 'ignore' })
        }
      }
    } catch {
      // Best-effort
    }
  }

  /**
   * Get the status of a project's dev server.
   * Verifies the process is actually alive, not just tracked.
   * Also checks if the configured port is listening (catches externally-started servers).
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

    // Fallback: check if the port is actually listening (externally started server)
    if (port > 0 && this.isPortListening(port)) {
      return {
        status: 'running',
        port,
        tailscalePort,
        url: buildTailscaleUrl(tailscalePort),
        tailscaleMapped: mapped,
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
   * Wait for a port to start listening, or for the process to exit.
   */
  private waitForPort(port: number, entry: DevServerProcess, timeoutMs = 30000): Promise<boolean> {
    log.info('dev-server', `Waiting for port ${port} to be ready (timeout: ${timeoutMs}ms)`)
    return new Promise((resolve) => {
      const interval = 500
      let elapsed = 0
      const check = () => {
        if (entry.exited) {
          log.info('dev-server', `Process exited while waiting for port ${port} (after ${elapsed}ms)`)
          return resolve(false)
        }
        if (this.isPortListening(port)) {
          log.info('dev-server', `Port ${port} is ready (took ${elapsed}ms)`)
          return resolve(true)
        }
        elapsed += interval
        if (elapsed >= timeoutMs) {
          log.warn('dev-server', `Timeout waiting for port ${port} after ${timeoutMs}ms`)
          return resolve(false)
        }
        setTimeout(check, interval)
      }
      setTimeout(check, interval)
    })
  }

  /**
   * Check if a port is currently listening on localhost.
   * Delegates to the shared probe in ports.ts.
   */
  private isPortListening(port: number): boolean {
    return isLocalPortListening(port)
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
