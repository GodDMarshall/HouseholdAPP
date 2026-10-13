import type { ChannelInfo } from '@house/shared'
import type {
  Action,
  Capability,
  ConnectionPath,
  Device,
  DeviceKind,
  DiscoveredDevice,
  Family,
  FamilyDescriptor,
} from '@house/shared'
import type { Logger } from '../lib/log.ts'

export interface ProbeResult {
  ok: boolean
  latencyMs: number | null
  error?: string
  /** Anything learned while probing (model, firmware, signal ...). Merged into state. */
  info?: Record<string, unknown>
  /** True when the path cannot be checked (SMS): treated as available but unverified. */
  unverifiable?: boolean
}

export interface ActionResult {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
  /** The hub could not confirm the outcome itself; the app asks the owner to confirm. */
  needsConfirmation?: boolean
  /** State keys to merge right away (e.g. power: true) without waiting for the next read. */
  state?: Record<string, unknown>
}

export interface Snapshot {
  contentType: string
  body: Buffer
}

export interface WifiScanEntry {
  ssid: string
  signal: number | null
  security: string | null
}

export interface SmsOutcome {
  /** True when a modem accepted the message. */
  sent: boolean
  /** When no modem is attached: an sms: link the phone can open with the text pre-filled. */
  handoff?: string
  error?: string
}

/** Everything an adapter call gets. `device.config` here is DECRYPTED (hub side only). */
export interface AdapterContext {
  device: Device
  path: ConnectionPath
  /** Decrypted secret config field, e.g. secret('password'). */
  secret(name: string): string | undefined
  /** Plain string config field with a fallback. */
  str(name: string, fallback?: string): string
  num(name: string, fallback?: number): number
  bool(name: string, fallback?: boolean): boolean
  /** A house WiFi network by id (ssid + decrypted password), for wifi.set and for path checks. */
  wifi(networkId: string): { id: string; ssid: string; password: string } | undefined
  /** Send an SMS through the hub's transport. */
  sms(to: string, text: string): Promise<SmsOutcome>
  /** Per-request timeout for device calls. */
  timeoutMs: number
  log: Logger
}

export interface Adapter {
  family: Family
  /** What the Add-device form asks for and what the wizard should say. */
  describe(): FamilyDescriptor
  /** Capabilities for a concrete config, e.g. a Tasmota with dimmer=true gains 'dim'. */
  capabilities(config: Record<string, unknown>, kind: DeviceKind): Capability[]
  /** Is the device reachable on this path? Must be quick (<= timeoutMs) and side-effect free. */
  probe(ctx: AdapterContext): Promise<ProbeResult>
  /** Read the current state (power, gate, ptz ...). Optional for write-only devices. */
  readState?(ctx: AdapterContext): Promise<Record<string, unknown>>
  /** Do the thing. Must map unsupported action types to { ok: false, error }. */
  execute(ctx: AdapterContext, action: Action): Promise<ActionResult>
  /** A JPEG still, when the device can produce one directly. */
  snapshot?(ctx: AdapterContext): Promise<Snapshot>
  /** go2rtc source URLs for live video on this path (rtsp://..., onvif://..., tapo://...). */
  streamSources?(ctx: AdapterContext): string[]
  /** Re-point the device at another WiFi network. */
  setWifi?(ctx: AdapterContext, target: { ssid: string; password: string }): Promise<ActionResult>
  /** Networks the device can see. */
  scanWifi?(ctx: AdapterContext): Promise<WifiScanEntry[]>
  /** Push-style state (MQTT): call onState whenever the device reports. Returns an unsubscribe. */
  subscribe?(ctx: AdapterContext, onState: (state: Record<string, unknown>) => void): Promise<() => void>
  /** Find devices of this family on the network. */
  discover?(seconds: number, log: Logger): Promise<DiscoveredDevice[]>
  /** On a recorder (NVR / DVR): the cameras behind it, so they can all be added in one go. */
  listChannels?(ctx: AdapterContext): Promise<ChannelInfo[]>
}

export function unsupported(action: Action): ActionResult {
  return { ok: false, error: `This device cannot do "${action.type}"` }
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** The address on this path, or a clear error when the owner has not filled it in. */
export function requireHost(ctx: AdapterContext): string {
  const host = (ctx.path.host ?? '').trim()
  if (!host) throw new Error(`No address set on the "${ctx.path.label}" connection`)
  return host
}

/** http(s)://host:port for this path. IPv6 literals are bracketed. */
export function baseUrl(ctx: AdapterContext, opts: { https?: boolean; defaultPort?: number } = {}): string {
  const host = requireHost(ctx)
  const scheme = opts.https ? 'https' : 'http'
  const port = ctx.path.port ?? opts.defaultPort ?? (opts.https ? 443 : 80)
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const standard = (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443)
  return `${scheme}://${h}${standard ? '' : ':' + port}`
}

/** user:pass@ for stream URLs, percent-encoded so odd characters in passwords survive. */
export function userInfo(username: string | undefined, password: string | undefined): string {
  if (!username) return ''
  return `${encodeURIComponent(username)}${password ? ':' + encodeURIComponent(password) : ''}@`
}

/** TCP reachability check for devices with no cheap status call. */
export async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    const done = (res: ProbeResult) => {
      socket.destroy()
      resolve(res)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done({ ok: true, latencyMs: Date.now() - started }))
    socket.once('timeout', () => done({ ok: false, latencyMs: null, error: `${host}:${port} did not answer` }))
    socket.once('error', (err: NodeJS.ErrnoException) =>
      done({
        ok: false,
        latencyMs: null,
        error:
          err.code === 'ECONNREFUSED'
            ? `${host}:${port} refused the connection`
            : err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH'
              ? `${host} is not reachable from this network`
              : err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN'
                ? `${host} could not be found. Check the address.`
                : err.code === 'ECONNRESET'
                  ? `${host}:${port} closed the connection`
                  : err.message,
      }),
    )
  })
}

/** Common config field specs so adapters read the same. */
export const FIELD = {
  username: (help = 'The login the device asks for.') => ({ name: 'username', label: 'Username', type: 'text' as const, required: true, help }),
  password: (help = 'Stored encrypted on the hub.') => ({ name: 'password', label: 'Password', type: 'password' as const, secret: true, required: true, help }),
  https: () => ({ name: 'https', label: 'Use HTTPS', type: 'toggle' as const, default: false }),
}
