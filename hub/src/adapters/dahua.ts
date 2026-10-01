/**
 * Dahua / CP Plus cameras over the Dahua HTTP CGI API (CP Plus's wired and
 * professional lines are Dahua-made and answer the same calls).
 *
 * Everything here is a plain GET under /cgi-bin/ with HTTP digest auth:
 *   magicBox.cgi       identity, restart
 *   snapshot.cgi       JPEG still
 *   ptz.cgi            start / stop pairs, GotoPreset, getPresets, getStatus
 *   configManager.cgi  getConfig / setConfig (Network, WLan)
 *   wlan.cgi           WiFi scan
 *   netApp.cgi         network interfaces (the SIM link shows up here as "3G")
 * Answers are text: `key=value` lines for reads, `OK` / `ERROR` for commands.
 * Live video is RTSP at /cam/realmonitor?channel=N&subtype=0|1.
 *
 * Reference: docs/protocols/dahua-cpplus-cgi.md
 */
import type { Action, Capability, DeviceKind, FamilyDescriptor } from '@house/shared'
import { request, sleep, withTimeout, type Response } from '../lib/http.ts'
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

// ---------------------------------------------------------------------------
// Text formats
// ---------------------------------------------------------------------------

/**
 * Parse Dahua `key=value` lines. A leading `table.` (configManager answers) is
 * dropped, so `table.WLan.eth2.SSID=home` becomes `WLan.eth2.SSID`. Values are
 * kept exactly as sent (an SSID may contain spaces and `=`); lines without `=`
 * (`OK`, `Found Num:1`) are ignored.
 */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let key = line.slice(0, eq).trim()
    if (key.startsWith('table.')) key = key.slice('table.'.length)
    if (key) out[key] = line.slice(eq + 1)
  }
  return out
}

/** Collect `prefix[0].Name=…`, `prefix[1].Name=…` into one record per index, in index order. */
export function parseIndexed(kv: Record<string, string>, prefix: string): Array<Record<string, string>> {
  const rows = new Map<number, Record<string, string>>()
  const head = prefix + '['
  for (const [key, value] of Object.entries(kv)) {
    if (!key.startsWith(head)) continue
    const close = key.indexOf('].', head.length)
    if (close < 0) continue
    const index = Number(key.slice(head.length, close))
    if (!Number.isInteger(index) || index < 0) continue
    let row = rows.get(index)
    if (!row) {
      row = {}
      rows.set(index, row)
    }
    row[key.slice(close + 2)] = value
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row)
}

/** EncrAlgr in a WiFi scan answer (HTTP API V3.35, 4.8.8). It names the cipher, not WPA vs WPA2. */
const SCAN_SECURITY: Record<number, string> = {
  0: 'Open (no password)',
  1: 'WEP',
  2: 'WPA/WPA2 (TKIP)',
  3: 'WPA/WPA2 (AES)',
  4: 'WPA/WPA2 (TKIP+AES)',
}

interface ScannedNetwork extends WifiScanEntry {
  /** Raw EncrAlgr, when the camera sent one. */
  cipher: number | null
}

function parseScan(text: string): ScannedNetwork[] {
  const best = new Map<string, ScannedNetwork>()
  for (const row of parseIndexed(parseKeyValues(text), 'wlanDevice')) {
    const ssid = row.SSID ?? ''
    if (!ssid.trim()) continue
    const quality = toNumber(row.LinkQuality)
    const rssi = toNumber(row.RSSIQuality)
    let signal: number | null = null
    if (quality !== null) signal = clamp(Math.round(quality), 0, 100)
    else if (rssi !== null && rssi < 0) signal = clamp(Math.round(2 * (rssi + 100)), 0, 100)
    const cipher = toNumber(row.EncrAlgr)
    const entry: ScannedNetwork = { ssid, signal, security: cipher === null ? null : (SCAN_SECURITY[cipher] ?? null), cipher }
    const seen = best.get(ssid)
    if (!seen || (entry.signal ?? -1) > (seen.signal ?? -1)) best.set(ssid, entry)
  }
  return [...best.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1))
}

/**
 * Networks in a `wlan.cgi?action=scanWlanDevices` answer. Handles both headers
 * (`Found Num:1` on older firmware, `found=1` on newer), keeps the strongest
 * entry per network name and leaves out hidden (nameless) networks.
 */
export function parseWifiScan(text: string): WifiScanEntry[] {
  return parseScan(text).map(({ ssid, signal, security }) => ({ ssid, signal, security }))
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const n = Number(value.trim())
  return Number.isFinite(n) ? n : null
}

