import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

// node:sqlite is loaded through require so bundlers and test runners that do not
// know this built-in yet leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

export type DB = DatabaseSyncType

const MIGRATIONS: string[] = [
  // v1 — the registry
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE wifi_networks (
    id TEXT PRIMARY KEY,
    ssid TEXT NOT NULL,
    password_enc TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    family TEXT NOT NULL,
    room TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL DEFAULT '{}',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE paths (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    wifi_network_id TEXT REFERENCES wifi_networks(id) ON DELETE SET NULL,
    host TEXT,
    port INTEGER,
    extra TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX paths_device ON paths(device_id, priority);
  CREATE TABLE device_runtime (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    active_path_id TEXT,
    pinned_path_id TEXT,
    state TEXT NOT NULL DEFAULT '{}',
    last_seen_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    path_id TEXT,
    label TEXT NOT NULL,
    source TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    result TEXT,
    error TEXT
  );
  CREATE INDEX actions_device ON actions(device_id, requested_at);
  CREATE INDEX actions_requested ON actions(requested_at);
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    device_id TEXT,
    level TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX events_ts ON events(ts);
  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    subscription TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
  );
  `,
  // v2 — per-device notification level
  `
  ALTER TABLE devices ADD COLUMN notify TEXT NOT NULL DEFAULT 'important';
  `,
]

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 3000;')
  migrate(db)
  return db
}

function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);')
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined
  let version = row?.version ?? 0
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!
    db.exec('BEGIN;')
    try {
      db.exec(sql)
      version += 1
      db.prepare('UPDATE schema_version SET version = ?').run(version)
      db.exec('COMMIT;')
    } catch (err) {
      db.exec('ROLLBACK;')
      throw err
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
