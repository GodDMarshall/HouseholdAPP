/**
 * Generic HTTP relay — relay boards and home-made WiFi switches that are driven
 * by opening plain web addresses (on, off, toggle, pulse, status).
 *
 * The owner types the addresses once; every URL is built from the connection
 * path in use, so the same settings work on house WiFi A, house WiFi B and a
 * SIM port-forward. Lights and switches use on / off / toggle; gates use either
 * one button (step logic) or separate open / close / stop addresses.
 *
 * Three rules shape the code:
 *  - probe() and readState() only ever read the status addresses (or do a bare
 *    TCP check). They never touch an address that switches something.
 *  - A press that cannot be repeated safely (a toggle, any press of a one-button
 *    gate) is never sent twice: if the answer is lost, the action fails with a
 *    plain message instead of failing over and pressing again.
 *  - The hub gives up on an action after twice the device timeout and then tries
 *    another connection. Every request made during an action is therefore cut to
 *    the time that is left, so the hub never starts a second press while the
 *    first is still under way.
 */
import type { Action, Capability, DeviceKind, FamilyDescriptor, GateState } from '@house/shared'
import { request, sleep, type Response as HttpResponse } from '../lib/http.ts'
import {
  baseUrl,
  clamp,
  FIELD,
  requireHost,
  tcpProbe,
  unsupported,
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type ProbeResult,
} from './types.ts'

/** The device (or the settings) said no. Reported to the owner; never retried on another path. */
class Refused extends Error {}

/** Mark a failure after which the relay may nevertheless have been switched (answer lost, release failed). */
function maybeSent<E extends Error>(err: E): E {
  return Object.assign(err, { maybeSent: true })
}

function wasMaybeSent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { maybeSent?: unknown }).maybeSent === true
}

interface Step {
  method: string
  target: string
  body: string | null
}

interface Runtime {
  /** Last power state this hub commanded or read. */
  power?: boolean
  /** A gate move the hub started and has not yet seen finish. */
  move?: { dir: 'opening' | 'closing'; at: number }
  /** When the one-button relay was last pressed by the hub. */
  pressedAt?: number
  /** The hub's last gate command was a stop. */
  stopped?: boolean
}

const runtimes = new Map<string, Runtime>()

function rt(ctx: AdapterContext): Runtime {
  let r = runtimes.get(ctx.device.id)
  if (!r) {
    r = {}
    runtimes.set(ctx.device.id, r)
  }
  return r
}

/** Test hook: forget what the hub remembers about moves it started. */
export function resetHttpRelayRuntime(): void {
  runtimes.clear()
}

const DEFAULT_PULSE_MS = 800
const DEFAULT_TRAVEL_SEC = 30
/** No request gets less time than this, however little of the action's time is left. */
const MIN_TIMEOUT_MS = 300

/** "/a then /b" — two addresses sent one after the other with the press length in between. */
const THEN = /\s+then\s+(?=(?:(?:GET|POST|PUT)\s+)?(?:\/|https?:\/\/))/i
/** "POST /address text to send" — one address sent differently from the rest. */
const EXPLICIT = /^(GET|POST|PUT)\s+([\s\S]+)$/i
/** Any failure of the secure (TLS) layer, for wording the error. */
const TLS_FAILED = /EPROTO|SSL routines|wrong version number|handshake|ERR_SSL|ERR_TLS/i
/**
 * Transport errors that prove the request never reached the device: no
 * connection at all, or a secure connection that could not be set up (the
 * request is only sent once that is done). Everything else — no answer in
 * time, connection cut, an answer that is not HTTP, an answer cut short —
 * leaves open whether the device acted.
 */
const NOT_DELIVERED = /refused the connection|is not reachable|could not be resolved|EPROTO|wrong version number|handshake failure/i
const NO_ANSWER_IN_TIME = /timed out|did not answer/i

// ---------------------------------------------------------------------------
// Time: an action must be finished before the hub gives up on it
// ---------------------------------------------------------------------------

/** When the action running on this context has to be finished. Only set while execute() runs. */
const deadlines = new WeakMap<AdapterContext, number>()

function timeLeft(ctx: AdapterContext): number {
  const end = deadlines.get(ctx)
  return end === undefined ? Number.POSITIVE_INFINITY : end - Date.now()
}

/** A request timeout: what is wanted, cut to the time the action has left after keeping `reserve` for what follows. */
function within(ctx: AdapterContext, want: number, reserve = 0): number {
  const left = timeLeft(ctx)
  if (left === Number.POSITIVE_INFINITY) return Math.round(want)
  return Math.round(Math.min(want, Math.max(MIN_TIMEOUT_MS, left - reserve)))
}

