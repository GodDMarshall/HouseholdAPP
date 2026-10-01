/**
 * Hikvision cameras (and Hik-Connect branded ones, 4G models included) over
 * ISAPI — the camera's own HTTP interface: XML bodies, HTTP digest login.
 *
 * Things that are easy to get wrong, and how they are handled here:
 *  - Stream ids are channel × 100 + stream (101 main, 102 sub); PTZ ids are the
 *    plain video channel (1). Mixing them up gets "badXmlContent" from the camera.
 *  - ISAPI has no PTZ "stop": stopping is a continuous move at speed zero. Every
 *    move therefore gets a hub-side auto-stop, so a lost "release" from the phone
 *    cannot leave the camera turning.
 *  - A wrong password counts towards the camera's login lock, and the hub checks
 *    devices every few seconds. After a failed login the same login is not tried
 *    again for a while (or at all, once the camera says tries are running out).
 *  - The WiFi PUT replaces the whole block: read it first, change only what moves
 *    the camera, send the rest back as it was. The camera usually leaves the
 *    network before it answers, so silence after the PUT is checked, not assumed.
 *  - Old firmware answers on the same paths without the /ISAPI prefix.
 *  - "This model does not have it" is never remembered for good: a camera that is
 *    still starting up answers the same way, so the question is asked again later.
 *  - A stop that did not get through is retried, and a pending auto-stop is only
 *    given up once the camera has confirmed the command that replaces it.
 */
import crypto from 'node:crypto'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import type { Action, Capability, DeviceKind, FamilyDescriptor } from '@house/shared'
import { request, type Response as HttpResponse } from '../lib/http.ts'
import {
  FIELD,
  baseUrl,
  clamp,
  requireHost,
  unsupported,
  userInfo,
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type ProbeResult,
  type Snapshot,
  type WifiScanEntry,
} from './types.ts'

const NS = 'http://www.isapi.org/ver20/XMLSchema'
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>'

/** A held move is stopped by the hub after this long even if no "stop" arrives. */
const MAX_MOVE_SECONDS = 30
/** After a wrong password, wait this long before the same login is tried again. */
const LOGIN_RETRY_MS = 10 * 60_000
/** Stop for good once the camera says this few tries are left before it locks. */
const TRIES_TO_SPARE = 2
/** When the camera does not say how many tries are left, stop after this many. */
const BLIND_TRIES = 2
/** Lock length assumed when the camera says "locked" without a time. */
const DEFAULT_LOCK_SECONDS = 30 * 60
/** A WiFi list read this recently is good enough to check a move against. */
const SCAN_FRESH_MS = 2 * 60_000
/** "This model does not have it" is believed for this long, then asked again. */
const RECHECK_MS = 10 * 60_000
/** A stop that did not get through is sent again after these waits (seconds), then given up. */
const STOP_RETRY_SECONDS = [0.5, 1.5, 4, 10]

const WRONG_LOGIN = 'Wrong username or password'
const NOT_HIKVISION =
  'Something answered at this address, but not as a Hikvision camera. Check the address and port, and that ISAPI is switched on in the camera’s settings.'
const NOT_ACTIVATED = 'The camera has not been set up yet. Give it a password with its own app first, then add it here.'
const NO_PTZ = 'The camera did not accept the move. If it is a fixed camera, turn off “This camera can turn and zoom”.'
const NO_WIFI = 'This camera model has no WiFi, so the hub cannot see or change its WiFi network.'
const NO_SCAN = 'This camera cannot list the WiFi networks around it.'
const USE_HTTPS = 'The camera only answers on its secure address (https://). Turn on “Use HTTPS” for this camera.'
const SENT_ELSEWHERE = 'The camera sent the hub to a different address instead of answering. Check the address and port of this connection.'
const STARTING_UP = 'The camera answered, but it is busy or still starting up. It should be back in a minute.'

type Xml = Record<string, unknown>

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const LIST_TAGS = new Set(['NetworkInterface', 'accessPoint', 'PTZPreset'])

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Keep every value as text: an SSID of "12345" or a channel of "06" must survive a round trip.
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => LIST_TAGS.has(name),
})

const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', suppressEmptyNode: false })

function parseXml(text: string): Xml {
  try {
    const parsed: unknown = parser.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Xml) : {}
  } catch {
    return {}
  }
}

function node(v: unknown): Xml | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Xml) : null
}

function list(v: unknown): Xml[] {
  return Array.isArray(v) ? v.map(node).filter((x): x is Xml => x !== null) : []
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
}

