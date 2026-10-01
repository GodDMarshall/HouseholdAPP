/**
 * Tuya / Smart Life devices controlled inside the house, over the LAN protocol
 * on TCP 6668 (through the "tuyapi" package). Needs the device id, its local
 * key and the protocol version; no internet and no Tuya account at run time.
 *
 * Things that shape this file:
 *  - A Tuya device accepts ONE local connection. Every call for a device goes
 *    through a single short-lived connection that is shared by calls arriving
 *    close together, used strictly one request at a time, and closed after a
 *    few idle seconds so the Smart Life app is not locked out.
 *  - A device only reports a status when a value really changes, so the hub
 *    reads first, sends only what differs, and when no confirmation arrives it
 *    looks at the device again before calling the command failed.
 *  - tuyapi has no timeout on reads, emits 'error' events that would crash the
 *    process when nobody listens, never settles connect() when a 3.4 / 3.5
 *    sign-in fails, and throws inside its own socket handler on a sign-in
 *    reply it cannot decrypt. All four are handled here.
 *  - The local key never appears in a log line, an error or a result.
 */
import crypto from 'node:crypto'
import TuyAPI from 'tuyapi'
import type { Action, Capability, DeviceKind, FamilyDescriptor, GateState } from '@house/shared'
import { sleep } from '../lib/http.ts'
import { clamp, requireHost, unsupported, type ActionResult, type Adapter, type AdapterContext, type ProbeResult } from './types.ts'

// ---------------------------------------------------------------------------
// The part of tuyapi this adapter uses
// ---------------------------------------------------------------------------

type DpValue = boolean | number | string | null
/** Data points as the device reports them: { "1": true, "9": 0 } or { "20": true, "22": 500 }. */
type Dps = Record<string, unknown>

type TuyaSetOptions = { dps: number; set: DpValue } | { multiple: true; data: Record<string, DpValue> }

interface TuyaSocket {
  destroy?: () => void
  once?: (event: 'connect' | 'close', listener: () => void) => unknown
  connecting?: boolean
  destroyed?: boolean
}

interface TuyaClient {
  connect(): Promise<boolean>
  disconnect(): void
  isConnected(): boolean
  get(options: { schema: true; dps?: number }): Promise<unknown>
  set(options: TuyaSetOptions): Promise<unknown>
  on(event: 'error' | 'connected' | 'disconnected', listener: (arg?: unknown) => void): unknown
  /** tuyapi's socket. Watched for "accepted" and "closed", and closed by hand when a connection is given up. */
  client?: TuyaSocket
  /** tuyapi's own packet dispatcher. Wrapped (see open()) so a packet it chokes on cannot stop the hub. */
  _packetHandler?: (packet: unknown) => void
}

const DEFAULT_PORT = 6668
const VERSIONS = ['3.3', '3.4', '3.5', '3.1']
/** Close the connection this long after the last call, so the device's single slot is free again. */
const IDLE_CLOSE_MS = 3000
/** A reading this fresh is reused, so the check + state read of one round costs one request. */
const FRESH_MS = 1500
const MIN_STEP_MS = 250
/** A device on the same network confirms a command within a fraction of a second; after this long it will not. */
const CONFIRM_WAIT_MS = 2500
/** Pause between closing a connection and opening the next, so the device has freed its single slot. */
const REOPEN_PAUSE_MS = 150
/** A device that turns the hub away just after the hub closed its last connection gets one more try, this much later. */
const REOPEN_RETRY_MS = 600
const REOPEN_RETRY_WITHIN_MS = 2500
/** Time allowed for letting go of a gate relay, whatever happened to the rest of the command. */
const RELEASE_BUDGET_MS = 4000
/** Longest gate button press. Keeps a whole press, slow confirmations included, inside the time the hub allows one command. */
const MAX_PULSE_MS = 5000

const WRONG_KEY =
  'The device did not accept the local key. Check the key and the protocol version. The key changes whenever the device is paired again in Smart Life'
const UNREADABLE =
  'The device answered, but the hub could not read the reply. The local key or the protocol version is not right for this device'
const KEY_LENGTH = 'The local key must be exactly 16 characters. Copy it again from your key list'

/** The device (or its settings) said no. Reported to the owner as it is; trying another connection will not help. */
class DeviceRefusal extends Error {}
/** The device sent something, but not anything the hub could read. */
class Unreadable extends DeviceRefusal {}
/** The device was reached and asked, and stayed as it was. */
class Unchanged extends DeviceRefusal {}
/** The device took the connection but never answered a request. */
class Silence extends Error {}
/** The device would not take (or keep) a connection: refused or reset. */
class TurnedAway extends Error {}
class TimedOut extends Error {}
/** The connection was closed while the hub was waiting on it. */
class HungUp extends Error {}

