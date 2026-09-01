import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as api from '../api/client'
import type { Persona, Todo, TodoStatus, ActionItem, ActionItemStatus, ProviderType } from '../api/client'

/**
 * The team layer: personas (the AI org roster) and per-project todos.
 */
export const useTeamStore = defineStore('team', () => {
  const personas = ref<Persona[]>([])
  const todos = ref<Todo[]>([])
  const actions = ref<ActionItem[]>([])
  const error = ref<string | null>(null)
  /** Projects with a manual standup run in flight. */
  const standupRunning = ref<Set<string>>(new Set())

  const personasById = computed(() => {
    const map = new Map<string, Persona>()
    for (const p of personas.value) map.set(p.id, p)
    return map
  })

  const lead = computed(() => personas.value.find((p) => p.isLead) ?? personas.value[0] ?? null)

  function todosForProject(projectId: string): Todo[] {
    return todos.value.filter((t) => t.projectId === projectId)
  }

  function openTodoCount(projectId: string): number {
    return todosForProject(projectId).filter((t) => t.status !== 'done').length
  }

  // ----- Personas -----

  async function fetchPersonas() {
    try {
      personas.value = await api.fetchPersonas()
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load personas'
    }
  }

  async function createPersona(data: {
    name: string
    role: string
    personality: string
    provider: ProviderType
    model?: string
    isLead: boolean
  }): Promise<Persona | null> {
    try {
      const persona = await api.createPersona(data)
      await fetchPersonas() // lead exclusivity may have demoted others
      error.value = null
      return persona
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create persona'
      return null
    }
  }

  async function updatePersona(id: string, data: Partial<Omit<Persona, 'id' | 'avatar'>>) {
    try {
      await api.updatePersona(id, data)
      await fetchPersonas()
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to update persona'
    }
  }

  async function deletePersona(id: string) {
    try {
      await api.deletePersona(id)
      personas.value = personas.value.filter((p) => p.id !== id)
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to delete persona'
    }
  }

  async function uploadAvatar(id: string, file: File) {
    try {
      const updated = await api.uploadPersonaAvatar(id, file)
      const idx = personas.value.findIndex((p) => p.id === id)
      if (idx >= 0) personas.value[idx] = updated
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to upload avatar'
    }
  }

  // ----- Todos -----

  async function fetchTodos() {
    try {
      todos.value = await api.fetchTodos()
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load todos'
    }
  }

  async function addTodo(projectId: string, text: string, notes?: string) {
    try {
      const todo = await api.createTodo(projectId, text, notes)
      todos.value.unshift(todo)
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to add todo'
    }
  }

  async function setTodoStatus(id: string, status: TodoStatus) {
    try {
      const updated = await api.updateTodo(id, { status })
      const idx = todos.value.findIndex((t) => t.id === id)
      if (idx >= 0) todos.value[idx] = updated
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to update todo'
    }
  }

  async function implementTodo(id: string): Promise<api.StandupRunResult | null> {
    try {
      const result = await api.implementTodo(id)
      error.value = null
      await fetchTodos() // status/link changed at dispatch
      return result
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to start implementation'
      return null
    }
  }

  async function deleteTodo(id: string) {
    try {
      await api.deleteTodo(id)
      todos.value = todos.value.filter((t) => t.id !== id)
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to delete todo'
    }
  }

  // ----- Action items -----

  const openActionCount = computed(() => actions.value.filter((a) => a.status === 'open').length)

  async function fetchActions() {
    try {
      actions.value = await api.fetchActionItems()
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load action items'
    }
  }

  async function addAction(projectId: string, text: string, notes?: string) {
    try {
      const item = await api.createActionItem(projectId, text, notes)
      actions.value.unshift(item)
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to add action item'
    }
  }

  async function setActionStatus(id: string, status: ActionItemStatus) {
    try {
      const updated = await api.updateActionItem(id, { status })
      const idx = actions.value.findIndex((a) => a.id === id)
      if (idx >= 0) actions.value[idx] = updated
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to update action item'
    }
  }

  async function deleteAction(id: string) {
    try {
      await api.deleteActionItem(id)
      actions.value = actions.value.filter((a) => a.id !== id)
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to delete action item'
    }
  }

  // ----- Standup -----

  async function runStandup(projectId: string): Promise<api.StandupRunResult | null> {
    standupRunning.value.add(projectId)
    try {
      const result = await api.runStandup(projectId)
      error.value = null
      // Statuses flip (inbox → under_review → proposed) during a run.
      await fetchTodos()
      await fetchActions()
      return result
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Standup failed'
      return null
    } finally {
      standupRunning.value.delete(projectId)
    }
  }

  function clearError() {
    error.value = null
  }

  return {
    personas,
    personasById,
    lead,
    todos,
    actions,
    openActionCount,
    error,
    standupRunning,
    todosForProject,
    openTodoCount,
    fetchActions,
    addAction,
    setActionStatus,
    deleteAction,
    fetchPersonas,
    createPersona,
    updatePersona,
    deletePersona,
    uploadAvatar,
    fetchTodos,
    addTodo,
    setTodoStatus,
    implementTodo,
    deleteTodo,
    runStandup,
    clearError,
  }
})
