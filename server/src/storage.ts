import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import {
  SessionSchema,
  SessionMetaSchema,
  ProjectSchema,
  TodoSchema,
  ActionItemSchema,
  PersonaSchema,
  StandupStateSchema,
  type Session,
  type SessionMeta,
  type ChatMessage,
  type Project,
  type SessionStatus,
  type Todo,
  type ActionItem,
  type Persona,
  type StandupState,
} from './schemas.js'
import type { ChangedCollection } from './events.js'

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IStorageLayer {
  // Sessions
  saveSession(session: Session): Promise<void>
  getSession(sessionId: string): Promise<Session | null>
  listSessions(): Promise<SessionMeta[]>
  deleteSession(sessionId: string): Promise<void>
  appendMessage(sessionId: string, message: ChatMessage): Promise<void>
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  // Projects
  listProjects(): Promise<Project[]>
  addProject(project: Omit<Project, 'id'>): Promise<Project>
  updateProject(projectId: string, data: Partial<Omit<Project, 'id'>>): Promise<Project>
  removeProject(projectId: string): Promise<void>
  getProject(projectId: string): Promise<Project | null>
  // Todos
  listTodos(projectId?: string): Promise<Todo[]>
  addTodo(data: { projectId: string; text: string; notes?: string }): Promise<Todo>
  updateTodo(todoId: string, data: Partial<Omit<Todo, 'id' | 'projectId' | 'createdAt'>>): Promise<Todo>
  removeTodo(todoId: string): Promise<void>
  removeTodosByProject(projectId: string): Promise<void>
  // Action items
  listActionItems(projectId?: string): Promise<ActionItem[]>
  addActionItem(data: { projectId: string; text: string; notes?: string; personaId?: string }): Promise<ActionItem>
  updateActionItem(actionId: string, data: Partial<Omit<ActionItem, 'id' | 'projectId' | 'createdAt'>>): Promise<ActionItem>
  removeActionItem(actionId: string): Promise<void>
  removeActionItemsByProject(projectId: string): Promise<void>
  // Personas
  listPersonas(): Promise<Persona[]>
  addPersona(persona: Omit<Persona, 'id'>): Promise<Persona>
  updatePersona(personaId: string, data: Partial<Omit<Persona, 'id'>>): Promise<Persona>
  removePersona(personaId: string): Promise<void>
  // Standup state
  getStandupState(projectId: string): Promise<StandupState | null>
  setStandupState(state: StandupState): Promise<void>
  removeStandupState(projectId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const ProjectArraySchema = z.array(ProjectSchema)
const TodoArraySchema = z.array(TodoSchema)
const ActionItemArraySchema = z.array(ActionItemSchema)
const PersonaArraySchema = z.array(PersonaSchema)
const StandupStateArraySchema = z.array(StandupStateSchema)

export class StorageLayer implements IStorageLayer {
  private readonly dataDir: string
  private readonly sessionsDir: string
  private readonly projectsFile: string
  private readonly indexFile: string
  private readonly todosFile: string
  private readonly actionItemsFile: string
  private readonly personasFile: string
  private readonly standupStateFile: string
  /**
   * Per-file locks. Every read-modify-write runs exclusively under its
   * file's lock (see runExclusive) — two concurrent updates to the same
   * collection serialize instead of losing one of the writes.
   */
  private readonly fileLocks = new Map<string, Promise<void>>()
  /** Change-capture hook: called once per committed mutation, per collection. */
  private readonly onChange: ((collection: ChangedCollection) => void) | null
  /**
   * In-memory session-metadata index, keyed by session ID. Lets `listSessions`
   * answer from memory instead of reading (and parsing) every session file on
   * each call. Lazily built from disk on first use, then kept in sync on every
   * mutation, and persisted to `index.json` so it survives restarts.
   */
  private indexCache: Record<string, SessionMeta> | null = null

  constructor(dataDir: string, onChange?: (collection: ChangedCollection) => void) {
    this.dataDir = dataDir
    this.sessionsDir = path.join(dataDir, 'sessions')
    this.projectsFile = path.join(dataDir, 'projects.json')
    this.indexFile = path.join(dataDir, 'index.json')
    this.todosFile = path.join(dataDir, 'todos.json')
    this.actionItemsFile = path.join(dataDir, 'action-items.json')
    this.personasFile = path.join(dataDir, 'personas.json')
    this.standupStateFile = path.join(dataDir, 'standup-state.json')
    this.onChange = onChange ?? null
  }

  /** Fire the change-capture hook; a subscriber failure never fails a write. */
  private notify(collection: ChangedCollection): void {
    try {
      this.onChange?.(collection)
    } catch {
      // Change hints are best-effort by design
    }
  }

  // -----------------------------------------------------------------------
  // Startup
  // -----------------------------------------------------------------------

  async ensureDataDir(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    await mkdir(this.sessionsDir, { recursive: true })
    // Clean up orphaned temp files from previous runs
    await this.cleanupTempFiles()
  }

  /**
   * Remove any .tmp. files left behind by failed atomic writes.
   */
  private async cleanupTempFiles(): Promise<void> {
    try {
      const dirs = [this.dataDir, this.sessionsDir]
      for (const dir of dirs) {
        if (!existsSync(dir)) continue
        const files = await readdir(dir)
        for (const file of files) {
          if (file.includes('.tmp.')) {
            try {
              await unlink(path.join(dir, file))
            } catch {
              // Ignore — file may be locked
            }
          }
        }
      }
    } catch {
      // Non-critical — don't fail startup
    }
  }

  // -----------------------------------------------------------------------
  // Exclusivity + atomic write helpers
  // -----------------------------------------------------------------------

  /**
   * Run `fn` exclusively for a file: operations on the same path execute one
   * at a time, in arrival order. This is what makes load → mutate → write
   * safe under concurrency — the lock covers the whole transaction, not just
   * the final write. Locks are per-path promise chains; a failed operation
   * doesn't poison the chain. NOT reentrant: never nest runExclusive calls
   * on the same path (use atomicWrite directly inside a held lock).
   */
  private runExclusive<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.fileLocks.get(filePath) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.fileLocks.set(
      filePath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /** Whole-object write under the file's lock (no read-back involved). */
  private async serializedWrite(filePath: string, data: unknown): Promise<void> {
    await this.runExclusive(filePath, () => this.atomicWrite(filePath, data))
  }

  private async atomicWrite(filePath: string, data: unknown): Promise<void> {
    const json = JSON.stringify(data, null, 2)
    const tempPath = filePath + '.tmp.' + randomUUID()
    try {
      await writeFile(tempPath, json, 'utf-8')
      await rename(tempPath, filePath)
    } catch {
      // On Windows, rename can fail if the target is locked.
      // Fall back to direct write — use flag 'w' to ensure the file is
      // truncated first so no stale tail bytes remain from a longer
      // previous write.
      try {
        await unlink(tempPath)
      } catch {
        // Temp file may not exist
      }
      await writeFile(filePath, json, { encoding: 'utf-8', flag: 'w' })
    }
  }

  // -----------------------------------------------------------------------
  // Generic JSON-array file helper
  // -----------------------------------------------------------------------

  private async loadArrayFile<T>(file: string, schema: z.ZodType<T[]>): Promise<T[]> {
    if (!existsSync(file)) {
      return []
    }
    try {
      const raw = await readFile(file, 'utf-8')
      const parsed = JSON.parse(raw)
      const result = schema.safeParse(parsed)
      if (!result.success) {
        console.error(
          `Storage: ${path.basename(file)} failed validation, returning empty list:`,
          result.error.format(),
        )
        return []
      }
      return result.data
    } catch (err) {
      console.error(`Storage: failed to read ${path.basename(file)}:`, err)
      return []
    }
  }

  // -----------------------------------------------------------------------
  // Projects
  // -----------------------------------------------------------------------

  private async loadProjects(): Promise<Project[]> {
    return this.loadArrayFile(this.projectsFile, ProjectArraySchema)
  }

  async listProjects(): Promise<Project[]> {
    return this.loadProjects()
  }

  async addProject(project: Omit<Project, 'id'>): Promise<Project> {
    const created = await this.runExclusive(this.projectsFile, async () => {
      const projects = await this.loadProjects()
      const newProject: Project = {
        id: randomUUID(),
        ...project,
      }
      projects.push(newProject)
      await this.atomicWrite(this.projectsFile, projects)
      return newProject
    })
    this.notify('projects')
    return created
  }

  async removeProject(projectId: string): Promise<void> {
    await this.runExclusive(this.projectsFile, async () => {
      const projects = await this.loadProjects()
      await this.atomicWrite(this.projectsFile, projects.filter((p) => p.id !== projectId))
    })
    this.notify('projects')
  }

  async updateProject(projectId: string, data: Partial<Omit<Project, 'id'>>): Promise<Project> {
    const updated = await this.runExclusive(this.projectsFile, async () => {
      const projects = await this.loadProjects()
      const index = projects.findIndex((p) => p.id === projectId)
      if (index === -1) {
        throw new Error(`Project ${projectId} not found`)
      }
      projects[index] = { ...projects[index], ...data }
      await this.atomicWrite(this.projectsFile, projects)
      return projects[index]
    })
    this.notify('projects')
    return updated
  }

  async getProject(projectId: string): Promise<Project | null> {
    const projects = await this.loadProjects()
    return projects.find((p) => p.id === projectId) ?? null
  }

  // -----------------------------------------------------------------------
  // Todos
  // -----------------------------------------------------------------------

  async listTodos(projectId?: string): Promise<Todo[]> {
    const todos = await this.loadArrayFile(this.todosFile, TodoArraySchema)
    return projectId ? todos.filter((t) => t.projectId === projectId) : todos
  }

  async addTodo(data: { projectId: string; text: string; notes?: string }): Promise<Todo> {
    const created = await this.runExclusive(this.todosFile, async () => {
      const todos = await this.loadArrayFile(this.todosFile, TodoArraySchema)
      const now = Date.now()
      const todo: Todo = {
        id: randomUUID(),
        projectId: data.projectId,
        text: data.text,
        ...(data.notes ? { notes: data.notes } : {}),
        status: 'inbox',
        createdAt: now,
        updatedAt: now,
      }
      todos.push(todo)
      await this.atomicWrite(this.todosFile, todos)
      return todo
    })
    this.notify('todos')
    return created
  }

  async updateTodo(
    todoId: string,
    data: Partial<Omit<Todo, 'id' | 'projectId' | 'createdAt'>>,
  ): Promise<Todo> {
    const updated = await this.runExclusive(this.todosFile, async () => {
      const todos = await this.loadArrayFile(this.todosFile, TodoArraySchema)
      const index = todos.findIndex((t) => t.id === todoId)
      if (index === -1) {
        throw new Error(`Todo ${todoId} not found`)
      }
      const current = todos[index]
      const next: Todo = { ...current, ...data, updatedAt: Date.now() }
      // The completion timestamp is owned here so the ledger stays consistent:
      // stamped on the transition into 'done', cleared when the idea reopens.
      if (data.status && data.status !== current.status) {
        if (data.status === 'done') next.completedAt = Date.now()
        else delete next.completedAt
      }
      todos[index] = next
      await this.atomicWrite(this.todosFile, todos)
      return next
    })
    this.notify('todos')
    return updated
  }

  async removeTodo(todoId: string): Promise<void> {
    await this.runExclusive(this.todosFile, async () => {
      const todos = await this.loadArrayFile(this.todosFile, TodoArraySchema)
      await this.atomicWrite(this.todosFile, todos.filter((t) => t.id !== todoId))
    })
    this.notify('todos')
  }

  async removeTodosByProject(projectId: string): Promise<void> {
    await this.runExclusive(this.todosFile, async () => {
      const todos = await this.loadArrayFile(this.todosFile, TodoArraySchema)
      await this.atomicWrite(this.todosFile, todos.filter((t) => t.projectId !== projectId))
    })
    this.notify('todos')
  }

  // -----------------------------------------------------------------------
  // Action items
  // -----------------------------------------------------------------------

  async listActionItems(projectId?: string): Promise<ActionItem[]> {
    const items = await this.loadArrayFile(this.actionItemsFile, ActionItemArraySchema)
    return projectId ? items.filter((a) => a.projectId === projectId) : items
  }

  async addActionItem(data: {
    projectId: string
    text: string
    notes?: string
    personaId?: string
  }): Promise<ActionItem> {
    const created = await this.runExclusive(this.actionItemsFile, async () => {
      const items = await this.loadArrayFile(this.actionItemsFile, ActionItemArraySchema)
      const now = Date.now()
      const item: ActionItem = {
        id: randomUUID(),
        projectId: data.projectId,
        text: data.text,
        ...(data.notes ? { notes: data.notes } : {}),
        ...(data.personaId ? { personaId: data.personaId } : {}),
        status: 'open',
        createdAt: now,
        updatedAt: now,
      }
      items.push(item)
      await this.atomicWrite(this.actionItemsFile, items)
      return item
    })
    this.notify('actions')
    return created
  }

  async updateActionItem(
    actionId: string,
    data: Partial<Omit<ActionItem, 'id' | 'projectId' | 'createdAt'>>,
  ): Promise<ActionItem> {
    const updated = await this.runExclusive(this.actionItemsFile, async () => {
      const items = await this.loadArrayFile(this.actionItemsFile, ActionItemArraySchema)
      const index = items.findIndex((a) => a.id === actionId)
      if (index === -1) {
        throw new Error(`Action item ${actionId} not found`)
      }
      items[index] = { ...items[index], ...data, updatedAt: Date.now() }
      await this.atomicWrite(this.actionItemsFile, items)
      return items[index]
    })
    this.notify('actions')
    return updated
  }

  async removeActionItem(actionId: string): Promise<void> {
    await this.runExclusive(this.actionItemsFile, async () => {
      const items = await this.loadArrayFile(this.actionItemsFile, ActionItemArraySchema)
      await this.atomicWrite(this.actionItemsFile, items.filter((a) => a.id !== actionId))
    })
    this.notify('actions')
  }

  async removeActionItemsByProject(projectId: string): Promise<void> {
    await this.runExclusive(this.actionItemsFile, async () => {
      const items = await this.loadArrayFile(this.actionItemsFile, ActionItemArraySchema)
      await this.atomicWrite(this.actionItemsFile, items.filter((a) => a.projectId !== projectId))
    })
    this.notify('actions')
  }

  // -----------------------------------------------------------------------
  // Personas
  // -----------------------------------------------------------------------

  async listPersonas(): Promise<Persona[]> {
    return this.loadArrayFile(this.personasFile, PersonaArraySchema)
  }

  async addPersona(persona: Omit<Persona, 'id'>): Promise<Persona> {
    const created = await this.runExclusive(this.personasFile, async () => {
      const personas = await this.loadArrayFile(this.personasFile, PersonaArraySchema)
      const newPersona: Persona = { id: randomUUID(), ...persona }
      // A team has exactly one lead: promoting a new lead demotes the others.
      if (newPersona.isLead) {
        for (const p of personas) p.isLead = false
      }
      personas.push(newPersona)
      await this.atomicWrite(this.personasFile, personas)
      return newPersona
    })
    this.notify('personas')
    return created
  }

  async updatePersona(
    personaId: string,
    data: Partial<Omit<Persona, 'id'>>,
  ): Promise<Persona> {
    const updated = await this.runExclusive(this.personasFile, async () => {
      const personas = await this.loadArrayFile(this.personasFile, PersonaArraySchema)
      const index = personas.findIndex((p) => p.id === personaId)
      if (index === -1) {
        throw new Error(`Persona ${personaId} not found`)
      }
      if (data.isLead) {
        for (const p of personas) p.isLead = false
      }
      personas[index] = { ...personas[index], ...data }
      await this.atomicWrite(this.personasFile, personas)
      return personas[index]
    })
    this.notify('personas')
    return updated
  }

  async removePersona(personaId: string): Promise<void> {
    await this.runExclusive(this.personasFile, async () => {
      const personas = await this.loadArrayFile(this.personasFile, PersonaArraySchema)
      await this.atomicWrite(this.personasFile, personas.filter((p) => p.id !== personaId))
    })
    this.notify('personas')
  }

  // -----------------------------------------------------------------------
  // Standup state
  // -----------------------------------------------------------------------

  async getStandupState(projectId: string): Promise<StandupState | null> {
    const states = await this.loadArrayFile(this.standupStateFile, StandupStateArraySchema)
    return states.find((s) => s.projectId === projectId) ?? null
  }

  async setStandupState(state: StandupState): Promise<void> {
    await this.runExclusive(this.standupStateFile, async () => {
      const states = await this.loadArrayFile(this.standupStateFile, StandupStateArraySchema)
      const index = states.findIndex((s) => s.projectId === state.projectId)
      if (index === -1) states.push(state)
      else states[index] = state
      await this.atomicWrite(this.standupStateFile, states)
    })
    this.notify('standup')
  }

  async removeStandupState(projectId: string): Promise<void> {
    await this.runExclusive(this.standupStateFile, async () => {
      const states = await this.loadArrayFile(this.standupStateFile, StandupStateArraySchema)
      await this.atomicWrite(this.standupStateFile, states.filter((s) => s.projectId !== projectId))
    })
    this.notify('standup')
  }

  // -----------------------------------------------------------------------
  // Sessions
  // -----------------------------------------------------------------------

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`)
  }

  private async loadSession(sessionId: string): Promise<Session | null> {
    const filePath = this.sessionPath(sessionId)
    if (!existsSync(filePath)) {
      return null
    }
    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      const result = SessionSchema.safeParse(parsed)
      if (!result.success) {
        console.error(
          `Storage: session ${sessionId} failed validation:`,
          result.error.format(),
        )
        return null
      }
      return result.data
    } catch (err) {
      console.error(`Storage: failed to read session ${sessionId}:`, err)
      return null
    }
  }

  // ----- Session index (fast listing) -----

  private static metaOf(session: Session): SessionMeta {
    const { messages: _messages, ...meta } = session
    return meta
  }

  /** Load the index from memory, or from disk, rebuilding from session files if absent/corrupt. */
  private async loadIndex(): Promise<Record<string, SessionMeta>> {
    if (this.indexCache) return this.indexCache

    if (existsSync(this.indexFile)) {
      try {
        const raw = await readFile(this.indexFile, 'utf-8')
        const parsed = JSON.parse(raw)
        const result = z.record(SessionMetaSchema).safeParse(parsed)
        if (result.success) {
          this.indexCache = result.data
          return this.indexCache
        }
        console.error('Storage: index.json failed validation, rebuilding')
      } catch (err) {
        console.error('Storage: failed to read index.json, rebuilding:', err)
      }
    }

    this.indexCache = await this.rebuildIndex()
    await this.persistIndex()
    return this.indexCache
  }

  /** Rebuild the index by scanning every session file (migration / recovery path). */
  private async rebuildIndex(): Promise<Record<string, SessionMeta>> {
    const index: Record<string, SessionMeta> = {}
    if (!existsSync(this.sessionsDir)) return index
    const files = await readdir(this.sessionsDir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const session = await this.loadSession(file.replace('.json', ''))
      if (session) index[session.id] = StorageLayer.metaOf(session)
    }
    return index
  }

  private async persistIndex(): Promise<void> {
    if (this.indexCache) await this.serializedWrite(this.indexFile, this.indexCache)
  }

  /** Upsert one session's metadata into the index and persist. */
  private async updateIndexEntry(session: Session): Promise<void> {
    const index = await this.loadIndex()
    index[session.id] = StorageLayer.metaOf(session)
    await this.persistIndex()
  }

  private async removeIndexEntry(sessionId: string): Promise<void> {
    const index = await this.loadIndex()
    if (sessionId in index) {
      delete index[sessionId]
      await this.persistIndex()
    }
  }

  async saveSession(session: Session): Promise<void> {
    await this.serializedWrite(this.sessionPath(session.id), session)
    await this.updateIndexEntry(session)
    this.notify('sessions')
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.loadSession(sessionId)
  }

  async listSessions(): Promise<SessionMeta[]> {
    const index = await this.loadIndex()
    return Object.values(index)
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.runExclusive(this.sessionPath(sessionId), async () => {
      const filePath = this.sessionPath(sessionId)
      if (existsSync(filePath)) {
        await unlink(filePath)
      }
    })
    await this.removeIndexEntry(sessionId)
    this.notify('sessions')
  }

  /** Run a load → mutate → write transaction on one session file. */
  private async mutateSession(
    sessionId: string,
    mutate: (session: Session) => void,
  ): Promise<Session> {
    const session = await this.runExclusive(this.sessionPath(sessionId), async () => {
      const loaded = await this.loadSession(sessionId)
      if (!loaded) {
        throw new Error(`Session ${sessionId} not found`)
      }
      mutate(loaded)
      await this.atomicWrite(this.sessionPath(sessionId), loaded)
      return loaded
    })
    await this.updateIndexEntry(session)
    this.notify('sessions')
    return session
  }

  async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
    await this.mutateSession(sessionId, (session) => {
      // Upsert by id: a streaming message is persisted repeatedly as it
      // grows, so replace an existing entry rather than appending duplicates.
      const existing = session.messages.findIndex((m) => m.id === message.id)
      if (existing >= 0) {
        session.messages[existing] = message
      } else {
        session.messages.push(message)
      }
      session.updatedAt = message.timestamp
    })
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    await this.mutateSession(sessionId, (session) => {
      session.status = status
      session.updatedAt = Date.now()
    })
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.mutateSession(sessionId, (session) => {
      session.title = title
      session.updatedAt = Date.now()
    })
  }
}
