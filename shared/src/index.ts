/**
 * House Control — contracts shared by the hub (server) and the app (phone UI).
 *
 * Everything the app sees goes through these types. Secrets never leave the hub:
 * config fields marked `secret` in a family descriptor are sent to the app as
 * SECRET_MASK and only replaced when the user types a new value.
 */

export const SECRET_MASK = '••••••••'

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** What the thing is, from the owner's point of view. Drives the tile design. */
export type DeviceKind = 'camera' | 'gate' | 'light' | 'switch' | 'sensor' | 'other'

export const DEVICE_KINDS: DeviceKind[] = ['camera', 'gate', 'light', 'switch', 'sensor', 'other']

/** How the hub talks to it. One adapter per family. */
export type Family =
  | 'virtual'
  | 'rtsp'
  | 'onvif'
  | 'hikvision'
  | 'dahua'
  | 'tapo'
  | 'tasmota'
  | 'shelly'
  | 'tuya-cloud'
  | 'tuya-local'
  | 'mqtt'
  | 'http-relay'
  | 'gsm-sms'

export const FAMILIES: Family[] = [
  'virtual', 'rtsp', 'onvif', 'hikvision', 'dahua', 'tapo', 'tasmota', 'shelly',
  'tuya-cloud', 'tuya-local', 'mqtt', 'http-relay', 'gsm-sms',
]

/** What a device can do. Computed by the adapter from the device's config. */
export type Capability =
  | 'power' // on / off / toggle
  | 'dim' // brightness 0-100
  | 'color' // colour (lights)
  | 'gate' // open / close / stop / pulse
  | 'gate-state' // knows whether it is open or closed
  | 'ptz' // pan / tilt / zoom
  | 'presets' // PTZ presets
  | 'snapshot' // JPEG still
  | 'stream' // live video through go2rtc
  | 'wifi' // can be re-pointed at another WiFi network
  | 'wifi-scan' // can list WiFi networks it sees
  | 'cellular' // reports SIM / 4G status
  | 'reboot'
  | 'sms' // commanded by SMS
  | 'state' // reports a state we can read back

/** A connection path is one way of reaching a device, in priority order. */
export type PathKind =
  | 'lan' // an IP on one of the house WiFi / wired networks
  | 'cellular' // the device's own SIM: reachable only if the carrier gives it a public IP
  | 'cloud' // the vendor's cloud (Tuya, EZVIZ ...), reachable from anywhere
  | 'sms' // text messages to the device's SIM number (gate boxes, some 4G cameras)

export const PATH_KINDS: PathKind[] = ['lan', 'cellular', 'cloud', 'sms']

export interface ConnectionPath {
  id: string
  deviceId: string
  /** 0 = tried first. */
  priority: number
  kind: PathKind
  /** Shown on the tile: "Home WiFi", "Backup WiFi", "SIM", "SMS". */
  label: string
  /** For lan paths: which house WiFi network this address lives on. */
  wifiNetworkId: string | null
  /** IP address or hostname (lan / cellular), phone number (sms), or account handle (cloud). */
  host: string | null
  port: number | null
  /** Family-specific extras (e.g. cloud region, SMS password). */
  extra: Record<string, unknown>
  enabled: boolean
}

export type PathStatus = 'unknown' | 'checking' | 'up' | 'down' | 'disabled'

export interface PathHealth {
  pathId: string
  status: PathStatus
  latencyMs: number | null
  lastCheckedAt: string | null
  lastUpAt: string | null
  error: string | null
}

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  family: Family
  room: string
  /** Family-specific settings (username, channel, device id ...). Secrets masked for the app. */
  config: Record<string, unknown>
  capabilities: Capability[]
  paths: ConnectionPath[]
  sort: number
  createdAt: string
  updatedAt: string
}

/** A device as the app creates or edits it. */
export interface DeviceInput {
  name: string
  kind: DeviceKind
  family: Family
  room: string
  config: Record<string, unknown>
  paths: PathInput[]
  sort?: number
}

