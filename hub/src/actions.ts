import fs from 'node:fs'
import path from 'node:path'
import {
  ACTION_LABELS,
  ACTION_TYPES,
  type Action,
  type ActionRequest,
  type ActionStatus,
  type ActionType,
  type Capability,
  type ConnectionPath,
  type Device,
  type GateState,
} from '@house/shared'
import type { ActionResult, Snapshot } from './adapters/types.ts'
import type { Config } from './config.ts'
import { nowIso, parseJson, type DB } from './db.ts'
import type { DeviceManager } from './devices.ts'
import type { Bus, EventLog } from './events.ts'
import { newId } from './ids.ts'
import { sleep, withTimeout } from './lib/http.ts'
import type { Logger } from './lib/log.ts'
import type { Notifier } from './notify.ts'
import type { Registry } from './registry.ts'
import { grabSnapshot } from './snapshot.ts'
import type { WifiMover } from './wifi.ts'

export interface VideoLike {
  snapshot(deviceId: string): Promise<Snapshot | null>
}

export interface ActionQueueDeps {
  db: DB
  registry: Registry
  devices: DeviceManager
  bus: Bus
  events: EventLog
  notifier: Notifier
  wifi: WifiMover
  video: VideoLike | null
  log: Logger
  config: Config
}

export class ActionError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message)
  }
}

/** Which capability an action needs. Absent = always allowed. */
const NEEDS: Partial<Record<ActionType, Capability[]>> = {
  'power.on': ['power'],
  'power.off': ['power'],
  'power.toggle': ['power'],
  'dim.set': ['dim'],
  'color.set': ['color'],
  'gate.open': ['gate'],
  'gate.close': ['gate'],
  'gate.stop': ['gate'],
  'gate.pulse': ['gate'],
  'ptz.move': ['ptz'],
  'ptz.stop': ['ptz'],
  'ptz.preset': ['presets'],
  snapshot: ['snapshot', 'stream'],
  reboot: ['reboot'],
  'wifi.set': ['wifi'],
  'wifi.scan': ['wifi-scan'],
}

/** Actions whose completion the owner wants to hear about on the phone. Failures always notify. */
const NOTIFY_DONE = new Set<ActionType>(['gate.open', 'gate.close', 'gate.stop', 'gate.pulse', 'wifi.set', 'reboot', 'path.switch', 'sms.send', 'custom'])

const SNAPSHOTS_KEPT = 300

/**
 * Every command goes through here: it is stored, run over the device's live
 * path (with one automatic retry after a failover), tracked to completion and
 * announced — in the app and, for the actions that matter, as a push
 * notification.
 */
export class ActionQueue {
  private chains = new Map<string, Promise<unknown>>()
  /** The newest gate command per device, so an older one knows it was overtaken. */
  private latestGate = new Map<string, string>()
  private readonly log: Logger
  private readonly snapshotDir: string

  constructor(private readonly deps: ActionQueueDeps) {
    this.log = deps.log.child('actions')
    this.snapshotDir = path.join(deps.config.dataDir, 'snapshots')
    fs.mkdirSync(this.snapshotDir, { recursive: true })
    this.failInterrupted()
  }

  // ----------------------------------------------------------------- public

  request(deviceId: string, req: ActionRequest, source: Action['source'] = 'app'): Action {
    const device = this.deps.registry.getDevice(deviceId)
    if (!device) throw new ActionError('Device not found', 404)
    if (!ACTION_TYPES.includes(req.type)) throw new ActionError(`Unknown action "${String(req.type)}"`)
    const needs = NEEDS[req.type]
    if (needs && !needs.some((c) => device.capabilities.includes(c))) {
      throw new ActionError(`${device.name} cannot ${ACTION_LABELS[req.type].toLowerCase()}`)
    }
    const params = req.params ?? {}
    const action: Action = {
      id: newId('act'),
      deviceId,
      type: req.type,
      params,
      status: 'queued',
      pathId: null,
      label: this.labelFor(device, req.type, params),
      source,
      requestedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    }
    this.insert(action)
    this.deps.bus.emit('action', action)
    if (isGateMove(req.type)) this.latestGate.set(deviceId, action.id)
    // One command at a time per device, in the order asked. The slot is released
    // as soon as a command has been DELIVERED: a gate that is still travelling
    // must not hold back the Stop (or Close) tapped after it.
    const prev = this.chains.get(deviceId) ?? Promise.resolve()
    const next = prev.then(
      () =>
        new Promise<void>((release) => {
          void this.run(action, release)
            .catch((err) => this.log.error(`action ${action.id} crashed`, err))
            .finally(release)
        }),
    )
    this.chains.set(deviceId, next)
    return action
  }

