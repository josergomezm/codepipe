// Types matching backend schemas (redefined for frontend — can't import from server)

export type ProviderType = 'kiro' | 'gemini' | 'claude' | 'codex'
export type SessionStatus = 'live' | 'archived'
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type MessageStatus = 'streaming' | 'complete'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  status: MessageStatus
  metadata?: { toolName?: string; thinkingContent?: string; credits?: string; time?: string }
}

export interface Project {
  id: string
  name: string
  path: string
}

export interface Session {
  id: string
  provider: ProviderType
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  status: SessionStatus
  messages: ChatMessage[]
}

export interface SessionMeta {
  id: string
  provider: ProviderType
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  status: SessionStatus
}

// --- Helpers ---

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? res.statusText)
  }
  return res.json() as Promise<T>
}

// --- Sessions ---

export function fetchSessions(): Promise<SessionMeta[]> {
  return request<SessionMeta[]>('/api/sessions')
}

export function fetchSession(id: string): Promise<Session> {
  return request<Session>(`/api/sessions/${id}`)
}

export function createSession(provider: ProviderType, projectId: string): Promise<Session> {
  return request<Session>('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, projectId }),
  })
}

export async function deleteSession(id: string): Promise<void> {
  await request<unknown>(`/api/sessions/${id}`, { method: 'DELETE' })
}

// --- Projects ---

export function fetchProjects(): Promise<Project[]> {
  return request<Project[]>('/api/projects')
}

export function createProject(name: string, path: string): Promise<Project> {
  return request<Project>('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path }),
  })
}

export async function deleteProject(id: string): Promise<void> {
  await request<unknown>(`/api/projects/${id}`, { method: 'DELETE' })
}

// --- Browse (filesystem directory picker) ---

export interface BrowseResult {
  current: string
  parent: string | null
  entries: { name: string; type: 'directory' }[]
}

export function browsePath(path?: string): Promise<BrowseResult> {
  const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse'
  return request<BrowseResult>(url)
}
