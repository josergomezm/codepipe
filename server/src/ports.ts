import { execSync } from 'child_process'
import { getServeStatus } from './tailscale.js'
import type { RunningService } from './service-manager.js'

// ---------------------------------------------------------------------------
// Central port registry
//
// Single source of truth for which ports CodePipe reserves for itself, who
// owns each active Tailscale Serve mapping, and whether a requested port
// combination conflicts with anything. Used by the project routes (save-time
// validation + registry endpoint) and the dev server manager (start-time
// guard) so a misconfigured project can never clobber an existing mapping.
// ---------------------------------------------------------------------------

export const CODEPIPE_FRONTEND_PORT = 5552
/** Tailscale HTTPS port that serves the CodePipe frontend itself. */
export const CODEPIPE_TAILSCALE_PORT = 443

export function getCodePipeBackendPort(): number {
  return Number(process.env['PORT'] ?? 5551)
}

export interface ProjectPortInfo {
  id: string
  name: string
  devServer?: { port: number; tailscalePort?: number }
}

export interface ReservedPort {
  port: number
  type: 'local'
  owner: string
}

export interface RegistryMapping {
  tailscalePort: number
  localPort: number
  owner: string
}

export interface PortRegistry {
  reserved: ReservedPort[]
  tailscaleMappings: RegistryMapping[]
}

export interface PortConflict {
  port: number
  type: 'local' | 'tailscale'
  owner: string
}

/** Thrown when starting a dev server would clobber an existing port/mapping. */
export class PortConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortConflictError'
  }
}

/**
 * Build the port registry shipped to the client: CodePipe's own reserved
 * ports, extra runtime reservations (e.g. running Firebase emulators), plus
 * every active Tailscale Serve mapping with its identified owner.
 */
export function buildPortRegistry(projects: ProjectPortInfo[], extraReserved: ReservedPort[] = []): PortRegistry {
  return {
    reserved: [
      { port: getCodePipeBackendPort(), type: 'local', owner: 'CodePipe Backend' },
      { port: CODEPIPE_FRONTEND_PORT, type: 'local', owner: 'CodePipe Frontend' },
      ...extraReserved,
    ],
    tailscaleMappings: getServeStatus().mappings.map((m) => ({
      tailscalePort: m.tailscalePort,
      localPort: m.localPort,
      owner: identifyMappingOwner(m.localPort, m.tailscalePort, projects),
    })),
  }
}

/**
 * Identify the owner of a Tailscale Serve mapping by matching it against
 * CodePipe's own ports and known projects' devServer configs.
 */
export function identifyMappingOwner(
  localPort: number,
  tailscalePort: number,
  projects: ProjectPortInfo[],
): string {
  if (localPort === CODEPIPE_FRONTEND_PORT || localPort === getCodePipeBackendPort()) {
    return 'CodePipe'
  }

  for (const project of projects) {
    if (!project.devServer) continue
    const ds = project.devServer
    if (ds.port === localPort) {
      // If the project specifies a tailscalePort, verify it matches
      if (ds.tailscalePort !== undefined && ds.tailscalePort !== tailscalePort) continue
      return project.name
    }
  }

  return 'Unknown'
}

/**
 * Check whether a local port + Tailscale port combination would conflict with
 * CodePipe's own ports, another project's configured dev server, or an active
 * Tailscale Serve mapping. A missing tailscalePort is treated as 443, which
 * always conflicts — 443 is CodePipe's own frontend.
 *
 * Returns an array of conflicts (empty = safe to use).
 */
