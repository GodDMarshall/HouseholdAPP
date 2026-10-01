/**
 * Shelly relays and dimmers on the house network.
 *
 *  - First generation (Shelly 1, 1PM, 2.5, Dimmer 2 ...): plain HTTP paths such as
 *    /relay/0?turn=on, /light/0, /status, /settings/sta, protected by HTTP Basic.
 *  - Plus / Pro / Gen3 / Gen4: RPC under /rpc/<Method>, protected by SHA-256 digest
 *    with the fixed user "admin".
 *
 * Three kinds of tile: a light, a switch, or a gate / garage door whose motor
 * board has its push-button input wired across the Shelly's relay contacts.
 *
 * Things this adapter is deliberately careful about:
 *  - Newer Shellys keep a small table of login nonces and lock logins out after
 *    repeated wrong passwords. On firmware 2.0.0 and later one nonce is reused with
 *    a rising counter instead of asking for a new one per call. Older firmware does
 *    not support that, so there every call does the full challenge round-trip and a
 *    used nonce is never sent again. A wrong password is not tried again for a
 *    minute, and a "that nonce is stale" answer is never mistaken for one.
 *  - Firmware 1.8+ answers only over HTTPS (port 80 redirects). The redirect is
 *    followed once and remembered per address; if that address later stops
 *    answering over HTTPS (another device took it), the plain way is tried again.
 *  - A gate on a single step input is stateful: a pulse opens, stops or closes
 *    depending on where the gate is. With a sensor, no pulse is sent to a gate that
 *    is already where the owner asked.
 *  - A press or a toggle is never sent twice. If its answer is lost while the
 *    Shelly is still on the network, the action fails with a plain message
 *    instead of failing over to another connection and pressing again.
 *  - WiFi passwords travel in a request body, never in a URL, and never reach a
 *    log line, an error or a result.
 */
import crypto from 'node:crypto'
import type { Action, Capability, DeviceKind, DiscoveredDevice, FamilyDescriptor, GateState } from '@house/shared'
import { basicHeader, request, type Response } from '../lib/http.ts'
import type { Logger } from '../lib/log.ts'
import {
  baseUrl,
  clamp,
  requireHost,
  tcpProbe,
  unsupported,
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type ProbeResult,
  type WifiScanEntry,
} from './types.ts'

type Gen = 1 | 2
type GateMode = 'one-button' | 'separate-relays'
type RefusalCode = 'login' | 'password' | 'busy' | 'other'

/** The device answered, and the answer was "no". Never retried on another path. */
class Refusal extends Error {
  constructor(
    message: string,
    public readonly code: RefusalCode = 'other',
  ) {
    super(message)
  }
}

interface DigestState {
  /** Fingerprint of the credentials this nonce was used with. */
  fp: string
  realm: string
  nonce: string
  algorithm: string
  qop: boolean
  opaque?: string
  nc: number
  since: number
}

interface Challenge {
  realm: string
  nonce: string
  algorithm: string
  qop: boolean
  opaque?: string
  /** The device says the nonce it was sent is no longer good: a nonce problem, not a password problem. */
  stale: boolean
}

interface Session {
  gen?: Gen
  https?: boolean
  httpsPort?: number
  /** Firmware older than 2.0.0: a nonce is good for one request only (full 401 round-trip every time). */
  singleUseNonce?: boolean
  digest?: DigestState
  authFail?: { fp: string; until: number }
  busyUntil?: number
}

interface Move {
  goal: 'open' | 'closed' | 'stopped'
  until: number
}

interface Identity {
  gen: Gen
  auth: boolean
  info: Record<string, unknown>
}

interface SendOptions {
  method?: 'GET' | 'POST'
  body?: string
  contentType?: string
  auth: 'none' | 'basic' | 'digest'
  timeoutMs?: number
  /** Clock time by which the whole call, login round-trips included, must be over. */
  deadline?: number
}

interface CallOptions {
  post?: boolean
  timeoutMs?: number
  deadline?: number
}

/** What is known about each address (host:port): generation, scheme, login nonce, back-off. */
const sessions = new Map<string, Session>()
/** Gate movements the hub started, by device id, so "opening" / "closing" can be shown. */
const moves = new Map<string, Move>()

const WRONG_LOGIN = 'Wrong username or password'
const NEEDS_PASSWORD = 'This Shelly asks for a password. Enter it in the device settings.'
const BUSY = 'The Shelly is refusing logins for a short while after too many attempts. Try again in a minute.'
const NOT_SHELLY = 'Something answers at this address, but it is not a Shelly'
const TOO_SLOW = 'The Shelly is answering too slowly to do this safely. Nothing more was sent. Try again in a moment.'
const UNREADABLE = 'The Shelly sent an answer the hub could not read'
const NONCE_RACE = 'The Shelly was busy with another request and turned this one away. Nothing was changed. Try again in a moment.'

/** Failures after which the request may nevertheless have reached the device. */
const AMBIGUOUS = /timed out|closed the connection|socket hang up|ECONNRESET|aborted/i

/** After a wrong password, wait this long before trying the same one again (stays under the device's lock-out). */
const AUTH_RETRY_MS = 60_000
/** After "too many requests" with no hint from the device. */
const BUSY_WAIT_MS = 10_000
/** A nonce is good for 30,000 uses or an hour; renew well before either. */
const NONCE_MAX_USES = 25_000
const NONCE_MAX_AGE_MS = 50 * 60_000
/** The hub waits at most 90 s for a gate to settle. */
const MAX_TRAVEL_S = 85
const MAX_PULSE_S = 30

