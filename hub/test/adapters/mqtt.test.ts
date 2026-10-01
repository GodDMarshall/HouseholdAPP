/**
 * The generic MQTT adapter against a real in-process broker (aedes on
 * 127.0.0.1) and mock devices that speak the documented topic layouts:
 *  - Tasmota: cmnd/<topic>/POWER -> stat/<topic>/RESULT {"POWER":"ON"} and
 *    stat/<topic>/POWER ON, availability on tele/<topic>/LWT Online | Offline.
 *  - Shelly Gen1: shellies/<id>/relay/0/command on|off -> shellies/<id>/relay/0,
 *    shellies/<id>/online true | false.
 *  - Shelly Gen2: <id>/command/switch:0 -> <id>/status/switch:0 {"output":true,...}.
 * The gate controller and the 0-255 dimmer are owner-built boxes whose wording
 * is whatever the owner types into the form; they use the form's defaults.
 * The Zigbee2MQTT light is not in the protocol notes; it follows Zigbee2MQTT's
 * own documented layout (zigbee2mqtt/<name>, .../set, .../availability).
 */
import crypto from 'node:crypto'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import tls from 'node:tls'
import Aedes from 'aedes'
import type { AuthenticateError, Client } from 'aedes'
import mqtt from 'mqtt'
import type { MqttClient } from 'mqtt'
import { afterEach, describe, expect, it } from 'vitest'
import adapter, { closeAllMqttClients, mqttClientCount, setMqttIdleCloseMs } from '../../src/adapters/mqtt.ts'
import type { DeviceKind } from '@house/shared'
import { makeAction, makeCtx, type TestCtx } from '../helpers.ts'

// ---------------------------------------------------------------------------
// Broker and mock devices
// ---------------------------------------------------------------------------

interface Broker {
  port: number
  /** Every CONNECT the broker saw. */
  connects: Array<{ clientId: string; username: string | undefined; clean: boolean; keepalive: number; protocolVersion: number }>
  /** Every PUBLISH a client sent (not the broker's own). */
  published: Array<{ clientId: string; topic: string; payload: string; qos: number; retain: boolean }>
  subscribed: Array<{ clientId: string; topic: string; qos: number }>
  unsubscribed: Array<{ clientId: string; topic: string }>
  disconnected: string[]
  /** What the hub itself published. */
  fromHub(): Array<{ topic: string; payload: string; qos: number; retain: boolean }>
  hubConnects(): number
  /** Cut the hub's connection from the broker side. */
  kickHub(): void
  /** From now on, swallow messages to this topic without ever confirming them. */
  stall(topic: string): void
  /** Answer every failed login with this CONNACK code (Mosquitto answers 5 to a wrong password). */
  refuseLoginsWith(code: number): void
  /** Refuse subscriptions to this topic the way a broker with access rules does (SUBACK 0x80). */
  denyListening(topic: string): void
  /** Cut the connection of whoever asks to listen on this topic, before answering. */
  dropOnListening(topic: string): void
  /** Answer slowly: the CONNECT and every SUBSCRIBE are held back this long. */
  slowDown(delays: { connectMs?: number; listenMs?: number }): void
  close(): Promise<void>
}

const HUB = /^housecontrol-[0-9a-f]{8}$/

/** DER: tag, length, content. */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const length = body.length < 128 ? [body.length] : body.length < 256 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff]
  return Buffer.concat([Buffer.from([tag, ...length]), body])
}

/** A throwaway self-signed certificate for "localhost", made on the spot so no key lives in the repository. */
function selfSignedCertificate(): { key: string; cert: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'))
  const ecdsaWithSha256 = der(0x30, oid('2a8648ce3d040302'))
  const name = der(0x30, der(0x31, der(0x30, oid('550403'), der(0x0c, Buffer.from('localhost')))))
  const utc = (d: Date) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'))
  const validity = der(0x30, utc(new Date(Date.now() - 86_400_000)), utc(new Date(Date.now() + 86_400_000)))
  const tbs = der(0x30, der(0x02, Buffer.from([0x01])), ecdsaWithSha256, name, validity, name, publicKey.export({ type: 'spki', format: 'der' }))
  const signature = crypto.sign('sha256', tbs, privateKey)
  const cert = der(0x30, tbs, ecdsaWithSha256, der(0x03, Buffer.from([0]), signature))
  const lines = cert.toString('base64').match(/.{1,64}/g) ?? []
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
  }
}

/**
 * `users` given: logins are checked. A wrong password is answered with CONNACK 4 ("bad user name or
 * password", what aedes, EMQX and HiveMQ send) and a missing login with 5 ("not authorized").
 * Mosquitto answers 5 to both; refuseLoginsWith(5) makes this broker do the same.
 * `secure`: the broker only speaks TLS (mqtts), with a self-signed certificate.
 */
async function startBroker(users?: Record<string, string>, secure = false, port = 0): Promise<Broker> {
  const aedes = new Aedes()
  const live = new Set<Client>()
  const stalled = new Set<string>()
  const denied = new Set<string>()
  const dropping = new Set<string>()
  const delays = { connectMs: 0, listenMs: 0 }
  let failedLoginCode: number | null = null
  const sockets = new Set<net.Socket>()
  const broker: Broker = {
    port: 0,
    connects: [],
    published: [],
    subscribed: [],
    unsubscribed: [],
    disconnected: [],
    fromHub: () => broker.published.filter((p) => HUB.test(p.clientId)).map(({ topic, payload, qos, retain }) => ({ topic, payload, qos, retain })),
    hubConnects: () => broker.connects.filter((c) => HUB.test(c.clientId)).length,
    kickHub: () => {
      for (const c of live) if (HUB.test(c.id)) c.close()
    },
    stall: (topic) => void stalled.add(topic),
    refuseLoginsWith: (code) => {
      failedLoginCode = code
    },
    denyListening: (topic) => void denied.add(topic),
    dropOnListening: (topic) => void dropping.add(topic),
    slowDown: (d) => void Object.assign(delays, d),
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => aedes.close(() => r()))
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
  aedes.preConnect = (_client, packet, done) => {
    broker.connects.push({
      clientId: packet.clientId,
      username: packet.username,
      clean: packet.clean === true,
      keepalive: packet.keepalive ?? 0,
      protocolVersion: packet.protocolVersion ?? 0,
    })
    if (delays.connectMs > 0) setTimeout(() => done(null, true), delays.connectMs)
    else done(null, true)
  }
  aedes.authenticate = (_client, username, password, done) => {
    if (!users) return done(null, true)
    if (username && users[username] === password?.toString()) return done(null, true)
    const err = new Error('Auth error') as AuthenticateError
    // 4 = bad username or password, 5 = not authorized (no login given).
    ;(err as { returnCode: number }).returnCode = failedLoginCode ?? (username ? 4 : 5)
    done(err, null)
  }
  aedes.authorizeSubscribe = (client, sub, done) => {
    if (dropping.has(sub.topic)) {
      client.close()
      return
    }
    // aedes turns a null subscription into SUBACK 0x80, the "not allowed" answer.
    const answer = () => done(null, denied.has(sub.topic) ? null : sub)
    if (delays.listenMs > 0) setTimeout(answer, delays.listenMs)
    else answer()
  }
  aedes.authorizePublish = (_client, packet, done) => {
    if (stalled.has(packet.topic)) return
    done(null)
  }
  aedes.on('client', (c) => live.add(c))
  aedes.on('clientDisconnect', (c) => {
    live.delete(c)
    broker.disconnected.push(c.id)
  })
  aedes.on('publish', (packet, client) => {
    if (client) broker.published.push({ clientId: client.id, topic: packet.topic, payload: packet.payload.toString(), qos: packet.qos, retain: packet.retain === true })
  })
  aedes.on('subscribe', (subs, client) => {
    for (const s of subs) broker.subscribed.push({ clientId: client.id, topic: s.topic, qos: s.qos })
  })
  aedes.on('unsubscribe', (topics, client) => {
    for (const t of topics) broker.unsubscribed.push({ clientId: client.id, topic: t })
  })
  const onSocket = (socket: net.Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    aedes.handle(socket)
  }
  const server: net.Server = secure ? tls.createServer(selfSignedCertificate(), onSocket) : net.createServer(onSocket)
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()))
  broker.port = (server.address() as AddressInfo).port
  return broker
}

function connectDevice(broker: Broker, clientId: string, will?: { topic: string; payload: string }, login?: { username: string; password: string }): Promise<MqttClient> {
  return mqtt.connectAsync(`mqtt://127.0.0.1:${broker.port}`, {
    clientId,
    reconnectPeriod: 0,
    ...(login ?? {}),
    will: will ? { topic: will.topic, payload: Buffer.from(will.payload), qos: 1, retain: true } : undefined,
  })
}

