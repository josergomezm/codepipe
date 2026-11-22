import { Router, type Response } from 'express'
import { promises as fs } from 'fs'
import type { IStorageLayer } from '../storage.js'
import { indexMedia, listDir, MEDIA_KINDS, PathOutsideProjectError, resolveInProject, type FileKind } from '../project-files.js'
import { log } from '../logger.js'

type P = { id: string }

function fail(res: Response, err: unknown, what: string, id: string): void {
  if (err instanceof PathOutsideProjectError) { res.status(403).json({ error: err.message }); return }
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') { res.status(404).json({ error: 'Not found' }); return }
  if (code === 'EACCES' || code === 'EPERM') { res.status(403).json({ error: 'Permission denied' }); return }
  log.error('api', `Failed to ${what} for project ${id}`, err)
  res.status(500).json({ error: `Failed to ${what}` })
}

/** Read-only project files for the Files tab: /api/projects/:id/files */
export function createFilesRoutes(storage: IStorageLayer): Router {
  const router = Router({ mergeParams: true })

  async function projectRoot(id: string, res: Response): Promise<string | null> {
    const project = await storage.getProject(id)
    if (!project) { res.status(404).json({ error: 'Project not found' }); return null }
    return project.path
  }

  // GET /api/projects/:id/files?path=<dir> — one folder's entries
  router.get('/', async (req, res) => {
    const { id } = req.params as unknown as P
    try {
      const root = await projectRoot(id, res)
      if (!root) return
      res.json(await listDir(root, typeof req.query['path'] === 'string' ? req.query['path'] : ''))
    } catch (err) { fail(res, err, 'list files', id) }
  })

  // GET /api/projects/:id/files/media?kind=video,image — newest media first
  router.get('/media', async (req, res) => {
    const { id } = req.params as unknown as P
    const kinds = String(req.query['kind'] ?? '').split(',').filter((k): k is FileKind => (MEDIA_KINDS as string[]).includes(k))
    try {
      const root = await projectRoot(id, res)
      if (!root) return
      res.json(await indexMedia(root, { kinds }))
    } catch (err) { fail(res, err, 'index media', id) }
  })

  // GET /api/projects/:id/files/raw?path=<file> — the file itself (Range-capable,
  // so videos seek). Served as an attachment when ?download=1.
  router.get('/raw', async (req, res) => {
    const { id } = req.params as unknown as P
    const rel = req.query['path']
    if (typeof rel !== 'string' || !rel) { res.status(400).json({ error: 'path query parameter is required' }); return }
    try {
      const root = await projectRoot(id, res)
      if (!root) return
      const abs = await resolveInProject(root, rel)
      const st = await fs.stat(abs)
      if (!st.isFile()) { res.status(400).json({ error: 'Not a file' }); return }
      // Project HTML/SVG opened directly must not run script on our origin.
      // (Not applied to PDFs: Chrome's viewer refuses to render when sandboxed.)
      if (/\.(html?|xhtml|svg|xml)$/i.test(abs)) res.setHeader('Content-Security-Policy', 'sandbox')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (req.query['download']) res.attachment(abs.split(/[\\/]/).pop())
      res.sendFile(abs, { dotfiles: 'allow', cacheControl: true, maxAge: 0, lastModified: true }, (err) => {
        if (err && !res.headersSent) fail(res, err, 'read file', id)
      })
    } catch (err) { fail(res, err, 'read file', id) }
  })

  return router
}
