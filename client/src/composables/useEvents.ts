import { useSessionsStore } from '../stores/sessions'
import { useProjectsStore } from '../stores/projects'
import { useTeamStore } from '../stores/team'

/**
 * Global change-hint subscription (/ws?events=1).
 *
 * The server broadcasts `{ type: 'changed', collection }` whenever storage
 * commits a mutation; we refetch the matching store. Events are hints, not
 * data — the REST reads stay the single source of truth, so a dropped event
 * costs freshness, never correctness. Reconnects with capped backoff, and
 * refetches everything after a reconnect to cover the gap.
 */

const MAX_RECONNECT_DELAY_MS = 30_000

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let started = false

function refetch(collection: string) {
  const sessions = useSessionsStore()
  const projects = useProjectsStore()
  const team = useTeamStore()

  switch (collection) {
    case 'sessions':
      void sessions.fetchSessions()
      break
    case 'projects':
      void projects.fetchProjects()
      break
    case 'todos':
      void team.fetchTodos()
      break
    case 'actions':
      void team.fetchActions()
      break
    case 'personas':
      void team.fetchPersonas()
      break
    // 'standup' state has no store of its own — views fetch it on demand.
  }
}

function refetchAll() {
  for (const collection of ['sessions', 'projects', 'todos', 'actions', 'personas']) {
    refetch(collection)
  }
}

function connect() {
  try {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${window.location.host}/ws?events=1`)
  } catch {
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    // Anything could have changed while we were disconnected.
    if (reconnectAttempts > 0) refetchAll()
    reconnectAttempts = 0
  }

  ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string)
      if (msg?.type === 'changed' && typeof msg.collection === 'string') {
        refetch(msg.collection)
      }
    } catch {
      // Malformed frame — ignore
    }
  }

  ws.onclose = () => {
    ws = null
    scheduleReconnect()
  }

  ws.onerror = () => {
    ws?.close()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS)
  reconnectAttempts++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

/** Start the (singleton) events subscription. Safe to call more than once. */
export function startEvents(): void {
  if (started) return
  started = true
  connect()
}
