import os from 'node:os'
import path from 'node:path'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import type { HubStatus, ServerMessage } from '@house/shared'
import { ActionQueue } from './actions.ts'
import { registerApi } from './api.ts'
import { Auth } from './auth.ts'
import { VERSION, type Config } from './config.ts'
import { SecretBox } from './crypto.ts'
import { getSetting, openDb, setSetting, type DB } from './db.ts'
import { DeviceManager } from './devices.ts'
import { Discovery } from './discovery.ts'
import { Bus, EventLog } from './events.ts'
import { logger, type Logger } from './lib/log.ts'
import { Notifier } from './notify.ts'
import { Registry } from './registry.ts'
import { seedIfEmpty } from './seed.ts'
import { SmsTransport } from './sms.ts'
import { VideoManager } from './video.ts'
import { WifiMover } from './wifi.ts'
import { registerWs } from './ws.ts'

export interface Hub {
  app: FastifyInstance
  db: DB
  bus: Bus
  events: EventLog
  registry: Registry
  devices: DeviceManager
  actions: ActionQueue
  auth: Auth
  notifier: Notifier
  video: VideoManager
  sms: SmsTransport
  status(): HubStatus
  /** Listen, start the health loop and the video sidecar. Returns the port actually bound. */
  start(): Promise<number>
  stop(): Promise<void>
}

/** Wire the whole hub from a config. Nothing listens or polls until start(). */
export async function createHub(config: Config, log: Logger = logger('hub')): Promise<Hub> {
  const startedAt = new Date()
  const db = openDb(config.dataDir === ':memory:' ? ':memory:' : path.join(config.dataDir, 'house.db'))
  const box = config.dataDir === ':memory:' ? SecretBox.ephemeral() : SecretBox.load(config.dataDir)
  const bus = new Bus()
  const events = new EventLog(db, bus)
  const registry = new Registry(db, box, bus)
  // Seed once per data folder: a house the owner has emptied stays empty after a restart.
  if (config.seedVirtual && getSetting(db, 'seeded') === null) {
    seedIfEmpty(registry, log)
    setSetting(db, 'seeded', '1')
  }

  const sms = new SmsTransport(config.smsPort, log)
  const notifier = new Notifier(db, config.dataDir, log)
  const auth = new Auth(db)
  const devices = new DeviceManager({ db, registry, bus, events, sms, notifier, log, config })
  const wifi = new WifiMover({ registry, devices, events, notifier, log, config })
  const video = new VideoManager({ config, registry, devices, bus, log })
  const actions = new ActionQueue({ db, registry, devices, bus, events, notifier, wifi, video, log, config })
  const discovery = new Discovery(log)

  const status = (): HubStatus => ({
    version: VERSION,
    hostname: os.hostname(),
    addresses: localAddresses(),
    startedAt: startedAt.toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
    dataDir: config.dataDir,
    devices: registry.listDevices().length,
    video: video.status,
    push: notifier.status(),
    sms: sms.status,
    discovery: discovery.status,
  })

  const hello = (): ServerMessage => ({
    type: 'hello',
    status: status(),
    devices: registry.listDevices(),
    states: devices.listStates(),
    wifi: registry.listWifi(),
    actions: actions.list({ limit: 50 }),
  })

  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: true })
  // go2rtc's WebRTC endpoint takes a raw SDP body.
  app.addContentTypeParser('application/sdp', { parseAs: 'string' }, (_req, body, done) => done(null, body))
  await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } })
  registerWs(app, { bus, auth, hello, log })
  registerApi(app, { config, registry, devices, actions, events, notifier, auth, video, discovery, status, log })

  let housekeeping: NodeJS.Timeout | null = null

  return {
    app,
    db,
    bus,
    events,
    registry,
    devices,
    actions,
    auth,
    notifier,
    video,
    sms,
    status,
    async start() {
      await sms.start()
      if (config.dataDir !== ':memory:') notifier.init()
      await app.listen({ port: config.port, host: config.host })
      const address = app.server.address()
      const port = typeof address === 'object' && address ? address.port : config.port
      devices.start()
      await video.start()
      events.record({ type: 'hub.started', message: `Hub started on port ${port}` })
      bus.emit('hub.status', status())
      housekeeping = setInterval(
        () => {
          events.prune()
          actions.prune()
          bus.emit('hub.status', status())
        },
        60 * 60 * 1000,
      )
      housekeeping.unref?.()
      return port
    },
    async stop() {
      if (housekeeping) clearInterval(housekeeping)
      devices.stop()
      await video.stop()
      await sms.stop()
      await app.close()
      db.close()
    },
  }
}

export function localAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address)
  }
  return out
}