/** RFC 3986 escaping for a query value: everything except letters, digits and - . _ ~ */
function enc(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

// ---------------------------------------------------------------------------
// Talking to the camera
// ---------------------------------------------------------------------------

/** The camera answered, and the answer was "no" (bad login, service off). Not a reason to try another path. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

function refusalFor(status: number): Refusal {
  if (status === 401) return new Refusal('Wrong username or password', status)
  if (status === 403) return new Refusal('The camera refused this login: wrong username or password, or this user is not allowed to do that', status)
  if (status === 404) {
    return new Refusal(
      'This camera does not answer Dahua commands. Either "CGI service" is switched off in the camera\'s own settings, or it is not a Dahua-type camera (try adding it as an ONVIF camera)',
      status,
    )
  }
  if (status >= 300 && status < 400) {
    return new Refusal('The camera sent the hub to a different address. If its settings page opens with https://, switch on "Use HTTPS"', status)
  }
  if (status >= 500) {
    return new Refusal(
      `The camera reported an error (HTTP ${status}). On newer cameras, set Authentication Mode to "Compatible" (MD5 digest) in the camera's security settings`,
      status,
    )
  }
  return new Refusal(`The camera answered HTTP ${status}`, status)
}

/** Turn low-level network errors into sentences. Never includes the URL (it can carry a WiFi password). */
function plainTransportError(err: unknown, host: string): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (/timed out/i.test(message)) return new Error(`The camera at ${host} did not answer in time`)
  if (/socket hang up|ECONNRESET|EPIPE|closed the connection/i.test(message)) return new Error(`The camera at ${host} closed the connection`)
  if (/EPROTO|SSL|TLS|wrong version number/i.test(message)) {
    return new Error(`The camera at ${host} could not set up a secure (HTTPS) connection. Check the "Use HTTPS" switch`)
  }
  if (/invalid url/i.test(message)) return new Error(`"${host}" is not a usable address for this connection`)
  return err instanceof Error ? err : new Error(message)
}

/**
 * http(s)://address[:port] of the camera on the connection in use.
 *
 * The hub saves every connection with this family's usual port (80) unless the
 * owner types another one. No camera serves HTTPS on 80, so with "Use HTTPS"
 * on, a saved 80 means "the usual port" and becomes 443. Any other port is the
 * owner's own choice and is kept.
 */
export function cameraBaseUrl(ctx: AdapterContext): string {
  const https = ctx.bool('https', false)
  const port = ctx.path.port
  if (https && (port === null || port === undefined || port === 80)) {
    return baseUrl({ ...ctx, path: { ...ctx.path, port: 443 } }, { https: true })
  }
  return baseUrl(ctx, { https })
}

/**
 * One CGI call. `pathAndQuery` must already be escaped. Returns the response
 * for 2xx and for 400 (how these cameras say "ERROR"); throws Refusal for
 * other statuses and a plain Error when the camera cannot be reached.
 * `budgetMs` bounds the whole call, digest handshake included.
 */
async function cgi(ctx: AdapterContext, pathAndQuery: string, budgetMs: number = ctx.timeoutMs): Promise<Response> {
  const url = cameraBaseUrl(ctx) + pathAndQuery
  const username = ctx.str('username').trim()
  const budget = Math.max(250, Math.round(budgetMs))
  let res: Response
  try {
    res = await withTimeout(
      request(url, {
        timeoutMs: budget,
        insecure: true,
        // Old firmware only takes a plain (Basic) login. That is allowed on the house network, never over the public SIM path.
        digest: username ? { username, password: ctx.secret('password') ?? '', allowBasic: ctx.path.kind !== 'cellular' } : undefined,
      }),
      budget,
      'The camera',
    )
  } catch (err) {
    throw plainTransportError(err, requireHost(ctx))
  }
  if ((res.status >= 200 && res.status < 300) || res.status === 400) return res
  throw refusalFor(res.status)
}

/** A read call: parsed key=value lines, or null when the camera says it has no such thing. */
async function readKv(ctx: AdapterContext, pathAndQuery: string, budgetMs?: number): Promise<Record<string, string> | null> {
  const res = await cgi(ctx, pathAndQuery, budgetMs)
  if (res.status !== 200) return null
  return parseKeyValues(res.text())
}

/** A command call: true when the camera answered OK, false when it answered ERROR. */
async function command(ctx: AdapterContext, pathAndQuery: string, budgetMs?: number): Promise<boolean> {
  const res = await cgi(ctx, pathAndQuery, budgetMs)
  return res.status === 200 && /^\s*OK\b/i.test(res.text())
}

function channelOf(ctx: AdapterContext): number {
  const n = Math.round(ctx.num('channel', 1))
  return Number.isFinite(n) && n >= 0 ? n : 1
}

function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on'
}

// ---------------------------------------------------------------------------
// Per-device memory (lives as long as the hub process)
// ---------------------------------------------------------------------------

interface Move {
  code: string
  arg1: number
  arg2: number
  arg3: number
}

interface Runtime {
  /** Movements started and not yet stopped; each needs a stop with the same code and arguments. */
  moves: Move[]
  /** PTZ channel number this camera accepted (firmware generations count from 1 or from 0). */
  ptzChannel: number | null
  stopTimer: NodeJS.Timeout | null
  identity: { serial: string; model: string | null; firmware: string | null; at: number } | null
}

const runtimes = new Map<string, Runtime>()

function runtimeOf(ctx: AdapterContext): Runtime {
  let rt = runtimes.get(ctx.device.id)
  if (!rt) {
    rt = { moves: [], ptzChannel: null, stopTimer: null, identity: null }
    runtimes.set(ctx.device.id, rt)
  }
  return rt
}

/** Test hook: forget remembered moves, channels and identities, and cancel pending auto-stops. */
export function resetDahuaRuntimes(): void {
  for (const rt of runtimes.values()) {
    if (rt.stopTimer) clearTimeout(rt.stopTimer)
  }
  runtimes.clear()
}

