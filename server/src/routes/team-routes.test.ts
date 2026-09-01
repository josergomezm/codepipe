import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'
import express from 'express'
import request from 'supertest'

import { StorageLayer } from '../storage.js'
import { createTodoRoutes } from './todos.js'
import { createActionRoutes } from './actions.js'
import { createPersonaRoutes } from './personas.js'
import { createStandupRoutes } from './standup.js'
import type { StandupService, StandupRunResult } from '../standup.js'
import type { Project } from '../schemas.js'

// A 1x1 transparent PNG for avatar upload tests.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

let tmpDir: string
let storage: StorageLayer
let app: express.Express
let project: Project
let standupResult: StandupRunResult
let implementResult: StandupRunResult
let resolvedNotifications: string[]

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-routes-'))
  storage = new StorageLayer(tmpDir)
  await storage.ensureDataDir()
  project = await storage.addProject({ name: 'demo', path: tmpDir })

  standupResult = { ran: true, sessionId: '55555555-5555-4555-8555-555555555555' }
  implementResult = { ran: true, sessionId: '66666666-6666-4666-8666-666666666666' }
  resolvedNotifications = []
  const standupStub = {
    runStandup: async (projectId: string) => {
      if (!(await storage.getProject(projectId))) throw new Error('Project not found')
      return standupResult
    },
    notifyActionResolved: async (item: { id: string }) => {
      resolvedNotifications.push(item.id)
    },
    implementProposal: async (todoId: string) => {
      if (!(await storage.listTodos()).some((t) => t.id === todoId)) throw new Error('Todo not found')
      return implementResult
    },
  } as unknown as StandupService

  app = express()
  app.use(express.json())
  app.use('/api/todos', createTodoRoutes(storage, standupStub))
  app.use('/api/actions', createActionRoutes(storage, standupStub))
  app.use('/api/personas', createPersonaRoutes(storage, path.join(tmpDir, 'avatars')))
  app.use('/api/standup', createStandupRoutes(standupStub, storage))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('todo routes', () => {
  it('supports the full CRUD lifecycle with validation', async () => {
    // Invalid body → 400
    await request(app).post('/api/todos').send({ text: 'no project' }).expect(400)
    // Unknown project → 404
    await request(app)
      .post('/api/todos')
      .send({ projectId: '99999999-9999-4999-8999-999999999999', text: 'x' })
      .expect(404)

    const created = await request(app)
      .post('/api/todos')
      .send({ projectId: project.id, text: 'First idea', notes: 'ctx' })
      .expect(201)
    expect(created.body.status).toBe('inbox')

    const list = await request(app).get(`/api/todos?projectId=${project.id}`).expect(200)
    expect(list.body).toHaveLength(1)

    const updated = await request(app)
      .patch(`/api/todos/${created.body.id}`)
      .send({ status: 'approved' })
      .expect(200)
    expect(updated.body.status).toBe('approved')

    await request(app).patch(`/api/todos/${created.body.id}`).send({ status: 'nope' }).expect(400)
    await request(app).patch('/api/todos/missing-id').send({ status: 'done' }).expect(404)

    await request(app).delete(`/api/todos/${created.body.id}`).expect(200)
    const empty = await request(app).get(`/api/todos?projectId=${project.id}`).expect(200)
    expect(empty.body).toHaveLength(0)
  })

  it('maps implement dispatch to 202, skips to 409, unknown todo to 404', async () => {
    const todo = await storage.addTodo({ projectId: project.id, text: 'Build it' })

    const started = await request(app).post(`/api/todos/${todo.id}/implement`).expect(202)
    expect(started.body.sessionId).toBeTruthy()

    implementResult = { ran: false, reason: 'An implementation session already exists for this idea' }
    const skipped = await request(app).post(`/api/todos/${todo.id}/implement`).expect(409)
    expect(skipped.body.reason).toContain('already exists')

    await request(app).post('/api/todos/99999999-9999-4999-8999-999999999999/implement').expect(404)
  })
})

