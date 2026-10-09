// These two must stay the first imports, in this order: .env is loaded before
// any module reads its settings, then the crash handlers are installed before
// any other module's top-level code can throw.
import { SUPERVISED } from './env.js'
import './crash-guard.js'
import express from 'express'
import { createServer } from 'http'

import { StorageLayer } from './storage.js'
import { EventBus } from './events.js'
import { SessionManager } from './session-manager.js'
import { DevServerManager } from './dev-server-manager.js'
import { ServiceManager } from './service-manager.js'
import { registerAdapter } from './adapters/registry.js'
import { KiroAdapter } from './adapters/kiro.js'
import { KiroAcpAdapter } from './adapters/kiro-acp.js'
import { GeminiAdapter } from './adapters/gemini.js'
import { createChangesRoutes } from './routes/changes.js'
import { TerminalManager } from './terminal-manager.js'
import { createTerminalUpgradeHandler } from './terminal-ws.js'
import { ClaudeAdapter } from './adapters/claude.js'
import { createSessionRoutes } from './routes/sessions.js'
import { createProjectRoutes } from './routes/projects.js'
import { createServiceRoutes } from './routes/services.js'
import { createBrowseRoutes } from './routes/browse.js'
import { createUploadRoutes } from './routes/upload.js'
import { createTodoRoutes } from './routes/todos.js'
import { createActionRoutes } from './routes/actions.js'
import { DueReminderService } from './due-reminders.js'
import { createPersonaRoutes } from './routes/personas.js'
import { createStandupRoutes } from './routes/standup.js'
import { StandupService } from './standup.js'
import { setupWebSocket } from './websocket.js'
import { getProviderHealth } from './provider-health.js'
import { PushService } from './push.js'
import { createPushRoutes } from './routes/push.js'
import { log, setCrashContext } from './logger.js'
import { onFatal } from './crash-guard.js'
import { startHealthMonitor } from './health.js'
import { createDiagnosticsRoutes } from './routes/diagnostics.js'

// ---------------------------------------------------------------------------
// Initialize storage and session manager
// ---------------------------------------------------------------------------

// Change hints flow storage → bus → WebSocket subscribers; clients refetch.
const eventBus = new EventBus()

const storage = new StorageLayer('./data', (collection) => eventBus.publish(collection))
await storage.ensureDataDir()

// Web Push (disabled unless VAPID keys are set — see `npm run gen-vapid`).
const pushService = new PushService({ dataDir: './data' })
log.info('server', `Push notifications: ${pushService.isEnabled() ? 'enabled' : 'disabled (no VAPID keys)'}`)

const sessionManager = new SessionManager(storage, pushService)
const devServerManager = new DevServerManager()
const serviceManager = new ServiceManager()

// The proactive team layer: daily standups over the per-project todo list,
// routed through personas. Registers the team-turn hook on the session manager.
const standupService = new StandupService(storage, sessionManager, pushService)
// Daily push for action items due today or overdue.
const dueReminders = new DueReminderService(storage, pushService, { dataDir: './data' })

// ---------------------------------------------------------------------------
// Register CLI adapters
// ---------------------------------------------------------------------------

// Kiro transport is selectable: `KIRO_TRANSPORT=acp` uses the structured
// Agent Client Protocol path (recommended); anything else keeps the legacy
// non-interactive text-parsing adapter.
const useKiroAcp = (process.env['KIRO_TRANSPORT'] ?? '').toLowerCase() === 'acp'
registerAdapter('kiro', () => (useKiroAcp ? new KiroAcpAdapter() : new KiroAdapter()))
log.info('server', `Kiro transport: ${useKiroAcp ? 'acp' : 'non-interactive'}`)

// Antigravity CLI over stream-json (`agy -p --output-format stream-json`).
registerAdapter('gemini', () => new GeminiAdapter())

// Claude Code over stream-json (`claude -p --output-format stream-json`).
registerAdapter('claude', () => new ClaudeAdapter())

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json())

