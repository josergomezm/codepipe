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
import { ISOLATED_CHILD } from './child-options.js'

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
  exitCode: number | null
  /** Ports the server printed in its startup URLs ("Local: http://localhost:3000/"). */
  announcedPorts: Set<number>
}

/** The dev server never listened where CodePipe waits for it. */
export class DevServerStartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevServerStartError'
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const URL_PORT = /https?:\/\/(?:\[[^\]]*\]|[\w.-]+):(\d{2,5})/g

/** Ports in the URLs a chunk of dev server output prints. */
export function portsInOutput(text: string): number[] {
  return [...text.replace(ANSI, '').matchAll(URL_PORT)].map((m) => parseInt(m[1]))
}

/** Why a dev server that never listened on `port` failed, in words the user can act on. */
export function explainStartFailure(port: number, entry: { exited: boolean; exitCode: number | null; announcedPorts: Set<number> }): string {
  const others = [...entry.announcedPorts].filter((p) => p !== port)
  if (others.length > 0 && !entry.announcedPorts.has(port)) {
    return `The dev server came up on port ${others.join(', ')}, but CodePipe waits for port ${port} (ports.json app.vite, or the port in project settings). Its config isn't applying that port — Nuxt reads devServer.port, not vite.server.port. Re-run the remote setup from project settings.`
  }
  if (entry.announcedPorts.has(port)) {
    return `The dev server reported port ${port}, but nothing listened on 0.0.0.0:${port} or 127.0.0.1:${port} — it probably bound only to ::1 (localhost). Set its host to 0.0.0.0.`
  }
  if (entry.exited) {
    return `The dev server exited${entry.exitCode !== null ? ` with code ${entry.exitCode}` : ''} before it listened on port ${port}. Check the CodePipe server log for its output.`
  }
  return `The dev server didn't listen on port ${port} within 30 seconds. Check that it binds 0.0.0.0:${port}.`
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
   * Throws DevServerStartError when the server never listens on its port.
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
      ...ISOLATED_CHILD,
    })

    const entry: DevServerProcess = {
      process: child,
      projectId,
      config,
      projectPath,
      exited: false,
      exitCode: null,
      announcedPorts: new Set(),
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
      const text = data.toString()
      for (const p of portsInOutput(text)) entry.announcedPorts.add(p)
      log.info('dev-server', `[${projectId}] stdout: ${text.trim()}`)
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      for (const p of portsInOutput(text)) entry.announcedPorts.add(p)
      log.info('dev-server', `[${projectId}] stderr: ${text.trim()}`)
    })

    child.on('close', (exitCode) => {
      entry.exited = true
      entry.exitCode = exitCode
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
      throw new DevServerStartError(explainStartFailure(config.port, entry))
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
   *
   * Returns true if a tracked process existed. Independent of that, this always
   * frees the configured port: servers that fork a deep child (Nuxt's nuxi
   * re-spawns the real listener as a grandchild) or that outlived a backend
   * restart aren't reachable through our tracked PID, so killing by port is the
   * only reliable path. We wait for the port to actually clear before returning
   * so the caller isn't told "stopped" while the server is still listening.
   */
  async stop(projectId: string, config?: ProjectDevServer): Promise<boolean> {
    const entry = this.processes.get(projectId)
    const wasTracked = !!entry

    if (entry) {
      this.killProcess(entry)
      this.processes.delete(projectId)
    }

    // The port to free and the Tailscale mapping to remove come from the tracked
    // entry if we have one, otherwise from the config the caller passed in.
    const port = entry?.config.port ?? config?.port
    const tsPort = entry?.config.tailscalePort ?? config?.tailscalePort ?? 443

    if (port !== undefined && port > 0) {
      // Always run the port-based kill, even with nothing tracked, then confirm
      // the port is free — retrying the kill for anything the first pass missed.
      await this.killByPortAndWait(port)
    }

    // Remove the Tailscale Serve mapping so the port isn't left dangling.
    // Don't remove port 443 — that's CodePipe itself.
    if (tsPort !== 443) {
      await removeServeMapping(tsPort)
    }

    return wasTracked
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

    // The tracked tree exiting doesn't mean the port is free — a detached
    // grandchild (nuxi) can keep listening and block the restart.
    await this.killByPortAndWait(entry.config.port)

    // Remove the Tailscale Serve mapping so the port isn't left dangling
    const tsPort = entry.config.tailscalePort ?? 443
    if (tsPort !== 443) {
      await removeServeMapping(tsPort)
    }
  }

  /**
   * Last-resort, synchronous: kill every dev server's process tree right now.
   * For a crashing server — they run in their own consoles, so nothing else
   * would stop them, and they'd keep holding their ports after a restart.
   */
  killAllNow(): void {
    for (const entry of this.processes.values()) this.killProcess(entry)
  }

  /**
   * Kill a process and its tree.
   */
  private killProcess(entry: DevServerProcess): void {
    if (entry.exited) return

    const pid = entry.process.pid
    if (pid === undefined) return

    log.info('dev-server', `Killing dev server for project ${entry.projectId} (PID ${pid})`)

    if (process.platform === 'win32') {
      void this.taskkill(pid)
    } else {
      try {
        entry.process.kill('SIGTERM')
      } catch {
        // Already dead
      }
    }
  }

  /**
   * PIDs of processes listening on `port` on a local interface.
   * Skips the Tailscale interface (100.x / fd7a:…) so we never kill tailscaled.
   * Parses netstat by column rather than fixed spacing, and matches both IPv4
   * (0.0.0.0 / 127.0.0.1) and IPv6 loopback/any ([::] / [::1]) bindings.
   */
  private listPidsOnPort(port: number): Set<string> {
    const pids = new Set<string>()
    if (process.platform !== 'win32') return pids
    try {
      const output = execSync(`netstat -aon | findstr :${port} | findstr LISTENING`, {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...ISOLATED_CHILD,
      })
      for (const line of output.trim().split('\n')) {
        // Columns: Proto  LocalAddr  ForeignAddr  State  PID
        const parts = line.trim().split(/\s+/)
        if (parts[0] !== 'TCP') continue
        const localAddr = parts[1] ?? '' // e.g. "0.0.0.0:2999" or "[::]:2999"
        // The port is whatever follows the last colon in the local address.
        const lastColon = localAddr.lastIndexOf(':')
        if (lastColon < 0 || localAddr.slice(lastColon + 1) !== String(port)) continue
        const host = localAddr.slice(0, lastColon)
        // Only local bindings. Exclude the Tailscale interface explicitly.
        const isLocal =
          host === '0.0.0.0' ||
          host === '127.0.0.1' ||
          host === '[::]' ||
          host === '[::1]'
        if (!isLocal) continue
        const pid = parts[4]
        // Never kill ourselves, even if a stale config points at CodePipe's port.
        if (pid && pid !== '0' && pid !== String(process.pid)) pids.add(pid)
      }
    } catch {
      // Best-effort — findstr exits non-zero when nothing matches.
    }
    return pids
  }

  /**
   * Kill everything on `port`, then poll until it's actually free, retrying the
   * kill for anything that survived or was forked late — Nuxt's nuxi forks the
   * real listener as a grandchild that a single pass can race and miss.
   * Checks freedom with the same IPv4+IPv6 scan it kills from, so a leftover
   * [::] listener isn't mistaken for a free port.
   */
  private async killByPortAndWait(port: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const pids = this.listPidsOnPort(port)
      if (pids.size === 0) return true
      if (Date.now() >= deadline) {
        log.warn('dev-server', `Port ${port} still listening after stop (waited ${timeoutMs}ms): PID(s) ${[...pids].join(', ')}`)
        return false
      }
      log.info('dev-server', `Killing PID(s) ${[...pids].join(', ')} listening on port ${port}`)
      await Promise.all([...pids].map((pid) => this.taskkill(pid)))
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  /** Run `taskkill /pid <pid> /f /t` and resolve once it finishes. */
  private taskkill(pid: string | number): Promise<void> {
    if (process.platform !== 'win32') return Promise.resolve()
    return new Promise((resolve) => {
      const child = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore', ...ISOLATED_CHILD })
      child.on('close', () => resolve())
      child.on('error', () => resolve())
    })
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