/** What the hub has seen on one connection. */
interface Wire {
  /** 'signin' until tuyapi reports the connection ready. */
  phase: 'signin' | 'ready'
  /** The device accepted the TCP connection. */
  tcpUp: boolean
  /** The device sent something the hub could not read; 'key' = it failed the key check. */
  unreadable: 'key' | 'reply' | null
  /** Set while the sign-in or a request is being waited for: ends that wait early. */
  cut: ((why: Error) => void) | null
}

const wires = new WeakMap<object, Wire>()

function wireOf(dev: TuyaClient): Wire {
  let wire = wires.get(dev)
  if (!wire) {
    wire = { phase: 'signin', tcpUp: false, unreadable: null, cut: null }
    wires.set(dev, wire)
  }
  return wire
}

/** Run after the promise reactions already queued, so a failure with a cause is reported by its cause. */
function soon(fn: () => void): void {
  queueMicrotask(() => queueMicrotask(fn))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface Settings {
  host: string
  port: number
  id: string
  key: string
  version: string
  /** Data point of the on/off value; null = work it out from what the device reports. */
  switchDp: number | null
  /** Used when the device's reply does not settle it: 20 on bulbs, 1 on everything else. */
  usualSwitchDp: number
  dimmer: boolean
  dimDp: number | null
  dimMin: number
  dimMax: number
  /** null when the device is not a gate. */
  gate: 'pulse' | 'hold' | null
  pulseMs: number
}

function flag(v: unknown, fallback = false): boolean {
  if (v === undefined || v === null || v === '') return fallback
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
}

function gateModeOf(config: Record<string, unknown>): 'pulse' | 'hold' {
  return String(config.gateMode ?? 'pulse') === 'hold' ? 'hold' : 'pulse'
}

function dpNumber(ctx: AdapterContext, name: string): number | null {
  const n = ctx.num(name, 0)
  return Number.isInteger(n) && n >= 1 && n <= 255 ? n : null
}

function settings(ctx: AdapterContext): Settings {
  const host = requireHost(ctx)
  const id = ctx.str('deviceId').trim()
  if (!id) throw new DeviceRefusal('No Device ID is set for this device')
  const key = (ctx.secret('localKey') ?? '').trim()
  if (!key) throw new DeviceRefusal('No local key is set for this device')
  if (key.length !== 16) throw new DeviceRefusal(KEY_LENGTH)
  const version = ctx.str('version', '3.3').trim()
  let dimMin = Math.round(ctx.num('dimMin', 10))
  let dimMax = Math.round(ctx.num('dimMax', 1000))
  if (!(dimMin >= 0 && dimMax > dimMin)) {
    dimMin = 10
    dimMax = 1000
  }
  const kind = ctx.device.kind
  return {
    host,
    port: ctx.path.port ?? DEFAULT_PORT,
    id,
    key,
    version: VERSIONS.includes(version) ? version : '3.3',
    switchDp: dpNumber(ctx, 'switchDp'),
    usualSwitchDp: kind === 'light' ? 20 : 1,
    dimmer: kind !== 'gate' && ctx.bool('dimmer', false),
    dimDp: dpNumber(ctx, 'dimDp'),
    dimMin,
    dimMax,
    gate: kind === 'gate' ? gateModeOf(ctx.device.config) : null,
    pulseMs: clamp(Math.round(ctx.num('pulseMs', 1000)), 100, MAX_PULSE_MS),
  }
}

// ---------------------------------------------------------------------------
// One shared, short-lived connection per device
// ---------------------------------------------------------------------------

interface Link {
  id: string
  dev: TuyaClient | null
  /** Calls run one after another on this chain. */
  tail: Promise<unknown>
  users: number
  idleTimer: NodeJS.Timeout | null
  seen: { at: number; dps: Dps } | null
  /** When the last connection was closed from this side. */
  closedAt: number
}

const links = new Map<string, Link>()
/** Connections we have given up on: if one still completes later, it is closed at once. */
const retired = new WeakSet<object>()

function linkFor(s: Settings): Link {
  // Hashed so the local key is never used as a readable map key.
  const id = crypto.createHash('sha256').update([s.host, s.port, s.id, s.version, s.key].join('\n')).digest('hex')
  let link = links.get(id)
  if (!link) {
    link = { id, dev: null, tail: Promise.resolve(), users: 0, idleTimer: null, seen: null, closedAt: 0 }
    links.set(id, link)
  }
  return link
}

/** Close a connection the hub no longer wants, whatever state tuyapi thinks it is in. */
function drop(dev: TuyaClient): void {
  retired.add(dev)
  try {
    dev.disconnect()
  } catch {
    /* already gone */
  }
  try {
    // disconnect() does nothing while a connection is still being set up; close the socket itself too.
    dev.client?.destroy?.()
  } catch {
    /* already gone */
  }
}

function hangUp(link: Link): void {
  const dev = link.dev
  link.dev = null
  link.seen = null
  if (!dev) return
  link.closedAt = Date.now()
  drop(dev)
}

/** Give up on `dev`, whether or not the link still holds it (the device may have closed it first). */
function giveUp(link: Link, dev: TuyaClient): void {
  if (link.dev === dev) hangUp(link)
  else drop(dev)
}

/** Run a job on the device's connection, after any job already under way for the same device. */
function use<T>(s: Settings, job: (link: Link) => Promise<T>): Promise<T> {
  const link = linkFor(s)
  link.users += 1
  if (link.idleTimer) {
    clearTimeout(link.idleTimer)
    link.idleTimer = null
  }
  const run = link.tail.then(() => job(link))
  link.tail = run
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      link.users -= 1
      if (link.users > 0) return
      link.idleTimer = setTimeout(() => {
        link.idleTimer = null
        if (link.users > 0) return
        // The (now empty) entry stays, so a call arriving right after this still knows when the connection was closed.
        hangUp(link)
      }, IDLE_CLOSE_MS)
      link.idleTimer.unref?.()
    })
  return run
}

