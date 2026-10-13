import {
  DEVICE_KINDS,
  NOTIFY_LEVELS,
  PATH_KINDS,
  SECRET_MASK,
  type ConnectionPath,
  type Device,
  type DeviceInput,
  type FieldSpec,
  type PathInput,
  type WifiNetwork,
  type WifiNetworkInput,
} from '@house/shared'
import { getAdapter } from './adapters/index.ts'
import type { SecretBox } from './crypto.ts'
import { nowIso, parseJson, type DB } from './db.ts'
import type { Bus } from './events.ts'
import { newId } from './ids.ts'

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
  }
}

/** An id that does not exist: the API answers 404, so every verb says the same thing. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
  }
}

/** Limits that keep a typo from becoming a problem. */
const NAME_MAX = 60
const ROOM_MAX = 40
const CONFIG_MAX_BYTES = 16 * 1024
const SORT_MAX = 1_000_000

export interface WifiSecret {
  id: string
  ssid: string
  password: string
}

/**
 * The registry: devices, their connection paths and the house WiFi networks.
 * Secrets are encrypted before they touch the database and masked before they
 * reach the app.
 */
export class Registry {
  constructor(
    private readonly db: DB,
    private readonly box: SecretBox,
    private readonly bus: Bus,
  ) {}

  // ------------------------------------------------------------------ devices

  listDevices(): Device[] {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY sort ASC, created_at ASC').all() as Row[]
    return rows.map((r) => this.rowToDevice(r, true))
  }

