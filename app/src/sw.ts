/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { NetworkFirst } from 'workbox-strategies'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> }

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// App shell: serve index.html for navigations, from the network when we can.
registerRoute(
  new NavigationRoute(new NetworkFirst({ cacheName: 'shell', networkTimeoutSeconds: 3 }), {
    denylist: [/^\/api\//, /^\/video\//, /^\/ws/],
  }),
)

self.addEventListener('install', () => {
  void self.skipWaiting()
})
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

interface PushPayload {
  title: string
  body: string
  tag?: string
  url?: string
  level?: 'info' | 'warn' | 'error'
}

self.addEventListener('push', (event) => {
  let payload: PushPayload = { title: 'House Control', body: '' }
  try {
    payload = { ...payload, ...(event.data?.json() as PushPayload) }
  } catch {
    payload.body = event.data?.text() ?? ''
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url ?? '/' },
      requireInteraction: payload.level === 'error',
    } as NotificationOptions),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) {
          void c.navigate(url)
          return c.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