/** How long the "is it still on the network?" check after a lost answer may take. */
function aliveCheckMs(ctx: AdapterContext): number {
  return clamp(Math.round(ctx.timeoutMs / 4), 250, 1500)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function cfg(ctx: AdapterContext, name: string): string {
  return ctx.str(name).trim()
}

function raw(config: Record<string, unknown>, name: string): string {
  const v = config[name]
  return v === undefined || v === null ? '' : String(v).trim()
}

function pulseMs(ctx: AdapterContext): number {
  return clamp(Math.round(ctx.num('pulseMs', DEFAULT_PULSE_MS)), 100, 5000)
}

function travelMs(ctx: AdapterContext): number {
  return clamp(ctx.num('gateTravelSec', DEFAULT_TRAVEL_SEC), 3, 120) * 1000
}

function hasPowerState(ctx: AdapterContext): boolean {
  return cfg(ctx, 'statePath') !== '' && cfg(ctx, 'stateOnMatch') !== ''
}

function hasGateSensor(ctx: AdapterContext): boolean {
  return cfg(ctx, 'gateStatePath') !== '' && cfg(ctx, 'gateClosedMatch') !== ''
}

function isSeparate(ctx: AdapterContext): boolean {
  return cfg(ctx, 'gateMode') === 'separate'
}

/** The login to use. Shelly and Tasmota devices only ask for a password; their user is always "admin". */
function login(ctx: AdapterContext): { username: string; password: string } {
  const password = ctx.secret('password') ?? ''
  return { username: cfg(ctx, 'username') || (password ? 'admin' : ''), password }
}

/**
 * The port on the connection in use. The hub fills in 80 on every new
 * connection, so with a secure (https) address 80 means "the usual port",
 * which is 443; any other number is the owner's own choice and is kept.
 */
function portOf(ctx: AdapterContext, https: boolean): number {
  const port = ctx.path.port
  if (https) return port && port !== 80 ? port : 443
  return port ?? 80
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Split one settings value into the request(s) it stands for. Status reads default to GET. */
function parseSteps(ctx: AdapterContext, value: string, forRead = false): Step[] {
  const post = !forRead && cfg(ctx, 'method').toUpperCase() === 'POST'
  const defaultMethod = post ? 'POST' : 'GET'
  const defaultBody = post ? cfg(ctx, 'body') : ''
  return value
    .trim()
    .split(THEN)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = EXPLICIT.exec(part)
      if (m) {
        const method = m[1]!.toUpperCase()
        const rest = m[2]!.trim()
        // A plain link carries no text, so everything after GET is the address (spaces and all).
        if (method === 'GET') return { method, target: rest, body: null }
        const cut = rest.search(/\s/)
        const own = cut < 0 ? '' : rest.slice(cut).trim()
        return { method, target: cut < 0 ? rest : rest.slice(0, cut), body: own || defaultBody || null }
      }
      return { method: defaultMethod, target: part, body: defaultBody || null }
    })
}

/** The full URL for one address on the connection in use. Never contains anything but what the owner configured. */
function fillUrl(ctx: AdapterContext, target: string, label: string): string {
  const full = /^https?:\/\//i.test(target)
  // An address written out in full says itself whether it is secure; a short one follows the "Use HTTPS" switch.
  const https = full ? /^https:/i.test(target) : ctx.bool('https', false)
  const host = requireHost(ctx)
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const port = portOf(ctx, https)
  if (full && !target.includes('{host}')) {
    throw new Refused(`The ${label} address is written out in full but has no {host} in it. Put {host} where the device's address goes, so each connection can use its own.`)
  }
  const { username, password } = login(ctx)
  const filled = target
    .split('{host}').join(h)
    .split('{port}').join(String(port))
    .split('{user}').join(encodeURIComponent(username))
    .split('{pass}').join(encodeURIComponent(password))
  const url = full ? filled : baseUrl({ ...ctx, path: { ...ctx.path, port } }, { https }) + (filled.startsWith('/') ? '' : '/') + filled
  try {
    return new URL(url).toString()
  } catch {
    throw new Refused(`The ${label} address is not a usable web address. Check it in the device settings.`)
  }
}

/** Test hook: the full address one settings value turns into on this connection (its first address when it holds two). */
export function addressFor(ctx: AdapterContext, value: string): string {
  const step = parseSteps(ctx, value)[0]
  return step ? fillUrl(ctx, step.target, 'command') : ''
}

function fillBody(ctx: AdapterContext, body: string): string {
  const { username, password } = login(ctx)
  return body
    .split('{host}').join(requireHost(ctx))
    .split('{port}').join(String(portOf(ctx, ctx.bool('https', false))))
    .split('{user}').join(username)
    .split('{pass}').join(password)
}

function contentTypeOf(body: string): string {
  const t = body.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) return 'application/json'
  if (t.includes('=')) return 'application/x-www-form-urlencoded'
  return 'text/plain'
}