const IDENTITY_TTL_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// PTZ
// ---------------------------------------------------------------------------

/** A move with no "seconds" still ends by itself, in case the stop from the phone never arrives. */
export const MAX_MOVE_SECONDS = 30
const LONGEST_REQUESTED_MOVE_SECONDS = 120
const DEAD_ZONE = 0.05
/** How soon the hub tries again by itself when a stop could not be delivered. */
const STOP_RETRY_MS = 500
/** Sent when asked to stop with nothing on record (for example after a hub restart). */
const BLIND_STOP: Move = { code: 'Up', arg1: 0, arg2: 0, arg3: 0 }

function axis(value: unknown): number {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return 0
  const v = clamp(n, -1, 1)
  return Math.abs(v) < DEAD_ZONE ? 0 : v
}

/** -1..1 to the documented speed range 1..8. */
function speed(value: number): number {
  return clamp(Math.round(Math.abs(value) * 8), 1, 8)
}

/** The documented ptz.cgi codes for a joystick position: one pan/tilt code and/or one zoom code. */
function movesFor(pan: number, tilt: number, zoom: number): Move[] {
  const moves: Move[] = []
  if (pan !== 0 && tilt !== 0) {
    // Diagonals: arg1 = vertical speed, arg2 = horizontal speed.
    moves.push({ code: (pan < 0 ? 'Left' : 'Right') + (tilt > 0 ? 'Up' : 'Down'), arg1: speed(tilt), arg2: speed(pan), arg3: 0 })
  } else if (pan !== 0) {
    moves.push({ code: pan < 0 ? 'Left' : 'Right', arg1: 0, arg2: speed(pan), arg3: 0 })
  } else if (tilt !== 0) {
    moves.push({ code: tilt > 0 ? 'Up' : 'Down', arg1: 0, arg2: speed(tilt), arg3: 0 })
  }
  if (zoom !== 0) moves.push({ code: zoom > 0 ? 'ZoomTele' : 'ZoomWide', arg1: 0, arg2: 1, arg3: 0 })
  return moves
}

/**
 * Which PTZ channel numbers to try. Newer firmware counts from 1, older from 0.
 * Only a single camera (number 1) falls back to 0 by itself: on a recorder,
 * "one less" could be a different camera, so there the owner sets it.
 */
function ptzChannels(ctx: AdapterContext, rt: Runtime): { list: number[]; fixed: boolean } {
  const explicit = ctx.str('ptzChannel').trim()
  if (explicit !== '' && Number.isFinite(Number(explicit)) && Number(explicit) >= 0) return { list: [Math.round(Number(explicit))], fixed: true }
  const ch = channelOf(ctx)
  const candidates = ch === 1 ? [1, 0] : [ch]
  // The number that worked last time goes first; the other stays as a fallback in case that was a fluke.
  const learned = rt.ptzChannel
  if (learned !== null && candidates.includes(learned)) return { list: [learned, ...candidates.filter((c) => c !== learned)], fixed: false }
  return { list: candidates, fixed: false }
}

async function ptzCommand(ctx: AdapterContext, rt: Runtime, action: 'start' | 'stop', move: Move): Promise<boolean> {
  const { list, fixed } = ptzChannels(ctx, rt)
  for (const ch of list) {
    const ok = await command(ctx, `/cgi-bin/ptz.cgi?action=${action}&channel=${ch}&code=${enc(move.code)}&arg1=${move.arg1}&arg2=${move.arg2}&arg3=${move.arg3}`)
    if (ok) {
      if (!fixed) rt.ptzChannel = ch
      return true
    }
  }
  return false
}

function clearStopTimer(rt: Runtime): void {
  if (rt.stopTimer) {
    clearTimeout(rt.stopTimer)
    rt.stopTimer = null
  }
}

/** Have the hub send the stop by itself after `ms`, replacing any stop already waiting. */
function armStop(ctx: AdapterContext, rt: Runtime, ms: number): void {
  clearStopTimer(rt)
  rt.stopTimer = setTimeout(() => {
    rt.stopTimer = null
    void autoStop(ctx, rt)
  }, ms)
  rt.stopTimer.unref?.()
}

/** Send the stop for everything on record (or one blind stop). Throws on a connection failure and keeps the record. */
async function sendStops(ctx: AdapterContext, rt: Runtime): Promise<boolean> {
  const moves = rt.moves
  let accepted = true
  for (const move of moves.length ? moves : [BLIND_STOP]) {
    accepted = (await ptzCommand(ctx, rt, 'stop', move)) && accepted
  }
  if (rt.moves === moves) rt.moves = []
  return accepted
}

/**
 * Stop now. When the stop cannot be delivered the camera is still turning, so
 * the failure is passed on (the hub then tries another connection) and the hub
 * keeps trying on this one in the background.
 */
async function stopMoves(ctx: AdapterContext, rt: Runtime): Promise<boolean> {
  clearStopTimer(rt)
  try {
    return await sendStops(ctx, rt)
  } catch (err) {
    if (!(err instanceof Refusal) && rt.moves.length > 0) armStop(ctx, rt, STOP_RETRY_MS)
    throw err
  }
}

