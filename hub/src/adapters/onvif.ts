/**
 * ONVIF camera — the fallback for any IP camera (Profile S / Profile T).
 *
 * Everything here is hand-built SOAP 1.2 over lib/http.ts, parsed with
 * fast-xml-parser. How it talks to a camera:
 *
 *  - Login: WS-Security UsernameToken with PasswordDigest. The timestamp uses the
 *    CAMERA's clock (offset learnt from an unauthenticated GetSystemDateAndTime).
 *    When the camera answers HTTP 401, or rejects the token, the same call is
 *    repeated with HTTP Digest and no WS-Security header, and that choice is
 *    remembered.
 *  - Service addresses come from GetServices (GetCapabilities on older cameras),
 *    but only their PATH is used: host and port are always the ones of the
 *    connection being used, because cameras report their LAN address even when
 *    they are reached through a SIM or a port-forward. The same is done to the
 *    video and still-picture addresses.
 *  - A small per-camera memory (keyed by address + ONVIF path + username, never
 *    holding the password) keeps the clock offset, service map, profiles and
 *    resolved addresses, so a PTZ tap is one request, not five.
 *  - A refused login is not tried again for five minutes unless the password is
 *    changed here: cameras lock the account (often for half an hour) after a
 *    handful of wrong tries, and the hub checks every few seconds.
 *  - streamSources() must answer at once, so it returns the RTSP addresses that
 *    the last readState() resolved. Before the first state read it hands go2rtc
 *    an onvif:// source and lets it ask the camera itself.
 *  - An optional per-connection `rtspPort` in path.extra overrides the video port
 *    (for a SIM / port-forward where 554 is mapped elsewhere).
 *  - A move never runs open-ended: the app sends one "move" when a button is
 *    pressed and one "stop" when it is let go, and that stop can get lost. Every
 *    ContinuousMove therefore carries a time limit for the camera and the hub
 *    arms its own Stop for the same moment.
 *
 * REUSABLE CLIENT — for other adapters (Tapo cameras speak ONVIF on port 2020):
 *
 *   import { onvifClient, OnvifError } from './onvif.ts'
 *   const cam = onvifClient({ host, port, path?, username, password, timeoutMs })
 *
 *   await cam.getDeviceInformation()            -> { manufacturer, model, firmware, serial, hardwareId }
 *   await cam.getProfiles()                     -> OnvifProfile[]  { token, name, encoding, width, height, ptz, media2 }
 *   await cam.getStreamUri(profileToken)        -> 'rtsp://host:554/…'  host rewritten, NO credentials (add userInfo() yourself)
 *   await cam.getSnapshotUri(profileToken)      -> 'http://host:port/…' host rewritten, fetch it with HTTP digest
 *   await cam.continuousMove(profileToken, { pan, tilt, zoom }, seconds?)   each -1..1; an axis left at 0 is not sent.
 *                                               `seconds` is handed to the camera as its own time limit (Timeout);
 *                                               without it the camera moves until stop() or its own default limit.
 *   await cam.stop(profileToken)
 *   await cam.getPresets(profileToken)          -> OnvifPreset[]  { token, name }
 *   await cam.gotoPreset(profileToken, preset)  preset = the preset TOKEN
 *   await cam.reboot()                          -> the camera's message, e.g. 'Rebooting in 30 seconds'
 *
 * Also available: syncClock(), getServices(), getStatus(), getNetworkInterfaces(),
 * getServiceCapabilities(), getDot11Capabilities(), getDot11Status(), scanDot11Networks(),
 * setDot11Networks(), fetchSnapshot(), sources(), forget().
 *
 * Errors: a refusal by the camera (bad login, SOAP fault, not an ONVIF device,
 * feature missing) is an OnvifError with kind 'auth' | 'fault' | 'protocol' |
 * 'unsupported'. A camera that cannot be reached throws a plain Error with a
 * plain-language message. Neither ever contains the password.
 */
