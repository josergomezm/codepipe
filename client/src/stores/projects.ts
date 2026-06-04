import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../api/client'
import type { Project, ProjectDevServer, DevServerInfo } from '../api/client'

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const tailscaleHostname = ref<string | null>(null)
  const error = ref<string | null>(null)

  async function fetchProjects() {
    try {
      const response = await api.fetchProjects()
      projects.value = response.projects
      tailscaleHostname.value = response.tailscaleHostname
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

  function clearError() {
    error.value = null
  }

  return {
    projects,
    tailscaleHostname,
    error,
    fetchProjects,
    addProject,
    removeProject,
    updateProjectDevServer,
    startDevServer,
    stopDevServer,
    getProjectDevUrl,
    clearError,
  }
})