function int(v: unknown): number | null {
  const s = str(v)
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  return Math.round(Number(s))
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The camera answered, but said no. `auth` = login refused, `missing` = this
 * model does not have the feature, `refused` = anything else it turned down.
 * Transport problems (no answer at all) stay plain Errors so the hub fails over.
 */
class IsapiError extends Error {
  constructor(
    public readonly kind: 'auth' | 'missing' | 'refused',
    message: string,
  ) {
    super(message)
  }
}

interface Status {
  code: number | null
  text: string
  sub: string
  lock: string
  retryTimes: number | null
  lockSeconds: number | null
}

/** The <ResponseStatus> the camera sends for writes and for every error. */
function statusOf(body: string): Status | null {
  if (!body.includes('ResponseStatus')) return null
  const rs = node(parseXml(body).ResponseStatus)
  if (!rs) return null
  return {
    code: int(rs.statusCode),
    text: str(rs.statusString),
    sub: str(rs.subStatusCode),
    lock: str(rs.lockStatus).toLowerCase(),
    retryTimes: int(rs.retryTimes),
    lockSeconds: int(rs.resLockTime),
  }
}

/** A camera set to "HTTPS only" answers plain requests by pointing at its secure address. */
function redirectText(res: HttpResponse): string | null {
  if (res.status < 300 || res.status >= 400) return null
  return /^https:/i.test(res.headers.location ?? '') ? USE_HTTPS : SENT_ELSEWHERE
}

/** Why the camera turned a request down, or null when it accepted it. */
function refusal(res: HttpResponse, missing: string): IsapiError | null {
  const st = statusOf(res.text())
  const sub = st?.sub.toLowerCase() ?? ''
  const http2xx = res.status >= 200 && res.status < 300
  // statusCode 0/1 = OK, 7 = OK but the camera wants a restart.
  if (http2xx && (!st || st.code === null || st.code <= 1 || st.code === 7)) return null
  if (sub === 'notactivated') return new IsapiError('refused', NOT_ACTIVATED)
  const moved = redirectText(res)
  if (moved) return new IsapiError('refused', moved)
  if (res.status === 404 || res.status === 405 || res.status === 501 || sub === 'notsupport' || sub === 'methodnotallowed') {
    return new IsapiError('missing', missing)
  }
  if (sub === 'lowprivilege' || res.status === 403) {
    return new IsapiError('refused', 'This login is not allowed to do that on the camera. Use the admin login, or give this user the permission in the camera’s settings.')
  }
  if (sub === 'upgrading') return new IsapiError('refused', 'The camera is updating its software. Try again in a few minutes.')
  if (st?.code === 2 || sub === 'devicebusy') return new IsapiError('refused', 'The camera is busy. Try again in a moment.')
  const detail = [st?.text, st?.sub].filter(Boolean).join(', ')
  if (st?.code === 5 || st?.code === 6) {
    return new IsapiError('refused', `The camera did not accept the request the way this hub sends it (${detail || 'invalid content'}).`)
  }
  return new IsapiError('refused', detail ? `The camera refused: ${detail}` : `The camera answered with an error (HTTP ${res.status})`)
}

/** Parsed XML under `root`, or a thrown refusal. An empty root (<PTZPresetList/>) is an empty object. */
function xmlRoot(res: HttpResponse, root: string, missing: string): Xml {
  const bad = refusal(res, missing)
  if (bad) throw bad
  const parsed = parseXml(res.text())
  if (!(root in parsed)) throw new IsapiError('refused', 'The camera sent an answer this hub could not read.')
  return node(parsed[root]) ?? {}
}

/** Turn the HTTP client's wording into a sentence for the owner. Never contains credentials. */
function plain(err: unknown): Error {
  if (err instanceof IsapiError) return err
  const msg = err instanceof Error ? err.message : String(err)
  const timed = /^Timed out after (\d+) ms/i.exec(msg)
  if (timed) {
    const secs = Math.max(1, Math.round(Number(timed[1]) / 1000))
    return new Error(`The camera did not answer within ${secs} second${secs === 1 ? '' : 's'}`)
  }
  if (/EPROTO|wrong version number|SSL routines|ERR_SSL|ERR_TLS/i.test(msg)) {
    return new Error('The camera did not accept a secure (HTTPS) connection. Check the “Use HTTPS” switch and the port.')
  }
  if (/socket hang up|ECONNRESET/i.test(msg)) return new Error('The camera closed the connection without answering')
  return err instanceof Error ? err : new Error(msg)
}

/** The request went out and nothing came back — as opposed to "could not connect at all". */
function wentSilent(err: unknown): boolean {
  if (err instanceof IsapiError) return false
  const msg = err instanceof Error ? err.message : String(err)
  return /timed out|closed the connection|socket hang up|ECONNRESET/i.test(msg)
}

// ---------------------------------------------------------------------------
// Per-camera memory (never persisted, never logged)
// ---------------------------------------------------------------------------

interface AccessPoint {
  ssid: string
  signal: number | null
  mode: string
  connected: boolean
}

interface Session {
  /** true = old firmware without the /ISAPI prefix, null = not known yet. */
  legacy: boolean | null
  /** Network interface that owns the WiFi radio. undefined = not looked up, null = no WiFi. */
  wifiInterface: string | null | undefined
  /** When a "no WiFi" finding is looked at again. */
  wifiRecheckAt: number
  /** Fingerprint of the login that last worked. */
  goodLogin: string | null
  /** Fingerprint of the login the camera refused, and when it may be tried again. */
  badLogin: { login: string; count: number; retryAt: number } | null
  /** The camera said the account is locked until this time. */
  lockedUntil: number
  /** The request that is finding out whether the login works; others wait for it. */
  firstLogin: Promise<unknown> | null
  /** Features this model answered "not here" for, and when each is asked again. */
  absent: Map<string, number>
  /** The last WiFi list the camera gave. */
  seen: { at: number; list: AccessPoint[] } | null
}

const sessions = new Map<string, Session>()
const autoStops = new Map<string, NodeJS.Timeout>()
const ptzTurns = new Map<string, Promise<void>>()
/** Counts the owner's PTZ commands per camera, so a queued auto-stop can tell it has been overtaken. */
const ptzEpoch = new Map<string, number>()
/** Cameras the hub has set moving and has not yet seen stop. */
const turning = new Set<string>()

function sessionFor(deviceId: string, base: string): Session {
  // Keyed by address too: the hub also probes other addresses with this device's
  // login when it looks for a camera that moved, and those are different cameras.
  const key = `${deviceId}|${base}`
  let s = sessions.get(key)
  if (!s) {
    s = { legacy: null, wifiInterface: undefined, wifiRecheckAt: 0, goodLogin: null, badLogin: null, lockedUntil: 0, firstLogin: null, absent: new Map(), seen: null }
    sessions.set(key, s)
  }
  return s
}

/**
 * http(s)://address:port for the connection in use. The app fills in port 80 for
 * every new connection; with "Use HTTPS" on, that default means the usual secure
 * port (443). Any other port the owner typed is used as it is.
 */
export function hikvisionBaseUrl(ctx: AdapterContext): string {
  const https = ctx.bool('https', false)
  const port = ctx.path.port
  if (https && (port === null || port === undefined || port === 80)) {
    return baseUrl({ ...ctx, path: { ...ctx.path, port: 443 } }, { https: true })
  }
  return baseUrl(ctx, { https })
}

function sessionOf(ctx: AdapterContext): Session {
  return sessionFor(ctx.device.id, hikvisionBaseUrl(ctx))
}

/** Forget everything remembered about cameras (login guards, pending auto-stops). For tests and restarts. */
export function resetHikvisionSessions(): void {
  for (const t of autoStops.values()) clearTimeout(t)
  autoStops.clear()
  ptzTurns.clear()
  ptzEpoch.clear()
  turning.clear()
  sessions.clear()
}

/**
 * One-way fingerprint of a login. Includes the device's last-saved time, so
 * saving the camera again in the app lets the hub try a refused login once more.
 */
function loginMark(ctx: AdapterContext, username: string, password: string): string {
  return crypto.createHash('sha256').update(`${username}\n${password}\n${ctx.device.updatedAt}`).digest('hex')
}

function minutes(ms: number): string {
  const n = Math.max(1, Math.ceil(ms / 60_000))
  return `${n} minute${n === 1 ? '' : 's'}`
}

function lockedText(ms: number): string {
  return `The camera has locked this login after too many wrong passwords. It unlocks in about ${minutes(ms)}.`
}

function refuseIfBlocked(s: Session, login: string): void {
  const now = Date.now()
  if (now < s.lockedUntil) throw new IsapiError('auth', lockedText(s.lockedUntil - now))
  const bad = s.badLogin
  if (!bad || bad.login !== login || now >= bad.retryAt) return
  const wait = Number.isFinite(bad.retryAt) ? `will not try again for ${minutes(bad.retryAt - now)}` : 'has stopped trying'
  throw new IsapiError('auth', `${WRONG_LOGIN}. The hub ${wait}, so the camera does not lock this login. Enter the right password here and save.`)
}

/** A 401 that came back after the login was sent: remember it so the hub does not hammer the camera. */
function loginFailed(s: Session, login: string, res: HttpResponse): IsapiError {
  const st = statusOf(res.text())
  const now = Date.now()
  s.goodLogin = null
  if (st?.sub.toLowerCase() === 'notactivated') return new IsapiError('refused', NOT_ACTIVATED)
  if (st?.lock === 'locked') {
    // Locked says nothing about whether this password is right: someone else may have caused it.
    const secs = st.lockSeconds && st.lockSeconds > 0 ? st.lockSeconds : DEFAULT_LOCK_SECONDS
    s.lockedUntil = now + secs * 1000
    return new IsapiError('auth', lockedText(secs * 1000))
  }
  const count = (s.badLogin?.login === login ? s.badLogin.count : 0) + 1
  const left = st?.retryTimes ?? null
  const giveUp = left !== null ? left <= TRIES_TO_SPARE : count >= BLIND_TRIES
  s.badLogin = { login, count, retryAt: giveUp ? Number.POSITIVE_INFINITY : now + LOGIN_RETRY_MS }
  if (left === null) return new IsapiError('auth', WRONG_LOGIN)
  return new IsapiError('auth', `${WRONG_LOGIN} (the camera allows ${left} more ${left === 1 ? 'try' : 'tries'} before it locks this login)`)
}

// ---------------------------------------------------------------------------
// One ISAPI call
// ---------------------------------------------------------------------------

interface CallOptions {
  body?: string
  timeoutMs?: number
}

const noop = (): void => undefined

/**
 * Send one request to the camera on the current path. Returns the camera's
 * answer whatever its status, except a refused login, which throws
 * IsapiError('auth'). No answer at all throws the HTTP client's Error.
 */
async function isapi(ctx: AdapterContext, method: 'GET' | 'PUT', path: string, opts: CallOptions = {}): Promise<HttpResponse> {
  const base = hikvisionBaseUrl(ctx)
  const s = sessionFor(ctx.device.id, base)
  const username = ctx.str('username').trim()
  const password = ctx.secret('password') ?? ''
  if (!username || !password) throw new IsapiError('auth', 'Enter the camera’s username and password first')
  const login = loginMark(ctx, username, password)

  // Until this login has worked once, go one request at a time: several
  // parallel requests with a wrong password would each count towards the lock.
  while (s.goodLogin !== login && s.firstLogin) await s.firstLogin.then(noop, noop)
  refuseIfBlocked(s, login)

  const run = async (): Promise<HttpResponse> => {
    const headers: Record<string, string> = {}
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/xml; charset="UTF-8"'
      // Without this Node sends the body chunked, which camera web servers do not read.
      headers['Content-Length'] = String(Buffer.byteLength(opts.body))
    } else if (method === 'PUT') headers['Content-Length'] = '0'
    const go = (p: string) =>
      request(base + p, { method, headers, body: opts.body, digest: { username, password, allowBasic: ctx.path.kind !== 'cellular' }, insecure: true, timeoutMs: opts.timeoutMs ?? ctx.timeoutMs })
    const old = (p: string) => p.replace(/^\/ISAPI\//, '/')

    let res = await go(s.legacy ? old(path) : path)
    // "stale" means the login was right but the one-time number expired: ask again once.
    if (res.status === 401 && /stale\s*=\s*"?true/i.test(res.headers['www-authenticate'] ?? '')) res = await go(s.legacy ? old(path) : path)
    if (s.legacy === null && path.startsWith('/ISAPI/')) {
      if (res.status >= 200 && res.status < 300) s.legacy = false
      else if (res.status === 404) {
        const alt = await go(old(path))
        // Only an XML or picture answer counts: a web page served for any address is not old firmware.
        const isapiLike = /xml|^image\//i.test(alt.headers['content-type'] ?? '')
        if (alt.status >= 200 && alt.status < 300 && isapiLike) {
          s.legacy = true
          res = alt
        } else if (alt.status === 401) res = alt
      }
    }
    if (res.status === 401) throw loginFailed(s, login, res)
    s.goodLogin = login
    s.badLogin = null
    return res
  }

  if (s.goodLogin === login) return run()
  const first = run()
  s.firstLogin = first
  try {
    return await first
  } finally {
    if (s.firstLogin === first) s.firstLogin = null
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function flag(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
}

/** Video channel: 1 on a camera, the camera's number on a recorder. */
function channelOf(ctx: AdapterContext): number {
  const n = Math.floor(ctx.num('channel', 1))
  return n >= 1 && n <= 999 ? n : 1
}

function validPort(v: unknown): number | null {
  const n = Number(v)
  return v !== null && v !== undefined && v !== '' && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

/** A connection may carry its own video port (extra.rtspPort) when the router forwards a different one. */
function rtspPortOf(ctx: AdapterContext): number {
  return validPort(ctx.path.extra?.rtspPort) ?? validPort(ctx.num('rtspPort', 554)) ?? 554
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function identityOf(info: Xml): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const put = (key: string, value: string) => {
    if (value) out[key] = value
  }
  put('model', str(info.model))
  put('firmware', [str(info.firmwareVersion), str(info.firmwareReleasedDate)].filter(Boolean).join(' '))
  put('serial', str(info.serialNumber))
  put('mac', str(info.macAddress).toLowerCase())
  put('deviceName', str(info.deviceName))
  put('deviceType', str(info.deviceType))
  return out
}

async function readPtz(ctx: AdapterContext): Promise<Record<string, unknown>> {
  const res = await isapi(ctx, 'GET', `/ISAPI/PTZCtrl/channels/${channelOf(ctx)}/status`)
  const abs = node(xmlRoot(res, 'PTZStatus', NO_PTZ).AbsoluteHigh)
  if (!abs) return {}
  // azimuth 0..3600 and elevation -900..2700 are tenths of a degree; absoluteZoom is tenths of ×.
  const azimuth = (int(abs.azimuth) ?? 0) / 10
  const elevation = (int(abs.elevation) ?? 0) / 10
  const zoom = Math.max(1, (int(abs.absoluteZoom) ?? 10) / 10)
  const round = (n: number) => Math.round(n * 1000) / 1000
  return {
    ptz: {
      pan: round((((azimuth + 180) % 360) - 180) / 180),
      tilt: round(clamp(elevation / 90, -1, 1)),
      zoom,
      azimuth,
      elevation,
    },
  }
}

async function presetList(ctx: AdapterContext): Promise<Array<{ id: number; name: string }>> {
  const res = await isapi(ctx, 'GET', `/ISAPI/PTZCtrl/channels/${channelOf(ctx)}/presets`)
  const out: Array<{ id: number; name: string }> = []
  for (const p of list(xmlRoot(res, 'PTZPresetList', NO_PTZ).PTZPreset)) {
    const id = int(p.id)
    if (id === null || id < 1 || str(p.enabled).toLowerCase() === 'false') continue
    out.push({ id, name: str(p.presetName) })
  }
  return out
}

async function readPresets(ctx: AdapterContext): Promise<Record<string, unknown>> {
  const presets = await presetList(ctx)
  const names: Record<string, string> = {}
  for (const p of presets) if (p.name) names[String(p.id)] = p.name
  return { presets: presets.map((p) => p.id), presetNames: names }
}

/** Which network interface owns the WiFi radio (commonly 2). null = this model has none. */
async function wifiInterface(ctx: AdapterContext, timeoutMs?: number): Promise<string | null> {
  const s = sessionOf(ctx)
  if (s.wifiInterface === null && Date.now() >= s.wifiRecheckAt) s.wifiInterface = undefined
  if (s.wifiInterface !== undefined) return s.wifiInterface
  const res = await isapi(ctx, 'GET', '/ISAPI/System/Network/interfaces', { timeoutMs })
  const all = refusal(res, NO_WIFI) ? [] : list(node(parseXml(res.text()).NetworkInterfaceList)?.NetworkInterface)
  if (all.length === 0) {
    // The list could not be read on this firmware; 2 is where WiFi cameras keep it.
    s.wifiInterface = '2'
    return s.wifiInterface
  }
  const withWifi = all.find((i) => 'Wireless' in i)
  if (withWifi) {
    s.wifiInterface = str(withWifi.id) || '2'
    return s.wifiInterface
  }
  // Some firmware leaves the WiFi details out of the list. Ask the interfaces
  // themselves before deciding there is no WiFi, the usual one (2) first.
  const ids = all.map((i) => str(i.id)).filter(Boolean)
  const order = [...ids.filter((id) => id === '2'), ...ids.filter((id) => id !== '2')].slice(0, 3)
  for (const id of order) {
    const one = await isapi(ctx, 'GET', `/ISAPI/System/Network/interfaces/${id}/wireless`, { timeoutMs })
    if (!refusal(one, NO_WIFI) && 'Wireless' in parseXml(one.text())) {
      s.wifiInterface = id
      return s.wifiInterface
    }
  }
  noWifi(s)
  return null
}

/** Believe "no WiFi" for a while, not for ever: a camera that is still starting up can look the same. */
function noWifi(s: Session): void {
  s.wifiInterface = null
  s.wifiRecheckAt = Date.now() + RECHECK_MS
}

async function readWifi(ctx: AdapterContext): Promise<Record<string, unknown>> {
  const id = await wifiInterface(ctx)
  if (!id) return {}
  const res = await isapi(ctx, 'GET', `/ISAPI/System/Network/interfaces/${id}/wireless`)
  let w: Xml
  try {
    w = xmlRoot(res, 'Wireless', NO_WIFI)
  } catch (err) {
    if (err instanceof IsapiError && err.kind === 'missing') noWifi(sessionOf(ctx))
    throw err
  }
  if (str(w.enabled).toLowerCase() === 'false') return { wifi: null }
  return { wifi: str(w.ssid) || null }
}

function isPrivateAddress(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
}

const SIM_WORDS: Record<string, string> = {
  VALID: 'SIM OK',
  ROAM: 'SIM OK (roaming)',
  NOVALID: 'SIM not accepted',
  NOEXIST: 'No SIM in the camera',
  UNKNOWN: 'SIM state unknown',
}

async function readCellular(ctx: AdapterContext): Promise<Record<string, unknown>> {
  const res = await isapi(ctx, 'GET', '/ISAPI/System/Network/WirelessDial/Interfaces/1/dialstatus')
  const d = xmlRoot(res, 'Dialstatus', 'This camera model does not report a SIM.')
  const out: Record<string, unknown> = {}
  const raw = int(d.SignalStrength)
  if (raw !== null) {
    // The camera gives a bare number. Negative values are read as dBm (-113 none … -51 full); the rest as a percentage.
    out.signal = raw < 0 ? Math.round(clamp(((raw + 113) / 62) * 100, 0, 100)) : clamp(raw, 0, 100)
  }
  const uim = str(d.UIMInfo).toUpperCase()
  const mode = str(d.RealtimeMode)
  const ip = str(node(d.IpAddress)?.ipAddress)
  const hasIp = ip !== '' && ip !== '0.0.0.0'
  const parts = [SIM_WORDS[uim] ?? (uim ? `SIM: ${uim}` : 'SIM state unknown')]
  if (mode && mode.toUpperCase() !== 'UNKNOWN') parts.push(mode)
  if (hasIp && isPrivateAddress(ip)) parts.push('private address (cannot be reached from outside)')
  else if (hasIp) parts.push('public address')
  out.sim = parts.join(', ')
  if (mode) out.simNetwork = mode
  if (hasIp) {
    out.simAddress = ip
    out.simAddressPublic = !isPrivateAddress(ip)
  }
  const link = str(d.Dialstat)
  if (link) out.simLink = link
  return out
}

async function accessPoints(ctx: AdapterContext, id: string, timeoutMs: number): Promise<AccessPoint[]> {
  const res = await isapi(ctx, 'GET', `/ISAPI/System/Network/interfaces/${id}/wireless/accessPointList`, { timeoutMs })
  const found = list(xmlRoot(res, 'accessPointList', NO_SCAN).accessPoint)
  const best = new Map<string, AccessPoint>()
  for (const ap of found) {
    const ssid = str(ap.ssid)
    if (!ssid) continue // networks that hide their name
    const sig = int(ap.signalStrength)
    const entry: AccessPoint = {
      ssid,
      signal: sig === null ? null : clamp(sig, 0, 100),
      mode: str(ap.securityMode),
      connected: str(ap.connected).toLowerCase() === 'true',
    }
    const prev = best.get(ssid)
    if (!prev) best.set(ssid, entry)
    else if ((entry.signal ?? -1) > (prev.signal ?? -1)) best.set(ssid, { ...entry, connected: entry.connected || prev.connected })
    else if (entry.connected) prev.connected = true
  }
  const out = [...best.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1))
  sessionOf(ctx).seen = { at: Date.now(), list: out }
  return out
}

const SECURITY_NAMES: Record<string, string> = {
  disable: 'Open',
  WEP: 'WEP',
  'WPA-personal': 'WPA',
  'WPA2-personal': 'WPA2',
  'WPA-RADIUS': 'WPA Enterprise',
  'WPA-enterprise': 'WPA Enterprise',
  'WPA2-enterprise': 'WPA2 Enterprise',
}

// ---------------------------------------------------------------------------
// PTZ
// ---------------------------------------------------------------------------

function ptzData(pan: number, tilt: number, zoom: number): string {
  return `${XML_HEAD}<PTZData version="2.0" xmlns="${NS}"><pan>${pan}</pan><tilt>${tilt}</tilt><zoom>${zoom}</zoom></PTZData>`
}

/** Continuous move at the given speeds (-100..100). All zeros is how ISAPI stops a move. */
async function drive(ctx: AdapterContext, pan: number, tilt: number, zoom: number): Promise<void> {
  const res = await isapi(ctx, 'PUT', `/ISAPI/PTZCtrl/channels/${channelOf(ctx)}/continuous`, { body: ptzData(pan, tilt, zoom) })
  const bad = refusal(res, NO_PTZ)
  if (bad) throw bad
}

/** PTZ commands for one camera go out in the order they were asked for, so a stop never overtakes its move. */
function inTurn<T>(deviceId: string, job: () => Promise<T>): Promise<T> {
  const prev = ptzTurns.get(deviceId) ?? Promise.resolve()
  const mine = prev.then(job, job)
  const tail = mine.then(noop, noop)
  ptzTurns.set(deviceId, tail)
  void tail.then(() => {
    if (ptzTurns.get(deviceId) === tail) ptzTurns.delete(deviceId)
  })
  return mine
}

function cancelAutoStop(deviceId: string): void {
  const t = autoStops.get(deviceId)
  if (t) clearTimeout(t)
  autoStops.delete(deviceId)
}

/** The owner sent a new PTZ command: it replaces whatever stop was pending or queued. */
function takeOver(deviceId: string): void {
  cancelAutoStop(deviceId)
  ptzEpoch.set(deviceId, (ptzEpoch.get(deviceId) ?? 0) + 1)
}

/** A login the camera refuses, or a camera without PTZ, will not answer differently a second later. */
function worthAnotherTry(err: unknown): boolean {
  return !(err instanceof IsapiError) || err.kind === 'refused'
}

/**
 * Stop the camera after `seconds`, whatever the phone does. A stop that does not
 * get through is sent again a few times; a newer command from the owner takes over.
 */
function armAutoStop(ctx: AdapterContext, seconds: number, attempt = 0): void {
  const id = ctx.device.id
  cancelAutoStop(id)
  const timer = setTimeout(() => {
    if (autoStops.get(id) !== timer) return
    autoStops.delete(id)
    const epoch = ptzEpoch.get(id)
    void inTurn(id, async () => {
      if (ptzEpoch.get(id) !== epoch) return
      try {
        await drive(ctx, 0, 0, 0)
        turning.delete(id)
      } catch (err) {
        const wait = worthAnotherTry(err) ? STOP_RETRY_SECONDS[attempt] : undefined
        if (wait === undefined) ctx.log.warn(`could not stop the camera moving: ${plain(err).message}`)
        else if (ptzEpoch.get(id) === epoch && !autoStops.has(id)) armAutoStop(ctx, wait, attempt + 1)
      }
    })
  }, seconds * 1000)
  timer.unref?.()
  autoStops.set(id, timer)
}

/** Stop now. If the stop does not get through, keep trying in the background for a short while. */
async function stopNow(ctx: AdapterContext): Promise<ActionResult> {
  const id = ctx.device.id
  try {
    await inTurn(id, async () => {
      await drive(ctx, 0, 0, 0)
      turning.delete(id)
    })
  } catch (err) {
    if (worthAnotherTry(err)) armAutoStop(ctx, STOP_RETRY_SECONDS[0]!, 1)
    throw err
  }
  return { ok: true, result: { stopped: true } }
}

function speedOf(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? Math.round(clamp(n, -1, 1) * 100) : 0
}

async function gotoPreset(ctx: AdapterContext, wanted: unknown): Promise<ActionResult> {
  let id: number | null = null
  const asText = str(wanted)
  if (/^\d+$/.test(asText)) id = Number(asText)
  else if (asText) {
    const match = (await presetList(ctx)).find((p) => p.name.toLowerCase() === asText.toLowerCase())
    if (!match) return { ok: false, error: `The camera has no preset called "${asText}"` }
    id = match.id
  }
  if (id === null || id < 1) return { ok: false, error: 'Choose which preset to go to' }

  const path = `/ISAPI/PTZCtrl/channels/${channelOf(ctx)}/presets/${id}/goto`
  // The specification says no body; some firmware insists on an empty PTZData.
  let res = await isapi(ctx, 'PUT', path)
  const st = statusOf(res.text())
  if (res.status === 400 || st?.code === 5 || st?.code === 6) res = await isapi(ctx, 'PUT', path, { body: `${XML_HEAD}<PTZData></PTZData>` })
  const bad = refusal(res, `The camera has no preset ${id}, or it cannot move.`)
  if (bad) throw bad
  return { ok: true, result: { preset: id } }
}

// ---------------------------------------------------------------------------
// WiFi change
// ---------------------------------------------------------------------------

const WIRELESS_ORDER = ['enabled', 'wirelessNetworkMode', 'channel', 'ssid', 'wmmEnabled', 'WirelessSecurity']
const SECURITY_ORDER = ['securityMode', 'WEP', 'WPA']
const WPA_ORDER = ['algorithmType', 'sharedKey', 'wpaKeyLength']

/** The camera's own block with our changes laid over it: known fields in schema order, anything else kept after them. */
function overlay(current: Xml, changes: Xml, order: string[]): Xml {
  const out: Xml = {}
  for (const k of order) {
    if (k in changes) out[k] = changes[k]
    else if (k in current) out[k] = current[k]
  }
  for (const [k, v] of Object.entries(current)) if (!(k in out)) out[k] = v
  for (const [k, v] of Object.entries(changes)) if (!(k in out)) out[k] = v
  return out
}

function wirelessXml(current: Xml, ssid: string, password: string, mode: string): string {
  const curSecurity = node(current.WirelessSecurity) ?? {}
  let security: Xml
  if (mode === 'disable') {
    const { WPA: _unused, ...rest } = curSecurity
    security = overlay(rest, { securityMode: mode }, SECURITY_ORDER)
  } else {
    const curWpa = node(curSecurity.WPA) ?? {}
    const algorithmType = mode === 'WPA2-personal' ? 'AES' : str(curWpa.algorithmType) || 'TKIP'
    const wpa = overlay(curWpa, { algorithmType, sharedKey: password, wpaKeyLength: String(Buffer.byteLength(password)) }, WPA_ORDER)
    security = overlay(curSecurity, { securityMode: mode, WPA: wpa }, SECURITY_ORDER)
  }
  const wireless = overlay(
    current,
    {
      enabled: 'true',
      wirelessNetworkMode: 'infrastructure',
      channel: 'auto',
      ssid,
      wmmEnabled: str(current.wmmEnabled) || 'true',
      WirelessSecurity: security,
    },
    WIRELESS_ORDER,
  )
  return XML_HEAD + String(builder.build({ Wireless: { '@_version': '2.0', '@_xmlns': NS, ...wireless } }))
}

async function moveToWifi(ctx: AdapterContext, target: { ssid: string; password: string }): Promise<ActionResult> {
  const ssid = target.ssid
  const password = target.password ?? ''
  if (!ssid || !ssid.trim()) return { ok: false, error: 'No network name given' }
  if (!ctx.bool('wifi', true)) return { ok: false, error: '“This camera has WiFi” is switched off for this camera.' }

  // The hub gives the whole move command twice the device timeout. Nothing may be
  // sent to the camera after the hub has given up, or it would report a failure
  // for a change that then happens anyway.
  const T = ctx.timeoutMs
  const deadline = Date.now() + 2 * T
  const spare = 0.1 * T
  const tail = 0.25 * T // kept for checking on the camera if it goes quiet
  const left = () => deadline - Date.now() - spare
  const SLOW = 'The camera was slow to answer, so nothing was changed. Try again.'
  const stepTime = () => Math.floor(Math.min(T, left() - tail - 0.25 * T))

  if (stepTime() < 0.1 * T) return { ok: false, error: SLOW }
  const id = await wifiInterface(ctx, stepTime())
  if (!id) return { ok: false, error: NO_WIFI }
  const path = `/ISAPI/System/Network/interfaces/${id}/wireless`

  if (stepTime() < 0.1 * T) return { ok: false, error: SLOW }
  const current = xmlRoot(await isapi(ctx, 'GET', path, { timeoutMs: stepTime() }), 'Wireless', NO_WIFI)

  // Only move to a network the camera can actually see: a camera sent to a
  // network it cannot join drops off WiFi and needs a cable to get back.
  const s = sessionOf(ctx)
  let seen: AccessPoint[] | null = s.seen && Date.now() - s.seen.at < SCAN_FRESH_MS ? s.seen.list : null
  if (!seen?.some((ap) => ap.ssid === ssid) && stepTime() >= 0.1 * T) {
    try {
      seen = await accessPoints(ctx, id, stepTime())
    } catch (err) {
      if (err instanceof IsapiError && err.kind === 'auth') throw err
      ctx.log.debug(`could not read the WiFi list before moving: ${plain(err).message}`)
      seen = null
    }
  }
  let mode = 'WPA2-personal'
  if (seen && seen.length > 0) {
    const ap = seen.find((x) => x.ssid === ssid)
    if (!ap) return { ok: false, error: `The camera cannot see "${ssid}" from where it is, so it was left on its current network.` }
    if (ap.mode) mode = ap.mode
  }
  if (mode !== 'disable' && mode !== 'WPA-personal' && mode !== 'WPA2-personal') {
    return { ok: false, error: `"${ssid}" uses ${SECURITY_NAMES[mode] ?? mode} security, which the hub cannot set on this camera. Use the camera’s own app for this network.` }
  }
  if (mode !== 'disable') {
    if (!password) return { ok: false, error: `No password stored for "${ssid}"` }
    const len = Buffer.byteLength(password)
    if (len < 8 || len > 64) return { ok: false, error: 'A WiFi password is 8 to 63 characters long. Check the one stored for this network.' }
  }

  const body = wirelessXml(current, ssid, password, mode)
  const putTime = Math.floor(Math.min(T, left() - tail))
  if (putTime < 0.25 * T) return { ok: false, error: SLOW }

  let res: HttpResponse
  try {
    res = await isapi(ctx, 'PUT', path, { body, timeoutMs: putTime })
  } catch (err) {
    if (!wentSilent(err)) throw err
    // No answer. Either the camera has already left this network (the usual
    // case), or the request never got through. Ask it once more to find out.
    let after: HttpResponse | null = null
    try {
      after = await isapi(ctx, 'GET', path, { timeoutMs: Math.max(100, Math.floor(Math.min(tail, left()))) })
    } catch (again) {
      if (again instanceof IsapiError) throw again
    }
    if (!after) {
      return {
        ok: true,
        result: { ssid, note: 'The camera stopped answering right after it was told to move, which is normal when it leaves the network it was reached on.' },
        state: { wifi: ssid },
      }
    }
    // Still here: it either took the change without saying so, or never got it.
    if (str(node(parseXml(after.text()).Wireless)?.ssid) === ssid) return { ok: true, result: { ssid }, state: { wifi: ssid } }
    return { ok: false, error: 'The camera did not answer the change and is still set to its old network. Nothing was changed; try again.' }
  }
  const bad = refusal(res, NO_WIFI)
  if (bad) throw bad
  const restart = statusOf(res.text())?.code === 7
  return {
    ok: true,
    result: restart ? { ssid, note: 'The camera says it must restart before it joins the new network. Use Reboot if it does not show up.' } : { ssid },
    state: { wifi: ssid },
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const adapter: Adapter = {
  family: 'hikvision',

  describe(): FamilyDescriptor {
    return {
      id: 'hikvision',
      label: 'Hikvision camera',
      tagline: 'Hikvision and Hik-Connect cameras, including 4G models with a SIM. Live view, pictures, turning the camera, WiFi change.',
      kinds: ['camera'],
      fields: [
        FIELD.username('The login of the camera itself, usually “admin”. This is not your Hik-Connect app account.'),
        FIELD.password('The camera’s own password. Stored encrypted on the hub. Type it carefully: after a few wrong tries the camera locks the login for about half an hour.'),
        {
          name: 'channel',
          label: 'Camera number',
          type: 'number',
          default: 1,
          help: 'Leave at 1 for a single camera. If this address is a recorder (NVR) with several cameras, enter which camera you want.',
        },
        {
          ...FIELD.https(),
          help: 'Turn on if the camera’s own settings page opens with https://. The hub then uses the usual secure port (443) and accepts the certificate the camera made for itself; if your camera uses a different secure port, enter it as the port of the connection. With this off, passwords travel unprotected inside your house network.',
        },
        {
          name: 'rtspPort',
          label: 'Video port',
          type: 'number',
          default: 554,
          help: 'The port live video comes from (the camera’s settings call it RTSP). It is 554 unless you changed it on the camera.',
        },
        {
          name: 'ptz',
          label: 'This camera can turn and zoom',
          type: 'toggle',
          default: false,
          help: 'Turn on for cameras with a motor (PTZ). Leave off for fixed cameras.',
        },
        {
          name: 'wifi',
          label: 'This camera has WiFi',
          type: 'toggle',
          default: true,
          help: 'Shows which WiFi the camera is on and lets you move it to another one. Turn off for cable-only models and for 4G models without WiFi.',
        },
        {
          name: 'cellular',
          label: 'This camera has a SIM',
          type: 'toggle',
          default: false,
          help: 'Turn on for 4G models. The hub then shows the SIM state and signal whenever it can reach the camera.',
        },
      ],
      pathKinds: ['lan', 'cellular'],
      defaultPort: 80,
      capabilities: ['stream', 'snapshot', 'ptz', 'presets', 'wifi', 'wifi-scan', 'cellular', 'reboot', 'state'],
      notes: [
        'First switch on ISAPI on the camera — that is the camera’s built-in control service, and without it the camera ignores the hub. Open the camera’s web page, go to System > System Service, tick “Enable ISAPI”, apply and restart the camera.',
        'Use the camera’s own login. After a few wrong passwords the camera locks the admin login for about 30 minutes, for the Hik-Connect app too. To avoid that, the hub stops trying after a wrong password until you correct it here.',
        'What works on the house network: live view, pictures, restart, and — when switched on above — turning and zooming, presets, the WiFi the camera is on, moving it to another WiFi, and SIM signal.',
        'Before moving the camera to another WiFi the hub checks that the camera can see that network. If the stored WiFi password is wrong, the camera can still drop off WiFi; it then needs a network cable or its own app to bring it back. Networks that hide their name, and company-style logins, have to be set in the camera’s own app.',
        'SIM connection: most SIM cards get a private address from the mobile company, so nothing can connect in to the camera over 4G. Add a SIM connection here only if your plan gives the SIM a public (static) address. Otherwise use the Hik-Connect app when the house internet is down.',
        'If live view does not start, open the camera’s Security settings and set both “RTSP Authentication” and “WEB Authentication” to digest (or digest/basic) with the MD5 option.',
        'Motion alerts and talking through the camera are not handled by the hub; keep using Hik-Connect for those.',
      ],
    }
  },

  capabilities(config: Record<string, unknown>, _kind: DeviceKind): Capability[] {
    const caps: Capability[] = ['stream', 'snapshot', 'reboot', 'state']
    if (flag(config.ptz, false)) caps.push('ptz', 'presets')
    if (flag(config.wifi, true)) caps.push('wifi', 'wifi-scan')
    if (flag(config.cellular, false)) caps.push('cellular')
    return caps
  },

  async probe(ctx): Promise<ProbeResult> {
    const started = Date.now()
    // One check is a login round trip or more; the whole of it must fit in the time the hub allows.
    let timer: NodeJS.Timeout | undefined
    const tooLong = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ctx.timeoutMs} ms`)), ctx.timeoutMs)
    })
    try {
      const res = await Promise.race([isapi(ctx, 'GET', '/ISAPI/System/deviceInfo'), tooLong])
      const info = res.status === 200 ? node(parseXml(res.text()).DeviceInfo) : null
      if (info) return { ok: true, latencyMs: Date.now() - started, info: identityOf(info) }
      const st = statusOf(res.text())
      let error = NOT_HIKVISION
      if (st?.sub.toLowerCase() === 'notactivated') error = NOT_ACTIVATED
      else if (redirectText(res)) error = redirectText(res)!
      else if (res.status >= 500 || st?.code === 2 || st?.code === 3) error = STARTING_UP
      return { ok: false, latencyMs: null, error }
    } catch (err) {
      return { ok: false, latencyMs: null, error: plain(err).message }
    } finally {
      clearTimeout(timer)
    }
  },

  async readState(ctx): Promise<Record<string, unknown>> {
    const s = sessionOf(ctx)
    const jobs: Array<[string, () => Promise<Record<string, unknown>>]> = []
    if (ctx.bool('ptz', false)) jobs.push(['ptz', () => readPtz(ctx)], ['presets', () => readPresets(ctx)])
    if (ctx.bool('wifi', true)) jobs.push(['wifi', () => readWifi(ctx)])
    if (ctx.bool('cellular', false)) jobs.push(['cellular', () => readCellular(ctx)])
    const now = Date.now()
    const wanted = jobs.filter(([name]) => (s.absent.get(name) ?? 0) <= now)
    const settled = await Promise.allSettled(wanted.map(([, job]) => job()))

    const state: Record<string, unknown> = {}
    let answered = 0
    let firstError: unknown = null
    settled.forEach((r, i) => {
      const name = wanted[i]![0]
      if (r.status === 'fulfilled') {
        answered += 1
        s.absent.delete(name)
        Object.assign(state, r.value)
        return
      }
      const missing = r.reason instanceof IsapiError && r.reason.kind === 'missing'
      if (missing) {
        // This model does not have it: an answer, just not a useful one. Leave it alone for a while.
        answered += 1
        s.absent.set(name, now + RECHECK_MS)
      } else if (firstError === null) firstError = r.reason
      ctx.log.debug(`${name} not read: ${plain(r.reason).message}`)
    })
    if (firstError !== null && answered === 0) throw plain(firstError)
    return state
  },

  async execute(ctx, action: Action): Promise<ActionResult> {
    const id = ctx.device.id
    const p = action.params
    try {
      switch (action.type) {
        case 'ptz.move': {
          if (!ctx.bool('ptz', false)) return unsupported(action)
          const pan = speedOf(p.pan)
          const tilt = speedOf(p.tilt)
          const zoom = speedOf(p.zoom)
          takeOver(id)
          if (pan === 0 && tilt === 0 && zoom === 0) return await stopNow(ctx)
          const asked = Number(p.seconds)
          const seconds = Number.isFinite(asked) && asked > 0 ? clamp(asked, 0.1, MAX_MOVE_SECONDS) : MAX_MOVE_SECONDS
          try {
            await inTurn(id, async () => {
              await drive(ctx, pan, tilt, zoom)
              turning.add(id)
              armAutoStop(ctx, seconds)
            })
          } catch (err) {
            if (wentSilent(err)) {
              // The order may have reached the camera although its answer never came back.
              turning.add(id)
              armAutoStop(ctx, seconds)
            } else if (turning.has(id)) {
              // An earlier move is still running and its auto-stop was just replaced: do not leave it turning.
              armAutoStop(ctx, STOP_RETRY_SECONDS[0]!)
            }
            throw err
          }
          return { ok: true, result: { pan, tilt, zoom, stopsAfterSeconds: seconds } }
        }
        case 'ptz.stop': {
          if (!ctx.bool('ptz', false)) return unsupported(action)
          takeOver(id)
          return await stopNow(ctx)
        }
        case 'ptz.preset': {
          if (!ctx.bool('ptz', false)) return unsupported(action)
          takeOver(id)
          let went: ActionResult | null = null
          try {
            went = await inTurn(id, () => gotoPreset(ctx, p.preset))
            return went
          } finally {
            // Going to a preset ends a held move. If it did not happen, the held move still needs its stop.
            if (went?.ok) turning.delete(id)
            else if (turning.has(id)) armAutoStop(ctx, STOP_RETRY_SECONDS[0]!)
          }
        }
        case 'reboot': {
          const res = await isapi(ctx, 'PUT', '/ISAPI/System/reboot')
          const bad = refusal(res, 'This camera cannot be restarted from the hub.')
          if (bad) throw bad
          cancelAutoStop(id)
          turning.delete(id)
          // The camera answers first and restarts after; it is usually back in 30 to 90 seconds.
          return { ok: true, result: { backInSeconds: 60 } }
        }
        default:
          return unsupported(action)
      }
    } catch (err) {
      if (err instanceof IsapiError) return { ok: false, error: err.message }
      throw plain(err)
    }
  },

  async snapshot(ctx): Promise<Snapshot> {
    const channel = channelOf(ctx)
    try {
      // Stills come from the main stream only: channel × 100 + 1.
      const res = await isapi(ctx, 'GET', `/ISAPI/Streaming/channels/${channel}01/picture`)
      const type = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      const jpeg = res.body.length > 2 && res.body[0] === 0xff && res.body[1] === 0xd8
      if (res.status === 200 && res.body.length > 0 && (jpeg || type.startsWith('image/'))) {
        return { contentType: type.startsWith('image/') ? type : 'image/jpeg', body: res.body }
      }
      throw refusal(res, `The camera gave no picture for camera number ${channel}.`) ?? new Error('The camera answered, but not with a picture')
    } catch (err) {
      throw plain(err)
    }
  },

  streamSources(ctx): string[] {
    const host = requireHost(ctx)
    const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    const login = userInfo(ctx.str('username').trim() || undefined, ctx.secret('password'))
    const base = `rtsp://${login}${h}:${rtspPortOf(ctx)}/Streaming/Channels/${channelOf(ctx)}`
    // Main stream first (full screen), then the small sub stream (tiles).
    return [`${base}01`, `${base}02`]
  },

  async setWifi(ctx, target): Promise<ActionResult> {
    try {
      return await moveToWifi(ctx, target)
    } catch (err) {
      if (err instanceof IsapiError) return { ok: false, error: err.message }
      throw plain(err)
    }
  },

  async scanWifi(ctx): Promise<WifiScanEntry[]> {
    try {
      if (!ctx.bool('wifi', true)) throw new IsapiError('missing', '“This camera has WiFi” is switched off for this camera.')
      const id = await wifiInterface(ctx)
      if (!id) throw new IsapiError('missing', NO_WIFI)
      // Some firmware starts a fresh scan on every read, which takes a few seconds.
      const found = await accessPoints(ctx, id, ctx.timeoutMs * 2)
      return found.map((ap) => ({ ssid: ap.ssid, signal: ap.signal, security: ap.mode ? (SECURITY_NAMES[ap.mode] ?? ap.mode) : null }))
    } catch (err) {
      throw plain(err)
    }
  },
}

export default adapter