describe('action item routes', () => {
  it('supports the full CRUD lifecycle with open-first sorting', async () => {
    await request(app).post('/api/actions').send({ text: 'no project' }).expect(400)
    await request(app)
      .post('/api/actions')
      .send({ projectId: '99999999-9999-4999-8999-999999999999', text: 'x' })
      .expect(404)

    const first = await request(app)
      .post('/api/actions')
      .send({ projectId: project.id, text: 'Set up Stripe secrets', notes: 'dashboard → API keys' })
      .expect(201)
    expect(first.body.status).toBe('open')

    const second = await request(app)
      .post('/api/actions')
      .send({ projectId: project.id, text: 'Create Sentry project' })
      .expect(201)

    // Completing the newer item sorts it below the still-open one.
    await request(app).patch(`/api/actions/${second.body.id}`).send({ status: 'done' }).expect(200)
    const list = await request(app).get(`/api/actions?projectId=${project.id}`).expect(200)
    expect(list.body.map((a: { id: string }) => a.id)).toEqual([first.body.id, second.body.id])

    await request(app).patch(`/api/actions/${first.body.id}`).send({ status: 'nope' }).expect(400)
    await request(app).patch('/api/actions/missing-id').send({ status: 'done' }).expect(404)

    await request(app).delete(`/api/actions/${first.body.id}`).expect(200)
    const remaining = await request(app).get(`/api/actions?projectId=${project.id}`).expect(200)
    expect(remaining.body).toHaveLength(1)

    // Manually added items (no persona) never ping the team.
    expect(resolvedNotifications).toHaveLength(0)
  })

  it('pings the team only when a team-raised item transitions open → done', async () => {
    const persona = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    const item = await storage.addActionItem({
      projectId: project.id, text: 'Add API key', personaId: persona.id,
    })

    // Editing text doesn't ping; completing does; re-completing doesn't.
    await request(app).patch(`/api/actions/${item.id}`).send({ text: 'Add the API key' }).expect(200)
    expect(resolvedNotifications).toHaveLength(0)

    await request(app).patch(`/api/actions/${item.id}`).send({ status: 'done' }).expect(200)
    expect(resolvedNotifications).toEqual([item.id])

    await request(app).patch(`/api/actions/${item.id}`).send({ status: 'done' }).expect(200)
    expect(resolvedNotifications).toHaveLength(1)
  })
})

describe('persona routes', () => {
  const mayaBody = {
    name: 'Maya',
    role: 'Team lead',
    personality: 'Pragmatic.',
    provider: 'kiro',
    isLead: true,
  }

  it('supports CRUD with single-lead enforcement', async () => {
    await request(app).post('/api/personas').send({ name: 'x' }).expect(400)

    const maya = await request(app).post('/api/personas').send(mayaBody).expect(201)
    const aria = await request(app)
      .post('/api/personas')
      .send({ ...mayaBody, name: 'Aria', isLead: true })
      .expect(201)

    let roster = await request(app).get('/api/personas').expect(200)
    expect(roster.body.find((p: { id: string }) => p.id === maya.body.id).isLead).toBe(false)
    expect(roster.body.find((p: { id: string }) => p.id === aria.body.id).isLead).toBe(true)

    await request(app).patch(`/api/personas/${maya.body.id}`).send({ isLead: true }).expect(200)
    roster = await request(app).get('/api/personas').expect(200)
    expect(roster.body.find((p: { id: string }) => p.id === aria.body.id).isLead).toBe(false)

    await request(app).patch('/api/personas/missing').send({ role: 'x' }).expect(404)

    await request(app).delete(`/api/personas/${aria.body.id}`).expect(200)
    roster = await request(app).get('/api/personas').expect(200)
    expect(roster.body).toHaveLength(1)
  })

  it('uploads and replaces avatars, rejecting non-images', async () => {
    const maya = await request(app).post('/api/personas').send(mayaBody).expect(201)

    await request(app)
      .post(`/api/personas/${maya.body.id}/avatar`)
      .attach('file', Buffer.from('not an image'), 'avatar.txt')
      .expect(415)

    const first = await request(app)
      .post(`/api/personas/${maya.body.id}/avatar`)
      .attach('file', PNG_1PX, 'maya.png')
      .expect(201)
    expect(first.body.avatar).toMatch(/\.png$/)
    const firstPath = path.join(tmpDir, 'avatars', first.body.avatar)
    expect(existsSync(firstPath)).toBe(true)

    // Replacing removes the old file.
    const second = await request(app)
      .post(`/api/personas/${maya.body.id}/avatar`)
      .attach('file', PNG_1PX, 'maya2.png')
      .expect(201)
    expect(second.body.avatar).not.toBe(first.body.avatar)
    expect(existsSync(firstPath)).toBe(false)

    await request(app)
      .post('/api/personas/99999999-9999-4999-8999-999999999999/avatar')
      .attach('file', PNG_1PX, 'x.png')
      .expect(404)
  })
})

describe('standup routes', () => {
  it('maps dispatch to 202, skips to 409, unknown project to 404', async () => {
    const started = await request(app).post(`/api/standup/${project.id}/run`).expect(202)
    expect(started.body.ran).toBe(true)

    standupResult = { ran: false, reason: 'Todo list unchanged since the last standup' }
    const skipped = await request(app).post(`/api/standup/${project.id}/run`).expect(409)
    expect(skipped.body.reason).toContain('unchanged')

    await request(app).post('/api/standup/99999999-9999-4999-8999-999999999999/run').expect(404)
  })

  it('returns standup state (empty default for fresh projects)', async () => {
    const fresh = await request(app).get(`/api/standup/${project.id}`).expect(200)
    expect(fresh.body.projectId).toBe(project.id)
    expect(fresh.body.lastRunAt).toBeUndefined()

    await storage.setStandupState({ projectId: project.id, lastRunAt: 123, lastHash: 'h' })
    const stored = await request(app).get(`/api/standup/${project.id}`).expect(200)
    expect(stored.body.lastRunAt).toBe(123)
  })
})
