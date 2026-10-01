/**
 * Tuya / Smart Life devices through the Tuya IoT Platform OpenAPI — the path
 * that works from anywhere the device has internet, even when it is not on the
 * hub's network.
 *
 * Wire protocol (docs/protocols/lights-tasmota-shelly-tuya.md):
 *   GET  /v1.0/token?grant_type=1                      -> access_token, expire_time (s)
 *   GET  /v1.0/iot-03/devices/{id}                     -> name, model, ip, online ...
 *   GET  /v1.0/iot-03/devices/{id}/status              -> [{ code, value }]
 *   GET  /v1.0/iot-03/devices/{id}/specification       -> ranges of each code
 *   POST /v1.0/iot-03/devices/{id}/commands            <- { commands: [{ code, value }] }
 * Every request carries client_id, t, nonce, sign_method and
 *   sign = UPPER(HMAC-SHA256(client_id + [access_token] + t + nonce + stringToSign, secret))
 *   stringToSign = METHOD \n SHA256(body) \n <signature headers> \n path?sortedQuery
 *
 * The free Tuya plan allows only a limited number of requests, and the hub
 * checks every device several times a minute, so status answers are kept for
 * `refreshSeconds` and commands update that copy straight away.
 */
import crypto from 'node:crypto'
import type { Action, Capability, DeviceKind, FamilyDescriptor, GateState } from '@house/shared'
import { request, sleep } from '../lib/http.ts'
import { clamp, unsupported, type ActionResult, type Adapter, type AdapterContext, type ProbeResult } from './types.ts'

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Tuya's regional OpenAPI hosts. The project's data centre must match the Smart Life account's region. */
export const TUYA_REGIONS: Record<string, { label: string; url: string }> = {
  in: { label: 'India', url: 'https://openapi.tuyain.com' },
  sg: { label: 'Singapore', url: 'https://openapi-sg.iotbing.com' },
  eu: { label: 'Central Europe', url: 'https://openapi.tuyaeu.com' },
  'eu-w': { label: 'Western Europe', url: 'https://openapi-weaz.tuyaeu.com' },
  us: { label: 'Western America', url: 'https://openapi.tuyaus.com' },
  'us-e': { label: 'Eastern America', url: 'https://openapi-ueaz.tuyaus.com' },
  cn: { label: 'China', url: 'https://openapi.tuyacn.com' },
}

const DEFAULT_REGION = 'in'

/**
 * Where to send requests on this path: an address typed on the connection
 * itself (when it starts with http), else the custom address in the settings,
 * else the chosen region.
 */