export function checkPortConflicts(
  localPort: number,
  tailscalePort: number | undefined,
  projects: ProjectPortInfo[],
  excludeProjectId?: string,
  extraReserved: ReservedPort[] = [],
): PortConflict[] {
  const conflicts: PortConflict[] = []
  const seen = new Set<string>()
  const add = (c: PortConflict) => {
    const key = `${c.type}:${c.port}`
    if (!seen.has(key)) {
      seen.add(key)
      conflicts.push(c)
    }
  }

  const backendPort = getCodePipeBackendPort()
  const tsPort = tailscalePort ?? CODEPIPE_TAILSCALE_PORT

  // CodePipe's own local ports
  if (localPort === backendPort) {
    add({ port: localPort, type: 'local', owner: 'CodePipe Backend' })
  }
  if (localPort === CODEPIPE_FRONTEND_PORT) {
    add({ port: localPort, type: 'local', owner: 'CodePipe Frontend' })
  }

  // Runtime reservations (e.g. ports held by running Firebase emulators)
  for (const r of extraReserved) {
    if (r.port === localPort) {
      add({ port: localPort, type: 'local', owner: r.owner })
    }
  }

  // 443 (explicit or implicit default) is CodePipe's own Tailscale mapping
  if (tsPort === CODEPIPE_TAILSCALE_PORT) {
    add({ port: tsPort, type: 'tailscale', owner: 'CodePipe Frontend' })
  }

  // Other projects' configured dev servers
  for (const project of projects) {
    if (project.id === excludeProjectId) continue
    if (!project.devServer) continue
    const ds = project.devServer

    if (ds.port === localPort) {
      add({ port: localPort, type: 'local', owner: project.name })
    }
    if ((ds.tailscalePort ?? CODEPIPE_TAILSCALE_PORT) === tsPort) {
      add({ port: tsPort, type: 'tailscale', owner: project.name })
    }
  }

  // Active Tailscale Serve mappings (catches external tools and stale serves
  // that no project config knows about)
  const excludedProject = projects.find((p) => p.id === excludeProjectId)
  for (const m of getServeStatus().mappings) {
    // A mapping that already points this Tailscale port at this local port is
    // exactly what we want — not a conflict.
    if (m.tailscalePort === tsPort && m.localPort === localPort) continue

    if (m.tailscalePort === tsPort) {
      const owner = identifyMappingOwner(m.localPort, m.tailscalePort, projects)
      if (owner === excludedProject?.name) continue
      add({
        port: tsPort,
        type: 'tailscale',
        owner: owner === 'Unknown' ? `an active Tailscale mapping (→ :${m.localPort})` : owner,
      })
    }
  }

  return conflicts
}

/** Render conflicts as a single human-readable error message. */
export function formatConflicts(conflicts: PortConflict[]): string {
  return conflicts
    .map((c) => `${c.type === 'local' ? 'Local port' : 'Tailscale port'} ${c.port} is already used by ${c.owner}`)
    .join('. ')
}

/**
 * Convert running services' live ports (parsed from their stdout, e.g.
 * Firebase emulator table) into runtime port reservations.
 */
export function servicePortsAsReserved(running: RunningService[], projects: ProjectPortInfo[]): ReservedPort[] {
  const out: ReservedPort[] = []
  for (const svc of running) {
    const projectName = projects.find((p) => p.id === svc.projectId)?.name ?? 'another project'
    for (const [name, info] of Object.entries(svc.state.ports)) {
      out.push({ port: info.port, type: 'local', owner: `${projectName} — ${svc.label} (${name})` })
    }
  }
  return out
}

/**
 * Best-effort name for whoever holds a local port: CodePipe itself, a runtime
 * reservation (running service), or a project's configured dev server.
 */
export function identifyLocalPortOwner(
  port: number,
  projects: ProjectPortInfo[],
  extraReserved: ReservedPort[] = [],
): string {
  if (port === getCodePipeBackendPort()) return 'CodePipe Backend'
  if (port === CODEPIPE_FRONTEND_PORT) return 'CodePipe Frontend'
  const reserved = extraReserved.find((r) => r.port === port)
  if (reserved) return reserved.owner
  const project = projects.find((p) => p.devServer?.port === port)
  if (project) return `${project.name} (dev server)`
  return 'another process'
}

/**
 * Check if a port is currently listening on localhost (127.0.0.1 / 0.0.0.0).
 * Filters out Tailscale's own listeners (100.x.x.x) to avoid false positives.
 */
export function isLocalPortListening(port: number): boolean {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -aon | findstr :${port} | findstr LISTENING`, {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      // Only count 127.0.0.1 or 0.0.0.0 bindings — not Tailscale interface (100.x.x.x)
      return output.trim().split('\n').some((line) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith('TCP    127.0.0.1:') && !trimmed.startsWith('TCP    0.0.0.0:')) return false
        const localAddr = trimmed.split(/\s+/)[1]
        return localAddr?.endsWith(`:${port}`) ?? false
      })
    } else {
      const output = execSync(`ss -tlnp 2>/dev/null | grep :${port} || lsof -i :${port} -sTCP:LISTEN 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return output.trim().length > 0
    }
  } catch {
    return false
  }
}