export interface PathInput {
  id?: string
  priority: number
  kind: PathKind
  label: string
  wifiNetworkId?: string | null
  host?: string | null
  port?: number | null
  extra?: Record<string, unknown>
  enabled?: boolean
}

/** Live state of a device, pushed to the app whenever it changes. */
export interface DeviceState {
  deviceId: string
  online: boolean
  activePathId: string | null
  /** Set when the owner pinned a connection by hand; null = the hub chooses. */
  pinnedPathId: string | null
  /**
   * Family-agnostic state keys the tiles understand:
   * power (boolean), brightness (0-100), gate (GateState),
   * ptz ({pan,tilt,zoom}), signal (0-100, cellular), sim (string), wifi (ssid the device reports),
   * plus anything the adapter adds.
   */
  state: Record<string, unknown>
  paths: PathHealth[]
  lastSeenAt: string | null
  updatedAt: string
  /** Short human sentence for the tile, e.g. "Reachable on Home WiFi" or "Unreachable on all paths". */
  summary: string
}

export type GateState = 'open' | 'closed' | 'opening' | 'closing' | 'stopped' | 'unknown'

// ---------------------------------------------------------------------------
// WiFi networks the house has
// ---------------------------------------------------------------------------

export interface WifiNetwork {
  id: string
  ssid: string
  hasPassword: boolean
  notes: string
  createdAt: string
}

export interface WifiNetworkInput {
  ssid: string
  /** Omit or SECRET_MASK to keep the stored password. */
  password?: string
  notes?: string
}

// ---------------------------------------------------------------------------
// Actions — everything the owner asks a device to do, tracked to completion
// ---------------------------------------------------------------------------

export type ActionType =
  | 'power.on'
  | 'power.off'
  | 'power.toggle'
  | 'dim.set' // params: { brightness: 0-100 }
  | 'color.set' // params: { hex: '#rrggbb' } or { temperature: kelvin }
  | 'gate.open'
  | 'gate.close'
  | 'gate.stop'
  | 'gate.pulse' // one relay pulse (open/stop/close step logic)
  | 'ptz.move' // params: { pan: -1..1, tilt: -1..1, zoom: -1..1, seconds?: number }
  | 'ptz.stop'
  | 'ptz.preset' // params: { preset: number | string }
  | 'snapshot'
  | 'reboot'
  | 'wifi.set' // params: { wifiNetworkId } or { ssid, password }
  | 'wifi.scan'
  | 'path.switch' // params: { pathId }
  | 'probe' // params: { pathId? }
  | 'sms.send' // params: { text }
  | 'custom' // params: family-defined

export const ACTION_TYPES: ActionType[] = [
  'power.on', 'power.off', 'power.toggle', 'dim.set', 'color.set',
  'gate.open', 'gate.close', 'gate.stop', 'gate.pulse',
  'ptz.move', 'ptz.stop', 'ptz.preset', 'snapshot', 'reboot',
  'wifi.set', 'wifi.scan', 'path.switch', 'probe', 'sms.send', 'custom',
]

export type ActionStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  /** The hub could not confirm the result itself (e.g. an SMS handed to the phone). */
  | 'needs-confirmation'

export interface Action {
  id: string
  deviceId: string
  type: ActionType
  params: Record<string, unknown>
  status: ActionStatus
  pathId: string | null
  /** Human label, e.g. "Open gate". */
  label: string
  source: 'app' | 'hub' | 'schedule'
  requestedAt: string
  startedAt: string | null
  finishedAt: string | null
  result: Record<string, unknown> | null
  error: string | null
}