/** Host and port a request for this address would go to (for the bare TCP check). */
function endpoint(ctx: AdapterContext, step: Step, label: string): { host: string; port: number } {
  const u = new URL(fillUrl(ctx, step.target, label))
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * One request to the device. `timeoutMs` is what the caller would like; the
 * time actually given is cut to what the running action has left.
 */
async function send(ctx: AdapterContext, step: Step, label: string, timeoutMs = ctx.timeoutMs, reserve = 0): Promise<HttpResponse> {
  const url = fillUrl(ctx, step.target, label)
  const { username, password } = login(ctx)
  const headers: Record<string, string> = {
    // Tiny web servers (ESP boards) drop idle connections without notice; never reuse one for a command.
    Connection: 'close',
    // Tasmota can be set to accept commands only from its own pages; this is what a link on its own page would send.
    Referer: `${new URL(url).origin}/`,
  }
  let body: string | undefined
  if (step.body && step.method !== 'GET') {
    body = fillBody(ctx, step.body)
    headers['Content-Type'] = contentTypeOf(body)
    // Small embedded web servers do not understand chunked uploads; always say how long the text is.
    headers['Content-Length'] = String(Buffer.byteLength(body))
  }
  const opts = () => ({ method: step.method, headers, body, timeoutMs: within(ctx, timeoutMs, reserve), insecure: true })
  // A plain (Basic) login sends the password readably. Fine on the house network or over https; never over the public SIM path in clear.
  const plainOk = ctx.path.kind !== 'cellular' || url.startsWith('https:')
  let res = await request(url, { ...opts(), digest: username ? { username, password, allowBasic: plainOk } : undefined })
  // Some firmwares answer 401 without saying which login scheme they want; they take a plain (basic) login.
  if (res.status === 401 && username && plainOk && !/^(digest|basic)/i.test(res.headers['www-authenticate'] ?? '')) {
    res = await request(url, { ...opts(), basic: { username, password } })
  }
  ctx.log.debug(`${label}: HTTP ${res.status}`)
  return res
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300
}

function refusal(res: HttpResponse, label: string): string {
  const status = res.status
  if (status === 401) return 'Wrong username or password'
  if (status === 404) return `The device has nothing at the ${label} address (HTTP 404). Check that address in the device settings.`
  if (status === 429) {
    return `The device is asking the hub to wait (HTTP 429). This happens after several wrong logins or too many requests. Check the username and password, then try again in a few minutes.`
  }
  if (status >= 300 && status < 400) {
    if (/^https:/i.test(res.headers.location ?? '')) {
      return `The device only accepts a secure connection (HTTP ${status}). Switch on "Use HTTPS" in the device settings.`
    }
    return `The device sent the ${label} request somewhere else (HTTP ${status}). If it expects a secure connection, switch on "Use HTTPS".`
  }
  return `The device answered the ${label} request with an error (HTTP ${status})`
}

/**
 * Some devices say no inside an answer that looks fine from outside (HTTP 200):
 * Sonoff DIY mode {"seq":3,"error":422}, a Shelly RPC frame {"error":{"code":-105,"message":"…"}},
 * Tasmota {"Command":"Unknown"} or {"WARNING":"Enter command cmnd="}.
 * Returns the device's own words for the problem, or null when the answer carries none.
 */
function bodyProblem(text: string): string | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  let json: unknown
  try {
    json = JSON.parse(t)
  } catch {
    return null
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null
  const o = json as Record<string, unknown>
  const e = o.error
  if (typeof e === 'number' && e !== 0) return `error ${e}`
  if (e === true) return 'error'
  if (typeof e === 'string' && e.trim() !== '' && !/^(0|ok|okay|none|no|false|null|success)$/i.test(e.trim())) return e.trim()
  if (e !== null && typeof e === 'object') {
    const inner = e as Record<string, unknown>
    const said = inner.message ?? inner.code
    return said === undefined || said === null || typeof said === 'object' ? 'error' : String(said)
  }
  if (typeof o.WARNING === 'string' && o.WARNING.trim() !== '') return o.WARNING.trim()
  if (o.Command === 'Unknown' || o.Command === 'Error') return `command ${o.Command.toLowerCase()}`
  return null
}

/** The device's own error words, shortened, and with the password taken out in case the device echoed the request. */
function quoteDevice(ctx: AdapterContext, said: string): string {
  let out = said.replace(/\s+/g, ' ')
  const password = ctx.secret('password')
  if (password) out = out.split(password).join('***').split(encodeURIComponent(password)).join('***')
  return out.length > 80 ? `${out.slice(0, 77)}...` : out
}

/** Throws Refused when the device answered, but with a no — as an HTTP status or inside the answer. */
function assertAccepted(ctx: AdapterContext, res: HttpResponse, label: string): void {
  if (!isOk(res.status)) throw new Refused(refusal(res, label))
  const problem = bodyProblem(res.text())
  if (problem) {
    throw new Refused(
      `The device answered the ${label} request but said it could not do it (${quoteDevice(ctx, problem)}). Check the address, and the text sent with it, in the device settings.`,
    )
  }
}

function rawMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A transport error as one plain sentence, with no address details beyond host:port. */
function plain(err: unknown): string {
  const msg = rawMessage(err)
  const m = /^Timed out after (\d+) ms talking to (.+)$/.exec(msg)
  if (m) return `${m[2]} did not answer within ${Math.round(Number(m[1]) / 100) / 10} seconds`
  if (TLS_FAILED.test(msg)) {
    return 'The device did not accept a secure (HTTPS) connection. If its own page opens with http, switch off "Use HTTPS" in the device settings.'
  }
  if (/Parse Error|HPE_/i.test(msg)) {
    return 'The device answered with something that is not a web reply. Check the port on this connection, and whether "Use HTTPS" should be on.'
  }
  if (/^aborted$|socket hang up/i.test(msg)) return 'The device cut the connection before it had finished answering'
  return msg
}

/** Read one status address. Throws Refused for a device-level no, Error for a transport failure. */
async function readText(ctx: AdapterContext, value: string, label: string, timeoutMs = ctx.timeoutMs): Promise<string> {
  const step = parseSteps(ctx, value, true)[0]
  if (!step) throw new Refused(`No ${label} address is set for this device`)
  let res: HttpResponse
  try {
    res = await send(ctx, step, label, timeoutMs)
  } catch (err) {
    if (err instanceof Refused) throw err
    throw new Error(plain(err))
  }
  assertAccepted(ctx, res, label)
  return res.text()
}

/**
 * Send a command. One step is a single request; more steps are "switch on,
 * wait for the press length, switch off" timed by the hub.
 *
 * repeatSafe = sending the whole command twice does no harm (on, off, open,
 * close, stop). When it is not (a toggle, any press of a one-button gate) and
 * the answer is lost while the device is still on the network, the hub must
 * not fail over and press again, so the action fails with Refused instead of
 * a transport error.
 */
async function fire(ctx: AdapterContext, steps: Step[], label: string, repeatSafe: boolean): Promise<void> {
  const first = steps[0]
  if (!first) throw new Refused(`No ${label} address is set for this device`)
  const rest = steps.slice(1)
  const aliveCheck = aliveCheckMs(ctx)
  // Time kept back for what has to follow the first request inside the same action.
  const reserve = rest.length > 0 ? pulseMs(ctx) + 2500 : repeatSafe ? 0 : aliveCheck + 200
  let res: HttpResponse
  try {
    res = await send(ctx, first, label, ctx.timeoutMs, reserve)
  } catch (err) {
    if (err instanceof Refused) throw err
    const message = rawMessage(err)
    if (NOT_DELIVERED.test(message)) throw new Error(plain(err))
    // From here on the request may have reached the device even though its answer did not reach the hub.
    let released = true
    if (rest.length > 0) {
      // The "on" may have arrived: make sure the relay is released.
      for (const step of rest) released = (await releaseOnce(ctx, step, label, Math.min(ctx.timeoutMs, 2000), aliveCheck + 200)) && released
    }
    if (!repeatSafe) {
      const { host, port } = endpoint(ctx, first, label)
      const alive = await tcpProbe(host, port, aliveCheck)
      if (alive.ok) {
        const what = NO_ANSWER_IN_TIME.test(message) ? `The device did not answer the ${label} request in time` : `The device cut the connection while answering the ${label} request`
        const relay = rest.length === 0 ? '' : released ? ' The relay has been told to switch off again.' : ' The relay may still be held on.'
        throw maybeSent(
          new Refused(`${what}, so the hub cannot tell whether it arrived. It was not sent again, to avoid pressing twice.${relay} Check the device before trying again.`),
        )
      }
    }
    throw maybeSent(new Error(plain(err)))
  }
  assertAccepted(ctx, res, label)
  for (const step of rest) {
    await sleep(pulseMs(ctx))
    await release(ctx, step, label)
  }
}

/** One quiet try at switching the relay off again. True when the device accepted it. */
async function releaseOnce(ctx: AdapterContext, step: Step, label: string, timeoutMs: number, reserve: number): Promise<boolean> {
  try {
    const res = await send(ctx, step, label, timeoutMs, reserve)
    return isOk(res.status) && bodyProblem(res.text()) === null
  } catch {
    return false
  }
}

/**
 * The second half of a hub-timed press. Tried up to three times, sharing out
 * the time the action has left: a relay left on holds the gate button down.
 */
async function release(ctx: AdapterContext, step: Step, label: string): Promise<void> {
  const tries = 3
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await sleep(250)
    const left = timeLeft(ctx)
    const share = left === Number.POSITIVE_INFINITY ? ctx.timeoutMs : clamp((left - 250 * (tries - 1 - attempt)) / (tries - attempt), MIN_TIMEOUT_MS, ctx.timeoutMs)
    let res: HttpResponse
    try {
      res = await send(ctx, step, label, share)
    } catch (err) {
      if (err instanceof Refused) throw err
      continue
    }
    if (isOk(res.status) && bodyProblem(res.text()) === null) return
    throw maybeSent(
      new Refused(
        `The relay was switched on for the ${label}, but the device would not switch it off again (${isOk(res.status) ? 'it answered with an error' : `HTTP ${res.status}`}). It may still be held on — check the device.`,
      ),
    )
  }
  // A transport failure: the hub may fail over and run the press again on another connection, which also releases the relay.
  throw maybeSent(
    new Error(`The relay was switched on for the ${label}, but the device stopped answering before it could be switched off again. It may still be held on — check the device.`),
  )
}

