import express from 'express'
import { createServer } from 'http'

import { StorageLayer } from './storage.js'
import { SessionManager } from './session-manager.js'
import { registerAdapter } from './adapters/registry.js'
import { KiroAdapter } from './adapters/kiro.js'
import { createSessionRoutes } from './routes/sessions.js'
import { createProjectRoutes } from './routes/projects.js'
import { createBrowseRoutes } from './routes/browse.js'
import { createUploadRoutes } from './routes/upload.js'
import { setupWebSocket } from './websocket.js'
import { log } from './logger.js'

// ---------------------------------------------------------------------------
// Initialize storage and session manager
// ---------------------------------------------------------------------------

const storage = new StorageLayer('./data')
await storage.ensureDataDir()

const sessionManager = new SessionManager(storage)

// ---------------------------------------------------------------------------
// Register CLI adapters
// ---------------------------------------------------------------------------

registerAdapter('kiro', () => new KiroAdapter())

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json())

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Mount REST routes
app.use('/api/sessions', createSessionRoutes(sessionManager, storage))
app.use('/api/projects', createProjectRoutes(storage))
app.use('/api/browse', createBrowseRoutes())
app.use('/api/upload', createUploadRoutes('./data/uploads'))

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const port = Number(process.env['PORT'] ?? 5551)

const server = createServer(app)
setupWebSocket(server, sessionManager, storage)

server.listen(port, '127.0.0.1', () => {
  log.info('server', `CodePipe server listening on http://127.0.0.1:${port}`)
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function gracefulShutdown(signal: string): Promise<void> {
  log.info('server', `Received ${signal}. Shutting down gracefully...`)

  try {
    await sessionManager.shutdown()
  } catch (err) {
    log.error('server', 'Error during session manager shutdown', err)
  }

  server.close(() => {
    log.info('server', 'Server closed')
    process.exit(0)
  })

  // Force exit after 5 seconds if graceful shutdown hangs
  setTimeout(() => {
    log.error('server', 'Forced exit after timeout')
    process.exit(1)
  }, 5000).unref()
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { app, server }