import crypto from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import type { Action, Capability, DeviceKind, DiscoveredDevice, FamilyDescriptor } from '@house/shared'
import { request, type Response } from '../lib/http.ts'
import type { Logger } from '../lib/log.ts'
import {
  clamp,
  FIELD,
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PATH = '/onvif/device_service'
const DEFAULT_PORT = 80

const NS = {
  device: 'http://www.onvif.org/ver10/device/wsdl',
  media: 'http://www.onvif.org/ver10/media/wsdl',
  media2: 'http://www.onvif.org/ver20/media/wsdl',
  ptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  schema: 'http://www.onvif.org/ver10/schema',
} as const

const WSSE_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd'
const WSU_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd'
const PASSWORD_DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest'
const BASE64_BINARY = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary'

/** How long remembered answers stay fresh. Resolved video addresses are kept until replaced. */
const TTL = {
  clock: 5 * 60_000,
  services: 10 * 60_000,
  profiles: 10 * 60_000,
  uris: 10 * 60_000,
  info: 5 * 60_000,
  network: 5 * 60_000,
  presets: 60_000,
}

/** After a refused login, how long before the same password is tried again. */
const AUTH_RETRY_MS = 5 * 60_000
const MAX_PRESETS = 32
const MAX_MOVE_SECONDS = 60
/** How long a move may run when the app gives no limit (it only sends "stop" on release, which can get lost). */
const DEFAULT_MOVE_SECONDS = 30
/** IANA ifType of an 802.11 (WiFi) interface. */
const IFTYPE_WIFI = 71

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OnvifClientOptions {
  host: string
  port: number
  /** Device service path. Default /onvif/device_service. */
  path?: string
  username: string
  password: string
  timeoutMs: number
  /** Use this port in video addresses instead of the one the camera reports. */
  rtspPort?: number
}

export type OnvifErrorKind = 'auth' | 'fault' | 'protocol' | 'unsupported'

/** The camera answered, but refused or could not do what was asked. */
export class OnvifError extends Error {
  readonly kind: OnvifErrorKind
  /** SOAP fault codes without their prefix, e.g. ['Sender', 'NotAuthorized']. */
  readonly codes: string[]

  constructor(kind: OnvifErrorKind, message: string, codes: string[] = []) {
    super(message)
    this.name = 'OnvifError'
    this.kind = kind
    this.codes = codes
  }

  /** True when the camera's fault carries this code or its text matches. */
  is(what: RegExp): boolean {
    return this.codes.some((c) => what.test(c)) || what.test(this.message)
  }
}

export interface OnvifDeviceInformation {
  manufacturer: string
  model: string
  firmware: string
  serial: string
  hardwareId: string
}

export interface OnvifProfile {
  token: string
  name: string
  encoding: string
  width: number
  height: number
  /** The profile has a PTZ configuration attached. */
  ptz: boolean
  /** Listed by the Media2 (Profile T) service rather than Media1. */
  media2: boolean
}

export interface OnvifPreset {
  token: string
  name: string
}

export interface OnvifServices {
  device: string
  media?: string
  media2?: string
  ptz?: string
  imaging?: string
  events?: string
}

export interface OnvifDot11Entry {
  /** SSID as hex of its bytes, the way ONVIF carries it. */
  ssidHex: string
  mode: string
  alias: string
  priority: number
  securityMode: string
  algorithm?: string
  dot1x?: string
  /** Only when adding or changing a network; never returned by the camera. */
  passphrase?: string
  /** 64 hex characters; wins over passphrase. */
  key?: string
}

export interface OnvifNetworkInterface {
  token: string
  name: string
  mac: string
  /** IANA interface type: 71 = WiFi, 6 = wired. Null when the camera does not say. */
  type: number | null
  dot11: OnvifDot11Entry[]
}

export interface OnvifDot11Status {
  ssid: string
  signal: string
  alias: string
}

export interface OnvifDot11Network {
  ssid: string
  signal: string
  auth: string[]
  ciphers: string[]
}

export interface OnvifClient {
  /** Ask the camera for its clock again (unauthenticated). Returns camera time minus hub time, in ms. */
  syncClock(): Promise<number>
  getDeviceInformation(maxAgeMs?: number): Promise<OnvifDeviceInformation>
  getServices(): Promise<OnvifServices>
  getProfiles(): Promise<OnvifProfile[]>
  getStreamUri(profileToken: string): Promise<string>
  getSnapshotUri(profileToken: string): Promise<string>
  fetchSnapshot(uri: string): Promise<Snapshot>
  continuousMove(profileToken: string, velocity: { pan?: number; tilt?: number; zoom?: number }, seconds?: number): Promise<void>
  stop(profileToken: string): Promise<void>
  getPresets(profileToken: string, maxAgeMs?: number): Promise<OnvifPreset[]>
  gotoPreset(profileToken: string, preset: string | number): Promise<void>
  getStatus(profileToken: string): Promise<{ pan: number; tilt: number; zoom: number } | null>
  reboot(): Promise<string>
  getNetworkInterfaces(maxAgeMs?: number): Promise<OnvifNetworkInterface[]>
  getServiceCapabilities(): Promise<{ dot11: boolean | null }>
  getDot11Capabilities(): Promise<{ scan: boolean; multiple: boolean }>
  getDot11Status(interfaceToken: string): Promise<OnvifDot11Status>
  scanDot11Networks(interfaceToken: string): Promise<OnvifDot11Network[]>
  setDot11Networks(interfaceToken: string, entries: OnvifDot11Entry[]): Promise<{ rebootNeeded: boolean }>
  /** Video addresses resolved so far (main first), without credentials. */
  sources(): string[]
  /** Remember resolved video addresses for sources(). */
  remember(sources: string[]): void
  /** Drop everything remembered about this camera. */
  forget(): void
}

// ---------------------------------------------------------------------------
// Small XML helpers
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Walk down element names; arrays are entered at their first item. */
function child(node: unknown, ...names: string[]): unknown {
  let cur: unknown = node
  for (const name of names) {
    if (Array.isArray(cur)) cur = cur[0]
    if (!isObj(cur)) return undefined
    cur = cur[name]
  }
  return cur
}

function list(v: unknown): unknown[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

/** Text of an element, whether it parsed as a string or as { '#text', attributes }. */
function txt(v: unknown): string {
  if (Array.isArray(v)) return txt(v[0])
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (isObj(v)) return txt(v['#text'])
  return ''
}

function attr(node: unknown, name: string): string {
  const n = Array.isArray(node) ? node[0] : node
  return isObj(n) ? txt(n[`@_${name}`]) : ''
}

function num(v: unknown, fallback = 0): number {
  const n = Number(txt(v))
  return Number.isFinite(n) ? n : fallback
}

function isTrue(v: unknown): boolean {
  const s = txt(v).toLowerCase()
  return s === 'true' || s === '1'
}

function bare(code: string): string {
  const i = code.lastIndexOf(':')
  return i >= 0 ? code.slice(i + 1) : code
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function bracket(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function normalisePath(path: string | undefined): string {
  const p = (path ?? '').trim()
  if (!p) return DEFAULT_PATH
  return p.startsWith('/') ? p : '/' + p
}

function origin(o: Required<Pick<OnvifClientOptions, 'host' | 'port'>>): string {
  return `http://${bracket(o.host)}${o.port === 80 ? '' : ':' + o.port}`
}

/** Path + query of an address the camera reported, or '' when it cannot be read. */
function pathOf(xaddr: string): string {
  try {
    const u = new URL(xaddr)
    return u.pathname + u.search
  } catch {
    return xaddr.startsWith('/') ? xaddr : ''
  }
}

function portOf(xaddr: string): number | null {
  try {
    const u = new URL(xaddr)
    if (u.port) return Number(u.port)
    return u.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

/**
 * Put our host into an address the camera reported, dropping any login the
 * camera embedded. `port` decides what happens to the reported port.
 */
function rewriteUri(uri: string, host: string, port: (reported: number | null, scheme: string) => number | null): string {
  const clean = uri.trim()
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d+))?(.*)$/i.exec(clean)
  if (!m) return clean
  const scheme = m[1]!.toLowerCase()
  const p = port(m[3] ? Number(m[3]) : null, scheme)
  return `${scheme}://${bracket(host)}${p === null ? '' : ':' + p}${m[4] ?? ''}`
}

function withLogin(uri: string, username: string, password: string): string {
  const i = uri.indexOf('://')
  if (i < 0 || !username) return uri
  return uri.slice(0, i + 3) + userInfo(username, password) + uri.slice(i + 3)
}

// ---------------------------------------------------------------------------
// WiFi value helpers
// ---------------------------------------------------------------------------

function ssidToHex(ssid: string): string {
  return Buffer.from(ssid, 'utf8').toString('hex').toUpperCase()
}

/** ONVIF carries SSIDs as hex; a few cameras send plain text instead. */
function ssidFromHex(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v)) {
    const decoded = Buffer.from(v, 'hex').toString('utf8')
    if (!/[\u0000-\u001f\ufffd]/.test(decoded)) return decoded
  }
  return v
}

/** ONVIF only gives five words for signal strength; map them to a rough percentage. */
function signalPercent(strength: string): number | null {
  switch (strength.trim().toLowerCase()) {
    case 'none':
      return 0
    case 'very bad':
      return 20
    case 'bad':
      return 40
    case 'good':
      return 70
    case 'very good':
      return 90
    default:
      return null
  }
}

function securityLabel(n: OnvifDot11Network): string | null {
  const auth = n.auth.map((a) => a.toLowerCase())
  const ciphers = n.ciphers.map((c) => c.toLowerCase())
  if (auth.includes('psk')) {
    if (ciphers.includes('ccmp')) return 'WPA2'
    if (ciphers.includes('tkip')) return 'WPA'
    return 'WPA/WPA2'
  }
  if (auth.includes('dot1x')) return 'Enterprise'
  if (auth.includes('none')) return 'Open'
  return null
}

// ---------------------------------------------------------------------------
// Per-camera memory (never holds the password)
// ---------------------------------------------------------------------------

interface Session {
  /** Which login style this camera accepted last. */
  auth: 'wsse' | 'digest' | null
  cache: Map<string, { at: number; value: Promise<unknown> }>
  /** Port the camera itself reports for its ONVIF services (before rewriting). */
  nativePort: number | null
  /** Resolved video addresses, main first, without credentials. Kept until replaced. */
  streams: string[]
  /** Preset label shown in the app -> preset token. */
  presetLabels: Map<string, string>
  stopTimer: NodeJS.Timeout | null
  /** GetStatus faulted on this camera; do not keep asking. */
  noStatus: boolean
  /** The camera faulted on a ContinuousMove time limit; send moves without one. */
  noMoveTimeout: boolean
  /** The camera refused this login; `fp` is a salted fingerprint, not the password. */
  refused: { fp: string; until: number; error: string } | null
}

const sessions = new Map<string, Session>()

function sessionKey(o: { host: string; port: number; path: string; username: string }): string {
  return `${o.host.toLowerCase()}|${o.port}|${o.path}|${o.username}`
}

function sessionFor(key: string): Session {
  let s = sessions.get(key)
  if (!s) {
    s = { auth: null, cache: new Map(), nativePort: null, streams: [], presetLabels: new Map(), stopTimer: null, noStatus: false, noMoveTimeout: false, refused: null }
    sessions.set(key, s)
  }
  return s
}

const FINGERPRINT_SALT = crypto.randomBytes(16)

/** Lets the hub notice that the login was changed without keeping the password around. */
function fingerprint(username: string, password: string): string {
  return crypto.createHmac('sha256', FINGERPRINT_SALT).update(`${username}\0${password}`).digest('hex')
}

/** Test hook: forget every camera and cancel pending auto-stops. */
export function resetOnvifSessions(): void {
  for (const s of sessions.values()) if (s.stopTimer) clearTimeout(s.stopTimer)
  sessions.clear()
}

/** Run `load` once per `ttlMs`; concurrent callers share the same request. Failures are not remembered. */
function cached<T>(s: Session, name: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = s.cache.get(name)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>
  const value = load()
  const entry = { at: Date.now(), value }
  s.cache.set(name, entry)
  value.catch(() => {
    if (s.cache.get(name) === entry) s.cache.delete(name)
  })
  return value
}

// ---------------------------------------------------------------------------
// SOAP
// ---------------------------------------------------------------------------

type Opts = Required<Omit<OnvifClientOptions, 'rtspPort'>> & { rtspPort: number | null }

function securityHeader(o: Opts, shiftMs: number): string {
  const created = new Date(Date.now() + shiftMs).toISOString()
  const nonce = crypto.randomBytes(16)
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created + o.password, 'utf8')]))
    .digest('base64')
  return (
    `<Security s:mustUnderstand="1" xmlns="${WSSE_NS}"><UsernameToken>` +
    `<Username>${esc(o.username)}</Username>` +
    `<Password Type="${PASSWORD_DIGEST}">${digest}</Password>` +
    `<Nonce EncodingType="${BASE64_BINARY}">${nonce.toString('base64')}</Nonce>` +
    `<Created xmlns="${WSU_NS}">${created}</Created>` +
    '</UsernameToken></Security>'
  )
}