export function tuyaApiBase(ctx: AdapterContext): string {
  const host = (ctx.path.host ?? '').trim()
  if (/^https?:\/\//i.test(host)) {
    const base = host.replace(/\/+$/, '')
    if (ctx.path.port && !hasExplicitPort(base)) return `${base}:${ctx.path.port}`
    return base
  }
  const custom = ctx.str('apiBase').trim()
  if (custom) return (/^https?:\/\//i.test(custom) ? custom : `https://${custom}`).replace(/\/+$/, '')
  const fromPath = typeof ctx.path.extra?.region === 'string' ? ctx.path.extra.region.trim() : ''
  const region = fromPath || ctx.str('region', DEFAULT_REGION).trim() || DEFAULT_REGION
  return (TUYA_REGIONS[region] ?? TUYA_REGIONS[DEFAULT_REGION]!).url
}

function hasExplicitPort(base: string): boolean {
  try {
    return new URL(base).port !== ''
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

type QueryValue = string | number | boolean

/** The url part of the string-to-sign: the path, then the query with its keys in alphabetical order. */
export function tuyaCanonicalUrl(path: string, query: Record<string, QueryValue> = {}): string {
  const keys = Object.keys(query).sort()
  if (keys.length === 0) return path
  return `${path}?${keys.map((k) => `${k}=${String(query[k])}`).join('&')}`
}

export interface TuyaSignInput {
  clientId: string
  secret: string
  /** Left out for the token call, required for every other call. */
  accessToken?: string
  /** 13-digit millisecond timestamp, the same value sent in the `t` header. */
  t: string | number
  nonce?: string
  method: string
  /** Path plus sorted query, see tuyaCanonicalUrl(). */
  url: string
  /** The exact body bytes sent; empty for GET. */
  body?: string
  /** Only when a Signature-Headers header is sent (this adapter never sends one). */
  signatureHeaders?: Record<string, string>
}

/** sign header value: upper-case hex HMAC-SHA256 over Tuya's documented string. */
export function tuyaSign(input: TuyaSignInput): string {
  const headerLines = Object.entries(input.signatureHeaders ?? {})
    .map(([k, v]) => `${k}:${v}\n`)
    .join('')
  const stringToSign = `${input.method.toUpperCase()}\n${sha256Hex(input.body ?? '')}\n${headerLines}\n${input.url}`
  const message = input.clientId + (input.accessToken ?? '') + String(input.t) + (input.nonce ?? '') + stringToSign
  return crypto.createHmac('sha256', input.secret).update(message, 'utf8').digest('hex').toUpperCase()
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface TuyaCredentials {
  /** https://openapi.tuyain.com, no trailing slash. */
  base: string
  accessId: string
  accessSecret: string
  timeoutMs: number
}

/** Tuya answered, but with success:false. `message` is safe to show to the owner. */
export class TuyaApiError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly tuyaMsg: string,
  ) {
    super(message)
  }
}

interface Envelope {
  success: boolean
  result?: unknown
  code?: number
  msg?: string
}

interface TokenEntry {
  token: string
  /** When to stop using it: one minute before Tuya lets it lapse. */
  expiresAt: number
}

const TOKEN_MARGIN_S = 60
const tokens = new Map<string, TokenEntry>()
const tokenFlights = new Map<string, Promise<TokenEntry>>()

function tokenKey(cred: TuyaCredentials): string {
  return `${cred.base}|${cred.accessId}|${sha256Hex(cred.accessSecret).slice(0, 12)}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function lowerFirst(s: string): string {
  return s.length > 1 && /[A-Z]/.test(s[0]!) && /[a-z]/.test(s[1]!) ? s[0]!.toLowerCase() + s.slice(1) : s
}

/** One signed request. Throws a plain Error when the cloud cannot be reached or answers nonsense. */
async function send(
  cred: TuyaCredentials,
  method: 'GET' | 'POST',
  path: string,
  query: Record<string, QueryValue> | undefined,
  body: string,
  accessToken: string | undefined,
): Promise<Envelope> {
  const t = String(Date.now())
  const nonce = crypto.randomBytes(16).toString('hex')
  const sign = tuyaSign({ clientId: cred.accessId, secret: cred.accessSecret, accessToken, t, nonce, method, url: tuyaCanonicalUrl(path, query), body })
  const headers: Record<string, string> = { client_id: cred.accessId, sign, sign_method: 'HMAC-SHA256', t, nonce }
  if (accessToken) headers.access_token = accessToken
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'
    // An explicit length keeps Node from sending the body in chunks, which is how every known-good Tuya client sends it.
    headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'))
  }
  const keys = Object.keys(query ?? {}).sort()
  const search = keys.length ? `?${keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(query![k]))}`).join('&')}` : ''

  let res: Awaited<ReturnType<typeof request>>
  try {
    res = await request(`${cred.base}${path}${search}`, { method, headers, body: body || undefined, timeoutMs: cred.timeoutMs })
  } catch (err) {
    throw new Error(`Could not reach Tuya's cloud: ${lowerFirst(err instanceof Error ? err.message : String(err))}`)
  }
  let parsed: unknown
  try {
    parsed = res.json()
  } catch {
    parsed = null
  }
  if (isRecord(parsed) && typeof parsed.success === 'boolean') {
    return {
      success: parsed.success,
      result: parsed.result,
      code: typeof parsed.code === 'number' ? parsed.code : Number(parsed.code) || undefined,
      msg: typeof parsed.msg === 'string' ? parsed.msg : undefined,
    }
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`Tuya's cloud answered with an error (HTTP ${res.status})`)
  throw new Error("Tuya's cloud sent an answer the hub could not read")
}

/** Turn Tuya's code + msg into a sentence the owner can act on. Tuya's own words are always included. */
function apiError(env: Envelope): TuyaApiError {
  const code = env.code ?? 0
  const msg = (env.msg ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || `error ${code}`
  const said = `(Tuya said: ${msg})`
  let text: string
  if (code === 1004 || code === 1001 || code === 1005 || /sign invalid|secret invalid|clientid.*invalid/i.test(msg)) {
    text = `Wrong Access ID or Access Secret, or the wrong region is chosen ${said}`
  } else if (code === 1106 || /permission deny/i.test(msg)) {
    text = `Tuya refused: this device is not linked to your cloud project, or the project is in another region ${said}`
  } else if (code === 2001 || /device is offline/i.test(msg)) {
    text = `The device is offline: check its power and its WiFi ${said}`
  } else if (code === 2008 || /not support/i.test(msg)) {
    text = `The device does not accept this command ${said}`
  } else if (code === 1013 || /request time is invalid/i.test(msg)) {
    text = `The clock of the hub computer is wrong; set its date and time ${said}`
  } else if (/expired|quota|used up/i.test(msg) && !/token/i.test(msg)) {
    text = `Your Tuya IoT Core plan has run out or its limit is used up; renew it on the Tuya developer website ${said}`
  } else if (/not authorized|no permissions/i.test(msg)) {
    text = `Your Tuya cloud project is not allowed to use this service; add the IoT Core service to the project ${said}`
  } else {
    text = `Tuya said: ${msg}`
  }
  return new TuyaApiError(text, code, msg)
}

function isTokenInvalid(env: Envelope): boolean {
  return env.code === 1010 || env.code === 1011 || env.code === 1012 || /token\s+(is\s+)?(invalid|expired?)/i.test(env.msg ?? '')
}

async function fetchToken(cred: TuyaCredentials): Promise<TokenEntry> {
  const env = await send(cred, 'GET', '/v1.0/token', { grant_type: 1 }, '', undefined)
  if (!env.success) throw apiError(env)
  const r = isRecord(env.result) ? env.result : {}
  const token = typeof r.access_token === 'string' ? r.access_token : ''
  if (!token) throw new Error("Tuya's cloud sent a sign-in answer the hub could not read")
  const lifetimeS = Number(r.expire_time)
  const usableS = Number.isFinite(lifetimeS) ? Math.max(0, lifetimeS - TOKEN_MARGIN_S) : 0
  return { token, expiresAt: Date.now() + usableS * 1000 }
}

/** The cached access token for this client id, or a new one (one request even when several devices ask at once). */
async function accessToken(cred: TuyaCredentials): Promise<TokenEntry> {
  const key = tokenKey(cred)
  const cached = tokens.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached
  let flight = tokenFlights.get(key)
  if (!flight) {
    flight = fetchToken(cred)
      .then((entry) => {
        tokens.set(key, entry)
        return entry
      })
      .finally(() => tokenFlights.delete(key))
    tokenFlights.set(key, flight)
  }
  return flight
}

/**
 * A signed business call. Returns Tuya's `result`; throws TuyaApiError when Tuya
 * answers success:false, a plain Error when the cloud cannot be reached. A
 * "token invalid" answer gets a new token and one retry.
 */
export async function tuyaCloudCall(
  cred: TuyaCredentials,
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Record<string, QueryValue>; body?: unknown } = {},
): Promise<unknown> {
  const body = opts.body === undefined ? '' : JSON.stringify(opts.body)
  for (let attempt = 0; ; attempt++) {
    const entry = await accessToken(cred)
    const env = await send(cred, method, path, opts.query, body, entry.token)
    if (env.success) return env.result
    if (attempt === 0 && isTokenInvalid(env)) {
      const key = tokenKey(cred)
      if (tokens.get(key)?.token === entry.token) tokens.delete(key)
      continue
    }
    throw apiError(env)
  }
}

// ---------------------------------------------------------------------------
// Per-device memory
// ---------------------------------------------------------------------------

interface DataPoint {
  code: string
  value: unknown
}

interface Range {
  min: number
  max: number
}

interface DeviceMemo {
  status?: { list: DataPoint[]; at: number; ttlMs: number }
  detail?: { res: ProbeResult; at: number; ttlMs: number }
  ranges?: { byCode: Map<string, Range>; until: number }
  /** A door move the hub started and is waiting to see finished. */
  motion?: { goal: 'open' | 'closed'; until: number }
}

const memos = new Map<string, DeviceMemo>()

/** Forget every token and remembered status (used by tests, and safe at any time). */
export function resetTuyaCloud(): void {
  tokens.clear()
  tokenFlights.clear()
  memos.clear()
}

/** Ranges from Tuya's standard instruction sets; the device's own specification wins when it can be read. */
const DOCUMENTED_RANGES: Record<string, Range> = {
  bright_value_v2: { min: 10, max: 1000 },
  bright_value: { min: 25, max: 255 },
  temp_value_v2: { min: 0, max: 1000 },
  temp_value: { min: 0, max: 255 },
}

const SWITCH_CODES = ['switch_led', 'switch_1', 'switch']
const GATE_SWITCH_CODES = ['switch_1', 'switch', 'switch_led']
const DIM_CODES = ['bright_value_v2', 'bright_value']
const TEMP_CODES = ['temp_value_v2', 'temp_value']
/** Colour codes with the top of their saturation / brightness scale. */
const COLOUR_CODES: Array<{ code: string; max: number }> = [
  { code: 'colour_data_v2', max: 1000 },
  { code: 'colour_data', max: 255 },
]
const DOOR_SENSOR_CODE = 'doorcontact_state'
const TRAVEL_TIME_CODE = 'tr_timecon'

const DEFAULT_REFRESH_S = 300
/** After a command, look again soon so the tile shows what the device really did. */
const AFTER_COMMAND_MS = 5000
/** While a door is moving the hub asks every second; Tuya is asked this often. */
const MOTION_POLL_MS = 3000
const DEFAULT_TRAVEL_S = 30
/** A door that had not arrived when its travel time ran out is looked at once more after this long. */
const LATE_DOOR_CHECK_MS = 30_000
const FAILURE_KEEP_MS = 60_000
const SPEC_RETRY_MS = 10 * 60_000
/** Warm white to cool white, the usual span of Tuya bulbs. */
const KELVIN_WARM = 2700
const KELVIN_COOL = 6500

/** A problem with what the owner filled in; reported, never retried on another path. */
class SetupError extends Error {}

interface Session {
  cred: TuyaCredentials
  deviceId: string
  /** /v1.0/iot-03/devices/{id} */
  path: string
  memo: DeviceMemo
  refreshMs: number
  config: Record<string, unknown>
  kind: DeviceKind
}

function openSession(ctx: AdapterContext): Session {
  const accessId = ctx.str('accessId').trim()
  const accessSecret = (ctx.secret('accessSecret') ?? '').trim()
  const deviceId = ctx.str('deviceId').trim()
  const missing = [!accessId && 'Access ID', !accessSecret && 'Access Secret', !deviceId && 'Device ID'].filter(Boolean)
  if (missing.length) throw new SetupError(`Fill in the ${missing.join(', ')} for this device first`)
  const cred: TuyaCredentials = { base: tuyaApiBase(ctx), accessId, accessSecret, timeoutMs: ctx.timeoutMs }
  const key = `${tokenKey(cred)}|${deviceId}`
  let memo = memos.get(key)
  if (!memo) {
    memo = {}
    memos.set(key, memo)
  }
  return {
    cred,
    deviceId,
    path: `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}`,
    memo,
    refreshMs: clamp(ctx.num('refreshSeconds', DEFAULT_REFRESH_S), 0, 3600) * 1000,
    config: ctx.device.config,
    kind: ctx.device.kind,
  }
}

function forget(memo: DeviceMemo): void {
  memo.status = undefined
  memo.detail = undefined
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Settings helpers (config only — also used by capabilities())
// ---------------------------------------------------------------------------

function flag(config: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const v = config[name]
  if (v === undefined || v === null || v === '') return fallback
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
}

function text(config: Record<string, unknown>, name: string): string {
  const v = config[name]
  return typeof v === 'string' ? v.trim() : ''
}

function gateModeOf(config: Record<string, unknown>): 'opener' | 'pulse' {
  return text(config, 'gateMode') === 'pulse' ? 'pulse' : 'opener'
}

function capabilitiesFor(config: Record<string, unknown>, kind: DeviceKind): Capability[] {
  if (kind === 'gate') return gateModeOf(config) === 'pulse' ? ['gate'] : ['gate', 'gate-state', 'state']
  const out: Capability[] = ['power', 'state']
  if ((kind === 'light' && flag(config, 'dimmable', true)) || text(config, 'dimCode')) out.push('dim')
  if (kind === 'light' && flag(config, 'colour', false)) out.push('color')
  return out
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function asStatusList(result: unknown): DataPoint[] {
  if (!Array.isArray(result)) throw new Error("Tuya's cloud sent a status the hub could not read")
  const list: DataPoint[] = []
  for (const item of result) if (isRecord(item) && typeof item.code === 'string') list.push({ code: item.code, value: item.value })
  return list
}

async function fetchStatus(s: Session): Promise<DataPoint[]> {
  const list = asStatusList(await tuyaCloudCall(s.cred, 'GET', `${s.path}/status`))
  s.memo.status = { list, at: Date.now(), ttlMs: s.refreshMs }
  return list
}

/** The remembered status when it is young enough, else a fresh one. */
async function statusWithin(s: Session, maxAgeMs: number): Promise<DataPoint[]> {
  const st = s.memo.status
  if (st && Date.now() - st.at < Math.min(st.ttlMs, s.refreshMs, maxAgeMs)) return st.list
  return fetchStatus(s)
}

/** Any remembered status will do (used only to learn which codes the device has). */
async function statusAnyAge(s: Session): Promise<DataPoint[]> {
  return s.memo.status?.list ?? fetchStatus(s)
}

function valueOf(list: DataPoint[], code: string): unknown {
  return list.find((d) => d.code === code)?.value
}

function has(list: DataPoint[], code: string): boolean {
  return list.some((d) => d.code === code)
}

function switchCodeOf(s: Session, list: DataPoint[]): string | null {
  const set = text(s.config, 'switchCode')
  if (set) return set
  return (s.kind === 'gate' ? GATE_SWITCH_CODES : SWITCH_CODES).find((c) => has(list, c)) ?? null
}

function dimCodeOf(s: Session, list: DataPoint[]): string | null {
  const set = text(s.config, 'dimCode')
  if (set) return set
  return DIM_CODES.find((c) => has(list, c)) ?? null
}

function colourCodeOf(list: DataPoint[]): { code: string; max: number } | null {
  return COLOUR_CODES.find((c) => has(list, c.code)) ?? null
}

/**
 * The colour value the light is showing right now, or null when it is showing white.
 * A light is showing a colour when work_mode says so, or when it has no white brightness at all (colour-only strips).
 */
function colourInUse(s: Session, list: DataPoint[]): { code: string; max: number; hsv: Hsv } | null {
  const colour = colourCodeOf(list)
  if (!colour) return null
  const hsv = parseColour(valueOf(list, colour.code))
  if (!hsv) return null
  const mode = valueOf(list, 'work_mode')
  if (mode === 'colour' || (mode === undefined && !dimCodeOf(s, list))) return { ...colour, hsv }
  return null
}

function parseRange(values: unknown): Range | null {
  let v = values
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!isRecord(v)) return null
  const min = Number(v.min)
  const max = Number(v.max)
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null
}

/** The range of a numeric code: the device's own specification, else Tuya's documented standard. */
async function rangeFor(s: Session, code: string): Promise<Range> {
  const now = Date.now()
  if (!s.memo.ranges || now >= s.memo.ranges.until) {
    const byCode = new Map<string, Range>()
    let until = now + SPEC_RETRY_MS
    try {
      const spec = await tuyaCloudCall(s.cred, 'GET', `${s.path}/specification`)
      if (isRecord(spec)) {
        for (const section of [spec.status, spec.functions]) {
          if (!Array.isArray(section)) continue
          for (const item of section) {
            if (!isRecord(item) || typeof item.code !== 'string') continue
            const range = parseRange(item.values)
            if (range) byCode.set(item.code, range)
          }
        }
      }
      until = Number.MAX_SAFE_INTEGER
    } catch {
      // The specification is a nicety: fall back to the documented ranges and ask again later.
    }
    s.memo.ranges = { byCode, until }
  }
  return s.memo.ranges.byCode.get(code) ?? DOCUMENTED_RANGES[code] ?? { min: 10, max: 1000 }
}

/** 1-100 % spread over the code's range, so 100 % is its maximum and 1 % its minimum. */
function toPercent(value: number, r: Range): number {
  return clamp(Math.round(1 + ((value - r.min) * 99) / (r.max - r.min)), 1, 100)
}

function fromPercent(pct: number, r: Range): number {
  return Math.round(r.min + ((clamp(pct, 1, 100) - 1) * (r.max - r.min)) / 99)
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

interface Hsv {
  h: number
  s: number
  v: number
}

/** Tuya reports colour as {"h","s","v"}, sometimes as that JSON inside a string. */
function parseColour(value: unknown): Hsv | null {
  let v = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!isRecord(v)) return null
  const h = Number(v.h)
  const s = Number(v.s)
  const b = Number(v.v)
  return Number.isFinite(h) && Number.isFinite(s) && Number.isFinite(b) ? { h, s, v: b } : null
}

/** h 0-360, s and v 0-1 -> #rrggbb */
function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s
  const hh = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x]
  const m = v - c
  const hex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/** #rrggbb -> h 0-360, s and v 0-1 */
function hexToHsv(input: string): Hsv | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(input.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function travelMs(list: DataPoint[]): number {
  const t = Number(valueOf(list, TRAVEL_TIME_CODE))
  return (Number.isFinite(t) && t >= 5 && t <= 300 ? t : DEFAULT_TRAVEL_S) * 1000 + 5000
}

/** Open / closed from the door sensor, shown as opening / closing while a move the hub started is under way. */
function gateStateOf(s: Session, list: DataPoint[]): GateState {
  const contact = valueOf(list, DOOR_SENSOR_CODE)
  if (typeof contact !== 'boolean') {
    s.memo.motion = undefined
    return 'unknown'
  }
  const now: GateState = contact ? 'open' : 'closed'
  const m = s.memo.motion
  if (m && Date.now() < m.until && now !== m.goal) return m.goal === 'open' ? 'opening' : 'closing'
  s.memo.motion = undefined
  return now
}

async function stateOf(s: Session, list: DataPoint[]): Promise<Record<string, unknown>> {
  if (s.kind === 'gate') return { gate: gateStateOf(s, list) }
  const caps = capabilitiesFor(s.config, s.kind)
  const state: Record<string, unknown> = {}
  const sw = switchCodeOf(s, list)
  const power = sw ? valueOf(list, sw) : undefined
  if (typeof power === 'boolean') state.power = power

  // What the light is showing decides where its brightness lives, whether or not the colour controls are switched on here.
  const mode = valueOf(list, 'work_mode')
  const shown = colourInUse(s, list)
  if (caps.includes('color')) {
    if (typeof mode === 'string') state.colorMode = mode
    if (shown) state.color = hsvToHex(shown.hsv.h, clamp(shown.hsv.s / shown.max, 0, 1), 1)
  }

  if (caps.includes('dim')) {
    if (shown) {
      state.brightness = clamp(Math.round((shown.hsv.v / shown.max) * 100), 1, 100)
    } else {
      const dim = dimCodeOf(s, list)
      const raw = dim ? valueOf(list, dim) : undefined
      if (dim && typeof raw === 'number') state.brightness = toPercent(raw, await rangeFor(s, dim))
    }
  }
  return state
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function sendCommands(s: Session, commands: DataPoint[]): Promise<void> {
  const result = await tuyaCloudCall(s.cred, 'POST', `${s.path}/commands`, { body: { commands } })
  if (result === false) throw new TuyaApiError('Tuya did not accept the command', 0, 'result false')
  // Keep the remembered status in step, and look again soon to confirm.
  const st = s.memo.status
  if (st) {
    for (const c of commands) {
      const dp = st.list.find((d) => d.code === c.code)
      if (dp) dp.value = c.value
    }
    st.at = Date.now()
    st.ttlMs = Math.min(s.refreshMs, AFTER_COMMAND_MS)
  }
}

const NO_SWITCH = 'This device does not report an on/off switch. Fill in "On/off code" in its settings.'

async function setPower(s: Session, action: Action): Promise<ActionResult> {
  // A toggle needs to know the present state for certain; on / off only need the code.
  const list = action.type === 'power.toggle' ? await fetchStatus(s) : text(s.config, 'switchCode') ? [] : await statusAnyAge(s)
  const code = switchCodeOf(s, list)
  if (!code) return { ok: false, error: NO_SWITCH }
  let on = action.type === 'power.on'
  if (action.type === 'power.toggle') {
    const now = valueOf(list, code)
    if (typeof now !== 'boolean') return { ok: false, error: `The device does not report "${code}", so the hub cannot tell whether it is on` }
    on = !now
  }
  await sendCommands(s, [{ code, value: on }])
  return { ok: true, state: { power: on } }
}

async function setBrightness(s: Session, action: Action): Promise<ActionResult> {
  const wanted = Number(action.params.brightness)
  if (!Number.isFinite(wanted)) return { ok: false, error: 'No brightness given' }
  const pct = clamp(Math.round(wanted), 0, 100)
  const list = await statusAnyAge(s)
  const sw = switchCodeOf(s, list)
  if (pct === 0) {
    if (!sw) return { ok: false, error: NO_SWITCH }
    await sendCommands(s, [{ code: sw, value: false }])
    return { ok: true, state: { power: false } }
  }
  const commands: DataPoint[] = sw ? [{ code: sw, value: true }] : []
  const shown = colourInUse(s, list)
  if (shown) {
    // While a colour is showing, the brightness lives inside the colour value; the white brightness would change nothing you can see.
    commands.push({ code: shown.code, value: { h: shown.hsv.h, s: shown.hsv.s, v: Math.max(1, Math.round((pct / 100) * shown.max)) } })
  } else {
    const dim = dimCodeOf(s, list)
    if (!dim) return { ok: false, error: 'This device does not report a brightness setting, so it cannot be dimmed from here' }
    commands.push({ code: dim, value: fromPercent(pct, await rangeFor(s, dim)) })
  }
  await sendCommands(s, commands)
  return { ok: true, state: { power: true, brightness: pct } }
}

async function setColour(s: Session, action: Action): Promise<ActionResult> {
  const list = await statusAnyAge(s)
  const sw = switchCodeOf(s, list)
  const commands: DataPoint[] = sw ? [{ code: sw, value: true }] : []
  const hasMode = has(list, 'work_mode')

  if (typeof action.params.hex === 'string') {
    const hsv = hexToHsv(action.params.hex)
    if (!hsv) return { ok: false, error: 'That is not a colour the hub understands (use the form #rrggbb)' }
    const colour = colourCodeOf(list)
    if (!colour) return { ok: false, error: 'This light does not report a colour setting' }
    if (hasMode) commands.push({ code: 'work_mode', value: 'colour' })
    const value = { h: Math.round(hsv.h), s: Math.round(hsv.s * colour.max), v: Math.max(Math.round(colour.max / 100), Math.round(hsv.v * colour.max)) }
    commands.push({ code: colour.code, value })
    await sendCommands(s, commands)
    return {
      ok: true,
      state: { power: true, colorMode: 'colour', color: hsvToHex(value.h, value.s / colour.max, 1), brightness: clamp(Math.round((value.v / colour.max) * 100), 1, 100) },
    }
  }

  const kelvin = Number(action.params.temperature)
  if (Number.isFinite(kelvin) && kelvin > 0) {
    const code = TEMP_CODES.find((c) => has(list, c))
    if (!code) return { ok: false, error: 'This light has no warm / cool white setting' }
    const r = await rangeFor(s, code)
    const share = (clamp(kelvin, KELVIN_WARM, KELVIN_COOL) - KELVIN_WARM) / (KELVIN_COOL - KELVIN_WARM)
    if (hasMode) commands.push({ code: 'work_mode', value: 'white' })
    commands.push({ code, value: Math.round(r.min + share * (r.max - r.min)) })
    await sendCommands(s, commands)
    return { ok: true, state: { power: true, colorMode: 'white' }, result: { temperature: Math.round(clamp(kelvin, KELVIN_WARM, KELVIN_COOL)) } }
  }
  return { ok: false, error: 'No colour given' }
}

/** Tuya garage door opener: switch_1 true = open, false = close; doorcontact_state true = open. */
async function moveDoor(s: Session, action: Action): Promise<ActionResult> {
  if (action.type === 'gate.stop') {
    return { ok: false, error: 'Tuya garage door openers have no stop command. Use the wall button or the remote to stop the door.' }
  }
  const list = await fetchStatus(s)
  const code = switchCodeOf(s, list)
  if (!code) return { ok: false, error: NO_SWITCH }
  const contact = valueOf(list, DOOR_SENSOR_CODE)
  const sensor = typeof contact === 'boolean' ? contact : null
  let open = action.type === 'gate.open'
  if (action.type === 'gate.pulse') open = sensor === null ? valueOf(list, code) !== true : !sensor
  await sendCommands(s, [{ code, value: open }])
  const goal = open ? 'open' : 'closed'
  if (sensor === null) {
    s.memo.motion = undefined
    return { ok: true, state: { gate: 'unknown' }, result: { sent: goal, note: 'The opener reports no door sensor, so the hub cannot see whether the door moved' } }
  }
  if (sensor === open) {
    s.memo.motion = undefined
    return { ok: true, state: { gate: goal }, result: { alreadyThere: true } }
  }
  s.memo.motion = { goal, until: Date.now() + travelMs(list) }
  return { ok: true, state: { gate: open ? 'opening' : 'closing' } }
}

/** A plain switch wired across the gate's push-button: on, wait, off — one press of the button. */
async function pressButton(s: Session, ctx: AdapterContext): Promise<ActionResult> {
  const list = text(s.config, 'switchCode') ? [] : await statusAnyAge(s)
  const code = switchCodeOf(s, list)
  if (!code) return { ok: false, error: NO_SWITCH }
  const seconds = clamp(ctx.num('pulseSeconds', 1), 0.2, 5)
  try {
    await sendCommands(s, [{ code, value: true }])
  } catch (err) {
    // The answer was lost, so the switch may be on all the same: make sure it does not stay on.
    if (!(err instanceof TuyaApiError)) await sendCommands(s, [{ code, value: false }]).catch(() => undefined)
    throw err
  }
  await sleep(seconds * 1000)
  let last: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await sendCommands(s, [{ code, value: false }])
      return { ok: true, result: { pressed: code, seconds } }
    } catch (err) {
      last = err
      await sleep(400)
    }
  }
  // Never throw here: a retry on another connection would press the button a second time.
  forget(s.memo)
  return { ok: false, error: `The switch was turned on but could not be turned off again. Turn it off in the Smart Life app and check the gate. ${message(last)}` }
}

async function sendCustom(s: Session, action: Action): Promise<ActionResult> {
  const p = action.params
  const raw: unknown[] = Array.isArray(p.commands) ? p.commands : typeof p.code === 'string' ? [{ code: p.code, value: p.value }] : []
  const commands: DataPoint[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.code !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(item.code) || item.value === undefined) {
      return { ok: false, error: 'A custom command needs a code and a value, for example code "switch_2" with value true' }
    }
    commands.push({ code: item.code, value: item.value })
  }
  if (commands.length === 0 || commands.length > 10) return { ok: false, error: 'A custom command needs between 1 and 10 code / value pairs' }
  await sendCommands(s, commands)
  return { ok: true, result: { sent: commands.map((c) => c.code) } }
}