// Health check — reports server status plus per-provider binary availability,
// so clients can detect that, e.g., kiro-cli isn't installed before a session
// is created and fails opaquely.
app.get('/api/health', async (_req, res) => {
  try {
    res.json({ status: 'ok', providers: await getProviderHealth() })
  } catch (err) {
    log.error('api', 'Provider health check failed', err)
    res.json({ status: 'ok', providers: [] })
  }
})

// Mount REST routes
app.use('/api/sessions', createSessionRoutes(sessionManager, storage))
app.use('/api/projects', createProjectRoutes(storage, devServerManager, serviceManager))
app.use('/api/projects/:id/services', createServiceRoutes(storage, serviceManager))
app.use('/api/projects/:id/changes', createChangesRoutes(storage))
app.use('/api/browse', createBrowseRoutes())
app.use('/api/upload', createUploadRoutes('./data/uploads'))
app.use('/api/push', createPushRoutes(pushService))
app.use('/api/todos', createTodoRoutes(storage, standupService))
app.use('/api/actions', createActionRoutes(storage, standupService))
app.use('/api/personas', createPersonaRoutes(storage, './data/avatars'))
app.use('/api/avatars', express.static('./data/avatars', { maxAge: '1d' }))
app.use('/api/standup', createStandupRoutes(standupService, storage))
app.use('/api/diagnostics', createDiagnosticsRoutes(() => healthCounts()))

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = createServer(app)
const terminalManager = new TerminalManager()
setupWebSocket(server, sessionManager, storage, eventBus, {
  '/ws/terminal': createTerminalUpgradeHandler(storage, terminalManager),
})

/** What's running right now — for health samples, diagnostics and crash reports. */
function healthCounts(): Record<string, number> {
  return {
    ...sessionManager.getStats(),
    shells: terminalManager.shellCount(),
    runningServices: serviceManager.listRunning().length,
  }
}
setCrashContext(() => healthCounts())
// On a fatal crash, don't leave anything we started running untracked:
// agents, shells, dev servers and services all run in their own consoles.
onFatal(() => {
  sessionManager.killAllProcesses()
  terminalManager.killAll('server crashed')
  devServerManager.killAllNow()
  serviceManager.killAllNow()
})

// Only listen when running directly (not imported by tests)
const isMainModule = !process.env['VITEST']

if (isMainModule) {
  const port = Number(process.env['PORT'] ?? 5551)
  const host = process.env['HOST'] ?? '127.0.0.1'

  server.listen(port, host, () => {
    log.info('server', `CodePipe server listening on http://${host}:${port}`)
  })

  standupService.start()
  dueReminders.start()
  startHealthMonitor(healthCounts)
  log.info('server', `Started (pid ${process.pid}, node ${process.version}${SUPERVISED ? ', supervised' : ''})`)

  // Graceful shutdown
  let shuttingDown = false
  async function gracefulShutdown(signal: string): Promise<void> {
    // e.g. Ctrl+C and then closing the window: shut down once.
    if (shuttingDown) return
    shuttingDown = true
    log.info('server', `Received ${signal}. Shutting down gracefully...`)

    try {
      standupService.stop()
      dueReminders.stop()
      await devServerManager.shutdownAll()
      await serviceManager.shutdownAll()
      terminalManager.killAll()
      await sessionManager.shutdown()
    } catch (err) {
      log.error('server', 'Error during shutdown', err)
    }

    server.close(() => {
      log.info('server', 'Server closed')
      process.exit(0)
    })

    setTimeout(() => {
      log.error('server', 'Forced exit after timeout')
      process.exit(1)
    }, 5000).unref()
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  // Windows: SIGHUP is the console window being closed (or logoff), SIGBREAK
  // is Ctrl+Break. Without handlers the process is killed with no chance to
  // save the reply being streamed or archive chats.
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'))
  if (process.platform === 'win32') process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'))
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { app, server }