/** Compact SOAP 1.2 envelope (some cameras mishandle pretty-printed XML). */
function envelope(body: string, security: string): string {
  return (
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">' +
    `<s:Header>${security}</s:Header>` +
    `<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">${body}</s:Body>` +
    '</s:Envelope>'
  )
}

function transportError(err: unknown, o: Opts): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (/timed out/i.test(message)) return new Error(`The camera at ${o.host} did not answer in time`)
  if (/socket hang up/i.test(message)) return new Error(`The camera at ${o.host} closed the connection without answering`)
  if (err instanceof TypeError && /invalid url/i.test(message)) {
    return new Error(`"${o.host}" is not an address the hub can use. Enter only the camera's IP address or name, without http:// or anything after it.`)
  }
  return err instanceof Error ? err : new Error(message)
}

const AUTH_FAULT = /NotAuthorized|FailedAuthentication|Unauthorized|not\s+authori[sz]ed|authority\s+failure|InvalidSecurity/i

/** Turn an HTTP answer into the operation's response element, or throw an OnvifError. */
function interpret(res: Response, op: string): Record<string, unknown> {
  if (res.status === 401) throw new OnvifError('auth', 'The camera refused the username or password')
  let envelope: unknown
  try {
    envelope = child(parser.parse(res.text()) as unknown, 'Envelope')
  } catch {
    envelope = undefined
  }
  if (Array.isArray(envelope)) envelope = envelope[0]
  const body = child(envelope, 'Body')
  const fault = child(body, 'Fault')
  if (fault !== undefined) {
    const codes: string[] = []
    let code: unknown = child(fault, 'Code')
    for (let depth = 0; code !== undefined && depth < 6; depth++) {
      const value = txt(child(code, 'Value'))
      if (value) codes.push(bare(value))
      code = child(code, 'Subcode')
    }
    const legacy = txt(child(fault, 'faultcode'))
    if (legacy) codes.push(bare(legacy))
    const reason = txt(child(fault, 'Reason', 'Text')) || txt(child(fault, 'faultstring')) || codes[codes.length - 1] || 'no reason given'
    if (res.status === 403 || codes.some((c) => AUTH_FAULT.test(c)) || AUTH_FAULT.test(reason)) {
      throw new OnvifError('auth', 'The camera refused the username or password', codes)
    }
    throw new OnvifError('fault', reason, codes)
  }
  if (res.status === 403) throw new OnvifError('auth', 'The camera refused the username or password')
  const success = res.status >= 200 && res.status < 300
  // A real SOAP envelope with nothing in its body: some cameras acknowledge Stop, a move or a
  // preset this way instead of sending the empty <…Response/> element.
  if (success && isObj(envelope) && 'Body' in envelope && !isObj(body) && txt(body) === '') return {}
  if (!success || !isObj(body)) {
    throw new OnvifError(
      'protocol',
      success
        ? 'Something answered at this address, but not as an ONVIF camera'
        : `Something answered at this address with HTTP ${res.status}, not as an ONVIF camera`,
    )
  }
  const response = body[`${op}Response`]
  return isObj(response) ? response : {}
}

/** A velocity as it goes on the wire: -1..1, three decimals, anything unreadable = 0. */
function axis(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? Number(clamp(n, -1, 1).toFixed(3)) : 0
}