async function run(s: Session, ctx: AdapterContext, action: Action): Promise<ActionResult> {
  const caps = capabilitiesFor(s.config, s.kind)
  switch (action.type) {
    case 'power.on':
    case 'power.off':
    case 'power.toggle':
      return caps.includes('power') ? setPower(s, action) : unsupported(action)
    case 'dim.set':
      return caps.includes('dim') ? setBrightness(s, action) : unsupported(action)
    case 'color.set':
      return caps.includes('color') ? setColour(s, action) : unsupported(action)
    case 'gate.open':
    case 'gate.close':
    case 'gate.stop':
    case 'gate.pulse':
      if (!caps.includes('gate')) return unsupported(action)
      return gateModeOf(s.config) === 'pulse' ? pressButton(s, ctx) : moveDoor(s, action)
    case 'custom':
      return sendCustom(s, action)
    default:
      return unsupported(action)
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function pick(r: Record<string, unknown>, name: string): string | undefined {
  const v = r[name]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

const adapter: Adapter = {
  family: 'tuya-cloud',

  describe(): FamilyDescriptor {
    return {
      id: 'tuya-cloud',
      label: 'Tuya / Smart Life (over the internet)',
      tagline: 'Smart Life and Tuya lights, switches and garage door openers, through Tuya’s own cloud. Works from anywhere the device has internet.',
      kinds: ['light', 'switch', 'gate'],
      fields: [
        {
          name: 'accessId',
          label: 'Access ID',
          type: 'text',
          required: true,
          help: 'Also called Client ID. Shown on the Overview page of your cloud project on the Tuya developer website (iot.tuya.com).',
        },
        {
          name: 'accessSecret',
          label: 'Access Secret',
          type: 'password',
          secret: true,
          required: true,
          help: 'Also called Client Secret, shown next to the Access ID. Stored encrypted on the hub.',
        },
        {
          name: 'deviceId',
          label: 'Device ID',
          type: 'text',
          required: true,
          help: 'The long code next to the device in the Devices list of your cloud project.',
        },
        {
          name: 'region',
          label: 'Region (data centre)',
          type: 'select',
          required: true,
          default: DEFAULT_REGION,
          options: Object.entries(TUYA_REGIONS).map(([value, r]) => ({ value, label: r.label })),
          help: 'Must be the region your Smart Life account lives in. Accounts made in India use India.',
        },
        {
          name: 'dimmable',
          label: 'This light can be dimmed',
          type: 'toggle',
          default: true,
          help: 'Only used for lights. Turn it off for a light that is just on / off.',
        },
        {
          name: 'colour',
          label: 'This light can change colour',
          type: 'toggle',
          default: false,
          help: 'Only used for lights. Turn it on for colour bulbs and strips, and for bulbs that can change between warm and cool white.',
        },
        {
          name: 'gateMode',
          label: 'How the gate or garage door is driven',
          type: 'select',
          default: 'opener',
          options: [
            { value: 'opener', label: 'Tuya garage door opener (has Open and Close, knows open / closed)' },
            { value: 'pulse', label: 'Plain Tuya switch wired to the gate’s push-button (one press each time)' },
          ],
          help: 'Only used when this device is a gate or garage door.',
        },
        {
          name: 'pulseSeconds',
          label: 'Button press length (seconds)',
          type: 'number',
          default: 1,
          showWhen: { field: 'gateMode', equals: 'pulse' },
          help: 'How long the switch stays on to press the gate’s button. Most gates need about one second.',
        },
        {
          name: 'refreshSeconds',
          label: 'Ask Tuya for the status every (seconds)',
          type: 'number',
          default: DEFAULT_REFRESH_S,
          help: 'Tuya’s free plan allows only a limited number of requests each month, so the status is not asked for more often than this. A change made at the wall switch or in the Smart Life app can take this long to show here. Commands you send from here always go out straight away. Use a smaller number only on a paid Tuya plan.',
        },
        {
          name: 'switchCode',
          label: 'On/off code (optional)',
          type: 'text',
          help: 'Leave empty and the hub finds it (switch_led for bulbs, switch_1 or switch for switches). Fill it in only for a switch with several buttons, for example switch_2 for the second button.',
        },
        {
          name: 'dimCode',
          label: 'Brightness code (optional)',
          type: 'text',
          help: 'Leave empty and the hub finds it (bright_value_v2 or bright_value). Fill it in only if the brightness slider does nothing.',
        },
        {
          name: 'apiBase',
          label: 'Custom cloud address (optional)',
          type: 'text',
          help: 'Leave empty to use the region above. Only needed if Tuya gave you a different address, for example https://openapi.tuyain.com.',
        },
      ],
      pathKinds: ['cloud'],
      defaultPort: null,
      capabilities: ['power', 'dim', 'color', 'gate', 'gate-state', 'state'],
      notes: [
        'One-time setup on the Tuya developer website (iot.tuya.com): create a cloud project of the type Smart Home in the India data centre, add the free IoT Core service to it, then open Devices > Link Tuya App Account and scan the code with the Smart Life app. Your devices then appear in the project with their Device IDs; the Access ID and Access Secret are on the project’s Overview page.',
        'The project’s data centre must match the region of your Smart Life account, otherwise the devices do not show up. One Smart Life account can be linked to at most two cloud projects.',
        'The free IoT Core service is a trial: it runs out after one month and has to be renewed on the same website (Tuya takes 1 to 2 working days to approve), and it allows only a limited number of requests. When it has run out, this connection stops working until it is renewed.',
        'This connection needs internet at both ends, the hub and the device. It keeps working when the device is on a different network from the hub, but not when the device itself has no internet.',
        'To stay inside the request limit the hub asks Tuya for the status only every few minutes, so changes made elsewhere show up late. Commands from here go out straight away.',
        'Garage door openers: Open and Close are sent to the opener and its door sensor tells the hub whether the door is open or closed; these openers have no Stop command. A plain switch wired to the gate’s push-button can only press that button; the hub cannot tell which way the gate then moves.',
        'A Tuya device cannot be moved to another WiFi network from here. That is done by pairing it again in the Smart Life app.',
      ],
    }
  },

  capabilities(config: Record<string, unknown>, kind: DeviceKind): Capability[] {
    return capabilitiesFor(config, kind)
  },

  async probe(ctx): Promise<ProbeResult> {
    let s: Session
    try {
      s = openSession(ctx)
    } catch (err) {
      return { ok: false, latencyMs: null, error: message(err) }
    }
    const kept = s.memo.detail
    if (kept && Date.now() - kept.at < Math.min(kept.ttlMs, s.refreshMs)) return kept.res

    const started = Date.now()
    let res: ProbeResult
    let keepMs = s.refreshMs
    try {
      const detail = await tuyaCloudCall(s.cred, 'GET', s.path)
      const latencyMs = Date.now() - started
      const d = isRecord(detail) ? detail : {}
      if (d.online === false) {
        res = { ok: false, latencyMs: null, error: 'Tuya’s cloud says this device is offline. Check its power and its WiFi.' }
        keepMs = Math.min(keepMs, FAILURE_KEEP_MS)
      } else {
        // Named fields only: the answer also carries the device's local key, which must stay on the hub.
        const info: Record<string, unknown> = {}
        const model = pick(d, 'model') ?? pick(d, 'product_name')
        if (model) info.model = model
        for (const [key, from] of [['name', 'name'], ['product', 'product_name'], ['category', 'category'], ['ip', 'ip'], ['serial', 'uuid']] as const) {
          const v = pick(d, from)
          if (v) info[key] = v
        }
        res = { ok: true, latencyMs, info }
      }
    } catch (err) {
      if (!(err instanceof TuyaApiError)) {
        forget(s.memo)
        return { ok: false, latencyMs: null, error: message(err) }
      }
      res = { ok: false, latencyMs: null, error: err.message }
      keepMs = Math.min(keepMs, FAILURE_KEEP_MS)
    }
    s.memo.detail = { res, at: Date.now(), ttlMs: keepMs }
    return res
  },

  async readState(ctx): Promise<Record<string, unknown>> {
    const s = openSession(ctx)
    // A push-button gate has nothing the hub can read, so no request is spent on it.
    if (s.kind === 'gate' && gateModeOf(s.config) === 'pulse') return {}
    try {
      const move = s.kind === 'gate' ? s.memo.motion : undefined
      if (!move) return await stateOf(s, await statusWithin(s, Number.POSITIVE_INFINITY))
      if (Date.now() < move.until) return await stateOf(s, await statusWithin(s, MOTION_POLL_MS))
      // The travel time is over: what is shown from now on must be a new reading, not one from while the door was moving.
      const state = await stateOf(s, await fetchStatus(s))
      if (state.gate !== move.goal && s.memo.status) s.memo.status.ttlMs = Math.min(s.refreshMs, LATE_DOOR_CHECK_MS)
      return state
    } catch (err) {
      if (!(err instanceof TuyaApiError)) forget(s.memo)
      throw err
    }
  },

  async execute(ctx, action: Action): Promise<ActionResult> {
    let s: Session
    try {
      s = openSession(ctx)
    } catch (err) {
      return { ok: false, error: message(err) }
    }
    try {
      return await run(s, ctx, action)
    } catch (err) {
      // Whatever went wrong, the next check must ask Tuya again rather than trust what was remembered.
      forget(s.memo)
      if (err instanceof TuyaApiError) return { ok: false, error: err.message }
      throw err
    }
  },
}

export default adapter