/** The stop the hub sends by itself. A lost stop leaves the camera turning, so it is tried three times. */
async function autoStop(ctx: AdapterContext, rt: Runtime): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sendStops(ctx, rt)
      return
    } catch (err) {
      ctx.log.warn(`automatic stop failed (try ${attempt} of 3)`, err instanceof Error ? err.message : String(err))
      if (err instanceof Refusal) return
      await sleep(400)
    }
  }
}

async function presetNumber(ctx: AdapterContext, wanted: unknown): Promise<number | null> {
  const text = String(wanted ?? '').trim()
  if (text === '') return null
  if (/^\d+$/.test(text)) return Number(text)
  const kv = await readKv(ctx, `/cgi-bin/ptz.cgi?action=getPresets&channel=${channelOf(ctx)}`)
  if (!kv) return null
  for (const row of presetRows(kv)) {
    const index = toNumber(row.Index)
    if (index !== null && (row.Name ?? '').trim().toLowerCase() === text.toLowerCase()) return index
  }
  return null
}

/**
 * Rows of a getPresets answer. The documents show `presets.presets[0].Index=1`;
 * firmware that leaves out the first word (`presets[0].Index=1`) is read too.
 */
function presetRows(kv: Record<string, string>): Array<Record<string, string>> {
  const rows = parseIndexed(kv, 'presets.presets')
  return rows.length > 0 ? rows : parseIndexed(kv, 'presets')
}

/** `status.Position=120,12,2` (pan, tilt, zoom). Some firmware sends three indexed lines instead. */
function ptzPosition(kv: Record<string, string>): { pan: number; tilt: number; zoom: number } | null {
  let parts: Array<number | null> = []
  const joined = kv['status.Position'] ?? kv['status.Postion']
  if (joined !== undefined) {
    parts = joined.split(',').map((s) => toNumber(s))
  } else {
    for (const name of ['status.Position', 'status.Postion']) {
      if (kv[`${name}[0]`] !== undefined) parts = [0, 1, 2].map((i) => toNumber(kv[`${name}[${i}]`]))
    }
  }
  const [pan, tilt, zoom] = parts
  if (pan === null || pan === undefined || tilt === null || tilt === undefined) return null
  return { pan, tilt, zoom: zoom ?? 0 }
}

// ---------------------------------------------------------------------------
// Network: WiFi and the SIM link
// ---------------------------------------------------------------------------

const GET_WLAN = '/cgi-bin/configManager.cgi?action=getConfig&name=WLan'
const GET_NETWORK = '/cgi-bin/configManager.cgi?action=getConfig&name=Network'
const GET_INTERFACES = '/cgi-bin/netApp.cgi?action=getInterfaces'
const SCAN_WLAN = '/cgi-bin/wlan.cgi?action=scanWlanDevices'

interface WlanInterface {
  /** eth2 on older models, wlan0 / wlan1 on newer ones. */
  name: string
  /** Sub-keys of table.WLan.<name>. Includes the stored WiFi keys: never log or return this. */
  keys: Record<string, string>
}

/** The wireless interface in a getConfig&name=WLan answer: the enabled one, else the first. */
function wlanInterface(kv: Record<string, string>): WlanInterface | null {
  const found = new Map<string, Record<string, string>>()
  for (const [key, value] of Object.entries(kv)) {
    const m = /^WLan\.([^.[\]]+)\.(.+)$/.exec(key)
    if (!m) continue
    const name = m[1]!
    let keys = found.get(name)
    if (!keys) {
      keys = {}
      found.set(name, keys)
    }
    keys[m[2]!] = value
  }
  let first: WlanInterface | null = null
  for (const [name, keys] of found) {
    if ((keys.Enable ?? '').trim().toLowerCase() === 'true') return { name, keys }
    first ??= { name, keys }
  }
  return first
}

function isCellularInterface(row: Record<string, string>): boolean {
  return /^3g/i.test((row.Name ?? '').trim()) || /LTE|WCDMA|SCDMA|CDMA|EDGE|EVDO|\bNR\b/i.test(row.Type ?? '')
}

/** Short text for the SIM row on the tile, from the camera's interface list. */
function simSummary(kv: Record<string, string>): string {
  const sim = parseIndexed(kv, 'netInterface').find(isCellularInterface)
  if (!sim) return 'No SIM module reported by the camera'
  const type = (sim.Type ?? '').trim()
  const network = type && !type.includes(',') && !/^auto$/i.test(type) ? ` (${type})` : ''
  switch ((sim.ConnStatus ?? '').trim().toLowerCase()) {
    case 'connected':
      return `Connected${network}`
    case 'connecting':
      return 'Connecting'
    case 'disconn':
      return 'Not connected'
    case 'down':
      return 'Link is down'
    case 'inexistence':
      return 'No SIM module found'
  }
  // Older firmware only says whether the module is usable, not whether it is online.
  return (sim.Valid ?? '').trim().toLowerCase() === 'true' ? `SIM module ready${network}` : 'SIM module not available'
}

interface WifiSecurity {
  encryption: string
  keyType: 'ASCII' | 'Hex' | null
}

/**
 * The WLan.<if>.Encryption value for the target network. The documented values
 * are Off, On, WEP64Bits, WEP128Bits, WPA-PSK-TKIP and WPA-PSK-CCMP; firmware
 * that names them differently tells us so in its current setting, which is
 * reused when it fits the target's cipher.
 */