/** Close every open Tuya connection now (hub shutdown, tests). */
export function closeTuyaLinks(): void {
  for (const link of links.values()) {
    if (link.idleTimer) clearTimeout(link.idleTimer)
    link.idleTimer = null
    hangUp(link)
  }
  links.clear()
}

interface Budget {
  /** Milliseconds the next device request may take. */
  left(): number
}

function budget(totalMs: number, stepMs: number): Budget {
  const end = Date.now() + Math.max(totalMs, MIN_STEP_MS)
  return { left: () => Math.max(MIN_STEP_MS, Math.min(stepMs, end - Date.now())) }
}

/**
 * Wait for the sign-in or for one answer: until it arrives, the time is up, or
 * the connection is closed or proves unusable (wire.cut).
 */
function waitFor<T>(wire: Wire, p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cut = (why: Error) => {
      clearTimeout(t)
      if (wire.cut === cut) wire.cut = null
      reject(why)
    }
    const t = setTimeout(() => cut(new TimedOut('timed out')), ms)
    wire.cut = cut
    // Each request is judged by what comes back for it, not by an earlier stray packet.
    if (wire.phase === 'ready') wire.unreadable = null
    p.then(
      (v) => {
        clearTimeout(t)
        if (wire.cut === cut) wire.cut = null
        resolve(v)
      },
      (e: unknown) => cut(e instanceof Error ? e : new Error(typeof e === 'string' ? e : 'failed')),
    )
  })
}

const KEY_OR_APP = "The local key or protocol version may be wrong, or another app (Smart Life on this WiFi) is using the device's only local connection"

/**
 * Turn whatever tuyapi or the socket threw into one plain sentence. The original
 * text is never passed on: it can contain key-derived bytes.
 */
function explain(err: unknown, s: Settings, phase: 'connect' | 'answer', wire: Wire | null = null): Error {
  if (err instanceof DeviceRefusal || err instanceof Silence || err instanceof TurnedAway) return err
  const where = `${s.host}:${s.port}`
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const ownCode = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  const code = typeof ownCode === 'string' ? ownCode : (/\b(E[A-Z]{5,})\b/.exec(text)?.[1] ?? '')
  if (/HMAC mismatch/i.test(text) || wire?.unreadable === 'key') return new DeviceRefusal(WRONG_KEY)
  if (code === 'ECONNREFUSED') {
    return new TurnedAway(`${where} refused the connection. Check the address; if it is right, another app may be using the device's only local connection`)
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new Error(`${s.host} is not reachable from this network`)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error(`${s.host} could not be found on the network`)
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return new TurnedAway(`${where} closed the connection. Another app may be using the device's only local connection`)
  }
  // Something did come back, just nothing the hub could read: say that rather than "no answer".
  if (wire?.unreadable) return new Unreadable(UNREADABLE)
  if (err instanceof HungUp) {
    if (phase === 'answer') return new Silence(`The device at ${s.host} closed the connection without answering. ${KEY_OR_APP}`)
    if (wire?.tcpUp) return new Error(`The device at ${s.host} took the connection but closed it during the secure sign-in. ${KEY_OR_APP}`)
    return new Error(`Could not connect to ${where}`)
  }
  const timedOut = err instanceof TimedOut || code === 'ETIMEDOUT' || /timed out|^Timeout waiting/i.test(text)
  if (timedOut && phase === 'answer') return new Silence(`The device at ${s.host} took the connection but did not answer. ${KEY_OR_APP}`)
  if (timedOut && wire?.tcpUp) return new Error(`The device at ${s.host} took the connection but did not finish the secure sign-in. ${KEY_OR_APP}`)
  if (timedOut) return new Error(`${where} did not answer`)
  return new Error(phase === 'connect' ? `Could not connect to ${where}` : `${where} stopped answering`)
}

