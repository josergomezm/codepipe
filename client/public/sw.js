/* CodePipe service worker — installability + Web Push notifications.
 *
 * Intentionally minimal: no offline caching (the app needs the live backend
 * anyway). Its job is to make CodePipe installable and to show push
 * notifications when the agent finishes a turn while the app is backgrounded.
 */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }

  const title = data.title || 'CodePipe'
  const body = data.body || 'New activity'
  const sessionId = data.sessionId || ''

  event.waitUntil(
    (async () => {
      // If a window is already focused/visible, the user is actively using the
      // app — don't buzz them for the reply they're watching arrive.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const focused = windows.some((c) => c.focused || c.visibilityState === 'visible')
      if (focused) return

      await self.registration.showNotification(title, {
        body,
        tag: data.tag || sessionId || 'codepipe',
        renotify: true,
        icon: '/icon.svg',
        badge: '/icon.svg',
        data: { sessionId },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const sessionId = event.notification.data && event.notification.data.sessionId
  const url = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/'

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if ('focus' in client) {
          client.postMessage({ type: 'open-session', sessionId })
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url)
    })(),
  )
})
