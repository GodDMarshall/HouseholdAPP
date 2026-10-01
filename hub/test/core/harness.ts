import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Action, Device, DeviceInput, EventRecord } from '@house/shared'
import { resetVirtualRuntimes } from '../../src/adapters/virtual.ts'
import { config as baseConfig, type Config } from '../../src/config.ts'
import { createHub, type Hub } from '../../src/hub.ts'
import { setLogLevel } from '../../src/lib/log.ts'

setLogLevel('error')

export interface TestHub {
  hub: Hub
  dir: string
  events: EventRecord[]
  pushes: Array<{ title: string; body: string }>
  home: string
  backup: string
  close(): Promise<void>
  /** Add an illustrative device with sensible paths. */
  add(input: Partial<DeviceInput> & { name: string; simulate: 'camera' | 'gate' | 'light' | 'dimmer'; config?: Record<string, unknown> }): Device
  /** Resolve when the action reaches a final (or needs-confirmation) state. */
  settle(action: Action, timeoutMs?: number): Promise<Action>
  token(): string
}

/** A hub wired exactly like production, on a temp folder, without listening on a port. */
export async function makeHub(overrides: Partial<Config> = {}): Promise<TestHub> {
  resetVirtualRuntimes()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-test-'))
  const config: Config = {
    ...baseConfig,
    dataDir: dir,
    port: 0,
    host: '127.0.0.1',
    seedVirtual: false,
    probeIntervalSec: 3600,
    failbackEveryTicks: 2,
    deviceTimeoutMs: 1500,
    gateNoMoveSec: 3,
    gateSettleSec: 20,
    wifiMoveWaitSec: 24,
    wifiStillOldSec: 5,
    smsPort: null,
    go2rtcBin: path.join(dir, 'no-go2rtc'),
    appDist: path.join(dir, 'no-dist'),
    ...overrides,
  }
  const hub = await createHub(config)
  // The health loop is wired (so new devices are picked up) but the timer is an hour away.
  hub.devices.start()
  await hub.app.ready()
  const events: EventRecord[] = []
  hub.bus.on('event', (e) => events.push(e))
  const pushes: Array<{ title: string; body: string }> = []
  // Capture push notifications instead of sending them.
  hub.notifier.send = async (p) => {
    pushes.push({ title: p.title, body: p.body })
    return { sent: 1, failed: 0 }
  }
  // With the starter set seeded, its two networks are already there.
  const home = (hub.registry.findWifiBySsid('Home WiFi') ?? hub.registry.createWifi({ ssid: 'Home WiFi', password: 'home-pass' })).id
  const backup = (hub.registry.findWifiBySsid('Backup WiFi') ?? hub.registry.createWifi({ ssid: 'Backup WiFi', password: 'backup-pass' })).id
  let token: string | null = null

  return {
    hub,
    dir,
    events,
    pushes,
    home,
    backup,
    token() {
      if (!token) token = hub.auth.isConfigured() ? hub.auth.login('2468') : hub.auth.setup('2468')
      return token
    },
    add(input) {
      const kind = input.kind ?? (input.simulate === 'camera' ? 'camera' : input.simulate === 'gate' ? 'gate' : 'light')
      const device = hub.registry.createDevice({
        name: input.name,
        kind,
        family: 'virtual',
        room: input.room ?? 'Lab',
        notify: input.notify,
        config: { simulate: input.simulate, ...(input.config ?? {}) },
        paths: input.paths ?? [
          { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: home, host: '192.168.1.10', port: 80 },
          { priority: 1, kind: 'lan', label: 'Backup WiFi', wifiNetworkId: backup, host: '192.168.8.10', port: 80 },
        ],
      })
      return device
    },
    settle(action, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const final = (a: Action | null) => a && (a.status === 'done' || a.status === 'failed' || a.status === 'needs-confirmation')
        const now = hub.actions.get(action.id)
        if (final(now)) return resolve(now!)
        const t = setTimeout(() => {
          off()
          reject(new Error(`action ${action.type} did not settle: ${JSON.stringify(hub.actions.get(action.id))}`))
        }, timeoutMs)
        const off = hub.bus.on('action', (a) => {
          if (a.id === action.id && final(a)) {
            clearTimeout(t)
            off()
            resolve(a)
          }
        })
      })
    },
    async close() {
      hub.devices.stop()
      await hub.app.close().catch(() => undefined)
      try {
        hub.db.close()
      } catch {
        /* already closed */
      }
      resetVirtualRuntimes()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
