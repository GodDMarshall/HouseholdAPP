/**
 * TP-Link Tapo camera — C2xx / C5xx models, and the 4G models while they are on
 * a network cable.
 *
 * What a third party can really do with a Tapo on the house network
 * (docs/protocols/tapo-ezviz-v380.md):
 *
 *  - Video: RTSP on port 554, /stream1 (sharp) and /stream2 (light), with the
 *    "Camera Account" made in the Tapo app. TP-Link documents these two
 *    addresses, so streamSources() answers at once without asking the camera.
 *  - Everything else goes over ONVIF on port 2020 with the same Camera Account,
 *    through the reusable client in onvif.ts: WS-Security PasswordDigest on the
 *    camera's own clock, service addresses read from the camera (a Tapo serves
 *    media and movement on one /onvif/service address) with only their path
 *    used. That gives identity (model, firmware, serial, MAC), turning, saved
 *    positions, restart, and a still picture on models that hand one out.
 *  - WiFi cannot be changed by anything except a reset and a new set-up in the
 *    Tapo app (TP-Link's own statement), and a Tapo does not answer the ONVIF
 *    WiFi calls. So there is no setWifi / scanWifi here, the 'wifi' capability
 *    is never claimed, and the WiFi calls are never even sent.
 *  - The camera's HTTPS API on port 443 is deliberately not used: on current
 *    firmware it needs the TP-Link account password and a pairing handshake, and
 *    a few failed tries lock the owner's Tapo app out of the camera as well.
 *  - Optional: when the TP-Link account password is filled in, go2rtc is also
 *    given its tapo:// source (the Tapo app's own video port, 8800) as a last
 *    resort after the two RTSP addresses.
 *
 * Ports: the ONVIF port is the connection's own port when one is typed in, else
 * the `onvifPort` setting (2020). The video port is `rtspPort` in the
 * connection's extras when present, else the `rtspPort` setting (554).
 *
 * A refused login is not tried again for five minutes unless the password is
 * changed here, so the hub's regular checks cannot lock the Camera Account.
 * Only the identity call (GetDeviceInformation, which every valid login may
 * make) decides that a login is wrong. When the camera answers one command with
 * "not authorised" (a restart, a move, the picture address), the identity call
 * is asked once: if it still works, the login is fine and only that command is
 * off limits, so the camera is not taken offline over it.
 *
 * A move never runs open-ended: the camera is given a time limit and the hub
 * arms its own Stop for the same moment, because the "stop" the app sends when
 * the button is let go can get lost on the way.
 */
import crypto from 'node:crypto'
import type { Action, Capability, DeviceKind, FamilyDescriptor } from '@house/shared'
import { onvifClient, OnvifError, type OnvifClient, type OnvifClientOptions, type OnvifDeviceInformation, type OnvifPreset, type OnvifProfile } from './onvif.ts'
import { clamp, requireHost, unsupported, userInfo, type ActionResult, type Adapter, type AdapterContext, type ProbeResult, type Snapshot } from './types.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ONVIF_PORT = 2020
const DEFAULT_RTSP_PORT = 554

/** After a refused login, how long before the same password is tried again. */
const AUTH_RETRY_MS = 5 * 60_000
const INFO_TTL_MS = 5 * 60_000
const NETWORK_TTL_MS = 10 * 60_000
const PRESETS_TTL_MS = 60_000
/** A model that hands out no still picture is not asked again for this long. */
const NO_STILLS_TTL_MS = 10 * 60_000
const MAX_PRESETS = 32
const MAX_MOVE_SECONDS = 60
/** How long a move may run when the app gives no limit. */
const DEFAULT_MOVE_SECONDS = 30

const WRONG_LOGIN = 'Wrong username or password. Use the Camera Account made in the Tapo app, not your TP-Link email and password'
const NEEDS_ACCOUNT = 'Enter the Camera Account username and password. You make them in the Tapo app: open the camera, tap the gear icon, then Advanced Settings > Camera Account'
const NOT_A_TAPO =
  'Something answered at this address, but not the way a Tapo camera does. Check the address and the control port (a Tapo uses 2020), and that Third-Party Compatibility is switched on in the Tapo app'
