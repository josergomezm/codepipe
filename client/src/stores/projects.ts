import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../api/client'
import type { Project, ProjectDevServer, DevServerInfo, ServiceWithState, ServiceConfig, ServiceState, PortRegistry } from '../api/client'

// Per-project service state (runtime, not persisted in project object)
const serviceStateMap = ref<Map<string, ServiceWithState[]>>(new Map())

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const tailscaleHostname = ref<string | null>(null)
  const portRegistry = ref<PortRegistry | null>(null)
  const error = ref<string | null>(null)

  async function fetchProjects() {
    try {
      const response = await api.fetchProjects()
      projects.value = response.projects
      tailscaleHostname.value = response.tailscaleHostname
      if (response.portRegistry) {
        portRegistry.value = response.portRegistry
      }
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load projects'
    }
  }

  async function addProject(name: string, path: string): Promise<Project> {
    try {
      const project = await api.createProject(name, path)
      projects.value.push(project)
      error.value = null
      return project
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to add project'
      throw e
    }
  }

  async function removeProject(id: string) {
    try {
      await api.deleteProject(id)
      projects.value = projects.value.filter((p) => p.id !== id)
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to remove project'
    }
  }

  async function updateProjectDevServer(id: string, devServer: ProjectDevServer | null) {
    try {
      const updated = await api.updateProject(id, { devServer })
      const index = projects.value.findIndex((p) => p.id === id)
      if (index !== -1) {
        projects.value[index] = { ...projects.value[index], ...updated }
      }
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to update dev server config'
    }
  }

  async function updateProjectStandup(id: string, standup: { enabled: boolean; hour: number } | null) {
    try {
      const updated = await api.updateProject(id, { standup })
      const index = projects.value.findIndex((p) => p.id === id)
      if (index !== -1) {
        projects.value[index] = { ...projects.value[index], ...updated, standup: updated.standup }
      }
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to update standup config'
    }
  }

  async function startDevServer(id: string): Promise<DevServerInfo | null> {
    try {
      const info = await api.startDevServer(id)
      const index = projects.value.findIndex((p) => p.id === id)
      if (index !== -1) {
        projects.value[index] = { ...projects.value[index], devServerStatus: info }
      }
      error.value = null
      return info
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to start dev server'
      return null
    }
  }

  async function stopDevServer(id: string) {
    try {
      await api.stopDevServer(id)
    } catch {
      // Even if the API fails, the intent is to stop — update UI anyway
    }
    // Always mark as stopped locally
    const index = projects.value.findIndex((p) => p.id === id)
    if (index !== -1) {
      const project = projects.value[index]
      projects.value[index] = {
        ...project,
        devServerStatus: project.devServerStatus
          ? { ...project.devServerStatus, status: 'stopped' }
          : null,
      }
    }
    error.value = null
  }

  function getProjectDevUrl(projectId: string): string | null {
    const project = projects.value.find((p) => p.id === projectId)
    if (!project?.devServerStatus) return null
    if (project.devServerStatus.status !== 'running') return null
    return project.devServerStatus.url
  }

  // --- Services ---

  function getServices(projectId: string): ServiceWithState[] {
    return serviceStateMap.value.get(projectId) ?? []
  }

  function hasRunningService(projectId: string): boolean {
    return getServices(projectId).some((s) => s.state.status === 'running')
  }

  async function fetchServices(projectId: string) {
    try {
      const { services } = await api.fetchServices(projectId)
      serviceStateMap.value.set(projectId, services)
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load services'
    }
  }

  async function addService(projectId: string, config: Omit<ServiceConfig, 'id'> & { id?: string }): Promise<ServiceConfig | null> {
    try {
      const saved = await api.addService(projectId, config)
      // Re-fetch to get state alongside config
      await fetchServices(projectId)
      error.value = null
      return saved
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to add service'
      return null
    }
  }

  async function removeService(projectId: string, serviceId: string) {
    try {
      await api.deleteService(projectId, serviceId)
      const current = serviceStateMap.value.get(projectId) ?? []
      serviceStateMap.value.set(projectId, current.filter((s) => s.id !== serviceId))
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to remove service'
    }
  }

  async function startService(projectId: string, serviceId: string): Promise<ServiceState | null> {
    try {
      const state = await api.startService(projectId, serviceId)
      _updateServiceState(projectId, serviceId, state)
      error.value = null
      return state
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to start service'
      return null
    }
  }

  async function stopService(projectId: string, serviceId: string) {
    try {
      await api.stopService(projectId, serviceId)
      _updateServiceState(projectId, serviceId, { status: 'stopped', ports: {}, logs: [] })
      error.value = null
    } catch {
      // Optimistically mark stopped even if request failed
      _updateServiceState(projectId, serviceId, { status: 'stopped', ports: {}, logs: [] })
    }
  }

  async function refreshServiceStatus(projectId: string, serviceId: string) {
    try {
      const state = await api.getServiceStatus(projectId, serviceId)
      _updateServiceState(projectId, serviceId, state)
    } catch {
      // Best-effort
    }
  }

  function _updateServiceState(projectId: string, serviceId: string, state: ServiceState) {
    const current = serviceStateMap.value.get(projectId) ?? []
    const idx = current.findIndex((s) => s.id === serviceId)
    if (idx !== -1) {
      current[idx] = { ...current[idx], state }
      serviceStateMap.value.set(projectId, [...current])
    }
  }

  function clearError() {
    error.value = null
  }

  return {
    projects,
    tailscaleHostname,
    portRegistry,
    error,
    fetchProjects,
    addProject,
    removeProject,
    updateProjectDevServer,
    updateProjectStandup,
    startDevServer,
    stopDevServer,
    getProjectDevUrl,
    // Services
    getServices,
    hasRunningService,
    fetchServices,
    addService,
    removeService,
    startService,
    stopService,
    refreshServiceStatus,
    clearError,
  }
})
