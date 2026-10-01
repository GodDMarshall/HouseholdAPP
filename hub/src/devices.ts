import type { ConnectionPath, Device, DeviceState, PathHealth } from '@house/shared'
import { getAdapter } from './adapters/index.ts'
import type { Adapter, AdapterContext, ProbeResult } from './adapters/types.ts'
import type { Config } from './config.ts'
import { nowIso, parseJson, type DB } from './db.ts'
import type { Bus, EventLog } from './events.ts'
import type { Logger } from './lib/log.ts'
import { withTimeout } from './lib/http.ts'
import type { Notifier } from './notify.ts'
import type { Registry } from './registry.ts'
import type { SmsTransport } from './sms.ts'

interface Runtime {
  deviceId: string
  health: Map<string, PathHealth>
  activePathId: string | null
  pinnedPathId: string | null
  state: Record<string, unknown>
  lastSeenAt: string | null
  online: boolean | null // null = never checked
  tick: number
  checking: Promise<DeviceState> | null
  unsubscribe: (() => void) | null
}

export interface DeviceManagerDeps {
  db: DB
  registry: Registry
  bus: Bus
  events: EventLog
  sms: SmsTransport
  notifier: Notifier
  log: Logger
  config: Config
}

/**
 * Knows, for every device, which connection path is alive and what state the
 * device is in. Runs the health loop, fails over and back, and hands adapters a
 * context bound to a concrete path.
 */
export class DeviceManager {
  private runtimes = new Map<string, Runtime>()
  private timer: NodeJS.Timeout | null = null
  private readonly log: Logger