  getDevice(id: string): Device | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined
    return row ? this.rowToDevice(row, true) : null
  }

  /** Hub-side only: config with secrets decrypted. Never send to the app. */
  getDeviceUnmasked(id: string): Device | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined
    return row ? this.rowToDevice(row, false) : null
  }

  createDevice(input: DeviceInput): Device {
    const clean = this.validateDevice(input)
    const id = newId('dev')
    const ts = nowIso()
    const storedConfig = this.encryptSecrets(clean.family, clean.config, {})
    const sort = clean.sort ?? this.nextSort()
    this.db.exec('BEGIN;')
    try {
      this.db
        .prepare('INSERT INTO devices (id, name, kind, family, room, config, sort, notify, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, clean.name, clean.kind, clean.family, clean.room, JSON.stringify(storedConfig), sort, clean.notify ?? 'important', ts, ts)
      this.replacePaths(id, clean.paths)
      this.db.prepare('INSERT INTO device_runtime (device_id, updated_at) VALUES (?, ?)').run(id, ts)
      this.db.exec('COMMIT;')
    } catch (err) {
      this.db.exec('ROLLBACK;')
      throw err
    }
    const device = this.getDevice(id)!
    this.bus.emit('device.upsert', device)
    return device
  }

  updateDevice(id: string, input: Partial<DeviceInput>): Device {
    const existing = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined
    if (!existing) throw new NotFoundError('Device not found')
    const familyChanged = input.family !== undefined && input.family !== existing.family
    const merged: DeviceInput = {
      name: input.name ?? String(existing.name),
      kind: input.kind ?? (existing.kind as DeviceInput['kind']),
      family: input.family ?? (existing.family as DeviceInput['family']),
      room: input.room ?? String(existing.room),
      // Settings belong to a family: a different family starts from what was sent for it, never from the old secrets.
      config: familyChanged ? (input.config ?? {}) : (input.config ?? this.decryptConfig(String(existing.family), parseJson(existing.config as string, {}))),
      paths: input.paths ?? this.listPaths(id).map(pathToInput),
      sort: input.sort ?? Number(existing.sort),
      notify: input.notify ?? (existing.notify as DeviceInput['notify']),
    }
    const clean = this.validateDevice(merged)
    const previous = familyChanged ? {} : parseJson<Record<string, unknown>>(existing.config as string, {})
    const storedConfig = this.encryptSecrets(clean.family, clean.config, previous)
    const ts = nowIso()
    this.db.exec('BEGIN;')
    try {
      this.db
        .prepare('UPDATE devices SET name = ?, kind = ?, family = ?, room = ?, config = ?, sort = ?, notify = ?, updated_at = ? WHERE id = ?')
        .run(clean.name, clean.kind, clean.family, clean.room, JSON.stringify(storedConfig), clean.sort ?? 0, clean.notify ?? 'important', ts, id)
      if (input.paths) this.replacePaths(id, clean.paths)
      this.db.exec('COMMIT;')
    } catch (err) {
      this.db.exec('ROLLBACK;')
      throw err
    }
    const device = this.getDevice(id)!
    this.bus.emit('device.upsert', device)
    return device
  }

  deleteDevice(id: string): boolean {
    const res = this.db.prepare('DELETE FROM devices WHERE id = ?').run(id)
    const removed = Number(res.changes) > 0
    if (removed) this.bus.emit('device.remove', id)
    return removed
  }

  reorder(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE devices SET sort = ? WHERE id = ?')
    ids.forEach((id, i) => stmt.run(i, id))
    for (const d of this.listDevices()) this.bus.emit('device.upsert', d)
  }

  // -------------------------------------------------------------------- paths

  listPaths(deviceId: string): ConnectionPath[] {
    const rows = this.db.prepare('SELECT * FROM paths WHERE device_id = ? ORDER BY priority ASC').all(deviceId) as Row[]
    return rows.map(rowToPath)
  }

  getPath(id: string): ConnectionPath | null {
    const row = this.db.prepare('SELECT * FROM paths WHERE id = ?').get(id) as Row | undefined
    return row ? rowToPath(row) : null
  }

  /** Fill in the address of a path once the device has been found on that network. */
  setPathHost(pathId: string, host: string, port?: number | null): ConnectionPath | null {
    this.db.prepare('UPDATE paths SET host = ?, port = COALESCE(?, port) WHERE id = ?').run(host, port ?? null, pathId)
    const p = this.getPath(pathId)
    if (p) {
      const d = this.getDevice(p.deviceId)
      if (d) this.bus.emit('device.upsert', d)
    }
    return p
  }

  private replacePaths(deviceId: string, paths: PathInput[]): void {
    const keep = new Set<string>()
    const mine = new Set((this.db.prepare('SELECT id FROM paths WHERE device_id = ?').all(deviceId) as { id: string }[]).map((r) => r.id))
    const upsert = this.db.prepare(
      `INSERT INTO paths (id, device_id, priority, kind, label, wifi_network_id, host, port, extra, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET priority = excluded.priority, kind = excluded.kind, label = excluded.label,
         wifi_network_id = excluded.wifi_network_id, host = excluded.host, port = excluded.port, extra = excluded.extra, enabled = excluded.enabled`,
    )
    paths.forEach((p, i) => {
      // An id is only an identity for a connection this device already has; anything else is a new connection.
      const id = p.id && mine.has(p.id) && !keep.has(p.id) ? p.id : newId('pth')
      keep.add(id)
      upsert.run(
        id,
        deviceId,
        i,
        p.kind,
        p.label,
        p.wifiNetworkId ?? null,
        p.host?.trim() || null,
        p.port ?? null,
        JSON.stringify(p.extra ?? {}),
        p.enabled === false ? 0 : 1,
      )
    })
    const existing = this.db.prepare('SELECT id FROM paths WHERE device_id = ?').all(deviceId) as { id: string }[]
    const del = this.db.prepare('DELETE FROM paths WHERE id = ?')
    for (const row of existing) if (!keep.has(row.id)) del.run(row.id)
  }

  // --------------------------------------------------------------------- wifi

  listWifi(): WifiNetwork[] {
    const rows = this.db.prepare('SELECT * FROM wifi_networks ORDER BY created_at ASC').all() as Row[]
    return rows.map(rowToWifi)
  }

  /** Hub-side only. */
  getWifiSecret(id: string): WifiSecret | undefined {
    const row = this.db.prepare('SELECT * FROM wifi_networks WHERE id = ?').get(id) as Row | undefined
    if (!row) return undefined
    const enc = row.password_enc as string | null
    return { id: String(row.id), ssid: String(row.ssid), password: enc ? this.box.decrypt(enc) : '' }
  }

  findWifiBySsid(ssid: string): WifiNetwork | undefined {
    return this.listWifi().find((w) => w.ssid === ssid)
  }

  createWifi(input: WifiNetworkInput): WifiNetwork {
    const ssid = (input.ssid ?? '').trim()
    if (!ssid) throw new ValidationError('The network name (SSID) is required')
    if (ssid.length > 32) throw new ValidationError('A WiFi name has 32 characters at most')
    if (typeof input.password === 'string' && input.password.length > 64) throw new ValidationError('A WiFi password has 64 characters at most')
    if (this.findWifiBySsid(ssid)) throw new ValidationError(`"${ssid}" is already in the list`)
    const id = newId('wifi')
    const password = input.password && input.password !== SECRET_MASK ? input.password : ''
    this.db
      .prepare('INSERT INTO wifi_networks (id, ssid, password_enc, notes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, ssid, password ? this.box.encrypt(password) : null, (input.notes ?? '').trim(), nowIso())
    this.emitWifi()
    return this.listWifi().find((w) => w.id === id)!
  }

  updateWifi(id: string, input: WifiNetworkInput): WifiNetwork {
    const row = this.db.prepare('SELECT * FROM wifi_networks WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new NotFoundError('WiFi network not found')
    const ssid = (input.ssid ?? String(row.ssid)).trim()
    if (!ssid) throw new ValidationError('The network name (SSID) is required')
    const clash = this.findWifiBySsid(ssid)
    if (clash && clash.id !== id) throw new ValidationError(`"${ssid}" is already in the list`)
    let passwordEnc = row.password_enc as string | null
    if (input.password !== undefined && input.password !== SECRET_MASK) {
      passwordEnc = input.password ? this.box.encrypt(input.password) : null
    }
    this.db
      .prepare('UPDATE wifi_networks SET ssid = ?, password_enc = ?, notes = ? WHERE id = ?')
      .run(ssid, passwordEnc, (input.notes ?? String(row.notes ?? '')).trim(), id)
    this.emitWifi()
    return this.listWifi().find((w) => w.id === id)!
  }

  deleteWifi(id: string): boolean {
    const res = this.db.prepare('DELETE FROM wifi_networks WHERE id = ?').run(id)
    const removed = Number(res.changes) > 0
    if (removed) {
      this.emitWifi()
      for (const d of this.listDevices()) if (d.paths.some((p) => p.wifiNetworkId === null)) this.bus.emit('device.upsert', d)
    }
    return removed
  }

  private emitWifi(): void {
    this.bus.emit('wifi.networks', this.listWifi())
  }

  // --------------------------------------------------------------- internals

  private nextSort(): number {
    // Read the top position as a REAL: an odd value left by an old build or a hand edit
    // must never throw (an INTEGER past 2^53 does) and must never block the next add.
    let top = -1
    try {
      const row = this.db.prepare('SELECT MAX(CAST(sort AS REAL)) AS top FROM devices').get() as { top: number | null }
      if (typeof row.top === 'number' && Number.isFinite(row.top)) top = row.top
    } catch {
      top = Number.NaN
    }
    const next = top + 1
    return Number.isSafeInteger(next) && next >= 0 && next <= SORT_MAX ? next : this.listDevices().length
  }

  /** Check a device as the form would save it, without saving. Used by "Test the connections". */
  validate(input: DeviceInput): DeviceInput {
    return this.validateDevice(input)
  }

  private validateDevice(input: DeviceInput): DeviceInput {
    const name = (input.name ?? '').trim()
    if (!name) throw new ValidationError('Give the device a name')
    if (name.length > NAME_MAX) throw new ValidationError(`The name is too long (${NAME_MAX} characters at most)`)
    const room = (input.room ?? '').trim()
    if (room.length > ROOM_MAX) throw new ValidationError(`The place name is too long (${ROOM_MAX} characters at most)`)
    if (input.sort !== undefined && (!Number.isInteger(input.sort) || input.sort < 0 || input.sort > SORT_MAX)) throw new ValidationError('Bad position for this device')
    if (!DEVICE_KINDS.includes(input.kind)) throw new ValidationError(`Unknown device kind "${String(input.kind)}"`)
    if (input.notify !== undefined && !NOTIFY_LEVELS.includes(input.notify)) throw new ValidationError(`Unknown notification level "${String(input.notify)}"`)
    let adapter
    try {
      adapter = getAdapter(input.family)
    } catch {
      throw new ValidationError(`Unknown device family "${String(input.family)}"`)
    }
    const desc = adapter.describe()
    if (desc.kinds.length && !desc.kinds.includes(input.kind)) {
      throw new ValidationError(`${desc.label} cannot be a ${input.kind}`)
    }
    const config: Record<string, unknown> = { ...(input.config ?? {}) }
    let bytes = 0
    try {
      bytes = JSON.stringify(config).length
    } catch {
      throw new ValidationError('The settings could not be read')
    }
    if (bytes > CONFIG_MAX_BYTES || depthOf(config) > 4) throw new ValidationError('The settings are too large')
    for (const f of desc.fields) {
      const v = config[f.name]
      const empty = v === undefined || v === null || v === ''
      const shown = !f.showWhen || config[f.showWhen.field] === f.showWhen.equals
      if (f.required && empty && f.default === undefined && shown) throw new ValidationError(`${f.label} is required`)
      if (empty && f.default !== undefined) config[f.name] = f.default
      if (empty) continue
      if (f.type === 'number' && !Number.isFinite(Number(v))) throw new ValidationError(`${f.label} must be a number`)
      if ((f.type === 'text' || f.type === 'password' || f.type === 'textarea') && typeof v !== 'string') throw new ValidationError(`${f.label} must be text`)
      if (f.type === 'select' && f.options && !f.options.some((o) => o.value === String(v))) throw new ValidationError(`${f.label}: "${String(v).slice(0, 40)}" is not one of the choices`)
      if (f.type === 'toggle' && typeof v !== 'boolean' && v !== 'true' && v !== 'false') throw new ValidationError(`${f.label} must be on or off`)
    }
    const paths = (input.paths ?? []).map((p, i) => {
      if (!PATH_KINDS.includes(p.kind)) throw new ValidationError(`Unknown path kind "${String(p.kind)}"`)
      if (desc.pathKinds.length && !desc.pathKinds.includes(p.kind)) throw new ValidationError(`${desc.label} cannot be reached by ${p.kind}`)
      const label = (p.label ?? '').trim() || defaultPathLabel(p)
      if (p.kind === 'sms' && !(p.host ?? '').trim()) throw new ValidationError('An SMS path needs the device’s phone number')
      if (p.port !== undefined && p.port !== null && (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) {
        throw new ValidationError('Port must be between 1 and 65535')
      }
      if (typeof p.host === 'string' && p.host.length > 253) throw new ValidationError('The address is too long')
      if (label.length > NAME_MAX) throw new ValidationError('A connection name is too long')
      // A WiFi network that no longer exists (deleted on another phone) simply means "wired / not a stored WiFi".
      const wifiNetworkId = p.kind === 'lan' && p.wifiNetworkId && this.db.prepare('SELECT 1 FROM wifi_networks WHERE id = ?').get(p.wifiNetworkId) ? p.wifiNetworkId : null
      return { ...p, label, priority: i, wifiNetworkId, extra: p.extra && typeof p.extra === 'object' ? p.extra : {}, port: p.port ?? (p.kind === 'lan' || p.kind === 'cellular' ? desc.defaultPort : null) }
    })
    if (paths.length > 12) throw new ValidationError('A device can have twelve connections at most')
    return { ...input, name, room, config, paths }
  }

  private secretFields(family: string): FieldSpec[] {
    try {
      return getAdapter(family)
        .describe()
        .fields.filter((f) => f.secret)
    } catch {
      return []
    }
  }

  private encryptSecrets(family: string, config: Record<string, unknown>, previousStored: Record<string, unknown>): Record<string, unknown> {
    const out = { ...config }
    for (const f of this.secretFields(family)) {
      const v = out[f.name]
      if (v === SECRET_MASK) out[f.name] = previousStored[f.name] ?? ''
      else if (typeof v === 'string' && v.length > 0) out[f.name] = this.box.encrypt(v)
      else if (v === undefined || v === null) out[f.name] = ''
    }
    return out
  }

  private decryptConfig(family: string, stored: Record<string, unknown>): Record<string, unknown> {
    const out = { ...stored }
    for (const f of this.secretFields(family)) {
      const v = out[f.name]
      if (typeof v === 'string' && this.box.isEncrypted(v)) out[f.name] = this.box.decrypt(v)
    }
    return out
  }

  private maskConfig(family: string, stored: Record<string, unknown>): Record<string, unknown> {
    const out = { ...stored }
    for (const f of this.secretFields(family)) {
      const v = out[f.name]
      out[f.name] = typeof v === 'string' && v.length > 0 ? SECRET_MASK : ''
    }
    return out
  }

  private rowToDevice(r: Row, masked: boolean): Device {
    const family = String(r.family) as Device['family']
    const stored = parseJson<Record<string, unknown>>(r.config as string, {})
    const config = masked ? this.maskConfig(family, stored) : this.decryptConfig(family, stored)
    let capabilities: Device['capabilities'] = []
    try {
      capabilities = getAdapter(family).capabilities(this.decryptConfig(family, stored), r.kind as Device['kind'])
    } catch {
      capabilities = []
    }
    return {
      id: String(r.id),
      name: String(r.name),
      kind: r.kind as Device['kind'],
      family,
      room: String(r.room ?? ''),
      notify: NOTIFY_LEVELS.includes(r.notify as Device['notify']) ? (r.notify as Device['notify']) : 'important',
      config,
      capabilities,
      paths: this.listPaths(String(r.id)),
      sort: Number(r.sort ?? 0),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }
  }
}

type Row = Record<string, unknown>

function depthOf(v: unknown, d = 0): number {
  if (!v || typeof v !== 'object') return d
  let max = d + 1
  for (const x of Object.values(v as Record<string, unknown>)) max = Math.max(max, depthOf(x, d + 1))
  return max
}

function rowToPath(r: Row): ConnectionPath {
  return {
    id: String(r.id),
    deviceId: String(r.device_id),
    priority: Number(r.priority),
    kind: r.kind as ConnectionPath['kind'],
    label: String(r.label),
    wifiNetworkId: (r.wifi_network_id as string | null) ?? null,
    host: (r.host as string | null) ?? null,
    port: r.port === null || r.port === undefined ? null : Number(r.port),
    extra: parseJson<Record<string, unknown>>(r.extra as string, {}),
    enabled: Number(r.enabled) !== 0,
  }
}

function rowToWifi(r: Row): WifiNetwork {
  return {
    id: String(r.id),
    ssid: String(r.ssid),
    hasPassword: Boolean(r.password_enc),
    notes: String(r.notes ?? ''),
    createdAt: String(r.created_at),
  }
}

export function pathToInput(p: ConnectionPath): PathInput {
  return {
    id: p.id,
    priority: p.priority,
    kind: p.kind,
    label: p.label,
    wifiNetworkId: p.wifiNetworkId,
    host: p.host,
    port: p.port,
    extra: p.extra,
    enabled: p.enabled,
  }
}

function defaultPathLabel(p: PathInput): string {
  switch (p.kind) {
    case 'lan': return 'WiFi'
    case 'cellular': return 'SIM'
    case 'cloud': return 'Cloud'
    case 'sms': return 'SMS'
  }
}
