import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import request from 'supertest'
import { createServer, type Server as HttpServer } from 'http'
import { WebSocket } from 'ws'

// ---------------------------------------------------------------------------
// Mock node-pty BEFORE importing SessionManager
// ---------------------------------------------------------------------------

/** Captured callbacks from the most recently spawned mock pty. */
let mockPtyOnDataCb: ((data: string) => void) | null = null
let mockPtyOnExitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null
let mockPtyWritten: string[] = []
let mockPtyKilled = false

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    mockPtyOnDataCb = null
    mockPtyOnExitCb = null
    mockPtyWritten = []
    mockPtyKilled = false

    return {
      onData(cb: (data: string) => void) {
        mockPtyOnDataCb = cb
        return { dispose: vi.fn() }
      },
      onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
        mockPtyOnExitCb = cb
        return { dispose: vi.fn() }
      },
      write(data: string) {
        mockPtyWritten.push(data)
      },
      kill() {
        mockPtyKilled = true
      },
      pid: 12345,
      cols: 120,
      rows: 40,
      process: 'mock-pty',
      handleFlowControl: false,
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      clear: vi.fn(),
    }
  }),
}))

// Import AFTER mock is set up (vitest hoists vi.mock, but imports must come after)
import { StorageLayer } from './storage.js'
import { SessionManager } from './session-manager.js'
import { registerAdapter, clearAdapters } from './adapters/registry.js'
import { KiroAdapter } from './adapters/kiro.js'
import { createSessionRoutes } from './routes/sessions.js'
import { createProjectRoutes } from './routes/projects.js'
import { setupWebSocket } from './websocket.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let storage: StorageLayer
let sessionManager: SessionManager
let app: express.Express
let httpServer: HttpServer
let serverPort: number

/**
 * Build a fresh Express app + HTTP server wired to a temp storage directory.
 * Returns the port the server is listening on.
 */
async function buildTestServer(): Promise<number> {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'integration-test-'))
  storage = new StorageLayer(tmpDir)
  await storage.ensureDataDir()

  sessionManager = new SessionManager(storage)

  clearAdapters()
  registerAdapter('kiro', () => new KiroAdapter())

  app = express()
  app.use(express.json())
  app.use('/api/sessions', createSessionRoutes(sessionManager, storage))
  app.use('/api/projects', createProjectRoutes(storage))

  httpServer = createServer(app)
  setupWebSocket(httpServer, sessionManager, storage)

  return new Promise<number>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve(port)
    })
  })
}

async function teardownTestServer(): Promise<void> {
  await sessionManager.shutdown()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()))
  })
  await rm(tmpDir, { recursive: true, force: true })
}

/** Add a test project to storage and return it. */
async function addTestProject(): Promise<{ id: string; name: string; path: string }> {
  return storage.addProject({ name: 'Test Project', path: '/tmp' })
}

/**
 * Helper: open a WebSocket, collecting all messages from the start.
 * Returns the socket and a function to wait for N messages.
 */
