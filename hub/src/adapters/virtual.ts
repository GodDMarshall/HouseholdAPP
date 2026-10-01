/**
 * Virtual devices — an illustrative camera, gate and lights that behave like the
 * real thing (they go offline when re-pointed at another WiFi, the gate takes a
 * few seconds to open, PTZ moves the picture) so the whole app can be exercised
 * with no hardware attached. They are labelled "Illustrative" in the app.
 */
import type { Action, Capability, DeviceKind, FamilyDescriptor, GateState } from '@house/shared'
import {
  clamp,
  unsupported,
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type ProbeResult,
  type Snapshot,
  type WifiScanEntry,
} from './types.ts'

type Simulate = 'camera' | 'gate' | 'light' | 'dimmer'

interface Runtime {
  ssid: string | null
  offlineUntil: number
  power: boolean
  brightness: number
  gate: GateState
  gateTimer: NodeJS.Timeout | null
  ptz: { pan: number; tilt: number; zoom: number }
  velocity: { pan: number; tilt: number; zoom: number } | null
  moveTimer: NodeJS.Timeout | null
  presets: Record<string, { pan: number; tilt: number; zoom: number }>
  signal: number
  reboots: number
}

const runtimes = new Map<string, Runtime>()

const GATE_TRAVEL_MS = 6000
const REBOOT_MS = 5000
const WIFI_MOVE_MS = 4000

function simulateOf(config: Record<string, unknown>): Simulate {
  const s = String(config.simulate ?? 'light')
  return (['camera', 'gate', 'light', 'dimmer'] as Simulate[]).includes(s as Simulate) ? (s as Simulate) : 'light'
}

function rt(ctx: AdapterContext): Runtime {
  let r = runtimes.get(ctx.device.id)
  if (!r) {
    const start = ctx.str('startSsid').trim()
    const pathSsid = ctx.path.wifiNetworkId ? ctx.wifi(ctx.path.wifiNetworkId)?.ssid ?? null : null
    r = {
      ssid: start || pathSsid,
      offlineUntil: 0,
      power: false,
      brightness: 70,
      gate: 'closed',
      gateTimer: null,
      ptz: { pan: 0, tilt: 0, zoom: 1 },
      velocity: null,
      moveTimer: null,
      presets: { '1': { pan: 0, tilt: 0, zoom: 1 }, '2': { pan: 0.6, tilt: -0.2, zoom: 1.4 } },
      signal: 72,
      reboots: 0,
    }
    runtimes.set(ctx.device.id, r)
  }
  return r
}

/** Test hook. */
export function resetVirtualRuntimes(): void {
  for (const r of runtimes.values()) {
    if (r.gateTimer) clearTimeout(r.gateTimer)
    if (r.moveTimer) clearInterval(r.moveTimer)
  }
  runtimes.clear()
}

function stateOf(r: Runtime, sim: Simulate): Record<string, unknown> {
  const base: Record<string, unknown> = { wifi: r.ssid, signal: r.signal, model: `Virtual ${sim}`, illustrative: true }
  switch (sim) {
    case 'camera':
      return { ...base, ptz: { ...r.ptz }, presets: Object.keys(r.presets), sim: 'Illustrative SIM' }
    case 'gate':
      return { ...base, gate: r.gate }
    case 'light':
      return { ...base, power: r.power }
    case 'dimmer':
      return { ...base, power: r.power, brightness: r.brightness }
  }
}

/**
 * Like a real device: a command sent to an address on a network the device has
 * left, or while it restarts, never arrives. Thrown (not returned) so the hub
 * treats it as a transport failure and fails over.
 */
function assertReachable(ctx: AdapterContext, r: Runtime): void {
  if (Date.now() < r.offlineUntil) throw new Error('Device is restarting')
  if (ctx.path.kind === 'lan') {
    const target = ctx.path.wifiNetworkId ? ctx.wifi(ctx.path.wifiNetworkId)?.ssid ?? null : null
    if (target && r.ssid && target !== r.ssid) throw new Error(`No answer on "${target}": the device is on "${r.ssid}"`)
  }
  if (ctx.path.kind === 'cellular' && !ctx.bool('simReachable', false)) {
    throw new Error('The carrier gives this SIM a private address, so nothing can connect in to it')
  }
}

function jitter(lo: number, hi: number): number {
  return Math.round(lo + Math.random() * (hi - lo))
}

