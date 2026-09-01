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
  metadata?: {
    toolName?: string
    thinkingContent?: string
    credits?: string
    time?: string
    /** Persona who authored this message (team sessions). */
    personaId?: string
    /** 'deliberation' marks raw team-discussion output (collapsed in the UI). */
    kind?: 'deliberation'
  }
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

export type ServiceStatus = 'running' | 'stopped' | 'error'

export interface ServicePortInfo {
  host: string
  port: number
}

export interface ServiceConfig {
  id: string
  type: string
  label: string
  startCommand: string
  cwd?: string
}

export interface ServiceState {
  status: ServiceStatus
  pid?: number
  ports: Record<string, ServicePortInfo>
  uiUrl?: string
  logs: string[]
  error?: string
}

export interface ServiceWithState extends ServiceConfig {
  state: ServiceState
}

export interface ProjectStandupConfig {
  enabled: boolean
  /** Local hour of day (0-23) the standup runs. */
  hour: number
}

export interface Project {
  id: string
  name: string
  path: string
  devServer?: ProjectDevServer
  devServerStatus?: DevServerInfo | null
  services?: ServiceConfig[]
  standup?: ProjectStandupConfig
}

export type SessionKind = 'chat' | 'team' | 'work'

export interface Session {
  id: string
  provider: ProviderType
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  status: SessionStatus
  messages: ChatMessage[]
  model?: string
  kind?: SessionKind
}

export interface SessionMeta {
  id: string
  provider: ProviderType
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  status: SessionStatus
  model?: string
  kind?: SessionKind
}

// --- Team layer (todos, personas, standup) ---

export type TodoStatus = 'inbox' | 'under_review' | 'proposed' | 'approved' | 'done'

export interface TodoProposal {
  summary: string
  approach: string
  effort?: string
  personaId?: string
}

export interface Todo {
  id: string
  projectId: string
  text: string
  notes?: string
  status: TodoStatus
  proposal?: TodoProposal
  createdAt: number
  updatedAt: number
  /** When the idea reached 'done' (stamped server-side, cleared on reopen). */
  completedAt?: number
  /** The implementation ('work') session spawned for this idea, if any. */
  workSessionId?: string
}

export type ActionItemStatus = 'open' | 'done'

export interface ActionItem {
  id: string
  projectId: string
  text: string
  notes?: string
  status: ActionItemStatus
  /** Persona who raised it (absent for manually added items). */
  personaId?: string
  createdAt: number
  updatedAt: number
}

export interface Persona {
  id: string
  name: string
  role: string
  personality: string
  avatar?: string
  provider: ProviderType
  model?: string
  isLead: boolean
}

export interface StandupState {
  projectId: string
  lastRunAt?: number
  lastHash?: string
  teamSessionId?: string
}

export interface StandupRunResult {
  ran: boolean
  reason?: string
  sessionId?: string
}

export interface ModelOption {
  id: string
  name?: string
}