// ---------------------------------------------------------------------------
// Reading status answers
// ---------------------------------------------------------------------------

/**
 * Does a status answer match the owner's rule?
 *  - /pattern/flags       a regular expression tested against the whole answer
 *  - a.b[0].c=value       a named value in a JSON answer (compared ignoring case; numbers by value)
 *  - anything else        plain text the answer contains (ignoring case)
 */
export function matchesRule(text: string, ruleRaw: string): boolean {
  const rule = ruleRaw.trim()
  if (!rule) return false
  const re = /^\/(.+)\/([a-z]*)$/s.exec(rule)
  if (re) {
    let compiled: RegExp
    try {
      compiled = new RegExp(re[1]!, re[2])
    } catch {
      throw new Refused(`"${rule}" is not a valid pattern. Check it in the device settings.`)
    }
    return compiled.test(text)
  }
  const eq = /^([\w$-]+(?:\.[\w$-]+|\[\d+\])*)\s*=\s*(.*)$/s.exec(rule)
  if (eq) {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    if (json !== null && typeof json === 'object') {
      let cur: unknown = json
      for (const key of eq[1]!.split(/[.[\]]+/).filter(Boolean)) {
        if (cur === null || typeof cur !== 'object') return false
        cur = (cur as Record<string, unknown>)[key]
      }
      if (cur === undefined || cur === null || typeof cur === 'object') return false
      const want = eq[2]!.trim().replace(/^(["'])(.*)\1$/, '$2')
      const got = String(cur)
      return got.toLowerCase() === want.toLowerCase() || (want !== '' && got !== '' && Number(got) === Number(want))
    }
  }
  return text.toLowerCase().includes(rule.toLowerCase())
}

async function readPower(ctx: AdapterContext, timeoutMs = ctx.timeoutMs): Promise<boolean> {
  const text = await readText(ctx, cfg(ctx, 'statePath'), 'status', timeoutMs)
  return matchesRule(text, cfg(ctx, 'stateOnMatch'))
}

async function readClosed(ctx: AdapterContext, timeoutMs = ctx.timeoutMs): Promise<boolean> {
  const text = await readText(ctx, cfg(ctx, 'gateStatePath'), 'gate sensor', timeoutMs)
  return matchesRule(text, cfg(ctx, 'gateClosedMatch'))
}

/**
 * Gate state from a single "closed" sensor plus what the hub itself started.
 * Closed is what the sensor says; anything else is open — except that a move
 * the hub started counts as opening / closing until the sensor changes or the
 * travel time runs out.
 */
function gateFromSensor(ctx: AdapterContext, closed: boolean): GateState {
  const r = rt(ctx)
  if (r.move) {
    const moving = Date.now() - r.move.at < travelMs(ctx)
    if (moving && r.move.dir === 'opening' && closed) return 'opening'
    if (moving && r.move.dir === 'closing' && !closed) return 'closing'
    r.move = undefined
  }
  if (closed) {
    r.stopped = false
    return 'closed'
  }
  return r.stopped ? 'stopped' : 'open'
}

/** No sensor: only what the hub itself commanded, and only where the direction is certain. */
function gateWithoutSensor(ctx: AdapterContext): Record<string, unknown> {
  const r = runtimes.get(ctx.device.id)
  if (!r) return {}
  if (r.stopped) return { gate: 'stopped', gateAssumed: false }
  if (!r.move) return {}
  if (Date.now() - r.move.at < travelMs(ctx)) return { gate: r.move.dir, gateAssumed: false }
  return { gate: r.move.dir === 'opening' ? 'open' : 'closed', gateAssumed: true }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function powerAction(ctx: AdapterContext, action: Action): Promise<ActionResult> {
  const r = rt(ctx)
  let target: boolean
  if (action.type === 'power.toggle') {
    const toggle = cfg(ctx, 'togglePath')
    if (toggle) {
      await fire(ctx, parseSteps(ctx, toggle), 'toggle', false)
      let power: boolean | undefined = r.power === undefined ? undefined : !r.power
      // Read back what it became — briefly, and only if the action has time left: the toggle is done,
      // and a slow status read must never make the hub give up and toggle again on another connection.
      if (hasPowerState(ctx) && timeLeft(ctx) > 2 * MIN_TIMEOUT_MS) {
        try {
          power = await readPower(ctx, Math.min(ctx.timeoutMs, 2000))
        } catch {
          // The toggle itself went through; keep the estimate.
        }
      }
      r.power = power
      if (power === undefined) {
        return { ok: true, result: { note: 'Toggled. Without a status address the hub cannot tell whether it is now on or off.' } }
      }
      return { ok: true, state: { power } }
    }
    if (!hasPowerState(ctx)) {
      return {
        ok: false,
        error: 'This device has no toggle address and no status address, so the hub cannot tell whether to switch it on or off. Use On or Off instead.',
      }
    }
    target = !(await readPower(ctx))
  } else {
    target = action.type === 'power.on'
  }
  await fire(ctx, parseSteps(ctx, cfg(ctx, target ? 'onPath' : 'offPath')), target ? 'switch-on' : 'switch-off', true)
  r.power = target
  return { ok: true, state: { power: target } }
}

/**
 * One press of the one-button gate: the device's own pulse if it has one, else
 * on → wait → off timed by the hub. Never repeat-safe: a second press stops or
 * reverses the gate, however the press is timed.
 */
async function press(ctx: AdapterContext): Promise<void> {
  const pulse = cfg(ctx, 'pulsePath')
  if (pulse) return fire(ctx, parseSteps(ctx, pulse), 'pulse', false)
  const on = cfg(ctx, 'onPath')
  const off = cfg(ctx, 'offPath')
  if (!on || !off) {
    throw new Refused('This gate needs either a pulse address, or both an on and an off address so the hub can time the press itself. Add them in the device settings.')
  }
  return fire(ctx, [...parseSteps(ctx, on), ...parseSteps(ctx, off)], 'pulse', false)
}

const NO_SENSOR_NOTE = 'Command sent. There is no gate sensor, so the hub cannot see the gate move.'

async function gateSeparate(ctx: AdapterContext, action: Action): Promise<ActionResult> {
  const r = rt(ctx)
  const sensor = hasGateSensor(ctx)
  let type = action.type

  if (type === 'gate.stop') {
    if (!cfg(ctx, 'stopPath')) return { ok: false, error: 'No stop address is set for this gate' }
    await fire(ctx, parseSteps(ctx, cfg(ctx, 'stopPath')), 'gate stop', true)
    r.move = undefined
    r.stopped = true
    return { ok: true, state: { gate: 'stopped' } }
  }
  if (type === 'gate.pulse') {
    if (!sensor) {
      return { ok: false, error: 'This gate has separate open and close addresses and no sensor, so there is no single button to press. Use Open or Close.' }
    }
    type = (await readClosed(ctx)) ? 'gate.open' : 'gate.close'
  }
  const opening = type === 'gate.open'
  const value = cfg(ctx, opening ? 'openPath' : 'closePath')
  if (!value) return { ok: false, error: `No ${opening ? 'open' : 'close'} address is set for this gate` }
  await fire(ctx, parseSteps(ctx, value), opening ? 'gate open' : 'gate close', true)
  const dir = opening ? 'opening' : 'closing'
  r.move = { dir, at: Date.now() }
  r.stopped = false
  return sensor ? { ok: true, state: { gate: dir } } : { ok: true, state: { gate: dir }, result: { note: NO_SENSOR_NOTE } }
}

async function gateOneButton(ctx: AdapterContext, action: Action): Promise<ActionResult> {
  const r = rt(ctx)
  const type = action.type

  if (type === 'gate.stop') {
    // A press only stops a gate that is moving; on a gate at rest it would start it. Press only while a move the hub started can still be under way.
    const underWay = r.pressedAt !== undefined && Date.now() - r.pressedAt < travelMs(ctx)
    if (!underWay) {
      return {
        ok: false,
        error:
          'The button was not pressed: the hub has not started this gate moving just now, and with one button a press on a gate at rest would start it moving. Use the single press (pulse) if you do want to press the button.',
      }
    }
    await press(ctx)
    r.pressedAt = undefined
    r.move = undefined
    r.stopped = true
    return { ok: true, state: { gate: 'stopped' } }
  }

  let closed: boolean | null = null
  if (hasGateSensor(ctx)) {
    try {
      // Kept short, so the press that follows still fits inside the time the hub allows for the action.
      closed = await readClosed(ctx, Math.max(MIN_TIMEOUT_MS, ctx.timeoutMs / 3))
    } catch (err) {
      if (!(err instanceof Refused)) throw err
      // Open and Close decide from the sensor; a plain press does not need it.
      if (type !== 'gate.pulse') throw new Refused(`The button was not pressed because the gate sensor could not be read. ${err.message}`)
    }
  }
  if (type === 'gate.open' && closed === false) {
    return {
      ok: true,
      state: { gate: gateFromSensor(ctx, false) },
      result: { alreadyThere: true, note: 'The sensor shows the gate is not closed, so the button was not pressed.' },
    }
  }
  if (type === 'gate.close' && closed === true) {
    return {
      ok: true,
      state: { gate: gateFromSensor(ctx, true) },
      result: { alreadyThere: true, note: 'The sensor shows the gate is already closed, so the button was not pressed.' },
    }
  }

  try {
    await press(ctx)
  } catch (err) {
    // The press may have gone through even though it could not be confirmed: remember it, so Stop still works.
    if (wasMaybeSent(err)) {
      r.pressedAt = Date.now()
      r.stopped = false
      r.move = undefined
    }
    throw err
  }
  r.pressedAt = Date.now()
  r.stopped = false
  if (closed === null) {
    r.move = undefined
    return { ok: true, state: { gate: 'unknown' }, result: { note: 'Button pressed. Without a gate sensor the hub cannot see which way the gate moved.' } }
  }
  r.move = { dir: closed ? 'opening' : 'closing', at: Date.now() }
  return { ok: true, state: { gate: r.move.dir } }
}

async function rebootAction(ctx: AdapterContext, action: Action): Promise<ActionResult> {
  const value = cfg(ctx, 'rebootPath')
  if (!value) return unsupported(action)
  try {
    await fire(ctx, parseSteps(ctx, value), 'restart', true)
  } catch (err) {
    // A device that restarts at once often drops the connection before answering.
    if (err instanceof Refused || !/closed the connection|cut the connection/.test(rawMessage(err))) throw err
  }
  return { ok: true, result: { note: 'Restart requested. The device will be away for a short while.' } }
}

/** The first command address configured, used only to learn which port to check. */
function firstCommandStep(ctx: AdapterContext): Step {
  const names =
    ctx.device.kind === 'gate'
      ? isSeparate(ctx)
        ? ['openPath', 'closePath', 'stopPath']
        : ['pulsePath', 'onPath', 'offPath']
      : ['onPath', 'offPath', 'togglePath']
  for (const name of [...names, 'rebootPath']) {
    const step = parseSteps(ctx, cfg(ctx, name))[0]
    if (step) return step
  }
  return { method: 'GET', target: '/', body: null }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const adapter: Adapter = {
  family: 'http-relay',

  describe(): FamilyDescriptor {
    return {
      id: 'http-relay',
      label: 'Relay with web addresses (HTTP)',
      tagline: 'Relay boards and home-made WiFi switches that are controlled by simple web addresses.',
      kinds: ['light', 'switch', 'gate'],
      fields: [
        {
          name: 'onPath',
          label: 'Address that switches it on',
          type: 'text',
          help: 'Written from the first slash, for example /relay/1/on. The hub puts the device’s own address in front, so the same setting works on every connection.',
        },
        { name: 'offPath', label: 'Address that switches it off', type: 'text', help: 'For example /relay/1/off.' },
        {
          name: 'togglePath',
          label: 'Address that flips it (optional)',
          type: 'text',
          help: 'Only if the device has one, for example /relay/1/toggle. Without it, Toggle reads the status first and then switches on or off.',
        },
        {
          name: 'statePath',
          label: 'Status address (optional)',
          type: 'text',
          help: 'An address that only reports whether the relay is on, for example /relay/1/status. The hub reads it often, so it must never switch anything. Without it the hub can only check that the device is on the network.',
        },
        {
          name: 'stateOnMatch',
          label: 'Reads as on when',
          type: 'text',
          help: 'What the status answer contains when the relay is on. Three ways to write it: plain text such as ON; a named value in a structured (JSON) answer such as POWER=ON or relays.0.ison=true; or a pattern between slashes such as /"output":\\s*true/.',
        },
        {
          name: 'method',
          label: 'How commands are sent',
          type: 'select',
          default: 'GET',
          options: [
            { value: 'GET', label: 'Plain link (GET) — the usual way' },
            { value: 'POST', label: 'Posted form (POST)' },
          ],
          help: 'Most relay boards use a plain link. Status addresses are read as a plain link either way, unless the address itself starts with POST.',
        },
        {
          name: 'body',
          label: 'Text sent with each command',
          type: 'textarea',
          showWhen: { field: 'method', equals: 'POST' },
          help: 'Only if the device expects something inside the request, for example {"state":"on"}. Leave empty otherwise.',
        },
        {
          name: 'username',
          label: 'Username (optional)',
          type: 'text',
          help: 'Only if the device asks for a login. If you fill in a password and leave this empty, the hub logs in as admin, which is what Shelly and Tasmota devices expect.',
        },
        { name: 'password', label: 'Password (optional)', type: 'password', secret: true, help: 'Stored encrypted on the hub.' },
        {
          ...FIELD.https(),
          help: 'Switch on if the device’s own page opens with https. The hub then uses port 443 unless you set a different port on the connection. The device’s own certificate is accepted as it is.',
        },
        {
          name: 'gateMode',
          label: 'Gate: how the relay is wired',
          type: 'select',
          default: 'button',
          options: [
            { value: 'button', label: 'One button — each press steps open, stop, close' },
            { value: 'separate', label: 'Separate open, close and stop' },
          ],
          help: 'Only for gates and garage doors.',
        },
        {
          name: 'pulsePath',
          label: 'Gate: address that presses the button briefly (optional)',
          type: 'text',
          showWhen: { field: 'gateMode', equals: 'button' },
          help: 'An address that makes the device switch the relay on and off again by itself, for example /relay/0?turn=on&timer=1. If left empty, the hub uses the on address, waits for the press length, then uses the off address.',
        },
        {
          name: 'openPath',
          label: 'Gate: address that opens it',
          type: 'text',
          showWhen: { field: 'gateMode', equals: 'separate' },
          help: 'For example /relay/1/pulse. If the relay stays on until told otherwise, write both addresses with the word then between them: /relay/1/on then /relay/1/off.',
        },
        { name: 'closePath', label: 'Gate: address that closes it', type: 'text', showWhen: { field: 'gateMode', equals: 'separate' }, help: 'Written the same way as the open address.' },
        {
          name: 'stopPath',
          label: 'Gate: address that stops it (optional)',
          type: 'text',
          showWhen: { field: 'gateMode', equals: 'separate' },
          help: 'Without it the Stop button is refused.',
        },
        {
          name: 'pulseMs',
          label: 'Gate: press length (milliseconds)',
          type: 'number',
          default: DEFAULT_PULSE_MS,
          help: 'How long the hub holds the relay on when it times the press itself. 800 suits most gate boards; allowed range 100 to 5000.',
        },
        {
          name: 'gateStatePath',
          label: 'Gate: sensor address (optional)',
          type: 'text',
          help: 'An address that reports the gate’s position sensor, for example /input/1. It is only read, never switched.',
        },
        {
          name: 'gateClosedMatch',
          label: 'Gate: sensor reads as closed when',
          type: 'text',
          help: 'Written the same way as “Reads as on when”, for example state=true. With the sensor address and this filled in, the app shows whether the gate is open or closed.',
        },
        {
          name: 'gateTravelSec',
          label: 'Gate: seconds to open or close fully',
          type: 'number',
          default: DEFAULT_TRAVEL_SEC,
          help: 'A rough figure is enough. The hub uses it to tell when a move it started should have finished.',
        },
        { name: 'rebootPath', label: 'Restart address (optional)', type: 'text', help: 'Only if the device has one, for example /reboot. Adds a Restart button.' },
      ],
      pathKinds: ['lan', 'cellular'],
      defaultPort: 80,
      capabilities: ['power', 'gate', 'gate-state', 'state', 'reboot'],
      notes: [
        'For a light or switch, fill in the on and off addresses. For a gate or garage door, choose how the relay is wired and fill in the gate addresses. You will find the addresses in the board’s manual or on its own web page.',
        'Shelly and Tasmota devices have their own entries in the list of device types. Prefer those: they already know the device’s addresses and can also move it to another WiFi. Use this entry for other relay boards.',
        'If the device listens on a port other than 80, set that port on each connection (Sonoff devices in DIY mode use 8081). An address can also be written out in full with {host} where the device’s address goes, for example http://{host}:8081/zeroconf/switch. {port}, {user} and {pass} are filled in the same way, so a password never has to be typed into an address.',
        'One address can be sent differently from the rest by starting it with GET or POST and, after a space, the text to send. For a Sonoff in DIY mode: POST /zeroconf/switch {"deviceid":"1000xxxxxx","data":{"switch":"on"}}, with the device’s own ID in place of 1000xxxxxx. In such an address, write any space as %20.',
        'A command counts as done when the device answers without an error. The hub also reads the usual error replies inside an answer (for example an error number from a Sonoff, or “Command Unknown” from Tasmota) and reports them. It cannot see whether the lamp or the gate really reacted unless a status or sensor address is set.',
        'Without a status address the hub can only check that the device is on the network. It cannot show whether the relay is on, and Toggle then needs a toggle address.',
        'A gate relay only presses the button. Without a gate sensor the hub cannot see whether the gate really moved, and with one button it cannot know which way it will go.',
        'With one button, Stop only presses while a move the hub itself started can still be under way, because a press on a gate at rest would start it moving.',
        'When the hub times the press itself and the device drops off the network at the wrong moment, the relay can stay on. Where the device can pulse by itself, use its pulse address instead.',
        'If the answer to a toggle or to a press of a one-button gate is lost, the hub does not send it again, so the gate is never pressed twice by mistake. Check the device and try again.',
        'If the device answers with a redirect to https, switch on “Use HTTPS”. Newer Shelly firmware does this.',
        'The SIM connection only works when the SIM has a public address and the port is opened to the device. Plain http is not private, so prefer the house WiFi connections.',
        'These devices cannot be moved to another WiFi from here; use the device’s own setup page for that.',
      ],
    }
  },

  capabilities(config: Record<string, unknown>, kind: DeviceKind): Capability[] {
    const caps: Capability[] = []
    if (kind === 'gate') {
      caps.push('gate')
      if (raw(config, 'gateStatePath') && raw(config, 'gateClosedMatch')) caps.push('gate-state', 'state')
    } else {
      caps.push('power')
      if (raw(config, 'statePath') && raw(config, 'stateOnMatch')) caps.push('state')
    }
    if (raw(config, 'rebootPath')) caps.push('reboot')
    return caps
  },

  /** Reads the status address when there is one; otherwise only checks that the port answers. Never switches anything. */
  async probe(ctx): Promise<ProbeResult> {
    const started = Date.now()
    try {
      const gate = ctx.device.kind === 'gate'
      const sensorPath = cfg(ctx, 'gateStatePath')
      const status = gate ? sensorPath || cfg(ctx, 'statePath') : cfg(ctx, 'statePath')
      const step = parseSteps(ctx, status, true)[0]
      if (!step) {
        const { host, port } = endpoint(ctx, firstCommandStep(ctx), 'command')
        return await tcpProbe(host, port, ctx.timeoutMs)
      }
      const label = gate && sensorPath ? 'gate sensor' : 'status'
      const res = await send(ctx, step, label)
      if (!isOk(res.status)) return { ok: false, latencyMs: null, error: refusal(res, label) }
      const latencyMs = Date.now() - started
      const text = res.text()
      const info: Record<string, unknown> = {}
      // The device answered, so this connection works. What the answer means is a separate matter:
      // an answer that carries an error, or a rule that cannot be read, must not mark the device as unreachable.
      const problem = bodyProblem(text)
      if (problem) {
        ctx.log.warn(`${label}: the device answered but reported a problem (${quoteDevice(ctx, problem)})`)
        return { ok: true, latencyMs, info }
      }
      try {
        if (gate) {
          if (sensorPath && cfg(ctx, 'gateClosedMatch')) info.gate = gateFromSensor(ctx, matchesRule(text, cfg(ctx, 'gateClosedMatch')))
        } else if (cfg(ctx, 'stateOnMatch')) {
          info.power = matchesRule(text, cfg(ctx, 'stateOnMatch'))
        }
      } catch (err) {
        if (!(err instanceof Refused)) throw err
        ctx.log.warn(`${label}: ${err.message}`)
      }
      return { ok: true, latencyMs, info }
    } catch (err) {
      return { ok: false, latencyMs: null, error: plain(err) }
    }
  },

  /** Only ever reads the status addresses. */
  async readState(ctx): Promise<Record<string, unknown>> {
    if (ctx.device.kind === 'gate') {
      if (!hasGateSensor(ctx)) return gateWithoutSensor(ctx)
      return { gate: gateFromSensor(ctx, await readClosed(ctx)) }
    }
    if (!hasPowerState(ctx)) return {}
    const power = await readPower(ctx)
    rt(ctx).power = power
    return { power }
  },

  async execute(ctx, action: Action): Promise<ActionResult> {
    const gate = ctx.device.kind === 'gate'
    // The hub waits twice the device timeout for an action, then tries another connection. Stay inside that.
    deadlines.set(ctx, Date.now() + ctx.timeoutMs * 2 - Math.min(400, ctx.timeoutMs / 4))
    try {
      switch (action.type) {
        case 'power.on':
        case 'power.off':
        case 'power.toggle':
          return gate ? unsupported(action) : await powerAction(ctx, action)
        case 'gate.open':
        case 'gate.close':
        case 'gate.stop':
        case 'gate.pulse':
          if (!gate) return unsupported(action)
          return isSeparate(ctx) ? await gateSeparate(ctx, action) : await gateOneButton(ctx, action)
        case 'reboot':
          return await rebootAction(ctx, action)
        default:
          return unsupported(action)
      }
    } catch (err) {
      // A device-level no is an answer; anything else is a transport failure and goes up so the hub can fail over.
      if (err instanceof Refused) return { ok: false, error: err.message }
      throw err
    } finally {
      deadlines.delete(ctx)
    }
  },
}

export default adapter
