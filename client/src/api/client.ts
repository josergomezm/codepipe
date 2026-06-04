// Types matching backend schemas (redefined for frontend — can't import from server)

export type ProviderType = 'kiro' | 'gemini' | 'claude' | 'codex'
export type SessionStatus = 'live' | 'archived'
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type MessageStatus = 'streaming' | 'complete'

export interface Attachment {
  id: string
  filename: string
  mimeType: string
  size: number
  path: string
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  status: MessageStatus
  metadata?: { toolName?: string; thinkingContent?: string; credits?: string; time?: string }
  attachments?: Attachment[]
}

export interface ProjectDevServer {
  startCommand: string
  port: number
  tailscalePort?: number
  cwd?: string
}

export interface DevServerInfo {
  status: 'running' | 'stopped'
  port: number
  tailscalePort: number
  url: string | null
  tailscaleMapped: boolean
}

export interface Project {
  id: string
  name: string
  path: string
  devServer?: ProjectDevServer
  devServerStatus?: DevServerInfo | null
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

export interface ProjectsResponse {
  projects: Project[]
  tailscaleHostname: string | null
}

export async function fetchProjects(): Promise<ProjectsResponse> {
  return request<ProjectsResponse>('/api/projects')
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

export function updateProject(id: string, data: { name?: string; devServer?: ProjectDevServer | null }): Promise<Project> {
  return request<Project>(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export function startDevServer(projectId: string): Promise<DevServerInfo> {
  return request<DevServerInfo>(`/api/projects/${projectId}/dev-server/start`, {
    method: 'POST',
  })
}

export function stopDevServer(projectId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/projects/${projectId}/dev-server/stop`, {
    method: 'POST',
  })
}

export interface DetectedDevServer {
  startCommand: string | null
  packageManager: 'npm' | 'bun' | 'pnpm' | 'yarn' | null
  script: string | null
  availableScripts: string[]
  subDir: string | null
  port: number | null
  tailscalePort: number | null
  framework: string | null
}

export function detectDevServer(projectId: string): Promise<DetectedDevServer> {
  return request<DetectedDevServer>(`/api/projects/${projectId}/detect-dev-server`)
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

// --- Upload ---

export async function uploadFile(file: File): Promise<Attachment> {
  const formData = new FormData()
  formData.append('file', file)

  const res = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? res.statusText)
  }
  return res.json() as Promise<Attachment>
}
