/**
 * Generic MQTT device — for anything that talks through an MQTT broker:
 * Tasmota in MQTT mode, ESPHome, Zigbee2MQTT, Shelly with MQTT switched on,
 * home-made ESP relays, and SIM-only relays that dial OUT to a broker (the one
 * design that works through carrier NAT, because nothing has to connect in).
 *
 * The address on each connection path is the BROKER, not the device. One
 * client is kept per broker + login and shared by every device on it; it is
 * closed about 30 s after the last user lets go.
 *
 * Safety choices that matter for gates:
 *  - mqtt.js auto-reconnect and offline queueing are OFF. A command is only
 *    ever written to a live connection, and after a drop the hub opens a
 *    brand-new client, so an old "open the gate" can never be replayed later.
 *  - Commands to a gate are never published as retained messages.
 *  - Nothing is published when the device has told the broker it is offline.
 */
import { createHash, randomBytes } from 'node:crypto'
import mqtt from 'mqtt'
import type { IClientOptions, MqttClient } from 'mqtt'
import type { Action, Capability, DeviceKind, FamilyDescriptor, GateState } from '@house/shared'
import { clamp, requireHost, unsupported, type ActionResult, type Adapter, type AdapterContext, type ProbeResult } from './types.ts'

const DEFAULT_PORT = 1883
const DEFAULT_TLS_PORT = 8883
const KEEPALIVE_SEC = 30
/**
 * A broker replays kept (retained) messages right after it confirms a subscription. These are how
 * long after that confirmation the hub still waits for one: longer when checking a connection,
 * because calling a device offline by mistake is worse than a slow check.
 */
const AVAILABILITY_WAIT_MS = 1500
const RETAINED_WAIT_MS = 600
/** A message flagged as kept this soon after subscribing is taken as a replay of the past. */
const REPLAY_WINDOW_MS = 2000
/** Longest wait for the device to report back after a command (a relay on a SIM can take a second or two). */
const ECHO_WAIT_MAX_MS = 4000
/** Background reconnect steps while something is listening for pushed state. */
const RETRY_STEPS_MS = [1000, 2000, 5000, 10_000, 30_000]
const REFUSED_RETRY_MS = 60_000
const BACKGROUND_CONNECT_MS = 10_000

let idleCloseMs = 30_000

type Qos = 0 | 1 | 2

/** The broker turned the hub away (login, permissions). Not a transport problem: no failover. */
class BrokerRefusedError extends Error {}
/** A command was written but never confirmed, so it may or may not have gone through. */
class UnconfirmedError extends Error {}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms))
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** Wakes everyone waiting each time a message arrives. */
class Signal {
  private waiters = new Set<() => void>()

  fire(): void {
    for (const w of [...this.waiters]) w()
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(1, ms))
      this.waiters.add(done)
    })
  }
}