  constructor(private readonly deps: DeviceManagerDeps) {
    this.log = deps.log.child('devices')
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    for (const d of this.deps.registry.listDevices()) this.load(d)
    this.deps.bus.on('device.upsert', (d) => this.onDeviceChanged(d))
    this.deps.bus.on('device.remove', (id) => this.onDeviceRemoved(id))
    const interval = this.deps.config.probeIntervalSec * 1000
    this.timer = setInterval(() => void this.tickAll(), interval)
    this.timer.unref?.()
    void this.tickAll()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const r of this.runtimes.values()) r.unsubscribe?.()
  }

  private load(device: Device): Runtime {
    const row = this.deps.db.prepare('SELECT * FROM device_runtime WHERE device_id = ?').get(device.id) as Record<string, unknown> | undefined
    const runtime: Runtime = {
      deviceId: device.id,
      health: new Map(device.paths.map((p) => [p.id, blankHealth(p)])),
      activePathId: (row?.active_path_id as string | null) ?? null,
      pinnedPathId: (row?.pinned_path_id as string | null) ?? null,
      state: parseJson<Record<string, unknown>>(row?.state as string | undefined, {}),
      lastSeenAt: (row?.last_seen_at as string | null) ?? null,
      online: null,
      tick: 0,
      checking: null,
      unsubscribe: null,
    }
    if (runtime.activePathId && !device.paths.some((p) => p.id === runtime.activePathId)) runtime.activePathId = null
    if (runtime.pinnedPathId && !device.paths.some((p) => p.id === runtime.pinnedPathId)) runtime.pinnedPathId = null
    this.runtimes.set(device.id, runtime)
    void this.resubscribe(device, runtime)
    return runtime
  }

  private onDeviceChanged(device: Device): void {
    const existing = this.runtimes.get(device.id)
    if (!existing) {
      this.load(device)
      void this.check(device.id, { force: true })
      return
    }
    // Keep health for paths that still exist, add blanks for new ones.
    const health = new Map<string, PathHealth>()
    for (const p of device.paths) health.set(p.id, existing.health.get(p.id) ?? blankHealth(p))
    existing.health = health
    if (existing.activePathId && !health.has(existing.activePathId)) existing.activePathId = null
    if (existing.pinnedPathId && !health.has(existing.pinnedPathId)) existing.pinnedPathId = null
    void this.resubscribe(device, existing)
    this.broadcast(device.id)
    void this.check(device.id, { force: true })
  }

  private onDeviceRemoved(id: string): void {
    const r = this.runtimes.get(id)
    r?.unsubscribe?.()
    this.runtimes.delete(id)
  }

  private async resubscribe(device: Device, runtime: Runtime): Promise<void> {
    runtime.unsubscribe?.()
    runtime.unsubscribe = null
    const adapter = this.adapterFor(device)
    if (!adapter.subscribe) return
    const path = this.activePath(device.id) ?? device.paths.find((p) => p.enabled) ?? null
    if (!path) return
    try {
      const unmasked = this.unmasked(device.id)
      runtime.unsubscribe = await adapter.subscribe(this.context(unmasked, path), (state) => {
        this.mergeState(device.id, state)
        runtime.lastSeenAt = nowIso()
      })
    } catch (err) {
      this.log.warn(`${device.name}: subscribe failed`, err instanceof Error ? err.message : err)
    }
  }

  // --------------------------------------------------------------- lookups

  adapterFor(device: Device): Adapter {
    return getAdapter(device.family)
  }

  unmasked(deviceId: string): Device {
    const d = this.deps.registry.getDeviceUnmasked(deviceId)
    if (!d) throw new Error('Device not found')
    return d
  }

  /** Build the context an adapter call runs in. `device` must be the unmasked device. */
  context(device: Device, path: ConnectionPath): AdapterContext {
    const cfg = device.config
    const registry = this.deps.registry
    const sms = this.deps.sms
    return {
      device,
      path,
      secret: (name) => {
        const v = cfg[name]
        return typeof v === 'string' && v.length > 0 ? v : undefined
      },
      str: (name, fallback = '') => {
        const v = cfg[name]
        return v === undefined || v === null ? fallback : String(v)
      },
      num: (name, fallback = 0) => {
        const n = Number(cfg[name])
        return Number.isFinite(n) && cfg[name] !== '' && cfg[name] !== null && cfg[name] !== undefined ? n : fallback
      },
      bool: (name, fallback = false) => {
        const v = cfg[name]
        if (v === undefined || v === null || v === '') return fallback
        return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
      },
      wifi: (networkId) => registry.getWifiSecret(networkId),
      sms: (to, text) => sms.send(to, text),
      timeoutMs: this.deps.config.deviceTimeoutMs,
      log: this.log.child(device.name),
    }
  }

  getState(deviceId: string): DeviceState | null {
    const device = this.deps.registry.getDevice(deviceId)
    const r = this.runtimes.get(deviceId)
    if (!device || !r) return null
    return this.toState(device, r)
  }

  listStates(): DeviceState[] {
    return this.deps.registry
      .listDevices()
      .map((d) => {
        const r = this.runtimes.get(d.id) ?? this.load(d)
        return this.toState(d, r)
      })
  }

  /**
   * The path commands should use right now. The health check already prefers a
   * pinned path while it answers, so the active path is always the right one;
   * a pinned path that has gone quiet must not swallow commands.
   */
  activePath(deviceId: string): ConnectionPath | null {
    const device = this.deps.registry.getDevice(deviceId)
    const r = this.runtimes.get(deviceId)
    if (!device || !r) return null
    return device.paths.find((p) => p.id === r.activePathId && p.enabled) ?? null
  }

  // ---------------------------------------------------------------- checks

  private async tickAll(): Promise<void> {
    const devices = this.deps.registry.listDevices()
    await Promise.all(devices.map((d) => this.check(d.id).catch((err) => this.log.warn(`${d.name}: check failed`, err))))
  }

  /**
   * Probe the device: keep the current path if it answers; otherwise walk the
   * others in priority order. Every few ticks re-try better paths (fail-back).
   */
  check(deviceId: string, opts: { force?: boolean } = {}): Promise<DeviceState> {
    const r = this.runtimes.get(deviceId)
    if (!r) return Promise.reject(new Error('Device not found'))
    if (r.checking && !opts.force) return r.checking
    const run = this.runCheck(deviceId, r, opts.force ?? false).finally(() => {
      r.checking = null
    })
    r.checking = run
    return run
  }

  private async runCheck(deviceId: string, r: Runtime, force: boolean): Promise<DeviceState> {
    const device = this.deps.registry.getDevice(deviceId)
    if (!device) throw new Error('Device not found')
    const unmasked = this.unmasked(deviceId)
    const adapter = this.adapterFor(device)
    const paths = device.paths.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority)
    r.tick += 1
    for (const p of device.paths) if (!p.enabled) r.health.set(p.id, { ...blankHealth(p), status: 'disabled' })

    if (paths.length === 0) {
      r.activePathId = null
      this.setOnline(device, r, false, 'No connection paths configured')
      return this.finish(device, r)
    }

    const pinned = r.pinnedPathId ? paths.find((p) => p.id === r.pinnedPathId) ?? null : null
    const current = pinned ?? paths.find((p) => p.id === r.activePathId) ?? null
    const sweep = force || r.tick % this.deps.config.failbackEveryTicks === 0 || !current || (current !== pinned && current.priority !== paths[0]!.priority)

    let chosen: ConnectionPath | null = null

    if (sweep) {
      // Probe every path in parallel, then choose the best that answers.
      const results = await Promise.all(paths.map((p) => this.probeOne(adapter, unmasked, p, r)))
      const order = pinned ? [pinned, ...paths.filter((p) => p !== pinned)] : paths
      for (const p of order) {
        const res = results[paths.indexOf(p)]!
        if (res.ok) {
          chosen = p
          break
        }
      }
    } else {
      const res = await this.probeOne(adapter, unmasked, current, r)
      if (res.ok) chosen = current
      else {
        for (const p of paths) {
          if (p === current) continue
          const alt = await this.probeOne(adapter, unmasked, p, r)
          if (alt.ok) {
            chosen = p
            break
          }
        }
      }
    }

    const previousId = r.activePathId
    r.activePathId = chosen?.id ?? null
    if (chosen && chosen.id !== previousId) {
      const prev = device.paths.find((p) => p.id === previousId)
      const better = prev ? chosen.priority < prev.priority : false
      this.deps.events.record({
        deviceId: device.id,
        level: prev && !better ? 'warn' : 'info',
        type: prev ? (better ? 'path.restored' : 'path.switched') : 'path.up',
        message: prev
          ? better
            ? `${device.name} is back on ${chosen.label}`
            : `${device.name} switched from ${prev.label} to ${chosen.label}`
          : `${device.name} reachable on ${chosen.label}`,
        data: { pathId: chosen.id, previousPathId: previousId },
      })
      if (prev && r.online !== null && (device.notify === 'everything' || device.notify === 'important')) {
        void this.deps.notifier.send({
          title: better ? `${device.name} back on ${chosen.label}` : `${device.name} now on ${chosen.label}`,
          body: better ? 'The better connection is working again.' : `${prev.label} stopped answering, so the hub switched over.`,
          tag: `path:${device.id}`,
          url: `/device/${device.id}`,
          deviceId: device.id,
        })
      }
      void this.resubscribe(device, r)
    }

    if (chosen) {
      this.setOnline(device, r, true, null)
      if (adapter.readState && chosen.kind !== 'sms') {
        try {
          const state = await withTimeout(adapter.readState(this.context(unmasked, chosen)), this.deps.config.deviceTimeoutMs, 'Reading state')
          r.state = { ...r.state, ...state }
          r.lastSeenAt = nowIso()
        } catch (err) {
          this.log.debug(`${device.name}: readState failed`, err instanceof Error ? err.message : err)
        }
      } else {
        r.lastSeenAt = nowIso()
      }
    } else {
      this.setOnline(device, r, false, 'Unreachable on all connections')
    }
    return this.finish(device, r)
  }

  private async probeOne(adapter: Adapter, unmasked: Device, path: ConnectionPath, r: Runtime): Promise<ProbeResult> {
    const before = r.health.get(path.id) ?? blankHealth(path)
    r.health.set(path.id, { ...before, status: 'checking' })
    const started = Date.now()
    let res: ProbeResult
    try {
      res = await withTimeout(adapter.probe(this.context(unmasked, path)), this.deps.config.deviceTimeoutMs + 500, `Checking ${path.label}`)
    } catch (err) {
      res = { ok: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) }
    }
    const now = nowIso()
    const health: PathHealth = {
      pathId: path.id,
      status: res.ok ? 'up' : 'down',
      latencyMs: res.ok ? res.latencyMs ?? (res.unverifiable ? null : Date.now() - started) : null,
      lastCheckedAt: now,
      lastUpAt: res.ok ? now : before.lastUpAt,
      error: res.ok ? null : res.error ?? 'No answer',
    }
    r.health.set(path.id, health)
    if (res.ok && res.info) r.state = { ...r.state, ...res.info }
    return res
  }

  private setOnline(device: Device, r: Runtime, online: boolean, reason: string | null): void {
    const was = r.online
    r.online = online
    if (was === null) return
    const quiet = device.notify === 'none'
    if (was && !online) {
      this.deps.events.record({ deviceId: device.id, level: 'error', type: 'device.offline', message: `${device.name}: ${reason ?? 'unreachable'}` })
      if (quiet) return
      void this.deps.notifier.send({
        title: `${device.name} unreachable`,
        body: reason ?? 'No connection path is answering.',
        tag: `offline:${device.id}`,
        url: `/device/${device.id}`,
        deviceId: device.id,
        level: 'error',
      })
    } else if (!was && online) {
      this.deps.events.record({ deviceId: device.id, level: 'info', type: 'device.online', message: `${device.name} is reachable again` })
      if (quiet) return
      void this.deps.notifier.send({ title: `${device.name} is back`, body: 'Reachable again.', tag: `offline:${device.id}`, url: `/device/${device.id}`, deviceId: device.id })
    }
  }

  private finish(device: Device, r: Runtime): DeviceState {
    this.persist(r)
    return this.broadcast(device.id) ?? this.toState(device, r)
  }

  /** Probe one path now (used by the "check" button and by wifi moves). */
  async probePath(deviceId: string, pathId: string): Promise<ProbeResult> {
    const device = this.deps.registry.getDevice(deviceId)
    const r = this.runtimes.get(deviceId)
    const path = device?.paths.find((p) => p.id === pathId)
    if (!device || !r || !path) throw new Error('Path not found')
    const res = await this.probeOne(this.adapterFor(device), this.unmasked(deviceId), path, r)
    this.broadcast(deviceId)
    return res
  }

  /** Pin a path by hand (null to let the hub choose again), then re-check. */
  async pinPath(deviceId: string, pathId: string | null): Promise<DeviceState> {
    const device = this.deps.registry.getDevice(deviceId)
    const r = this.runtimes.get(deviceId)
    if (!device || !r) throw new Error('Device not found')
    if (pathId && !device.paths.some((p) => p.id === pathId && p.enabled)) throw new Error('That connection is not enabled on this device')
    r.pinnedPathId = pathId
    const label = device.paths.find((p) => p.id === pathId)?.label
    const state = await this.check(deviceId, { force: true })
    if (pathId && state.activePathId !== pathId) {
      // The chosen connection is not answering: do not leave a pin on a dead path.
      r.pinnedPathId = null
      this.persist(r)
      this.deps.events.record({ deviceId, level: 'warn', type: 'path.pin-failed', message: `${device.name}: ${label} is not answering, so it was not pinned` })
      return this.broadcast(deviceId) ?? state
    }
    this.deps.events.record({
      deviceId,
      type: 'path.pinned',
      message: pathId ? `${device.name}: connection pinned to ${label}` : `${device.name}: automatic connection choice restored`,
    })
    return this.broadcast(deviceId) ?? state
  }

  pinnedPathId(deviceId: string): string | null {
    return this.runtimes.get(deviceId)?.pinnedPathId ?? null
  }

  /** Merge state keys straight away (after an action) and tell the app. */
  mergeState(deviceId: string, partial: Record<string, unknown>): void {
    const r = this.runtimes.get(deviceId)
    if (!r) return
    r.state = { ...r.state, ...partial }
    r.lastSeenAt = nowIso()
    this.persist(r)
    this.broadcast(deviceId)
  }

  /** Read state over the active path right now (after gate moves etc.). */
  async refreshState(deviceId: string): Promise<Record<string, unknown>> {
    const device = this.deps.registry.getDevice(deviceId)
    const r = this.runtimes.get(deviceId)
    const path = this.activePath(deviceId)
    if (!device || !r || !path) throw new Error('Device is not reachable')
    const adapter = this.adapterFor(device)
    if (!adapter.readState) return r.state
    const state = await withTimeout(adapter.readState(this.context(this.unmasked(deviceId), path)), this.deps.config.deviceTimeoutMs, 'Reading state')
    r.state = { ...r.state, ...state }
    r.lastSeenAt = nowIso()
    this.persist(r)
    this.broadcast(deviceId)
    return r.state
  }

  // --------------------------------------------------------------- output

  private toState(device: Device, r: Runtime): DeviceState {
    const active = device.paths.find((p) => p.id === r.activePathId) ?? null
    const activeHealth = active ? r.health.get(active.id) : undefined
    let summary: string
    if (r.online === null) summary = 'Checking…'
    else if (!r.online) summary = device.paths.some((p) => p.enabled) ? 'Unreachable on all connections' : 'No connection set up'
    else if (active?.kind === 'sms') summary = 'SMS only — commands go by text'
    else if (active) summary = `On ${active.label}${activeHealth?.latencyMs != null ? ` (${activeHealth.latencyMs} ms)` : ''}`
    else summary = 'Reachable'
    if (r.pinnedPathId && active && r.pinnedPathId === active.id) summary += ' · pinned'
    return {
      deviceId: device.id,
      online: r.online === true,
      activePathId: r.activePathId,
      pinnedPathId: r.pinnedPathId,
      state: r.state,
      paths: device.paths.map((p) => r.health.get(p.id) ?? blankHealth(p)),
      lastSeenAt: r.lastSeenAt,
      updatedAt: nowIso(),
      summary,
    }
  }

  private broadcast(deviceId: string): DeviceState | null {
    const state = this.getState(deviceId)
    if (state) this.deps.bus.emit('device.state', state)
    return state
  }

  private persist(r: Runtime): void {
    this.deps.db
      .prepare(
        `INSERT INTO device_runtime (device_id, active_path_id, pinned_path_id, state, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET active_path_id = excluded.active_path_id, pinned_path_id = excluded.pinned_path_id,
           state = excluded.state, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
      )
      .run(r.deviceId, r.activePathId, r.pinnedPathId, JSON.stringify(r.state), r.lastSeenAt, nowIso())
  }
}

function blankHealth(p: ConnectionPath): PathHealth {
  return { pathId: p.id, status: p.enabled ? 'unknown' : 'disabled', latencyMs: null, lastCheckedAt: null, lastUpAt: null, error: null }
}
