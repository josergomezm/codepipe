import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import {
  SessionSchema,
  ProjectSchema,
  type Session,
  type SessionMeta,
  type ChatMessage,
  type Project,
  type SessionStatus,
} from './schemas.js'

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

  // Projects
  listProjects(): Promise<Project[]>
  addProject(project: Omit<Project, 'id'>): Promise<Project>
  removeProject(projectId: string): Promise<void>
  getProject(projectId: string): Promise<Project | null>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const ProjectArraySchema = z.array(ProjectSchema)

export class StorageLayer implements IStorageLayer {
  private readonly dataDir: string
  private readonly sessionsDir: string
  private readonly projectsFile: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.sessionsDir = path.join(dataDir, 'sessions')
    this.projectsFile = path.join(dataDir, 'projects.json')
  }

  // -----------------------------------------------------------------------
  // Startup
  // -----------------------------------------------------------------------

  async ensureDataDir(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    await mkdir(this.sessionsDir, { recursive: true })
  }

  // -----------------------------------------------------------------------
  // Atomic write helper
  // -----------------------------------------------------------------------

  async atomicWrite(filePath: string, data: unknown): Promise<void> {
    const tempPath = filePath + '.tmp.' + randomUUID()
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8')
    await rename(tempPath, filePath)
  }

  // -----------------------------------------------------------------------
  // Projects
  // -----------------------------------------------------------------------

  private async loadProjects(): Promise<Project[]> {
    if (!existsSync(this.projectsFile)) {
      return []
    }
    try {
      const raw = await readFile(this.projectsFile, 'utf-8')
      const parsed = JSON.parse(raw)
      const result = ProjectArraySchema.safeParse(parsed)
      if (!result.success) {
        console.error(
          'Storage: projects.json failed validation, returning empty list:',
          result.error.format(),
        )
        return []
      }
      return result.data
    } catch (err) {
      console.error('Storage: failed to read projects.json:', err)
      return []
    }
  }

  async listProjects(): Promise<Project[]> {
    return this.loadProjects()
  }

  async addProject(project: Omit<Project, 'id'>): Promise<Project> {
    const projects = await this.loadProjects()
    const newProject: Project = {
      id: randomUUID(),
      ...project,
    }
    projects.push(newProject)
    await this.atomicWrite(this.projectsFile, projects)
    return newProject
  }

  async removeProject(projectId: string): Promise<void> {
    const projects = await this.loadProjects()
    const filtered = projects.filter((p) => p.id !== projectId)
    await this.atomicWrite(this.projectsFile, filtered)
  }

  async getProject(projectId: string): Promise<Project | null> {
    const projects = await this.loadProjects()
    return projects.find((p) => p.id === projectId) ?? null
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

  async saveSession(session: Session): Promise<void> {
    await this.atomicWrite(this.sessionPath(session.id), session)
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.loadSession(sessionId)
  }

  async listSessions(): Promise<SessionMeta[]> {
    if (!existsSync(this.sessionsDir)) {
      return []
    }
    const files = await readdir(this.sessionsDir)
    const metas: SessionMeta[] = []

    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const sessionId = file.replace('.json', '')
      const session = await this.loadSession(sessionId)
      if (session) {
        // Omit messages to return metadata only
        const { messages: _, ...meta } = session
        metas.push(meta)
      }
    }

    return metas
  }

  async deleteSession(sessionId: string): Promise<void> {
    const filePath = this.sessionPath(sessionId)
    if (existsSync(filePath)) {
      await unlink(filePath)
    }
  }

  async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
    const session = await this.loadSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }
    session.messages.push(message)
    session.updatedAt = message.timestamp
    await this.atomicWrite(this.sessionPath(sessionId), session)
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const session = await this.loadSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }
    session.status = status
    session.updatedAt = Date.now()
    await this.atomicWrite(this.sessionPath(sessionId), session)
  }
}
