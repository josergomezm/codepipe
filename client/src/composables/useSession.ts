import { ref, readonly } from 'vue'
import { useSessionsStore } from '../stores/sessions'

// Singleton state — shared across all components that call useSession()
const isConnected = ref(false)
const connectionError = ref<string | null>(null)

/** Max delay between reconnect attempts (30 seconds). */
const MAX_RECONNECT_DELAY_MS = 30_000

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let currentSessionId: string | null = null

function connect(sessionId: string) {
  // If already connected or connecting to this session, don't reconnect
  if (
    currentSessionId === sessionId &&
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return
  }

  // Clean up any previous connection
  cleanupSocket()
  currentSessionId = sessionId

  try {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${window.location.host}/ws?sessionId=${sessionId}`)
  } catch {
    // WebSocket constructor can throw if URL is invalid
    return
  }

  ws.onopen = () => {
    isConnected.value = true
    connectionError.value = null
    reconnectAttempts = 0

    // Send any pending initial message (e.g., from createSessionWithPrompt)
    const store = useSessionsStore()
    const pending = store.consumePendingMessage()
    if (pending && ws && ws.readyState === WebSocket.OPEN) {
      // Small delay to let the CLI process initialize
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: pending }))
        }
      }, 1000)
    }
  }

  ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string)
      const store = useSessionsStore()

      // Guard: ignore messages from a session that's no longer active.
      // This prevents a slow/late response from a previous session from
      // overwriting the current session's messages.
      if (currentSessionId !== store.activeSessionId) {
        return
      }

      switch (msg.type) {
        case 'history':
          store.setMessages(msg.data)
          break
        case 'message':
          store.upsertMessage(msg.data)
          break
        case 'status':
          store.setStatus(msg.data)
          break
        case 'model_state':
          store.setModelState(msg.data)
          break
        case 'error':
          connectionError.value = msg.data
          break
      }
    } catch {
      // Ignore malformed messages
    }
  }

  ws.onclose = () => {
    isConnected.value = false

    // Don't reconnect if we switched sessions
    if (!currentSessionId) return

    // Auto-reconnect with exponential backoff, no attempt limit.
    // Delay: 2s → 4s → 8s → 16s → 30s (capped), then 30s forever.
    const delay = Math.min(2000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS)
    connectionError.value = 'Connection lost — retrying...'
    reconnectTimer = setTimeout(() => {
      reconnectAttempts++
      if (currentSessionId) {
        connect(currentSessionId)
      }
    }, delay)
  }

  ws.onerror = () => {
    // Only set the error if we don't already have a more specific one from onclose
    if (!connectionError.value) {
      connectionError.value = 'Connection lost — retrying...'
    }
  }
}

/**
 * Tear down the current WebSocket without resetting session-level state.
 * Silences the "WebSocket is closed before the connection is established"
 * warning by stripping event handlers before closing a CONNECTING socket.
 */
function cleanupSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0

  if (ws) {
    // Remove handlers first so the close/error events don't fire
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    ws.close()
    ws = null
  }
  isConnected.value = false
}

function disconnect() {
  currentSessionId = null
  cleanupSocket()
}

function sendMessage(text: string, attachments?: import('../api/client').Attachment[]): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false
  }

  // Guard: only send if the WebSocket is connected to the session the user
  // is currently viewing. Without this check, a race between session switching
  // and message sending can route input to the wrong CLI process.
  const store = useSessionsStore()
  if (!currentSessionId || currentSessionId !== store.activeSessionId) {
    return false
  }

  ws.send(JSON.stringify({
    type: 'input',
    data: text,
    ...(attachments?.length ? { attachments } : {}),
  }))
  return true
}

/**
 * Cancel the in-flight turn (Stop button). Tells the backend to stop the CLI
 * and drain the queue. Returns false if not connected to the active session.
 */
function cancel(): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  const store = useSessionsStore()
  if (!currentSessionId || currentSessionId !== store.activeSessionId) return false
  ws.send(JSON.stringify({ type: 'cancel' }))
  return true
}

/** Select the model for the active session. Returns false if not connected. */
function setModel(model: string): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  const store = useSessionsStore()
  if (!currentSessionId || currentSessionId !== store.activeSessionId) return false
  ws.send(JSON.stringify({ type: 'set_model', model }))
  return true
}

function clearConnectionError() {
  connectionError.value = null
}

export function useSession() {
  return {
    connect,
    disconnect,
    sendMessage,
    cancel,
    setModel,
    clearConnectionError,
    isConnected,
    connectionError: readonly(connectionError),
  }
}