/** Test hook: forget everything learned about addresses and gate movements. */
export function resetShellyState(): void {
  sessions.clear()
  moves.clear()
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function jsonOf(res: Response): unknown {
  try {
    return JSON.parse(res.text())
  } catch {
    return undefined
  }
}

/** A whole number >= 0, or null when the field was left empty. */
function optionalIndex(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function encodeQuery(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(isRecord(v) || Array.isArray(v) ? JSON.stringify(v) : String(v))}`)
    .join('&')
}

/** WiFi strength as 0-100 from the dBm figure the device reports. */
function signalPercent(rssi: unknown): number | null {
  const n = Number(rssi)
  if (rssi === null || rssi === undefined || !Number.isFinite(n) || n >= 0) return null
  return clamp(Math.round(2 * (n + 100)), 0, 100)
}

function wifiState(ssid: unknown, rssi: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof ssid === 'string' && ssid) out.wifi = ssid
  const pct = signalPercent(rssi)
  if (pct !== null) out.signal = pct
  return out
}

function fingerprint(username: string, password: string): string {
  return crypto.createHash('sha256').update(`${username}\n${password}`).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function generationSetting(config: Record<string, unknown>): 'auto' | 'gen1' | 'gen2' {
  const v = String(config.generation ?? 'auto')
  return v === 'gen1' || v === 'gen2' ? v : 'auto'
}

function isOn(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
}

function channelOf(ctx: AdapterContext): number {
  return optionalIndex(ctx.device.config.channel) ?? 0
}

function gateModeOf(ctx: AdapterContext): GateMode {
  return ctx.str('gateMode', 'one-button') === 'separate-relays' ? 'separate-relays' : 'one-button'
}

/** Shelly timers count whole seconds, so the press length is rounded up. */
function pulseSeconds(ctx: AdapterContext): number {
  return clamp(Math.ceil(ctx.num('pulseMs', 1000) / 1000), 1, MAX_PULSE_S)
}

function travelMs(ctx: AdapterContext): number {
  return clamp(ctx.num('travelSeconds', 20), 1, MAX_TRAVEL_S) * 1000
}

function sensorInput(ctx: AdapterContext): number | null {
  return optionalIndex(ctx.device.config.inputId)
}

/** Translate the raw input level into "the gate is closed". */
function closedFrom(ctx: AdapterContext, input: boolean): boolean {
  const closedMeansOn = ctx.str('inputClosedMeans', 'on') !== 'off'
  return input === closedMeansOn
}

// ---------------------------------------------------------------------------
// Transport: scheme, login, back-off
// ---------------------------------------------------------------------------

function sessionOf(ctx: AdapterContext): Session {
  const key = `${requireHost(ctx).toLowerCase()}:${ctx.path.port ?? 80}`
  let s = sessions.get(key)
  if (!s) {
    s = {}
    sessions.set(key, s)
  }
  return s
}

function usesHttps(ctx: AdapterContext, s: Session): boolean {
  return s.https === true || ctx.bool('https', false)
}

function origin(ctx: AdapterContext, s: Session): string {
  if (!usesHttps(ctx, s)) return baseUrl(ctx, { defaultPort: 80 })
  const configured = ctx.path.port
  const port = s.httpsPort ?? (configured && configured !== 80 ? configured : 443)
  return baseUrl({ ...ctx, path: { ...ctx.path, port } }, { https: true })
}

/** Where a redirect points, if it points at HTTPS. */
function httpsTarget(location: string | undefined): { port: number } | null {
  if (!location) return null
  try {
    const u = new URL(location)
    if (u.protocol !== 'https:') return null
    return { port: u.port ? Number(u.port) : 443 }
  } catch {
    return null
  }
}

function parseAuthParams(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out[m[1]!] = (m[2] ?? m[3] ?? '').trim()
  return out
}

/** The digest challenge from a 401: the WWW-Authenticate header, or the JSON body some firmware sends. */
function challengeFrom(res: Response): Challenge | null {
  const header = res.headers['www-authenticate'] ?? ''
  if (/^digest/i.test(header)) {
    const p = parseAuthParams(header.replace(/^digest\s+/i, ''))
    if (p.nonce) {
      return {
        realm: p.realm ?? '',
        nonce: p.nonce,
        algorithm: (p.algorithm ?? 'MD5').toUpperCase(),
        qop: (p.qop ?? '')
          .split(',')
          .map((x) => x.trim())
          .includes('auth'),
        opaque: p.opaque,
        stale: /^true$/i.test(p.stale ?? ''),
      }
    }
  }
  const body = jsonOf(res)
  if (isRecord(body) && body.auth_type === 'digest' && body.nonce !== undefined && body.nonce !== null) {
    return {
      realm: String(body.realm ?? ''),
      nonce: String(body.nonce),
      algorithm: String(body.algorithm ?? 'SHA-256').toUpperCase(),
      qop: true,
      stale: body.stale === true || body.stale === 'true',
    }
  }
  return null
}

/** RFC 7616 digest. Shelly: SHA-256, qop=auth, and the counter must rise with every use of a nonce. */
function digestAuthorization(d: DigestState, method: string, uri: string, username: string, password: string): string {
  d.nc += 1
  const nc = d.nc.toString(16).padStart(8, '0')
  const cnonce = crypto.randomBytes(8).toString('hex')
  const hash = (v: string) =>
    crypto
      .createHash(d.algorithm.startsWith('SHA-256') ? 'sha256' : 'md5')
      .update(v)
      .digest('hex')
  const ha1 = hash(`${username}:${d.realm}:${password}`)
  const ha2 = hash(`${method}:${uri}`)
  const response = d.qop ? hash(`${ha1}:${d.nonce}:${nc}:${cnonce}:auth:${ha2}`) : hash(`${ha1}:${d.nonce}:${ha2}`)
  const parts = [`username="${username}"`, `realm="${d.realm}"`, `nonce="${d.nonce}"`, `uri="${uri}"`]
  if (d.qop) parts.push(`cnonce="${cnonce}"`, `nc=${nc}`, 'qop=auth')
  parts.push(`algorithm=${d.algorithm}`, `response="${response}"`)
  if (d.opaque) parts.push(`opaque="${d.opaque}"`)
  return 'Digest ' + parts.join(', ')
}

function usableDigest(s: Session, fp: string): DigestState | null {
  const d = s.digest
  if (!d) return null
  if (d.fp !== fp || d.nc >= NONCE_MAX_USES || Date.now() - d.since > NONCE_MAX_AGE_MS) {
    s.digest = undefined
    return null
  }
  return d
}

/**
 * One request to the device. Follows the HTTP -> HTTPS redirect of newer
 * firmware once, logs in, and turns 401 / 429 into a Refusal. Transport
 * failures (timeout, refused) are thrown as they come from lib/http.
 */
async function send(ctx: AdapterContext, pathAndQuery: string, opts: SendOptions): Promise<Response> {
  const s = sessionOf(ctx)
  const method = opts.method ?? 'GET'
  const password = opts.auth === 'none' ? '' : ctx.secret('password') ?? ''
  const username = opts.auth === 'basic' ? ctx.str('username', 'admin').trim() || 'admin' : 'admin'
  const fp = password ? fingerprint(username, password) : ''

  if (opts.auth !== 'none') {
    const now = Date.now()
    if ((s.busyUntil ?? 0) > now) throw new Refusal(BUSY, 'busy')
    if (fp && s.authFail && s.authFail.fp === fp && s.authFail.until > now) throw new Refusal(WRONG_LOGIN, 'login')
  }

  /** The nonce the device handed to this very call. Preferred over the shared one, so calls running side by side cannot spoil each other's login. */
  let own: DigestState | null = null

  const attempt = async (): Promise<Response> => {
    const limit = opts.timeoutMs ?? ctx.timeoutMs
    const left = opts.deadline === undefined ? limit : opts.deadline - Date.now()
    if (left < 250) throw new Refusal(TOO_SLOW)
    const headers: Record<string, string> = {}
    if (opts.body !== undefined) {
      headers['Content-Type'] = opts.contentType ?? 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(opts.body))
    }
    if (fp && opts.auth === 'basic') headers.Authorization = basicHeader(username, password)
    if (fp && opts.auth === 'digest') {
      const d = own ?? usableDigest(s, fp)
      if (d) headers.Authorization = digestAuthorization(d, method, pathAndQuery, username, password)
    }
    return request(origin(ctx, s) + pathAndQuery, { method, headers, body: opts.body, timeoutMs: Math.min(limit, left), insecure: true })
  }

  let res = await attempt()

  if (res.status >= 300 && res.status < 400 && !usesHttps(ctx, s)) {
    const target = httpsTarget(res.headers.location)
    if (target) {
      s.https = true
      s.httpsPort = target.port
      ctx.log.debug('this Shelly only answers over a secure connection; switching to it')
      res = await attempt()
    }
  }

  if (fp && opts.auth === 'digest') {
    // A 401 here is the first call (no nonce yet), older firmware (a new nonce for every request),
    // or a nonce that went stale: take the new one and answer it. A second new nonce is taken only
    // when the device itself says "stale", because that is about the nonce and not about the password.
    for (let round = 0; res.status === 401 && round < 2; round += 1) {
      const challenge = challengeFrom(res)
      if (!challenge || (round === 1 && !challenge.stale)) break
      own = { realm: challenge.realm, nonce: challenge.nonce, algorithm: challenge.algorithm, qop: challenge.qop, opaque: challenge.opaque, fp, nc: 0, since: Date.now() }
      s.digest = s.singleUseNonce ? undefined : own
      res = await attempt()
    }
  }

  if (res.status === 401) {
    if (!own || s.digest === own) s.digest = undefined
    if (!fp) throw new Refusal(NEEDS_PASSWORD, 'password')
    // Still "stale" after two fresh nonces: other requests got in between. The password was not judged.
    if (opts.auth === 'digest' && challengeFrom(res)?.stale) throw new Refusal(NONCE_RACE, 'busy')
    s.authFail = { fp, until: Date.now() + AUTH_RETRY_MS }
    throw new Refusal(WRONG_LOGIN, 'login')
  }
  if (res.status === 429) {
    const wait = Number(res.headers['retry-after'])
    s.busyUntil = Date.now() + (Number.isFinite(wait) && wait > 0 ? Math.min(wait, 300) * 1000 : BUSY_WAIT_MS)
    throw new Refusal(BUSY, 'busy')
  }
  if (fp && res.status < 400) s.authFail = undefined
  return res
}

/**
 * For commands that do harm when repeated (a toggle, a press on a one-button
 * gate). The hub retries a thrown failure on another connection, and every
 * connection leads to the same Shelly, so a lost answer must not be thrown
 * while the device is still there: the command may already have been carried out.
 *
 * The hub also retries when an action takes longer than twice the device
 * timeout, so these commands run against a deadline (see actionDeadline) that
 * keeps the whole action, this check included, inside that limit.
 */
async function once<T>(ctx: AdapterContext, what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof Refusal || !AMBIGUOUS.test(messageOf(err))) throw err
    const u = new URL(origin(ctx, sessionOf(ctx)))
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
    // Short enough that, with actionDeadline(), the whole action stays inside the hub's limit of 2 x timeout.
    const alive = await tcpProbe(requireHost(ctx), port, clamp(Math.floor(ctx.timeoutMs / 2), 200, 1500))
    // Gone from this network: nothing arrived, so trying another connection is safe.
    if (!alive.ok) throw err
    throw new Refusal(`The Shelly did not answer the ${what} in time, so the hub cannot tell whether it arrived. It was not sent again, to avoid doing it twice. Check before trying again.`)
  }
}

/** When an action must be over: inside the hub's own limit (2 x timeout), with room for the check in once(). */
function actionDeadline(ctx: AdapterContext): number {
  return Date.now() + Math.max(1000, ctx.timeoutMs * 2 - 2500)
}

// ---------------------------------------------------------------------------
// The two dialects
// ---------------------------------------------------------------------------

/** First generation: GET (or form POST) on a REST path, JSON back. */
async function gen1Call<T = Record<string, unknown>>(
  ctx: AdapterContext,
  path: string,
  params: Record<string, unknown> = {},
  opts: CallOptions = {},
): Promise<T> {
  const q = encodeQuery(params)
  const res = opts.post
    ? await send(ctx, path, { method: 'POST', body: q, contentType: 'application/x-www-form-urlencoded', auth: 'basic', timeoutMs: opts.timeoutMs, deadline: opts.deadline })
    : await send(ctx, q ? `${path}?${q}` : path, { auth: 'basic', timeoutMs: opts.timeoutMs, deadline: opts.deadline })
  if (res.status === 404) {
    throw new Refusal(`The Shelly does not know ${path}. Check "Output number", "This is a dimmer" and "Which Shelly is it" for this device.`)
  }
  if (res.status < 200 || res.status >= 300) throw new Refusal(`The Shelly answered with an error (HTTP ${res.status})`)
  const body = jsonOf(res)
  // Every first-generation answer is a JSON object. Anything else (a web page, "null", a list) is
  // an answer from the device, not a lost connection: it must never look like one to the hub.
  if (!isRecord(body)) throw new Refusal(UNREADABLE)
  return body as T
}

/** Plus / Pro / Gen3 / Gen4: /rpc/<Method>, parameters in the query (GET) or as a JSON body (POST). */
async function rpc<T = Record<string, unknown>>(ctx: AdapterContext, method: string, params: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
  let res: Response
  if (opts.post) {
    res = await send(ctx, `/rpc/${method}`, { method: 'POST', body: JSON.stringify(params), contentType: 'application/json', auth: 'digest', timeoutMs: opts.timeoutMs, deadline: opts.deadline })
  } else {
    const q = encodeQuery(params)
    res = await send(ctx, q ? `/rpc/${method}?${q}` : `/rpc/${method}`, { auth: 'digest', timeoutMs: opts.timeoutMs, deadline: opts.deadline })
  }
  const body = jsonOf(res)
  const failed = res.status < 200 || res.status >= 300
  const error = isRecord(body) ? (isRecord(body.error) ? body.error : failed ? body : null) : null
  if (failed || error) {
    const text = error && typeof error.message === 'string' ? error.message.slice(0, 160) : ''
    const code = error ? Number(error.code) : NaN
    if (res.status === 404 || code === 404 || /no handler/i.test(text)) {
      throw new Refusal(`This Shelly does not know the command ${method}. Check "This is a dimmer" and "Which Shelly is it" for this device.`)
    }
    throw new Refusal(text ? `The Shelly refused the command: ${text}` : `The Shelly answered with an error (HTTP ${res.status})`)
  }
  if (body === undefined && res.body.length > 0) throw new Refusal(UNREADABLE)
  return body as T
}

/** GET /shelly needs no login on either generation and says which one this is. */
async function identify(ctx: AdapterContext, opts: CallOptions = {}): Promise<Identity> {
  const s = sessionOf(ctx)
  const ask = () => send(ctx, '/shelly', { auth: 'none', timeoutMs: opts.timeoutMs, deadline: opts.deadline })
  let res: Response
  try {
    res = await ask()
  } catch (err) {
    // The secure connection was learned from a redirect, not chosen by the owner. If this address no
    // longer answers that way (another device took it over), forget it and ask the plain way, once.
    if (err instanceof Refusal || !s.https || ctx.bool('https', false) || /timed out/i.test(messageOf(err))) throw err
    s.https = undefined
    s.httpsPort = undefined
    s.digest = undefined
    res = await ask()
  }
  const body = res.status === 200 ? jsonOf(res) : undefined
  if (!isRecord(body)) throw new Refusal(NOT_SHELLY)
  const genNumber = Number(body.gen)
  const info: Record<string, unknown> = {}
  let gen: Gen
  let auth: boolean
  if (body.gen !== undefined && Number.isFinite(genNumber) && genNumber >= 2) {
    gen = 2
    auth = body.auth_en === true
    if (typeof body.model === 'string') info.model = body.model
    const firmware = typeof body.ver === 'string' ? body.ver : body.fw_id
    if (typeof firmware === 'string') info.firmware = firmware
    if (typeof body.id === 'string') info.serial = body.id
    info.generation = `gen${genNumber}`
    // Reusing a login nonce with a rising counter came with firmware 2.0.0. Before that, every
    // request needs the full challenge round-trip, and a used nonce must not be sent again.
    const major = typeof body.ver === 'string' ? Number.parseInt(body.ver, 10) : NaN
    s.singleUseNonce = Number.isFinite(major) && major < 2
    if (s.singleUseNonce) s.digest = undefined
  } else if (typeof body.type === 'string') {
    gen = 1
    auth = body.auth === true
    info.model = body.type
    if (typeof body.fw === 'string') info.firmware = body.fw
    info.generation = 'gen1'
  } else {
    throw new Refusal(NOT_SHELLY)
  }
  if (typeof body.mac === 'string') info.mac = body.mac
  s.gen = gen
  return { gen, auth, info }
}

async function generationOf(ctx: AdapterContext, deadline?: number): Promise<Gen> {
  const set = generationSetting(ctx.device.config)
  if (set === 'gen1') return 1
  if (set === 'gen2') return 2
  return sessionOf(ctx).gen ?? (await identify(ctx, { deadline })).gen
}

// ---------------------------------------------------------------------------
// Lights and switches
// ---------------------------------------------------------------------------

async function power(ctx: AdapterContext, gen: Gen, type: 'power.on' | 'power.off' | 'power.toggle', deadline: number): Promise<ActionResult> {
  const ch = channelOf(ctx)
  const dimmer = ctx.bool('dimmer', false)
  if (gen === 1) {
    const turn = type === 'power.on' ? 'on' : type === 'power.off' ? 'off' : 'toggle'
    const call = () => gen1Call(ctx, `/${dimmer ? 'light' : 'relay'}/${ch}`, { turn }, { deadline })
    const res = turn === 'toggle' ? await once(ctx, 'toggle', call) : await call()
    if (typeof res.ison !== 'boolean') throw new Refusal(UNREADABLE)
    const state: Record<string, unknown> = { power: res.ison }
    if (dimmer && typeof res.brightness === 'number') state.brightness = clamp(Math.round(res.brightness), 0, 100)
    return { ok: true, state }
  }
  if (dimmer) {
    if (type === 'power.toggle') {
      await once(ctx, 'toggle', () => rpc(ctx, 'Light.Toggle', { id: ch }, { deadline }))
      // The toggle is done. Light.Toggle does not say which way it went, so ask; if that
      // fails, still report success (never an error the hub would answer by toggling again).
      const st = await rpc(ctx, 'Light.GetStatus', { id: ch }, { deadline }).catch(() => null)
      if (!isRecord(st) || typeof st.output !== 'boolean') return { ok: true }
      const state: Record<string, unknown> = { power: st.output }
      if (typeof st.brightness === 'number') state.brightness = clamp(Math.round(st.brightness), 0, 100)
      return { ok: true, state }
    }
    const on = type === 'power.on'
    await rpc(ctx, 'Light.Set', { id: ch, on }, { deadline })
    return { ok: true, state: { power: on } }
  }
  if (type === 'power.toggle') {
    const res = await once(ctx, 'toggle', () => rpc(ctx, 'Switch.Toggle', { id: ch }, { deadline }))
    if (!isRecord(res) || typeof res.was_on !== 'boolean') return { ok: true }
    return { ok: true, state: { power: !res.was_on } }
  }
  const on = type === 'power.on'
  await rpc(ctx, 'Switch.Set', { id: ch, on }, { deadline })
  return { ok: true, state: { power: on } }
}

async function dim(ctx: AdapterContext, gen: Gen, action: Action): Promise<ActionResult> {
  const raw = Number(action.params.brightness)
  if (action.params.brightness === undefined || action.params.brightness === null || !Number.isFinite(raw)) {
    return { ok: false, error: 'No brightness given' }
  }
  const brightness = clamp(Math.round(raw), 0, 100)
  const ch = channelOf(ctx)
  if (gen === 1) {
    // First-generation dimmers accept 1..100; "0" means off.
    const res = await gen1Call(ctx, `/light/${ch}`, brightness === 0 ? { turn: 'off' } : { turn: 'on', brightness })
    const state: Record<string, unknown> = { power: typeof res.ison === 'boolean' ? res.ison : brightness > 0 }
    if (brightness > 0) state.brightness = typeof res.brightness === 'number' ? clamp(Math.round(res.brightness), 0, 100) : brightness
    return { ok: true, state }
  }
  if (brightness === 0) {
    await rpc(ctx, 'Light.Set', { id: ch, on: false })
    return { ok: true, state: { power: false } }
  }
  await rpc(ctx, 'Light.Set', { id: ch, on: true, brightness })
  return { ok: true, state: { power: true, brightness } }
}

// ---------------------------------------------------------------------------
// Gate / garage door
// ---------------------------------------------------------------------------

/** Close the relay for a moment, like pressing the gate's button. The Shelly itself releases it. */
async function pulse(ctx: AdapterContext, gen: Gen, relay: number, seconds: number, deadline: number): Promise<void> {
  if (gen === 1) await gen1Call(ctx, `/relay/${relay}`, { turn: 'on', timer: seconds }, { deadline })
  else await rpc(ctx, 'Switch.Set', { id: relay, on: true, toggle_after: seconds }, { deadline })
}

/** The sensor's raw level, or null when the Shelly has no such input (or it is not a switch-type input). */
async function readInput(ctx: AdapterContext, gen: Gen, input: number, deadline: number): Promise<boolean | null> {
  if (gen === 1) {
    const st = await gen1Call(ctx, '/status', {}, { deadline })
    const entry = Array.isArray(st.inputs) ? (st.inputs as unknown[])[input] : undefined
    if (!isRecord(entry) || entry.input === undefined || entry.input === null) return null
    return Number(entry.input) === 1
  }
  const st = await rpc(ctx, 'Input.GetStatus', { id: input }, { deadline })
  return isRecord(st) && typeof st.state === 'boolean' ? st.state : null
}

/** What the tile should say, from the sensor plus any movement the hub itself started. */
function gateNow(deviceId: string, closed: boolean | null): GateState {
  if (closed === null) return 'unknown'
  const mv = moves.get(deviceId)
  if (mv) {
    if (mv.goal === 'stopped') {
      if (!closed) return 'stopped'
    } else if (Date.now() < mv.until) {
      // Closing is confirmed the moment the sensor closes; opening only once the travel time has passed.
      if (!(mv.goal === 'closed' && closed)) return mv.goal === 'open' ? 'opening' : 'closing'
    }
    moves.delete(deviceId)
  }
  return closed ? 'closed' : 'open'
}

async function gate(ctx: AdapterContext, gen: Gen, type: 'gate.open' | 'gate.close' | 'gate.stop' | 'gate.pulse', deadline: number): Promise<ActionResult> {
  const id = ctx.device.id
  const mode = gateModeOf(ctx)
  const openRelay = channelOf(ctx)
  const input = sensorInput(ctx)
  const seconds = pulseSeconds(ctx)

  let closed: boolean | null = null
  if (input !== null) {
    const level = await readInput(ctx, gen, input, deadline)
    if (level !== null) {
      closed = closedFrom(ctx, level)
    } else if (mode === 'one-button' && type !== 'gate.pulse') {
      // A sensor was set up but gives nothing: do not guess which way a press would move the gate.
      return {
        ok: false,
        error: `The gate sensor on input ${input} gave no reading, so the hub cannot tell which way a press would move the gate. Check "Gate sensor input number" (on the Shelly that input must be set up as a switch), or use Pulse to press the button anyway.`,
      }
    }
  }
  const nothingToDo = (note: string): ActionResult => ({
    ok: true,
    result: { alreadyThere: true, note },
    state: { gate: gateNow(id, closed) },
  })

  let relay = openRelay
  let goal: Move['goal'] | null = null

  if (mode === 'one-button') {
    switch (type) {
      case 'gate.open':
        // On a step input a pulse to a gate that is not closed would stop or close it.
        if (closed === false) return nothingToDo('The sensor says the gate is not closed, so no press was sent. Use Pulse to step it by hand.')
        goal = 'open'
        break
      case 'gate.close':
        if (closed === true) return nothingToDo('The sensor says the gate is already closed, so no press was sent.')
        goal = 'closed'
        break
      case 'gate.stop':
        if (closed === true) return nothingToDo('The gate is closed, so there is nothing to stop.')
        goal = 'stopped'
        break
      case 'gate.pulse':
        goal = closed === null ? null : closed ? 'open' : 'closed'
        break
    }
  } else {
    const closeRelay = optionalIndex(ctx.device.config.closeChannel) ?? 1
    const stopRelay = optionalIndex(ctx.device.config.stopChannel)
    switch (type) {
      case 'gate.open':
        goal = 'open'
        break
      case 'gate.close':
        if (closed === true) return nothingToDo('The sensor says the gate is already closed, so no press was sent.')
        relay = closeRelay
        goal = 'closed'
        break
      case 'gate.stop':
        if (stopRelay === null) return { ok: false, error: 'No relay is set for STOP on this gate, so it cannot be stopped from here.' }
        relay = stopRelay
        goal = 'stopped'
        break
      case 'gate.pulse':
        if (closed === null) return { ok: false, error: 'This gate has separate relays for open and close. Use Open or Close.' }
        relay = closed ? openRelay : closeRelay
        goal = closed ? 'open' : 'closed'
        break
    }
  }

  // Separate OPEN / CLOSE / STOP inputs can be pressed again without harm; a step input cannot.
  if (mode === 'one-button') await once(ctx, 'press', () => pulse(ctx, gen, relay, seconds, deadline))
  else await pulse(ctx, gen, relay, seconds, deadline)

  if (closed === null || goal === null) {
    moves.delete(id)
    return { ok: true, result: { relay, pulseSeconds: seconds }, state: { gate: 'unknown' } }
  }
  moves.set(id, { goal, until: goal === 'stopped' ? Number.POSITIVE_INFINITY : Date.now() + travelMs(ctx) })
  const shown: GateState = goal === 'open' ? 'opening' : goal === 'closed' ? 'closing' : 'stopped'
  return { ok: true, result: { relay, pulseSeconds: seconds }, state: { gate: shown } }
}

// ---------------------------------------------------------------------------
// WiFi
// ---------------------------------------------------------------------------

/** What the numbers in WiFi.Scan's "auth" field stand for. */
const WIFI_SECURITY = ['Open', 'WEP', 'WPA', 'WPA2', 'WPA/WPA2', 'WPA2 Enterprise']

/**
 * A WiFi change makes the device drop its connection about a second later, so
 * the reply often never arrives. A lost reply after the request went out is
 * not a failure; the hub confirms by finding the device on the new network.
 */
async function replyMayBeLost(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return true
  } catch (err) {
    if (err instanceof Refusal) throw err
    if (AMBIGUOUS.test(messageOf(err))) return false
    throw err
  }
}

/** The house network this path is on, to keep as the fallback when moving to another one. */
function networkBeingLeft(ctx: AdapterContext, newSsid: string): { ssid: string; password: string } | null {
  const id = ctx.path.wifiNetworkId
  const w = id ? ctx.wifi(id) : undefined
  return w && w.ssid && w.password && w.ssid !== newSsid ? { ssid: w.ssid, password: w.password } : null
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const adapter: Adapter = {
  family: 'shelly',

  describe(): FamilyDescriptor {
    return {
      id: 'shelly',
      label: 'Shelly relay or dimmer',
      tagline: 'Shelly switches, dimmers and gate relays on the house WiFi. Works without the Shelly cloud.',
      kinds: ['light', 'switch', 'gate'],
      fields: [
        {
          name: 'generation',
          label: 'Which Shelly is it',
          type: 'select',
          default: 'auto',
          options: [
            { value: 'auto', label: 'Find out automatically' },
            { value: 'gen1', label: 'First generation (Shelly 1, 1PM, 2.5, Dimmer 2)' },
            { value: 'gen2', label: 'Plus, Pro, Gen3 or Gen4' },
          ],
          help: 'Older and newer Shellys are spoken to in different ways. Leave this on automatic unless the hub gets it wrong.',
        },
        {
          name: 'password',
          label: 'Password',
          type: 'password',
          secret: true,
          help: 'Only if you set one on the Shelly itself (on its own page under Settings: "Authentication" or "Restrict login"). Leave empty otherwise. Stored encrypted on the hub.',
        },
        {
          name: 'username',
          label: 'Username',
          type: 'text',
          default: 'admin',
          help: 'Only first-generation Shellys let you choose a username. Newer ones always use "admin".',
        },
        {
          name: 'channel',
          label: 'Output number',
          type: 'number',
          default: 0,
          help: 'Which relay on the Shelly this tile controls. Counting starts at 0: a single-relay Shelly is 0, the second relay of a two-relay model is 1. For a gate, this is the relay wired to the gate’s button terminal (or to its OPEN terminal).',
        },
        {
          name: 'dimmer',
          label: 'This is a dimmer',
          type: 'toggle',
          default: false,
          help: 'Switch on for Shelly Dimmer models so the brightness slider appears. Leave off for plain on/off relays. Not used for gates.',
        },
        {
          name: 'gateMode',
          label: 'Gate wiring',
          type: 'select',
          default: 'one-button',
          options: [
            { value: 'one-button', label: 'One button: each press steps open, stop, close' },
            { value: 'separate-relays', label: 'Separate relays for open and close' },
          ],
          help: 'Gates only. "One button" is a single relay across the gate board’s push-button (step) terminal. "Separate relays" needs a Shelly with two or more relays, wired to the board’s OPEN and CLOSE terminals.',
        },
        {
          name: 'closeChannel',
          label: 'Output number for CLOSE',
          type: 'number',
          default: 1,
          showWhen: { field: 'gateMode', equals: 'separate-relays' },
          help: 'The relay wired to the gate board’s CLOSE terminal. "Output number" above is then the OPEN relay.',
        },
        {
          name: 'stopChannel',
          label: 'Output number for STOP',
          type: 'number',
          showWhen: { field: 'gateMode', equals: 'separate-relays' },
          help: 'The relay wired to the gate board’s STOP terminal. Leave empty if there is none; the Stop button then says so instead of guessing.',
        },
        {
          name: 'pulseMs',
          label: 'Press length (milliseconds)',
          type: 'number',
          default: 1000,
          help: 'Gates only. How long the relay stays closed, like holding the button down. The Shelly counts in whole seconds, so this is rounded up: 1000 is one second, which suits most gate boards.',
        },
        {
          name: 'inputId',
          label: 'Gate sensor input number',
          type: 'number',
          help: 'Gates only. If a magnetic door sensor is wired to the Shelly’s switch input (SW), enter that input’s number: usually 0, or 100 on a Shelly Plus Add-On. The app then shows whether the gate is closed. Leave empty if there is no sensor. Important: on the Shelly’s own settings page choose the "Detached" switch mode for that input, so the sensor is only read and never switches the relay by itself.',
        },
        {
          name: 'inputClosedMeans',
          label: 'When the gate is closed, the sensor input is',
          type: 'select',
          default: 'on',
          options: [
            { value: 'on', label: 'On (the usual case: magnet next to the sensor)' },
            { value: 'off', label: 'Off' },
          ],
          help: 'If the app shows open when the gate is closed, switch this over.',
        },
        {
          name: 'travelSeconds',
          label: 'Seconds the gate takes to open or close',
          type: 'number',
          default: 20,
          help: 'Used with a gate sensor. The app shows "opening" or "closing" for this long, then reports what the sensor says. At most 85.',
        },
        {
          name: 'https',
          label: 'Always use a secure connection',
          type: 'toggle',
          default: false,
          help: 'Shelly firmware 1.8 and later only answers over a secure connection (HTTPS). The hub notices this by itself, so you can normally leave this off.',
        },
      ],
      pathKinds: ['lan'],
      defaultPort: 80,
      capabilities: ['power', 'dim', 'gate', 'gate-state', 'wifi', 'wifi-scan', 'reboot', 'state'],
      notes: [
        'Works over the house network only. A Shelly has no SIM, so while its WiFi is down the hub cannot reach it. Giving it a second house network (for example a 4G router) as fallback keeps it reachable.',
        'On, off, brightness and restart work on all models. Colour bulbs and RGBW controllers are not covered: only on/off and brightness.',
        'Moving a Shelly to another house WiFi works from here. When the network it is leaving is one of the stored house networks, that network is kept on the Shelly as its fallback, so a wrong password does not strand it. After a move it asks the router for its address, so a fixed address set on the Shelly is replaced.',
        'Listing the WiFi networks a Shelly can see works on Plus, Pro, Gen3 and Gen4 models, not on first-generation ones.',
        'For a gate or garage door: wire the relay’s contacts across the gate board’s push-button terminal, next to the wall button, and set the Shelly’s power-on default to OFF so a power cut cannot press the button. Each tap closes the relay for the press length, then the Shelly releases it by itself.',
        'Without a sensor the hub cannot tell whether a gate is open. On a one-button gate Open, Close and Stop then all send the same press, and Stop will start a gate that is standing still.',
        'With one magnetic sensor at the closed position the app knows closed from not closed. It will not press the button of a gate that is already where you asked, and it reports "open" for a gate that is only part-way. It cannot tell a moving gate from one standing open, so on a one-button gate Stop still presses the button whenever the gate is not closed.',
        'If a gate sensor is wired to the Shelly’s switch input, choose the "Detached" switch mode for it on the Shelly’s own settings page. Otherwise the sensor switches the relay every time the gate moves, which presses the gate’s button again.',
        'If the answer to a gate press or a toggle is lost, the hub does not send it again, so a gate is never pressed twice by mistake. Check the gate, then try again.',
        'If a password is wrong the hub waits a minute before trying again, because newer Shellys lock out logins after repeated wrong attempts.',
        'On firmware 1.8 and later the connection is encrypted with the Shelly’s own certificate. The hub accepts that certificate without checking who issued it, so keep the Shelly on your own network.',
      ],
    }
  },

  capabilities(config: Record<string, unknown>, kind: DeviceKind): Capability[] {
    const caps: Capability[] = []
    if (kind === 'gate') {
      caps.push('gate')
      if (optionalIndex(config.inputId) !== null) caps.push('gate-state')
    } else {
      caps.push('power')
      if (isOn(config.dimmer)) caps.push('dim')
    }
    caps.push('wifi')
    if (generationSetting(config) !== 'gen1') caps.push('wifi-scan')
    caps.push('reboot', 'state')
    return caps
  },

  async probe(ctx): Promise<ProbeResult> {
    const started = Date.now()
    // The whole check, login included, has to fit in the hub's limit for one check (timeout + 500 ms).
    const deadline = started + ctx.timeoutMs
    const plain = (err: unknown): string => {
      const m = messageOf(err)
      return /timed out/i.test(m) || m === TOO_SLOW ? 'The Shelly did not answer in time' : m
    }

    let id: Identity
    try {
      id = await identify(ctx, { deadline })
    } catch (err) {
      return { ok: false, latencyMs: null, error: plain(err) }
    }
    const latencyMs = Date.now() - started
    const set = generationSetting(ctx.device.config)
    if (set === 'gen1' && id.gen === 2) {
      return { ok: false, latencyMs: null, error: 'This is a newer Shelly (Plus, Pro, Gen3 or Gen4) but the device is set to first generation. Change "Which Shelly is it" to automatic.' }
    }
    if (set === 'gen2' && id.gen === 1) {
      return { ok: false, latencyMs: null, error: 'This is a first-generation Shelly but the device is set to Plus / Pro. Change "Which Shelly is it" to automatic.' }
    }

    const info = { ...id.info }
    if (!id.auth) return { ok: true, latencyMs, info }
    if (!ctx.secret('password')) return { ok: false, latencyMs: null, error: NEEDS_PASSWORD }

    // The Shelly has a password: make one cheap logged-in call so a wrong password shows up here.
    try {
      const loginDeadline = Math.max(deadline, Date.now() + 450)
      if (id.gen === 1) {
        const st = await gen1Call(ctx, '/status', {}, { deadline: loginDeadline })
        if (isRecord(st.wifi_sta)) Object.assign(info, wifiState(st.wifi_sta.ssid, st.wifi_sta.rssi))
      } else {
        const st = await rpc(ctx, 'WiFi.GetStatus', {}, { deadline: loginDeadline })
        if (isRecord(st)) Object.assign(info, wifiState(st.ssid, st.rssi))
      }
    } catch (err) {
      // "Slow down" means it is there and listening; the password is simply not checked this time.
      if (err instanceof Refusal && err.code === 'busy') return { ok: true, latencyMs, info }
      return { ok: false, latencyMs: null, error: plain(err) }
    }
    return { ok: true, latencyMs, info }
  },

  async readState(ctx): Promise<Record<string, unknown>> {
    const gen = await generationOf(ctx)
    const isGate = ctx.device.kind === 'gate'
    const ch = channelOf(ctx)
    const dimmer = ctx.bool('dimmer', false)
    const sensor = sensorInput(ctx)
    const inputIndex = sensor ?? ch
    const out: Record<string, unknown> = {}
    let input: boolean | null = null

    if (gen === 1) {
      const st = await gen1Call(ctx, '/status')
      const list = dimmer ? st.lights : st.relays
      const comp = Array.isArray(list) ? (list as unknown[])[ch] : undefined
      if (!isGate && isRecord(comp)) {
        if (typeof comp.ison === 'boolean') out.power = comp.ison
        if (dimmer && typeof comp.brightness === 'number') out.brightness = clamp(Math.round(comp.brightness), 0, 100)
      }
      if (isRecord(st.wifi_sta)) Object.assign(out, wifiState(st.wifi_sta.ssid, st.wifi_sta.rssi))
      const entry = Array.isArray(st.inputs) ? (st.inputs as unknown[])[inputIndex] : undefined
      if (isRecord(entry) && entry.input !== undefined && entry.input !== null) input = Number(entry.input) === 1
      if (typeof st.mac === 'string') out.mac = st.mac
    } else {
      const st = await rpc(ctx, 'Shelly.GetStatus')
      if (!isRecord(st)) throw new Refusal(UNREADABLE)
      const comp = st[`${dimmer ? 'light' : 'switch'}:${ch}`]
      if (!isGate && isRecord(comp)) {
        if (typeof comp.output === 'boolean') out.power = comp.output
        if (dimmer && typeof comp.brightness === 'number') out.brightness = clamp(Math.round(comp.brightness), 0, 100)
      }
      if (isRecord(st.wifi)) Object.assign(out, wifiState(st.wifi.ssid, st.wifi.rssi))
      const entry = st[`input:${inputIndex}`]
      if (isRecord(entry) && typeof entry.state === 'boolean') input = entry.state
    }

    if (input !== null) out.input = input
    if (isGate) out.gate = sensor === null ? 'unknown' : gateNow(ctx.device.id, input === null ? null : closedFrom(ctx, input))
    return out
  },

  async execute(ctx, action: Action): Promise<ActionResult> {
    const isGate = ctx.device.kind === 'gate'
    const deadline = actionDeadline(ctx)
    try {
      switch (action.type) {
        case 'power.on':
        case 'power.off':
        case 'power.toggle':
          if (isGate) return unsupported(action)
          return await power(ctx, await generationOf(ctx, deadline), action.type, deadline)
        case 'dim.set':
          if (isGate || !ctx.bool('dimmer', false)) return unsupported(action)
          return await dim(ctx, await generationOf(ctx), action)
        case 'gate.open':
        case 'gate.close':
        case 'gate.stop':
        case 'gate.pulse':
          if (!isGate) return unsupported(action)
          return await gate(ctx, await generationOf(ctx, deadline), action.type, deadline)
        case 'reboot': {
          const gen = await generationOf(ctx)
          if (gen === 1) await gen1Call(ctx, '/reboot')
          else await rpc(ctx, 'Shelly.Reboot')
          return { ok: true, result: { restarting: true } }
        }
        default:
          return unsupported(action)
      }
    } catch (err) {
      // The device said no: report it. Anything else is a transport failure and goes up so the hub can fail over.
      if (err instanceof Refusal) return { ok: false, error: err.message }
      throw err
    }
  },

  async setWifi(ctx, target): Promise<ActionResult> {
    const ssid = (target.ssid ?? '').trim()
    const password = target.password ?? ''
    if (!ssid) return { ok: false, error: 'No network name given' }
    if (!password) return { ok: false, error: `No password given for "${ssid}"` }
    const leaving = networkBeingLeft(ctx, ssid)
    // Whatever goes wrong, neither WiFi password may end up in a message.
    const scrub = (text: string): string => {
      let out = text.split(password).join('***')
      if (leaving) out = out.split(leaving.password).join('***')
      return out
    }
    // Leave room for both steps inside the hub's own limit for this action (2 x timeout), login round-trips included.
    const moveTimeout = Math.min(ctx.timeoutMs, 4000)
    const deadline = Date.now() + Math.max(1000, ctx.timeoutMs * 2 - 1000)

    try {
      // First make sure a Shelly is answering at this address right now. No WiFi password is sent to
      // anything else, and a reply that is lost afterwards can then only mean "it has already left";
      // without this, a Shelly that was never reached would be reported as told to move.
      const id = await identify(ctx, { deadline })
      const set = generationSetting(ctx.device.config)
      const gen: Gen = set === 'gen1' ? 1 : set === 'gen2' ? 2 : id.gen
      let fallback: string | null = null
      let replied: boolean

      if (gen === 1) {
        if (leaving) {
          // Save the fallback first, while the device is still listening on the old network.
          try {
            await gen1Call(ctx, '/settings/sta1', { enabled: 1, ssid: leaving.ssid, key: leaving.password, ipv4_method: 'dhcp' }, { post: true, timeoutMs: moveTimeout, deadline })
            fallback = leaving.ssid
          } catch (err) {
            if (!(err instanceof Refusal) || err.code !== 'other') throw err
            ctx.log.warn('could not save the fallback network on the Shelly; moving it anyway')
          }
        }
        replied = await replyMayBeLost(() =>
          gen1Call(ctx, '/settings/sta', { enabled: 1, ssid, key: password, ipv4_method: 'dhcp' }, { post: true, timeoutMs: moveTimeout, deadline }),
        )
      } else {
        const config: Record<string, unknown> = { sta: { ssid, pass: password, enable: true, ipv4mode: 'dhcp' } }
        if (leaving) {
          config.sta1 = { ssid: leaving.ssid, pass: leaving.password, enable: true }
          fallback = leaving.ssid
        }
        replied = await replyMayBeLost(() => rpc(ctx, 'WiFi.SetConfig', { config }, { post: true, timeoutMs: moveTimeout, deadline }))
      }
      return { ok: true, result: { ssid, fallback, replied }, state: { wifi: ssid } }
    } catch (err) {
      if (err instanceof Refusal) return { ok: false, error: scrub(err.message) }
      throw new Error(scrub(messageOf(err)))
    }
  },

  async scanWifi(ctx): Promise<WifiScanEntry[]> {
    // A scan takes a few seconds; the hub allows three times the normal limit for it.
    const deadline = Date.now() + Math.max(1000, ctx.timeoutMs * 3 - 500)
    const gen = await generationOf(ctx, deadline)
    if (gen === 1) throw new Error('First-generation Shellys cannot list the WiFi networks around them.')
    const res = await rpc(ctx, 'WiFi.Scan', {}, { timeoutMs: ctx.timeoutMs * 2, deadline })
    const results = isRecord(res) && Array.isArray(res.results) ? (res.results as unknown[]) : []
    const best = new Map<string, WifiScanEntry>()
    for (const r of results) {
      if (!isRecord(r) || typeof r.ssid !== 'string' || !r.ssid) continue
      const signal = signalPercent(r.rssi)
      const security = typeof r.auth === 'number' ? WIFI_SECURITY[r.auth] ?? null : null
      const seen = best.get(r.ssid)
      if (!seen || (signal ?? -1) > (seen.signal ?? -1)) best.set(r.ssid, { ssid: r.ssid, signal, security })
    }
    return [...best.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1))
  },

  /**
   * Shellys announce themselves on the network (mDNS); the hub already has a
   * scanner for that, so this only narrows its result to this family. It is
   * what lets the hub find a Shelly at its new address after a WiFi move.
   */
  async discover(seconds: number, log: Logger): Promise<DiscoveredDevice[]> {
    const { mdnsScan } = await import('../discovery.ts')
    const found = await mdnsScan(seconds, log)
    return found.filter((d) => d.family === 'shelly')
  },
}

export default adapter
