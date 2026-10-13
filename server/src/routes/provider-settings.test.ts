import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import request from 'supertest'

import { StorageLayer } from '../storage.js'
import { ProviderSettingsStore } from '../provider-settings-store.js'
import { createProviderSettingsRoutes } from './provider-settings.js'
import { createProjectRoutes } from './projects.js'
import { createPersonaRoutes } from './personas.js'
import type { DevServerManager } from '../dev-server-manager.js'
import type { ServiceManager } from '../service-manager.js'

let tmpDir: string
let storage: StorageLayer
let store: ProviderSettingsStore
let app: express.Express

const saved = { ...process.env }

beforeEach(async () => {
  delete process.env['CLAUDE_PERMISSION_MODE']
  delete process.env['CLAUDE_EXTRA_ARGS']
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-settings-routes-'))
  storage = new StorageLayer(tmpDir)
  await storage.ensureDataDir()
  store = new ProviderSettingsStore({ dataDir: tmpDir })
  await store.load()
  app = express()
  app.use(express.json())
  app.use('/api/provider-settings', createProviderSettingsRoutes(store, storage))
  app.use(
    '/api/projects',
    createProjectRoutes(
      storage,
      { getStatus: () => null, listRunning: () => [] } as unknown as DevServerManager,
      { listRunning: () => [] } as unknown as ServiceManager,
    ),
  )
  app.use('/api/personas', createPersonaRoutes(storage, path.join(tmpDir, 'avatars')))
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(tmpDir, { recursive: true, force: true })
})

describe('GET /api/provider-settings', () => {
  it('lists every provider with its spec, global layer, resolved values and args', async () => {
    const res = await request(app).get('/api/provider-settings')
    expect(res.status).toBe(200)
    const providers = res.body.providers as { spec: { provider: string; docsCheckedOn: string; settings: unknown[] }; global: object; resolved: { values: Record<string, unknown>; sources: Record<string, string> }; args: string[] }[]
    expect(providers.map((p) => p.spec.provider).sort()).toEqual(['claude', 'gemini', 'kiro'])
    const claude = providers.find((p) => p.spec.provider === 'claude')!
    expect(claude.spec.docsCheckedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(claude.global).toEqual({})
    expect(claude.resolved.values['permissionMode']).toBe('acceptEdits')
    expect(claude.resolved.sources['permissionMode']).toBe('default')
    expect(claude.args).toEqual(['--permission-mode', 'acceptEdits'])
    // No functions leaked
    expect(JSON.stringify(claude.spec)).not.toContain('args')
  })
})

describe('PUT /api/provider-settings/:provider', () => {
  it('replaces the global layer and reports the new effective values', async () => {
    const res = await request(app).put('/api/provider-settings/kiro').send({ trustAllTools: false, trustTools: ['fs_read'] })
    expect(res.status).toBe(200)
    expect(res.body.global).toEqual({ trustAllTools: false, trustTools: ['fs_read'] })
    expect(res.body.resolved.sources['trustAllTools']).toBe('global')
    expect(res.body.args).toEqual(['--trust-tools=fs_read'])
    expect(store.get('kiro')).toEqual({ trustAllTools: false, trustTools: ['fs_read'] })

    // Sending fewer keys drops the rest (it's a replace, not a merge).
    const again = await request(app).put('/api/provider-settings/kiro').send({ effort: 'high' })
    expect(again.body.global).toEqual({ effort: 'high' })
    expect(again.body.args).toEqual(['--trust-all-tools', '--effort', 'high'])
  })

  it('rejects bad values and unknown providers', async () => {
    const bad = await request(app).put('/api/provider-settings/claude').send({ permissionMode: 'yolo', nope: true })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/permissionMode/)
    expect(bad.body.error).toMatch(/Unknown setting "nope"/)
    expect(store.get('claude')).toEqual({})

    expect((await request(app).put('/api/provider-settings/codex').send({})).status).toBe(400)
    expect((await request(app).put('/api/provider-settings/nope').send({})).status).toBe(400)
  })
})

describe('project and persona overrides', () => {
  it('stores validated overrides on a project, and null clears them', async () => {
    const project = await storage.addProject({ name: 'P', path: tmpDir })
    const ok = await request(app).patch(`/api/projects/${project.id}`).send({ providerSettings: { claude: { permissionMode: 'plan' }, kiro: {} } })
    expect(ok.status).toBe(200)
    expect(ok.body.providerSettings).toEqual({ claude: { permissionMode: 'plan' } })

    const bad = await request(app).patch(`/api/projects/${project.id}`).send({ providerSettings: { claude: { permissionMode: 'nah' } } })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/^claude: /)

    const cleared = await request(app).patch(`/api/projects/${project.id}`).send({ providerSettings: null })
    expect(cleared.body.providerSettings).toBeUndefined()
  })

  it('stores validated overrides on a persona, and {} clears them', async () => {
    const created = await request(app).post('/api/personas').send({
      name: 'Maya',
      role: 'Lead',
      personality: '',
      provider: 'claude',
      isLead: true,
      providerSettings: { claude: { skipPermissions: true } },
    })
    expect(created.status).toBe(201)
    expect(created.body.providerSettings).toEqual({ claude: { skipPermissions: true } })

    const bad = await request(app).patch(`/api/personas/${created.body.id}`).send({ providerSettings: { claude: { skipPermissions: 'yes' } } })
    expect(bad.status).toBe(400)

    const cleared = await request(app).patch(`/api/personas/${created.body.id}`).send({ providerSettings: {} })
    expect(cleared.status).toBe(200)
    expect(cleared.body.providerSettings).toBeUndefined()
    // Other fields untouched
    expect(cleared.body.name).toBe('Maya')
  })

  it('resolves the effective settings for a project + persona context', async () => {
    await store.set('claude', { permissionMode: 'acceptEdits', skipPermissions: true })
    const project = await storage.addProject({ name: 'P', path: tmpDir })
    await storage.updateProject(project.id, { providerSettings: { claude: { permissionMode: 'dontAsk' } } })
    const persona = await storage.addPersona({
      name: 'Rex',
      role: 'Reviewer',
      personality: '',
      provider: 'claude',
      isLead: false,
      providerSettings: { claude: { permissionMode: 'plan', skipPermissions: false } },
    })

    const globalOnly = await request(app).get('/api/provider-settings/resolve').query({ provider: 'claude' })
    expect(globalOnly.body.values.permissionMode).toBe('acceptEdits')
    expect(globalOnly.body.sources.skipPermissions).toBe('global')

    const withProject = await request(app).get('/api/provider-settings/resolve').query({ provider: 'claude', projectId: project.id })
    expect(withProject.body.values.permissionMode).toBe('dontAsk')
    expect(withProject.body.sources.permissionMode).toBe('project')
    expect(withProject.body.args).toEqual(['--permission-mode', 'dontAsk', '--dangerously-skip-permissions'])

    const withPersona = await request(app)
      .get('/api/provider-settings/resolve')
      .query({ provider: 'claude', projectId: project.id, personaId: persona.id })
    expect(withPersona.body.values.permissionMode).toBe('plan')
    expect(withPersona.body.values.skipPermissions).toBe(false)
    expect(withPersona.body.sources.permissionMode).toBe('persona')
    expect(withPersona.body.args).toEqual(['--permission-mode', 'plan'])

    expect((await request(app).get('/api/provider-settings/resolve').query({ provider: 'claude', projectId: 'missing' })).status).toBe(404)
    expect((await request(app).get('/api/provider-settings/resolve').query({ provider: 'codex' })).status).toBe(400)
  })
})