function chooseSecurity(password: string, cipher: number | null, current: string | undefined): WifiSecurity {
  // No password, or the camera sees the network as open (EncrAlgr 0): nothing to send as a key.
  if (!password || cipher === 0) return { encryption: 'Off', keyType: null }
  if (cipher === 1) {
    const hex = /^[0-9a-f]+$/i.test(password) && (password.length === 10 || password.length === 26)
    const short = password.length === 5 || password.length === 10
    return { encryption: short ? 'WEP64Bits' : 'WEP128Bits', keyType: hex ? 'Hex' : 'ASCII' }
  }
  const now = (current ?? '').trim()
  const nowIsWpa = /WPA/i.test(now)
  const nowIsTkipOnly = /TKIP/i.test(now) && !/CCMP|AES/i.test(now)
  if (cipher === 2) return { encryption: nowIsWpa && nowIsTkipOnly ? now : 'WPA-PSK-TKIP', keyType: 'ASCII' }
  if (cipher === 3 || cipher === 4) return { encryption: nowIsWpa && !nowIsTkipOnly ? now : 'WPA-PSK-CCMP', keyType: 'ASCII' }
  // The camera did not say what the target uses: house networks usually share one kind of security.
  return { encryption: nowIsWpa ? now : 'WPA-PSK-CCMP', keyType: 'ASCII' }
}