/** One new connection, signed in and ready. */
async function open(s: Settings, link: Link, ms: number): Promise<TuyaClient> {
  let dev: TuyaClient
  try {
    dev = new TuyAPI({ id: s.id, key: s.key, ip: s.host, port: s.port, version: s.version, issueGetOnConnect: false }) as unknown as TuyaClient
  } catch {
    throw new DeviceRefusal('The hub could not use these Tuya settings. Check the Device ID and the local key')
  }
  const wire = wireOf(dev)
  // tuyapi reports trouble as 'error' events; with no listener Node would treat them as fatal. The text is only
  // looked at here, never kept: a reply that fails tuyapi's checks means the key or version does not fit.
  dev.on('error', (arg) => {
    const text = arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : ''
    if (/HMAC mismatch/i.test(text) && wire.phase === 'signin') {
      // The sign-in reply failed the key check. tuyapi drops it and would leave connect() waiting for ever.
      wire.unreadable = 'key'
      soon(() => wire.cut?.(new DeviceRefusal(WRONG_KEY)))
    } else if (/HMAC mismatch|CRC mismatch|Prefix does not match|Suffix does not match|Packet too short|Packet missing payload/i.test(text)) {
      wire.unreadable ??= 'reply'
    }
  })
  // tuyapi 7.7 throws inside its socket handler on a sign-in reply it could not decrypt (protocol 3.5 with a
  // wrong key): unguarded, that exception would stop the whole hub.
  const dispatch = dev._packetHandler
  if (typeof dispatch === 'function') {
    dev._packetHandler = (packet: unknown) => {
      try {
        dispatch.call(dev, packet)
      } catch {
        if (wire.phase === 'signin') {
          wire.unreadable = 'key'
          soon(() => wire.cut?.(new DeviceRefusal(WRONG_KEY)))
        } else {
          wire.unreadable ??= 'reply'
        }
      }
    }
  }
  dev.on('connected', () => {
    // tuyapi can reconnect by itself. A connection the hub has given up on must not keep the device's only
    // slot; closed a moment later, because tuyapi starts its keep-alive timer right after this event.
    if (retired.has(dev) || link.dev !== dev) queueMicrotask(() => drop(dev))
  })
  dev.on('disconnected', () => {
    // Never reused: the next call opens a new connection.
    retired.add(dev)
    if (link.dev === dev) {
      link.dev = null
      link.seen = null
    }
    soon(() => wire.cut?.(new HungUp('closed')))
  })
  link.dev = dev
  try {
    const ready = dev.connect()
    const sock = dev.client
    sock?.once?.('connect', () => {
      wire.tcpUp = true
    })
    // During the sign-in tuyapi reports a closed socket to nobody, so listen for it here.
    sock?.once?.('close', () => soon(() => wire.cut?.(new HungUp('closed'))))
    await waitFor(wire, ready, ms)
    wire.phase = 'ready'
  } catch (err) {
    const sock = dev.client
    if (sock && sock.connecting === false && sock.destroyed === false) wire.tcpUp = true
    if (link.dev === dev) {
      link.dev = null
      link.seen = null
    }
    // Only a connection the device really had counts as "just closed" for the next attempt.
    if (wire.tcpUp) link.closedAt = Date.now()
    drop(dev)
    throw explain(err, s, 'connect', wire)
  }
  return dev
}

async function connect(s: Settings, link: Link, time: Budget): Promise<TuyaClient> {
  if (link.dev?.isConnected()) return link.dev
  hangUp(link)
  // When the hub itself last closed a connection to this device (not counting the attempts below).
  const closedAt = link.closedAt
  for (let attempt = 0; ; attempt++) {
    const sinceClose = Date.now() - link.closedAt
    if (sinceClose >= 0 && sinceClose < REOPEN_PAUSE_MS) await sleep(REOPEN_PAUSE_MS - sinceClose)
    try {
      return await open(s, link, time.left())
    } catch (err) {
      // A device can need a moment to free its single slot after the hub's own last connection was closed.
      const justClosed = Date.now() - closedAt < REOPEN_RETRY_WITHIN_MS
      if (attempt > 0 || !(err instanceof TurnedAway) || !justClosed) throw err
      await sleep(REOPEN_RETRY_MS)
    }
  }
}

/** The data points in a reply. tuyapi already unwraps the {protocol, data:{dps}} form of 3.4 / 3.5 devices. */
function dpsOf(reply: unknown): Dps | null {
  if (typeof reply !== 'object' || reply === null) return null
  const dps = (reply as { dps?: unknown }).dps
  return typeof dps === 'object' && dps !== null ? (dps as Dps) : null
}

