import type { Device, DiscoveredDevice } from '@house/shared'
import type { ActionResult } from './adapters/types.ts'
import type { Config } from './config.ts'
import type { DeviceManager } from './devices.ts'
import type { EventLog } from './events.ts'
import { sleep, withTimeout } from './lib/http.ts'
import type { Logger } from './lib/log.ts'
import type { Notifier } from './notify.ts'
import { pathToInput, type Registry } from './registry.ts'

export interface WifiMoverDeps {
  registry: Registry
  devices: DeviceManager
  events: EventLog
  notifier: Notifier
  log: Logger
  config: Config
}

const WAIT_TOTAL_MS = 90_000
const POLL_MS = 4_000
const DISCOVER_AT_MS = [15_000, 40_000, 65_000]

/**
 * "Move to WiFi": tell the device to join another house network, then wait for
 * it to show up there — on the address we already know, or by discovering it —
 * and switch the live path over.
 */
export class WifiMover {
  private readonly log: Logger

  constructor(private readonly deps: WifiMoverDeps) {
    this.log = deps.log.child('wifi')
  }

  async move(deviceId: string, params: { wifiNetworkId?: string; ssid?: string; password?: string }): Promise<ActionResult> {
    const { registry, devices } = this.deps
    const device = registry.getDevice(deviceId)
    if (!device) return { ok: false, error: 'Device not found' }
    const adapter = devices.adapterFor(device)
    if (!adapter.setWifi) return { ok: false, error: `${device.name} cannot be re-pointed from here. Use its own app to change its WiFi.` }

    // Which network?
    let networkId: string | null = null
    let ssid = ''
    let password = ''
    if (params.wifiNetworkId) {
      const w = registry.getWifiSecret(params.wifiNetworkId)
      if (!w) return { ok: false, error: 'That WiFi network is not in the list' }
      networkId = w.id
      ssid = w.ssid
      password = w.password
    } else if (params.ssid) {
      ssid = params.ssid.trim()
      password = params.password ?? ''
      const known = registry.findWifiBySsid(ssid)
      if (known) {
        networkId = known.id
        if (!password) password = registry.getWifiSecret(known.id)?.password ?? ''
      }
    }
    if (!ssid) return { ok: false, error: 'Choose a WiFi network' }
    if (!password) return { ok: false, error: `No password stored for "${ssid}". Add it under WiFi networks first.` }

    const current = devices.activePath(deviceId)
    if (!current) {
      await devices.check(deviceId, { force: true })
    }
    const live = devices.activePath(deviceId)
    if (!live) return { ok: false, error: `${device.name} is unreachable, so it cannot be told to move` }
    if (live.kind === 'lan' && live.wifiNetworkId && live.wifiNetworkId === networkId) {
      return { ok: true, result: { ssid, alreadyThere: true }, state: { wifi: ssid } }
    }

    // Remember what we know about the device's identity before it goes away.
    const before = devices.getState(deviceId)?.state ?? {}
    const identity = pickIdentity(before)

    const unmasked = devices.unmasked(deviceId)
    const told = await withTimeout(adapter.setWifi(devices.context(unmasked, live), { ssid, password }), this.deps.config.deviceTimeoutMs * 2, 'Telling the device to move')
    if (!told.ok) return told
    this.deps.events.record({ deviceId, type: 'wifi.moving', message: `${device.name} told to join "${ssid}". Waiting for it to come back…`, data: { ssid } })
    if (told.state) devices.mergeState(deviceId, told.state)

    // Make sure there is a path for the target network.
    let target = device.paths.find((p) => p.kind === 'lan' && networkId && p.wifiNetworkId === networkId) ?? null
    if (!target && networkId) {
      const guessHost = live.kind === 'lan' ? live.host : null
      const paths = [...device.paths.map(pathToInput), { priority: device.paths.length, kind: 'lan' as const, label: ssid, wifiNetworkId: networkId, host: guessHost, port: live.port, enabled: true }]
      const updated = registry.updateDevice(deviceId, { paths })
      target = updated.paths.find((p) => p.kind === 'lan' && p.wifiNetworkId === networkId) ?? null
    }
    if (!target) {
      return { ok: true, needsConfirmation: true, result: { ssid, note: `"${ssid}" is not one of the stored WiFi networks, so the hub cannot look for the device there. Add the network and a path for it.` } }
    }

    // Wait for it to come back on the target network.
    const started = Date.now()
    let discoverIdx = 0
    while (Date.now() - started < WAIT_TOTAL_MS) {
      await sleep(POLL_MS)
      const fresh = registry.getDevice(deviceId)
      const tp = fresh?.paths.find((p) => p.id === target!.id)
      if (!fresh || !tp) return { ok: false, error: 'Device changed while moving' }
      if (tp.host) {
        const res = await devices.probePath(deviceId, tp.id).catch(() => ({ ok: false }))
        if (res.ok) {
          await devices.check(deviceId, { force: true })
          const nowLive = devices.activePath(deviceId)
          const onTarget = nowLive?.id === tp.id
          this.deps.events.record({ deviceId, type: 'wifi.moved', message: `${device.name} is now on "${ssid}" at ${tp.host}`, data: { ssid, host: tp.host } })
          return { ok: true, result: { ssid, host: tp.host, onTarget }, state: { wifi: ssid } }
        }
      }
      const elapsed = Date.now() - started
      if (discoverIdx < DISCOVER_AT_MS.length && elapsed >= DISCOVER_AT_MS[discoverIdx]! && adapter.discover) {
        discoverIdx += 1
        const found = await this.findOnNetwork(fresh, identity, tp.host)
        if (found) {
          registry.setPathHost(tp.id, found.host, found.port ?? undefined)
          this.log.info(`${device.name} found at ${found.host} after moving to "${ssid}"`)
        }
      }
    }
    return {
      ok: true,
      needsConfirmation: true,
      result: { ssid, note: `${device.name} was told to join "${ssid}" but has not been found there yet. If it is on that network, enter its new address on the "${ssid}" path.` },
    }
  }

  /** Discover devices of the same family and probe candidates with this device's credentials. */
  private async findOnNetwork(device: Device, identity: Record<string, string>, knownHost: string | null): Promise<DiscoveredDevice | null> {
    const { devices } = this.deps
    const adapter = devices.adapterFor(device)
    if (!adapter.discover) return null
    let candidates: DiscoveredDevice[]
    try {
      candidates = await adapter.discover(4, this.log)
    } catch (err) {
      this.log.debug('discovery failed', err instanceof Error ? err.message : err)
      return null
    }
    const unmasked = devices.unmasked(device.id)
    for (const c of candidates) {
      if (c.host === knownHost) continue
      const probePath = { ...device.paths[0]!, id: 'probe', host: c.host, port: c.port ?? device.paths[0]!.port, kind: 'lan' as const }
      try {
        const res = await withTimeout(adapter.probe(devices.context(unmasked, probePath)), this.deps.config.deviceTimeoutMs, 'Probing candidate')
        if (!res.ok) continue
        const info = pickIdentity(res.info ?? {})
        const keys = Object.keys(identity).filter((k) => info[k])
        if (keys.length && keys.some((k) => info[k] !== identity[k])) continue
        return c
      } catch {
        continue
      }
    }
    return null
  }
}

function pickIdentity(state: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ['serial', 'mac', 'deviceId', 'hardwareId']) {
    const v = state[k]
    if (typeof v === 'string' && v) out[k] = v.toLowerCase()
  }
  return out
}
