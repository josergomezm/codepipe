import { Router } from 'express'
import { existsSync } from 'fs'
import { readFile, readdir } from 'fs/promises'
import path from 'path'

import type { IStorageLayer } from '../storage.js'
import { CreateProjectRequestSchema, ProjectDevServerSchema } from '../schemas.js'
import { log } from '../logger.js'
import type { DevServerManager } from '../dev-server-manager.js'
import { getServeStatus, getTailscaleHostname } from '../tailscale.js'

/**
 * Create an Express Router for project CRUD endpoints.
 */
export function createProjectRoutes(storage: IStorageLayer, devServerManager: DevServerManager): Router {
  const router = Router()

  // GET /api/projects — list all projects
  router.get('/', async (_req, res) => {
    try {
      const projects = await storage.listProjects()
      const hostname = getTailscaleHostname()
      // Attach runtime dev server status to each project
      const result = projects.map((p) => ({
        ...p,
        devServerStatus: p.devServer
          ? devServerManager.getStatus(p.id, p.devServer)
          : null,
      }))
      res.json({ projects: result, tailscaleHostname: hostname })
    } catch (err) {
      log.error('api', 'Failed to list projects', err)
      res.status(500).json({ error: 'Failed to list projects' })
    }
  })

  // POST /api/projects — add a project
  router.post('/', async (req, res) => {
    const parsed = CreateProjectRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }

    const { name, path: projectPath } = parsed.data

    // Path traversal check: reject paths containing '..'
    if (projectPath.includes('..')) {
      res.status(400).json({ error: 'Path must not contain ".."' })
      return
    }

    // Validate path is absolute (works on both POSIX and Windows)
    if (!path.isAbsolute(projectPath)) {
      res.status(400).json({ error: 'Path must be absolute' })
      return
    }

    // Validate path exists on disk
    if (!existsSync(projectPath)) {
      res.status(400).json({ error: 'Path does not exist on disk' })
      return
    }

    try {
      const project = await storage.addProject({ name, path: projectPath })
      res.status(201).json(project)
    } catch (err) {
      log.error('api', 'Failed to add project', err)
      res.status(500).json({ error: 'Failed to add project' })
    }
  })

  // PATCH /api/projects/:id — update a project (name, devServer config, etc.)
  router.patch('/:id', async (req, res) => {
    const { id } = req.params

    try {
      const project = await storage.getProject(id)
      if (!project) {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      const updates: Record<string, unknown> = {}

      if (req.body.name !== undefined) {
        if (typeof req.body.name !== 'string' || req.body.name.length === 0) {
          res.status(400).json({ error: 'Name must be a non-empty string' })
          return
        }
        updates.name = req.body.name
      }

      if (req.body.devServer !== undefined) {
        if (req.body.devServer === null) {
          updates.devServer = undefined
        } else {
          const parsed = ProjectDevServerSchema.safeParse(req.body.devServer)
          if (!parsed.success) {
            res.status(400).json({ error: parsed.error.format() })
            return
          }
          updates.devServer = parsed.data
        }
      }

      const updated = await storage.updateProject(id, updates)
      res.json(updated)
    } catch (err) {
      log.error('api', `Failed to update project ${id}`, err)
      res.status(500).json({ error: 'Failed to update project' })
    }
  })

  // DELETE /api/projects/:id — remove a project
  router.delete('/:id', async (req, res) => {
    const { id } = req.params

    try {
      const project = await storage.getProject(id)
      if (!project) {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      // Stop dev server if running
      devServerManager.stop(id)

      await storage.removeProject(id)
      res.json({ ok: true })
    } catch (err) {
      log.error('api', `Failed to remove project ${id}`, err)
      res.status(500).json({ error: 'Failed to remove project' })
    }
  })

  // --- Dev Server Lifecycle ---

  // POST /api/projects/:id/dev-server/start
  router.post('/:id/dev-server/start', async (req, res) => {
    const { id } = req.params

    try {
      const project = await storage.getProject(id)
      if (!project) {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      if (!project.devServer) {
        res.status(400).json({ error: 'No dev server configured for this project' })
        return
      }

      const info = await devServerManager.start(id, project.path, project.devServer)
      res.json(info)
    } catch (err) {
      log.error('api', `Failed to start dev server for project ${id}`, err)
      res.status(500).json({ error: 'Failed to start dev server' })
    }
  })

  // POST /api/projects/:id/dev-server/stop
  router.post('/:id/dev-server/stop', async (req, res) => {
    const { id } = req.params

    const stopped = await devServerManager.stop(id)
    if (!stopped) {
      // Even if we don't have it tracked, report success —
      // the user's intent is "make it not running" which is already true
      res.json({ ok: true, wasRunning: false })
      return
    }

    res.json({ ok: true, wasRunning: true })
  })

  // GET /api/projects/:id/dev-server/status
  router.get('/:id/dev-server/status', async (req, res) => {
    const { id } = req.params

    try {
      const project = await storage.getProject(id)
      if (!project) {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      const info = devServerManager.getStatus(id, project.devServer ?? undefined)
      res.json(info)
    } catch (err) {
      log.error('api', `Failed to get dev server status for project ${id}`, err)
      res.status(500).json({ error: 'Failed to get dev server status' })
    }
  })

  // GET /api/projects/:id/detect-dev-server — auto-detect dev server config
  router.get('/:id/detect-dev-server', async (req, res) => {
    const { id } = req.params

    try {
      const project = await storage.getProject(id)
      if (!project) {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      const suggestion = await detectDevServerConfig(project.path)
      res.json(suggestion)
    } catch (err) {
      log.error('api', `Failed to detect dev server for project ${id}`, err)
      res.status(500).json({ error: 'Failed to detect dev server config' })
    }
  })

  return router
}

// ---------------------------------------------------------------------------
// Dev server auto-detection
// ---------------------------------------------------------------------------

type PackageManager = 'npm' | 'bun' | 'pnpm' | 'yarn'

interface DetectedDevServer {
  /** Resolved start command (derived from packageManager + script) */
  startCommand: string | null
  /** Detected package manager */
  packageManager: PackageManager | null
  /** Best script to use (dev:remote > dev > start) */
  script: string | null
  /** All available scripts from package.json */
  availableScripts: string[]
  /** Subdirectory containing the package.json (null = root) */
  subDir: string | null
  port: number | null
  tailscalePort: number | null
  framework: string | null
}

/**
 * Detect which package manager a project uses by checking lockfiles.
 */
function detectPackageManager(dir: string): PackageManager {
  if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock'))) return 'bun'
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/**
 * Build a run command from package manager + script name + optional prefix.
 */
function buildRunCommand(pm: PackageManager, script: string, subDir: string | null): string {
  const run = pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`
  if (subDir) {
    if (pm === 'npm') return `${run} --prefix ${subDir}`
    return `${run} --cwd ${subDir}`
  }
  return run
}

/**
 * Scan a project directory to detect dev server configuration.
 * Searches root and all immediate subdirectories for a package.json with dev:remote.
 */
async function detectDevServerConfig(projectPath: string): Promise<DetectedDevServer> {
  const result: DetectedDevServer = {
    startCommand: null,
    packageManager: null,
    script: null,
    availableScripts: [],
    subDir: null,
    port: null,
    tailscalePort: null,
    framework: null,
  }

  // Find all package.json files: root + immediate subdirectories
  const candidates = await findPackageJsons(projectPath)

  // Priority: prefer the one with dev:remote, then dev, then start
  let bestCandidate: { pkg: Record<string, unknown>; dir: string; subDir: string | null } | null = null

  for (const candidate of candidates) {
    const scripts = (candidate.pkg.scripts ?? {}) as Record<string, string>
    if (scripts['dev:remote']) {
      bestCandidate = candidate
      break // dev:remote is our convention — stop searching
    }
    if (!bestCandidate && (scripts['dev'] || scripts['start'])) {
      bestCandidate = candidate
    }
  }

  if (!bestCandidate) return result

  const { pkg, dir: pkgDir, subDir } = bestCandidate
  result.subDir = subDir

  // Detect package manager (check root for lockfile first, then pkg dir)
  const rootPm = detectPackageManager(projectPath)
  const pm = rootPm !== 'npm' ? rootPm : detectPackageManager(pkgDir)
  result.packageManager = pm

  // Collect scripts
  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  result.availableScripts = Object.keys(scripts)

  // Pick the best script
  if (scripts['dev:remote']) {
    result.script = 'dev:remote'
  } else if (scripts['dev']) {
    result.script = 'dev'
  } else if (scripts['start']) {
    result.script = 'start'
  }

  if (result.script) {
    result.startCommand = buildRunCommand(pm, result.script, subDir)
  }

  // Detect framework from dependencies
  const deps = {
    ...(pkg.dependencies ?? {}) as Record<string, string>,
    ...(pkg.devDependencies ?? {}) as Record<string, string>,
  }

  if (deps['vite'] || deps['@vitejs/plugin-vue'] || deps['@vitejs/plugin-react']) {
    result.framework = 'vite'
  } else if (deps['next']) {
    result.framework = 'next'
  } else if (deps['nuxt']) {
    result.framework = 'nuxt'
  } else if (deps['@angular/cli']) {
    result.framework = 'angular'
  } else if (deps['svelte'] || deps['@sveltejs/kit']) {
    result.framework = 'sveltekit'
  }

  // Detect port
  const port = await detectPort(pkgDir, scripts)
  if (port) result.port = port

  // If the best candidate didn't have dev:remote, check ALL candidates
  // to see if any of them do (might be in a different subfolder)
  if (!result.availableScripts.includes('dev:remote')) {
    for (const candidate of candidates) {
      const otherScripts = (candidate.pkg.scripts ?? {}) as Record<string, string>
      if (otherScripts['dev:remote']) {
        result.availableScripts = [...new Set([...result.availableScripts, 'dev:remote'])]
        // Update subDir and command to point to the right place
        result.subDir = candidate.subDir
        result.script = 'dev:remote'
        result.startCommand = buildRunCommand(pm, 'dev:remote', candidate.subDir)
        // Re-detect port from the correct directory
        const portFromCorrect = await detectPort(candidate.dir, otherScripts)
        if (portFromCorrect) result.port = portFromCorrect
        break
      }
    }
  }

  // Detect Tailscale port mapping
  if (result.port) {
    const tsPort = detectTailscalePort(result.port)
    if (tsPort) result.tailscalePort = tsPort
  }

  return result
}

/**
 * Find all package.json files in a project: root + all immediate subdirectories.
 * Skips node_modules, .git, and hidden directories.
 */
async function findPackageJsons(projectPath: string): Promise<Array<{ pkg: Record<string, unknown>; dir: string; subDir: string | null }>> {
  const results: Array<{ pkg: Record<string, unknown>; dir: string; subDir: string | null }> = []

  // Check root
  const rootPkg = path.join(projectPath, 'package.json')
  if (existsSync(rootPkg)) {
    try {
      const raw = await readFile(rootPkg, 'utf-8')
      results.push({ pkg: JSON.parse(raw), dir: projectPath, subDir: null })
    } catch {
      // Invalid JSON
    }
  }

  // Scan immediate subdirectories
  try {
    const entries = await readdir(projectPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Skip known non-project directories
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue

      const subPkgPath = path.join(projectPath, entry.name, 'package.json')
      if (existsSync(subPkgPath)) {
        try {
          const raw = await readFile(subPkgPath, 'utf-8')
          results.push({ pkg: JSON.parse(raw), dir: path.join(projectPath, entry.name), subDir: entry.name })
        } catch {
          // Invalid JSON — skip
        }
      }
    }
  } catch {
    // Can't read directory
  }

  return results
}

/**
 * Detect the dev server port from config files or scripts.
 */
async function detectPort(dir: string, scripts: Record<string, string>): Promise<number | null> {
  for (const configFile of ['vite.config.ts', 'vite.config.js', 'vite.config.mts']) {
    const configPath = path.join(dir, configFile)
    if (existsSync(configPath)) {
      try {
        const content = await readFile(configPath, 'utf-8')
        const portMatch = /port\s*:\s*(\d+)/.exec(content)
        if (portMatch) return parseInt(portMatch[1])
      } catch {
        // Skip
      }
    }
  }

  // Try to extract port from the script command
  const devScript = scripts['dev:remote'] ?? scripts['dev'] ?? ''
  const scriptPortMatch = /--port\s+(\d+)|-p\s+(\d+)|PORT=(\d+)/.exec(devScript)
  if (scriptPortMatch) {
    const p = scriptPortMatch[1] ?? scriptPortMatch[2] ?? scriptPortMatch[3]
    return parseInt(p)
  }

  return null
}

/**
 * Find which Tailscale HTTPS port proxies to a given local port.
 */
function detectTailscalePort(localPort: number): number | null {
  const status = getServeStatus()
  const mapping = status.mappings.find((m) => m.localPort === localPort)
  return mapping?.tailscalePort ?? null
}