/** Ask the device for all its data points. */
async function readDps(s: Settings, link: Link, time: Budget, opts: { fresh?: boolean } = {}): Promise<Dps> {
  if (!opts.fresh && link.seen && link.dev?.isConnected() && Date.now() - link.seen.at < FRESH_MS) return link.seen.dps
  const dev = await connect(s, link, time)
  const wire = wireOf(dev)
  let reply: unknown
  try {
    // `dps` only matters on the few devices that cannot list everything: tuyapi then asks for that one value.
    reply = await waitFor(wire, dev.get({ schema: true, dps: s.switchDp ?? s.usualSwitchDp }), time.left())
  } catch (err) {
    giveUp(link, dev)
    throw explain(err, s, 'answer', wire)
  }
  const dps = dpsOf(reply)
  if (!dps) {
    giveUp(link, dev)
    if (reply === 'devid not found') {
      throw new DeviceRefusal('The device says this Device ID is not its own. Check that the ID and the address belong to the same device')
    }
    throw new DeviceRefusal(UNREADABLE)
  }
  link.seen = { at: Date.now(), dps }
  return dps
}

/** A device may settle on its own number (a dimmer with a higher lowest level); any other value must match. */
function took(asked: DpValue | undefined, got: unknown): boolean {
  return got === asked || (typeof asked === 'number' && typeof got === 'number')
}

/**
 * Send values and make sure the device took them. Only send values that differ from the current ones.
 * Returns the values the device now holds for those data points.
 */
async function apply(s: Settings, link: Link, time: Budget, values: Record<string, DpValue>): Promise<Dps> {
  const keys = Object.keys(values)
  const dev = await connect(s, link, time)
  const wire = wireOf(dev)
  link.seen = null
  const only = keys[0]
  const options: TuyaSetOptions = keys.length === 1 && only !== undefined ? { dps: Number(only), set: values[only] ?? null } : { multiple: true, data: { ...values } }
  let told: Dps | null = null
  let quiet = false
  try {
    told = dpsOf(await waitFor(wire, dev.set(options), Math.min(time.left(), CONFIRM_WAIT_MS)))
  } catch (err) {
    // tuyapi keeps waiting on this command for a while yet; a new connection is the only clean way on.
    giveUp(link, dev)
    const why = explain(err, s, 'answer', wire)
    if (!(why instanceof Silence) && !(why instanceof Unreadable)) throw why
    quiet = true
  }
  if (told) {
    // A status packet lists what really changed, so a number in it is the level the device settled on.
    const reported = told
    const mentioned = keys.filter((k) => k in reported)
    if (mentioned.length > 0 && mentioned.every((k) => took(values[k], reported[k]))) {
      const held: Dps = { ...values }
      for (const k of mentioned) held[k] = reported[k]
      return held
    }
  }
  // No clear confirmation: look at the device itself rather than guess.
  const now = await readDps(s, link, time, { fresh: true })
  if (keys.every((k) => now[k] === values[k])) return { ...values }
  // The device was reached and asked: another connection would not change its mind, so this is its answer.
  throw new Unchanged(
    quiet
      ? `The device at ${s.host} did not confirm the command and has not changed. Another app may be using its only local connection`
      : `The device at ${s.host} answered but did not change`,
  )
}

// ---------------------------------------------------------------------------
// Data points -> what the tile shows
// ---------------------------------------------------------------------------

function switchDpOf(s: Settings, dps: Dps): number {
  if (s.switchDp !== null) return s.switchDp
  const has = (n: number) => typeof dps[String(n)] === 'boolean'
  if (has(20) && !has(1)) return 20
  if (has(1)) return 1
  return s.usualSwitchDp
}

function dimDpOf(s: Settings, dps: Dps): number {
  if (s.dimDp !== null) return s.dimDp
  if (switchDpOf(s, dps) === 20) return 22
  // Dimmer switches keep brightness on 2; older bulbs have their mode there and brightness on 3.
  if (typeof dps['2'] !== 'number' && typeof dps['3'] === 'number') return 3
  return 2
}

function toPercent(s: Settings, raw: number): number {
  return clamp(Math.round((raw / s.dimMax) * 100), 1, 100)
}

function fromPercent(s: Settings, percent: number): number {
  return clamp(Math.round((percent / 100) * s.dimMax), s.dimMin, s.dimMax)
}

/** The on/off data point and its value, or a refusal that tells the owner which numbers the device does have. */
function needSwitch(s: Settings, dps: Dps): { dp: number; on: boolean } {
  const dp = switchDpOf(s, dps)
  const value = dps[String(dp)]
  if (typeof value === 'boolean') return { dp, on: value }
  const byNumber = (a: string, b: string) => Number(a) - Number(b)
  const switches = Object.keys(dps).filter((k) => typeof dps[k] === 'boolean').sort(byNumber)
  const all = Object.keys(dps).sort(byNumber)
  const hint = switches.length
    ? `It has on/off values at: ${switches.join(', ')}`
    : all.length
      ? `It reported only these numbers: ${all.join(', ')}`
      : 'It reported no values at all'
  throw new DeviceRefusal(`This device has no on/off value at channel number ${dp}. ${hint}. Set the on/off channel number to match`)
}

