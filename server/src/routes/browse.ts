import { Router } from 'express'
import { existsSync, readdirSync, statSync } from 'fs'
import path from 'path'
import os from 'os'

/**
 * Create an Express Router for filesystem browsing (directory picker).
 */
export function createBrowseRoutes(): Router {
  const router = Router()

  // GET /api/browse?path=... — list directories at the given path
  router.get('/', (req, res) => {
    const requestedPath = req.query['path'] as string | undefined

    // Path traversal prevention
    if (requestedPath && requestedPath.includes('..')) {
      res.status(400).json({ error: 'Path must not contain ".."' })
      return
    }

    try {
      // No path provided — return root / drive listing
      if (!requestedPath) {
        const result = getRootListing()
        res.json(result)
        return
      }

      const resolved = path.resolve(requestedPath)

      if (!existsSync(resolved)) {
        res.status(404).json({ error: 'Path not found' })
        return
      }

      const stat = statSync(resolved)
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' })
        return
      }

      const entries = listDirectories(resolved)
      const parent = path.dirname(resolved)

      res.json({
        current: resolved,
        parent: parent === resolved ? null : parent,
        entries,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      // Permission denied
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' })
        return
      }

      console.error('Browse error:', err)
      res.status(500).json({ error: message })
    }
  })

  return router
}

/**
 * List subdirectories inside a given directory path.
 * Only returns directories, sorted alphabetically.
 */
function listDirectories(dirPath: string): { name: string; type: 'directory' }[] {
  const entries: { name: string; type: 'directory' }[] = []

  let dirEntries: string[]
  try {
    dirEntries = readdirSync(dirPath)
  } catch {
    return entries
  }

  for (const name of dirEntries) {
    // Skip hidden entries (dotfiles/dotfolders)
    if (name.startsWith('.')) continue

    try {
      const fullPath = path.join(dirPath, name)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        entries.push({ name, type: 'directory' })
      }
    } catch {
      // Skip entries we can't stat (permission denied, broken symlinks, etc.)
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/**
 * Return root listing. On Windows, enumerate available drive letters.
 * On POSIX, list directories under /.
 */
function getRootListing(): {
  current: string
  parent: string | null
  entries: { name: string; type: 'directory' }[]
} {
  if (os.platform() === 'win32') {
    const drives: { name: string; type: 'directory' }[] = []
    // Check drive letters A-Z
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code)
      const drivePath = `${letter}:\\`
      if (existsSync(drivePath)) {
        drives.push({ name: drivePath, type: 'directory' })
      }
    }
    return { current: '', parent: null, entries: drives }
  }

  // POSIX: list directories under /
  return {
    current: '/',
    parent: null,
    entries: listDirectories('/'),
  }
}