async function until<T>(signal: Signal, deadline: number, check: () => T | undefined): Promise<T | undefined> {
  for (;;) {
    const found = check()
    if (found !== undefined) return found
    const left = deadline - Date.now()
    if (left <= 0) return undefined
    await signal.wait(left)
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function hasWildcard(topic: string): boolean {
  return topic.includes('+') || topic.includes('#')
}

/** MQTT topic filter match ("+" one level, "#" the rest). */
function topicMatches(filter: string, topic: string): boolean {
  if (filter === topic) return true
  const f = filter.split('/')
  const t = topic.split('/')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true
    if (i >= t.length) return false
    if (f[i] !== '+' && f[i] !== t[i]) return false
  }
  return f.length === t.length
}

// ---------------------------------------------------------------------------
// One shared client per broker + login
// ---------------------------------------------------------------------------

interface LastMessage {
  text: string
  retained: boolean
  at: number
}

type Listener = (topic: string, text: string, retained: boolean) => void

interface Watch {
  filter: string
  qos: Qos
  listeners: Set<Listener>
  /** Latest message seen while subscribed on the current connection. */
  last: LastMessage | null
  /** Settles when the broker has confirmed the subscription on the current connection. */
  granted: Promise<void> | null
  /** When that confirmation came in. Kept messages, if any, follow it at once. */
  grantedAt: number | null
}

class BrokerLink {
  /** Calls in flight plus long-lived listeners. The link closes a while after this reaches 0. */
  refs = 0
  /** Long-lived listeners (subscribe). While > 0 the link reconnects by itself. */
  holders = 0
  closed = false
  idleTimer: NodeJS.Timeout | null = null
  readonly watches = new Map<string, Watch>()
  private client: MqttClient | null = null
  /** A client that is still trying to connect, so close() can stop it. */
  private opening: MqttClient | null = null
  private connecting: Promise<MqttClient> | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryStep = 0

  constructor(
    readonly key: string,
    /** host:port, for messages. Never carries the login. */
    readonly label: string,
    private readonly host: string,
    private readonly hasLogin: boolean,
    private readonly options: IClientOptions,
  ) {}

  private get secure(): boolean {
    return this.options.protocol === 'mqtts'
  }

  get connected(): boolean {
    return this.client?.connected === true
  }

  /** Connected client, opening the connection if needed. Throws in plain language. */
  connect(timeoutMs: number): Promise<MqttClient> {
    if (this.closed) return Promise.reject(new Error(`The connection to the broker at ${this.label} was closed`))
    if (this.client?.connected) return Promise.resolve(this.client)
    if (!this.connecting) {
      this.connecting = this.open(Math.max(1000, timeoutMs)).then(
        (client) => {
          this.connecting = null
          return client
        },
        (err: unknown) => {
          this.connecting = null
          this.scheduleRetry(err instanceof BrokerRefusedError)
          throw err
        },
      )
    }
    return within(this.connecting, timeoutMs, `The broker at ${this.label} did not answer`)
  }

  private open(timeoutMs: number): Promise<MqttClient> {
    return new Promise((resolve, reject) => {
      let settled = false
      let client: MqttClient
      try {
        // A fresh client every time: nothing an earlier connection failed to send can ride along.
        client = mqtt.connect({
          ...this.options,
          clientId: `housecontrol-${randomBytes(4).toString('hex')}`,
          connectTimeout: timeoutMs,
        })
      } catch (err) {
        reject(new Error(`Could not connect to the broker at ${this.label}: ${errorText(err)}`))
        return
      }
      this.opening = client
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        if (this.opening === client) this.opening = null
        client.end(true)
        reject(err)
      }
      // Always keep an error listener: an unheard "error" event would crash the hub.
      client.on('error', (err) => fail(this.describeConnectError(err)))
      client.on('close', () => {
        if (!settled) fail(new Error(`The broker at ${this.label} closed the connection`))
        else this.lost(client)
      })
      client.on('message', (topic, payload, packet) => this.dispatch(topic, payload, packet.retain === true))
      client.once('connect', () => {
        if (settled) return
        settled = true
        if (this.opening === client) this.opening = null
        if (this.closed) {
          client.end(true)
          reject(new Error(`The connection to the broker at ${this.label} was closed`))
          return
        }
        this.client = client
        this.retryStep = 0
        for (const w of this.watches.values()) w.granted = this.grant(client, w)
        resolve(client)
      })
    })
  }

  private describeConnectError(err: Error & { code?: unknown }): Error {
    const code = err.code
    if (typeof code === 'number') {
      // CONNACK return codes (MQTT 3.1.1).
      if (code === 4) return new BrokerRefusedError('Wrong username or password')
      if (code === 5) {
        return new BrokerRefusedError(
          this.hasLogin
            ? 'Wrong username or password (the broker refused this login)'
            : `The broker at ${this.label} does not let anyone in without a username and password`,
        )
      }
      if (code === 2) return new BrokerRefusedError(`The broker at ${this.label} refused the name the hub connects under`)
      if (code === 3) return new Error(`The broker at ${this.label} says it is not available right now`)
      if (code === 1) return new BrokerRefusedError(`The broker at ${this.label} does not speak this version of MQTT (3.1.1)`)
      return new Error(`The broker at ${this.label} refused the connection (code ${code})`)
    }
    const text = String(code ?? '')
    switch (text) {
      case 'ECONNREFUSED':
        return new Error(`${this.label} refused the connection (wrong port, or the broker is not running)`)
      case 'EHOSTUNREACH':
      case 'ENETUNREACH':
        return new Error(`${this.host} is not reachable from this network`)
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return new Error(`${this.host} could not be found (check the broker address)`)
      case 'ETIMEDOUT':
        return new Error(`The broker at ${this.label} did not answer`)
      case 'ECONNRESET':
      case 'EPIPE':
        return new Error(
          this.secure
            ? `${this.label} hung up while the secure (TLS) connection was being set up. Secure brokers usually listen on port ${DEFAULT_TLS_PORT}.`
            : `${this.label} closed the connection`,
        )
      case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      case 'SELF_SIGNED_CERT_IN_CHAIN':
      case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      case 'CERT_HAS_EXPIRED':
      case 'ERR_TLS_CERT_ALTNAME_INVALID':
        return new Error(
          `The security certificate of the broker at ${this.label} could not be checked. If it is your own broker with a self-made certificate, turn on "Accept a self-made certificate".`,
        )
      case 'EPROTO':
      case 'ERR_SSL_WRONG_VERSION_NUMBER':
        return new Error(`${this.label} did not answer as a secure (TLS) broker. Secure brokers usually listen on port ${DEFAULT_TLS_PORT}.`)
    }
    if (/connack timeout/i.test(err.message)) return new Error(`The broker at ${this.label} did not answer`)
    if (/TLS not authorized/i.test(err.message)) {
      return new Error(`The security certificate of the broker at ${this.label} could not be checked`)
    }
    // No error code at all: the other side answered, but with something mqtt.js could not read as
    // MQTT (a web server or another service on that port).
    if (code === undefined || code === null || text === '') {
      return new Error(`Something answered at ${this.label}, but not the way an MQTT broker does. Check the address and the port (brokers usually use ${DEFAULT_PORT}, or ${DEFAULT_TLS_PORT} for secure connections).`)
    }
    return new Error(`Could not connect to the broker at ${this.label}: ${err.message}`)
  }

  /** The current connection died (or is being thrown away). Everything cached from it is stale. */
  private lost(client: MqttClient): void {
    if (this.client !== client) return
    this.client = null
    client.end(true)
    for (const w of this.watches.values()) {
      w.granted = null
      w.grantedAt = null
      w.last = null
    }
    this.scheduleRetry(false)
  }

  /** Throw the current connection away, e.g. when it stopped answering. */
  drop(): void {
    if (this.client) this.lost(this.client)
  }

  private scheduleRetry(refused: boolean): void {
    if (this.closed || this.holders === 0 || this.retryTimer || this.client || this.connecting) return
    const delay = refused ? REFUSED_RETRY_MS : RETRY_STEPS_MS[Math.min(this.retryStep, RETRY_STEPS_MS.length - 1)]!
    this.retryStep += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      // A failure re-arms the timer through connect(); nothing to do here.
      this.connect(BACKGROUND_CONNECT_MS).catch(() => undefined)
    }, delay)
    this.retryTimer.unref?.()
  }

  /** Make sure a retry is pending for a long-lived listener that could not connect yet. */
  keepTrying(): void {
    this.scheduleRetry(false)
  }

  private grant(client: MqttClient, w: Watch): Promise<void> {
    const p = new Promise<void>((resolve, reject) => {
      client.subscribe(w.filter, { qos: w.qos }, (err, granted) => {
        // mqtt.js reports a refused subscription (SUBACK 0x80) as a "Subscribe error" that carries
        // the SUBACK packet. Any other error means the connection went away first: a transport
        // problem, not a refusal.
        const detail = err as { code?: unknown; packet?: { granted?: unknown } } | null
        const answered = Array.isArray(detail?.packet?.granted) ? (detail.packet.granted as unknown[]) : []
        const refused =
          answered.some((g) => typeof g === 'number' && g >= 0x80) ||
          (typeof detail?.code === 'number' && detail.code >= 0x80) ||
          (err ? /^Subscribe error/i.test(err.message) : granted?.some((g) => g.qos === 128) === true)
        if (refused) {
          reject(new BrokerRefusedError(`The broker does not allow the hub to listen on "${w.filter}". Check what this broker login is permitted to read.`))
        } else if (err) reject(new Error(`The connection to the broker at ${this.label} dropped while the hub was starting to listen`))
        else {
          w.grantedAt = Date.now()
          resolve()
        }
      })
    })
    p.catch(() => undefined)
    return p
  }

  private dispatch(topic: string, payload: Buffer, retainFlag: boolean): void {
    const text = payload.toString('utf8')
    for (const w of [...this.watches.values()]) {
      if (!topicMatches(w.filter, topic)) continue
      // A kept message replayed by the broker comes right after a new subscription is confirmed.
      // Proper brokers clear the flag on live messages; a small one that does not (some run on an
      // ESP board) must not make every live report look like an old one.
      const now = Date.now()
      const retained = retainFlag && (w.last === null || w.grantedAt === null || now - w.grantedAt < REPLAY_WINDOW_MS || hasWildcard(w.filter))
      w.last = { text, retained, at: now }
      for (const listener of [...w.listeners]) {
        try {
          listener(topic, text, retained)
        } catch {
          // A listener's own problem must not stop the others.
        }
      }
    }
  }

  /** Listen on a topic. Several listeners share one subscription and its latest message. */
  watch(filter: string, qos: Qos, listener: Listener): { watch: Watch; off: () => void } {
    let w = this.watches.get(filter)
    if (!w) {
      w = { filter, qos, listeners: new Set(), last: null, granted: null, grantedAt: null }
      this.watches.set(filter, w)
    }
    const entry = w
    entry.listeners.add(listener)
    if (!entry.granted && this.client?.connected) entry.granted = this.grant(this.client, entry)
    const off = () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size > 0 || this.watches.get(filter) !== entry) return
      this.watches.delete(filter)
      if (this.client?.connected) this.client.unsubscribe(filter, () => undefined)
    }
    return { watch: entry, off }
  }

  /** Write a message and wait until the broker has it (QoS 1/2) or it is on the wire (QoS 0). */
  publish(topic: string, payload: string, opts: { qos: Qos; retain: boolean }, timeoutMs: number): Promise<void> {
    const client = this.client
    if (!client?.connected) return Promise.reject(new Error(`The broker at ${this.label} is not connected`))
    return new Promise((resolve, reject) => {
      let finished = false
      const finish = (err?: Error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        client.removeListener('close', onClose)
        if (err) reject(err)
        else resolve()
      }
      const onClose = () => finish(new UnconfirmedError(`The connection to the broker at ${this.label} dropped before it confirmed the command`))
      const timer = setTimeout(
        () => {
          finish(new UnconfirmedError(`The broker at ${this.label} did not confirm the command in time`))
          // Never leave an unconfirmed command behind on a connection that might wake up later.
          this.drop()
        },
        Math.max(1, timeoutMs),
      )
      client.once('close', onClose)
      client.publish(topic, payload, { qos: opts.qos, retain: opts.retain }, (err) => {
        finish(err ? new UnconfirmedError(`The broker at ${this.label} did not confirm the command (${err.message})`) : undefined)
      })
    })
  }

  /** One round trip, to be sure a kept-open connection is still alive. */
  ping(timeoutMs: number): Promise<void> {
    const client = this.client
    if (!client?.connected) return Promise.reject(new Error(`The broker at ${this.label} is not connected`))
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer)
        client.removeListener('packetreceive', onPacket)
        client.removeListener('close', onClose)
        if (err) reject(err)
        else resolve()
      }
      const onPacket = (packet: { cmd: string }) => {
        if (packet.cmd === 'pingresp') done()
      }
      const onClose = () => done(new Error(`The broker at ${this.label} closed the connection`))
      const timer = setTimeout(() => done(new Error(`The broker at ${this.label} did not answer`)), Math.max(1, timeoutMs))
      client.on('packetreceive', onPacket)
      client.once('close', onClose)
      client.sendPing()
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (pool.get(this.key) === this) pool.delete(this.key)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.idleTimer = null
    this.retryTimer = null
    this.watches.clear()
    const clients = [this.client, this.opening].filter((c): c is MqttClient => c !== null)
    this.client = null
    this.opening = null
    await Promise.all(clients.map((c) => c.endAsync(true).catch(() => undefined)))
  }
}

