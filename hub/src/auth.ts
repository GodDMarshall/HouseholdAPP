import { hashPin, randomToken, sha256, verifyPin } from './crypto.ts'
import { getSetting, nowIso, setSetting, type DB } from './db.ts'

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status = 401,
  ) {
    super(message)
  }
}

/**
 * One PIN for the house. The first phone to open the app sets it. Every login
 * gets a long-lived token (the phone keeps it); wrong PINs are throttled, on
 * the sign-in screen and on "change PIN" alike.
 */
export class Auth {
  private failures = 0
  private lockedUntil = 0
  private listeners = new Set<(hash: string | null, keep: string | null) => void>()

  constructor(private readonly db: DB) {
    // The wrong-PIN lock survives a restart; restarting the hub is not a way round it.
    const raw = getSetting(db, 'pin_lock')
    if (raw) {
      try {
        const o = JSON.parse(raw) as { failures?: number; lockedUntil?: number }
        this.failures = Number(o.failures) || 0
        this.lockedUntil = Number(o.lockedUntil) || 0
      } catch {
        /* ignore a damaged value */
      }
    }
  }

  /** Told whenever sessions end: one token's hash, or null for all of them except `keep`. Live channels close on it. */
  onRevoke(fn: (hash: string | null, keep: string | null) => void): void {
    this.listeners.add(fn)
  }

  private announce(hash: string | null, keep: string | null): void {
    for (const fn of this.listeners) fn(hash, keep)
  }

  private saveLock(): void {
    setSetting(this.db, 'pin_lock', JSON.stringify({ failures: this.failures, lockedUntil: this.lockedUntil }))
  }

  isConfigured(): boolean {
    return getSetting(this.db, 'pin_hash') !== null
  }

  setup(pin: string, label = ''): string {
    if (this.isConfigured()) throw new AuthError('A PIN is already set', 409)
    validatePin(pin)
    setSetting(this.db, 'pin_hash', hashPin(pin))
    return this.issue(label)
  }

  login(pin: string, label = ''): string {
    const stored = getSetting(this.db, 'pin_hash')
    if (!stored) throw new AuthError('No PIN set yet', 409)
    this.checkPin(pin, stored, 'Wrong PIN')
    return this.issue(label)
  }

  /** Changing the PIN signs every other phone out; pass the caller's token to keep it signed in. */
  changePin(current: string, next: string, keepToken?: string | null): void {
    const stored = getSetting(this.db, 'pin_hash')
    if (!stored) throw new AuthError('No PIN set yet', 409)
    this.checkPin(current, stored, 'Current PIN is wrong')
    validatePin(next)
    if (next === current) throw new AuthError('That is already the PIN', 400)
    setSetting(this.db, 'pin_hash', hashPin(next))
    const keep = keepToken ? sha256(keepToken) : null
    if (keep) this.db.prepare('DELETE FROM sessions WHERE token_hash <> ?').run(keep)
    else this.db.prepare('DELETE FROM sessions').run()
    this.announce(null, keep)
  }

  verify(token: string | undefined | null): boolean {
    if (!token) return false
    const row = this.db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(sha256(token)) as { token_hash: string } | undefined
    if (!row) return false
    this.db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?').run(nowIso(), row.token_hash)
    return true
  }

  revoke(token: string): void {
    const hash = sha256(token)
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash)
    this.announce(hash, null)
  }

  revokeAll(): void {
    this.db.prepare('DELETE FROM sessions').run()
    this.announce(null, null)
  }

  sessions(): { label: string; createdAt: string; lastUsedAt: string }[] {
    const rows = this.db.prepare('SELECT label, created_at, last_used_at FROM sessions ORDER BY created_at ASC').all() as Record<string, string>[]
    return rows.map((r) => ({ label: r.label ?? '', createdAt: r.created_at!, lastUsedAt: r.last_used_at! }))
  }

  /** One throttle for every place a PIN is typed, so none of them is a way round it. */
  private checkPin(pin: string, stored: string, wrongMessage: string): void {
    const now = Date.now()
    if (now < this.lockedUntil) {
      throw new AuthError(`Too many wrong PINs. Try again in ${Math.ceil((this.lockedUntil - now) / 1000)} s`, 429)
    }
    if (!verifyPin(pin, stored)) {
      this.failures += 1
      if (this.failures >= 5) {
        this.lockedUntil = now + Math.min(15 * 60_000, 30_000 * 2 ** (this.failures - 5))
      }
      this.saveLock()
      throw new AuthError(wrongMessage, 401)
    }
    if (this.failures || this.lockedUntil) {
      this.failures = 0
      this.lockedUntil = 0
      this.saveLock()
    }
  }

  private issue(label: string): string {
    const token = randomToken(32)
    const ts = nowIso()
    this.db.prepare('INSERT INTO sessions (token_hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?)').run(sha256(token), label.slice(0, 80), ts, ts)
    return token
  }
}

/** The sign-in keypad has digits only, so the PIN must be something it can type. */
function validatePin(pin: string): void {
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw new AuthError('The PIN must be 4 to 8 digits', 400)
}
