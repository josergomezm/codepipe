import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../api/client'
import type { Project } from '../api/client'

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const error = ref<string | null>(null)

  async function fetchProjects() {
    try {
      projects.value = await api.fetchProjects()
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

  function clearError() {
    error.value = null
  }

  return {
    projects,
    error,
    fetchProjects,
    addProject,
    removeProject,
    clearError,
  }
})
