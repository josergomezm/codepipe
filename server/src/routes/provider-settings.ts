import { Router } from 'express'

import type { IStorageLayer } from '../storage.js'
import { ProviderTypeSchema, type ProviderType } from '../schemas.js'
import {
  PROVIDER_SETTINGS_SPECS,
  getProviderSettingsSpec,
  resolveSettings,
  settingsToArgs,
  specToJson,
  validateSettingValues,
  type SettingLayers,
} from '../provider-settings.js'
import type { ProviderSettingsStore } from '../provider-settings-store.js'
import { log } from '../logger.js'

/**
 * Provider launch settings: the schema (what each CLI can be configured
 * with, and when its flag list was last checked), the global layer, and a
 * resolver that shows the effective values for a project/persona.
 */
export function createProviderSettingsRoutes(store: ProviderSettingsStore, storage: IStorageLayer): Router {
  const router = Router()

  function describe(provider: ProviderType) {
    const spec = getProviderSettingsSpec(provider)!
    const global = store.get(provider)
    const resolved = resolveSettings(provider, { global })
    return {
      spec: specToJson(spec),
      /** The global layer's own overrides. */
      global,
      /** Effective global values (defaults + env + global), with provenance. */
      resolved,
      /** What those values launch the CLI with. */
      args: settingsToArgs(provider, resolved.values),
    }
  }

  // GET /api/provider-settings — every provider's spec + global layer
  router.get('/', (_req, res) => {
    res.json({ providers: PROVIDER_SETTINGS_SPECS.map((s) => describe(s.provider)) })
  })

  // GET /api/provider-settings/resolve?provider=&projectId=&personaId=
  // Effective values for a context, as a session there would launch with.
  router.get('/resolve', async (req, res) => {
    const provider = ProviderTypeSchema.safeParse(req.query['provider'])
    if (!provider.success || !getProviderSettingsSpec(provider.data)) {
      res.status(400).json({ error: 'Unknown provider' })
      return
    }
    const layers: SettingLayers = { global: store.get(provider.data) }
    try {
      const projectId = typeof req.query['projectId'] === 'string' ? req.query['projectId'] : null
      const personaId = typeof req.query['personaId'] === 'string' ? req.query['personaId'] : null
      if (projectId) {
        const project = await storage.getProject(projectId)
        if (!project) {
          res.status(404).json({ error: 'Project not found' })
          return
        }
        const layer = project.providerSettings?.[provider.data]
        if (layer) layers.project = layer
      }
      if (personaId) {
        const persona = (await storage.listPersonas()).find((p) => p.id === personaId)
        if (!persona) {
          res.status(404).json({ error: 'Persona not found' })
          return
        }
        const layer = persona.providerSettings?.[provider.data]
        if (layer) layers.persona = layer
      }
      const resolved = resolveSettings(provider.data, layers)
      res.json({ ...resolved, args: settingsToArgs(provider.data, resolved.values) })
    } catch (err) {
      log.error('api', 'Failed to resolve provider settings', err)
      res.status(500).json({ error: 'Failed to resolve provider settings' })
    }
  })

  // PUT /api/provider-settings/:provider — replace the global layer
  router.put('/:provider', async (req, res) => {
    const provider = ProviderTypeSchema.safeParse(req.params.provider)
    if (!provider.success || !getProviderSettingsSpec(provider.data)) {
      res.status(400).json({ error: 'Unknown provider' })
      return
    }
    const result = validateSettingValues(provider.data, req.body)
    if (!result.ok) {
      res.status(400).json({ error: result.errors.join('; ') })
      return
    }
    try {
      await store.set(provider.data, result.values)
      log.info('settings', `Global ${provider.data} launch settings updated: ${JSON.stringify(result.values)}`)
      res.json(describe(provider.data))
    } catch (err) {
      log.error('api', `Failed to save ${provider.data} settings`, err)
      res.status(500).json({ error: 'Failed to save settings' })
    }
  })

  return router
}
