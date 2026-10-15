import type { Project } from './schemas.js'
import type { IStorageLayer } from './storage.js'
import { readPortsFile, type PortsFile } from './ports-file.js'
import { applyFirebasePorts, detectFirebaseEmulators } from './services/firebase-detector.js'

/**
 * Bring a project's stored ports in line with what the repo declares: the
 * emulator ports on its firebase-emulators services (ports.json, else
 * firebase.json), and — when the repo has ports.json — the dev server's
 * local and Tailscale ports. Writes only when something changed.
 */
export async function refreshProjectPorts(
  storage: IStorageLayer,
  project: Project,
): Promise<{ project: Project; portsFile: PortsFile | null }> {
  const portsFile = await readPortsFile(project.path)
  const updates: Partial<Omit<Project, 'id'>> = {}

  const devServer = devServerFromPortsFile(project.devServer, portsFile)
  if (devServer) updates.devServer = devServer

  if ((project.services ?? []).some((s) => s.type === 'firebase-emulators')) {
    const services = applyFirebasePorts(project.services, await detectFirebaseEmulators(project.path))
    if (services) updates.services = services
  }

  if (Object.keys(updates).length === 0) return { project, portsFile }
  return { project: await storage.updateProject(project.id, updates), portsFile }
}

/**
 * The dev server config with ports.json's app.vite / app.tailscale applied,
 * or null when ports.json doesn't change it. A project without a dev server
 * config stays without one — ports.json can't supply the start command.
 */
export function devServerFromPortsFile(
  devServer: Project['devServer'],
  portsFile: PortsFile | null,
): Project['devServer'] | null {
  if (!devServer || !portsFile) return null
  const port = portsFile.app['vite'] ?? devServer.port
  const tailscalePort = portsFile.app['tailscale'] ?? devServer.tailscalePort
  if (port === devServer.port && tailscalePort === devServer.tailscalePort) return null
  return { ...devServer, port, tailscalePort }
}
