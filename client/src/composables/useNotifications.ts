import { ref, readonly } from 'vue'

/**
 * Web Push notifications: register the service worker, subscribe via the
 * PushManager using the server's VAPID public key, and report the
 * subscription to the backend so it can notify this device when an agent
 * finishes a turn.
 *
 * Notifications (and PWA install) require a secure context — i.e. HTTPS or
 * localhost. Over Tailscale you get HTTPS automatically, so installing the PWA
 * on your phone and enabling notifications works there.
 */

// Singleton reactive state, shared across components.
const supported = ref(false)
const serverEnabled = ref(false) // server has VAPID keys configured
const permission = ref<NotificationPermission>('default')
const subscribed = ref(false)
const busy = ref(false)
const lastError = ref<string | null>(null)

let vapidPublicKey: string | null = null
let initialized = false

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const output = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

async function init(): Promise<void> {
  if (initialized) return
  initialized = true

  supported.value =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (!supported.value) return

  permission.value = Notification.permission

  try {
    await navigator.serviceWorker.register('/sw.js')
  } catch (err) {
    lastError.value = err instanceof Error ? err.message : 'Service worker registration failed'
    return
  }

  // Does the server have push configured?
  try {
    const res = await fetch('/api/push/vapid-public-key')
    const data = await res.json()
    serverEnabled.value = Boolean(data.enabled && data.publicKey)
    vapidPublicKey = data.publicKey ?? null
  } catch {
    serverEnabled.value = false
  }

  // Already subscribed on this device?
  try {
    const reg = await navigator.serviceWorker.ready
    const existing = await reg.pushManager.getSubscription()
    subscribed.value = Boolean(existing)
  } catch {
    /* ignore */
  }
}

async function enable(): Promise<boolean> {
  lastError.value = null
  if (!supported.value || !serverEnabled.value || !vapidPublicKey) return false

  busy.value = true
  try {
    permission.value = await Notification.requestPermission()
    if (permission.value !== 'granted') {
      lastError.value = 'Notification permission was not granted'
      return false
    }

    const reg = await navigator.serviceWorker.ready
    const subscription =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      }))

    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    })
    if (!res.ok) {
      lastError.value = 'Server rejected the subscription'
      return false
    }

    subscribed.value = true
    return true
  } catch (err) {
    lastError.value = err instanceof Error ? err.message : 'Failed to enable notifications'
    return false
  } finally {
    busy.value = false
  }
}

async function disable(): Promise<void> {
  busy.value = true
  try {
    const reg = await navigator.serviceWorker.ready
    const subscription = await reg.pushManager.getSubscription()
    if (subscription) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => {})
      await subscription.unsubscribe()
    }
    subscribed.value = false
  } finally {
    busy.value = false
  }
}

export function useNotifications() {
  return {
    init,
    enable,
    disable,
    supported: readonly(supported),
    serverEnabled: readonly(serverEnabled),
    permission: readonly(permission),
    subscribed: readonly(subscribed),
    busy: readonly(busy),
    lastError: readonly(lastError),
  }
}
