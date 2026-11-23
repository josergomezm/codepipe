import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import path from 'path'
import os from 'os'
import express from 'express'
import request from 'supertest'

import { StorageLayer } from '../storage.js'
import { createSessionRoutes } from './sessions.js'
import { buildWorkspaceDigest } from '../lead/workspace-digest.js'
import type { ISessionManager } from '../session-manager.js'
import type { Session } from '../schemas.js'

const T = Date.UTC(2026, 10, 20)
let dir: string
let storage: StorageLayer
let app: express.Express

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-session-routes-'))
  storage = new StorageLayer(dir)
  await storage.ensureDataDir()
  // Only what DELETE touches: no live sessions; delete goes to storage.
  const sessionManager = {
    getSession: () => undefined,
    deleteSession: (id: string) => storage.deleteSession(id),
  } as unknown as ISessionManager
  app = express()
  app.use(express.json())
  app.use('/api/sessions', createSessionRoutes(sessionManager, storage))
})

afterEach(async () => {
  await storage.whenIdle()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('DELETE /api/sessions/:id', () => {
  it('records the chat as closed for the lead before removing it', async () => {
    const project = await storage.addProject({ name: 'Partners', path: path.join(dir, 'none') })
    const s: Session = {
      id: randomUUID(), provider: 'claude', projectId: project.id, title: 'Partners MVP',
      createdAt: T, updatedAt: T + 2, status: 'live',
      messages: [
        { id: randomUUID(), role: 'user', content: 'Ship the partner page', timestamp: T + 1, status: 'complete' },
        { id: randomUUID(), role: 'assistant', content: 'Built.\n\nDo you want me to deploy it?', timestamp: T + 2, status: 'complete' },
      ],
    }
    await storage.saveSession(s)

    expect((await request(app).delete(`/api/sessions/${s.id}`)).status).toBe(200)
    expect(await storage.getSession(s.id)).toBeNull()
    const closed = await storage.listClosedChats()
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ sessionId: s.id, request: 'Ship the partner page', attention: { state: 'waiting_on_you' } })
    // …and the next digest reports it as closed, not open.
    const digest = await buildWorkspaceDigest({ storage }, { since: T })
    expect(digest.closed.map((c) => c.title)).toEqual(['Partners MVP'])
    expect(digest.chats).toEqual([])
  })
})