  get(id: string): Action | null {
    const row = this.deps.db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Row | undefined
    return row ? rowToAction(row) : null
  }

  list(opts: { deviceId?: string | null; limit?: number } = {}): Action[] {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 50))
    const rows = (
      opts.deviceId
        ? this.deps.db.prepare('SELECT * FROM actions WHERE device_id = ? ORDER BY requested_at DESC LIMIT ?').all(opts.deviceId, limit)
        : this.deps.db.prepare('SELECT * FROM actions ORDER BY requested_at DESC LIMIT ?').all(limit)
    ) as Row[]
    return rows.map(rowToAction)
  }

  /** The owner tells us how a hand-off (SMS from the phone) went. */
  confirm(id: string, ok: boolean): Action {
    const action = this.get(id)
    if (!action) throw new ActionError('Action not found', 404)
    if (action.status !== 'needs-confirmation') throw new ActionError('This action is not waiting for confirmation')
    const done = { ...action, status: (ok ? 'done' : 'failed') as ActionStatus, finishedAt: nowIso(), error: ok ? null : 'Not sent' }
    this.update(done)
    this.deps.events.record({
      deviceId: action.deviceId,
      level: ok ? 'info' : 'warn',
      type: ok ? 'action.done' : 'action.failed',
      message: `${this.deviceName(action.deviceId)}: ${action.label} ${ok ? 'confirmed' : 'not sent'}`,
    })
    this.deps.bus.emit('action', done)
    return done
  }

  snapshotFile(actionId: string): { file: string; contentType: string } | null {
    if (!/^act_[A-Za-z0-9_-]+$/.test(actionId)) return null
    for (const ext of ['jpg', 'png', 'svg']) {
      const file = path.join(this.snapshotDir, `${actionId}.${ext}`)
      if (fs.existsSync(file)) return { file, contentType: ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'image/svg+xml' }
    }
    return null
  }

  prune(keep = 2000): void {
    this.deps.db.prepare('DELETE FROM actions WHERE id IN (SELECT id FROM actions ORDER BY requested_at DESC LIMIT -1 OFFSET ?)').run(keep)
  }

  // ---------------------------------------------------------------- running

  private async run(action: Action, release: () => void): Promise<void> {
    const running: Action = { ...action, status: 'running', startedAt: nowIso() }
    this.update(running)
    this.deps.bus.emit('action', running)
    let outcome: ActionResult
    let pathId: string | null = null
    try {
      const r = await this.perform(running, release)
      outcome = r.result
      pathId = r.pathId
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const status: ActionStatus = outcome.ok ? (outcome.needsConfirmation ? 'needs-confirmation' : 'done') : 'failed'
    const finished: Action = {
      ...running,
      status,
      pathId,
      finishedAt: status === 'needs-confirmation' ? null : nowIso(),
      result: outcome.result ?? null,
      error: outcome.ok ? null : outcome.error ?? 'Failed',
    }
    this.update(finished)
    this.deps.bus.emit('action', finished)
    this.announce(finished)
  }

  private async perform(action: Action, release: () => void): Promise<{ result: ActionResult; pathId: string | null }> {
    const { devices } = this.deps
    const device = this.deps.registry.getDevice(action.deviceId)
    if (!device) return { result: { ok: false, error: 'Device was removed' }, pathId: null }
    const p = action.params

    switch (action.type) {
      case 'probe': {
        if (typeof p.pathId === 'string') {
          const res = await devices.probePath(device.id, p.pathId)
          return { result: res.ok ? { ok: true, result: { latencyMs: res.latencyMs, unverifiable: res.unverifiable ?? false } } : { ok: false, error: res.error }, pathId: p.pathId }
        }
        const state = await devices.check(device.id, { force: true })
        return { result: state.online ? { ok: true, result: { summary: state.summary } } : { ok: false, error: state.summary }, pathId: state.activePathId }
      }
      case 'path.switch': {
        const pathId = typeof p.pathId === 'string' && p.pathId ? p.pathId : null
        const state = await devices.pinPath(device.id, pathId)
        const ok = !pathId || state.activePathId === pathId
        return {
          result: ok ? { ok: true, result: { summary: state.summary } } : { ok: false, error: `${device.paths.find((x) => x.id === pathId)?.label ?? 'That connection'} is not answering` },
          pathId: state.activePathId,
        }
      }
      case 'wifi.set': {
        const result = await this.deps.wifi.move(device.id, p as { wifiNetworkId?: string; ssid?: string; password?: string })
        return { result, pathId: devices.activePath(device.id)?.id ?? null }
      }
      case 'wifi.scan': {
        const { ctx, path: live } = await this.liveContext(device)
        const adapter = devices.adapterFor(device)
        if (!adapter.scanWifi) return { result: { ok: false, error: 'This device cannot scan for WiFi' }, pathId: live.id }
        const networks = await withTimeout(adapter.scanWifi(ctx), this.deps.config.deviceTimeoutMs * 3, 'WiFi scan')
        return { result: { ok: true, result: { networks } }, pathId: live.id }
      }
      case 'snapshot': {
        if (!devices.activePath(device.id)) await devices.check(device.id, { force: true })
        const got = await grabSnapshot(devices, this.deps.video, device, this.deps.config.deviceTimeoutMs * 2)
        if (!got) return { result: { ok: false, error: 'No picture could be taken' }, pathId: devices.activePath(device.id)?.id ?? null }
        const snap = got.snapshot
        const ext = snap.contentType.includes('svg') ? 'svg' : snap.contentType.includes('png') ? 'png' : 'jpg'
        fs.writeFileSync(path.join(this.snapshotDir, `${action.id}.${ext}`), snap.body)
        this.pruneSnapshots()
        return { result: { ok: true, result: { url: `/api/snapshots/${action.id}`, bytes: snap.body.length } }, pathId: got.pathId }
      }
      default:
        return this.executeWithFailover(device, action, release)
    }
  }

  /** Run an adapter action on the live path; on a transport failure, fail over once and retry. */
  private async executeWithFailover(device: Device, action: Action, release: () => void): Promise<{ result: ActionResult; pathId: string | null }> {
    const { devices } = this.deps
    const adapter = devices.adapterFor(device)
    const first = await this.liveContext(device)
    let live = first.path
    let result: ActionResult
    try {
      result = await withTimeout(adapter.execute(first.ctx, action), this.deps.config.deviceTimeoutMs * 2, action.label)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const alternatives = device.paths.filter((x) => x.enabled && x.id !== live.id)
      if (alternatives.length === 0) return { result: { ok: false, error: message }, pathId: live.id }
      this.log.warn(`${device.name}: ${action.label} failed on ${live.label} (${message}); trying another connection`)
      const state = await devices.check(device.id, { force: true })
      const next = devices.activePath(device.id)
      if (!next || next.id === live.id || !state.online) return { result: { ok: false, error: message }, pathId: live.id }
      live = next
      const ctx = devices.context(devices.unmasked(device.id), live)
      try {
        result = await withTimeout(adapter.execute(ctx, action), this.deps.config.deviceTimeoutMs * 2, action.label)
      } catch (err2) {
        return { result: { ok: false, error: err2 instanceof Error ? err2.message : String(err2) }, pathId: live.id }
      }
    }
    if (result.state) {
      devices.mergeState(device.id, result.state)
      // Carry what the owner cares about into the result so "done" can say what happened.
      const echo: Record<string, unknown> = {}
      if (typeof result.state.power === 'boolean') echo.power = result.state.power
      if (typeof result.state.brightness === 'number') echo.brightness = result.state.brightness
      if (Object.keys(echo).length) result = { ...result, result: { ...echo, ...(result.result ?? {}) } }
    }
    if (result.ok && !result.needsConfirmation && isGateMove(action.type) && device.capabilities.includes('gate-state') && live.kind !== 'sms') {
      // Delivered. Let the next command through (Stop!) while we watch the gate.
      release()
      const final = await this.settleGate(device, action)
      const superseded = this.latestGate.get(device.id) !== action.id
      result = { ...result, result: { ...(result.result ?? {}), gate: final, ...(superseded ? { superseded: true } : {}) } }
      const goal = action.type === 'gate.open' ? 'open' : action.type === 'gate.close' ? 'closed' : null
      if (goal && final !== goal && !superseded && (final === 'open' || final === 'closed' || final === 'stopped')) {
        // A definite reading that is not what was asked for: say so, do not call it done.
        result = {
          ...result,
          ok: false,
          error: final === 'stopped' ? `The gate stopped before it was fully ${goal}` : `The gate did not ${goal === 'closed' ? 'close' : 'open'}. It still reads ${final}.`,
        }
      }
    }
    return { result, pathId: live.id }
  }

  /**
   * Watch the gate until it reaches what was asked for, so "done" means done.
   * A reading that contradicts the goal is normal at first (a closing gate reads
   * "open" until it is shut), so it only counts once the gate has clearly had
   * time to move, or after it was seen moving.
   */
  private async settleGate(device: Device, action: Action): Promise<GateState> {
    const type = action.type
    const goal: GateState | null = type === 'gate.open' ? 'open' : type === 'gate.close' ? 'closed' : null
    const started = Date.now()
    let last: GateState = 'unknown'
    let sawMoving = false
    const settleMs = this.deps.config.gateSettleSec * 1000
    const noMoveMs = this.deps.config.gateNoMoveSec * 1000
    while (Date.now() - started < settleMs) {
      await sleep(1000)
      try {
        const state = await this.deps.devices.refreshState(device.id)
        last = (state.gate as GateState | undefined) ?? 'unknown'
      } catch {
        continue
      }
      const elapsed = Date.now() - started
      const moving = last === 'opening' || last === 'closing'
      if (moving) sawMoving = true
      const terminal = last === 'open' || last === 'closed' || last === 'stopped'
      if (!terminal) continue
      if (last === 'stopped') return last
      if (goal) {
        if (last === goal) return last
        // A later command took over (Stop, or Close after Open): this one will never reach its goal.
        if (this.latestGate.get(device.id) !== action.id) return last
        // It moved and came to rest somewhere else, or it never moved at all.
        if (sawMoving || elapsed >= noMoveMs) return last
        continue
      }
      // Stop / pulse have no target position: report where the gate came to rest.
      if (type === 'gate.stop' || sawMoving || elapsed >= 5000) return last
    }
    return last
  }

  private async liveContext(device: Device): Promise<{ ctx: ReturnType<DeviceManager['context']>; path: ConnectionPath }> {
    const { devices } = this.deps
    let live = devices.activePath(device.id)
    if (!live) {
      await devices.check(device.id, { force: true })
      live = devices.activePath(device.id)
    }
    if (!live) throw new ActionError(`${device.name} is unreachable on all connections`, 503)
    return { ctx: devices.context(devices.unmasked(device.id), live), path: live }
  }

  // ------------------------------------------------------------ announcing

  private announce(action: Action): void {
    const device = this.deps.registry.getDevice(action.deviceId)
    const name = device?.name ?? 'Device'
    const level = device?.notify ?? 'important'
    const body = describeResult(action)
    const chatty = action.type === 'ptz.move' || action.type === 'ptz.stop' || action.type === 'probe' || action.type === 'wifi.scan' || action.type === 'snapshot'
    if (action.status === 'done') {
      if (action.type !== 'snapshot' && chatty) return
      this.deps.events.record({ deviceId: action.deviceId, type: 'action.done', message: `${name}: ${action.label} — ${body}`, data: { actionId: action.id } })
      const push = level === 'everything' ? !chatty : level === 'important' && NOTIFY_DONE.has(action.type)
      // A command overtaken by a later one is not news; the later one reports.
      if (push && action.result?.superseded !== true) {
        void this.deps.notifier.send({ title: `${name}: ${action.label}`, body, tag: `action:${action.deviceId}:${action.type}`, url: `/device/${action.deviceId}`, deviceId: action.deviceId })
      }
    } else if (action.status === 'failed') {
      this.deps.events.record({ deviceId: action.deviceId, level: 'error', type: 'action.failed', message: `${name}: ${action.label} failed — ${action.error}`, data: { actionId: action.id } })
      if (level !== 'none' && action.type !== 'ptz.move' && action.type !== 'ptz.stop' && action.type !== 'probe') {
        void this.deps.notifier.send({ title: `${name}: ${action.label} failed`, body: action.error ?? 'Failed', tag: `action:${action.deviceId}:${action.type}`, url: `/device/${action.deviceId}`, deviceId: action.deviceId, level: 'error' })
      }
    } else if (action.status === 'needs-confirmation') {
      this.deps.events.record({ deviceId: action.deviceId, level: 'warn', type: 'action.needs-confirmation', message: `${name}: ${action.label} needs you — ${body}`, data: { actionId: action.id } })
      // Always sent: the command is stuck until the owner acts.
      void this.deps.notifier.send({ title: `${name}: ${action.label} needs you`, body, tag: `action:${action.deviceId}:${action.type}`, url: `/device/${action.deviceId}`, deviceId: action.deviceId, level: 'warn' })
    }
  }

  private labelFor(device: Device, type: ActionType, params: Record<string, unknown>): string {
    switch (type) {
      case 'wifi.set': {
        const id = typeof params.wifiNetworkId === 'string' ? params.wifiNetworkId : null
        const ssid = id ? this.deps.registry.listWifi().find((w) => w.id === id)?.ssid : (params.ssid as string | undefined)
        return ssid ? `Move to ${ssid}` : ACTION_LABELS[type]
      }
      case 'path.switch': {
        const label = device.paths.find((p) => p.id === params.pathId)?.label
        return label ? `Switch to ${label}` : 'Automatic connection'
      }
      case 'dim.set':
        return `Brightness ${Number(params.brightness ?? 0)}%`
      case 'ptz.preset':
        return `Preset ${String(params.preset ?? '')}`
      default:
        return ACTION_LABELS[type]
    }
  }

  private deviceName(deviceId: string): string {
    return this.deps.registry.getDevice(deviceId)?.name ?? 'Device'
  }

  // ---------------------------------------------------------------- storage

  private insert(a: Action): void {
    this.deps.db
      .prepare(
        `INSERT INTO actions (id, device_id, type, params, status, path_id, label, source, requested_at, started_at, finished_at, result, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.deviceId, a.type, JSON.stringify(a.params), a.status, a.pathId, a.label, a.source, a.requestedAt, a.startedAt, a.finishedAt, a.result ? JSON.stringify(a.result) : null, a.error)
  }

  private update(a: Action): void {
    this.deps.db
      .prepare('UPDATE actions SET status = ?, path_id = ?, started_at = ?, finished_at = ?, result = ?, error = ? WHERE id = ?')
      .run(a.status, a.pathId, a.startedAt, a.finishedAt, a.result ? JSON.stringify(a.result) : null, a.error, a.id)
  }

  /** Anything left "running" by a crash is marked failed so the app is not stuck. */
  private failInterrupted(): void {
    this.deps.db
      .prepare(`UPDATE actions SET status = 'failed', finished_at = ?, error = 'The hub restarted before this finished' WHERE status IN ('queued', 'running')`)
      .run(nowIso())
  }

  private pruneSnapshots(): void {
    const files = fs
      .readdirSync(this.snapshotDir)
      .map((f) => ({ f, t: fs.statSync(path.join(this.snapshotDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(SNAPSHOTS_KEPT)) fs.rmSync(path.join(this.snapshotDir, f), { force: true })
  }
}

function isGateMove(type: ActionType): boolean {
  return type === 'gate.open' || type === 'gate.close' || type === 'gate.pulse' || type === 'gate.stop'
}

function describeResult(a: Action): string {
  const r = a.result ?? {}
  // An adapter's own note is the most truthful account of what happened; it wins.
  const note = typeof r.note === 'string' && r.note ? r.note : null
  if (a.status === 'needs-confirmation') {
    if (note) return note
    if (typeof r.handoff === 'string') {
      return r.handoff.startsWith('tel:') ? 'Call the device from your phone, then confirm in the app.' : 'Send the text from your phone, then confirm in the app.'
    }
    return 'Could not be confirmed automatically.'
  }
  if (r.superseded === true) return 'Changed by a later command'
  if (note) return note
  if (r.via === 'sms') return a.type === 'sms.send' ? 'Text sent' : 'Text sent. The device cannot report back.'
  if (typeof r.gate === 'string') {
    switch (r.gate) {
      case 'open': return 'Gate is open'
      case 'closed': return 'Gate is closed'
      case 'stopped': return 'Gate stopped'
      default: return 'Gate moved (final position unknown)'
    }
  }
  if (a.type === 'dim.set' && typeof r.brightness === 'number') return `Brightness ${r.brightness}%`
  if (typeof r.power === 'boolean') return r.power ? 'Now on' : 'Now off'
  if (a.type === 'wifi.set' && typeof r.ssid === 'string') return `Now on ${r.ssid}`
  if (a.type === 'reboot') return 'Restarting'
  if (a.type === 'path.switch' && a.params.pathId) return 'In use now'
  if (typeof r.summary === 'string') return r.summary
  if (a.type === 'sms.send') return 'Text sent'
  return 'Done'
}

type Row = Record<string, unknown>

function rowToAction(r: Row): Action {
  return {
    id: String(r.id),
    deviceId: String(r.device_id),
    type: r.type as ActionType,
    params: parseJson<Record<string, unknown>>(r.params as string, {}),
    status: r.status as ActionStatus,
    pathId: (r.path_id as string | null) ?? null,
    label: String(r.label),
    source: r.source as Action['source'],
    requestedAt: String(r.requested_at),
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
    result: parseJson<Record<string, unknown> | null>(r.result as string | null, null),
    error: (r.error as string | null) ?? null,
  }
}
