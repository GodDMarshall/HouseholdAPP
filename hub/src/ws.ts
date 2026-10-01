import type { FastifyInstance } from 'fastify'
import type { ServerMessage } from '@house/shared'
import type { Auth } from './auth.ts'
import type { Bus } from './events.ts'
import type { Logger } from './lib/log.ts'

export interface WsDeps {
  bus: Bus
  auth: Auth
  hello: () => ServerMessage
  log: Logger
}

/** /ws?token=… — the app's live channel. Everything the bus emits is relayed. */
export function registerWs(app: FastifyInstance, deps: WsDeps): void {
  const log = deps.log.child('ws')
  app.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, 'http://hub')
    const token = url.searchParams.get('token')
    if (!deps.auth.verify(token)) {
      socket.close(4401, 'Not signed in')
      return
    }
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
      for (const off of offs) off()
    })
    socket.on('error', (err) => log.debug('socket error', err.message))
  })
}