const pool = new Map<string, BrokerLink>()

/** Where the broker is on this path, and how to log in. */
function brokerOf(ctx: AdapterContext): { key: string; label: string; host: string; hasLogin: boolean; options: IClientOptions } {
  // Forgive a pasted address such as mqtts://name:secret@broker.example.com:8883/ : keep only the
  // host, the port and whether it is secure. A login pasted in front of the host is thrown away
  // here so that it can never end up in a message; the login comes from the form.
  const pasted = requireHost(ctx)
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(pasted)?.[1]?.toLowerCase() ?? ''
  let host = pasted
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/^.*@/, '')
  let port = ctx.path.port
  const withPort = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(host)
  if (withPort) {
    host = withPort[1]!
    // A port typed into the address itself is the more deliberate of the two.
    port = Number(withPort[2])
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host) throw new Error(`No address set on the "${ctx.path.label}" connection`)
  const onPath = ctx.path.extra?.tls
  const tls = typeof onPath === 'boolean' ? onPath : ctx.bool('tls', false) || port === DEFAULT_TLS_PORT || scheme === 'mqtts' || scheme === 'ssl' || scheme === 'tls'
  const finalPort = port ?? (tls ? DEFAULT_TLS_PORT : DEFAULT_PORT)
  const username = ctx.str('username').trim()
  const password = ctx.secret('password')
  const insecure = ctx.bool('tlsInsecure', false)
  const label = `${host.includes(':') ? `[${host}]` : host}:${finalPort}`
  // The password only ever enters the key as a hash, so the key is safe to keep around.
  const key = createHash('sha256')
    .update([tls ? 'mqtts' : 'mqtt', host, String(finalPort), username, password ?? '', insecure ? 'insecure' : 'strict'].join('\n'))
    .digest('hex')
  const options: IClientOptions = {
    protocol: tls ? 'mqtts' : 'mqtt',
    host,
    port: finalPort,
    clean: true,
    keepalive: KEEPALIVE_SEC,
    // No automatic reconnect and no offline queue: see the note at the top of this file.
    reconnectPeriod: 0,
    queueQoSZero: false,
    resubscribe: false,
  }
  if (username) options.username = username
  if (username && password) options.password = password
  if (tls) options.rejectUnauthorized = !insecure
  return { key, label, host, hasLogin: username.length > 0, options }
}

function acquire(ctx: AdapterContext): BrokerLink {
  const target = brokerOf(ctx)
  let link = pool.get(target.key)
  if (!link) {
    link = new BrokerLink(target.key, target.label, target.host, target.hasLogin, target.options)
    pool.set(target.key, link)
  }
  link.refs += 1
  if (link.idleTimer) {
    clearTimeout(link.idleTimer)
    link.idleTimer = null
  }
  return link
}

function release(link: BrokerLink): void {
  link.refs = Math.max(0, link.refs - 1)
  if (link.refs > 0 || link.closed || link.idleTimer) return
  link.idleTimer = setTimeout(() => {
    link.idleTimer = null
    if (link.refs === 0) void link.close()
  }, idleCloseMs)
  link.idleTimer.unref?.()
}

/** Close every broker connection (hub shutdown, and between tests). */
export async function closeAllMqttClients(): Promise<void> {
  const links = [...pool.values()]
  pool.clear()
  remembered.clear()
  await Promise.all(links.map((l) => l.close()))
}

/** How many broker connections are being kept right now. */
export function mqttClientCount(): number {
  return pool.size
}