export interface ModelState {
  available: ModelOption[]
  current: string | null
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

export async function renameSession(id: string, title: string): Promise<void> {
  await request<unknown>(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

// --- Projects ---

export interface ReservedPort {
  port: number
  type: 'local'
  owner: string
}

export interface TailscaleMapping {
  tailscalePort: number
  localPort: number
  owner: string
}

export interface PortRegistry {
  reserved: ReservedPort[]
  tailscaleMappings: TailscaleMapping[]
}

export interface ProjectsResponse {
  projects: Project[]
  tailscaleHostname: string | null
  portRegistry?: PortRegistry
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

export function updateProject(id: string, data: { name?: string; devServer?: ProjectDevServer | null; standup?: ProjectStandupConfig | null }): Promise<Project> {
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

// --- Services ---

export interface FirebaseDetectionResult {
  found: boolean
  firebaseDir: string | null
  scriptName: string | null
  startCommand: string | null
  defaultPorts: Record<string, number>
}

export interface DetectFirebaseResponse {
  detection: FirebaseDetectionResult
  suggested: ServiceConfig | null
}

export function fetchServices(projectId: string): Promise<{ services: ServiceWithState[] }> {
  return request<{ services: ServiceWithState[] }>(`/api/projects/${projectId}/services`)
}

export function addService(projectId: string, config: Omit<ServiceConfig, 'id'> & { id?: string }): Promise<ServiceConfig> {
  return request<ServiceConfig>(`/api/projects/${projectId}/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
}

export function updateService(projectId: string, serviceId: string, data: Partial<ServiceConfig>): Promise<ServiceConfig> {
  return request<ServiceConfig>(`/api/projects/${projectId}/services/${serviceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deleteService(projectId: string, serviceId: string): Promise<void> {
  await request<unknown>(`/api/projects/${projectId}/services/${serviceId}`, { method: 'DELETE' })
}

export function startService(projectId: string, serviceId: string): Promise<ServiceState> {
  return request<ServiceState>(`/api/projects/${projectId}/services/${serviceId}/start`, {
    method: 'POST',
  })
}

export function stopService(projectId: string, serviceId: string): Promise<{ ok: boolean; wasRunning: boolean }> {
  return request<{ ok: boolean; wasRunning: boolean }>(`/api/projects/${projectId}/services/${serviceId}/stop`, {
    method: 'POST',
  })
}

export function getServiceStatus(projectId: string, serviceId: string): Promise<ServiceState> {
  return request<ServiceState>(`/api/projects/${projectId}/services/${serviceId}/status`)
}

export function detectFirebase(projectId: string): Promise<DetectFirebaseResponse> {
  return request<DetectFirebaseResponse>(`/api/projects/${projectId}/services/detect/firebase`)
}

// --- Todos ---

export function fetchTodos(projectId?: string): Promise<Todo[]> {
  const url = projectId ? `/api/todos?projectId=${encodeURIComponent(projectId)}` : '/api/todos'
  return request<Todo[]>(url)
}

export function createTodo(projectId: string, text: string, notes?: string): Promise<Todo> {
  return request<Todo>('/api/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, text, ...(notes ? { notes } : {}) }),
  })
}

export function updateTodo(id: string, data: { text?: string; notes?: string; status?: TodoStatus }): Promise<Todo> {
  return request<Todo>(`/api/todos/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deleteTodo(id: string): Promise<void> {
  await request<unknown>(`/api/todos/${id}`, { method: 'DELETE' })
}

export async function implementTodo(id: string): Promise<StandupRunResult> {
  const res = await fetch(`/api/todos/${id}/implement`, { method: 'POST' })
  // 409 = skipped (no proposal / already building) — the body says why.
  if (res.status === 409) return res.json() as Promise<StandupRunResult>
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? res.statusText)
  }
  return res.json() as Promise<StandupRunResult>
}

// --- Action items ---

export function fetchActionItems(projectId?: string): Promise<ActionItem[]> {
  const url = projectId ? `/api/actions?projectId=${encodeURIComponent(projectId)}` : '/api/actions'
  return request<ActionItem[]>(url)
}

export function createActionItem(projectId: string, text: string, notes?: string): Promise<ActionItem> {
  return request<ActionItem>('/api/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, text, ...(notes ? { notes } : {}) }),
  })
}

export function updateActionItem(
  id: string,
  data: { text?: string; notes?: string; status?: ActionItemStatus },
): Promise<ActionItem> {
  return request<ActionItem>(`/api/actions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deleteActionItem(id: string): Promise<void> {
  await request<unknown>(`/api/actions/${id}`, { method: 'DELETE' })
}

// --- Personas ---

export function fetchPersonas(): Promise<Persona[]> {
  return request<Persona[]>('/api/personas')
}

export function createPersona(data: Omit<Persona, 'id' | 'avatar'>): Promise<Persona> {
  return request<Persona>('/api/personas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export function updatePersona(id: string, data: Partial<Omit<Persona, 'id' | 'avatar'>>): Promise<Persona> {
  return request<Persona>(`/api/personas/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deletePersona(id: string): Promise<void> {
  await request<unknown>(`/api/personas/${id}`, { method: 'DELETE' })
}

export async function uploadPersonaAvatar(id: string, file: File): Promise<Persona> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(`/api/personas/${id}/avatar`, { method: 'POST', body: formData })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? res.statusText)
  }
  return res.json() as Promise<Persona>
}

export function personaAvatarUrl(persona: Persona): string | null {
  return persona.avatar ? `/api/avatars/${persona.avatar}` : null
}

// --- Standup ---

export async function runStandup(projectId: string): Promise<StandupRunResult> {
  const res = await fetch(`/api/standup/${projectId}/run`, { method: 'POST' })
  // 409 = skipped (already running / nothing to do) — the body says why.
  if (res.status === 409) return res.json() as Promise<StandupRunResult>
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? res.statusText)
  }
  return res.json() as Promise<StandupRunResult>
}

export function fetchStandupState(projectId: string): Promise<StandupState> {
  return request<StandupState>(`/api/standup/${projectId}`)
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