interface MockDevice {
  client: MqttClient
  /** Pull the plug: no goodbye, so the broker publishes the last-will message. */
  crash(): void
}

function asDevice(client: MqttClient): MockDevice {
  return { client, crash: () => client.stream.destroy() }
}

/**
 * Tasmota in MQTT mode. `powerRetain` is PowerRetain 1 (stat/<topic>/POWER is kept by the broker);
 * `stuck` is a relay that will not switch; `mute` hears commands but never answers.
 */
async function tasmota(broker: Broker, topic: string, opts: { powerRetain?: boolean; stuck?: boolean; mute?: boolean; login?: { username: string; password: string } } = {}): Promise<MockDevice> {
  const client = await connectDevice(broker, `DVES_${topic}`, { topic: `tele/${topic}/LWT`, payload: 'Offline' }, opts.login)
  let power = false
  await client.publishAsync(`tele/${topic}/LWT`, 'Online', { qos: 1, retain: true })
  client.on('message', (t, payload) => {
    if (opts.mute) return
    const command = t.split('/')[2]
    const arg = payload.toString().trim()
    if (command === 'POWER') {
      if (!opts.stuck) {
        if (/^(on|1|true)$/i.test(arg)) power = true
        else if (/^(off|0|false)$/i.test(arg)) power = false
        else if (/^(toggle|2)$/i.test(arg)) power = !power
      }
      const word = power ? 'ON' : 'OFF'
      client.publish(`stat/${topic}/RESULT`, JSON.stringify({ POWER: word }))
      client.publish(`stat/${topic}/POWER`, word, { retain: opts.powerRetain === true })
    } else if (command === 'Dimmer') {
      const dimmer = Number(arg)
      power = dimmer > 0
      client.publish(`stat/${topic}/RESULT`, JSON.stringify({ POWER: power ? 'ON' : 'OFF', Dimmer: dimmer }))
    }
  })
  await client.subscribeAsync(`cmnd/${topic}/+`, { qos: 1 })
  return asDevice(client)
}

const SHELLY1 = 'shellies/shelly1-5ECF7F1632E8'

/** Shelly Gen1 relay: plain words on/off, availability true/false. */
async function shellyGen1(broker: Broker): Promise<MockDevice> {
  const client = await connectDevice(broker, 'shelly1-5ECF7F1632E8', { topic: `${SHELLY1}/online`, payload: 'false' })
  await client.publishAsync(`${SHELLY1}/online`, 'true', { qos: 1, retain: true })
  client.on('message', (_t, payload) => {
    const arg = payload.toString()
    if (arg === 'on' || arg === 'off') client.publish(`${SHELLY1}/relay/0`, arg)
  })
  await client.subscribeAsync(`${SHELLY1}/relay/0/command`, { qos: 1 })
  return asDevice(client)
}

const SHELLY2 = 'shellypro4pm-f008d1d8b8b8'

/** Shelly Gen2 switch: status is the Switch.GetStatus JSON, with a true/false "output". */
async function shellyGen2(broker: Broker): Promise<MockDevice> {
  const client = await connectDevice(broker, SHELLY2, { topic: `${SHELLY2}/online`, payload: 'false' })
  await client.publishAsync(`${SHELLY2}/online`, 'true', { qos: 1, retain: true })
  const status = (output: boolean) =>
    JSON.stringify({ id: 0, source: 'mqtt', output, apower: output ? 8.4 : 0, voltage: 231.2, current: output ? 0.04 : 0, aenergy: { total: 12.5 }, temperature: { tC: 41.3, tF: 106.3 } })
  await client.publishAsync(`${SHELLY2}/status/switch:0`, status(false), { qos: 1, retain: true })
  client.on('message', (_t, payload) => {
    const arg = payload.toString()
    if (arg === 'on' || arg === 'off') client.publish(`${SHELLY2}/status/switch:0`, status(arg === 'on'), { retain: true })
  })
  await client.subscribeAsync(`${SHELLY2}/command/switch:0`, { qos: 1 })
  return asDevice(client)
}

/**
 * A lamp behind Zigbee2MQTT (retain switched on for it): commands are JSON on zigbee2mqtt/<name>/set,
 * the state is JSON on zigbee2mqtt/<name>, brightness counts 0-254, and availability is the JSON
 * {"state":"online"} | {"state":"offline"} that Zigbee2MQTT 2.x publishes.
 */
async function zigbeeLamp(broker: Broker, name: string): Promise<MockDevice> {
  const client = await connectDevice(broker, 'zigbee2mqtt', { topic: `zigbee2mqtt/${name}/availability`, payload: JSON.stringify({ state: 'offline' }) })
  const lamp = { state: 'OFF', brightness: 254, linkquality: 120 }
  const report = () => client.publish(`zigbee2mqtt/${name}`, JSON.stringify(lamp), { retain: true })
  await client.publishAsync(`zigbee2mqtt/${name}/availability`, JSON.stringify({ state: 'online' }), { qos: 1, retain: true })
  await client.publishAsync(`zigbee2mqtt/${name}`, JSON.stringify(lamp), { qos: 1, retain: true })
  client.on('message', (_t, payload) => {
    let msg: { state?: unknown; brightness?: unknown }
    try {
      msg = JSON.parse(payload.toString()) as typeof msg
    } catch {
      return
    }
    if (msg.state === 'ON' || msg.state === 'OFF') lamp.state = msg.state
    if (typeof msg.brightness === 'number') {
      lamp.brightness = msg.brightness
      lamp.state = msg.brightness > 0 ? 'ON' : 'OFF'
    }
    report()
  })
  await client.subscribeAsync(`zigbee2mqtt/${name}/set`, { qos: 1 })
  return asDevice(client)
}

/**
 * An owner-built gate controller using the words the form suggests: OPEN / CLOSE / STOP in,
 * opening / open / closing / closed / stopped out. PRESS is its single step button.
 */
async function gateController(broker: Broker, start: 'open' | 'closed' = 'closed', travelMs = 120): Promise<MockDevice> {
  const client = await connectDevice(broker, 'esp-gate')
  let position: string = start
  let timer: NodeJS.Timeout | null = null
  const say = (word: string) => {
    position = word
    client.publish('home/gate/state', word, { retain: true })
  }
  const travel = (via: string, to: string) => {
    if (timer) clearTimeout(timer)
    say(via)
    timer = setTimeout(() => say(to), travelMs)
  }
  await client.publishAsync('home/gate/state', start, { qos: 1, retain: true })
  client.on('message', (_t, payload) => {
    const arg = payload.toString()
    if (arg === 'OPEN') travel('opening', 'open')
    else if (arg === 'CLOSE') travel('closing', 'closed')
    else if (arg === 'STOP') {
      if (timer) clearTimeout(timer)
      say('stopped')
    } else if (arg === 'PRESS') {
      if (position === 'opening' || position === 'closing') {
        if (timer) clearTimeout(timer)
        say('stopped')
      } else if (position === 'open') travel('closing', 'closed')
      else travel('opening', 'open')
    }
  })
  await client.subscribeAsync('home/gate/set', { qos: 1 })
  return asDevice(client)
}