/** Test hook: how long an unused broker connection is kept before it is closed. */
export function setMqttIdleCloseMs(ms: number): void {
  idleCloseMs = ms
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface Reader {
  str(name: string, fallback?: string): string
  num(name: string, fallback?: number): number
  bool(name: string, fallback?: boolean): boolean
}

function rawReader(config: Record<string, unknown>): Reader {
  const blank = (v: unknown) => v === undefined || v === null || v === ''
  return {
    str: (name, fallback = '') => {
      const v = config[name]
      return v === undefined || v === null ? fallback : String(v)
    },
    num: (name, fallback = 0) => {
      const v = config[name]
      const n = Number(v)
      return Number.isFinite(n) && !blank(v) ? n : fallback
    },
    bool: (name, fallback = false) => {
      const v = config[name]
      if (blank(v)) return fallback
      return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
    },
  }
}

interface Settings {
  commandTopic: string
  stateTopic: string
  valuePath: string[]
  payloadOn: string
  payloadOff: string
  stateOn: string
  stateOff: string
  availabilityTopic: string
  payloadAvailable: string
  payloadNotAvailable: string
  brightnessCommandTopic: string
  brightnessCommandTemplate: string
  /** Where brightness is reported; falls back to the state topic when only a brightness item name is given. */
  brightnessStateTopic: string
  brightnessPath: string[]
  brightnessScale: number
  payloadOpen: string
  payloadClose: string
  payloadStop: string
  payloadPulse: string
  gateWords: Array<[GateState, string]>
  retain: boolean
  qos: Qos
}

/** "POWER", "state.power", "lights[0].on" or a Home Assistant style "{{ value_json.POWER }}" → path keys. */
function toPath(template: string): string[] {
  let t = template.trim()
  const braces = /^\{\{\s*(.*?)\s*\}\}$/.exec(t)
  if (braces) t = braces[1]!
  t = t.replace(/^value_json\b\.?/, '').replace(/^\$\.?/, '')
  t = t.replace(/\[\s*['"]?([^'"\]]+?)['"]?\s*\]/g, '.$1')
  return t
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * The word a device reports for on / off when the owner left that box empty. Normally the same
 * word as the command. When the command is a JSON message such as {"state":"ON"} (Zigbee2MQTT,
 * ESPHome lights) the report is read item by item, so the word is that item of the command.
 */
function reportWord(explicit: string, payload: string, path: string[], usual: string): string {
  if (explicit) return explicit
  const parsed = tryJson(payload)
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') return payload
  const item = path.length > 0 ? pick(payload, path) : undefined
  return item !== undefined && item !== null && typeof item !== 'object' ? String(item) : usual
}

function settings(r: Reader): Settings {
  const text = (name: string, fallback = '') => r.str(name, fallback).trim()
  const orDefault = (name: string, fallback: string) => text(name, fallback) || fallback
  const payloadOn = orDefault('payloadOn', 'ON')
  const payloadOff = orDefault('payloadOff', 'OFF')
  const stateTopic = text('stateTopic')
  const valuePath = toPath(text('valueTemplate'))
  // The hub writes a field's default back into an empty box when a device is saved, so these
  // three boxes have no default and "empty" carries the meaning by itself: with a step-button
  // message filled in, an empty box means "press the button"; without one, the usual word.
  const payloadPulse = text('payloadPulse')
  const gateMessage = (name: string, usual: string) => text(name) || (payloadPulse ? '' : usual)
  const brightnessPath = toPath(text('brightnessValueTemplate'))
  const template = text('brightnessCommandTemplate', '{value}')
  const scale = r.num('brightnessScale', 100)
  const qos = Math.round(r.num('qos', 1))
  return {
    commandTopic: text('commandTopic'),
    stateTopic,
    valuePath,
    payloadOn,
    payloadOff,
    stateOn: reportWord(text('stateOn'), payloadOn, valuePath, 'ON'),
    stateOff: reportWord(text('stateOff'), payloadOff, valuePath, 'OFF'),
    availabilityTopic: text('availabilityTopic'),
    payloadAvailable: orDefault('payloadAvailable', 'online'),
    payloadNotAvailable: orDefault('payloadNotAvailable', 'offline'),
    brightnessCommandTopic: text('brightnessCommandTopic'),
    brightnessCommandTemplate: template.includes('{value}') ? template : '{value}',
    brightnessStateTopic: text('brightnessStateTopic') || (brightnessPath.length > 0 ? stateTopic : ''),
    brightnessPath,
    brightnessScale: scale > 0 ? scale : 100,
    payloadOpen: gateMessage('payloadOpen', 'OPEN'),
    payloadClose: gateMessage('payloadClose', 'CLOSE'),
    payloadStop: gateMessage('payloadStop', 'STOP'),
    payloadPulse,
    gateWords: [
      ['open', orDefault('stateOpen', 'open')],
      ['closed', orDefault('stateClosed', 'closed')],
      ['opening', orDefault('stateOpening', 'opening')],
      ['closing', orDefault('stateClosing', 'closing')],
      ['stopped', orDefault('stateStopped', 'stopped')],
    ],
    retain: r.bool('retain', false),
    qos: qos === 0 || qos === 2 ? qos : 1,
  }
}

/** Every topic the hub listens on for this device, without repeats. */
function watchTopics(cfg: Settings): string[] {
  return [...new Set([cfg.stateTopic, cfg.brightnessStateTopic, cfg.availabilityTopic].filter(Boolean))]
}

// ---------------------------------------------------------------------------
// Reading messages
// ---------------------------------------------------------------------------

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const t = text.trim()
  if (!t) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(t) }
  } catch {
    return { ok: false }
  }
}

/**
 * The value a message carries. With no path: the text itself. With a path: that
 * item of the JSON message, or undefined when this message does not carry it
 * (Tasmota's RESULT topic reports many different things). A message that is not
 * JSON at all is taken as it stands.
 */
function pick(text: string, path: string[]): unknown {
  if (path.length === 0) return text.trim()
  const parsed = tryJson(text)
  // Not JSON, or a bare JSON word / number (ON, 1, true): there is nothing to look inside.
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') return text.trim()
  let cur: unknown = parsed.value
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    if (Array.isArray(cur)) {
      const i = Number(key)
      if (!Number.isInteger(i)) return undefined
      cur = cur[i]
    } else {
      const obj = cur as Record<string, unknown>
      if (Object.hasOwn(obj, key)) cur = obj[key]
      else {
        const loose = Object.keys(obj).filter((k) => k.toLowerCase() === key.toLowerCase())
        if (loose.length !== 1) return undefined
        cur = obj[loose[0]!]
      }
    }
    if (cur === undefined) return undefined
  }
  return cur
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Sensor readings: numbers as numbers, JSON as JSON, anything else as text. */
function reading(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const parsed = tryJson(value)
  return parsed.ok ? parsed.value : value
}

function isSwitchLike(kind: DeviceKind): boolean {
  return kind !== 'gate' && kind !== 'sensor'
}

/** Turn one message on one of the watched topics into the state keys the app understands. */
function parseMessage(cfg: Settings, kind: DeviceKind, filter: string, text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (filter === cfg.availabilityTopic) {
    // Zigbee2MQTT announces {"state":"online"} rather than the bare word: read that item too.
    const parsed = tryJson(text)
    const inner = parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>).state : undefined
    const words = typeof inner === 'string' || typeof inner === 'boolean' ? [text, String(inner)] : [text]
    if (words.some((w) => same(w, cfg.payloadAvailable))) out.available = true
    else if (words.some((w) => same(w, cfg.payloadNotAvailable))) out.available = false
  }
  if (filter === cfg.stateTopic) {
    const value = pick(text, cfg.valuePath)
    if (value !== undefined) {
      if (kind === 'gate') {
        const word = scalar(value)
        out.gate = cfg.gateWords.find(([, w]) => same(w, word))?.[0] ?? 'unknown'
      } else if (kind === 'sensor') {
        out.value = reading(value)
      } else {
        const word = scalar(value)
        if (same(word, cfg.stateOn)) out.power = true
        else if (same(word, cfg.stateOff)) out.power = false
      }
    }
  }
  if (filter === cfg.brightnessStateTopic && isSwitchLike(kind)) {
    const n = toNumber(pick(text, cfg.brightnessPath))
    if (n !== null) out.brightness = clamp(Math.round((n / cfg.brightnessScale) * 100), 0, 100)
  }
  return out
}

