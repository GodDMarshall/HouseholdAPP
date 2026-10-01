import { api } from './api.ts'
import { useStore } from './store.ts'

export type PushSupport = 'ok' | 'insecure' | 'unsupported' | 'ios-install' | 'denied'

/** Can this browser receive push notifications from the hub? */
export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure'
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  if (ios && !standalone) return 'ios-install'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return 'ok'
}

export function pushSupportText(s: PushSupport): string {
  switch (s) {
    case 'ok': return ''
    case 'insecure': return 'Notifications need the secure (https) address of the hub. Open the app through the Tailscale https address from the setup guide. Messages inside the app still work here.'
    case 'ios-install': return 'On iPhone, add the app to the Home Screen first (Share → Add to Home Screen), then open it from there.'
    case 'unsupported': return 'This browser cannot receive notifications. Use Chrome on Android or the installed app on iPhone.'
    case 'denied': return 'Notifications are blocked for this site in the browser settings. Allow them there, then try again.'
  }
}

function keyToBytes(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export async function isSubscribed(): Promise<boolean> {
  if (pushSupport() !== 'ok') return false
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  return Boolean(sub)
}

export async function enablePush(): Promise<boolean> {
  const { toast, status } = useStore.getState()
  const support = pushSupport()
  if (support !== 'ok') {
    toast(pushSupportText(support), 'warn')
    return false
  }
  const key = status?.push.publicKey
  if (!key) {
    toast('The hub has no push key yet. Try again in a moment.', 'warn')
    return false
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    toast('Notifications were not allowed.', 'warn')
    return false
  }
  const reg = await navigator.serviceWorker.ready
  const existing = await reg.pushManager.getSubscription()
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) as BufferSource }))
  await api.post('/api/push/subscribe', { subscription: sub.toJSON() })
  toast('Notifications are on for this phone.', 'ok')
  return true
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined)
    await sub.unsubscribe()
  }
  useStore.getState().toast('Notifications are off for this phone.', 'info')
}
