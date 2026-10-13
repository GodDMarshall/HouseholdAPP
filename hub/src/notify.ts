import fs from 'node:fs'
import path from 'node:path'
import webpush from 'web-push'
import type { HubStatus } from '@house/shared'
import { nowIso, type DB } from './db.ts'
import { newId } from './ids.ts'
import type { Logger } from './lib/log.ts'
import { ValidationError } from './registry.ts'

export interface PushPayload {
  title: string
  body: string
  /** Collapses repeated notifications of the same thing. */
  tag?: string
  /** Where the app opens when the notification is tapped, e.g. /device/dev_x. */
  url?: string
  deviceId?: string
  level?: 'info' | 'warn' | 'error'
}

/**
 * Web Push to the owner's phones. VAPID keys are generated once and kept in
 * data/vapid.json. Subscriptions live in the database; dead ones are pruned.
 */
export class Notifier {
  private publicKey: string | null = null
  private enabled = false

  constructor(
    private readonly db: DB,
    private readonly dataDir: string,
    private readonly log: Logger,
  ) {}

  init(): void {
    const file = path.join(this.dataDir, 'vapid.json')
    let keys: { publicKey: string; privateKey: string }
    if (fs.existsSync(file)) {
      keys = JSON.parse(fs.readFileSync(file, 'utf8'))
    } else {
      keys = webpush.generateVAPIDKeys()
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 })
      this.log.info('Generated Web Push (VAPID) keys')
    }
    webpush.setVapidDetails('mailto:owner@house.local', keys.publicKey, keys.privateKey)
    this.publicKey = keys.publicKey
    this.enabled = true
  }

  status(): HubStatus['push'] {
    return { enabled: this.enabled, publicKey: this.publicKey, subscriptions: this.count() }
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }
    return Number(row.n)
  }

  subscribe(subscription: webpush.PushSubscription, label = ''): void {
    const endpoint = subscription?.endpoint ?? ''
    const keys = subscription?.keys as { p256dh?: string; auth?: string } | undefined
    if (!/^https:\/\/\S+$/.test(endpoint) || !keys?.p256dh || !keys?.auth) {
      throw new ValidationError('That phone did not give a usable notification address. Turn notifications off and on again.')
    }
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, endpoint, subscription, label, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription, label = excluded.label`,
      )
      .run(newId('sub'), subscription.endpoint, JSON.stringify(subscription), label, nowIso())
  }

  unsubscribe(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
  }

  async send(payload: PushPayload): Promise<{ sent: number; failed: number }> {
    if (!this.enabled) return { sent: 0, failed: 0 }
    const rows = this.db.prepare('SELECT endpoint, subscription FROM push_subscriptions').all() as { endpoint: string; subscription: string }[]
    let sent = 0
    let failed = 0
    await Promise.all(
      rows.map(async (row) => {
        try {
          const sub = JSON.parse(row.subscription) as webpush.PushSubscription
          await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 120, urgency: payload.level === 'error' ? 'high' : 'normal' })
          sent += 1
        } catch (err) {
          failed += 1
          const status = (err as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) {
            this.unsubscribe(row.endpoint)
            this.log.info('Removed a push subscription that no longer exists')
          } else {
            this.log.warn('Push failed', err instanceof Error ? err.message : err)
          }
        }
      }),
    )
    return { sent, failed }
  }
}