function stateOf(s: Settings, dps: Dps): Record<string, unknown> {
  const on = dps[String(switchDpOf(s, dps))]
  if (s.gate === 'pulse') return { gate: 'unknown' satisfies GateState }
  if (s.gate === 'hold') return { gate: (typeof on === 'boolean' ? (on ? 'open' : 'closed') : 'unknown') satisfies GateState }
  const out: Record<string, unknown> = {}
  if (typeof on === 'boolean') out.power = on
  if (s.dimmer) {
    const raw = dps[String(dimDpOf(s, dps))]
    if (typeof raw === 'number') out.brightness = toPercent(s, raw)
  }
  return out
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function switchTo(s: Settings, link: Link, time: Budget, want: boolean | 'toggle'): Promise<{ on: boolean; changed: boolean; dps: Dps }> {
  const dps = await readDps(s, link, time, { fresh: true })
  const { dp, on } = needSwitch(s, dps)
  const target = want === 'toggle' ? !on : want
  if (on === target) return { on, changed: false, dps }
  await apply(s, link, time, { [String(dp)]: target })
  return { on: target, changed: true, dps: { ...dps, [String(dp)]: target } }
}

async function setBrightness(s: Settings, link: Link, time: Budget, percent: number): Promise<ActionResult> {
  if (percent === 0) {
    const off = await switchTo(s, link, time, false)
    return { ok: true, state: { power: false, brightness: 0 }, ...(off.changed ? {} : { result: { unchanged: true } }) }
  }
  const dps = await readDps(s, link, time, { fresh: true })
  const { dp, on } = needSwitch(s, dps)
  const dim = dimDpOf(s, dps)
  const value = fromPercent(s, percent)
  const values: Record<string, DpValue> = {}
  if (!on) values[String(dp)] = true
  // A colour bulb (20 on/off, 21 mode, 22 brightness) follows its brightness value only on white light.
  if (dp === 20 && dim === 22 && typeof dps['21'] === 'string' && dps['21'] !== 'white') values['21'] = 'white'
  if (dps[String(dim)] !== value) values[String(dim)] = value
  const changed = Object.keys(values).length > 0
  let level = percent
  if (changed) {
    const held = (await apply(s, link, time, values))[String(dim)]
    // The device may have settled on its own nearest level: report that one.
    if (typeof held === 'number' && held !== value) level = toPercent(s, held)
  }
  return { ok: true, state: { power: true, brightness: level }, ...(changed ? {} : { result: { unchanged: true } }) }
}

/** Let go of the gate relay, however the press went. True when the relay is confirmed off. */
async function release(s: Settings, link: Link, key: string, stepMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const time = budget(RELEASE_BUDGET_MS, stepMs)
    let now: Dps | null = null
    try {
      now = await readDps(s, link, time, { fresh: true })
    } catch {
      now = null
    }
    // Relays with their own timer have already let go; sending "off" again would get no reply.
    if (now && now[key] === false) return true
    try {
      await apply(s, link, time, { [key]: false })
      return true
    } catch {
      /* try once more on a new connection */
    }
  }
  return false
}

/** Press the gate's push button: relay on, wait, relay off. */
async function pressButton(ctx: AdapterContext, s: Settings, link: Link, time: Budget): Promise<ActionResult> {
  // Nothing has been sent yet, so a failure here may safely be retried on another connection.
  const before = await readDps(s, link, time, { fresh: true })
  const { dp, on } = needSwitch(s, before)
  const key = String(dp)
  if (on) await apply(s, link, time, { [key]: false })

  // From here the button may have been pressed. Never throw: a retry on another connection would press it twice.
  try {
    await apply(s, link, time, { [key]: true })
  } catch (err) {
    const letGo = await release(s, link, key, ctx.timeoutMs)
    ctx.log.warn(`gate relay press not confirmed (relay ${letGo ? 'is off' : 'state unknown'})`)
    // A plain "no" (wrong key, wrong channel) is reported as it is. Anything less certain gets the careful wording:
    // a relay with its own timer can click and be off again before the hub looks.
    if (err instanceof DeviceRefusal && !(err instanceof Unchanged) && !(err instanceof Unreadable)) return { ok: false, error: err.message }
    return { ok: false, error: 'The gate relay did not confirm the press. It may or may not have clicked: look at the gate before trying again' }
  }
  await sleep(s.pulseMs)
  if (!(await release(s, link, key, ctx.timeoutMs))) {
    ctx.log.warn('gate relay did not confirm that it let go')
    return {
      ok: false,
      error: 'The relay pressed the gate button, but the hub could not confirm that it let go again. Check the device before using the gate: its button may still be held down',
    }
  }
  return { ok: true, result: { pressedMs: s.pulseMs }, state: { gate: 'unknown' } }
}

function customValues(params: Record<string, unknown>): Record<string, DpValue> | null {
  const raw = params.dps
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: Record<string, DpValue> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!/^\d{1,3}$/.test(k)) return null
    if (typeof v !== 'boolean' && typeof v !== 'number' && typeof v !== 'string') return null
    out[k] = v
  }
  return Object.keys(out).length ? out : null
}

