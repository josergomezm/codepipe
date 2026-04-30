import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../api/client'
import type { Project } from '../api/client'

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])

  async function fetchProjects() {
    projects.value = await api.fetchProjects()
  }

  async function addProject(name: string, path: string): Promise<Project> {
    const project = await api.createProject(name, path)
    projects.value.push(project)
    return project
  }

  async function removeProject(id: string) {
    await api.deleteProject(id)
    projects.value = projects.value.filter((p) => p.id !== id)
  }

  return {
    projects,
    fetchProjects,
    addProject,
    removeProject,
  }
})
