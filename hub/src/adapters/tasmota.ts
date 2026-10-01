/**
 * Tasmota — Sonoff and other ESP switches flashed with Tasmota, driven over the
 * device's own web API: GET /cm?cmnd=<command> answers with JSON.
 *
 * Three uses of the same relay board:
 *  - light / switch: Power<n> ON|OFF|TOGGLE, Dimmer, Color / CT;
 *  - gate or garage door: one short press of a relay wired across the motor's
 *    push-button terminals. The press is timed by the device (PulseTime<n>), so
 *    the relay lets go even if WiFi drops in the middle of it;
 *  - optional door sensor on a Tasmota Switch input for open / closed.
 *
 * House WiFi only: these boards have no SIM, and the login travels in clear text.
 */
import type { Action, Capability, DeviceKind, FamilyDescriptor, GateState } from '@house/shared'
import { request, sleep } from '../lib/http.ts'
import { baseUrl, clamp, unsupported, type ActionResult, type Adapter, type AdapterContext, type ProbeResult, type WifiScanEntry } from './types.ts'

type Json = Record<string, unknown>

/** tasmota.h: MAX_RELAYS_SET / MAX_SWITCHES_SET. */
const MAX_RELAYS = 32
const MAX_SWITCHES = 28
/** A gate leaves its closed-position sensor within a few seconds of the press. */
const LEAVE_SENSOR_MS = 4000
/** Extra wait after the press length before checking that the relay let go. */
const RELEASE_MARGIN_MS = 250
const SCAN_POLL_MS = 700

/** The device answered, but said no (wrong login, command not accepted). Not a reason to try another connection. */
class Refused extends Error {}

// ------------------------------------------------------------------ config

interface ConfigReader {
  str(name: string, fallback?: string): string
  num(name: string, fallback?: number): number
  bool(name: string, fallback?: boolean): boolean
}

interface Settings {
  /** True when the relay presses a gate button instead of staying on or off. */
  gate: boolean
  relay: number
  dimmer: boolean
  color: boolean
  /** Separate open / close / stop relays instead of one step button. */
  separate: boolean
  openRelay: number
  closeRelay: number
  /** 0 = no stop relay. */
  stopRelay: number
  pulseMs: number
  /** Tasmota Switch<n> with the door sensor; 0 = none. */
  stateInput: number
  onMeansClosed: boolean
  travelMs: number
}

/** Same reading rules as the hub's AdapterContext, for capabilities() which only gets the raw config. */
function readerOf(config: Json): ConfigReader {
  return {
    str: (name, fallback = '') => {
      const v = config[name]
      return v === undefined || v === null ? fallback : String(v)
    },
    num: (name, fallback = 0) => {
      const v = config[name]
      const n = Number(v)
      return Number.isFinite(n) && v !== '' && v !== null && v !== undefined ? n : fallback
    },
    bool: (name, fallback = false) => {
      const v = config[name]
      if (v === undefined || v === null || v === '') return fallback
      return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
    },
  }
}

function settingsOf(c: ConfigReader, kind: DeviceKind): Settings {
  const whole = (name: string, fallback: number, lo: number, hi: number) => clamp(Math.round(c.num(name, fallback)), lo, hi)
  return {
    gate: kind === 'gate' || c.str('use') === 'gate',
    relay: whole('relay', 1, 1, MAX_RELAYS),
    dimmer: c.bool('dimmer', false),
    color: c.bool('color', false),
    separate: c.str('gateMode', 'single') === 'separate',
    openRelay: whole('openRelay', 1, 1, MAX_RELAYS),
    closeRelay: whole('closeRelay', 2, 1, MAX_RELAYS),
    stopRelay: whole('stopRelay', 0, 0, MAX_RELAYS),
    pulseMs: whole('pulseMs', 800, 100, 60_000),
    stateInput: whole('stateInput', 0, 0, MAX_SWITCHES),
    onMeansClosed: c.str('stateOnMeans', 'closed') !== 'open',
    travelMs: whole('travelSeconds', 20, 1, 120) * 1000,
  }
}

// -------------------------------------------------------------------- wire

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Tasmota is loose about key case ("WifiScan" / "WiFiScan", "SSId"), so look keys up without it. */
function pick(obj: Json, name: string): unknown {
  if (name in obj) return obj[name]
  const want = name.toLowerCase()
  for (const k of Object.keys(obj)) if (k.toLowerCase() === want) return obj[k]
  return undefined
}

function section(obj: Json, name: string): Json | null {
  const v = pick(obj, name)
  return isObj(v) ? v : null
}

function numberOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

function onOff(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (v === 1 || v === 0) return v === 1
  if (typeof v !== 'string') return undefined
  const t = v.trim().toUpperCase()
  if (t === 'ON' || t === '1' || t === 'TRUE') return true
  if (t === 'OFF' || t === '0' || t === 'FALSE') return false
  return undefined
}

