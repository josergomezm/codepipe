import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { randomUUID } from 'crypto'
import { mkdir } from 'fs/promises'
import { log } from '../logger.js'

/** Allowed MIME types for uploads. */
const ALLOWED_MIME_TYPES = new Set([
  // Images (supported by Kiro CLI)
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // Documents
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
])

/** Max file size: 10MB (matches Kiro CLI's image limit). */
const MAX_FILE_SIZE = 10 * 1024 * 1024

export interface UploadedFile {
  id: string
  filename: string
  mimeType: string
  size: number
  path: string
}

export function createUploadRoutes(uploadsDir: string): Router {
  const router = Router()

  // Configure multer with disk storage
  const storage = multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await mkdir(uploadsDir, { recursive: true })
        cb(null, uploadsDir)
      } catch (err) {
        cb(err as Error, uploadsDir)
      }
    },
    filename: (_req, file, cb) => {
      // Preserve original extension, use UUID for uniqueness
      const ext = path.extname(file.originalname) || ''
      cb(null, `${randomUUID()}${ext}`)
    },
  })

  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
        cb(null, true)
      } else {
        cb(new Error(`Unsupported file type: ${file.mimetype}`))
      }
    },
  })

  /**
   * POST /api/upload
   * Accepts a single file via multipart form data (field name: "file").
   * Returns the uploaded file metadata including the host filesystem path.
   */
  router.post('/', upload.single('file'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' })
      return
    }

    const result: UploadedFile = {
      id: path.basename(req.file.filename, path.extname(req.file.filename)),
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      path: path.resolve(req.file.path),
    }

    log.info('upload', `Uploaded: ${result.filename} (${result.mimeType}, ${result.size} bytes) → ${result.path}`)
    res.status(201).json(result)
  })

  // Error handling for multer errors
  router.use((err: Error, _req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }, _next: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` })
        return
      }
      res.status(400).json({ error: err.message })
      return
    }
    if (err.message?.startsWith('Unsupported file type')) {
      res.status(415).json({ error: err.message })
      return
    }
    log.error('upload', 'Upload error', err)
    res.status(500).json({ error: 'Upload failed' })
  })

  return router
}
