import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { randomUUID } from 'crypto'
import { mkdir, unlink } from 'fs/promises'
import { existsSync } from 'fs'

import type { IStorageLayer } from '../storage.js'
import { PersonaBodySchema, UpdatePersonaRequestSchema } from '../schemas.js'
import { log } from '../logger.js'

/** Avatar uploads: images only, small. */
const AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MAX_AVATAR_SIZE = 2 * 1024 * 1024

/**
 * Create an Express Router for persona CRUD + avatar upload.
 * Avatars are stored under `avatarsDir` and served at /api/avatars/<file>.
 */
export function createPersonaRoutes(storage: IStorageLayer, avatarsDir: string): Router {
  const router = Router()

  const upload = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        try {
          await mkdir(avatarsDir, { recursive: true })
          cb(null, avatarsDir)
        } catch (err) {
          cb(err as Error, avatarsDir)
        }
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname) || '.png'
        cb(null, `${randomUUID()}${ext}`)
      },
    }),
    limits: { fileSize: MAX_AVATAR_SIZE },
    fileFilter: (_req, file, cb) => {
      if (AVATAR_MIME_TYPES.has(file.mimetype)) cb(null, true)
      else cb(new Error(`Unsupported avatar type: ${file.mimetype}`))
    },
  })

  // GET /api/personas — the team roster
  router.get('/', async (_req, res) => {
    try {
      res.json(await storage.listPersonas())
    } catch (err) {
      log.error('api', 'Failed to list personas', err)
      res.status(500).json({ error: 'Failed to list personas' })
    }
  })

  // POST /api/personas — add a team member
  router.post('/', async (req, res) => {
    const parsed = PersonaBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }

    try {
      const persona = await storage.addPersona(parsed.data)
      res.status(201).json(persona)
    } catch (err) {
      log.error('api', 'Failed to add persona', err)
      res.status(500).json({ error: 'Failed to add persona' })
    }
  })

  // PATCH /api/personas/:id
  router.patch('/:id', async (req, res) => {
    const parsed = UpdatePersonaRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }

    try {
      const persona = await storage.updatePersona(req.params.id, parsed.data)
      res.json(persona)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update persona'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
        return
      }
      log.error('api', `Failed to update persona ${req.params.id}`, err)
      res.status(500).json({ error: 'Failed to update persona' })
    }
  })

  // DELETE /api/personas/:id — also removes the avatar file
  router.delete('/:id', async (req, res) => {
    try {
      const personas = await storage.listPersonas()
      const persona = personas.find((p) => p.id === req.params.id)
      await storage.removePersona(req.params.id)
      if (persona?.avatar) {
        const file = path.join(avatarsDir, path.basename(persona.avatar))
        if (existsSync(file)) await unlink(file).catch(() => {})
      }
      res.json({ ok: true })
    } catch (err) {
      log.error('api', `Failed to delete persona ${req.params.id}`, err)
      res.status(500).json({ error: 'Failed to delete persona' })
    }
  })

  // POST /api/personas/:id/avatar — upload/replace the profile picture
  router.post('/:id/avatar', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' })
      return
    }

    try {
      const personas = await storage.listPersonas()
      const existing = personas.find((p) => p.id === req.params.id)
      if (!existing) {
        await unlink(req.file.path).catch(() => {})
        res.status(404).json({ error: 'Persona not found' })
        return
      }

      // Replace: delete the previous avatar file if there was one.
      if (existing.avatar) {
        const old = path.join(avatarsDir, path.basename(existing.avatar))
        if (existsSync(old)) await unlink(old).catch(() => {})
      }

      const persona = await storage.updatePersona(String(req.params.id), {
        avatar: req.file.filename,
      })
      res.status(201).json(persona)
    } catch (err) {
      log.error('api', `Failed to set avatar for persona ${req.params.id}`, err)
      res.status(500).json({ error: 'Failed to set avatar' })
    }
  })

  // Multer error handling
  router.use((err: Error, _req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }, _next: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `Avatar too large. Maximum size is ${MAX_AVATAR_SIZE / 1024 / 1024}MB` })
        return
      }
      res.status(400).json({ error: err.message })
      return
    }
    if (err.message?.startsWith('Unsupported avatar type')) {
      res.status(415).json({ error: err.message })
      return
    }
    log.error('api', 'Avatar upload error', err)
    res.status(500).json({ error: 'Avatar upload failed' })
  })

  return router
}