/** Single-relay boards answer "POWER", multi-relay boards "POWER1", "POWER2" … */
function powerValue(obj: Json, relay: number): unknown {
  const numbered = pick(obj, `POWER${relay}`)
  return numbered !== undefined ? numbered : relay === 1 ? pick(obj, 'POWER') : undefined
}

function powerOf(obj: Json, relay: number): boolean | undefined {
  return onOff(powerValue(obj, relay))
}

/** {"Command":"Unknown"} / {"Command":"Error"}: the firmware does not know the command, or the number is out of range. */
function notAccepted(reply: Json): boolean {
  const c = pick(reply, 'Command')
  return typeof c === 'string' && /^(unknown|error)$/i.test(c.trim())
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The request certainly never reached the device (as opposed to "sent, but no answer"). */
function neverSent(err: unknown): boolean {
  return /refused the connection|is not reachable|could not be resolved/.test(messageOf(err))
}

/**
 * Run one console command. Every URL is built from the path in use. The login is
 * sent both ways Tasmota accepts it: HTTP Basic (checked first by current firmware)
 * and the user= / password= arguments older firmware needs. The Referer satisfies
 * the firmware's check that API calls come "from" its own address.
 * Error messages never carry the URL, because the URL carries the password.
 */
async function command(ctx: AdapterContext, cmnd: string, timeoutMs: number = ctx.timeoutMs): Promise<Json> {
  const base = baseUrl(ctx, { defaultPort: 80 })
  try {
    // Everything after the address is percent-encoded, so only the address itself can make the URL unusable.
    // Caught here because the platform's own "Invalid URL" error carries the whole URL, password included.
    new URL(base)
  } catch {
    throw new Error(`The address on the "${ctx.path.label}" connection is not usable. Enter just the device's IP address, for example 192.168.1.60.`)
  }
  const password = ctx.secret('password')
  const username = ctx.str('username').trim() || 'admin'
  const login = password ? `user=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&` : ''
  const res = await request(`${base}/cm?${login}cmnd=${encodeURIComponent(cmnd)}`, {
    timeoutMs,
    // A fresh connection per command: these small boards close after every answer, and a reused
    // socket that has gone stale would blur "never sent" into "sent, no answer".
    headers: { Referer: `${base}/`, Accept: 'application/json', Connection: 'close' },
    basic: password ? { username, password } : undefined,
  }).catch((err: unknown) => {
    const message = messageOf(err)
    if (/^Timed out after/i.test(message)) {
      throw new Error(`${ctx.path.host ?? 'The device'} did not answer in time. It may be switched off or on another WiFi network.`)
    }
    throw err instanceof Error ? err : new Error(message)
  })

  let body: unknown = null
  try {
    body = JSON.parse(res.text())
  } catch {
    body = null
  }
  const reply = isObj(body) ? body : null
  const warning = reply && typeof reply.WARNING === 'string' ? reply.WARNING : ''
  if (res.status === 401 || /need user/i.test(warning)) {
    throw new Refused(password ? 'Wrong username or password' : 'This device asks for a password. Enter its web password in the device settings.')
  }
  if (res.status !== 200) throw new Error(`The device answered with an error (HTTP ${res.status}). It may not be a Tasmota device.`)
  if (!reply) throw new Error('Something answered at this address, but not the way a Tasmota device does')
  if (warning) throw new Refused('The device did not accept the command')
  return reply
}

// ------------------------------------------------------------------- state

function identityOf(reply: Json): Json {
  const out: Json = {}
  const status = section(reply, 'Status')
  if (status) {
    const friendly = pick(status, 'FriendlyName')
    const first = Array.isArray(friendly) ? friendly[0] : friendly
    const deviceName = pick(status, 'DeviceName')
    const name = typeof deviceName === 'string' && deviceName.trim() ? deviceName : first
    if (typeof name === 'string' && name.trim()) out.name = name.trim()
  }
  const fwr = section(reply, 'StatusFWR')
  const version = fwr ? pick(fwr, 'Version') : undefined
  const hardware = fwr ? pick(fwr, 'Hardware') : undefined
  if (typeof version === 'string' && version) out.firmware = version
  out.model = typeof hardware === 'string' && hardware ? `Tasmota (${hardware})` : 'Tasmota'
  const net = section(reply, 'StatusNET')
  if (net) {
    const mac = pick(net, 'Mac')
    const hostname = pick(net, 'Hostname')
    const ip = pick(net, 'IPAddress')
    if (typeof mac === 'string' && mac) out.mac = mac
    if (typeof hostname === 'string' && hostname) out.hostname = hostname
    if (typeof ip === 'string' && ip) out.ip = ip
  }
  return out
}

function wifiOf(sts: Json): { ap: number | undefined; ssid: string | undefined; signal: number | undefined } {
  const wifi = section(sts, 'Wifi')
  if (!wifi) return { ap: undefined, ssid: undefined, signal: undefined }
  const ssid = pick(wifi, 'SSId')
  // "RSSI" is already a 0-100 quality figure; "Signal" (newer firmware) is the raw dBm.
  const quality = numberOf(pick(wifi, 'RSSI'))
  const dbm = numberOf(pick(wifi, 'Signal'))
  const signal = quality !== undefined ? clamp(Math.round(quality), 0, 100) : dbm !== undefined ? clamp(Math.round(2 * (dbm + 100)), 0, 100) : undefined
  return { ap: numberOf(pick(wifi, 'AP')), ssid: typeof ssid === 'string' && ssid ? ssid : undefined, signal }
}

/** True = the sensor says closed, false = not closed, null = the device did not report that input. */
function sensorClosed(reply: Json, s: Settings): boolean | null {
  const sns = section(reply, 'StatusSNS')
  const on = sns ? onOff(pick(sns, `Switch${s.stateInput}`)) : undefined
  return on === undefined ? null : on === s.onMeansClosed
}

/** What the hub itself last asked the gate to do, so "opening" / "closing" can be shown while it travels. */
interface Move {
  goal: 'open' | 'closed' | 'stopped'
  at: number
  /** For a stop the hub made: which way the gate was going when the button was pressed. */
  from?: 'opening' | 'closing'
}
const lastMove = new Map<string, Move>()

/** Test hook. */
export function resetTasmotaMemory(): void {
  lastMove.clear()
}

/**
 * Gate position from one sensor at the closed position. "Closed" is certain;
 * anything else is "not closed", refined by what the hub last asked for and how
 * long the gate takes to travel.
 */
function gateNow(deviceId: string, s: Settings, closed: boolean | null): GateState {
  if (closed === null) return 'unknown'
  const last = lastMove.get(deviceId)
  const age = last ? Date.now() - last.at : Number.POSITIVE_INFINITY
  if (closed) {
    if (last?.goal === 'open' && age < Math.min(LEAVE_SENSOR_MS, s.travelMs)) return 'opening'
    lastMove.delete(deviceId)
    return 'closed'
  }
  if (!last) return 'open'
  if (last.goal === 'stopped') return 'stopped'
  if (age < s.travelMs) return last.goal === 'open' ? 'opening' : 'closing'
  return 'open'
}

/** State keys from a Status reply that holds StatusSTS (and StatusSNS when the gate sensor is wanted). */
function stateOf(deviceId: string, s: Settings, reply: Json): Json {
  const out: Json = {}
  const sts = section(reply, 'StatusSTS')
  if (sts) {
    if (!s.gate) {
      const power = powerOf(sts, s.relay)
      if (power !== undefined) out.power = power
      if (s.dimmer) {
        const dimmer = numberOf(pick(sts, 'Dimmer'))
        if (dimmer !== undefined) out.brightness = clamp(Math.round(dimmer), 0, 100)
      }
      if (s.color) Object.assign(out, colorOf(sts))
    }
    const wifi = wifiOf(sts)
    if (wifi.ssid) out.wifi = wifi.ssid
    if (wifi.signal !== undefined) out.signal = wifi.signal
  }
  if (s.gate) out.gate = s.stateInput > 0 ? gateNow(deviceId, s, sensorClosed(reply, s)) : 'unknown'
  return out
}

function colorOf(obj: Json): Json {
  const out: Json = {}
  const color = pick(obj, 'Color')
  if (typeof color === 'string' && /^[0-9a-f]{6}/i.test(color)) {
    out.color = `#${color.slice(0, 6).toUpperCase()}`
  } else if (typeof color === 'string' && /^\d{1,3}(,\d{1,3}){2,4}$/.test(color.trim())) {
    // SetOption17 1 makes the device report "255,136,0" instead of "FF8800".
    const rgb = color.split(',').slice(0, 3).map((part) => clamp(Number(part), 0, 255))
    out.color = `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`
  }
  const ct = numberOf(pick(obj, 'CT'))
  if (ct !== undefined && ct > 0) out.temperature = Math.round(1_000_000 / ct)
  return out
}

// -------------------------------------------------------------------- gate

/** PulseTime<n> value: 1..111 are tenths of a second, 112..64900 are seconds + 100. */
function pulseTimeValue(ms: number): number {
  const tenths = Math.round(ms / 100)
  if (tenths <= 111) return clamp(tenths, 1, 111)
  return clamp(100 + Math.round(ms / 1000), 112, 64_900)
}

/**
 * One press of a gate button: set the device's own release timer, switch the
 * relay on, then check that it let go.
 * `left()` is the time remaining before the hub gives up on the whole action.
 */
async function pressRelay(ctx: AdapterContext, relay: number, pulseMs: number, left: () => number): Promise<ActionResult> {
  const value = pulseTimeValue(pulseMs)
  const holdMs = value <= 111 ? value * 100 : (value - 100) * 1000
  const stepTimeout = (): number => {
    const ms = Math.min(ctx.timeoutMs, left())
    if (ms < 500) throw new Error('The device is answering too slowly to press the gate button safely')
    return ms
  }

  // Nothing is pressed yet, so a failure up to here may safely be retried on another connection.
  const timer = pick(await command(ctx, `PulseTime${relay} ${value}`, stepTimeout()), `PulseTime${relay}`)
  if (!isObj(timer) || numberOf(pick(timer, 'Set')) !== value) {
    return {
      ok: false,
      error: `The device did not accept the press length for relay ${relay}, so the hub did not press it. Without it the button could stay held down.`,
    }
  }

  const pressTimeout = stepTimeout()
  let reply: Json
  try {
    reply = await command(ctx, `Power${relay} ON`, pressTimeout)
  } catch (err) {
    if (err instanceof Refused || neverSent(err)) throw err
    // Sent, but no answer: pressing again on another connection could stop a gate that has just started moving.
    return {
      ok: true,
      needsConfirmation: true,
      result: { relay, note: 'The press was sent, but the device did not answer, so the hub cannot tell whether the gate button was pressed. Look at the gate, then confirm.' },
    }
  }
  if (notAccepted(reply)) return { ok: false, error: `The device has no relay number ${relay}` }
  const answered = powerValue(reply, relay)
  if (answered === undefined || onOff(answered) === false) {
    return { ok: false, error: `Relay ${relay} did not switch on, so the gate button was not pressed` }
  }

  // The button has been pressed. From here on never throw: the hub would press it again.
  let released = false
  let stuck = false
  let note: string | undefined
  const wait = holdMs + RELEASE_MARGIN_MS
  if (left() - wait >= 1000) {
    await sleep(wait)
    const checkTimeout = () => Math.min(ctx.timeoutMs, Math.max(300, left()))
    try {
      const seen = powerOf(await command(ctx, `Power${relay}`, checkTimeout()), relay)
      if (seen === false) released = true
      else if (seen === true) {
        stuck = true
        if (powerOf(await command(ctx, `Power${relay} OFF`, checkTimeout()), relay) === false) {
          stuck = false
          released = true
          note = 'The relay did not let go by itself, so the hub switched it off. Check the device’s PulseTime setting.'
        }
      }
    } catch {
      // Could not look again; the device times the release itself.
    }
  }
  if (stuck) {
    return { ok: false, error: `The gate button was pressed, but relay ${relay} is still on. Switch it off on the device’s own web page and check the device.` }
  }
  if (!released && !note) note = 'The press was made; the hub could not re-check that the relay let go (the device times that itself).'
  return { ok: true, result: { relay, pressMs: holdMs, released, ...(note ? { note } : {}) } }
}

async function gateAction(ctx: AdapterContext, s: Settings, action: Action): Promise<ActionResult> {
  // The hub allows an action twice the device timeout; stay inside it so it never retries a press that happened.
  const deadline = Date.now() + ctx.timeoutMs * 2 - 750
  const left = () => deadline - Date.now()
  const id = ctx.device.id
  const wanted: Move['goal'] | null = action.type === 'gate.open' ? 'open' : action.type === 'gate.close' ? 'closed' : action.type === 'gate.stop' ? 'stopped' : null
  const watched = s.stateInput > 0
  let relay = s.relay
  let goal: Move['goal'] | null = wanted
  let from: Move['from']
  let note: string | undefined

  if (s.separate) {
    if (!wanted) {
      return { ok: false, error: 'This gate has separate open, close and stop buttons, so there is no single step press. Use Open, Close or Stop.' }
    }
    relay = wanted === 'open' ? s.openRelay : wanted === 'closed' ? s.closeRelay : s.stopRelay
    if (relay < 1) return { ok: false, error: 'No stop relay is set for this gate' }
  } else if (watched) {
    // One button steps open → stop → close → stop. With the sensor, never press when that would do the opposite of what was asked.
    const now = gateNow(id, s, sensorClosed(await command(ctx, 'Status 10', Math.min(ctx.timeoutMs, Math.max(500, left()))), s))
    const skip = (why: string): ActionResult => ({ ok: true, result: { alreadyThere: true, note: why }, state: { gate: now } })
    if (now !== 'unknown') {
      const moving = now === 'opening' || now === 'closing'
      if (wanted === 'closed' && now === 'closed') return skip('The gate is already closed, so the button was not pressed.')
      if (wanted === 'closed' && now === 'closing') return skip('The gate is already closing, so the button was not pressed.')
      if (wanted === 'open' && now === 'open') return skip('The gate is already open, so the button was not pressed.')
      if (wanted === 'open' && now === 'opening') return skip('The gate is already opening, so the button was not pressed.')
      if (wanted === 'stopped' && now === 'closed') return skip('The gate is closed, so there is nothing to stop.')
      const last = lastMove.get(id)
      if (wanted === 'stopped' && now === 'stopped' && last && Date.now() - last.at < s.travelMs) {
        // A second Stop right after the first (a double tap) would set the gate moving again.
        return skip('The gate was stopped a moment ago, so the button was not pressed again. Another press would set it moving.')
      }
      if (moving) {
        goal = 'stopped'
        from = now
        if (wanted && wanted !== 'stopped') note = `The gate was ${now}; one press stops it. Tap ${wanted === 'open' ? 'Open' : 'Close'} again to carry on.`
      } else if (wanted === 'stopped') {
        // Not closed, and not moving as far as the hub knows. It may still be moving (a remote, a wall
        // button, the motor's own auto-close), and then this press is the one that stops it.
        note = 'The hub did not know the gate was moving. If it was standing still, this press has set it moving; look at the gate.'
      } else if (!wanted) {
        goal = now === 'closed' ? 'open' : now === 'open' ? 'closed' : null
      } else if (now === 'stopped' && last?.from === (wanted === 'open' ? 'opening' : 'closing')) {
        note = `The gate was stopped while ${last.from}. On many gates the next press turns it round instead of carrying on, so check which way it is moving.`
      }
    }
  }

  const pressedAt = Date.now()
  const press = await pressRelay(ctx, relay, s.pulseMs, left)
  if (!press.ok || press.needsConfirmation) {
    if (press.needsConfirmation) lastMove.delete(id)
    return press
  }
  if (watched && goal) lastMove.set(id, { goal, at: pressedAt, ...(from ? { from } : {}) })
  else lastMove.delete(id)
  const pressNote = typeof press.result?.note === 'string' ? press.result.note : ''
  const notes = [note, pressNote].filter(Boolean).join(' ')
  const result = { ...(press.result ?? {}), ...(notes ? { note: notes } : {}) }
  if (!watched || !goal) return { ok: true, result }
  return { ok: true, result, state: { gate: goal === 'open' ? 'opening' : goal === 'closed' ? 'closing' : 'stopped' } }
}

// -------------------------------------------------------------------- wifi

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

/** Why this network cannot be sent in a Backlog, or null when it can. Never quotes the password. */
function wifiProblem(ssid: string, password: string): string | null {
  if (!ssid) return 'No network name given'
  if (!password) return `No password stored for "${ssid}"`
  if (ssid.includes(';') || password.includes(';')) {
    return 'Tasmota cannot be sent a WiFi name or password that contains a semicolon (;). Set this network once on the device’s own web page instead.'
  }
  if (/[\u0000-\u001f\u007f]/.test(ssid) || /[\u0000-\u001f\u007f]/.test(password)) {
    return 'The WiFi name or password contains a character that cannot be sent to the device'
  }
  if (ssid !== ssid.trim() || password !== password.trim()) {
    return 'The WiFi name or password starts or ends with a space, which Tasmota drops. Set this network once on the device’s own web page instead.'
  }
  // Backlog keeps a ";" that sits between { and } as part of one command. With an unmatched bracket it
  // would swallow the commands that follow, and the device would save the wrong name or password.
  const unmatched = (t: string) => t.split('{').length !== t.split('}').length
  if (unmatched(ssid) || unmatched(password)) {
    return 'Tasmota cannot be sent a WiFi name or password with an unmatched curly bracket ({ or }). Set this network once on the device’s own web page instead.'
  }
  if (/^[012"]$/.test(ssid)) return `Tasmota reads "${ssid}" as an instruction, not a name, so this network cannot be set from here`
  if (bytes(ssid) > 32) return 'That WiFi name is longer than the 32 characters Tasmota can store'
  if (bytes(password) > 64) return 'That WiFi password is longer than the 64 characters Tasmota can store'
  if (password.length < 8) return 'That WiFi password is shorter than 8 characters, which no protected network accepts'
  return null
}

function scanEntries(nets: Json): WifiScanEntry[] {
  const best = new Map<string, WifiScanEntry>()
  for (const net of Object.values(nets)) {
    if (!isObj(net)) continue
    const ssid = pick(net, 'SSId')
    if (typeof ssid !== 'string' || !ssid) continue
    const quality = numberOf(pick(net, 'RSSI'))
    const dbm = numberOf(pick(net, 'Signal'))
    const signal = quality !== undefined ? clamp(Math.round(quality), 0, 100) : dbm !== undefined ? clamp(Math.round(2 * (dbm + 100)), 0, 100) : null
    const encryption = pick(net, 'Encryption')
    const entry: WifiScanEntry = { ssid, signal, security: typeof encryption === 'string' && encryption ? encryption : null }
    const seen = best.get(ssid)
    if (!seen || (entry.signal ?? -1) > (seen.signal ?? -1)) best.set(ssid, entry)
  }
  return [...best.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1))
}

// ----------------------------------------------------------------- adapter

const adapter: Adapter = {
  family: 'tasmota',

  describe(): FamilyDescriptor {
    return {
      id: 'tasmota',
      label: 'Tasmota switch or relay',
      tagline: 'Sonoff and other WiFi switches running Tasmota: lights, switches, and gate or garage-door buttons.',
      kinds: ['light', 'switch', 'gate'],
      fields: [
        {
          name: 'use',
          label: 'What it controls',
          type: 'select',
          required: true,
          default: 'switch',
          options: [
            { value: 'switch', label: 'A light or a switch (stays on or off)' },
            { value: 'gate', label: 'A gate or garage door (short press of its button)' },
          ],
          help: 'Choose the gate option when the relay is wired across the push-button terminals of a gate or garage-door motor; the gate settings then appear below. A device added as a gate is always treated as one.',
        },
        {
          name: 'username',
          label: 'Username',
          type: 'text',
          placeholder: 'admin',
          help: 'Only needed if the device’s own web page asks you to log in. Tasmota always uses "admin", so you can leave this empty.',
        },
        {
          name: 'password',
          label: 'Password',
          type: 'password',
          secret: true,
          help: 'The web password set on the device. Leave empty if its web page opens without a login. Stored encrypted on the hub.',
        },
        {
          name: 'relay',
          label: 'Relay number',
          type: 'number',
          default: 1,
          help: 'Which switch on the device to use: 1 on a single switch; 2, 3, 4 … on boards with several. For a one-button gate this is the relay that presses the button.',
        },
        {
          name: 'dimmer',
          label: 'Can be dimmed',
          type: 'toggle',
          default: false,
          showWhen: { field: 'use', equals: 'switch' },
          help: 'Turn on for dimmer modules and dimmable bulbs. Leave off for plain on / off switches.',
        },
        {
          name: 'color',
          label: 'Can change colour',
          type: 'toggle',
          default: false,
          showWhen: { field: 'use', equals: 'switch' },
          help: 'Turn on for colour bulbs and strips, and for bulbs that go from warm to cool white.',
        },
        {
          name: 'gateMode',
          label: 'Gate buttons',
          type: 'select',
          default: 'single',
          showWhen: { field: 'use', equals: 'gate' },
          options: [
            { value: 'single', label: 'One button (each press steps open → stop → close)' },
            { value: 'separate', label: 'Separate open / close / stop relays' },
          ],
          help: 'One button: a single relay is wired to the motor’s step input. Separate: one relay each for the open, close and stop inputs, which makes every tap do exactly what it says.',
        },
        {
          name: 'openRelay',
          label: 'Open relay number',
          type: 'number',
          default: 1,
          showWhen: { field: 'gateMode', equals: 'separate' },
        },
        {
          name: 'closeRelay',
          label: 'Close relay number',
          type: 'number',
          default: 2,
          showWhen: { field: 'gateMode', equals: 'separate' },
        },
        {
          name: 'stopRelay',
          label: 'Stop relay number',
          type: 'number',
          default: 0,
          showWhen: { field: 'gateMode', equals: 'separate' },
          help: 'Leave at 0 if no relay is wired to the stop input.',
        },
        {
          name: 'pulseMs',
          label: 'Press length (milliseconds)',
          type: 'number',
          default: 800,
          showWhen: { field: 'use', equals: 'gate' },
          help: 'How long the relay holds the button. 800 suits most gate motors. The device times the press itself, so the relay lets go even if WiFi drops in the middle of it.',
        },
        {
          name: 'stateInput',
          label: 'Door sensor input (0 = none)',
          type: 'number',
          default: 0,
          showWhen: { field: 'use', equals: 'gate' },
          help: 'If a magnetic door sensor is wired to the device and set up in Tasmota as Switch 1, 2 …, enter that number so the tile can show open or closed. Fit the sensor where the gate is fully closed. Leave 0 if there is no sensor.',
        },
        {
          name: 'stateOnMeans',
          label: 'Sensor reads ON when the gate is',
          type: 'select',
          default: 'closed',
          showWhen: { field: 'use', equals: 'gate' },
          options: [
            { value: 'closed', label: 'Closed' },
            { value: 'open', label: 'Open' },
          ],
          help: 'If the tile shows open while the gate is shut, switch this over.',
        },
        {
          name: 'travelSeconds',
          label: 'Time to open or close fully (seconds)',
          type: 'number',
          default: 20,
          showWhen: { field: 'use', equals: 'gate' },
          help: 'Used with the door sensor to show "opening" and "closing" while the gate is moving.',
        },
      ],
      pathKinds: ['lan'],
      defaultPort: 80,
      capabilities: ['power', 'dim', 'color', 'gate', 'gate-state', 'wifi', 'wifi-scan', 'reboot', 'state'],
      notes: [
        'Works on the house WiFi only: the device has no SIM, so the hub must be on the same network as it.',
        'On, off, dimming and colour take effect at once, and the tile shows the state the device itself reports.',
        'Gate or garage door: each tap is one short press of the relay. The hub sets the device’s own press timer (PulseTime) so the button is never left held down, then checks that the relay let go. A press proves the button was pressed, not that the gate moved.',
        'With one button, the hub cannot know whether the next press opens or closes unless a door sensor is fitted. With a sensor, Close is ignored when the gate is already closed and Open when it is already open. Without one, every tap presses the button.',
        'Stop on a one-button gate is also just a press: it stops a gate that is moving, but it sets a gate that is standing part-way open moving. A second Stop straight after the first is ignored for that reason. After a stop, the next press may turn the gate round instead of carrying on; that depends on the motor.',
        'The door sensor sits at the closed position, so "closed" is certain and "open" means "not closed".',
        'For a gate, open the device’s own web page, go to Console and enter once: Backlog PowerOnState 0; SetOption114 1; SwitchMode1 1 — this keeps the relay off after a power cut and stops the door sensor from working the relay by itself. Without it, the sensor can press the gate button by itself whenever the gate moves. If the sensor is on Switch 2, write SwitchMode2 instead of SwitchMode1.',
        'Move to another WiFi: the hub saves the new network in the device’s spare WiFi slot and restarts it. The network it is on now stays saved, so it falls back to it if the new one cannot be joined. A WiFi name or password containing a semicolon (;) or an unmatched curly bracket cannot be sent, and Tasmota advises against spaces and special characters in them.',
        'After changing network the device usually gets a new address. Reserve its address in the router, or enter the new one on that connection.',
        'Listing nearby WiFi networks needs Tasmota 12.1 or newer.',
        'Tasmota sends its password unencrypted, so keep the device on the house network and never open it to the internet.',
      ],
    }
  },

  capabilities(config: Record<string, unknown>, kind: DeviceKind): Capability[] {
    const s = settingsOf(readerOf(config), kind)
    const shared: Capability[] = ['wifi', 'wifi-scan', 'reboot', 'state']
    if (s.gate) return s.stateInput > 0 ? ['gate', 'gate-state', ...shared] : ['gate', ...shared]
    const caps: Capability[] = ['power']
    if (s.dimmer) caps.push('dim')
    if (s.color) caps.push('color')
    return [...caps, ...shared]
  },

  async probe(ctx): Promise<ProbeResult> {
    const started = Date.now()
    let reply: Json
    try {
      // Status 0 is the one call that carries name, firmware, MAC, WiFi and relay state together.
      reply = await command(ctx, 'Status 0')
    } catch (err) {
      return { ok: false, latencyMs: null, error: messageOf(err) }
    }
    const latencyMs = Date.now() - started
    if (!section(reply, 'Status') && !section(reply, 'StatusSTS') && !section(reply, 'StatusNET')) {
      return { ok: false, latencyMs: null, error: 'Something answered at this address, but it is not a Tasmota device' }
    }
    const s = settingsOf(ctx, ctx.device.kind)
    return { ok: true, latencyMs, info: { ...identityOf(reply), ...stateOf(ctx.device.id, s, reply) } }
  },

  async readState(ctx) {
    const s = settingsOf(ctx, ctx.device.kind)
    // Status 11 is the light one; the door sensor lives in another block, so a watched gate asks for everything.
    const reply = await command(ctx, s.gate && s.stateInput > 0 ? 'Status 0' : 'Status 11')
    if (!section(reply, 'StatusSTS')) throw new Error('The device did not report its state')
    return stateOf(ctx.device.id, s, reply)
  },

  async execute(ctx, action: Action): Promise<ActionResult> {
    const s = settingsOf(ctx, ctx.device.kind)
    const p = action.params
    try {
      switch (action.type) {
        case 'power.on':
        case 'power.off':
        case 'power.toggle': {
          if (s.gate) return { ok: false, error: 'This relay presses a gate button, so it cannot be left switched on or off. Use Open, Close or Stop.' }
          const word = action.type === 'power.on' ? 'ON' : action.type === 'power.off' ? 'OFF' : 'TOGGLE'
          const reply = await command(ctx, `Power${s.relay} ${word}`)
          if (notAccepted(reply)) return { ok: false, error: `The device has no relay number ${s.relay}` }
          const answered = powerValue(reply, s.relay)
          if (answered === undefined) return { ok: false, error: 'The device answered, but did not confirm the switch' }
          // A device with renamed ON / OFF words still confirms by answering; trust the command for on / off.
          const power = onOff(answered) ?? (action.type === 'power.toggle' ? undefined : action.type === 'power.on')
          return power === undefined ? { ok: true } : { ok: true, state: { power } }
        }
        case 'dim.set': {
          if (s.gate || !s.dimmer) return unsupported(action)
          const asked = numberOf(p.brightness)
          if (asked === undefined) return { ok: false, error: 'No brightness given' }
          const reply = await command(ctx, `Dimmer ${clamp(Math.round(asked), 0, 100)}`)
          if (notAccepted(reply)) return { ok: false, error: 'This device does not dim. Turn off "Can be dimmed" in its settings.' }
          const dimmer = numberOf(pick(reply, 'Dimmer'))
          if (dimmer === undefined) return { ok: false, error: 'The device answered, but did not confirm the brightness' }
          const brightness = clamp(Math.round(dimmer), 0, 100)
          return { ok: true, state: { brightness, power: powerOf(reply, s.relay) ?? brightness > 0 } }
        }
        case 'color.set': {
          if (s.gate || !s.color) return unsupported(action)
          const hex = typeof p.hex === 'string' ? p.hex.trim().replace(/^#/, '') : ''
          const kelvin = numberOf(p.temperature)
          let cmnd: string
          if (hex) {
            if (!/^[0-9a-f]{6}$/i.test(hex)) return { ok: false, error: 'That is not a colour the light understands' }
            cmnd = `Color #${hex.toUpperCase()}`
          } else if (kelvin !== undefined && kelvin > 0) {
            // Tasmota counts colour temperature in mireds, 153 (cool) to 500 (warm).
            cmnd = `CT ${clamp(Math.round(1_000_000 / kelvin), 153, 500)}`
          } else {
            return { ok: false, error: 'No colour given' }
          }
          const reply = await command(ctx, cmnd)
          if (notAccepted(reply)) {
            return { ok: false, error: hex ? 'This light cannot change colour. Turn off "Can change colour" in its settings.' : 'This light cannot change between warm and cool white' }
          }
          const seen = colorOf(reply)
          const confirmed = hex ? seen.color : seen.temperature
          if (confirmed === undefined) return { ok: false, error: 'The device answered, but did not confirm the colour' }
          const state: Json = hex ? { color: seen.color } : { temperature: seen.temperature }
          const power = powerOf(reply, s.relay)
          if (power !== undefined) state.power = power
          const dimmer = numberOf(pick(reply, 'Dimmer'))
          if (s.dimmer && dimmer !== undefined) state.brightness = clamp(Math.round(dimmer), 0, 100)
          return { ok: true, state }
        }
        case 'gate.open':
        case 'gate.close':
        case 'gate.stop':
        case 'gate.pulse':
          if (!s.gate) return unsupported(action)
          return await gateAction(ctx, s, action)
        case 'reboot': {
          const reply = await command(ctx, 'Restart 1')
          if (pick(reply, 'Restart') === undefined) return { ok: false, error: 'The device answered, but did not confirm the restart' }
          return { ok: true, result: { restarting: true } }
        }
        default:
          return unsupported(action)
      }
    } catch (err) {
      if (err instanceof Refused) return { ok: false, error: err.message }
      throw err
    }
  },

  async setWifi(ctx, target): Promise<ActionResult> {
    const ssid = target.ssid ?? ''
    const password = target.password ?? ''
    const problem = wifiProblem(ssid, password)
    if (problem) return { ok: false, error: problem }
    try {
      const sts = section(await command(ctx, 'Status 11'), 'StatusSTS')
      const now = sts ? wifiOf(sts) : { ap: undefined, ssid: undefined, signal: undefined }
      if (now.ssid === ssid) return { ok: true, result: { ssid, alreadyThere: true }, state: { wifi: ssid } }
      // Tasmota keeps two networks. Write the one it is NOT using now, so the working one stays as the
      // fallback; setting a slot also makes it the one tried first after the restart.
      const slot = now.ap === 2 ? 1 : 2
      // One Backlog, because each of these commands would restart the device on its own. The reply is
      // not a confirmation (often just {}); the hub confirms by finding the device on the new network.
      const queued = await command(ctx, `Backlog SSID${slot} ${ssid}; Password${slot} ${password}; Restart 1`)
      if (notAccepted(queued)) return { ok: false, error: 'The device did not accept the WiFi change' }
      const plain = /^[A-Za-z0-9_.-]+$/
      const result: Json = { ssid, slot, restarting: true }
      if (now.ssid) result.fallback = now.ssid
      if (!plain.test(ssid) || !plain.test(password)) {
        result.note = 'Tasmota advises against spaces and special characters in WiFi names and passwords sent this way. If the device does not appear on the new network, it falls back to the one it was on.'
      }
      return { ok: true, result }
    } catch (err) {
      if (err instanceof Refused) return { ok: false, error: err.message }
      throw err
    }
  },

  async scanWifi(ctx): Promise<WifiScanEntry[]> {
    // The hub allows three device timeouts for a scan; a scan itself takes a few seconds.
    const deadline = Date.now() + Math.max(4000, ctx.timeoutMs * 3 - 1500)
    const start = await command(ctx, 'WifiScan 1')
    if (notAccepted(start)) throw new Error('This Tasmota version cannot list WiFi networks. Update it to 12.1 or newer.')
    let restarted = false
    for (;;) {
      await sleep(SCAN_POLL_MS)
      const answer = pick(await command(ctx, 'WifiScan'), 'WifiScan')
      if (isObj(answer)) return scanEntries(answer)
      const text = typeof answer === 'string' ? answer : ''
      if (/not started/i.test(text) && !restarted) {
        restarted = true
        await command(ctx, 'WifiScan 1')
      } else if (!/scanning|busy|not started/i.test(text)) {
        return []
      }
      if (Date.now() > deadline) throw new Error('The device is still scanning for WiFi networks. Try again in a moment.')
    }
  },
}

export default adapter
