import type { ServerMessage } from '@house/shared'
import { getToken } from './api.ts'
import { useStore } from './store.ts'

let socket: WebSocket | null = null
let retry = 0
let timer: number | null = null
let wanted = false

/** Keep one live channel to the hub open; reconnect with backoff. */
export function connectLive(): void {
  wanted = true
  open()
}

export function disconnectLive(): void {
  wanted = false
  if (timer) window.clearTimeout(timer)
  timer = null
  socket?.close()
  socket = null
  useStore.getState().setConnected(false)
}

function open(): void {
  const token = getToken()
  if (!wanted || !token) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // The token travels as a sub-protocol, never in the address.
  const ws = new WebSocket(`${proto}://${location.host}/ws`, ['hc-token', token])
  socket = ws
  ws.onopen = () => {
    retry = 0
    useStore.getState().setConnected(true)
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as ServerMessage | { type: 'pong' }
      if (msg.type !== 'pong') useStore.getState().apply(msg)
    } catch {
      /* ignore */
    }
  }
  ws.onclose = (ev) => {
    useStore.getState().setConnected(false)
    socket = null
    if (ev.code === 4401) {
      useStore.getState().setAuth('login')
      return
    }
    if (!wanted) return
    retry += 1
    const delay = Math.min(15000, 500 * 2 ** Math.min(retry, 5))
    timer = window.setTimeout(open, delay)
  }
  ws.onerror = () => ws.close()
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wanted) {
    retry = 0
    open()
  }
})