const adapter: Adapter = {
  family: 'virtual',

  describe(): FamilyDescriptor {
    return {
      id: 'virtual',
      label: 'Illustrative device',
      tagline: 'Behaves like a real camera, gate or light with no hardware. Good for trying the app.',
      kinds: ['camera', 'gate', 'light', 'switch'],
      fields: [
        {
          name: 'simulate',
          label: 'Behaves like',
          type: 'select',
          required: true,
          default: 'light',
          options: [
            { value: 'camera', label: 'PTZ camera with its own SIM' },
            { value: 'gate', label: 'Sliding gate with GSM box' },
            { value: 'light', label: 'On / off light' },
            { value: 'dimmer', label: 'Dimmable light' },
          ],
        },
        { name: 'startSsid', label: 'Starts on WiFi', type: 'text', help: 'Leave blank to start on the first path’s network.' },
        { name: 'simReachable', label: 'SIM has a public IP', type: 'toggle', default: false, help: 'Off = the carrier blocks inbound connections, like a normal consumer SIM.' },
        { name: 'failRate', label: 'Flakiness (%)', type: 'number', default: 0, help: 'Chance that any check fails, to try the failover.' },
      ],
      pathKinds: ['lan', 'cellular', 'sms', 'cloud'],
      defaultPort: 80,
      capabilities: ['power', 'dim', 'gate', 'gate-state', 'ptz', 'presets', 'snapshot', 'wifi', 'wifi-scan', 'cellular', 'reboot', 'sms', 'state'],
      notes: ['Illustrative only. Replace with your real devices when you add them.'],
    }
  },

  capabilities(config: Record<string, unknown>, _kind: DeviceKind): Capability[] {
    switch (simulateOf(config)) {
      case 'camera':
        return ['snapshot', 'ptz', 'presets', 'wifi', 'wifi-scan', 'cellular', 'reboot', 'state']
      case 'gate':
        return ['gate', 'gate-state', 'sms', 'reboot', 'state']
      case 'light':
        return ['power', 'wifi', 'reboot', 'state']
      case 'dimmer':
        return ['power', 'dim', 'wifi', 'reboot', 'state']
    }
  },

  async probe(ctx): Promise<ProbeResult> {
    const r = rt(ctx)
    if (Date.now() < r.offlineUntil) return { ok: false, latencyMs: null, error: 'Device is restarting' }
    const failRate = clamp(ctx.num('failRate', 0), 0, 100)
    if (failRate > 0 && Math.random() * 100 < failRate) return { ok: false, latencyMs: null, error: 'No answer (illustrative flakiness)' }
    switch (ctx.path.kind) {
      case 'lan': {
        const target = ctx.path.wifiNetworkId ? ctx.wifi(ctx.path.wifiNetworkId)?.ssid ?? null : null
        if (target && r.ssid && target !== r.ssid) {
          return { ok: false, latencyMs: null, error: `Device is on "${r.ssid}", not "${target}"` }
        }
        return { ok: true, latencyMs: jitter(4, 40), info: { wifi: r.ssid } }
      }
      case 'cellular':
        if (!ctx.bool('simReachable', false)) {
          return { ok: false, latencyMs: null, error: 'The carrier gives this SIM a private address, so nothing can connect in to it' }
        }
        return { ok: true, latencyMs: jitter(120, 400), info: { signal: r.signal } }
      case 'cloud':
        return { ok: true, latencyMs: jitter(150, 500) }
      case 'sms':
        return { ok: true, latencyMs: null, unverifiable: true }
    }
  },

  async readState(ctx) {
    const r = rt(ctx)
    assertReachable(ctx, r)
    return stateOf(r, simulateOf(ctx.device.config))
  },

  async execute(ctx, action: Action): Promise<ActionResult> {
    const r = rt(ctx)
    const sim = simulateOf(ctx.device.config)
    if (ctx.path.kind !== 'sms') assertReachable(ctx, r)
    const p = action.params

    switch (action.type) {
      case 'power.on':
      case 'power.off':
      case 'power.toggle': {
        if (sim !== 'light' && sim !== 'dimmer') return unsupported(action)
        r.power = action.type === 'power.toggle' ? !r.power : action.type === 'power.on'
        return { ok: true, state: { power: r.power } }
      }
      case 'dim.set': {
        if (sim !== 'dimmer') return unsupported(action)
        r.brightness = clamp(Math.round(Number(p.brightness ?? r.brightness)), 0, 100)
        r.power = r.brightness > 0
        return { ok: true, state: { brightness: r.brightness, power: r.power } }
      }
      case 'gate.open':
      case 'gate.close':
      case 'gate.stop':
      case 'gate.pulse': {
        if (sim !== 'gate') return unsupported(action)
        if (ctx.path.kind === 'sms') {
          // The GSM box answers only by moving the gate; the hub cannot see it.
          const text = action.type === 'gate.open' ? '1234#GON#' : action.type === 'gate.close' ? '1234#GOFF#' : '1234#GSTOP#'
          const out = await ctx.sms(ctx.path.host ?? '', text)
          return out.sent ? { ok: true, result: { via: 'sms' } } : { ok: true, needsConfirmation: true, result: { handoff: out.handoff, text } }
        }
        const target: GateState | null =
          action.type === 'gate.open' ? 'open' : action.type === 'gate.close' ? 'closed' : action.type === 'gate.stop' ? 'stopped' : null
        if (r.gateTimer) {
          clearTimeout(r.gateTimer)
          r.gateTimer = null
        }
        if (action.type === 'gate.stop') {
          r.gate = r.gate === 'opening' || r.gate === 'closing' ? 'stopped' : r.gate
          return { ok: true, state: { gate: r.gate } }
        }
        let goal = target
        if (action.type === 'gate.pulse') goal = r.gate === 'open' || r.gate === 'opening' ? 'closed' : 'open'
        if (r.gate === goal) return { ok: true, state: { gate: r.gate }, result: { alreadyThere: true } }
        r.gate = goal === 'open' ? 'opening' : 'closing'
        r.gateTimer = setTimeout(() => {
          r.gate = goal!
          r.gateTimer = null
        }, GATE_TRAVEL_MS)
        r.gateTimer.unref?.()
        return { ok: true, state: { gate: r.gate } }
      }
      case 'ptz.move': {
        if (sim !== 'camera') return unsupported(action)
        r.velocity = {
          pan: clamp(Number(p.pan ?? 0), -1, 1),
          tilt: clamp(Number(p.tilt ?? 0), -1, 1),
          zoom: clamp(Number(p.zoom ?? 0), -1, 1),
        }
        if (!r.moveTimer) {
          r.moveTimer = setInterval(() => {
            if (!r.velocity) return
            r.ptz.pan = clamp(r.ptz.pan + r.velocity.pan * 0.06, -1, 1)
            r.ptz.tilt = clamp(r.ptz.tilt + r.velocity.tilt * 0.06, -1, 1)
            r.ptz.zoom = clamp(r.ptz.zoom + r.velocity.zoom * 0.05, 1, 4)
          }, 100)
          r.moveTimer.unref?.()
        }
        const seconds = Number(p.seconds ?? 0)
        if (seconds > 0) {
          setTimeout(() => stopMove(r), seconds * 1000).unref?.()
        }
        return { ok: true, state: { ptz: { ...r.ptz } } }
      }
      case 'ptz.stop': {
        if (sim !== 'camera') return unsupported(action)
        stopMove(r)
        return { ok: true, state: { ptz: { ...r.ptz } } }
      }
      case 'ptz.preset': {
        if (sim !== 'camera') return unsupported(action)
        const preset = r.presets[String(p.preset ?? '1')]
        if (!preset) return { ok: false, error: `No preset ${String(p.preset)}` }
        stopMove(r)
        r.ptz = { ...preset }
        return { ok: true, state: { ptz: { ...r.ptz } } }
      }
      case 'snapshot':
        if (sim !== 'camera') return unsupported(action)
        return { ok: true }
      case 'reboot': {
        r.offlineUntil = Date.now() + REBOOT_MS
        r.reboots += 1
        return { ok: true, result: { backInSeconds: REBOOT_MS / 1000 } }
      }
      case 'sms.send': {
        const out = await ctx.sms(ctx.path.host ?? '', String(p.text ?? ''))
        return out.sent ? { ok: true } : { ok: true, needsConfirmation: true, result: { handoff: out.handoff } }
      }
      case 'custom':
        return { ok: false, error: 'Illustrative devices have no custom commands' }
      default:
        return unsupported(action)
    }
  },

  async snapshot(ctx): Promise<Snapshot> {
    const r = rt(ctx)
    const sim = simulateOf(ctx.device.config)
    if (sim !== 'camera') throw new Error('Only the illustrative camera produces snapshots')
    assertReachable(ctx, r)
    return { contentType: 'image/svg+xml', body: Buffer.from(renderScene(ctx.device.name, r)) }
  },

  async setWifi(ctx, target): Promise<ActionResult> {
    const r = rt(ctx)
    assertReachable(ctx, r)
    if (!target.ssid) return { ok: false, error: 'No network name given' }
    if (!target.password) return { ok: false, error: `No password stored for "${target.ssid}"` }
    r.offlineUntil = Date.now() + WIFI_MOVE_MS
    r.ssid = target.ssid
    return { ok: true, result: { ssid: target.ssid }, state: { wifi: target.ssid } }
  },

  async scanWifi(ctx): Promise<WifiScanEntry[]> {
    const r = rt(ctx)
    assertReachable(ctx, r)
    const seen = new Map<string, WifiScanEntry>()
    const add = (ssid: string | null, signal: number) => {
      if (ssid && !seen.has(ssid)) seen.set(ssid, { ssid, signal, security: 'WPA2' })
    }
    add(r.ssid, 78)
    add(ctx.path.wifiNetworkId ? ctx.wifi(ctx.path.wifiNetworkId)?.ssid ?? null : null, 70)
    add('Home WiFi', 64)
    add('Backup WiFi', 52)
    add('JioFiber-3F2A', 41)
    add('Airtel_Neighbour', 23)
    return [...seen.values()]
  },
}