interface CallOptions {
  /** False for the one call that must go out without a login (the clock). */
  auth?: boolean
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// The reusable client
// ---------------------------------------------------------------------------

export function onvifClient(options: OnvifClientOptions): OnvifClient {
  const o: Opts = {
    host: options.host.trim(),
    port: options.port || DEFAULT_PORT,
    path: normalisePath(options.path),
    username: (options.username ?? '').trim(),
    password: options.password ?? '',
    timeoutMs: options.timeoutMs,
    rtspPort: options.rtspPort && options.rtspPort > 0 ? options.rtspPort : null,
  }
  if (!o.host) throw new Error('No address set for this camera')
  const key = sessionKey(o)
  const session = (): Session => sessionFor(key)
  const base = origin(o)
  const deviceUrl = base + o.path

  async function post(url: string, action: string, xml: string, digest: boolean, timeoutMs: number): Promise<Response> {
    try {
      return await request(url, {
        method: 'POST',
        headers: {
          'Content-Type': `application/soap+xml;charset=utf-8;action="${action}"`,
          // An explicit length: small camera web servers do not accept chunked uploads.
          'Content-Length': String(Buffer.byteLength(xml)),
          Connection: 'close',
        },
        body: xml,
        timeoutMs,
        digest: digest ? { username: o.username, password: o.password } : undefined,
      })
    } catch (err) {
      throw transportError(err, o)
    }
  }

  function clockShift(): Promise<number> {
    return cached(session(), 'clock', TTL.clock, async () => {
      try {
        return await readClock()
      } catch (err) {
        // The camera answered but would not tell the time without a login: carry on with our own clock.
        if (err instanceof OnvifError) return 0
        throw err
      }
    })
  }

  async function readClock(): Promise<number> {
    const started = Date.now()
    const res = await call(deviceUrl, NS.device, 'GetSystemDateAndTime', '', { auth: false })
    const sys = child(res, 'SystemDateAndTime')
    const dt = child(sys, 'UTCDateTime') ?? child(sys, 'LocalDateTime')
    const date = child(dt, 'Date')
    const time = child(dt, 'Time')
    const year = num(child(date, 'Year'), NaN)
    if (!Number.isFinite(year)) return 0
    const cameraNow = Date.UTC(year, num(child(date, 'Month'), 1) - 1, num(child(date, 'Day'), 1), num(child(time, 'Hour')), num(child(time, 'Minute')), num(child(time, 'Second')))
    // The answer was produced somewhere between sending and receiving.
    return cameraNow - Math.round((started + Date.now()) / 2)
  }

  /** One SOAP call. Returns the <{op}Response> element. */
  async function call(url: string, ns: string, op: string, inner: string, opts: CallOptions = {}): Promise<Record<string, unknown>> {
    const s = session()
    const action = `${ns}/${op}`
    const body = inner ? `<${op} xmlns="${ns}">${inner}</${op}>` : `<${op} xmlns="${ns}"/>`
    const timeoutMs = opts.timeoutMs ?? o.timeoutMs
    const plain = envelope(body, '')

    if (opts.auth === false || !o.username) {
      return interpret(await post(url, action, plain, false, timeoutMs), op)
    }

    try {
      if (s.auth === 'digest') {
        return interpret(await post(url, action, plain, true, timeoutMs), op)
      }
      const shift = await clockShift()
      const first = await post(url, action, envelope(body, securityHeader(o, shift)), false, timeoutMs)
      if (first.status !== 401) {
        try {
          const out = interpret(first, op)
          s.auth = 'wsse'
          return out
        } catch (err) {
          // The token was refused (or, on first contact, answered with something that is not
          // SOAP). Cameras set to "digest only", or with a clock we could not read, still
          // accept HTTP digest: fall through and try that.
          const tryDigest = err instanceof OnvifError && (err.kind === 'auth' || (err.kind === 'protocol' && s.auth === null))
          if (!tryDigest) throw err
        }
      }
      // Per the ONVIF core spec, never send WS-Security and HTTP credentials together.
      const out = interpret(await post(url, action, plain, true, timeoutMs), op)
      s.auth = 'digest'
      return out
    } catch (err) {
      if (err instanceof OnvifError && err.kind === 'auth') {
        s.auth = null
        s.cache.delete('clock')
      }
      throw err
    }
  }

  function getServices(): Promise<OnvifServices> {
    return cached(session(), 'services', TTL.services, async () => {
      const s = session()
      const found: OnvifServices = { device: deviceUrl }
      const place = (name: keyof OnvifServices, xaddr: string) => {
        if (!xaddr) return
        const p = pathOf(xaddr)
        if (!p) return
        if (s.nativePort === null || name === 'device') s.nativePort = portOf(xaddr) ?? s.nativePort
        if (name !== 'device') found[name] = base + p
      }
      try {
        const res = await call(deviceUrl, NS.device, 'GetServices', '<IncludeCapability>false</IncludeCapability>')
        const byNamespace: Record<string, keyof OnvifServices> = {
          [NS.device]: 'device',
          [NS.media]: 'media',
          [NS.media2]: 'media2',
          [NS.ptz]: 'ptz',
          'http://www.onvif.org/ver20/imaging/wsdl': 'imaging',
          'http://www.onvif.org/ver10/events/wsdl': 'events',
        }
        const services = list(child(res, 'Service'))
        for (const svc of services) {
          const name = byNamespace[txt(child(svc, 'Namespace'))]
          if (name) place(name, txt(child(svc, 'XAddr')))
        }
        if (services.length > 0) return found
      } catch (err) {
        if (!(err instanceof OnvifError) || err.kind === 'auth') throw err
      }
      // Older cameras: the legacy service map.
      try {
        const res = await call(deviceUrl, NS.device, 'GetCapabilities', '<Category>All</Category>')
        const caps = child(res, 'Capabilities')
        place('device', txt(child(caps, 'Device', 'XAddr')))
        place('media', txt(child(caps, 'Media', 'XAddr')))
        place('ptz', txt(child(caps, 'PTZ', 'XAddr')))
        place('imaging', txt(child(caps, 'Imaging', 'XAddr')))
        place('events', txt(child(caps, 'Events', 'XAddr')))
      } catch (err) {
        if (!(err instanceof OnvifError) || err.kind === 'auth') throw err
      }
      // Last resort: very simple cameras answer every service on the one address.
      if (!found.media && !found.media2) found.media = deviceUrl
      return found
    })
  }

  function parseProfiles(res: Record<string, unknown>, media2: boolean): OnvifProfile[] {
    const out: OnvifProfile[] = []
    for (const p of list(child(res, 'Profiles'))) {
      const token = attr(p, 'token')
      if (!token) continue
      const encoder = media2 ? child(p, 'Configurations', 'VideoEncoder') : child(p, 'VideoEncoderConfiguration')
      const ptz = media2 ? child(p, 'Configurations', 'PTZ') : child(p, 'PTZConfiguration')
      out.push({
        token,
        name: txt(child(p, 'Name')) || token,
        encoding: txt(child(encoder, 'Encoding')),
        width: num(child(encoder, 'Resolution', 'Width')),
        height: num(child(encoder, 'Resolution', 'Height')),
        ptz: ptz !== undefined,
        media2,
      })
    }
    return out
  }

  function getProfiles(): Promise<OnvifProfile[]> {
    return cached(session(), 'profiles', TTL.profiles, async () => {
      const services = await getServices()
      let firstError: unknown = null
      if (services.media) {
        try {
          const profiles = parseProfiles(await call(services.media, NS.media, 'GetProfiles', ''), false)
          if (profiles.length > 0 || !services.media2) return profiles
        } catch (err) {
          if (!(err instanceof OnvifError) || err.kind === 'auth' || !services.media2) throw err
          firstError = err
        }
      }
      if (services.media2) {
        return parseProfiles(await call(services.media2, NS.media2, 'GetProfiles', '<Type>All</Type>'), true)
      }
      if (firstError) throw firstError
      throw new OnvifError('unsupported', 'This camera does not offer video over ONVIF')
    })
  }

  async function mediaFor(profileToken: string): Promise<{ url: string; media2: boolean }> {
    const [services, profiles] = await Promise.all([getServices(), getProfiles()])
    const profile = profiles.find((p) => p.token === profileToken)
    const media2 = profile ? profile.media2 : !services.media
    const url = media2 ? services.media2 : services.media
    if (!url) throw new OnvifError('unsupported', 'This camera does not offer video over ONVIF')
    return { url, media2 }
  }

  function getStreamUri(profileToken: string): Promise<string> {
    return cached(session(), `stream:${profileToken}`, TTL.uris, async () => {
      const { url, media2 } = await mediaFor(profileToken)
      const token = `<ProfileToken>${esc(profileToken)}</ProfileToken>`
      const res = media2
        ? await call(url, NS.media2, 'GetStreamUri', `<Protocol>RTSP</Protocol>${token}`)
        : await call(
            url,
            NS.media,
            'GetStreamUri',
            `<StreamSetup><Stream xmlns="${NS.schema}">RTP-Unicast</Stream><Transport xmlns="${NS.schema}"><Protocol>RTSP</Protocol></Transport></StreamSetup>${token}`,
          )
      const uri = txt(child(res, 'MediaUri', 'Uri')) || txt(child(res, 'Uri'))
      if (!uri) throw new OnvifError('fault', 'The camera did not give a video address')
      return rewriteUri(uri, o.host, (reported) => o.rtspPort ?? reported)
    })
  }

  function getSnapshotUri(profileToken: string): Promise<string> {
    return cached(session(), `snapshot:${profileToken}`, TTL.uris, async () => {
      const { url, media2 } = await mediaFor(profileToken)
      const res = await call(url, media2 ? NS.media2 : NS.media, 'GetSnapshotUri', `<ProfileToken>${esc(profileToken)}</ProfileToken>`)
      const uri = txt(child(res, 'MediaUri', 'Uri')) || txt(child(res, 'Uri'))
      if (!uri) throw new OnvifError('unsupported', 'This camera does not offer still pictures over ONVIF')
      const native = session().nativePort
      return rewriteUri(uri, o.host, (reported, scheme) => {
        const standard = scheme === 'https' ? 443 : 80
        const theirs = reported ?? standard
        // Served by the same web server as ONVIF: use the port we reach that server on.
        const port = native === null || theirs === native ? o.port : theirs
        return port === standard ? null : port
      })
    })
  }

  async function fetchSnapshot(uri: string): Promise<Snapshot> {
    let res: Response
    try {
      res = await request(uri, {
        timeoutMs: o.timeoutMs,
        headers: { Connection: 'close' },
        digest: o.username ? { username: o.username, password: o.password } : undefined,
        insecure: true,
      })
    } catch (err) {
      throw transportError(err, o)
    }
    if (res.status === 401 || res.status === 403) throw new OnvifError('auth', 'The camera refused the username or password for the picture')
    if (res.status !== 200) throw new OnvifError('protocol', `The camera answered HTTP ${res.status} for the picture`)
    if (res.body.length === 0) throw new OnvifError('protocol', 'The camera sent an empty picture')
    // Some cameras answer 200 with a login or error page instead of the picture.
    const type = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    const jpeg = res.body.length > 3 && res.body[0] === 0xff && res.body[1] === 0xd8
    if (!jpeg && !type.startsWith('image/')) throw new OnvifError('protocol', 'The camera answered the picture request with something that is not a picture')
    return { contentType: jpeg ? 'image/jpeg' : type, body: res.body }
  }

  async function ptzUrl(): Promise<string> {
    const services = await getServices()
    if (!services.ptz) throw new OnvifError('unsupported', 'This camera does not offer movement controls over ONVIF')
    return services.ptz
  }

  async function continuousMove(profileToken: string, velocity: { pan?: number; tilt?: number; zoom?: number }, seconds?: number): Promise<void> {
    const pan = axis(velocity.pan)
    const tilt = axis(velocity.tilt)
    const zoom = axis(velocity.zoom)
    if (pan === 0 && tilt === 0 && zoom === 0) return stop(profileToken)
    const url = await ptzUrl()
    // An axis that is not moving is left out: the camera then leaves it alone, and
    // cameras without zoom (or that reject pan+zoom together) are not upset.
    const vector =
      (pan !== 0 || tilt !== 0 ? `<PanTilt x="${pan}" y="${tilt}" xmlns="${NS.schema}"/>` : '') + (zoom !== 0 ? `<Zoom x="${zoom}" xmlns="${NS.schema}"/>` : '')
    const head = `<ProfileToken>${esc(profileToken)}</ProfileToken><Velocity>${vector}</Velocity>`
    const secs = Number(seconds)
    if (Number.isFinite(secs) && secs > 0 && !session().noMoveTimeout) {
      try {
        await call(url, NS.ptz, 'ContinuousMove', `${head}<Timeout>PT${Math.max(1, Math.ceil(secs))}S</Timeout>`)
        return
      } catch (err) {
        // Some cameras refuse a timeout outside their own range; move without one from now on.
        if (!(err instanceof OnvifError) || err.kind !== 'fault' || !err.is(/timeout/i)) throw err
        session().noMoveTimeout = true
      }
    }
    await call(url, NS.ptz, 'ContinuousMove', head)
  }

  async function stop(profileToken: string): Promise<void> {
    await call(await ptzUrl(), NS.ptz, 'Stop', `<ProfileToken>${esc(profileToken)}</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom>`)
  }

  function getPresets(profileToken: string, maxAgeMs = 0): Promise<OnvifPreset[]> {
    return cached(session(), `presets:${profileToken}`, maxAgeMs, async () => {
      const res = await call(await ptzUrl(), NS.ptz, 'GetPresets', `<ProfileToken>${esc(profileToken)}</ProfileToken>`)
      const out: OnvifPreset[] = []
      for (const p of list(child(res, 'Preset'))) {
        const token = attr(p, 'token')
        if (token) out.push({ token, name: txt(child(p, 'Name')) })
      }
      return out
    })
  }

  async function gotoPreset(profileToken: string, preset: string | number): Promise<void> {
    await call(await ptzUrl(), NS.ptz, 'GotoPreset', `<ProfileToken>${esc(profileToken)}</ProfileToken><PresetToken>${esc(String(preset))}</PresetToken>`)
  }

  async function getStatus(profileToken: string): Promise<{ pan: number; tilt: number; zoom: number } | null> {
    const res = await call(await ptzUrl(), NS.ptz, 'GetStatus', `<ProfileToken>${esc(profileToken)}</ProfileToken>`)
    const position = child(res, 'PTZStatus', 'Position')
    const panTilt = child(position, 'PanTilt')
    const zoom = child(position, 'Zoom')
    if (panTilt === undefined && zoom === undefined) return null
    return { pan: num(attr(panTilt, 'x')), tilt: num(attr(panTilt, 'y')), zoom: num(attr(zoom, 'x')) }
  }

  function getDeviceInformation(maxAgeMs = 0): Promise<OnvifDeviceInformation> {
    return cached(session(), 'info', maxAgeMs, async () => {
      const res = await call(deviceUrl, NS.device, 'GetDeviceInformation', '')
      // This is the call the connection check rests on: an answer that carries none of the five
      // fields (a cut-off or foreign reply) must not pass for a camera.
      if (!['Manufacturer', 'Model', 'FirmwareVersion', 'SerialNumber', 'HardwareId'].some((k) => k in res)) {
        throw new OnvifError('protocol', 'Something answered at this address, but not as an ONVIF camera')
      }
      return {
        manufacturer: txt(child(res, 'Manufacturer')),
        model: txt(child(res, 'Model')),
        firmware: txt(child(res, 'FirmwareVersion')),
        serial: txt(child(res, 'SerialNumber')),
        hardwareId: txt(child(res, 'HardwareId')),
      }
    })
  }

  async function reboot(): Promise<string> {
    const res = await call(deviceUrl, NS.device, 'SystemReboot', '')
    forget()
    return txt(child(res, 'Message'))
  }

  function parseDot11(entry: unknown): OnvifDot11Entry {
    const security = child(entry, 'Security')
    const out: OnvifDot11Entry = {
      ssidHex: txt(child(entry, 'SSID')),
      mode: txt(child(entry, 'Mode')) || 'Infrastructure',
      alias: txt(child(entry, 'Alias')),
      priority: num(child(entry, 'Priority')),
      securityMode: txt(child(security, 'Mode')) || 'None',
    }
    const algorithm = txt(child(security, 'Algorithm'))
    if (algorithm) out.algorithm = algorithm
    const dot1x = txt(child(security, 'Dot1X'))
    if (dot1x) out.dot1x = dot1x
    return out
  }

  function getNetworkInterfaces(maxAgeMs = 0): Promise<OnvifNetworkInterface[]> {
    return cached(session(), 'network', maxAgeMs, async () => {
      const res = await call(deviceUrl, NS.device, 'GetNetworkInterfaces', '')
      return list(child(res, 'NetworkInterfaces')).map((n) => {
        const ext = child(n, 'Extension')
        // WiFi interfaces carry their type in Extension; a few cameras put it under Link instead.
        const type = txt(child(ext, 'InterfaceType')) || txt(child(n, 'Link', 'InterfaceType'))
        return {
          token: attr(n, 'token'),
          name: txt(child(n, 'Info', 'Name')),
          mac: txt(child(n, 'Info', 'HwAddress')),
          type: type ? num(type) : null,
          dot11: list(child(ext, 'Dot11')).map(parseDot11),
        }
      })
    })
  }

  async function getServiceCapabilities(): Promise<{ dot11: boolean | null }> {
    const res = await call(deviceUrl, NS.device, 'GetServiceCapabilities', '')
    const value = attr(child(res, 'Capabilities', 'Network'), 'Dot11Configuration')
    return { dot11: value ? isTrue(value) : null }
  }

  async function getDot11Capabilities(): Promise<{ scan: boolean; multiple: boolean }> {
    const res = await call(deviceUrl, NS.device, 'GetDot11Capabilities', '')
    const caps = child(res, 'Capabilities')
    return { scan: isTrue(child(caps, 'ScanAvailableNetworks')), multiple: isTrue(child(caps, 'MultipleConfiguration')) }
  }

  async function getDot11Status(interfaceToken: string): Promise<OnvifDot11Status> {
    const res = await call(deviceUrl, NS.device, 'GetDot11Status', `<InterfaceToken>${esc(interfaceToken)}</InterfaceToken>`)
    const status = child(res, 'Status')
    return { ssid: ssidFromHex(txt(child(status, 'SSID'))), signal: txt(child(status, 'SignalStrength')), alias: txt(child(status, 'ActiveConfigAlias')) }
  }

  async function scanDot11Networks(interfaceToken: string): Promise<OnvifDot11Network[]> {
    const res = await call(deviceUrl, NS.device, 'ScanAvailableDot11Networks', `<InterfaceToken>${esc(interfaceToken)}</InterfaceToken>`, {
      // Scanning the air takes the camera a few seconds.
      timeoutMs: o.timeoutMs * 2,
    })
    return list(child(res, 'Networks')).map((n) => ({
      ssid: ssidFromHex(txt(child(n, 'SSID'))),
      signal: txt(child(n, 'SignalStrength')),
      // "AuthAndMangementSuite" is misspelled in the ONVIF schema itself.
      auth: [...list(child(n, 'AuthAndMangementSuite')), ...list(child(n, 'AuthAndManagementSuite'))].map(txt).filter(Boolean),
      ciphers: list(child(n, 'PairCipher')).map(txt).filter(Boolean),
    }))
  }

  async function setDot11Networks(interfaceToken: string, entries: OnvifDot11Entry[]): Promise<{ rebootNeeded: boolean }> {
    // Schema order matters (xs:sequence): SSID, Mode, Alias, Priority, Security{Mode, Algorithm?, PSK?, Dot1X?}.
    const dot11 = entries
      .map((e) => {
        const psk = e.key ? `<PSK><Key>${esc(e.key)}</Key></PSK>` : e.passphrase ? `<PSK><Passphrase>${esc(e.passphrase)}</Passphrase></PSK>` : ''
        return (
          `<Dot11><SSID>${esc(e.ssidHex)}</SSID><Mode>${esc(e.mode)}</Mode><Alias>${esc(e.alias)}</Alias><Priority>${Math.round(clamp(e.priority, 0, 31))}</Priority>` +
          `<Security><Mode>${esc(e.securityMode)}</Mode>${e.algorithm ? `<Algorithm>${esc(e.algorithm)}</Algorithm>` : ''}${psk}${e.dot1x ? `<Dot1X>${esc(e.dot1x)}</Dot1X>` : ''}</Security></Dot11>`
        )
      })
      .join('')
    const res = await call(
      deviceUrl,
      NS.device,
      'SetNetworkInterfaces',
      `<InterfaceToken>${esc(interfaceToken)}</InterfaceToken><NetworkInterface><Enabled xmlns="${NS.schema}">true</Enabled><Extension xmlns="${NS.schema}">${dot11}</Extension></NetworkInterface>`,
    )
    session().cache.delete('network')
    return { rebootNeeded: isTrue(child(res, 'RebootNeeded')) }
  }

  function forget(): void {
    const s = sessions.get(key)
    if (!s) return
    // Keep the resolved video addresses: they stay valid across a restart of the camera.
    s.cache.clear()
    s.auth = null
    s.noStatus = false
    s.noMoveTimeout = false
  }

  return {
    syncClock: () => {
      session().cache.delete('clock')
      return cached(session(), 'clock', TTL.clock, readClock)
    },
    getDeviceInformation,
    getServices,
    getProfiles,
    getStreamUri,
    getSnapshotUri,
    fetchSnapshot,
    continuousMove,
    stop,
    getPresets,
    gotoPreset,
    getStatus,
    reboot,
    getNetworkInterfaces,
    getServiceCapabilities,
    getDot11Capabilities,
    getDot11Status,
    scanDot11Networks,
    setDot11Networks,
    sources: () => [...session().streams],
    remember: (sources) => {
      session().streams = [...sources]
    },
    forget,
  }
}

// ---------------------------------------------------------------------------
// Adapter glue
// ---------------------------------------------------------------------------

function flag(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
}

function optionsFor(ctx: AdapterContext): OnvifClientOptions & { path: string } {
  const extra = ctx.path.extra ?? {}
  const rtspPort = Number(extra.rtspPort)
  return {
    host: requireHost(ctx),
    port: ctx.path.port ?? DEFAULT_PORT,
    path: normalisePath(ctx.str('onvifPath', DEFAULT_PATH)),
    username: ctx.str('username').trim(),
    password: ctx.secret('password') ?? '',
    timeoutMs: ctx.timeoutMs,
    rtspPort: Number.isFinite(rtspPort) && rtspPort > 0 ? rtspPort : undefined,
  }
}

function sessionOf(ctx: AdapterContext): Session {
  return sessionFor(sessionKey(optionsFor(ctx)))
}

/** Main = sharpest picture, sub = the smallest other one, ptz = the profile to steer. */
function pickProfiles(profiles: OnvifProfile[]): { main: OnvifProfile | null; sub: OnvifProfile | null; ptz: OnvifProfile | null } {
  if (profiles.length === 0) return { main: null, sub: null, ptz: null }
  const area = (p: OnvifProfile) => p.width * p.height
  let main = profiles[0]!
  for (const p of profiles) if (area(p) > area(main)) main = p
  let sub: OnvifProfile | null = null
  for (const p of profiles) {
    if (p.token === main.token) continue
    if (!sub || area(p) < area(sub)) sub = p
  }
  const ptz = main.ptz ? main : profiles.find((p) => p.ptz) ?? main
  return { main, sub, ptz }
}

/** Cameras name unused slots "Preset 1", "preset_002"…: show just the number. */
function presetLabel(p: OnvifPreset): string {
  const numbered = /^preset[\s_-]*0*(\d+)$/i.exec(p.name)
  if (numbered) return numbered[1]!
  return p.name || p.token
}

function rememberPresets(s: Session, presets: OnvifPreset[]): string[] {
  s.presetLabels.clear()
  const labels: string[] = []
  for (const p of presets) {
    const label = presetLabel(p)
    if (s.presetLabels.has(label)) continue
    s.presetLabels.set(label, p.token)
    if (labels.length < MAX_PRESETS) labels.push(label)
  }
  return labels
}

function clearStop(s: Session): void {
  if (s.stopTimer) clearTimeout(s.stopTimer)
  s.stopTimer = null
}

/** Device-level refusal -> a sentence for the owner. Anything else (unreachable) is thrown on. */
function refusal(err: unknown, doing: string, opts: { needsAdmin?: boolean } = {}): ActionResult {
  if (!(err instanceof OnvifError)) throw err
  switch (err.kind) {
    case 'auth':
      return {
        ok: false,
        error: opts.needsAdmin
          ? `The camera did not accept this login for ${doing}. It needs the camera's administrator username and password.`
          : 'Wrong username or password',
      }
    case 'unsupported':
      return { ok: false, error: err.message }
    case 'protocol':
      return { ok: false, error: `${err.message}. Check the port and the ONVIF address path.` }
    case 'fault':
      if (err.is(/ActionNotSupported|NotSupported|NoPTZProfile|not\s+supported|not\s+implemented/i)) {
        return { ok: false, error: `This camera does not support ${doing} over ONVIF` }
      }
      return { ok: false, error: `The camera refused ${doing}: ${err.message}` }
  }
}

function infoState(info: OnvifDeviceInformation): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (info.model) out.model = info.manufacturer && !info.model.toLowerCase().includes(info.manufacturer.toLowerCase()) ? `${info.manufacturer} ${info.model}` : info.model
  if (info.firmware) out.firmware = info.firmware
  if (info.serial) out.serial = info.serial
  if (info.hardwareId) out.hardwareId = info.hardwareId
  return out
}