function connectWs(sessionId: string): Promise<{
  ws: WebSocket
  collectMessages: (count: number, timeoutMs?: number) => Promise<unknown[]>
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?sessionId=${sessionId}`)
    const allMessages: unknown[] = []
    let waitResolve: ((msgs: unknown[]) => void) | null = null
    let waitCount = 0

    // Start collecting messages immediately (before 'open' fires)
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Buffer.isBuffer(raw) ? raw.toString() : typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString()
      allMessages.push(JSON.parse(text))
      if (waitResolve && allMessages.length >= waitCount) {
        waitResolve(allMessages.slice(0, waitCount))
        waitResolve = null
      }
    })

    ws.on('open', () => {
      const collectMessages = (count: number, timeoutMs = 3000): Promise<unknown[]> => {
        if (allMessages.length >= count) {
          return Promise.resolve(allMessages.slice(0, count))
        }
        return new Promise((res, rej) => {
          waitCount = count
          const timer = setTimeout(() => {
            waitResolve = null
            rej(new Error(`Timed out waiting for ${count} messages, got ${allMessages.length}`))
          }, timeoutMs)
          waitResolve = (msgs) => {
            clearTimeout(timer)
            res(msgs)
          }
        })
      }
      resolve({ ws, collectMessages })
    })

    ws.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('Integration tests', () => {
  beforeEach(async () => {
    serverPort = await buildTestServer()
  })

  afterEach(async () => {
    await teardownTestServer()
  })


  // =========================================================================
  // 4.5.1 — Session creation via REST API with mocked pty
  // =========================================================================

  describe('4.5.1 — Session creation via REST API', () => {
    it('POST /api/sessions with valid provider + projectId returns 201 with session', async () => {
      const project = await addTestProject()

      const res = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })

      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({
        provider: 'kiro',
        projectId: project.id,
        status: 'live',
        messages: [],
      })
      expect(res.body.id).toBeDefined()
      expect(res.body.createdAt).toBe(res.body.updatedAt)
    })

    it('session is persisted to storage after creation', async () => {
      const project = await addTestProject()

      const res = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })

      expect(res.status).toBe(201)

      // Verify session is retrievable via GET
      const getRes = await request(app).get(`/api/sessions/${res.body.id}`)
      expect(getRes.status).toBe(200)
      expect(getRes.body.id).toBe(res.body.id)
      expect(getRes.body.status).toBe('live')
    })

    it('session appears in session list', async () => {
      const project = await addTestProject()

      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })

      const listRes = await request(app).get('/api/sessions')
      expect(listRes.status).toBe(200)
      expect(listRes.body).toHaveLength(1)
      expect(listRes.body[0].id).toBe(createRes.body.id)
      // SessionMeta should not include messages
      expect(listRes.body[0].messages).toBeUndefined()
    })
  })

  // =========================================================================
  // 4.5.2 — WebSocket connection and history replay
  // =========================================================================

  describe('4.5.2 — WebSocket connection and history replay', () => {
    it('client receives history and idle status on connect to live session', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      const { ws, collectMessages } = await connectWs(sessionId)
      try {
        const msgs = await collectMessages(2)

        // First message: history (empty for a new session)
        expect(msgs[0]).toMatchObject({ type: 'history', data: [] })
        // Second message: status idle
        expect(msgs[1]).toMatchObject({ type: 'status', data: 'idle' })
      } finally {
        ws.close()
      }
    })

    it('client receives error and socket closes for non-existent session', async () => {
      const { ws, collectMessages } = await connectWs('00000000-0000-0000-0000-000000000000')
      try {
        const msgs = await collectMessages(1)
        expect(msgs[0]).toMatchObject({ type: 'error', data: 'Session not found' })
      } finally {
        ws.close()
      }
    })
  })

  // =========================================================================
  // 4.5.3 — User input flow
  // =========================================================================

  describe('4.5.3 — User input flow', () => {
    it('sending input via WebSocket writes to pty and broadcasts user message', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      const { ws, collectMessages } = await connectWs(sessionId)
      try {
        // Consume the initial history + status messages
        await collectMessages(2)

        // Send user input
        ws.send(JSON.stringify({ type: 'input', data: 'hello' }))

        // Should receive a user message broadcast (message #3)
        const msgs = await collectMessages(3)
        const userMsg = msgs[2] as { type: string; data: { role: string; content: string } }
        expect(userMsg.type).toBe('message')
        expect(userMsg.data.role).toBe('user')
        expect(userMsg.data.content).toBe('hello')

        // Verify pty.write was called with 'hello\r' (carriage return for terminal)
        expect(mockPtyWritten).toContain('hello\r')
      } finally {
        ws.close()
      }
    })
  })

  // =========================================================================
  // 4.5.4 — Session deletion
  // =========================================================================

  describe('4.5.4 — Session deletion', () => {
    it('DELETE live session kills pty and returns ok', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      const delRes = await request(app).delete(`/api/sessions/${sessionId}`)
      expect(delRes.status).toBe(200)
      expect(delRes.body).toEqual({ ok: true })

      // Verify pty.kill() was called
      expect(mockPtyKilled).toBe(true)

      // Session should no longer be retrievable as live
      const getRes = await request(app).get(`/api/sessions/${sessionId}`)
      expect(getRes.status).toBe(404)
    })

    it('DELETE non-existent session returns ok (idempotent)', async () => {
      const delRes = await request(app).delete('/api/sessions/00000000-0000-0000-0000-000000000000')
      expect(delRes.status).toBe(200)
      expect(delRes.body).toEqual({ ok: true })
    })
  })

  // =========================================================================
  // 4.5.5 — Error cases
  // =========================================================================

  describe('4.5.5 — Error cases', () => {
    it('POST /api/sessions with invalid provider returns 400', async () => {
      const project = await addTestProject()
      const res = await request(app)
        .post('/api/sessions')
        .send({ provider: 'invalid-provider', projectId: project.id })

      expect(res.status).toBe(400)
    })

    it('POST /api/sessions with non-existent projectId returns 400', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: '00000000-0000-0000-0000-000000000000' })

      expect(res.status).toBe(400)
    })

    it('GET /api/sessions/:id for non-existent session returns 404', async () => {
      const res = await request(app).get('/api/sessions/00000000-0000-0000-0000-000000000000')
      expect(res.status).toBe(404)
    })

    it('POST /api/projects with path containing ".." returns 400', async () => {
      const res = await request(app)
        .post('/api/projects')
        .send({ name: 'Bad Project', path: '/tmp/../etc/passwd' })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('..')
    })

    it('POST /api/sessions with missing fields returns 400', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({})

      expect(res.status).toBe(400)
    })

    it('POST /api/projects with relative path returns 400', async () => {
      const res = await request(app)
        .post('/api/projects')
        .send({ name: 'Bad Project', path: 'relative/path' })

      expect(res.status).toBe(400)
    })
  })

  // =========================================================================
  // 4.5.6 — Session continuation (archived session reconnection)
  // =========================================================================

  describe('4.5.6 — Session continuation', () => {
    it('WebSocket to archived session (pty exited) sends exited status, not idle', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      // Simulate pty exit — session transitions to archived but stays in memory
      expect(mockPtyOnExitCb).toBeTruthy()
      mockPtyOnExitCb!({ exitCode: 0 })

      // Small delay for the async storage write to complete
      await new Promise((r) => setTimeout(r, 50))

      // Connect a new WebSocket to the now-archived session
      const { ws, collectMessages } = await connectWs(sessionId)
      try {
        const msgs = await collectMessages(2)

        // Should receive history (with the exit system message)
        expect(msgs[0]).toMatchObject({ type: 'history' })
        const history = (msgs[0] as { type: string; data: unknown[] }).data
        expect(history.length).toBeGreaterThan(0)

        // Should receive 'exited' status, NOT 'idle'
        expect(msgs[1]).toMatchObject({ type: 'status', data: 'exited' })
      } finally {
        ws.close()
      }
    })

    it('REST GET for archived session (pty exited) returns status archived', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      // Simulate pty exit
      mockPtyOnExitCb!({ exitCode: 0 })
      await new Promise((r) => setTimeout(r, 50))

      const getRes = await request(app).get(`/api/sessions/${sessionId}`)
      expect(getRes.status).toBe(200)
      expect(getRes.body.status).toBe('archived')
    })

    it('sending input to archived session triggers revival and spawns new pty', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      // Simulate pty exit
      mockPtyOnExitCb!({ exitCode: 0 })
      await new Promise((r) => setTimeout(r, 50))

      // Connect to the archived session
      const { ws, collectMessages } = await connectWs(sessionId)
      try {
        // Consume initial history + exited status
        const initial = await collectMessages(2)
        expect(initial[1]).toMatchObject({ type: 'status', data: 'exited' })

        // Send input — this should trigger session revival
        ws.send(JSON.stringify({ type: 'input', data: 'continue please' }))

        // Should receive an idle status (session revived) and eventually a
        // user message once the input is forwarded after the delay
        const msgs = await collectMessages(4, 8000)
        const types = (msgs as { type: string }[]).map((m) => m.type)

        // After revival: status idle, then the user message
        expect(types).toContain('status')
        const statusMsgs = (msgs as { type: string; data: unknown }[]).filter(
          (m) => m.type === 'status' && m.data === 'idle',
        )
        expect(statusMsgs.length).toBeGreaterThan(0)
      } finally {
        ws.close()
      }
    })

    it('archived session in storage (not in memory) can be loaded and revived', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      // Simulate pty exit
      mockPtyOnExitCb!({ exitCode: 0 })
      await new Promise((r) => setTimeout(r, 50))

      // Force-remove from in-memory map to simulate server restart scenario
      // (session only exists in storage)
      ;(sessionManager as unknown as { sessions: Map<string, unknown> }).sessions.delete(sessionId)

      // Connect via WebSocket — should load from storage
      const { ws, collectMessages } = await connectWs(sessionId)
      try {
        const msgs = await collectMessages(2)
        expect(msgs[0]).toMatchObject({ type: 'history' })
        expect(msgs[1]).toMatchObject({ type: 'status', data: 'exited' })
      } finally {
        ws.close()
      }
    })
  })
})
