import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ServerMessage } from '@house/shared'
import type { Auth } from './auth.ts'
import { sha256 } from './crypto.ts'
import type { Bus } from './events.ts'
import type { Logger } from './lib/log.ts'

interface Closable {
  close(code: number, reason: string): void
}

/** Every open live channel, by the hash of the token that opened it, so a sign-out can close them. */
const open = new Map<string, Set<Closable>>()

/**
 * The token of a WebSocket request. The app sends it as a sub-protocol
 * ("hc-token, <token>") so it never appears in an address; a ?token= query is
 * still accepted.
 */
export function wsToken(req: FastifyRequest): string | null {
  const header = req.headers['sec-websocket-protocol']
  if (header) {
    const parts = String(header)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const i = parts.indexOf('hc-token')
    if (i >= 0) {
      const t = parts.find((p, j) => j !== i)
      if (t) return t
    }
  }
  return new URL(req.url, 'http://hub').searchParams.get('token')
}

/** Remember a channel while it is open. Returns the function that forgets it. */
export function trackSocket(token: string, socket: Closable): () => void {
  const hash = sha256(token)
  let set = open.get(hash)
  if (!set) {
    set = new Set()
    open.set(hash, set)
  }
  set.add(socket)
  return () => {
    const s = open.get(hash)
    if (!s) return
    s.delete(socket)
    if (s.size === 0) open.delete(hash)
  }
}

/** Close the channels of one token (hash), or of every token except `keep`. */
export function closeSockets(hash: string | null, keep: string | null): void {
  for (const [h, set] of open) {
    if (hash ? h !== hash : h === keep) continue
    for (const s of set) {
      try {
        s.close(4401, 'Signed out')
      } catch {
        /* already gone */
      }
    }
    open.delete(h)
  }
}

export interface WsDeps {
  bus: Bus
  auth: Auth
  hello: () => ServerMessage
  log: Logger
}

/** /ws?token=… — the app's live channel. Everything the bus emits is relayed. */
export function registerWs(app: FastifyInstance, deps: WsDeps): void {
  const log = deps.log.child('ws')
  deps.auth.onRevoke(closeSockets)
  app.get('/ws', { websocket: true }, (socket, req) => {
    const token = wsToken(req)
    if (!token || !deps.auth.verify(token)) {
      socket.close(4401, 'Not signed in')
      return
    }
    const untrack = trackSocket(token, socket)
    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
    }
    send(deps.hello())
    const offs = [
      deps.bus.on('device.upsert', (device) => send({ type: 'device.upsert', device })),
      deps.bus.on('device.remove', (deviceId) => send({ type: 'device.remove', deviceId })),
      deps.bus.on('device.state', (state) => send({ type: 'device.state', state })),
      deps.bus.on('action', (action) => send({ type: 'action', action })),
      deps.bus.on('event', (event) => send({ type: 'event', event })),
      deps.bus.on('wifi.networks', (networks) => send({ type: 'wifi.networks', networks })),
      deps.bus.on('hub.status', (status) => send({ type: 'hub.status', status })),
      deps.bus.on('discover', (progress) => send({ type: 'discover', progress })),
    ]
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping()
    }, 25_000)
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string }
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
      } catch {
        /* ignore */
      }
    })
    socket.on('close', () => {
      clearInterval(ping)
      untrack()
      for (const off of offs) off()
    })
    socket.on('error', (err) => log.debug('socket error', err.message))
  })
}