export interface ActionRequest {
  type: ActionType
  params?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Events — the activity feed
// ---------------------------------------------------------------------------

export type EventLevel = 'info' | 'warn' | 'error'

export interface EventRecord {
  id: string
  ts: string
  deviceId: string | null
  level: EventLevel
  /** e.g. 'path.up', 'path.down', 'path.switched', 'action.done', 'action.failed', 'wifi.moved', 'hub.started' */
  type: string
  message: string
  data: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Family descriptors — tell the app how to draw the "Add device" form
// ---------------------------------------------------------------------------

export type FieldType = 'text' | 'password' | 'number' | 'select' | 'toggle' | 'textarea'

export interface FieldSpec {
  name: string
  label: string
  type: FieldType
  required?: boolean
  secret?: boolean
  help?: string
  placeholder?: string
  default?: unknown
  options?: { value: string; label: string }[]
  /** Only show when another config field has this value. */
  showWhen?: { field: string; equals: unknown }
}

export interface FamilyDescriptor {
  id: Family
  label: string
  /** Short line under the label in the picker. */
  tagline: string
  /** Which device kinds this family can be. */
  kinds: DeviceKind[]
  /** Config fields to ask for. */
  fields: FieldSpec[]
  /** Which path kinds make sense. */
  pathKinds: PathKind[]
  /** Default port for lan paths, if any. */
  defaultPort: number | null
  /** What the family can do at best; actual capabilities depend on config. */
  capabilities: Capability[]
  /** Plain-language notes shown in the wizard (what works, what does not). */
  notes: string[]
}

// ---------------------------------------------------------------------------
// Hub status
// ---------------------------------------------------------------------------

export interface HubStatus {
  version: string
  hostname: string
  addresses: string[]
  startedAt: string
  uptimeSec: number
  dataDir: string
  devices: number
  video: {
    go2rtc: 'running' | 'missing' | 'stopped' | 'error'
    version: string | null
    detail: string | null
  }
  push: {
    enabled: boolean
    publicKey: string | null
    subscriptions: number
  }
  sms: {
    modem: 'connected' | 'missing' | 'error' | 'disabled'
    port: string | null
    detail: string | null
  }
  discovery: {
    onvif: boolean
    mdns: boolean
  }
}

// ---------------------------------------------------------------------------
// Realtime messages hub → app
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'hello'; status: HubStatus; devices: Device[]; states: DeviceState[]; wifi: WifiNetwork[]; actions: Action[] }
  | { type: 'device.upsert'; device: Device }
  | { type: 'device.remove'; deviceId: string }
  | { type: 'device.state'; state: DeviceState }
  | { type: 'action'; action: Action }
  | { type: 'event'; event: EventRecord }
  | { type: 'wifi.networks'; networks: WifiNetwork[] }
  | { type: 'hub.status'; status: HubStatus }

export type ClientMessage = { type: 'ping' }

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveredDevice {
  family: Family
  kind: DeviceKind
  name: string
  host: string
  port: number | null
  detail: string
  config: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Helpers used on both sides
// ---------------------------------------------------------------------------

export const ACTION_LABELS: Record<ActionType, string> = {
  'power.on': 'Turn on',
  'power.off': 'Turn off',
  'power.toggle': 'Toggle',
  'dim.set': 'Set brightness',
  'color.set': 'Set colour',
  'gate.open': 'Open gate',
  'gate.close': 'Close gate',
  'gate.stop': 'Stop gate',
  'gate.pulse': 'Pulse gate',
  'ptz.move': 'Move camera',
  'ptz.stop': 'Stop camera',
  'ptz.preset': 'Go to preset',
  snapshot: 'Take snapshot',
  reboot: 'Reboot',
  'wifi.set': 'Move to WiFi',
  'wifi.scan': 'Scan WiFi',
  'path.switch': 'Switch connection',
  probe: 'Check connection',
  'sms.send': 'Send SMS',
  custom: 'Custom command',
}

export function kindLabel(kind: DeviceKind): string {
  switch (kind) {
    case 'camera': return 'Camera'
    case 'gate': return 'Gate or garage door'
    case 'light': return 'Light'
    case 'switch': return 'Switch'
    case 'sensor': return 'Sensor'
    default: return 'Device'
  }
}

export function pathKindLabel(kind: PathKind): string {
  switch (kind) {
    case 'lan': return 'WiFi / wired'
    case 'cellular': return 'SIM (4G)'
    case 'cloud': return 'Cloud'
    case 'sms': return 'SMS'
  }
}