async function perform(ctx: AdapterContext, s: Settings, link: Link, action: Action): Promise<ActionResult> {
  const time = budget(ctx.timeoutMs * 2 - 500, ctx.timeoutMs)
  switch (action.type) {
    case 'power.on':
    case 'power.off':
    case 'power.toggle': {
      const done = await switchTo(s, link, time, action.type === 'power.toggle' ? 'toggle' : action.type === 'power.on')
      const state = stateOf(s, done.dps)
      return { ok: true, state: { ...state, power: done.on }, ...(done.changed ? {} : { result: { unchanged: true } }) }
    }
    case 'dim.set': {
      const percent = Number(action.params.brightness)
      if (!Number.isFinite(percent)) return { ok: false, error: 'No brightness was given' }
      return setBrightness(s, link, time, clamp(Math.round(percent), 0, 100))
    }
    case 'gate.open':
    case 'gate.close':
    case 'gate.stop':
    case 'gate.pulse': {
      if (s.gate === 'pulse') return pressButton(ctx, s, link, time)
      const done = await switchTo(s, link, time, action.type === 'gate.open')
      return { ok: true, state: { gate: done.on ? 'open' : 'closed' }, ...(done.changed ? {} : { result: { alreadyThere: true } }) }
    }
    case 'custom': {
      const values = customValues(action.params)
      if (!values) return { ok: false, error: 'A custom command needs "dps": channel numbers with the values to set, for example {"dps":{"1":true}}' }
      const before = await readDps(s, link, time, { fresh: true })
      const differing: Record<string, DpValue> = {}
      for (const [k, v] of Object.entries(values)) if (before[k] !== v) differing[k] = v
      if (Object.keys(differing).length) await apply(s, link, time, differing)
      return { ok: true, result: { dps: values }, state: stateOf(s, { ...before, ...values }) }
    }
    default:
      return unsupported(action)
  }
}

