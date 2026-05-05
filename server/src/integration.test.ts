import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import request from 'supertest'
import { createServer, type Server as HttpServer } from 'http'
import { WebSocket } from 'ws'

// ---------------------------------------------------------------------------
// Mock child_process.spawn for non-interactive adapter tests
// ---------------------------------------------------------------------------

let mockSpawnStdoutCb: ((data: Buffer) => void) | null = null
let mockSpawnCloseCb: ((code: number) => void) | null = null
let mockSpawnErrorCb: ((err: Error) => void) | null = null
let mockSpawnKilled = false
let mockSpawnArgs: string[] = []

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    spawn: vi.fn((_command: string, args: string[], _options: unknown) => {
      mockSpawnStdoutCb = null
      mockSpawnCloseCb = null
      mockSpawnErrorCb = null
      mockSpawnKilled = false
      mockSpawnArgs = args

      const stdout = {
        on(event: string, cb: (data: Buffer) => void) {
          if (event === 'data') mockSpawnStdoutCb = cb
        },
      }
      const stderr = {
        on(_event: string, _cb: (data: Buffer) => void) {
          // no-op for tests
        },
      }

      return {
        stdout,
        stderr,
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === 'close') mockSpawnCloseCb = cb as (code: number) => void
          if (event === 'error') mockSpawnErrorCb = cb as (err: Error) => void
        },
        kill() {
          mockSpawnKilled = true
        },
        pid: 12345,
      }
    }),
  }
})

// ---------------------------------------------------------------------------
// Mock node-pty (still needed for the module import, even if Kiro doesn't use it)
// ---------------------------------------------------------------------------

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

// Import AFTER mock is set up
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

async function addTestProject(): Promise<{ id: string; name: string; path: string }> {
  return storage.addProject({ name: 'Test Project', path: '/tmp' })
}

function connectWs(sessionId: string): Promise<{
  ws: WebSocket
  collectMessages: (count: number, timeoutMs?: number) => Promise<unknown[]>
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?sessionId=${sessionId}`)
    const allMessages: unknown[] = []
    let waitResolve: ((msgs: unknown[]) => void) | null = null
    let waitCount = 0

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
            rej(new Error(`Timed out waiting for ${count} messages, got ${allMessages.length}: ${JSON.stringify(allMessages)}`))
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
  // Session creation via REST API
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
      expect(listRes.body[0].messages).toBeUndefined()
    })
  })

  // =========================================================================
  // WebSocket connection and history replay
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
        expect(msgs[0]).toMatchObject({ type: 'history', data: [] })
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
  // User input flow (non-interactive mode)
  // =========================================================================

  describe('4.5.3 — User input flow', () => {
    it('sending input via WebSocket spawns a child process and broadcasts user message', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      const { ws, collectMessages } = await connectWs(sessionId)
      try {
        // Consume initial history + status
        await collectMessages(2)

        // Send user input
        ws.send(JSON.stringify({ type: 'input', data: 'hello' }))

        // Should receive a user message broadcast (message #3)
        const msgs = await collectMessages(3)
        const userMsg = msgs[2] as { type: string; data: { role: string; content: string } }
        expect(userMsg.type).toBe('message')
        expect(userMsg.data.role).toBe('user')
        expect(userMsg.data.content).toBe('hello')

        // For non-interactive mode, child_process.spawn is called (not pty.write)
        // The mock spawn should have been called with the message as the last arg
        expect(mockSpawnArgs[mockSpawnArgs.length - 1]).toBe('hello')
      } finally {
        ws.close()
      }
    })

    it('child process stdout is parsed and broadcast as assistant messages', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      const { ws, collectMessages } = await connectWs(sessionId)
      try {
        await collectMessages(2)

        ws.send(JSON.stringify({ type: 'input', data: 'hello' }))

        // Wait for user message + typing status
        await collectMessages(4)

        // Simulate CLI stdout
        await new Promise(r => setTimeout(r, 50))
        if (mockSpawnStdoutCb) {
          mockSpawnStdoutCb(Buffer.from('> Hello! How can I help?\n'))
        }

        // Wait for assistant message
        const msgs = await collectMessages(5)
        const assistantMsg = msgs[4] as { type: string; data: { role: string; content: string } }
        expect(assistantMsg.type).toBe('message')
        expect(assistantMsg.data.role).toBe('assistant')
        expect(assistantMsg.data.content).toContain('Hello! How can I help?')

        // Simulate process exit
        if (mockSpawnCloseCb) {
          mockSpawnCloseCb(1)
        }

        // Should get idle status after process exits
        const finalMsgs = await collectMessages(7, 5000)
        const statusMsgs = (finalMsgs as { type: string; data: unknown }[]).filter(
          m => m.type === 'status' && m.data === 'idle',
        )
        expect(statusMsgs.length).toBeGreaterThan(0)
      } finally {
        ws.close()
      }
    })
  })

  // =========================================================================
  // Session deletion
  // =========================================================================

  describe('4.5.4 — Session deletion', () => {
    it('DELETE live session returns ok', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      const delRes = await request(app).delete(`/api/sessions/${sessionId}`)
      expect(delRes.status).toBe(200)
      expect(delRes.body).toEqual({ ok: true })

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
  // Error cases
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
  // Session continuation (non-interactive mode)
  // =========================================================================

  describe('4.5.6 — Session continuation', () => {
    it('non-interactive session stays live (no PTY to exit)', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      // Session should always be live for non-interactive adapters
      const getRes = await request(app).get(`/api/sessions/${sessionId}`)
      expect(getRes.status).toBe(200)
      expect(getRes.body.status).toBe('live')
    })

    it('archived session in storage can be loaded via WebSocket', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      // Force-archive and remove from memory to simulate server restart
      await storage.updateSessionStatus(sessionId, 'archived')
      ;(sessionManager as unknown as { sessions: Map<string, unknown> }).sessions.delete(sessionId)

      const { ws, collectMessages } = await connectWs(sessionId)
      try {
        const msgs = await collectMessages(2)
        expect(msgs[0]).toMatchObject({ type: 'history' })
        expect(msgs[1]).toMatchObject({ type: 'status', data: 'exited' })
      } finally {
        ws.close()
      }
    })

    it('sending input to archived session triggers revival', async () => {
      const project = await addTestProject()
      const createRes = await request(app)
        .post('/api/sessions')
        .send({ provider: 'kiro', projectId: project.id })
      const sessionId = createRes.body.id

      // Force-archive and remove from memory
      await storage.updateSessionStatus(sessionId, 'archived')
      ;(sessionManager as unknown as { sessions: Map<string, unknown> }).sessions.delete(sessionId)

      const { ws, collectMessages } = await connectWs(sessionId)
      try {
        // Consume initial history + exited status
        const initial = await collectMessages(2)
        expect(initial[1]).toMatchObject({ type: 'status', data: 'exited' })

        // Send input — triggers revival
        ws.send(JSON.stringify({ type: 'input', data: 'continue please' }))

        // Should receive idle status (session revived) and eventually user message
        const msgs = await collectMessages(4, 8000)
        const types = (msgs as { type: string }[]).map(m => m.type)

        expect(types).toContain('status')
        const statusMsgs = (msgs as { type: string; data: unknown }[]).filter(
          m => m.type === 'status' && m.data === 'idle',
        )
        expect(statusMsgs.length).toBeGreaterThan(0)
      } finally {
        ws.close()
      }
    })
  })
})
