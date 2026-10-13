import { EventEmitter } from 'node:events'
import type { Action, Device, DeviceState, DiscoverProgress, EventLevel, EventRecord, HubStatus, WifiNetwork } from '@house/shared'
import { nowIso, parseJson, type DB } from './db.ts'
import { newId } from './ids.ts'

export interface BusEvents {
  event: EventRecord
  'device.state': DeviceState
  'device.upsert': Device
  'device.remove': string
  action: Action
  'wifi.networks': WifiNetwork[]
  'hub.status': HubStatus
  discover: DiscoverProgress
}

/** Typed in-process event bus. The WebSocket layer relays these to the app. */
export class Bus {
  private em = new EventEmitter()

  constructor() {
    this.em.setMaxListeners(100)
  }

  on<K extends keyof BusEvents>(key: K, fn: (payload: BusEvents[K]) => void): () => void {
    this.em.on(key, fn)
    return () => this.em.off(key, fn)
  }

  emit<K extends keyof BusEvents>(key: K, payload: BusEvents[K]): void {
    this.em.emit(key, payload)
  }
}

export interface EventInput {
  deviceId?: string | null
  level?: EventLevel
  type: string
  message: string
  data?: Record<string, unknown> | null
}

/** The activity feed: persisted and broadcast. */
export class EventLog {
  constructor(
    private readonly db: DB,
    private readonly bus: Bus,
  ) {}

  record(input: EventInput): EventRecord {
    const event: EventRecord = {
      id: newId('evt'),
      ts: nowIso(),
      deviceId: input.deviceId ?? null,
      level: input.level ?? 'info',
      type: input.type,
      message: input.message,
      data: input.data ?? null,
    }
    this.db
      .prepare('INSERT INTO events (id, ts, device_id, level, type, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(event.id, event.ts, event.deviceId, event.level, event.type, event.message, event.data ? JSON.stringify(event.data) : null)
    this.bus.emit('event', event)
    return event
  }

  list(opts: { limit?: number; deviceId?: string | null; before?: string | null } = {}): EventRecord[] {
    const limit = Math.floor(Math.min(500, Math.max(1, opts.limit ?? 100)))
    const where: string[] = []
    const args: (string | number)[] = []
    if (opts.deviceId) {
      where.push('device_id = ?')
      args.push(opts.deviceId)
    }
    if (opts.before) {
      where.push('ts < ?')
      args.push(opts.before)
    }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`
    args.push(limit)
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>
    return rows.map(rowToEvent)
  }

  /** Keep the feed from growing forever. */
  prune(keep = 5000): void {
    this.db
      .prepare('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY ts DESC LIMIT -1 OFFSET ?)')
      .run(keep)
  }
}

function rowToEvent(r: Record<string, unknown>): EventRecord {
  return {
    id: String(r.id),
    ts: String(r.ts),
    deviceId: (r.device_id as string | null) ?? null,
    level: r.level as EventLevel,
    type: String(r.type),
    message: String(r.message),
    data: parseJson<Record<string, unknown> | null>(r.data as string | null, null),
  }
}