const SWITCHED_OFF_HINT =
  'If this is the camera’s address, open the Tapo app and check that Third-Party Compatibility is switched on (Me > Third-Party Compatibility) and that a Camera Account has been made. The camera only answers the hub once both are done'
const PTZ_OFF = 'Turning is switched off for this camera. Switch on "Camera can turn" in its settings.'
const NO_MOVEMENT = 'This Tapo model has no movement controls. Switch off "Camera can turn" in its settings.'
const NO_STILLS = 'This Tapo camera does not hand out still pictures by itself. The hub takes them from its live video instead, which needs the video service running on the hub.'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function flag(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
}

function validPort(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

function bracket(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function plain(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A velocity as the app sends it: -1..1, anything unreadable = 0. */
function axis(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? Number(clamp(n, -1, 1).toFixed(3)) : 0
}

function onvifPortOf(ctx: AdapterContext): number {
  return validPort(ctx.path.port) ?? validPort(ctx.num('onvifPort', DEFAULT_ONVIF_PORT)) ?? DEFAULT_ONVIF_PORT
}

/** A connection may carry its own video port (extra.rtspPort) when a router forwards a different one. */
function rtspPortOf(ctx: AdapterContext): number {
  return validPort(ctx.path.extra?.rtspPort) ?? validPort(ctx.num('rtspPort', DEFAULT_RTSP_PORT)) ?? DEFAULT_RTSP_PORT
}

function optionsFor(ctx: AdapterContext): OnvifClientOptions {
  return {
    host: requireHost(ctx),
    port: onvifPortOf(ctx),
    username: ctx.str('username').trim(),
    password: ctx.secret('password') ?? '',
    timeoutMs: ctx.timeoutMs,
  }
}

// ---------------------------------------------------------------------------
// Per-camera memory (never holds the password)
// ---------------------------------------------------------------------------

interface Memory {
  /** Saved-position label shown in the app -> the camera's preset token. */
  presetLabels: Map<string, string>
  stopTimer: NodeJS.Timeout | null
  /** The camera does not report where it is pointing; do not keep asking. */
  noStatus: boolean
  /** The camera hands out no still picture; not asked again before this time. */
  noStillsUntil: number
  /** The camera faulted on a move with a time limit and took the same move without one. */
  noMoveLimit: boolean
  /** The camera refused this login; `fp` is a salted fingerprint, not the password. */
  refused: { fp: string; until: number } | null
}

const memories = new Map<string, Memory>()

function memoryFor(o: OnvifClientOptions): Memory {
  const key = `${o.host.toLowerCase()}|${o.port}|${o.username}`
  let m = memories.get(key)
  if (!m) {
    m = { presetLabels: new Map(), stopTimer: null, noStatus: false, noStillsUntil: 0, noMoveLimit: false, refused: null }
    memories.set(key, m)
  }
  return m
}

const FINGERPRINT_SALT = crypto.randomBytes(16)

/** Lets the hub notice that the login was changed without keeping the password around. */
function fingerprint(username: string, password: string): string {
  return crypto.createHmac('sha256', FINGERPRINT_SALT).update(`${username}\0${password}`).digest('hex')
}

/** Test hook: forget every Tapo camera and cancel pending auto-stops. (The ONVIF client has its own: resetOnvifSessions.) */
export function resetTapoSessions(): void {
  for (const m of memories.values()) if (m.stopTimer) clearTimeout(m.stopTimer)
  memories.clear()
}

interface Cam {
  client: OnvifClient
  mem: Memory
  fp: string
  hasLogin: boolean
}

function open(ctx: AdapterContext): Cam {
  const o = optionsFor(ctx)
  return { client: onvifClient(o), mem: memoryFor(o), fp: fingerprint(o.username, o.password), hasLogin: o.username !== '' && o.password !== '' }
}

/** The sentence to show while a refused login is being held back, or null when the login may be tried. */
function heldBack(cam: Cam): string | null {
  if (!cam.hasLogin) return `${NEEDS_ACCOUNT}.`
  const r = cam.mem.refused
  if (!r || r.fp !== cam.fp || Date.now() >= r.until) return null
  const minutes = Math.max(1, Math.ceil((r.until - Date.now()) / 60_000))
  return `${WRONG_LOGIN}. The hub tries this login again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, so the camera does not lock it out; a changed password is tried at once.`
}

function noteRefused(cam: Cam): void {
  cam.mem.refused = { fp: cam.fp, until: Date.now() + AUTH_RETRY_MS }
}

function clearStop(m: Memory): void {
  if (m.stopTimer) clearTimeout(m.stopTimer)
  m.stopTimer = null
}

/** Main = sharpest picture, ptz = the profile to steer. */
function pickProfiles(profiles: OnvifProfile[]): { main: OnvifProfile | null; ptz: OnvifProfile | null } {
  if (profiles.length === 0) return { main: null, ptz: null }
  const area = (p: OnvifProfile) => p.width * p.height
  let main = profiles[0]!
  for (const p of profiles) if (area(p) > area(main)) main = p
  const ptz = main.ptz ? main : profiles.find((p) => p.ptz) ?? main
  return { main, ptz }
}

/** Unnamed slots come back as "Preset 1", "preset_002"…: show just the number. */
function presetLabel(p: OnvifPreset): string {
  const numbered = /^preset[\s_-]*0*(\d+)$/i.exec(p.name)
  if (numbered) return numbered[1]!
  return p.name || p.token
}

function rememberPresets(m: Memory, presets: OnvifPreset[]): string[] {
  m.presetLabels.clear()
  const labels: string[] = []
  for (const p of presets) {
    const label = presetLabel(p)
    if (m.presetLabels.has(label)) continue
    m.presetLabels.set(label, p.token)
    if (labels.length < MAX_PRESETS) labels.push(label)
  }
  return labels
}

function infoState(info: OnvifDeviceInformation): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (info.model) out.model = info.model
  if (info.firmware) out.firmware = info.firmware
  if (info.serial) out.serial = info.serial
  if (info.hardwareId) out.hardwareId = info.hardwareId
  return out
}

/** Camera could not be reached -> one plain sentence, with what to check on a Tapo. */
function unreachable(err: unknown): string {
  const message = plain(err)
  return /refused the connection/i.test(message) ? `${message}. ${SWITCHED_OFF_HINT}` : message
}

/**
 * The camera answered one call with "not authorised". Is the login itself wrong, or is it only
 * that call the Camera Account may not make? The identity call settles it: every valid login
 * may make it. Returns true when the login still stands. A camera that cannot be reached throws.
 */
async function loginStands(cam: Cam): Promise<boolean> {
  try {
    await cam.client.getDeviceInformation()
    cam.mem.refused = null
    return true
  } catch (err) {
    if (!(err instanceof OnvifError)) throw err
    if (err.kind !== 'auth') return true
    noteRefused(cam)
    return false
  }
}

/** Device-level refusal -> a sentence for the owner. Anything else (camera not reachable) is thrown on. */
async function refusal(cam: Cam, err: unknown, doing: string): Promise<ActionResult> {
  if (!(err instanceof OnvifError)) throw err
  switch (err.kind) {
    case 'auth':
      // Do not brand the login as wrong (which holds every call back for five minutes and shows
      // the camera as unreachable) because of one command the account is not allowed to give.
      if (await loginStands(cam)) return { ok: false, error: `This Tapo model does not allow ${doing} from the hub. Use the Tapo app for that.` }
      return { ok: false, error: `${WRONG_LOGIN}.` }
    case 'unsupported':
      return { ok: false, error: /movement/i.test(err.message) ? NO_MOVEMENT : err.message }
    case 'protocol':
      // The camera passed the connection check, so this is one command it answered badly.
      return { ok: false, error: `The camera gave an answer the hub could not read when it tried ${doing}. Try again. If it keeps happening, use the Tapo app for that.` }
    case 'fault':
      if (err.is(/ActionNotSupported|NotSupported|NoPTZProfile|not\s+supported|not\s+implemented/i)) {
        return { ok: false, error: `This Tapo model does not allow ${doing} from the hub. Use the Tapo app for that.` }
      }
      return { ok: false, error: `The camera refused ${doing}: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const adapter: Adapter = {
  family: 'tapo',

  describe(): FamilyDescriptor {
    return {
      id: 'tapo',
      label: 'TP-Link Tapo camera',
      tagline: 'Tapo C200, C210, C500, C510 and similar. Live video, pictures, turning and saved positions on the house network.',
      kinds: ['camera'],
      fields: [
        {
          name: 'username',
          label: 'Camera Account username',
          type: 'text',
          required: true,
          help: 'The username of the Camera Account. You make it in the Tapo app: open the camera, tap the gear icon, then Advanced Settings > Camera Account. It is not your TP-Link email.',
        },
        {
          name: 'password',
          label: 'Camera Account password',
          type: 'password',
          secret: true,
          required: true,
          help: 'The password of that Camera Account (6 to 32 characters). Stored encrypted on the hub.',
        },
        {
          name: 'onvifPort',
          label: 'Control port',
          type: 'number',
          default: DEFAULT_ONVIF_PORT,
          help: 'The port the camera takes commands on (ONVIF, the common language of network cameras). A Tapo uses 2020: leave it as it is. If one connection needs a different port, type it into that connection’s own port box instead.',
        },
        {
          name: 'rtspPort',
          label: 'Video port',
          type: 'number',
          default: DEFAULT_RTSP_PORT,
          help: 'The port the camera sends live video on (RTSP, the usual way cameras send video). A Tapo uses 554: leave it as it is.',
        },
        {
          name: 'ptz',
          label: 'Camera can turn',
          type: 'toggle',
          default: true,
          help: 'Shows the arrows and the saved positions. Switch off for a fixed Tapo that cannot turn.',
        },
        {
          name: 'cloudPassword',
          label: 'TP-Link account password (optional)',
          type: 'password',
          secret: true,
          help: 'Normally leave this empty. It is the password you sign in to the Tapo app with, not the Camera Account. When it is filled in, the hub keeps a second way to get video (the one the Tapo app itself uses) for when the normal video address gives nothing. Stored encrypted on the hub. Type it carefully: after a few wrong tries the camera refuses every login for a while, the Tapo app’s too.',
        },
      ],
      pathKinds: ['lan'],
      // No port is filled in on a connection: the two ports above apply. A port typed on a connection wins for control.
      defaultPort: null,
      capabilities: ['stream', 'snapshot', 'ptz', 'presets', 'reboot', 'state'],
      notes: [
        'First, in the Tapo app: open the camera, tap the gear icon, then Advanced Settings > Camera Account, and make a username and password (6 to 32 characters each; plain letters and digits work best). Enter that login here.',
        'Also in the Tapo app: Me > Third-Party Compatibility must be switched on, or the camera does not answer the hub. If the hub suddenly cannot log in, switch it off and on again and open the camera once in the Tapo app.',
        'Works on the house network: live video (a sharp and a light version), still pictures, turning and saved positions. Still pictures come from the live video when the camera does not hand them out itself.',
        'Restart is sent the standard way for network cameras. If your model does not take it, the hub says so and you restart the camera from the Tapo app.',
        `The camera turns while you hold the button. If letting go does not get through from the phone, it stops by itself after ${DEFAULT_MOVE_SECONDS} seconds.`,
        'Saved positions are made in the Tapo app. The hub lists them and sends the camera to them; it does not create new ones.',
        'The WiFi of a Tapo camera cannot be changed from here, nor from any other app. TP-Link only allows it by resetting the camera (hold its reset button for 5 seconds) and setting it up again in the Tapo app, so use the Tapo app for that step. The hub tells you when the camera stops answering.',
        'If the camera refuses the login, the hub waits five minutes before trying the same one again, so the camera does not lock the account. A corrected password is tried straight away.',
        'A Tapo allows three local video connections at a time. The hub takes one and shares it with every phone, so leave room for it if a recorder or another app also watches this camera.',
        '4G models (C501GW, TC40GW): the hub reaches them only while they are on a network cable. On the SIM alone a Tapo can be reached only from the Tapo app, so no SIM connection is offered here.',
        'Battery models (C410, C420, C425, D230) do not offer video this way and cannot be added. Recording to an SD card and Tapo Care together also switches this kind of access off in the camera.',
        'Motion alerts are not read from the camera through this option.',
        'EZVIZ cameras do not belong here. Add them as "Camera by stream address" with the video address rtsp://{user}:{pass}@{host}:{port}/ch1/main, the username admin and the 6-letter verification code from the camera’s label as the password (switch on RTSP in the EZVIZ app first), or as "ONVIF camera" if your model supports ONVIF.',
        'ICSee / XMEye cameras do not belong here. Add them as "Camera by stream address" with a dvrip:// address, for example dvrip://{user}:{pass}@{host}:34567?channel=0&subtype=0.',
        'V380 cameras can be added only if yours offers ONVIF or RTSP (many do not): then use "ONVIF camera" or "Camera by stream address". Otherwise they work only in the V380 app.',
      ],
    }
  },

  capabilities(config: Record<string, unknown>, _kind: DeviceKind): Capability[] {
    const caps: Capability[] = ['stream', 'snapshot', 'reboot', 'state']
    if (flag(config.ptz, true)) caps.push('ptz', 'presets')
    return caps
  },

  async probe(ctx): Promise<ProbeResult> {
    const down = (error: string): ProbeResult => ({ ok: false, latencyMs: null, error })
    let cam: Cam
    try {
      cam = open(ctx)
    } catch (err) {
      return down(plain(err))
    }
    const started = Date.now()
    try {
      // Needs no login, so it shows whether the camera is there without risking the account.
      await cam.client.syncClock()
    } catch (err) {
      if (!(err instanceof OnvifError)) return down(unreachable(err))
      if (err.kind === 'protocol') return down(`${NOT_A_TAPO}.`)
      // The camera answered but keeps its clock behind the login: carry on.
    }
    const latencyMs = Date.now() - started
    const held = heldBack(cam)
    if (held) return down(held)
    try {
      const info = await cam.client.getDeviceInformation()
      cam.mem.refused = null
      return { ok: true, latencyMs, info: infoState(info) }
    } catch (err) {
      if (!(err instanceof OnvifError)) return down(unreachable(err))
      if (err.kind === 'auth') {
        noteRefused(cam)
        return down(`${WRONG_LOGIN}.`)
      }
      if (err.kind === 'protocol') return down(`${NOT_A_TAPO}.`)
      return down(`The camera answered with an error: ${err.message}`)
    }
  },

  async readState(ctx): Promise<Record<string, unknown>> {
    const cam = open(ctx)
    const held = heldBack(cam)
    if (held) throw new Error(held)
    const { client, mem } = cam
    let info: OnvifDeviceInformation
    try {
      info = await client.getDeviceInformation(INFO_TTL_MS)
    } catch (err) {
      if (err instanceof OnvifError && err.kind === 'auth') {
        noteRefused(cam)
        throw new Error(`${WRONG_LOGIN}.`)
      }
      throw err
    }
    const state: Record<string, unknown> = infoState(info)
    const jobs: Promise<void>[] = []

    // The MAC address, so the hub can recognise the camera again at a new address.
    jobs.push(
      (async () => {
        try {
          const mac = (await client.getNetworkInterfaces(NETWORK_TTL_MS)).find((i) => i.mac)?.mac
          if (mac) state.mac = mac
        } catch (err) {
          if (!(err instanceof OnvifError)) throw err
        }
      })(),
    )

    if (ctx.bool('ptz', true)) {
      jobs.push(
        (async () => {
          let token: string
          try {
            const profile = pickProfiles(await client.getProfiles()).ptz
            if (!profile) return
            token = profile.token
            state.presets = rememberPresets(mem, await client.getPresets(token, PRESETS_TTL_MS))
          } catch (err) {
            // A fixed model has no movement service: nothing to report.
            if (!(err instanceof OnvifError)) throw err
            return
          }
          if (mem.noStatus) return
          try {
            const position = await client.getStatus(token)
            if (position) state.ptz = position
            else mem.noStatus = true
          } catch (err) {
            if (!(err instanceof OnvifError)) throw err
            if (err.kind === 'fault' || err.kind === 'unsupported') mem.noStatus = true
          }
        })(),
      )
    }

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
        if (!ctx.bool('ptz', true)) return { ok: false, error: PTZ_OFF }
        const cam = open(ctx)
        const held = heldBack(cam)
        if (held) return { ok: false, error: held }
        const { client, mem } = cam
        let profile: OnvifProfile | null
        try {
          profile = pickProfiles(await client.getProfiles()).ptz
        } catch (err) {
          return refusal(cam, err, 'turning')
        }
        if (!profile) return { ok: false, error: 'The camera did not list any video profile to steer' }
        const token = profile.token

        if (action.type === 'ptz.stop') {
          clearStop(mem)
          try {
            await client.stop(token)
          } catch (err) {
            return refusal(cam, err, 'stopping')
          }
          return { ok: true }
        }

        if (action.type === 'ptz.preset') {
          const wanted = String(p.preset ?? '').trim()
          if (!wanted) return { ok: false, error: 'No saved position chosen' }
          clearStop(mem)
          let target: string | undefined
          try {
            // A list read a moment ago is good enough; if the position is not in it, it may have
            // just been saved in the Tapo app, so the camera is asked once more before giving up.
            for (const maxAgeMs of [PRESETS_TTL_MS, 0]) {
              const presets = await client.getPresets(token, maxAgeMs)
              rememberPresets(mem, presets)
              target =
                mem.presetLabels.get(wanted) ??
                presets.find((x) => x.token === wanted)?.token ??
                presets.find((x) => x.name.toLowerCase() === wanted.toLowerCase())?.token
              if (target) break
              if (maxAgeMs === 0 && presets.length === 0) return { ok: false, error: 'The camera lists no saved positions. Save one in the Tapo app first.' }
            }
          } catch (err) {
            return refusal(cam, err, 'going to a saved position')
          }
          if (!target) return { ok: false, error: `The camera has no saved position "${wanted}"` }
          try {
            await client.gotoPreset(token, target)
          } catch (err) {
            if (err instanceof OnvifError && err.kind === 'fault' && err.is(/NoToken|preset/i)) return { ok: false, error: `The camera has no saved position "${wanted}"` }
            return refusal(cam, err, 'going to a saved position')
          }
          return { ok: true, result: { preset: wanted } }
        }

        // ptz.move
        const velocity = { pan: axis(p.pan), tilt: axis(p.tilt), zoom: axis(p.zoom) }
        clearStop(mem)
        if (velocity.pan === 0 && velocity.tilt === 0 && velocity.zoom === 0) {
          try {
            await client.stop(token)
          } catch (err) {
            return refusal(cam, err, 'stopping')
          }
          return { ok: true }
        }
        // The app sends one "move" when a button is pressed and "stop" when it is let go. If that
        // stop never arrives (phone lost its signal, app closed) the camera must not keep turning,
        // so every move has a limit: the one asked for, or DEFAULT_MOVE_SECONDS.
        const requested = Number(p.seconds ?? 0)
        const seconds = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_MOVE_SECONDS) : DEFAULT_MOVE_SECONDS
        try {
          await client.continuousMove(token, velocity, mem.noMoveLimit ? undefined : seconds)
        } catch (err) {
          if (mem.noMoveLimit || !(err instanceof OnvifError) || err.kind !== 'fault') return refusal(cam, err, 'turning')
          // The camera faulted on a move that carries a time limit. It is not established that every
          // Tapo firmware accepts that limit, so the move is tried once more without it; the hub's
          // own Stop below ends the move either way.
          try {
            await client.continuousMove(token, velocity)
            mem.noMoveLimit = true
          } catch (again) {
            return refusal(cam, again, 'turning')
          }
        }
        // The camera was given the same limit where it takes one, but the hub does not rely on it.
        const log = ctx.log
        mem.stopTimer = setTimeout(() => {
          mem.stopTimer = null
          client.stop(token).catch((err: unknown) => log.debug(`auto-stop failed: ${plain(err)}`))
        }, seconds * 1000)
        mem.stopTimer.unref?.()
        return { ok: true, result: { stopsAfterSeconds: seconds } }
      }

      case 'reboot': {
        const cam = open(ctx)
        const held = heldBack(cam)
        if (held) return { ok: false, error: held }
        clearStop(cam.mem)
        try {
          const message = await cam.client.reboot()
          return { ok: true, result: message ? { message } : {} }
        } catch (err) {
          return refusal(cam, err, 'restarting')
        }
      }

      default:
        return unsupported(action)
    }
  },

  async snapshot(ctx): Promise<Snapshot> {
    const cam = open(ctx)
    const held = heldBack(cam)
    if (held) throw new Error(held)
    const { client, mem } = cam
    if (Date.now() < mem.noStillsUntil) throw new Error(NO_STILLS)
    const noStills = (): Error => {
      mem.noStillsUntil = Date.now() + NO_STILLS_TTL_MS
      return new Error(NO_STILLS)
    }
    try {
      const { main } = pickProfiles(await client.getProfiles())
      if (!main) throw new Error('The camera did not list any video profile')
      let uri: string
      try {
        uri = await client.getSnapshotUri(main.token)
      } catch (err) {
        // The camera said it has no still-picture address: remember that rather than ask every time.
        if (err instanceof OnvifError && (err.kind === 'fault' || err.kind === 'unsupported')) throw noStills()
        throw err
      }
      try {
        return await client.fetchSnapshot(uri)
      } catch (err) {
        // It gave an address and then served no picture from it, or wanted another login for the
        // picture than the one it had just accepted. Either way: no stills from this camera.
        if (err instanceof OnvifError && (err.kind === 'protocol' || err.kind === 'auth')) throw noStills()
        throw err
      }
    } catch (err) {
      if (!(err instanceof OnvifError)) throw err
      if (err.kind === 'auth') {
        // Only a login the identity call also refuses is a wrong login.
        if (await loginStands(cam)) throw noStills()
        throw new Error(`${WRONG_LOGIN}.`)
      }
      throw new Error(err.kind === 'protocol' ? `${NOT_A_TAPO}.` : `The camera could not give a picture: ${err.message}`)
    }
  },

  streamSources(ctx): string[] {
    const host = bracket(requireHost(ctx))
    const login = userInfo(ctx.str('username').trim(), ctx.secret('password'))
    const base = `rtsp://${login}${host}:${rtspPortOf(ctx)}`
    // stream1 = the sharp picture, stream2 = the light one (for thumbnails and slow links).
    const sources = [`${base}/stream1`, `${base}/stream2`]
    // go2rtc's own Tapo source talks to the Tapo app's video port (8800). It takes the TP-Link
    // account password, alone and with no username; go2rtc works out the rest by itself.
    const cloud = ctx.secret('cloudPassword')
    if (cloud) sources.push(`tapo://${encodeURIComponent(cloud)}@${host}?subtype=0`)
    return sources
  },
}

export default adapter
