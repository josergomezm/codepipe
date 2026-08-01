import { Router } from 'express'
import type { Request } from 'express'
import type { IStorageLayer } from '../storage.js'
import type { ServiceManager } from '../service-manager.js'
import { ProjectServiceConfigSchema } from '../schemas.js'
import { log } from '../logger.js'
import { detectFirebaseEmulators, buildFirebaseServiceConfig, firebasePortParser } from '../services/firebase-detector.js'
import { isLocalPortListening, identifyLocalPortOwner, servicePortsAsReserved } from '../ports.js'

// TypeScript doesn't reflect mergeParams at the type level, so we cast params
// explicitly in each handler.
type P = { id: string }
type SP = { id: string; serviceId: string }

export function createServiceRoutes(storage: IStorageLayer, serviceManager: ServiceManager): Router {
  const router = Router({ mergeParams: true })

  // GET /api/projects/:id/services — list services with runtime state
  router.get('/', async (req, res) => {
    const { id } = req.params as unknown as P
    try {
      const project = await storage.getProject(id)
      if (!project) { res.status(404).json({ error: 'Project not found' }); return }

      const services = (project.services ?? []).map((svc) => ({
        ...svc,
        state: serviceManager.getState(id, svc.id),
      }))
      res.json({ services })
    } catch (err) {
      log.error('api', `Failed to list services for project ${id}`, err)
      res.status(500).json({ error: 'Failed to list services' })
    }
  })

  // POST /api/projects/:id/services — add a service config
  router.post('/', async (req, res) => {
    const { id } = req.params as unknown as P
    try {
      const project = await storage.getProject(id)
      if (!project) { res.status(404).json({ error: 'Project not found' }); return }

      const parsed = ProjectServiceConfigSchema.safeParse(req.body)
      if (!parsed.success) { res.status(400).json({ error: parsed.error.format() }); return }

      // Firebase emulators are a singleton per project — one firebase.json,
      // one emulator suite. Reject duplicates.
      if (parsed.data.type === 'firebase-emulators'
        && (project.services ?? []).some((s) => s.type === 'firebase-emulators')) {
        res.status(409).json({ error: 'Firebase Emulators are already configured for this project' })
        return
      }

      const services = [...(project.services ?? []), parsed.data]
      await storage.updateProject(id, { services })
      res.status(201).json(parsed.data)
    } catch (err) {
      log.error('api', `Failed to add service to project ${id}`, err)
      res.status(500).json({ error: 'Failed to add service' })
    }
  })

  // GET /api/projects/:id/services/detect/firebase — auto-detect
  // Registered before /:serviceId routes so Express doesn't match "detect" as a serviceId.
  router.get('/detect/firebase', async (req, res) => {
    const { id } = req.params as unknown as P
    try {
      const project = await storage.getProject(id)
      if (!project) { res.status(404).json({ error: 'Project not found' }); return }

      const detection = await detectFirebaseEmulators(project.path)
      const suggested = detection.found ? buildFirebaseServiceConfig(detection) : null
      res.json({ detection, suggested })
    } catch (err) {
      log.error('api', `Failed to detect firebase for project ${id}`, err)
      res.status(500).json({ error: 'Detection failed' })
    }
  })

  // PATCH /api/projects/:id/services/:serviceId — update a service config
  router.patch('/:serviceId', async (req, res) => {
    const { id, serviceId } = req.params as unknown as SP
    try {
      const project = await storage.getProject(id)
      if (!project) { res.status(404).json({ error: 'Project not found' }); return }

      const services = [...(project.services ?? [])]
      const idx = services.findIndex((s) => s.id === serviceId)
      if (idx === -1) { res.status(404).json({ error: 'Service not found' }); return }

      const updated = { ...services[idx], ...req.body, id: serviceId }
      const check = ProjectServiceConfigSchema.safeParse(updated)
      if (!check.success) { res.status(400).json({ error: check.error.format() }); return }

      services[idx] = check.data
      await storage.updateProject(id, { services })
      res.json(check.data)
    } catch (err) {
      log.error('api', `Failed to update service ${(req as Request<SP>).params.serviceId}`, err)
      res.status(500).json({ error: 'Failed to update service' })
    }
  })

  // DELETE /api/projects/:id/services/:serviceId — remove a service config
  router.delete('/:serviceId', async (req, res) => {
    const { id, serviceId } = req.params as unknown as SP
    try {
      const project = await storage.getProject(id)
      if (!project) { res.status(404).json({ error: 'Project not found' }); return }

      serviceManager.stop(id, serviceId)
      const services = (project.services ?? []).filter((s) => s.id !== serviceId)
      await storage.updateProject(id, { services })
      res.json({ ok: true })
    } catch (err) {
      log.error('api', `Failed to remove service ${(req as Request<SP>).params.serviceId}`, err)
      res.status(500).json({ error: 'Failed to remove service' })
    }
  })

  // POST /api/projects/:id/services/:serviceId/start
  router.post('/:serviceId/start', async (req, res) => {
    const { id, serviceId } = req.params as unknown as SP
    try {
      const project = await storage.getProject(id)
      if (!project) { res.status(404).json({ error: 'Project not found' }); return }

      const config = (project.services ?? []).find((s) => s.id === serviceId)
      if (!config) { res.status(404).json({ error: 'Service not found' }); return }

      // Pre-start guard: Firebase's default ports are identical for every
      // project, so check the ports this instance will bind before spawning.
      if (config.type === 'firebase-emulators') {
        const detection = await detectFirebaseEmulators(project.path)
        const allProjects = await storage.listProjects()

        // Ports held by this same service are fine — start() restarts it
        const own = serviceManager.getState(id, serviceId)
        const ownPorts = new Set(Object.values(own.ports).map((p) => p.port))
        const otherRunning = serviceManager
          .listRunning()
          .filter((s) => !(s.projectId === id && s.serviceId === serviceId))
        const reserved = servicePortsAsReserved(otherRunning, allProjects)

        const conflicts: string[] = []
        for (const [emulator, port] of Object.entries(detection.defaultPorts)) {
          if (ownPorts.has(port)) continue
          if (!isLocalPortListening(port)) continue
          conflicts.push(`port ${port} (${emulator}) is in use by ${identifyLocalPortOwner(port, allProjects, reserved)}`)
        }
        if (conflicts.length > 0) {
          res.status(409).json({
            error: `Cannot start Firebase emulators: ${conflicts.join(', ')}. Stop the other service or set unique ports in this project's firebase.json.`,
          })
          return
        }
      }

      const parser = config.type === 'firebase-emulators' ? firebasePortParser : undefined
      const state = serviceManager.start(id, project.path, config, parser)
      res.json(state)
    } catch (err) {
      log.error('api', `Failed to start service ${(req as Request<SP>).params.serviceId}`, err)
      res.status(500).json({ error: 'Failed to start service' })
    }
  })

  // POST /api/projects/:id/services/:serviceId/stop
  router.post('/:serviceId/stop', async (req, res) => {
    const { id, serviceId } = req.params as unknown as SP
    const stopped = serviceManager.stop(id, serviceId)
    res.json({ ok: true, wasRunning: stopped })
  })

  // GET /api/projects/:id/services/:serviceId/status
  router.get('/:serviceId/status', async (req, res) => {
    const { id, serviceId } = req.params as unknown as SP
    const state = serviceManager.getState(id, serviceId)
    res.json(state)
  })

  return router
}