/**
 * What the hub last heard from, or told, each device. Only used to pick the
 * right message for "toggle" and for one-button gates; it is forgotten on restart.
 */
const remembered = new Map<string, Record<string, unknown>>()

function remember(deviceId: string, state: Record<string, unknown> | undefined): void {
  if (!state || Object.keys(state).length === 0) return
  remembered.set(deviceId, { ...remembered.get(deviceId), ...state })
}

interface Observer {
  signal: Signal
  /** What the latest messages on the watched topics say. */
  current(): Record<string, unknown>
  /** The raw latest message on one topic, if any arrived on this connection. */
  latest(filter: string): LastMessage | null
  /** Resolves once the broker has confirmed every subscription. */
  ready(ms: number): Promise<void>
  /**
   * Waits for the kept messages on these topics (all watched topics when none are named), but only
   * while one can still be on its way: at most `ms` after the broker confirmed the subscription.
   * A topic that has been listened to for a while costs no waiting at all.
   */
  settle(ms: number, only?: string[]): Promise<void>
  close(): void
}

function observe(
  link: BrokerLink,
  cfg: Settings,
  ctx: AdapterContext,
  topics: string[],
  onMessage?: (state: Record<string, unknown>, retained: boolean) => void,
): Observer {
  const kind = ctx.device.kind
  const signal = new Signal()
  const entries = topics.map((filter) => {
    const { watch, off } = link.watch(filter, cfg.qos, (_topic, text, retained) => {
      const state = parseMessage(cfg, kind, filter, text)
      remember(ctx.device.id, state)
      onMessage?.(state, retained)
      signal.fire()
    })
    return { filter, watch, off }
  })
  return {
    signal,
    current() {
      const out: Record<string, unknown> = {}
      for (const e of entries) if (e.watch.last) Object.assign(out, parseMessage(cfg, kind, e.filter, e.watch.last.text))
      return out
    },
    latest(filter) {
      return entries.find((e) => e.filter === filter)?.watch.last ?? null
    },
    async ready(ms) {
      try {
        await within(Promise.all(entries.map((e) => e.watch.granted ?? Promise.resolve())), ms, `The broker at ${link.label} did not answer when the hub started to listen`)
      } catch (err) {
        // A connection that stopped answering must not be handed to the next call as if it were fine.
        if (!(err instanceof BrokerRefusedError)) link.drop()
        throw err
      }
    },
    async settle(ms, only) {
      const wanted = entries.filter((e) => !only || only.includes(e.filter))
      const now = Date.now()
      const deadline = Math.max(now, ...wanted.filter((e) => !e.watch.last).map((e) => (e.watch.grantedAt ?? now) + ms))
      await until(signal, deadline, () => (wanted.every((e) => e.watch.last) ? true : undefined))
    },
    close() {
      for (const e of entries) e.off()
    },
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface Plan {
  topic: string
  payload: string
  retain: boolean
  /** A step-button press: sending it twice undoes it, so it is never repeated blindly. */
  pulse: boolean
  /** The right message depends on what the device is doing now. */
  needsCurrent: boolean
  /** The device reports back on a topic the hub listens to. */
  echo: boolean
  /** This report is about the thing the command changes. */
  concerns(state: Record<string, unknown>): boolean
  /** This report says the command took effect. */
  matches(state: Record<string, unknown>): boolean
  /** What the command asks for. Shown as the state only when the device has no way to report back. */
  assumed?: Record<string, unknown>
  /** Sentence for when the device reports something else instead. */
  mismatch(state: Record<string, unknown>): string
  result?: Record<string, unknown>
}

/**
 * A report topic can only prove a command when it is a different topic: a broker hands the hub's
 * own message straight back on a topic it listens to, and that must never pass for the device's answer.
 */
function hearsBack(reportTopic: string, commandTopic: string): boolean {
  return Boolean(reportTopic) && !topicMatches(reportTopic, commandTopic)
}

function refuse(error: string): ActionResult {
  return { ok: false, error }
}

function isResult(x: Plan | ActionResult): x is ActionResult {
  return 'ok' in x
}

function plan(cfg: Settings, kind: DeviceKind, action: Action, current: Record<string, unknown>): Plan | ActionResult {
  const p = action.params ?? {}
  const needTopic = (topic: string, what: string): string | null => {
    if (!topic) return `No ${what} is set for this device`
    if (hasWildcard(topic)) return `The ${what} cannot contain + or #`
    return null
  }

  switch (action.type) {
    case 'power.on':
    case 'power.off':
    case 'power.toggle': {
      if (!isSwitchLike(kind)) return unsupported(action)
      const bad = needTopic(cfg.commandTopic, 'command topic')
      if (bad) return refuse(bad)
      const target = action.type === 'power.toggle' ? current.power !== true : action.type === 'power.on'
      return {
        topic: cfg.commandTopic,
        payload: target ? cfg.payloadOn : cfg.payloadOff,
        retain: cfg.retain,
        pulse: false,
        needsCurrent: action.type === 'power.toggle',
        echo: hearsBack(cfg.stateTopic, cfg.commandTopic),
        concerns: (s) => typeof s.power === 'boolean',
        matches: (s) => s.power === target,
        assumed: { power: target },
        mismatch: (s) => `The device answered, but reports it is still ${s.power ? 'on' : 'off'}`,
      }
    }
    case 'dim.set': {
      if (!isSwitchLike(kind) || !cfg.brightnessCommandTopic) return unsupported(action)
      const bad = needTopic(cfg.brightnessCommandTopic, 'brightness command topic')
      if (bad) return refuse(bad)
      const asked = toNumber(p.brightness)
      if (asked === null) return refuse('No brightness was given')
      const percent = clamp(Math.round(asked), 0, 100)
      const value = Math.round((percent / 100) * cfg.brightnessScale)
      return {
        topic: cfg.brightnessCommandTopic,
        payload: cfg.brightnessCommandTemplate.split('{value}').join(String(value)),
        retain: cfg.retain,
        pulse: false,
        needsCurrent: false,
        echo: hearsBack(cfg.brightnessStateTopic, cfg.brightnessCommandTopic),
        concerns: (s) => typeof s.brightness === 'number',
        // Lights round and clamp (minimum brightness), so any brightness report counts and is shown as reported.
        matches: (s) => typeof s.brightness === 'number',
        assumed: { brightness: percent },
        mismatch: () => 'The device answered, but did not report its brightness',
      }
    }
    case 'gate.open':
    case 'gate.close':
    case 'gate.stop':
    case 'gate.pulse': {
      if (kind !== 'gate') return unsupported(action)
      const bad = needTopic(cfg.commandTopic, 'command topic')
      if (bad) return refuse(bad)
      const gate = typeof current.gate === 'string' ? (current.gate as GateState) : 'unknown'
      const hasGate = (s: Record<string, unknown>) => typeof s.gate === 'string'
      const base = {
        topic: cfg.commandTopic,
        // A kept command would be replayed every time the gate box reconnects.
        retain: false,
        echo: hearsBack(cfg.stateTopic, cfg.commandTopic),
        concerns: hasGate,
        mismatch: (s: Record<string, unknown>) => `The gate answered, but reports it is ${String(s.gate)}`,
      }
      if (action.type === 'gate.pulse') {
        if (!cfg.payloadPulse) return refuse('This gate has no step-button message filled in, so there is no single press to send')
        return { ...base, payload: cfg.payloadPulse, pulse: true, needsCurrent: false, matches: hasGate }
      }
      if (action.type === 'gate.stop') {
        if (cfg.payloadStop) return { ...base, payload: cfg.payloadStop, pulse: false, needsCurrent: false, matches: hasGate }
        if (!cfg.payloadPulse) return refuse('No stop message is set for this gate')
        // One-button gates stop on a press while moving; a press at rest would start them instead.
        if (gate !== 'opening' && gate !== 'closing') {
          return refuse(
            cfg.stateTopic
              ? 'The gate is not moving, and a press of its one button would start it instead of stopping it'
              : 'This gate has one button and does not report whether it is moving, so the hub cannot safely send Stop',
          )
        }
        return { ...base, payload: cfg.payloadPulse, pulse: true, needsCurrent: true, matches: hasGate, result: { via: 'pulse' } }
      }
      const opening = action.type === 'gate.open'
      const goal: GateState[] = opening ? ['open', 'opening'] : ['closed', 'closing']
      const matches = (s: Record<string, unknown>) => goal.includes(s.gate as GateState)
      const explicit = opening ? cfg.payloadOpen : cfg.payloadClose
      if (explicit) return { ...base, payload: explicit, pulse: false, needsCurrent: false, matches }
      if (!cfg.payloadPulse) return refuse(`No ${opening ? 'open' : 'close'} message is set for this gate`)
      // One-button gate: a press when it is already there would move it the other way.
      if (goal.includes(gate)) return { ok: true, state: { gate }, result: { alreadyThere: true } }
      return { ...base, payload: cfg.payloadPulse, pulse: true, needsCurrent: true, matches, result: { via: 'pulse' } }
    }
    case 'custom': {
      const topic = typeof p.topic === 'string' && p.topic.trim() ? p.topic.trim() : cfg.commandTopic
      const bad = needTopic(topic, 'topic')
      if (bad) return refuse(bad)
      if (p.payload === undefined || p.payload === null) return refuse('A custom command needs a "payload" (the message to send)')
      return {
        topic,
        payload: typeof p.payload === 'object' ? JSON.stringify(p.payload) : String(p.payload),
        retain: p.retain === true && kind !== 'gate',
        pulse: true,
        needsCurrent: false,
        echo: false,
        concerns: () => false,
        matches: () => false,
        mismatch: () => '',
        result: { topic },
      }
    }
    default:
      return unsupported(action)
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const adapter: Adapter = {
  family: 'mqtt',

  describe(): FamilyDescriptor {
    return {
      id: 'mqtt',
      label: 'MQTT device',
      tagline: 'Lights, switches, gates and sensors that talk through an MQTT broker: Tasmota, ESPHome, Zigbee2MQTT, Shelly, home-made relays.',
      kinds: ['light', 'switch', 'gate', 'sensor'],
      fields: [
        {
          name: 'commandTopic',
          label: 'Command topic',
          type: 'text',
          help: 'The topic (the "address" inside the broker) the device listens on for commands. Tasmota: cmnd/porch/POWER. Zigbee2MQTT: zigbee2mqtt/porch/set. Leave empty for a sensor.',
        },
        {
          name: 'stateTopic',
          label: 'State topic',
          type: 'text',
          help: 'The topic where the device reports what it is doing. Tasmota: stat/porch/POWER. It must be a different topic from the command topic. Leave empty if the device never reports back; the hub then shows what it asked for, not what was confirmed.',
        },
        {
          name: 'valueTemplate',
          label: 'Item to read from the report',
          type: 'text',
          help: 'Only for devices that report in JSON, a message that looks like {"POWER":"ON"}. Write the name of the item, here POWER. For an item inside another, join the names with a dot, for example state.power. Leave empty when the report is a single word such as ON.',
        },
        { name: 'payloadOn', label: 'Message that turns it on', type: 'text', default: 'ON', help: 'Sent to the command topic. Zigbee2MQTT wants {"state":"ON"}.' },
        { name: 'payloadOff', label: 'Message that turns it off', type: 'text', default: 'OFF', help: 'Sent to the command topic. Zigbee2MQTT wants {"state":"OFF"}.' },
        { name: 'stateOn', label: 'Report that means on', type: 'text', help: 'Leave empty if the device reports with the same word as the on message. Capital letters do not matter. Shelly Gen2 and newer report true.' },
        { name: 'stateOff', label: 'Report that means off', type: 'text', help: 'Leave empty if the device reports with the same word as the off message. Shelly Gen2 and newer report false.' },
        {
          name: 'availabilityTopic',
          label: 'Availability topic',
          type: 'text',
          help: 'Optional but worth filling in. The topic where the device announces that it is connected, and where the broker announces when it drops off. Tasmota: tele/porch/LWT. Shelly: shellies/<name>/online. The device must publish this as a kept ("retained") message; Tasmota, ESPHome, Shelly and Zigbee2MQTT all do.',
        },
        { name: 'payloadAvailable', label: 'Announcement that means connected', type: 'text', default: 'online', help: 'Tasmota says Online, Shelly says true, Zigbee2MQTT says {"state":"online"} (online is enough for that one). Capital letters do not matter.' },
        { name: 'payloadNotAvailable', label: 'Announcement that means disconnected', type: 'text', default: 'offline', help: 'Tasmota says Offline, Shelly says false.' },
        {
          name: 'brightnessCommandTopic',
          label: 'Brightness command topic',
          type: 'text',
          help: 'Lights that can be dimmed only. Tasmota: cmnd/porch/Dimmer. Leave empty for a plain on/off light.',
        },
        {
          name: 'brightnessCommandTemplate',
          label: 'Brightness message',
          type: 'text',
          default: '{value}',
          help: 'What is sent to set the brightness; {value} is replaced by the number. Zigbee2MQTT wants {"brightness":{value}}.',
        },
        {
          name: 'brightnessStateTopic',
          label: 'Brightness report topic',
          type: 'text',
          help: 'Where the light reports its brightness. Tasmota: stat/porch/RESULT. Leave empty if it is reported on the state topic above.',
        },
        {
          name: 'brightnessValueTemplate',
          label: 'Brightness item in the report',
          type: 'text',
          help: 'For JSON reports: the name of the brightness item. Tasmota: Dimmer. Zigbee2MQTT: brightness. Leave empty when the report is just a number.',
        },
        {
          name: 'brightnessScale',
          label: 'Number the device uses for full brightness',
          type: 'number',
          default: 100,
          help: '100 for Tasmota. 254 for Zigbee2MQTT. 255 for many home-made dimmers. The app always shows 0 to 100 %.',
        },
        { name: 'payloadOpen', label: 'Gate: message that opens it', type: 'text', help: 'Gates only. Left empty, the hub sends OPEN. If the gate has a single step button, leave this empty and fill in the step-button message below; Open is then one press of that button.' },
        { name: 'payloadClose', label: 'Gate: message that closes it', type: 'text', help: 'Gates only. Left empty, the hub sends CLOSE. Leave it empty for a single-button gate.' },
        { name: 'payloadStop', label: 'Gate: message that stops it', type: 'text', help: 'Gates only. Left empty, the hub sends STOP. Leave it empty for a single-button gate.' },
        {
          name: 'payloadPulse',
          label: 'Gate: message for one press of the step button',
          type: 'text',
          help: 'For gate motors and garage doors with one button that goes open, stop, close in turn. For a Tasmota relay wired to that button this is ON (set PulseTime on the relay so it lets go again). When this is filled in and the three boxes above are empty, Open, Close and Stop are all done with presses of this button.',
        },
        { name: 'stateOpen', label: 'Gate: report that means open', type: 'text', default: 'open' },
        { name: 'stateClosed', label: 'Gate: report that means closed', type: 'text', default: 'closed' },
        { name: 'stateOpening', label: 'Gate: report that means opening', type: 'text', default: 'opening' },
        { name: 'stateClosing', label: 'Gate: report that means closing', type: 'text', default: 'closing' },
        { name: 'stateStopped', label: 'Gate: report that means stopped part-way', type: 'text', default: 'stopped' },
        { name: 'username', label: 'Broker username', type: 'text', help: 'The login for the broker, not for the device. Leave empty if the broker has no login.' },
        { name: 'password', label: 'Broker password', type: 'password', secret: true, help: 'Stored encrypted on the hub.' },
        {
          name: 'tls',
          label: 'Secure connection (TLS)',
          type: 'toggle',
          default: false,
          help: `Turn on for a broker on the internet, and set the port of that connection to ${DEFAULT_TLS_PORT}, where secure brokers usually listen (a house WiFi connection is filled in with ${DEFAULT_PORT}, the port for plain connections). A connection whose port is ${DEFAULT_TLS_PORT} is always made secure; one with no port uses ${DEFAULT_TLS_PORT} when this is on and ${DEFAULT_PORT} when it is off.`,
        },
        {
          name: 'tlsInsecure',
          label: 'Accept a self-made certificate',
          type: 'toggle',
          default: false,
          showWhen: { field: 'tls', equals: true },
          help: 'Only for your own broker whose security certificate you made yourself. The connection is still encrypted, but the hub no longer checks that it is talking to the right broker.',
        },
        {
          name: 'retain',
          label: 'Ask the broker to keep the last command',
          type: 'toggle',
          default: false,
          help: 'Leave off unless you know you need it. A kept command is delivered again every time the device reconnects; Tasmota in particular must not get kept commands. Never used for gate commands.',
        },
        {
          name: 'qos',
          label: 'Delivery care (QoS)',
          type: 'select',
          default: '1',
          options: [
            { value: '0', label: '0 - send once, no confirmation' },
            { value: '1', label: '1 - the broker confirms it got the message (recommended)' },
            { value: '2', label: '2 - confirmed exactly once (few devices support it)' },
          ],
        },
      ],
      pathKinds: ['lan', 'cloud'],
      defaultPort: DEFAULT_PORT,
      capabilities: ['power', 'dim', 'gate', 'gate-state', 'state'],
      notes: [
        'MQTT devices do not talk to the hub directly. The device and the hub both connect to a "broker", a small message-passing program (Mosquitto is the usual one). The address on each connection below is the address of the broker, not of the device.',
        'This is the one arrangement that works for a relay on its own SIM card: Indian mobile networks do not let anything connect in to a SIM, but the relay can dial out to a broker on the internet and the hub meets it there. Add that broker as a "Cloud" connection with the secure connection turned on.',
        'Fill in the availability topic if the device has one. Without it the hub can only tell that the broker is answering, not whether the device itself is switched on.',
        'Without a state topic the hub cannot hear back from the device, so after a command it shows what it asked for. With a state topic, a light or switch command counts as done only when the device reports back; if it stays silent the app asks you to look and confirm.',
        'After the hub restarts it only knows what the broker has kept. For a Tasmota device, type PowerRetain 1 in its console so its last on/off report is kept.',
        'Shelly: on the older (Gen1) models, switching MQTT on switches the Shelly cloud off, so the Shelly app stops working away from home. On Gen2 and newer, the MQTT settings page has two more switches that must be on: status updates over MQTT (called status_ntf) and MQTT control (enable_control). Without them the device stays silent and ignores commands.',
        'A gate motor or garage door with a single step button: leave the open, close and stop messages empty and fill in only the step-button message. Open and Close then each send one press. If the gate does not report its position, the hub cannot know which way that press will move it.',
        'Changing colour, restarting the device and moving it to another WiFi network cannot be done through this kind of connection. Use the device’s own app or web page for those.',
        'A Mosquitto 2 broker refuses every other machine until its settings file has "listener 1883" and a password file, and Windows Firewall must allow port 1883.',
      ],
    }
  },

  capabilities(config: Record<string, unknown>, kind: DeviceKind): Capability[] {
    const cfg = settings(rawReader(config))
    const caps: Capability[] = []
    if (kind === 'gate') {
      if (cfg.commandTopic) caps.push('gate')
      if (cfg.stateTopic) caps.push('gate-state')
    } else if (kind !== 'sensor') {
      if (cfg.commandTopic) caps.push('power')
      if (cfg.brightnessCommandTopic) caps.push('dim')
    }
    if (cfg.stateTopic || (cfg.brightnessStateTopic && isSwitchLike(kind))) caps.push('state')
    return caps
  },

  async probe(ctx): Promise<ProbeResult> {
    const started = Date.now()
    const deadline = started + ctx.timeoutMs
    const left = () => deadline - Date.now()
    const down = (error: string): ProbeResult => ({ ok: false, latencyMs: null, error })
    let link: BrokerLink
    try {
      link = acquire(ctx)
    } catch (err) {
      return down(errorText(err))
    }
    let obs: Observer | null = null
    try {
      const reused = link.connected
      await link.connect(left())
      if (reused) {
        // A kept-open connection can look alive after the broker has gone: make one round trip.
        try {
          await link.ping(Math.min(2000, Math.max(200, left() / 2)))
        } catch {
          link.drop()
          await link.connect(left())
        }
      }
      const latencyMs = Date.now() - started
      const cfg = settings(ctx)
      if (!cfg.availabilityTopic) return { ok: true, latencyMs }

      obs = observe(link, cfg, ctx, [cfg.availabilityTopic])
      await obs.ready(left())
      await obs.settle(Math.max(0, Math.min(AVAILABILITY_WAIT_MS, left() - 50)))
      const said = obs.latest(cfg.availabilityTopic)
      if (!said) {
        return down(`The broker answered, but the device has not announced itself on "${cfg.availabilityTopic}". It may never have connected to this broker, or the topic name is different.`)
      }
      const available = obs.current().available
      if (available === true) return { ok: true, latencyMs, info: { available: true } }
      if (available === false) return down('The device is offline: it has lost its connection to the broker')
      return down(
        `The device announced "${said.text.trim().slice(0, 40)}" on "${cfg.availabilityTopic}", which is neither "${cfg.payloadAvailable}" nor "${cfg.payloadNotAvailable}". Check the two announcement words.`,
      )
    } catch (err) {
      return down(errorText(err))
    } finally {
      obs?.close()
      release(link)
    }
  },

  async readState(ctx): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ctx.timeoutMs - 200
    const left = () => deadline - Date.now()
    const cfg = settings(ctx)
    const topics = watchTopics(cfg)
    if (topics.length === 0) return {}
    const link = acquire(ctx)
    let obs: Observer | null = null
    try {
      await link.connect(left())
      obs = observe(link, cfg, ctx, topics)
      await obs.ready(left())
      await obs.settle(Math.max(0, Math.min(RETAINED_WAIT_MS, left() - 100)))
      return obs.current()
    } finally {
      obs?.close()
      release(link)
    }
  },

  async execute(ctx, action: Action): Promise<ActionResult> {
    const cfg = settings(ctx)
    const kind = ctx.device.kind
    const id = ctx.device.id
    // Refuse what can never work before touching the broker.
    const early = plan(cfg, kind, action, remembered.get(id) ?? {})
    if (isResult(early) && !early.ok) return early
    const needsCurrent = !isResult(early) && early.needsCurrent

    // The hub allows a command twice the device timeout.
    const deadline = Date.now() + ctx.timeoutMs * 2 - 300
    const left = () => deadline - Date.now()
    const link = acquire(ctx)
    const seen: Array<{ state: Record<string, unknown>; retained: boolean }> = []
    let obs: Observer | null = null
    try {
      await link.connect(Math.min(ctx.timeoutMs, left()))
      // Listen BEFORE sending, so a quick report cannot slip past.
      obs = observe(link, cfg, ctx, watchTopics(cfg), (state, retained) => seen.push({ state, retained }))
      await obs.ready(Math.min(ctx.timeoutMs, left()))
      // Only wait for what the decision below needs: is the device there, and (for toggle and
      // one-button gates) what is it doing now.
      const needed = [cfg.availabilityTopic, needsCurrent || isResult(early) ? cfg.stateTopic : ''].filter(Boolean)
      if (needed.length > 0) await obs.settle(Math.max(0, Math.min(RETAINED_WAIT_MS, left())), needed)

      const heard = obs.current()
      if (cfg.availabilityTopic && heard.available === false) {
        // Thrown, not returned: another connection (another broker) may still reach the device.
        throw new Error(`${ctx.device.name} is offline: it has lost its connection to the broker at ${link.label}`)
      }
      const next = plan(cfg, kind, action, { ...remembered.get(id), ...heard })
      if (isResult(next)) return next

      // The hub stops waiting at twice the device timeout and may then try another connection. A
      // command must never go out so late that its confirmation could arrive after that moment.
      if (left() < Math.min(500, ctx.timeoutMs / 4)) {
        throw new Error(`The broker at ${link.label} answered too slowly, so the command was not sent`)
      }
      const mark = seen.length
      try {
        await link.publish(next.topic, next.payload, { qos: cfg.qos, retain: next.retain }, Math.min(ctx.timeoutMs, Math.max(100, left() - 200)))
      } catch (err) {
        if (next.pulse && err instanceof UnconfirmedError) {
          // Not thrown: the hub would send it again on another connection, and a second press undoes the first.
          return refuse(`${err.message}. It may or may not have gone through, so look before trying again.`)
        }
        throw err
      }

      if (!next.echo) {
        remember(id, next.assumed)
        return { ok: true, state: next.assumed, result: { ...next.result, confirmed: false } }
      }
      const echoMs = Math.max(100, Math.min(ECHO_WAIT_MAX_MS, ctx.timeoutMs / 2, left() - 100))
      // Kept messages are replays of the past; only a fresh report counts as the answer.
      const fresh = () => seen.slice(mark).filter((r) => !r.retained)
      const hit = await until(obs.signal, Date.now() + echoMs, () => fresh().find((r) => next.matches(r.state)))
      if (hit) return { ok: true, state: hit.state, result: { ...next.result, confirmed: true } }
      const other = fresh()
        .filter((r) => next.concerns(r.state))
        .pop()
      if (other) return { ok: false, error: next.mismatch(other.state), state: other.state }

      // A device that normally reports back stayed silent. Never show the wished-for state as fact.
      if (kind === 'gate') {
        // Gates take their time, and many report only at the end of the travel. The hub keeps
        // reading the gate's own reports after a gate command, so the outcome is settled there.
        return { ok: true, result: { ...next.result, confirmed: false, note: 'Sent, but the gate has not reported back yet.' } }
      }
      const lastReport = obs.current()
      const wanted = Object.entries(next.assumed ?? {})
      if (wanted.length > 0 && wanted.every(([key, value]) => lastReport[key] === value)) {
        // Some devices (ESPHome, Shelly) say nothing when asked for what they are already doing.
        return {
          ok: true,
          state: next.assumed,
          result: { ...next.result, confirmed: false, note: 'The device did not report back, but its last report already said this.' },
        }
      }
      return {
        ok: true,
        needsConfirmation: true,
        result: {
          ...next.result,
          confirmed: false,
          note: `The command was sent, but the device did not report back in time, so the hub cannot tell whether it worked. Look at the device, then confirm.`,
        },
      }
    } catch (err) {
      if (err instanceof BrokerRefusedError) return refuse(err.message)
      throw err
    } finally {
      obs?.close()
      release(link)
    }
  },

  async subscribe(ctx, onState): Promise<() => void> {
    const cfg = settings(ctx)
    const topics = watchTopics(cfg)
    if (topics.length === 0) return () => undefined
    const link = acquire(ctx)
    link.holders += 1
    let live = true
    const push = (state: Record<string, unknown>) => {
      if (live && Object.keys(state).length > 0) onState(state)
    }
    const obs = observe(link, cfg, ctx, topics, push)
    // Another device may already be listening on the same topic: hand over what is known.
    const known = obs.current()
    if (Object.keys(known).length > 0) queueMicrotask(() => push(known))
    try {
      await link.connect(ctx.timeoutMs)
      await obs.ready(ctx.timeoutMs)
    } catch (err) {
      // Keep the listeners: the link reconnects on its own and re-subscribes.
      ctx.log.warn(`MQTT: not listening yet, will keep trying (${errorText(err)})`)
      link.keepTrying()
    }
    return () => {
      if (!live) return
      live = false
      obs.close()
      link.holders = Math.max(0, link.holders - 1)
      release(link)
    }
  },
}

export default adapter