/** What this device cannot do, decided from its kind and settings alone (no connection made). */
function refusedUpFront(ctx: AdapterContext, action: Action): ActionResult | null {
  const isGate = ctx.device.kind === 'gate'
  switch (action.type) {
    case 'power.on':
    case 'power.off':
    case 'power.toggle':
      return isGate ? unsupported(action) : null
    case 'dim.set':
      if (isGate) return unsupported(action)
      return ctx.bool('dimmer', false) ? null : { ok: false, error: 'This device is not set up as dimmable. Turn on "Can be dimmed" in its settings if it is' }
    case 'gate.open':
    case 'gate.close':
      return isGate ? null : unsupported(action)
    case 'gate.pulse':
    case 'gate.stop':
      if (!isGate) return unsupported(action)
      return gateModeOf(ctx.device.config) === 'hold'
        ? { ok: false, error: 'This gate is set up as "on = open, off = closed", so it only has Open and Close' }
        : null
    case 'custom':
      return null
    default:
      return unsupported(action)
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const adapter: Adapter = {
  family: 'tuya-local',

  describe(): FamilyDescriptor {
    return {
      id: 'tuya-local',
      label: 'Tuya / Smart Life (inside the house)',
      tagline: 'Tuya and Smart Life bulbs, switches, sockets and gate relays, controlled directly over your WiFi. Works with the internet down.',
      kinds: ['light', 'switch', 'gate'],
      fields: [
        {
          name: 'deviceId',
          label: 'Device ID',
          type: 'text',
          required: true,
          help: 'The long code Tuya gives each device (20 or 22 letters and digits). It is listed next to the local key; the notes below say how to get both.',
        },
        {
          name: 'localKey',
          label: 'Local key',
          type: 'password',
          secret: true,
          required: true,
          help: 'A 16-character code that lets the hub talk to the device inside the house. Stored encrypted on the hub.',
        },
        {
          name: 'version',
          label: 'Protocol version',
          type: 'select',
          required: true,
          default: '3.3',
          options: [
            { value: '3.3', label: '3.3 (most devices)' },
            { value: '3.4', label: '3.4 (newer devices)' },
            { value: '3.5', label: '3.5 (newest devices)' },
            { value: '3.1', label: '3.1 (old devices)' },
          ],
          help: 'Your key list shows this as "version". If the check fails although the key is right, try the next one.',
        },
        {
          name: 'switchDp',
          label: 'On/off channel number',
          type: 'number',
          placeholder: 'Automatic',
          help: 'Tuya numbers each function of a device. Leave empty and the hub works it out: 1 on switches, sockets and relays, 20 on light bulbs. For a switch with several buttons, add each button as its own device and enter 1, 2, 3 and so on.',
        },
        { name: 'dimmer', label: 'Can be dimmed', type: 'toggle', default: false, help: 'Turn on for dimmable bulbs and dimmer switches.' },
        {
          name: 'dimDp',
          label: 'Brightness channel number',
          type: 'number',
          placeholder: 'Automatic',
          showWhen: { field: 'dimmer', equals: true },
          help: 'Leave empty for the usual one: 22 on bulbs, 2 on dimmer switches, 3 on older bulbs.',
        },
        {
          name: 'dimMin',
          label: 'Lowest brightness value',
          type: 'number',
          default: 10,
          showWhen: { field: 'dimmer', equals: true },
          help: 'The device’s own number for its dimmest setting. Most use 10; older bulbs use 25.',
        },
        {
          name: 'dimMax',
          label: 'Highest brightness value',
          type: 'number',
          default: 1000,
          showWhen: { field: 'dimmer', equals: true },
          help: 'The device’s own number for full brightness. Most use 1000; older bulbs use 255.',
        },
        {
          name: 'gateMode',
          label: 'Gate or garage door: how the relay works',
          type: 'select',
          default: 'pulse',
          options: [
            { value: 'pulse', label: 'Presses the motor’s push button for a moment' },
            { value: 'hold', label: 'Stays on while open, off while closed' },
          ],
          help: 'Only used when this device is a gate or garage door. Most gate motors need the short button press.',
        },
        {
          name: 'pulseMs',
          label: 'Gate: length of the button press (milliseconds)',
          type: 'number',
          default: 1000,
          showWhen: { field: 'gateMode', equals: 'pulse' },
          help: '1000 is one second, which suits most gate motors. The longest press is 5000 (five seconds).',
        },
      ],
      pathKinds: ['lan'],
      defaultPort: DEFAULT_PORT,
      capabilities: ['power', 'dim', 'gate', 'gate-state', 'state'],
      notes: [
        'Works over your own WiFi with no internet. The hub and the device must be on the same network, and the device should keep the same address: reserve it in your router.',
        'To get the Device ID and local key (once per device): make a free account at iot.tuya.com, create a cloud project in the India data centre, add the "IoT Core" service, then under Devices choose "Link Tuya App Account" and scan the code with the Smart Life app. After that run "tuya-cli wizard" (or "python -m tinytuya wizard") on a computer: it lists every device with its id, key, address and version. One Smart Life account can be linked to two such projects at most.',
        'The local key changes every time the device is removed and paired again in Smart Life. If the hub starts saying the key is wrong, fetch the key again. The free Tuya service used to read keys runs out after a month, but you only need it when a key has changed.',
        'These devices allow only one local connection at a time. If the Smart Life app is open on a phone on the same WiFi it can block the hub: close the app and try again. The hub itself connects only for a few seconds at a time, for each command and each routine check.',
        'A change made at the wall button or in the Smart Life app shows up here at the hub’s next routine check, some seconds later, not instantly.',
        'On, off and brightness are controlled from here. Colour and warm/cool white are not; use the Smart Life app for those. If a bulb is showing a colour or a scene, setting its brightness here puts it back on white light, because that is the only light its brightness setting controls.',
        'Gates and garage doors: wire the relay across the motor’s push-button input. In button-press mode every gate command presses that button once, like the remote: the gate itself decides whether that means open, stop or close, and the hub cannot see where the gate is.',
        'The hub cannot move a Tuya device to another WiFi network. That needs pairing again in Smart Life, which also changes the local key.',
        'Battery-powered Tuya devices sleep most of the time and cannot be controlled this way.',
      ],
    }
  },

  capabilities(config: Record<string, unknown>, kind: DeviceKind): Capability[] {
    if (kind === 'gate') return gateModeOf(config) === 'hold' ? ['gate', 'gate-state', 'state'] : ['gate']
    return flag(config.dimmer) ? ['power', 'dim', 'state'] : ['power', 'state']
  },

  async probe(ctx): Promise<ProbeResult> {
    const started = Date.now()
    try {
      const s = settings(ctx)
      const dps = await use(s, (link) => readDps(s, link, budget(ctx.timeoutMs, ctx.timeoutMs), { fresh: true }))
      // Only the right device can produce a readable answer for this id + key, so the id is a safe identity.
      return { ok: true, latencyMs: Date.now() - started, info: { ...stateOf(s, dps), serial: s.id } }
    } catch (err) {
      return { ok: false, latencyMs: null, error: err instanceof Error ? err.message : 'The device did not answer' }
    }
  },

  async readState(ctx): Promise<Record<string, unknown>> {
    const s = settings(ctx)
    const dps = await use(s, (link) => readDps(s, link, budget(ctx.timeoutMs - 300, ctx.timeoutMs)))
    return stateOf(s, dps)
  },

  async execute(ctx, action): Promise<ActionResult> {
    const refused = refusedUpFront(ctx, action)
    if (refused) return refused
    try {
      const s = settings(ctx)
      return await use(s, (link) => perform(ctx, s, link, action))
    } catch (err) {
      // The device or its settings said no: report it. Anything else is a connection failure and is thrown,
      // so the hub can try the device's next connection.
      if (err instanceof DeviceRefusal) return { ok: false, error: err.message }
      throw err
    }
  },
}

export default adapter