/** An owner-built dimmer that counts 0-255 on plain-number topics. */
async function espDimmer(broker: Broker): Promise<MockDevice> {
  const client = await connectDevice(broker, 'esp-dimmer')
  client.on('message', (_t, payload) => client.publish('home/hall/level', payload.toString(), { retain: true }))
  await client.subscribeAsync('home/hall/level/set', { qos: 1 })
  return asDevice(client)
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('Timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A broker confirms a QoS 1 message (PUBACK) before it has finished handing it on, so a command
 * with no report to wait for can return a moment before the broker's log shows it.
 */
const hubPublished = (count: number) => waitFor(() => broker!.fromHub().length >= count)

const PORCH = {
  commandTopic: 'cmnd/porch/POWER',
  stateTopic: 'stat/porch/RESULT',
  valueTemplate: 'POWER',
  availabilityTopic: 'tele/porch/LWT',
  payloadAvailable: 'Online',
  payloadNotAvailable: 'Offline',
}

const GATE = { commandTopic: 'home/gate/set', stateTopic: 'home/gate/state' }

/**
 * What the hub stores when the owner saves the form: Registry.normalise() writes a field's default
 * back into every box that was left (or made) empty. The adapter must work with that config.
 */
function asSaved(config: Record<string, unknown>): Record<string, unknown> {
  const saved: Record<string, unknown> = { ...config }
  for (const f of adapter.describe().fields) {
    const v = saved[f.name]
    if ((v === undefined || v === null || v === '') && f.default !== undefined) saved[f.name] = f.default
  }
  return saved
}

/** A server on 127.0.0.1 that is not an MQTT broker; `onSocket` decides how it misbehaves. */
async function notABroker(onSocket: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    onSocket(socket)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  extraServers.push(server)
  return (server.address() as AddressInfo).port
}

let broker: Broker | null = null
const devices: MockDevice[] = []
const extraServers: net.Server[] = []

function ctxFor(config: Record<string, unknown>, kind: DeviceKind = 'light', opts: { timeoutMs?: number; port?: number | null; id?: string } = {}): TestCtx {
  const ctx = makeCtx({ family: 'mqtt', kind, config, path: { port: opts.port === undefined ? broker!.port : opts.port }, timeoutMs: opts.timeoutMs })
  if (opts.id) ctx.device.id = opts.id
  return ctx
}

async function add(device: Promise<MockDevice>): Promise<MockDevice> {
  const d = await device
  devices.push(d)
  return d
}

afterEach(async () => {
  await closeAllMqttClients()
  setMqttIdleCloseMs(30_000)
  for (const d of devices.splice(0)) d.client.end(true)
  await broker?.close()
  broker = null
  for (const s of extraServers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
})

// ---------------------------------------------------------------------------

describe('mqtt adapter', () => {
  describe('add-device form', () => {
    it('describes itself in plain words', () => {
      const d = adapter.describe()
      expect(adapter.family).toBe('mqtt')
      expect(d.id).toBe('mqtt')
      expect(d.kinds).toEqual(['light', 'switch', 'gate', 'sensor'])
      expect(d.pathKinds).toEqual(['lan', 'cloud'])
      expect(d.defaultPort).toBe(1883)
      const names = d.fields.map((f) => f.name)
      for (const name of [
        'username', 'password', 'tls', 'commandTopic', 'stateTopic', 'availabilityTopic', 'payloadAvailable', 'payloadNotAvailable',
        'payloadOn', 'payloadOff', 'stateOn', 'stateOff', 'valueTemplate', 'brightnessCommandTopic', 'brightnessStateTopic', 'brightnessScale',
        'payloadOpen', 'payloadClose', 'payloadStop', 'payloadPulse', 'stateOpen', 'stateClosed', 'retain', 'qos',
      ]) {
        expect(names, name).toContain(name)
      }
      const field = (name: string) => d.fields.find((f) => f.name === name)!
      expect(field('password').secret).toBe(true)
      expect(field('password').required).not.toBe(true)
      expect(field('username').required).not.toBe(true)
      expect(field('payloadOn').default).toBe('ON')
      expect(field('payloadOff').default).toBe('OFF')
      expect(field('brightnessScale').default).toBe(100)
      expect(field('retain').default).toBe(false)
      expect(field('qos').options?.map((o) => o.value)).toEqual(['0', '1', '2'])
      expect(d.notes.length).toBeGreaterThan(0)
      expect(JSON.stringify(d)).not.toMatch(/demo|prototype|placeholder|stub|todo/i)
      // The hub writes defaults back into empty boxes on save, so a box whose emptiness means
      // something (a one-button gate has no open / close / stop message) must not have a default.
      for (const name of ['payloadOpen', 'payloadClose', 'payloadStop', 'payloadPulse', 'stateOn', 'stateOff']) expect(field(name).default, name).toBeUndefined()
      for (const f of d.fields) expect(f.label.length, f.name).toBeGreaterThan(3)
    })

    it('works out what the device can do from its kind and topics', () => {
      expect(adapter.capabilities({ commandTopic: 'cmnd/porch/POWER' }, 'light')).toEqual(['power'])
      expect(adapter.capabilities(PORCH, 'switch')).toEqual(['power', 'state'])
      expect(adapter.capabilities({ ...PORCH, brightnessCommandTopic: 'cmnd/porch/Dimmer' }, 'light')).toEqual(['power', 'dim', 'state'])
      expect(adapter.capabilities({ commandTopic: 'home/gate/set' }, 'gate')).toEqual(['gate'])
      expect(adapter.capabilities(GATE, 'gate')).toEqual(['gate', 'gate-state', 'state'])
      expect(adapter.capabilities({ stateTopic: 'home/tank/level' }, 'sensor')).toEqual(['state'])
      expect(adapter.capabilities({}, 'light')).toEqual([])
    })
  })

  describe('probe', () => {
    it('connects to the broker and reports how long it took', async () => {
      broker = await startBroker({ hub: 'broker-pass' })
      const res = await adapter.probe(ctxFor({ username: 'hub', password: 'broker-pass' }))
      expect(res.ok).toBe(true)
      expect(res.latencyMs).toBeGreaterThanOrEqual(0)
      // The CONNECT as the broker saw it.
      expect(broker.connects).toHaveLength(1)
      const connect = broker.connects[0]!
      expect(connect.clientId).toMatch(HUB)
      expect(connect).toMatchObject({ username: 'hub', clean: true, keepalive: 30, protocolVersion: 4 })
      // Checking is side-effect free: nothing was published.
      expect(broker.fromHub()).toEqual([])
    })

    it('says so when the broker rejects the password (CONNACK 4)', async () => {
      broker = await startBroker({ hub: 'broker-pass' })
      const res = await adapter.probe(ctxFor({ username: 'hub', password: 'not-the-pass' }))
      expect(res).toMatchObject({ ok: false, latencyMs: null })
      expect(res.error).toBe('Wrong username or password')
      expect(JSON.stringify(res)).not.toContain('not-the-pass')
    })

    it('says so when the broker wants a login and none is set (CONNACK 5)', async () => {
      broker = await startBroker({ hub: 'broker-pass' })
      const res = await adapter.probe(ctxFor({}))
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/without a username and password/)
    })

    it('reads the way Mosquitto answers a wrong password (CONNACK 5) as a wrong password too', async () => {
      broker = await startBroker({ hub: 'broker-pass' })
      broker.refuseLoginsWith(5)
      const res = await adapter.probe(ctxFor({ username: 'hub', password: 'not-the-pass' }))
      expect(res).toMatchObject({ ok: false, latencyMs: null })
      expect(res.error).toMatch(/^Wrong username or password/)
      expect(JSON.stringify(res)).not.toContain('not-the-pass')
      // A refusal by the device side is returned, not thrown: another connection would not help.
      const refused = await adapter.execute(ctxFor({ ...PORCH, username: 'hub', password: 'not-the-pass' }), makeAction('power.on'))
      expect(refused.ok).toBe(false)
      expect(refused.error).toMatch(/^Wrong username or password/)
      expect(JSON.stringify(refused)).not.toContain('not-the-pass')
    })

    it('says so when the broker does not let this login listen on a topic (SUBACK 0x80)', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      broker.denyListening('tele/porch/LWT')
      const res = await adapter.probe(ctxFor(PORCH))
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/does not allow the hub to listen on "tele\/porch\/LWT"/)
      // The same refusal stops a command before anything is sent, and it is returned, not thrown.
      const refused = await adapter.execute(ctxFor(PORCH), makeAction('power.on'))
      expect(refused.ok).toBe(false)
      expect(refused.error).toMatch(/does not allow the hub to listen/)
      expect(broker.fromHub()).toEqual([])
    })

    it('gives a clear answer when the address belongs to a web page, not a broker', async () => {
      const port = await notABroker((socket) =>
        socket.once('data', () => socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><body><h1>400 Bad Request</h1></body></html>')),
      )
      const res = await adapter.probe(ctxFor({}, 'light', { port, timeoutMs: 1500 }))
      expect(res).toMatchObject({ ok: false, latencyMs: null })
      expect(res.error).toMatch(new RegExp(`^Something answered at 127\\.0\\.0\\.1:${port}, but not the way an MQTT broker does`))
      expect(res.error).not.toMatch(/<html|undefined|\[object|header|packet/)
      // For a command this is a transport failure: thrown, so the hub can try another connection.
      await expect(adapter.execute(ctxFor({ commandTopic: 'cmnd/porch/POWER' }, 'light', { port, timeoutMs: 1500 }), makeAction('power.on'))).rejects.toThrow(`127.0.0.1:${port}`)
    })

    it('gives a clear answer when the other side hangs up at once', async () => {
      const port = await notABroker((socket) => socket.destroy())
      const res = await adapter.probe(ctxFor({}, 'light', { port, timeoutMs: 1500 }))
      expect(res).toMatchObject({ ok: false, latencyMs: null })
      expect(res.error).toMatch(/closed the connection/)
      await expect(adapter.readState!(ctxFor(PORCH, 'light', { port, timeoutMs: 1500 }))).rejects.toThrow(/closed the connection/)
    })

    it('reports an unreachable broker in a plain sentence', async () => {
      broker = await startBroker()
      const port = broker.port
      await broker.close()
      broker = null
      const res = await adapter.probe(ctxFor({}, 'light', { port }))
      expect(res).toMatchObject({ ok: false, latencyMs: null })
      expect(res.error).toMatch(/refused the connection|did not answer/)
    })

    it('gives up within the timeout on something that accepts the call but never answers', async () => {
      const sockets: net.Socket[] = []
      const silent = net.createServer((s) => sockets.push(s))
      await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()))
      extraServers.push(silent)
      const started = Date.now()
      const res = await adapter.probe(ctxFor({}, 'light', { port: (silent.address() as AddressInfo).port, timeoutMs: 400 }))
      expect(Date.now() - started).toBeLessThan(900)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/did not answer/)
      await closeAllMqttClients()
      for (const s of sockets) s.destroy()
    })

    it('needs an address on the connection', async () => {
      const ctx = makeCtx({ family: 'mqtt', kind: 'light', config: {}, path: { host: '', kind: 'cloud', label: 'Cloud' } })
      const res = await adapter.probe(ctx)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/No address set on the "Cloud" connection/)
    })

    it('uses port 8883 for a secure broker when the connection has no port', async () => {
      const res = await adapter.probe(ctxFor({ tls: true }, 'light', { port: null, timeoutMs: 1500 }))
      expect(res.ok).toBe(false)
      expect(res.error).toContain('127.0.0.1:8883')
    })

    it('fails cleanly when a secure connection is asked of a plain broker', async () => {
      broker = await startBroker()
      const res = await adapter.probe(ctxFor({ tls: true }, 'light', { timeoutMs: 1500 }))
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/secure|did not answer|closed the connection/)
    })

    it('connects to a secure broker and sends commands over TLS', async () => {
      broker = await startBroker({ hub: 'broker-pass' }, true)
      const ctx = ctxFor({ commandTopic: 'cmnd/gate1/POWER', username: 'hub', password: 'broker-pass', tls: true, tlsInsecure: true }, 'switch')
      const res = await adapter.probe(ctx)
      expect(res.ok).toBe(true)
      expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
      await hubPublished(1)
      expect(broker.fromHub()).toEqual([{ topic: 'cmnd/gate1/POWER', payload: 'ON', qos: 1, retain: false }])
      expect(broker.connects[0]).toMatchObject({ username: 'hub', clean: true })
    })

    it('does not trust a self-made certificate unless told to', async () => {
      broker = await startBroker(undefined, true)
      const res = await adapter.probe(ctxFor({ tls: true }))
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/security certificate .* could not be checked/)
      expect(res.error).toMatch(/Accept a self-made certificate/)
      expect(broker.hubConnects()).toBe(0)
    })

    it('forgives a pasted broker address with mqtt:// and a port in it', async () => {
      broker = await startBroker()
      const ctx = makeCtx({ family: 'mqtt', kind: 'light', config: {}, path: { host: `mqtt://127.0.0.1:${broker.port}/`, port: null } })
      expect((await adapter.probe(ctx)).ok).toBe(true)
    })

    it('takes mqtts:// and a port typed into the address as meant, over the port box', async () => {
      broker = await startBroker(undefined, true)
      // The port box of a house WiFi connection is filled in with 1883 by the hub.
      const ctx = makeCtx({ family: 'mqtt', kind: 'light', config: { tlsInsecure: true }, path: { host: `mqtts://127.0.0.1:${broker.port}`, port: 1883 } })
      expect((await adapter.probe(ctx)).ok).toBe(true)
      expect(broker.hubConnects()).toBe(1)
    })

    it('never repeats a login that was pasted into the address', async () => {
      broker = await startBroker()
      const port = broker.port
      await broker.close()
      broker = null
      const ctx = makeCtx({ family: 'mqtt', kind: 'light', config: {}, path: { host: `mqtt://owner:hunter2-secret@127.0.0.1:${port}/`, port: null } })
      const res = await adapter.probe(ctx)
      expect(res.ok).toBe(false)
      expect(res.error).toContain(`127.0.0.1:${port}`)
      expect(JSON.stringify(res)).not.toMatch(/hunter2-secret|owner/)
    })

    it('reports the device online from its kept availability message', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      const res = await adapter.probe(ctxFor(PORCH))
      expect(res.ok).toBe(true)
      expect(res.info).toEqual({ available: true })
      expect(broker.subscribed.filter((s) => HUB.test(s.clientId)).map(({ topic, qos }) => ({ topic, qos }))).toEqual([{ topic: 'tele/porch/LWT', qos: 1 }])
      expect(broker.fromHub()).toEqual([])
    })

    it('reports the device offline once the broker has published its last will', async () => {
      broker = await startBroker()
      const device = await add(tasmota(broker, 'porch'))
      expect((await adapter.probe(ctxFor(PORCH))).ok).toBe(true)
      device.crash()
      await waitFor(() => broker!.published.some((p) => p.topic === 'tele/porch/LWT' && p.payload === 'Offline'))
      const res = await adapter.probe(ctxFor(PORCH))
      expect(res).toMatchObject({ ok: false, latencyMs: null })
      expect(res.error).toMatch(/offline/)
    })

    it('does not call a device reachable when it has never announced itself', async () => {
      broker = await startBroker()
      const started = Date.now()
      const res = await adapter.probe(ctxFor(PORCH, 'light', { timeoutMs: 700 }))
      expect(Date.now() - started).toBeLessThan(1200)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/has not announced itself on "tele\/porch\/LWT"/)
    })

    it('points at the announcement words when they do not match', async () => {
      broker = await startBroker()
      await add(shellyGen1(broker))
      const res = await adapter.probe(ctxFor({ availabilityTopic: `${SHELLY1}/online` }))
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/announced "true".*neither "online" nor "offline"/)
    })
  })

  describe('on and off', () => {
    it('switches a Tasmota relay and takes the state from its JSON reply', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      // The config as the hub stores it: defaults written into every box left empty.
      const ctx = ctxFor(asSaved(PORCH))

      const on = await adapter.execute(ctx, makeAction('power.on'))
      expect(on).toMatchObject({ ok: true, state: { power: true }, result: { confirmed: true } })
      expect(on.needsConfirmation).toBeUndefined()
      const off = await adapter.execute(ctx, makeAction('power.off'))
      expect(off).toMatchObject({ ok: true, state: { power: false }, result: { confirmed: true } })

      // Exactly what went over the wire: QoS 1, never retained.
      expect(broker.fromHub()).toEqual([
        { topic: 'cmnd/porch/POWER', payload: 'ON', qos: 1, retain: false },
        { topic: 'cmnd/porch/POWER', payload: 'OFF', qos: 1, retain: false },
      ])
    })

    it('toggles from the state the device last reported', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch', { powerRetain: true }))
      const ctx = ctxFor({ ...PORCH, stateTopic: 'stat/porch/POWER', valueTemplate: '' })
      expect(await adapter.execute(ctx, makeAction('power.toggle'))).toMatchObject({ ok: true, state: { power: true } })
      expect(await adapter.execute(ctx, makeAction('power.toggle'))).toMatchObject({ ok: true, state: { power: false } })
      // A hub that has just started learns the state from the kept message before choosing.
      await adapter.execute(ctx, makeAction('power.on'))
      await closeAllMqttClients()
      expect(await adapter.execute(ctx, makeAction('power.toggle'))).toMatchObject({ ok: true, state: { power: false } })
      expect(broker.fromHub().map((p) => p.payload)).toEqual(['ON', 'OFF', 'ON', 'OFF'])
    })

    it('handles plain-word reports and custom words (Shelly Gen1)', async () => {
      broker = await startBroker()
      await add(shellyGen1(broker))
      const ctx = ctxFor(
        {
          commandTopic: `${SHELLY1}/relay/0/command`,
          stateTopic: `${SHELLY1}/relay/0`,
          payloadOn: 'on',
          payloadOff: 'off',
          availabilityTopic: `${SHELLY1}/online`,
          payloadAvailable: 'true',
          payloadNotAvailable: 'false',
        },
        'switch',
      )
      expect((await adapter.probe(ctx)).ok).toBe(true)
      expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true }, result: { confirmed: true } })
      expect(await adapter.execute(ctx, makeAction('power.off'))).toMatchObject({ ok: true, state: { power: false }, result: { confirmed: true } })
      expect(broker.fromHub()).toEqual([
        { topic: `${SHELLY1}/relay/0/command`, payload: 'on', qos: 1, retain: false },
        { topic: `${SHELLY1}/relay/0/command`, payload: 'off', qos: 1, retain: false },
      ])
    })

    it('reads a true/false item out of a larger JSON status (Shelly Gen2)', async () => {
      broker = await startBroker()
      await add(shellyGen2(broker))
      const ctx = ctxFor(
        {
          commandTopic: `${SHELLY2}/command/switch:0`,
          stateTopic: `${SHELLY2}/status/switch:0`,
          valueTemplate: 'output',
          payloadOn: 'on',
          payloadOff: 'off',
          stateOn: 'true',
          stateOff: 'false',
          availabilityTopic: `${SHELLY2}/online`,
          payloadAvailable: 'true',
          payloadNotAvailable: 'false',
        },
        'switch',
      )
      expect(await adapter.readState!(ctx)).toEqual({ power: false, available: true })
      expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true }, result: { confirmed: true } })
      expect(await adapter.readState!(ctx)).toEqual({ power: true, available: true })
    })

    it('assumes the command worked when the device has no state topic', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      const ctx = ctxFor({ commandTopic: 'cmnd/porch/POWER' })
      const started = Date.now()
      const on = await adapter.execute(ctx, makeAction('power.on'))
      expect(Date.now() - started).toBeLessThan(600)
      expect(on).toEqual({ ok: true, state: { power: true }, result: { confirmed: false } })
      // With nothing to listen to, toggle goes by what the hub last sent.
      expect(await adapter.execute(ctx, makeAction('power.toggle'))).toMatchObject({ ok: true, state: { power: false } })
      expect(await adapter.execute(ctx, makeAction('power.toggle'))).toMatchObject({ ok: true, state: { power: true } })
      await hubPublished(3)
      expect(broker.fromHub().map((p) => p.payload)).toEqual(['ON', 'OFF', 'ON'])
    })

    it('asks the owner to confirm when a device that normally reports back stays silent', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch', { mute: true }))
      const ctx = ctxFor(PORCH, 'light', { timeoutMs: 600 })
      const res = await adapter.execute(ctx, makeAction('power.on'))
      // Sent, but nobody knows whether it worked: no made-up state, and the app asks the owner.
      expect(res.ok).toBe(true)
      expect(res.needsConfirmation).toBe(true)
      expect(res.state).toBeUndefined()
      expect(res.result).toMatchObject({ confirmed: false })
      expect(String(res.result?.note)).toMatch(/did not report back in time.*Look at the device, then confirm/)
      expect(broker.fromHub()).toEqual([{ topic: 'cmnd/porch/POWER', payload: 'ON', qos: 1, retain: false }])
      // The unanswered wish is not remembered either: toggle still starts from "not known to be on".
      await adapter.execute(ctx, makeAction('power.toggle'))
      expect(broker.fromHub().map((p) => p.payload)).toEqual(['ON', 'ON'])
    })

    it('does not nag when a silent device had already reported the state that was asked for', async () => {
      broker = await startBroker()
      // An ESPHome-style switch: its state is kept by the broker, and it says nothing when told
      // to do what it is already doing.
      const device = asDevice(await connectDevice(broker, 'esp-pump'))
      devices.push(device)
      await device.client.publishAsync('pump/switch/relay/state', 'ON', { qos: 1, retain: true })
      const ctx = ctxFor({ commandTopic: 'pump/switch/relay/command', stateTopic: 'pump/switch/relay/state' }, 'switch', { timeoutMs: 600 })
      const res = await adapter.execute(ctx, makeAction('power.on'))
      expect(res.ok).toBe(true)
      expect(res.needsConfirmation).toBeUndefined()
      expect(res.state).toEqual({ power: true })
      expect(res.result).toMatchObject({ confirmed: false })
      expect(String(res.result?.note)).toMatch(/last report already said this/)
      // Asked for the opposite and still silent: that one does need the owner.
      expect((await adapter.execute(ctx, makeAction('power.off'))).needsConfirmation).toBe(true)
    })

    it('never takes its own command for the answer when command and state topic are the same', async () => {
      broker = await startBroker()
      // A broker hands the hub's own message back on a topic the hub listens to.
      const ctx = ctxFor({ commandTopic: 'home/lamp', stateTopic: 'home/lamp' }, 'switch', { timeoutMs: 600 })
      const res = await adapter.execute(ctx, makeAction('power.on'))
      expect(res).toEqual({ ok: true, state: { power: true }, result: { confirmed: false } })
    })

    it('fails honestly when the device reports that nothing changed', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch', { stuck: true }))
      const res = await adapter.execute(ctxFor(PORCH, 'light', { timeoutMs: 600 }), makeAction('power.on'))
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/still off/)
      expect(res.state).toEqual({ power: false })
    })

    it('honours the retain and QoS settings', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      await adapter.execute(ctxFor({ commandTopic: 'cmnd/porch/POWER', retain: true, qos: '0' }), makeAction('power.on'))
      await hubPublished(1)
      expect(broker.fromHub()).toEqual([{ topic: 'cmnd/porch/POWER', payload: 'ON', qos: 0, retain: true }])
    })

    it('sends nothing to a device that is offline, and throws so the hub tries another connection', async () => {
      broker = await startBroker()
      const device = await add(tasmota(broker, 'porch'))
      device.crash()
      await waitFor(() => broker!.published.some((p) => p.topic === 'tele/porch/LWT' && p.payload === 'Offline'))
      await expect(adapter.execute(ctxFor(PORCH), makeAction('power.on'))).rejects.toThrow(/is offline/)
      expect(broker.fromHub()).toEqual([])
    })

    it('throws when the broker drops the hub before the command could be sent', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      broker.dropOnListening('stat/porch/RESULT')
      // A lost connection is a transport failure, never "the broker refused": the hub must be free to fail over.
      await expect(adapter.execute(ctxFor(PORCH), makeAction('power.on'))).rejects.toThrow(/dropped while the hub was starting to listen|closed the connection/)
      expect(broker.fromHub()).toEqual([])
    })

    it('does not send a command so late that the hub has already stopped waiting for it', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      // The hub gives a command twice the device timeout (2 s here), then tries another connection.
      broker.slowDown({ connectMs: 800, listenMs: 750 })
      const ctx = ctxFor({ commandTopic: 'cmnd/porch/POWER', stateTopic: 'stat/porch/RESULT', valueTemplate: 'POWER' }, 'light', { timeoutMs: 1000 })
      await expect(adapter.execute(ctx, makeAction('power.on'))).rejects.toThrow(/too slowly, so the command was not sent/)
      await pause(300)
      expect(broker.fromHub()).toEqual([])
    })

    it('drives a Zigbee2MQTT lamp with the JSON messages the form suggests', async () => {
      broker = await startBroker()
      const lamp = await add(zigbeeLamp(broker, 'porch'))
      // Only what the form's help tells the owner to type; the "report that means on / off" boxes stay empty.
      const ctx = ctxFor(
        asSaved({
          commandTopic: 'zigbee2mqtt/porch/set',
          stateTopic: 'zigbee2mqtt/porch',
          valueTemplate: 'state',
          payloadOn: '{"state":"ON"}',
          payloadOff: '{"state":"OFF"}',
          availabilityTopic: 'zigbee2mqtt/porch/availability',
          brightnessCommandTopic: 'zigbee2mqtt/porch/set',
          brightnessCommandTemplate: '{"brightness":{value}}',
          brightnessValueTemplate: 'brightness',
          brightnessScale: 254,
        }),
      )
      expect(await adapter.probe(ctx)).toMatchObject({ ok: true, info: { available: true } })
      expect(await adapter.readState!(ctx)).toEqual({ power: false, brightness: 100, available: true })
      expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true }, result: { confirmed: true } })
      expect(await adapter.execute(ctx, makeAction('dim.set', { brightness: 50 }))).toMatchObject({ ok: true, state: { power: true, brightness: 50 }, result: { confirmed: true } })
      expect(await adapter.execute(ctx, makeAction('power.off'))).toMatchObject({ ok: true, state: { power: false }, result: { confirmed: true } })
      expect(broker.fromHub()).toEqual([
        { topic: 'zigbee2mqtt/porch/set', payload: '{"state":"ON"}', qos: 1, retain: false },
        { topic: 'zigbee2mqtt/porch/set', payload: '{"brightness":127}', qos: 1, retain: false },
        { topic: 'zigbee2mqtt/porch/set', payload: '{"state":"OFF"}', qos: 1, retain: false },
      ])
      lamp.crash()
      await waitFor(() => broker!.published.some((p) => p.topic === 'zigbee2mqtt/porch/availability' && p.payload === '{"state":"offline"}'))
      const gone = await adapter.probe(ctx)
      expect(gone.ok).toBe(false)
      expect(gone.error).toMatch(/offline/)
    })

    it('throws on a dead broker but returns a refusal for a wrong password', async () => {
      broker = await startBroker({ hub: 'broker-pass' })
      const refused = await adapter.execute(ctxFor({ ...PORCH, username: 'hub', password: 'not-the-pass' }), makeAction('power.on'))
      expect(refused).toEqual({ ok: false, error: 'Wrong username or password' })
      const port = broker.port
      await closeAllMqttClients()
      await broker.close()
      broker = null
      await expect(adapter.execute(ctxFor({ ...PORCH, username: 'hub', password: 'broker-pass' }, 'light', { port }), makeAction('power.on'))).rejects.toThrow(
        /refused the connection|did not answer/,
      )
    })
  })

  describe('reading state', () => {
    it('reads the kept state and availability after a restart', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch', { powerRetain: true }))
      const ctx = ctxFor({ ...PORCH, stateTopic: 'stat/porch/POWER', valueTemplate: '' })
      await adapter.execute(ctx, makeAction('power.on'))
      await closeAllMqttClients()
      const connectsBefore = broker.hubConnects()
      expect(await adapter.readState!(ctx)).toEqual({ power: true, available: true })
      expect(broker.hubConnects()).toBe(connectsBefore + 1)
      expect(broker.fromHub()).toHaveLength(1)
    })

    it('returns only what the broker actually holds', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      // stat/porch/RESULT is not kept by the broker, so only availability is known.
      const started = Date.now()
      expect(await adapter.readState!(ctxFor(PORCH))).toEqual({ available: true })
      expect(Date.now() - started).toBeLessThan(1500)
      expect(await adapter.readState!(ctxFor({ commandTopic: 'cmnd/porch/POWER' }))).toEqual({})
    })

    it('ignores JSON reports that do not carry the item', async () => {
      broker = await startBroker()
      const device = await add(tasmota(broker, 'porch'))
      const ctx = ctxFor(PORCH)
      const seen: Array<Record<string, unknown>> = []
      const stop = await adapter.subscribe!(ctx, (s) => seen.push(s))
      await waitFor(() => seen.length === 1)
      await device.client.publishAsync('stat/porch/RESULT', JSON.stringify({ POWER: 'ON' }))
      await device.client.publishAsync('stat/porch/RESULT', JSON.stringify({ Dimmer: 40 }))
      await device.client.publishAsync('stat/porch/RESULT', JSON.stringify({ POWER: 'OFF' }))
      await waitFor(() => seen.length === 3)
      expect(seen).toEqual([{ available: true }, { power: true }, { power: false }])
      stop()
    })

    it('reads an item nested inside a JSON report, however the item is written', async () => {
      broker = await startBroker()
      const device = asDevice(await connectDevice(broker, 'DVES_porch'))
      devices.push(device)
      // Tasmota tele/<topic>/STATE, the StatusSTS shape.
      const state = { Time: '2018.02.15 01:00:50', Uptime: '1 02:33:26', POWER: 'OFF', Wifi: { AP: 1, SSId: 'XXX', RSSI: 100 } }
      await device.client.publishAsync('tele/porch/STATE', JSON.stringify(state), { qos: 1, retain: true })
      for (const valueTemplate of ['Wifi.RSSI', 'wifi.rssi', '{{ value_json.Wifi.RSSI }}', "Wifi['RSSI']"]) {
        expect(await adapter.readState!(ctxFor({ stateTopic: 'tele/porch/STATE', valueTemplate }, 'sensor')), valueTemplate).toEqual({ value: 100 })
      }
      expect(await adapter.readState!(ctxFor({ stateTopic: 'tele/porch/STATE', valueTemplate: 'POWER' }, 'switch'))).toEqual({ power: false })
      expect(await adapter.readState!(ctxFor({ stateTopic: 'tele/porch/STATE', valueTemplate: 'Wifi.Missing' }, 'sensor'))).toEqual({})
    })

    it('takes a plain word or number as it stands even when an item name is filled in', async () => {
      broker = await startBroker()
      const pump = asDevice(await connectDevice(broker, 'esp-pump'))
      devices.push(pump)
      await pump.client.publishAsync('home/pump/state', '1', { qos: 1, retain: true })
      const ctx = ctxFor(asSaved({ commandTopic: 'home/pump/set', stateTopic: 'home/pump/state', valueTemplate: 'state', payloadOn: '1', payloadOff: '0' }), 'switch')
      expect(await adapter.readState!(ctx)).toEqual({ power: true })
    })

    it('reports a sensor reading as a number', async () => {
      broker = await startBroker()
      const sensor = asDevice(await connectDevice(broker, 'esp-tank'))
      devices.push(sensor)
      await sensor.client.publishAsync('home/tank/level', '72.5', { qos: 1, retain: true })
      const ctx = ctxFor({ stateTopic: 'home/tank/level' }, 'sensor')
      expect(await adapter.readState!(ctx)).toEqual({ value: 72.5 })
      expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: false })
    })
  })

  describe('brightness', () => {
    it('sets a Tasmota dimmer and reads brightness and power from one JSON reply', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      const ctx = ctxFor({ ...PORCH, brightnessCommandTopic: 'cmnd/porch/Dimmer', brightnessValueTemplate: 'Dimmer' })
      const res = await adapter.execute(ctx, makeAction('dim.set', { brightness: 60 }))
      expect(res).toMatchObject({ ok: true, state: { brightness: 60, power: true }, result: { confirmed: true } })
      expect(broker.fromHub()).toEqual([{ topic: 'cmnd/porch/Dimmer', payload: '60', qos: 1, retain: false }])
    })

    it('scales 0-100 % to the range the device counts in', async () => {
      broker = await startBroker()
      await add(espDimmer(broker))
      const ctx = ctxFor({ commandTopic: 'home/hall/set', brightnessCommandTopic: 'home/hall/level/set', brightnessStateTopic: 'home/hall/level', brightnessScale: 255 })
      expect(await adapter.execute(ctx, makeAction('dim.set', { brightness: 50 }))).toMatchObject({ ok: true, state: { brightness: 50 }, result: { confirmed: true } })
      expect(await adapter.execute(ctx, makeAction('dim.set', { brightness: 100 }))).toMatchObject({ ok: true, state: { brightness: 100 } })
      expect(await adapter.execute(ctx, makeAction('dim.set', { brightness: 250 }))).toMatchObject({ ok: true, state: { brightness: 100 } })
      expect(broker.fromHub().map((p) => p.payload)).toEqual(['128', '255', '255'])
      // 128 of 255 is shown as 50 %.
      await devices[0]!.client.publishAsync('home/hall/level', '128', { qos: 1, retain: true })
      await closeAllMqttClients()
      expect(await adapter.readState!(ctx)).toEqual({ brightness: 50 })
    })

    it('wraps the number in the message the device wants', async () => {
      broker = await startBroker()
      const ctx = ctxFor({ commandTopic: 'home/hall/set', brightnessCommandTopic: 'home/hall/set', brightnessCommandTemplate: '{"brightness":{value}}', brightnessScale: 254 })
      const res = await adapter.execute(ctx, makeAction('dim.set', { brightness: 50 }))
      expect(res).toEqual({ ok: true, state: { brightness: 50 }, result: { confirmed: false } })
      await hubPublished(1)
      expect(broker.fromHub()).toEqual([{ topic: 'home/hall/set', payload: '{"brightness":127}', qos: 1, retain: false }])
    })

    it('refuses brightness on a plain on/off light', async () => {
      broker = await startBroker()
      expect(await adapter.execute(ctxFor(PORCH), makeAction('dim.set', { brightness: 40 }))).toMatchObject({ ok: false })
      expect(await adapter.execute(ctxFor({ ...PORCH, brightnessCommandTopic: 'cmnd/porch/Dimmer' }), makeAction('dim.set', {}))).toEqual({ ok: false, error: 'No brightness was given' })
      expect(broker.hubConnects()).toBe(0)
    })
  })

  describe('gate', () => {
    it('opens, stops and closes with the gate messages and maps the reports', async () => {
      broker = await startBroker()
      await add(gateController(broker))
      // Only the two topics typed in: the open / close / stop boxes left empty mean OPEN / CLOSE / STOP.
      const ctx = ctxFor(asSaved(GATE), 'gate')
      expect(await adapter.readState!(ctx)).toEqual({ gate: 'closed' })

      const open = await adapter.execute(ctx, makeAction('gate.open'))
      expect(open).toMatchObject({ ok: true, state: { gate: 'opening' }, result: { confirmed: true } })
      await waitFor(() => broker!.published.some((p) => p.topic === 'home/gate/state' && p.payload === 'open'))
      expect(await adapter.readState!(ctx)).toEqual({ gate: 'open' })

      const close = await adapter.execute(ctx, makeAction('gate.close'))
      expect(close).toMatchObject({ ok: true, state: { gate: 'closing' } })
      const stop = await adapter.execute(ctx, makeAction('gate.stop'))
      expect(stop).toMatchObject({ ok: true, state: { gate: 'stopped' }, result: { confirmed: true } })
      expect(await adapter.readState!(ctx)).toEqual({ gate: 'stopped' })

      expect(broker.fromHub()).toEqual([
        { topic: 'home/gate/set', payload: 'OPEN', qos: 1, retain: false },
        { topic: 'home/gate/set', payload: 'CLOSE', qos: 1, retain: false },
        { topic: 'home/gate/set', payload: 'STOP', qos: 1, retain: false },
      ])
    })

    it('maps the owner’s own words for open and closed, and anything else to unknown', async () => {
      broker = await startBroker()
      const reed = asDevice(await connectDevice(broker, 'esp-reed'))
      devices.push(reed)
      const ctx = ctxFor({ ...GATE, stateOpen: 'ON', stateClosed: 'OFF' }, 'gate')
      const seen: Array<Record<string, unknown>> = []
      const stop = await adapter.subscribe!(ctx, (s) => seen.push(s))
      for (const word of ['on', 'OFF', 'jammed']) await reed.client.publishAsync('home/gate/state', word, { qos: 1 })
      await waitFor(() => seen.length === 3)
      expect(seen).toEqual([{ gate: 'open' }, { gate: 'closed' }, { gate: 'unknown' }])
      stop()
    })

    it('never keeps a gate command on the broker, whatever the retain setting', async () => {
      broker = await startBroker()
      await add(gateController(broker))
      await adapter.execute(ctxFor({ ...GATE, retain: true, payloadOpen: 'OPEN', payloadPulse: 'PRESS' }, 'gate'), makeAction('gate.open'))
      await adapter.execute(ctxFor({ ...GATE, retain: true, payloadOpen: 'OPEN', payloadPulse: 'PRESS' }, 'gate'), makeAction('gate.pulse'))
      expect(broker.fromHub()).toEqual([
        { topic: 'home/gate/set', payload: 'OPEN', qos: 1, retain: false },
        { topic: 'home/gate/set', payload: 'PRESS', qos: 1, retain: false },
      ])
    })

    it('needs a pulse message before it will pulse', async () => {
      broker = await startBroker()
      expect(await adapter.execute(ctxFor(GATE, 'gate'), makeAction('gate.pulse'))).toEqual({ ok: false, error: 'This gate has no step-button message filled in, so there is no single press to send' })
      expect(broker.hubConnects()).toBe(0)
    })

    it('drives a one-button gate with single presses and never presses the wrong way', async () => {
      broker = await startBroker()
      await add(gateController(broker, 'closed'))
      // Exactly what the hub stores when the owner fills in only the step-button message.
      const ctx = ctxFor(asSaved({ ...GATE, payloadOpen: '', payloadClose: '', payloadStop: '', payloadPulse: 'PRESS' }), 'gate')

      // Stop while it stands still would start it: refused, nothing sent.
      const idleStop = await adapter.execute(ctx, makeAction('gate.stop'))
      expect(idleStop.ok).toBe(false)
      expect(idleStop.error).toMatch(/not moving/)
      // Close while it is already closed: nothing to do, nothing sent.
      expect(await adapter.execute(ctx, makeAction('gate.close'))).toEqual({ ok: true, state: { gate: 'closed' }, result: { alreadyThere: true } })
      expect(broker.fromHub()).toEqual([])

      const open = await adapter.execute(ctx, makeAction('gate.open'))
      expect(open).toMatchObject({ ok: true, state: { gate: 'opening' }, result: { via: 'pulse', confirmed: true } })
      const stop = await adapter.execute(ctx, makeAction('gate.stop'))
      expect(stop).toMatchObject({ ok: true, state: { gate: 'stopped' }, result: { via: 'pulse' } })
      expect(broker.fromHub()).toEqual([
        { topic: 'home/gate/set', payload: 'PRESS', qos: 1, retain: false },
        { topic: 'home/gate/set', payload: 'PRESS', qos: 1, retain: false },
      ])
    })

    it('does not repeat a button press whose delivery is in doubt', async () => {
      broker = await startBroker()
      await add(gateController(broker))
      broker.stall('home/gate/set')
      const ctx = ctxFor({ ...GATE, payloadOpen: 'OPEN', payloadPulse: 'PRESS' }, 'gate', { timeoutMs: 500 })
      // The broker took the press but never confirmed it: a refusal, so the hub will not send a second press elsewhere.
      const pulse = await adapter.execute(ctx, makeAction('gate.pulse'))
      expect(pulse.ok).toBe(false)
      expect(pulse.error).toMatch(/did not confirm the command in time.*may or may not have gone through/)
      // A plain OPEN is safe to send again, so that one is thrown for the hub to try another connection.
      await expect(adapter.execute(ctx, makeAction('gate.open'))).rejects.toThrow(/did not confirm the command in time/)
      // Each doubtful connection was thrown away rather than kept with the command still on it.
      expect(broker.hubConnects()).toBe(2)
    })

    it('never sends an old command once the broker is back', async () => {
      broker = await startBroker()
      const port = broker.port
      const seen: Array<Record<string, unknown>> = []
      const stop = await adapter.subscribe!(ctxFor(GATE, 'gate'), (s) => seen.push(s))
      await broker.close()
      broker = null
      await expect(adapter.execute(ctxFor(GATE, 'gate', { port, timeoutMs: 600 }), makeAction('gate.open'))).rejects.toThrow()

      broker = await startBroker(undefined, false, port)
      await add(gateController(broker))
      // The hub finds the broker again by itself and hears the gate's kept report...
      await waitFor(() => broker!.hubConnects() === 1, 12_000)
      await waitFor(() => seen.length === 1)
      expect(seen).toEqual([{ gate: 'closed' }])
      // ...but the OPEN that failed earlier is gone for good.
      await pause(300)
      expect(broker.fromHub()).toEqual([])
      stop()
    })

    it('pulses a relay wired to the gate button (Tasmota relay "gate1")', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'gate1'))
      const ctx = ctxFor(asSaved({ commandTopic: 'cmnd/gate1/POWER', payloadPulse: 'ON' }), 'gate')
      expect(adapter.capabilities(ctx.device.config, 'gate')).toEqual(['gate'])
      expect(await adapter.execute(ctx, makeAction('gate.pulse'))).toEqual({ ok: true, state: undefined, result: { confirmed: false } })
      expect(await adapter.execute(ctx, makeAction('gate.open'))).toEqual({ ok: true, state: undefined, result: { via: 'pulse', confirmed: false } })
      // No position report, so Stop cannot be sent safely.
      expect((await adapter.execute(ctx, makeAction('gate.stop'))).ok).toBe(false)
      await hubPublished(2)
      expect(broker.fromHub()).toEqual([
        { topic: 'cmnd/gate1/POWER', payload: 'ON', qos: 1, retain: false },
        { topic: 'cmnd/gate1/POWER', payload: 'ON', qos: 1, retain: false },
      ])
    })
  })

  describe('pushed state', () => {
    it('pushes every report until unsubscribed', async () => {
      broker = await startBroker()
      const device = await add(tasmota(broker, 'porch'))
      const ctx = ctxFor(PORCH)
      const seen: Array<Record<string, unknown>> = []
      const stop = await adapter.subscribe!(ctx, (s) => seen.push(s))
      expect(broker.subscribed.filter((s) => HUB.test(s.clientId)).map((s) => s.topic).sort()).toEqual(['stat/porch/RESULT', 'tele/porch/LWT'])
      // The kept availability message arrives straight away.
      await waitFor(() => seen.length === 1)
      expect(seen[0]).toEqual({ available: true })

      // Someone presses the wall switch: the device reports on its own.
      await device.client.publishAsync('stat/porch/RESULT', JSON.stringify({ POWER: 'ON' }))
      await waitFor(() => seen.length === 2)
      expect(seen[1]).toEqual({ power: true })

      // What subscribe() saw is what readState() returns, without another round trip to the device.
      const started = Date.now()
      expect(await adapter.readState!(ctx)).toEqual({ power: true, available: true })
      expect(Date.now() - started).toBeLessThan(300)

      device.crash()
      await waitFor(() => seen.length === 3)
      expect(seen[2]).toEqual({ available: false })

      stop()
      stop()
      await waitFor(() => broker!.unsubscribed.filter((u) => HUB.test(u.clientId)).length === 2)
      const other = asDevice(await connectDevice(broker, 'other'))
      devices.push(other)
      await other.client.publishAsync('stat/porch/RESULT', JSON.stringify({ POWER: 'OFF' }), { qos: 1 })
      await pause(100)
      expect(seen).toHaveLength(3)
    })

    it('gives a second listener on the same topic what is already known, on the same subscription', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      const first: Array<Record<string, unknown>> = []
      const second: Array<Record<string, unknown>> = []
      const stopFirst = await adapter.subscribe!(ctxFor(PORCH), (s) => first.push(s))
      await waitFor(() => first.length === 1)
      const stopSecond = await adapter.subscribe!(ctxFor(PORCH), (s) => second.push(s))
      await waitFor(() => second.length === 1)
      expect(second).toEqual([{ available: true }])
      expect(broker.subscribed.filter((s) => HUB.test(s.clientId))).toHaveLength(2)
      // The shared subscription stays until the last listener leaves.
      stopFirst()
      await pause(50)
      expect(broker.unsubscribed).toEqual([])
      stopSecond()
      await waitFor(() => broker!.unsubscribed.length === 2)
    })

    it('accepts a wildcard state topic', async () => {
      broker = await startBroker()
      const tank = asDevice(await connectDevice(broker, 'esp-tank'))
      devices.push(tank)
      const seen: Array<Record<string, unknown>> = []
      const stop = await adapter.subscribe!(ctxFor({ stateTopic: 'home/+/level' }, 'sensor'), (s) => seen.push(s))
      await tank.client.publishAsync('home/tank/level', '41', { qos: 1 })
      await tank.client.publishAsync('home/tank/level/raw', '9999', { qos: 1 })
      await tank.client.publishAsync('home/sump/level', '7', { qos: 1 })
      await waitFor(() => seen.length === 2)
      await pause(50)
      expect(seen).toEqual([{ value: 41 }, { value: 7 }])
      stop()
    })

    it('reconnects by itself after the broker drops the hub, and listens again', async () => {
      broker = await startBroker()
      const device = await add(tasmota(broker, 'porch'))
      const seen: Array<Record<string, unknown>> = []
      const stop = await adapter.subscribe!(ctxFor(PORCH), (s) => seen.push(s))
      await waitFor(() => seen.length === 1)
      broker.kickHub()
      await waitFor(() => broker!.hubConnects() === 2, 5000)
      // Subscribed again on the new connection, and the kept message is delivered again.
      await waitFor(() => broker!.subscribed.filter((s) => HUB.test(s.clientId)).length === 4)
      await waitFor(() => seen.length === 2)
      await device.client.publishAsync('stat/porch/RESULT', JSON.stringify({ POWER: 'ON' }), { qos: 1 })
      await waitFor(() => seen.length === 3)
      expect(seen).toEqual([{ available: true }, { available: true }, { power: true }])
      stop()
    })

    it('starts listening later when the broker is down at first', async () => {
      broker = await startBroker()
      const port = broker.port
      await broker.close()
      broker = null
      const seen: Array<Record<string, unknown>> = []
      const stop = await adapter.subscribe!(ctxFor(PORCH, 'light', { port, timeoutMs: 800 }), (s) => seen.push(s))
      expect(seen).toEqual([])
      expect(mqttClientCount()).toBe(1)
      stop()
    })
  })

  describe('shared broker connection', () => {
    it('uses one connection for every device on the same broker and login', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      await add(tasmota(broker, 'hall'))
      const porch = ctxFor(PORCH, 'light', { id: 'dev_porch' })
      const hall = ctxFor({ commandTopic: 'cmnd/hall/POWER', stateTopic: 'stat/hall/POWER' }, 'light', { id: 'dev_hall' })
      expect((await adapter.probe(porch)).ok).toBe(true)
      expect((await adapter.probe(hall)).ok).toBe(true)
      expect(await adapter.execute(porch, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
      expect(await adapter.execute(hall, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
      await adapter.readState!(porch)
      expect(broker.hubConnects()).toBe(1)
      expect(mqttClientCount()).toBe(1)
    })

    it('keeps separate connections for separate logins', async () => {
      broker = await startBroker({ hub: 'broker-pass', guest: 'guest-pass' })
      expect((await adapter.probe(ctxFor({ username: 'hub', password: 'broker-pass' }))).ok).toBe(true)
      expect((await adapter.probe(ctxFor({ username: 'guest', password: 'guest-pass' }))).ok).toBe(true)
      expect(broker.hubConnects()).toBe(2)
      expect(mqttClientCount()).toBe(2)
    })

    it('closes everything with closeAllMqttClients()', async () => {
      broker = await startBroker()
      await add(tasmota(broker, 'porch'))
      const seen: Array<Record<string, unknown>> = []
      await adapter.subscribe!(ctxFor(PORCH), (s) => seen.push(s))
      await waitFor(() => seen.length === 1)
      expect(mqttClientCount()).toBe(1)
      await closeAllMqttClients()
      expect(mqttClientCount()).toBe(0)
      await waitFor(() => broker!.disconnected.some((id) => HUB.test(id)))
      // A later call simply opens a fresh connection.
      expect((await adapter.probe(ctxFor(PORCH))).ok).toBe(true)
      expect(broker.hubConnects()).toBe(2)
    })

    it('closes an unused connection after the idle time', async () => {
      broker = await startBroker()
      setMqttIdleCloseMs(80)
      expect((await adapter.probe(ctxFor({}))).ok).toBe(true)
      expect(mqttClientCount()).toBe(1)
      await waitFor(() => mqttClientCount() === 0)
      await waitFor(() => broker!.disconnected.some((id) => HUB.test(id)))
    })

    it('notices a kept-open connection that has died and connects again', async () => {
      broker = await startBroker()
      expect((await adapter.probe(ctxFor({}))).ok).toBe(true)
      broker.kickHub()
      expect((await adapter.probe(ctxFor({}))).ok).toBe(true)
      expect(broker.hubConnects()).toBe(2)
    })
  })

  describe('other commands', () => {
    it('refuses what a generic MQTT device cannot do, without touching the broker', async () => {
      broker = await startBroker()
      const light = ctxFor(PORCH)
      for (const action of [makeAction('ptz.move', { pan: 1 }), makeAction('color.set', { hex: '#ff8800' }), makeAction('reboot'), makeAction('gate.open'), makeAction('sms.send', { text: 'hi' })]) {
        const res = await adapter.execute(light, action)
        expect(res.ok, action.type).toBe(false)
        expect(res.error, action.type).toContain(action.type)
      }
      expect((await adapter.execute(ctxFor(GATE, 'gate'), makeAction('power.on'))).ok).toBe(false)
      expect(await adapter.execute(ctxFor({ stateTopic: 'stat/porch/POWER' }), makeAction('power.on'))).toEqual({ ok: false, error: 'No command topic is set for this device' })
      expect((await adapter.execute(ctxFor({ commandTopic: 'cmnd/+/POWER' }), makeAction('power.on'))).error).toMatch(/cannot contain \+ or #/)
      expect(broker.hubConnects()).toBe(0)
    })

    it('sends a custom message', async () => {
      broker = await startBroker()
      const ctx = ctxFor(PORCH)
      // Tasmota: any command can be sent as cmnd/<topic>/<Command>.
      const res = await adapter.execute(ctx, makeAction('custom', { topic: 'cmnd/porch/Backlog', payload: 'SSID2 Backup; Password2 secret' }))
      expect(res).toEqual({ ok: true, state: undefined, result: { topic: 'cmnd/porch/Backlog', confirmed: false } })
      expect((await adapter.execute(ctx, makeAction('custom', {}))).ok).toBe(false)
      await hubPublished(1)
      expect(broker.fromHub()).toEqual([{ topic: 'cmnd/porch/Backlog', payload: 'SSID2 Backup; Password2 secret', qos: 1, retain: false }])
    })
  })
})