const NOT_ONVIF = 'Something answered at this address, but not as an ONVIF camera. Check the port and the ONVIF address path, and that ONVIF is switched on in the camera.'
const NO_WIFI_OVER_ONVIF = 'This camera does not allow its WiFi to be changed over ONVIF. Use the camera’s own app for that.'

/** The request went out and nothing (or only a dropped connection) came back. Not: the connection was refused. */
function wentQuiet(err: unknown): boolean {
  return /did not answer in time|closed the connection/i.test(err instanceof Error ? err.message : String(err))
}

function wifiInterface(interfaces: OnvifNetworkInterface[]): OnvifNetworkInterface | null {
  return interfaces.find((i) => i.type === IFTYPE_WIFI && i.token) ?? interfaces.find((i) => i.dot11.length > 0 && i.token) ?? null
}

function newAlias(ssid: string, taken: Set<string>): string {
  const slug = ssid.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'network'
  let alias = `wifi-${slug}`
  for (let n = 2; taken.has(alias); n++) alias = `wifi-${slug}-${n}`
  return alias
}

const adapter: Adapter = {
  family: 'onvif',

  describe(): FamilyDescriptor {
    return {
      id: 'onvif',
      label: 'ONVIF camera',
      tagline: 'Works with most IP cameras. ONVIF is the common language nearly every camera brand understands.',
      kinds: ['camera'],
      fields: [
        FIELD.username('The camera login. Many cameras have a separate ONVIF user that you create in the camera’s own settings.'),
        { ...FIELD.password('Stored encrypted on the hub. Leave empty only if the camera really has no password.'), required: false },
        {
          name: 'onvifPath',
          label: 'ONVIF address path',
          type: 'text',
          default: DEFAULT_PATH,
          help: 'Leave as it is. Only change it if the camera’s manual gives a different ONVIF address.',
        },
        {
          name: 'ptz',
          label: 'Camera can turn and zoom',
          type: 'toggle',
          default: true,
          help: 'Shows the arrows and saved positions. Switch off for a fixed camera.',
        },
        {
          name: 'wifi',
          label: 'Let the hub change the camera’s WiFi',
          type: 'toggle',
          default: false,
          help: 'Few cameras allow this over ONVIF. If yours does not, the hub says so when you try and nothing is changed; use the camera’s own app instead.',
        },
      ],
      pathKinds: ['lan', 'cellular'],
      defaultPort: DEFAULT_PORT,
      capabilities: ['stream', 'snapshot', 'ptz', 'presets', 'wifi', 'wifi-scan', 'reboot', 'state'],
      notes: [
        'ONVIF has to be switched on in the camera first. On many cameras you also create an ONVIF user there; use that login here.',
        'If the camera refuses the login, the hub waits five minutes before trying the same one again, so the camera does not lock the account. A corrected password is tried straight away.',
        'The port is usually 80. Some brands use another one, such as 8000, 8080, 8899 or 2020: the camera’s manual or app says which.',
        'Live video, still pictures, turning and zooming, saved positions and restart work on most cameras. Restart needs an administrator login.',
        `The camera turns or zooms while you hold the button. If letting go does not get through from the phone, it stops by itself after ${DEFAULT_MOVE_SECONDS} seconds.`,
        'Changing the camera’s WiFi from here only works on the few cameras that allow it over ONVIF. When a camera does not, the hub tells you and changes nothing.',
        'Some cameras remember only one WiFi network. On those the new network replaces the old one, so if the camera cannot join it (wrong WiFi password, too far from the router) it has to be put back on WiFi with its own app.',
        'Over the SIM connection the camera must be reachable from outside on its ONVIF port and on its video port (usually 554). Most ordinary SIM cards do not allow that.',
        'Motion alerts are not read from the camera through this option.',
      ],
    }
  },

  capabilities(config: Record<string, unknown>, _kind: DeviceKind): Capability[] {
    const caps: Capability[] = ['stream', 'snapshot', 'reboot', 'state']
    if (flag(config.ptz, true)) caps.push('ptz', 'presets')
    if (flag(config.wifi, false)) caps.push('wifi', 'wifi-scan')
    return caps
  },

  async probe(ctx): Promise<ProbeResult> {
    let client: OnvifClient
    let hasUser: boolean
    let s: Session
    let fp: string
    try {
      const options = optionsFor(ctx)
      hasUser = options.username !== ''
      client = onvifClient(options)
      s = sessionFor(sessionKey(options))
      fp = fingerprint(options.username, options.password)
    } catch (err) {
      return { ok: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) }
    }
    const started = Date.now()
    try {
      await client.syncClock()
    } catch (err) {
      if (!(err instanceof OnvifError)) return { ok: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) }
      if (err.kind === 'protocol') return { ok: false, latencyMs: null, error: NOT_ONVIF }
      // The camera answered but keeps its clock behind the login: carry on.
    }
    const latencyMs = Date.now() - started
    // The camera is there. If it refused this very login a moment ago, do not knock again
    // yet: a few wrong tries in a row make many cameras lock the account.
    if (s.refused && s.refused.fp === fp && Date.now() < s.refused.until) {
      const minutes = Math.max(1, Math.ceil((s.refused.until - Date.now()) / 60_000))
      return {
        ok: false,
        latencyMs: null,
        error: `${s.refused.error}. The hub tries this login again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, so the camera does not lock it out; a changed password is tried at once.`,
      }
    }
    try {
      const info = await client.getDeviceInformation()
      s.refused = null
      return { ok: true, latencyMs, info: infoState(info) }
    } catch (err) {
      if (err instanceof OnvifError) {
        if (err.kind === 'auth') {
          const error = hasUser ? 'Wrong username or password' : 'This camera needs a username and password'
          s.refused = { fp, until: Date.now() + AUTH_RETRY_MS, error }
          return { ok: false, latencyMs: null, error }
        }
        if (err.kind === 'protocol') return { ok: false, latencyMs: null, error: NOT_ONVIF }
        return { ok: false, latencyMs: null, error: `The camera answered with an error: ${err.message}` }
      }
      return { ok: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async readState(ctx): Promise<Record<string, unknown>> {
    const client = onvifClient(optionsFor(ctx))
    const s = sessionOf(ctx)
    const state: Record<string, unknown> = infoState(await client.getDeviceInformation(TTL.info))
    const { main, sub, ptz } = pickProfiles(await client.getProfiles())
    const wantPtz = ctx.bool('ptz', true) && ptz !== null
    const wantWifi = ctx.bool('wifi', false)

    const jobs: Promise<void>[] = []

    // Video addresses for streamSources(), which cannot wait for the camera.
    if (main) {
      jobs.push(
        (async () => {
          const uris: string[] = []
          for (const p of [main, sub]) {
            if (!p) continue
            try {
              const uri = await client.getStreamUri(p.token)
              if (!uris.includes(uri)) uris.push(uri)
            } catch (err) {
              if (!(err instanceof OnvifError)) throw err
              ctx.log.debug(`no video address for profile ${p.name}: ${err.message}`)
            }
          }
          if (uris.length > 0) client.remember(uris)
        })(),
      )
    }

    if (wantPtz && ptz) {
      jobs.push(
        (async () => {
          try {
            state.presets = rememberPresets(s, await client.getPresets(ptz.token, TTL.presets))
          } catch (err) {
            if (!(err instanceof OnvifError)) throw err
          }
        })(),
      )
      if (!s.noStatus) {
        jobs.push(
          (async () => {
            try {
              const position = await client.getStatus(ptz.token)
              if (position) state.ptz = position
              else s.noStatus = true
            } catch (err) {
              if (!(err instanceof OnvifError)) throw err
              s.noStatus = true
            }
          })(),
        )
      }
    }

    jobs.push(
      (async () => {
        let interfaces: OnvifNetworkInterface[]
        try {
          interfaces = await client.getNetworkInterfaces(TTL.network)
        } catch (err) {
          if (!(err instanceof OnvifError)) throw err
          return
        }
        const mac = interfaces.find((i) => i.mac)?.mac
        if (mac) state.mac = mac
        const wifi = wantWifi ? wifiInterface(interfaces) : null
        if (!wifi) return
        try {
          const status = await client.getDot11Status(wifi.token)
          if (status.ssid) state.wifi = status.ssid
          const signal = signalPercent(status.signal)
          if (signal !== null) state.signal = signal
        } catch (err) {
          if (!(err instanceof OnvifError)) throw err
        }
      })(),
    )

    const settled = await Promise.allSettled(jobs)
    for (const r of settled) if (r.status === 'rejected') throw r.reason
    return state
  },

  async execute(ctx, action: Action): Promise<ActionResult> {
    const p = action.params
    switch (action.type) {
      case 'ptz.move':
      case 'ptz.stop':
      case 'ptz.preset': {
        if (!ctx.bool('ptz', true)) return { ok: false, error: 'Turning and zooming is switched off for this camera. Switch on "Camera can turn and zoom" in its settings.' }
        const client = onvifClient(optionsFor(ctx))
        const s = sessionOf(ctx)
        let profile: OnvifProfile | null
        try {
          profile = pickProfiles(await client.getProfiles()).ptz
        } catch (err) {
          return refusal(err, 'moving')
        }
        if (!profile) return { ok: false, error: 'The camera did not list any video profile to steer' }
        const token = profile.token

        if (action.type === 'ptz.stop') {
          clearStop(s)
          try {
            await client.stop(token)
          } catch (err) {
            return refusal(err, 'stopping')
          }
          return { ok: true }
        }

        if (action.type === 'ptz.preset') {
          const wanted = String(p.preset ?? '').trim()
          if (!wanted) return { ok: false, error: 'No preset chosen' }
          clearStop(s)
          let target = wanted
          try {
            const presets = await client.getPresets(token, TTL.profiles)
            rememberPresets(s, presets)
            const found =
              s.presetLabels.get(wanted) ??
              presets.find((x) => x.token === wanted)?.token ??
              presets.find((x) => x.name.toLowerCase() === wanted.toLowerCase())?.token
            if (!found && presets.length > 0) return { ok: false, error: `The camera has no preset "${wanted}"` }
            if (found) target = found
          } catch (err) {
            // The list could not be read; try the value as the preset's own id.
            if (!(err instanceof OnvifError) || err.kind === 'auth') return refusal(err, 'going to a preset')
          }
          try {
            await client.gotoPreset(token, target)
          } catch (err) {
            if (err instanceof OnvifError && err.kind === 'fault' && err.is(/NoToken|preset/i)) return { ok: false, error: `The camera has no preset "${wanted}"` }
            return refusal(err, 'going to a preset')
          }
          return { ok: true, result: { preset: wanted } }
        }

        // ptz.move
        const velocity = { pan: axis(p.pan), tilt: axis(p.tilt), zoom: axis(p.zoom) }
        clearStop(s)
        if (velocity.pan === 0 && velocity.tilt === 0 && velocity.zoom === 0) {
          try {
            await client.stop(token)
          } catch (err) {
            return refusal(err, 'stopping')
          }
          return { ok: true }
        }
        // The app sends one "move" when a button is pressed and "stop" when it is let go. If that
        // stop never arrives (phone lost its signal, app closed) the camera must not keep turning,
        // so every move has a limit: the one asked for, or DEFAULT_MOVE_SECONDS.
        const requested = Number(p.seconds ?? 0)
        const seconds = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_MOVE_SECONDS) : DEFAULT_MOVE_SECONDS
        try {
          await client.continuousMove(token, velocity, seconds)
        } catch (err) {
          return refusal(err, 'moving')
        }
        // The camera was given the same limit, but not every camera honours it.
        const log = ctx.log
        s.stopTimer = setTimeout(() => {
          s.stopTimer = null
          client.stop(token).catch((err: unknown) => log.debug(`auto-stop failed: ${err instanceof Error ? err.message : String(err)}`))
        }, seconds * 1000)
        s.stopTimer.unref?.()
        return { ok: true, result: { stopsAfterSeconds: seconds } }
      }

      case 'reboot': {
        const client = onvifClient(optionsFor(ctx))
        clearStop(sessionOf(ctx))
        try {
          const message = await client.reboot()
          return { ok: true, result: message ? { message } : {} }
        } catch (err) {
          return refusal(err, 'restarting', { needsAdmin: true })
        }
      }

      default:
        return unsupported(action)
    }
  },

  async snapshot(ctx): Promise<Snapshot> {
    const client = onvifClient(optionsFor(ctx))
    const { main } = pickProfiles(await client.getProfiles())
    if (!main) throw new Error('The camera did not list any video profile')
    let uri: string
    try {
      uri = await client.getSnapshotUri(main.token)
    } catch (err) {
      if (err instanceof OnvifError && err.kind === 'fault') throw new Error('This camera does not offer still pictures over ONVIF')
      throw err
    }
    try {
      return await client.fetchSnapshot(uri)
    } catch (err) {
      // The address may have gone stale (firmware change): ask again next time.
      if (err instanceof OnvifError) sessionOf(ctx).cache.delete(`snapshot:${main.token}`)
      throw err
    }
  },

  streamSources(ctx): string[] {
    const o = optionsFor(ctx)
    const s = sessions.get(sessionKey(o))
    if (s && s.streams.length > 0) return s.streams.map((uri) => withLogin(uri, o.username, o.password))
    // Nothing resolved yet (the hub has only just started): let go2rtc ask the camera itself.
    return [`onvif://${userInfo(o.username, o.password)}${bracket(o.host)}:${o.port}${o.path === DEFAULT_PATH ? '' : o.path}`]
  },

  async scanWifi(ctx): Promise<WifiScanEntry[]> {
    if (!ctx.bool('wifi', false)) throw new Error('WiFi control is switched off for this camera')
    const client = onvifClient(optionsFor(ctx))
    try {
      const wifi = wifiInterface(await client.getNetworkInterfaces(TTL.network))
      if (!wifi) throw new OnvifError('unsupported', 'This camera does not report a WiFi connection over ONVIF')
      const best = new Map<string, WifiScanEntry>()
      for (const n of await client.scanDot11Networks(wifi.token)) {
        if (!n.ssid) continue
        const entry: WifiScanEntry = { ssid: n.ssid, signal: signalPercent(n.signal), security: securityLabel(n) }
        const seen = best.get(n.ssid)
        if (!seen || (entry.signal ?? -1) > (seen.signal ?? -1)) best.set(n.ssid, entry)
      }
      return [...best.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1))
    } catch (err) {
      if (!(err instanceof OnvifError)) throw err
      if (err.kind === 'auth') throw new Error('Wrong username or password')
      if (err.kind === 'fault') throw new Error('This camera cannot list WiFi networks over ONVIF')
      throw new Error(err.message)
    }
  },

  async setWifi(ctx, target): Promise<ActionResult> {
    if (!ctx.bool('wifi', false)) return { ok: false, error: 'WiFi control is switched off for this camera. Switch on "Let the hub change the camera’s WiFi" in its settings.' }
    const ssid = (target.ssid ?? '').trim()
    const password = target.password ?? ''
    if (!ssid) return { ok: false, error: 'No network name given' }
    const ssidBytes = Buffer.byteLength(ssid, 'utf8')
    if (ssidBytes > 32) return { ok: false, error: 'That network name is too long for WiFi (32 characters at most)' }
    if (!password) return { ok: false, error: `No password stored for "${ssid}"` }
    const isKey = /^[0-9a-f]{64}$/i.test(password)
    if (!isKey && !/^[ -~]{8,63}$/.test(password)) {
      return { ok: false, error: 'The WiFi password must be 8 to 63 plain characters (letters, digits and common symbols) for the camera to accept it' }
    }

    const client = onvifClient(optionsFor(ctx))
    const doing = 'changing its WiFi'
    try {
      // 1. Does this camera allow it at all?
      try {
        const caps = await client.getServiceCapabilities()
        if (caps.dot11 === false) return { ok: false, error: NO_WIFI_OVER_ONVIF }
      } catch (err) {
        if (!(err instanceof OnvifError) || err.kind !== 'fault') throw err
        // Older cameras lack this call; the next one decides.
      }
      let multiple = false
      try {
        multiple = (await client.getDot11Capabilities()).multiple
      } catch (err) {
        if (err instanceof OnvifError && err.kind === 'fault') return { ok: false, error: NO_WIFI_OVER_ONVIF }
        throw err
      }

      // 2. Which interface, and which networks does it already know?
      const wifi = wifiInterface(await client.getNetworkInterfaces())
      if (!wifi) return { ok: false, error: 'This camera has no WiFi connection that can be changed over ONVIF' }

      // 3. Sending any WiFi entry replaces the camera's whole list, so the ones it already
      //    has are sent back (without a key: the camera keeps the stored one) plus the new one.
      const ssidHex = ssidToHex(ssid)
      const same = wifi.dot11.find((e) => e.ssidHex.toLowerCase() === ssidHex.toLowerCase())
      const kept = multiple ? wifi.dot11.filter((e) => e !== same && e.alias).map((e) => ({ ...e, priority: Math.min(e.priority, 30) })) : []
      const top = kept.reduce((m, e) => Math.max(m, e.priority), -1)
      // Networks the camera will no longer know after this (it holds one at a time, or gave no name to resend them under).
      const replaced = wifi.dot11
        .filter((e) => e !== same && !kept.some((k) => k.alias === e.alias))
        .map((e) => ssidFromHex(e.ssidHex))
        .filter(Boolean)
      const lost =
        replaced.length > 0
          ? {
              replaced,
              warning: `On this camera "${ssid}" takes the place of ${replaced.map((n) => `"${n}"`).join(', ')}; it does not keep both. If it cannot join "${ssid}", put it back on WiFi with the camera’s own app.`,
            }
          : {}
      const added: OnvifDot11Entry = {
        ssidHex,
        mode: 'Infrastructure',
        alias: same?.alias || newAlias(ssid, new Set(wifi.dot11.map((e) => e.alias))),
        priority: Math.min(31, top + 1),
        securityMode: 'PSK',
        algorithm: 'Any',
        ...(isKey ? { key: password } : { passphrase: password }),
      }
      let rebootNeeded: boolean
      try {
        rebootNeeded = (await client.setDot11Networks(wifi.token, [...kept, added])).rebootNeeded
      } catch (err) {
        if (err instanceof OnvifError || !wentQuiet(err)) throw err
        // It answered every question a moment ago and fell silent on this one: a camera that
        // switches networks at once often drops off before it can reply. The hub now looks for it
        // on the new network, which is what settles whether the move worked.
        client.forget()
        return {
          ok: true,
          result: {
            ssid,
            answered: false,
            note: 'The camera stopped answering as soon as it was given the new WiFi, which usually means it is already moving over.',
            ...lost,
          },
        }
      }

      // 4. Some cameras only switch over after a restart.
      let restarted = false
      if (rebootNeeded) {
        try {
          await client.reboot()
          restarted = true
        } catch (err) {
          if (err instanceof OnvifError) {
            return { ok: false, error: 'The camera saved the new WiFi but has to restart to use it, and it refused to restart. Switch it off and on again by hand.' }
          }
          // No answer at all: it has most likely already dropped off to restart or move.
          restarted = true
        }
      }
      client.forget()
      // No state.wifi here: the camera has only been told. The hub sets it once the camera is found on the new network.
      return { ok: true, result: { ssid, rebootNeeded, restarted, ...lost } }
    } catch (err) {
      if (err instanceof OnvifError && err.kind === 'fault' && err.is(/InvalidDot11|NotDot11/i)) return { ok: false, error: NO_WIFI_OVER_ONVIF }
      return refusal(err, doing, { needsAdmin: true })
    }
  },

  async discover(seconds: number, log: Logger): Promise<DiscoveredDevice[]> {
    // Imported on demand: discovery.ts imports the adapter list, which imports this file.
    const { onvifProbe } = await import('../discovery.ts')
    return onvifProbe(seconds, log)
  },
}

export default adapter