function stopMove(r: Runtime): void {
  r.velocity = null
  if (r.moveTimer) {
    clearInterval(r.moveTimer)
    r.moveTimer = null
  }
}

/** A 640×360 "camera view" that shifts with pan/tilt and grows with zoom. */
function renderScene(name: string, r: Runtime): string {
  const z = r.ptz.zoom
  const ox = -r.ptz.pan * 160
  const oy = r.ptz.tilt * 90
  const time = new Date().toLocaleString('en-IN', { hour12: false })
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a3a"/><stop offset="1" stop-color="#3b556b"/></linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a5a3c"/><stop offset="1" stop-color="#2b3524"/></linearGradient>
    <clipPath id="frame"><rect width="640" height="360"/></clipPath>
  </defs>
  <g clip-path="url(#frame)">
    <g transform="translate(320 180) scale(${z.toFixed(2)}) translate(${(-320 + ox).toFixed(1)} ${(-180 + oy).toFixed(1)})">
      <rect x="-400" y="-300" width="1440" height="520" fill="url(#sky)"/>
      <rect x="-400" y="220" width="1440" height="500" fill="url(#ground)"/>
      <rect x="-400" y="236" width="1440" height="14" fill="#8a8f7a"/>
      <g fill="#6d6f72">
        <rect x="120" y="120" width="18" height="130"/><rect x="500" y="120" width="18" height="130"/>
        <rect x="138" y="132" width="362" height="8"/><rect x="138" y="200" width="362" height="8"/>
        ${Array.from({ length: 17 }, (_, i) => `<rect x="${148 + i * 21}" y="128" width="5" height="118"/>`).join('')}
      </g>
      <rect x="560" y="60" width="220" height="190" fill="#7c6a58"/><polygon points="550,62 670,-10 790,62" fill="#5a3f33"/>
      <rect x="600" y="150" width="40" height="100" fill="#3a2a22"/><rect x="690" y="120" width="50" height="40" fill="#cfd8dc" opacity="0.7"/>
      <circle cx="-80" cy="60" r="70" fill="#2e4a2e"/><circle cx="-20" cy="90" r="90" fill="#3a5a35"/>
      <circle cx="-60" cy="120" r="80" fill="#2e4a2e"/><rect x="-70" y="180" width="24" height="70" fill="#4a3a2a"/>
    </g>
  </g>
  <rect x="0" y="0" width="640" height="34" fill="rgba(0,0,0,0.45)"/>
  <text x="14" y="23" font-family="Segoe UI, Roboto, sans-serif" font-size="16" fill="#fff">${esc(name)}</text>
  <text x="626" y="23" text-anchor="end" font-family="Segoe UI, Roboto, monospace" font-size="15" fill="#fff">${esc(time)}</text>
  <text x="626" y="337" text-anchor="end" font-family="Segoe UI, Roboto, monospace" font-size="13" fill="#e0e0e0">P ${r.ptz.pan.toFixed(2)}  T ${r.ptz.tilt.toFixed(2)}  Z ${z.toFixed(1)}x</text>
</svg>`
}

export default adapter
