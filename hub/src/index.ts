import os from 'node:os'
import fastifyWebsocket from '@fastify/websocket'
import Fastify from 'fastify'
import type { HubStatus, ServerMessage } from '@house/shared'
import { ActionQueue } from './actions.ts'
import { registerApi } from './api.ts'
import { Auth } from './auth.ts'
import { config, VERSION } from './config.ts'
import { SecretBox } from './crypto.ts'
import { openDb } from './db.ts'
import { DeviceManager } from './devices.ts'
import { Discovery } from './discovery.ts'
import { Bus, EventLog } from './events.ts'
import { logger, setLogLevel } from './lib/log.ts'
import { Notifier } from './notify.ts'
import { Registry } from './registry.ts'
import { seedIfEmpty } from './seed.ts'
import { SmsTransport } from './sms.ts'
import { VideoManager } from './video.ts'
import { WifiMover } from './wifi.ts'
import { registerWs } from './ws.ts'
import path from 'node:path'

setLogLevel(config.logLevel)
const log = logger('hub')
const startedAt = new Date()

async function main(): Promise<void> {
  log.info(`House Control hub v${VERSION} starting`, { dataDir: config.dataDir, port: config.port })

  const db = openDb(path.join(config.dataDir, 'house.db'))
  const box = SecretBox.load(config.dataDir)
  const bus = new Bus()
  const events = new EventLog(db, bus)
  const registry = new Registry(db, box, bus)
  if (config.seedVirtual) seedIfEmpty(registry, log)

  const sms = new SmsTransport(config.smsPort, log)
  await sms.start()
  const notifier = new Notifier(db, config.dataDir, log)
  notifier.init()
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
  await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } })
  registerWs(app, { bus, auth, hello, log })
  registerApi(app, { config, registry, devices, actions, events, notifier, auth, video, discovery, status, log })

  await app.listen({ port: config.port, host: config.host })
  devices.start()
  await video.start()
  events.record({ type: 'hub.started', message: `Hub started on port ${config.port}` })
  bus.emit('hub.status', status())

  const housekeeping = setInterval(() => {
    events.prune()
    actions.prune()
    bus.emit('hub.status', status())
  }, 60 * 60 * 1000)
  housekeeping.unref?.()

  const addresses = localAddresses()
  log.info(`Open the app at http://localhost:${config.port}${addresses.length ? '  (on the phone: ' + addresses.map((a) => `http://${a}:${config.port}`).join(' or ') + ')' : ''}`)
  if (!auth.isConfigured()) log.info('No PIN set yet — the first phone to open the app will set one')

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`)
    clearInterval(housekeeping)
    devices.stop()
    await video.stop()
    await sms.stop()
    await app.close()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

function localAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address)
  }
  return out
}

main().catch((err) => {
  log.error('Hub failed to start', err)
  process.exit(1)
})