/** A dropped link right after the write is what a camera changing WiFi looks like. */
function looksLikeLinkDrop(err: unknown): boolean {
  return err instanceof Error && !(err instanceof Refusal) && /did not answer in time|closed the connection/i.test(err.message)
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const WIFI_OFF = 'WiFi is switched off for this camera here. Turn on "This camera has WiFi" in its settings first.'

const adapter: Adapter = {
  family: 'dahua',

  describe(): FamilyDescriptor {
    return {
      id: 'dahua',
      label: 'Dahua / CP Plus camera',
      tagline: 'Dahua cameras and recorders, and CP Plus models made by Dahua. Live view, pictures, turn and zoom, WiFi change.',
      kinds: ['camera'],
      fields: [
        FIELD.username('The login of the camera itself (often "admin"), not your phone-app account.'),
        FIELD.password('The camera\'s own password. Stored encrypted on the hub.'),
        {
          name: 'channel',
          label: 'Camera number',
          type: 'number',
          default: 1,
          help: 'Use 1 for a single camera. On a recorder (NVR / DVR) with several cameras, enter this camera\'s number on the recorder.',
        },
        {
          ...FIELD.https(),
          help: 'Switch on only if the camera\'s own settings page opens with https://. The hub then uses the usual secure port (443). If your camera uses a different one, enter it as the port of the connection.',
        },
        {
          name: 'rtspPort',
          label: 'Video port',
          type: 'number',
          default: 554,
          help: 'The port the camera sends live video on (RTSP). It is 554 unless you changed it in the camera.',
        },
        {
          name: 'ptz',
          label: 'This camera can turn or zoom',
          type: 'toggle',
          default: false,
          help: 'Switch on for pan / tilt / zoom (PTZ) models. Leave off for fixed cameras. The hub cannot tell the two apart by itself.',
        },
        {
          name: 'ptzChannel',
          label: 'Movement channel',
          type: 'number',
          showWhen: { field: 'ptz', equals: true },
          help: 'Normally leave empty. Older cameras count from 0 instead of 1: if the camera does not move when you press the arrows, enter 0 here (on a recorder, the camera number minus 1).',
        },
        {
          name: 'wifi',
          label: 'This camera has WiFi',
          type: 'toggle',
          default: false,
          help: 'Switch on for WiFi models. The hub then shows which network the camera is on and can move it to another one.',
        },
        {
          name: 'cellular',
          label: 'This camera has its own SIM (4G)',
          type: 'toggle',
          default: false,
          help: 'Switch on for 4G models. The hub then shows whether the SIM link is up.',
        },
      ],
      pathKinds: ['lan', 'cellular'],
      defaultPort: 80,
      capabilities: ['stream', 'snapshot', 'ptz', 'presets', 'wifi', 'wifi-scan', 'cellular', 'reboot', 'state'],
      notes: [
        'Works with Dahua cameras and recorders and with CP Plus models built by Dahua (most wired and professional CP Plus cameras). Live video, still pictures and restart work on all of them.',
        'CP Plus ezyKam+ SIM cameras (CP-V32G, CP-Z32G and similar) are a different design and usually do not answer this way. If the connection check fails for one of those, add it as an ONVIF camera instead.',
        'In the camera\'s own settings page, "CGI service" must be on, and on newer cameras Authentication Mode must be "Compatible" (MD5 digest). Otherwise the camera rejects the hub.',
        'These cameras lock a login for some minutes after a few wrong passwords. If you correct the password here and the camera still refuses it, wait a while and check again.',
        `Turning and zooming continue while you hold the button. If letting go does not get through from the phone, the hub sends the stop itself after ${MAX_MOVE_SECONDS} seconds.`,
        'Changing WiFi follows Dahua\'s published method, but it has not been proven on every model. The first time, keep a network cable or SIM connection as a second path so the camera stays reachable if it does not join.',
        'After a WiFi change the hub looks for the camera at the address saved on that network\'s connection. Reserve a fixed address for the camera in each router. Hidden WiFi networks cannot be chosen.',
        'The new WiFi password is sent to the camera over the network it is on now. Use HTTPS if the camera supports it.',
        'SIM (4G): the hub shows whether the SIM link is up, but these cameras do not report signal strength this way. The hub can only reach a camera through its SIM if the SIM has a public address or a private tunnel (VPN); ordinary SIMs block incoming connections.',
        'If live video stays black on the phone, set the camera\'s video format to H.264 (not H.265) in the camera\'s own settings.',
      ],
    }
  },

  capabilities(config: Record<string, unknown>, _kind: DeviceKind): Capability[] {
    const caps: Capability[] = ['stream', 'snapshot', 'reboot', 'state']
    if (flag(config.ptz, false)) caps.push('ptz', 'presets')
    if (flag(config.wifi, false)) caps.push('wifi', 'wifi-scan')
    if (flag(config.cellular, false)) caps.push('cellular')
    return caps
  },

  async probe(ctx): Promise<ProbeResult> {
    const started = Date.now()
    try {
      const res = await cgi(ctx, '/cgi-bin/magicBox.cgi?action=getSystemInfo')
      const latencyMs = Date.now() - started
      const sys = res.status === 200 ? parseKeyValues(res.text()) : {}
      const serial = (sys.serialNumber ?? '').trim()
      const deviceType = (sys.deviceType ?? '').trim()
      if (!serial && !deviceType) {
        return { ok: false, latencyMs: null, error: 'Something answered at this address, but not the way a Dahua or CP Plus camera does' }
      }

      // Model and firmware need two more calls; remember them so the regular check stays at one.
      const rt = runtimeOf(ctx)
      let known = rt.identity
      if (!known || known.serial !== serial || Date.now() - known.at > IDENTITY_TTL_MS) {
        known = null
        const left = ctx.timeoutMs - (Date.now() - started)
        if (left > 300) {
          const [type, version] = await Promise.all([
            readKv(ctx, '/cgi-bin/magicBox.cgi?action=getDeviceType', left).catch(() => null),
            readKv(ctx, '/cgi-bin/magicBox.cgi?action=getSoftwareVersion', left).catch(() => null),
          ])
          const model = (type?.type ?? '').trim() || null
          // version=2.212.0000.0.R,build:2013-11-14
          const m = /^([^,]*)(?:,\s*build:\s*(.*))?$/.exec((version?.version ?? '').trim())
          const firmware = m && m[1] ? (m[2] ? `${m[1]} (${m[2].trim()})` : m[1]) : null
          known = { serial, model, firmware, at: Date.now() }
          if (model && firmware) rt.identity = known
        }
      }

      const info: Record<string, unknown> = {}
      if (serial) info.serial = serial
      const model = known?.model ?? deviceType
      if (model) info.model = model
      if (known?.firmware) info.firmware = known.firmware
      return { ok: true, latencyMs, info }
    } catch (err) {
      return { ok: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async readState(ctx): Promise<Record<string, unknown>> {
    // The hub allows one device timeout for the whole read, so the calls run side by side.
    const budget = Math.floor(ctx.timeoutMs * 0.85)
    const ch = channelOf(ctx)
    const wantWifi = ctx.bool('wifi', false)
    const wantPtz = ctx.bool('ptz', false)
    const wantSim = ctx.bool('cellular', false)
    const skip = Promise.resolve(null)
    const [network, wlan, interfaces, status, presets] = await Promise.allSettled([
      readKv(ctx, GET_NETWORK, budget),
      wantWifi ? readKv(ctx, GET_WLAN, budget) : skip,
      wantSim ? readKv(ctx, GET_INTERFACES, budget) : skip,
      wantPtz ? readKv(ctx, `/cgi-bin/ptz.cgi?action=getStatus&channel=${ch}`, budget) : skip,
      wantPtz ? readKv(ctx, `/cgi-bin/ptz.cgi?action=getPresets&channel=${ch}`, budget) : skip,
    ])
    // Unreachable or wrong login: say so rather than return an empty state.
    if (network.status === 'rejected') throw network.reason

    const state: Record<string, unknown> = {}

    if (network.value) {
      const kv = network.value
      const preferred = (kv['Network.DefaultInterface'] ?? '').trim()
      let mac = preferred ? (kv[`Network.${preferred}.PhysicalAddress`] ?? '').trim() : ''
      if (!mac) {
        const any = Object.keys(kv).find((k) => /^Network\.[^.]+\.PhysicalAddress$/.test(k))
        mac = any ? (kv[any] ?? '').trim() : ''
      }
      if (mac) state.mac = mac
    }

    if (wantWifi && wlan.status === 'fulfilled') {
      // No WiFi table (the camera answered "Error") reads the same as WiFi switched off: no network name.
      const wifi = wlan.value ? wlanInterface(wlan.value) : null
      const on = (wifi?.keys.Enable ?? '').trim().toLowerCase() === 'true'
      // Only the network name leaves this block; the same answer carries the stored WiFi keys.
      state.wifi = on && wifi?.keys.SSID ? wifi.keys.SSID : null
    }

    if (interfaces.status === 'fulfilled' && interfaces.value) state.sim = simSummary(interfaces.value)

    if (status.status === 'fulfilled' && status.value) {
      const position = ptzPosition(status.value)
      if (position) state.ptz = position
    }

    if (presets.status === 'fulfilled' && presets.value) {
      const ids: number[] = []
      const names: Record<string, string> = {}
      for (const row of presetRows(presets.value)) {
        const index = toNumber(row.Index)
        if (index === null) continue
        ids.push(index)
        if (row.Name?.trim()) names[String(index)] = row.Name.trim()
      }
      state.presets = ids
      state.presetNames = names
    }

    return state
  },

  async execute(ctx, action: Action): Promise<ActionResult> {
    const p = action.params
    try {
      switch (action.type) {
        case 'ptz.move': {
          if (!ctx.bool('ptz', false)) return unsupported(action)
          const rt = runtimeOf(ctx)
          const wanted = movesFor(axis(p.pan), axis(p.tilt), axis(p.zoom))
          if (wanted.length === 0) {
            const stopped = await stopMoves(ctx, rt)
            return stopped ? { ok: true } : { ok: false, error: 'The camera did not accept the stop command' }
          }
          const asked = Number(p.seconds ?? 0)
          const seconds = Number.isFinite(asked) && asked > 0 ? clamp(asked, 0.05, LONGEST_REQUESTED_MOVE_SECONDS) : MAX_MOVE_SECONDS
          clearStopTimer(rt)
          const started: Move[] = []
          try {
            // Each start needs a stop with the same code, so end what is no longer wanted first.
            for (const old of rt.moves) {
              if (wanted.some((w) => w.code === old.code)) continue
              await ptzCommand(ctx, rt, 'stop', old)
              rt.moves = rt.moves.filter((m) => m !== old)
            }
            for (const move of wanted) {
              // On record before it is sent: if the answer gets lost on the way back, the camera is
              // turning all the same and still needs its stop. A direction already running with the
              // same code is replaced; it comes back on record if the camera turns the new one down.
              const previous = rt.moves.find((m) => m.code === move.code)
              rt.moves = [...rt.moves.filter((m) => m !== previous), move]
              const forget = (): void => {
                rt.moves = previous ? rt.moves.map((m) => (m === move ? previous : m)) : rt.moves.filter((m) => m !== move)
              }
              let accepted: boolean
              try {
                accepted = await ptzCommand(ctx, rt, 'start', move)
              } catch (err) {
                // A refusal (wrong login, service off) means the camera did not start anything.
                if (err instanceof Refusal) forget()
                throw err
              }
              if (accepted) started.push(move)
              else forget()
            }
          } finally {
            // Whatever happened above, anything that may be moving gets its stop.
            if (rt.moves.length > 0) armStop(ctx, rt, seconds * 1000)
          }
          if (started.length === 0) {
            return {
              ok: false,
              error: 'The camera did not accept the move command. Check that this model can turn or zoom; if it can, try 0 or 1 in "Movement channel"',
            }
          }
          return { ok: true, result: { stopsAfterSeconds: seconds } }
        }

        case 'ptz.stop': {
          if (!ctx.bool('ptz', false)) return unsupported(action)
          const stopped = await stopMoves(ctx, runtimeOf(ctx))
          return stopped ? { ok: true } : { ok: false, error: 'The camera did not accept the stop command' }
        }

        case 'ptz.preset': {
          if (!ctx.bool('ptz', false)) return unsupported(action)
          const rt = runtimeOf(ctx)
          const preset = await presetNumber(ctx, p.preset)
          if (preset === null || preset < 1) return { ok: false, error: `No preset "${String(p.preset ?? '')}" on this camera` }
          clearStopTimer(rt)
          rt.moves = []
          const ok = await ptzCommand(ctx, rt, 'start', { code: 'GotoPreset', arg1: 0, arg2: preset, arg3: 0 })
          return ok ? { ok: true, result: { preset } } : { ok: false, error: `The camera did not go to preset ${preset}. Check that the preset is saved in the camera` }
        }

        case 'reboot': {
          const ok = await command(ctx, '/cgi-bin/magicBox.cgi?action=reboot')
          if (!ok) return { ok: false, error: 'The camera did not accept the restart command' }
          const rt = runtimeOf(ctx)
          clearStopTimer(rt)
          rt.moves = []
          rt.identity = null
          return { ok: true, result: { note: 'The camera is restarting. It usually takes a minute or two to come back.' } }
        }

        default:
          return unsupported(action)
      }
    } catch (err) {
      // The camera answered and said no: report it. Anything else is a connection problem for the hub to route around.
      if (err instanceof Refusal) return { ok: false, error: err.message }
      throw err
    }
  },

  async snapshot(ctx): Promise<Snapshot> {
    // A full-size picture over a SIM link takes a while; the hub allows two device timeouts for it.
    const res = await cgi(ctx, `/cgi-bin/snapshot.cgi?channel=${channelOf(ctx)}`, ctx.timeoutMs * 1.75)
    // Trust the bytes over the label: a JPEG starts with FF D8, whatever Content-Type says (or leaves out).
    const jpeg = res.body.length > 3 && res.body[0] === 0xff && res.body[1] === 0xd8
    const declared = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (res.status !== 200 || !(jpeg || (declared.startsWith('image/') && res.body.length > 0))) {
      throw new Error('The camera did not return a picture. Check the camera number')
    }
    return { contentType: jpeg ? 'image/jpeg' : declared, body: res.body }
  },

  streamSources(ctx): string[] {
    const host = requireHost(ctx)
    const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    // A SIM or forwarded connection may publish video on another port: path.extra.rtspPort wins over the device setting.
    const perPath = Number(ctx.path.extra?.rtspPort)
    const configured = ctx.num('rtspPort', 554)
    const pick = Number.isInteger(perPath) && perPath > 0 && perPath < 65536 ? perPath : configured
    const port = Number.isInteger(pick) && pick > 0 && pick < 65536 ? pick : 554
    const login = userInfo(ctx.str('username').trim(), ctx.secret('password'))
    const ch = channelOf(ctx)
    // subtype 0 = main stream (full quality), 1 = sub stream (lighter, for the SIM path and thumbnails).
    return [0, 1].map((subtype) => `rtsp://${login}${h}:${port}/cam/realmonitor?channel=${ch}&subtype=${subtype}`)
  },

  async scanWifi(ctx): Promise<WifiScanEntry[]> {
    if (!ctx.bool('wifi', false)) throw new Error(WIFI_OFF)
    // A scan takes the camera several seconds; the hub allows three device timeouts for it.
    const res = await cgi(ctx, SCAN_WLAN, ctx.timeoutMs * 2.5)
    if (res.status !== 200) throw new Error('This camera cannot look for WiFi networks. It may have no WiFi, or this model does not offer a scan')
    return parseWifiScan(res.text())
  },

  async setWifi(ctx, target): Promise<ActionResult> {
    if (!ctx.bool('wifi', false)) return { ok: false, error: WIFI_OFF }
    const ssid = target.ssid
    if (!ssid || !ssid.trim()) return { ok: false, error: 'No network name given' }
    const started = Date.now()
    // The hub allows two device timeouts for the whole move.
    const total = ctx.timeoutMs * 2
    try {
      // 1. Read the camera's WiFi table: it names the wireless interface and shows how this firmware spells things.
      const table = await readKv(ctx, GET_WLAN, ctx.timeoutMs * 0.5)
      const wlan = table ? wlanInterface(table) : null
      let iface = wlan?.name ?? ''
      if (!iface) {
        const list = await readKv(ctx, GET_INTERFACES, ctx.timeoutMs * 0.5)
        iface = (list ? parseIndexed(list, 'netInterface') : []).find((row) => /wireless/i.test(row.Type ?? ''))?.Name?.trim() ?? ''
      }
      if (!iface) return { ok: false, error: 'This camera does not report a WiFi adapter, so it cannot be moved to another WiFi network' }
      if (!/^[A-Za-z0-9_-]+$/.test(iface)) return { ok: false, error: 'The camera reported a WiFi adapter name the hub does not recognise' }

      // 2. Ask the camera what it can see. Moving it to a network out of its reach would leave it on no WiFi at all.
      let cipher: number | null = null
      let seen: ScannedNetwork[] | null = null
      try {
        const scan = await cgi(ctx, SCAN_WLAN, ctx.timeoutMs * 0.6)
        if (scan.status === 200) seen = parseScan(scan.text())
      } catch (err) {
        if (err instanceof Refusal) throw err
        ctx.log.debug('WiFi scan before the move gave no answer; continuing without it')
      }
      if (seen && seen.length > 0) {
        const match = seen.find((n) => n.ssid === ssid)
        if (!match) {
          return { ok: false, error: `The camera cannot see "${ssid}" from where it is, so it was left on its current network. Check the name, or move the router closer` }
        }
        cipher = match.cipher
      }

      // 3. One setConfig call, written the way the API documents it. Only the name=value pairs are escaped.
      const password = target.password ?? ''
      const security = chooseSecurity(password, cipher, wlan?.keys.Encryption)
      const pairs: Array<[string, string]> = [
        ['Enable', 'true'],
        ['SSID', ssid],
        ['Encryption', security.encryption],
      ]
      if (security.keyType) pairs.push(['KeyType', security.keyType], ['Keys[0]', password], ['KeyID', '0'])
      pairs.push(['LinkMode', 'Infrastructure'])
      // Newer firmware has a separate "connect" switch; set it only where the camera lists it.
      if (wlan && wlan.keys.ConnectEnable !== undefined) pairs.push(['ConnectEnable', 'true'])
      const query = pairs.map(([key, value]) => `WLan.${iface}.${key}=${enc(value)}`).join('&')
      const left = total - (Date.now() - started) - 500
      let accepted: boolean
      try {
        accepted = await command(ctx, `/cgi-bin/configManager.cgi?action=setConfig&${query}`, clamp(left, 800, ctx.timeoutMs))
      } catch (err) {
        if (!looksLikeLinkDrop(err)) throw err
        // It was answering a moment ago: this is what leaving for another network looks like. The hub now looks for it there.
        return {
          ok: true,
          result: { ssid, note: 'The camera stopped answering right after the new WiFi details were sent, which is normal when it changes network.' },
          state: { wifi: ssid },
        }
      }
      if (!accepted) return { ok: false, error: `The camera did not accept the WiFi settings for "${ssid}"` }
      return { ok: true, result: { ssid, security: security.encryption }, state: { wifi: ssid } }
    } catch (err) {
      if (err instanceof Refusal) return { ok: false, error: err.message }
      throw err
    }
  },
}

export default adapter
