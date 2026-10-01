import type { ConnectionPath, Device, DiscoveredDevice } from '@house/shared'
import type { ActionResult, ProbeResult } from './adapters/types.ts'
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

const POLL_MS = 4_000
const DISCOVER_AT_MS = [15_000, 40_000, 65_000]

/**
 * "Move to WiFi": tell the device to join another house network, then wait for
 * it to show up there and switch the live path over. Success is only reported
 * when the device is known to be on the new network: it says so itself, or it
 * answers at an address it did not have before.
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

    if (!devices.activePath(deviceId)) await devices.check(deviceId, { force: true })
    const live = devices.activePath(deviceId)
    if (!live) return { ok: false, error: `${device.name} is unreachable, so it cannot be told to move` }
    if (live.kind === 'lan' && live.wifiNetworkId && live.wifiNetworkId === networkId) {
      return { ok: true, result: { ssid, alreadyThere: true }, state: { wifi: ssid } }
    }

    // What we know about the device before it goes away.
    const identity = pickIdentity(devices.getState(deviceId)?.state ?? {})
    const oldHost = live.kind === 'lan' ? live.host : null

    const unmasked = devices.unmasked(deviceId)
    const told = await withTimeout(adapter.setWifi(devices.context(unmasked, live), { ssid, password }), this.deps.config.deviceTimeoutMs * 2, 'Telling the device to move')
    if (!told.ok) return told
    this.deps.events.record({ deviceId, type: 'wifi.moving', message: `${device.name} told to join "${ssid}". Waiting for it to come back…`, data: { ssid } })

    // A path for the target network: next to the other WiFi paths, ahead of SIM / cloud / SMS.
    let target = device.paths.find((p) => p.kind === 'lan' && networkId && p.wifiNetworkId === networkId) ?? null
    let created = false
    if (!target && networkId) {
      const inputs = device.paths.map(pathToInput)
      const at = device.paths.map((p) => p.kind).lastIndexOf('lan') + 1
      inputs.splice(at, 0, { priority: at, kind: 'lan' as const, label: ssid, wifiNetworkId: networkId, host: oldHost, port: live.port, enabled: true })
      const updated = registry.updateDevice(deviceId, { paths: inputs })
      target = updated.paths.find((p) => p.kind === 'lan' && p.wifiNetworkId === networkId) ?? null
      created = true
    }
    if (!target) {
      return { ok: true, needsConfirmation: true, result: { ssid, note: `"${ssid}" is not one of the stored WiFi networks, so the hub cannot look for the device there. Add the network and a connection for it.` } }
    }
    const targetId = target.id

    const started = Date.now()
    let discoverIdx = 0
    let lastSsid: string | null = null
    let stillOld = 0
    const waitTotalMs = this.deps.config.wifiMoveWaitSec * 1000
    const stillOldAfterMs = this.deps.config.wifiStillOldSec * 1000
    while (Date.now() - started < waitTotalMs) {
      await sleep(POLL_MS)
      const fresh = registry.getDevice(deviceId)
      const tp = fresh?.paths.find((p) => p.id === targetId)
      if (!fresh || !tp) return { ok: false, error: `${device.name} was changed while it was moving` }
      const elapsed = Date.now() - started

      if (tp.host) {
        const res = await devices.probePath(deviceId, tp.id).catch((): ProbeResult => ({ ok: false, latencyMs: null }))
        if (res.ok) {
          const seen = await this.reportedSsid(fresh, tp, res)
          if (seen === ssid || (seen === null && tp.host !== oldHost)) {
            await devices.check(deviceId, { force: true })
            const onTarget = devices.activePath(deviceId)?.id === tp.id
            devices.mergeState(deviceId, { wifi: ssid })
            this.deps.events.record({ deviceId, type: 'wifi.moved', message: `${device.name} is now on "${ssid}" at ${tp.host}`, data: { ssid, host: tp.host } })
            return { ok: true, result: { ssid, host: tp.host, onTarget }, state: { wifi: ssid } }
          }
          if (seen !== null) {
            // Answering, and telling us it is somewhere else.
            lastSsid = seen
            stillOld += 1
            if (elapsed >= stillOldAfterMs && stillOld >= 2) break
          }
        }
      }
      // Not found on the new network: is it simply back where it was?
      if (elapsed >= stillOldAfterMs && live.kind === 'lan' && live.id !== tp.id && fresh.paths.some((p) => p.id === live.id)) {
        const old = await devices.probePath(deviceId, live.id).catch((): ProbeResult => ({ ok: false, latencyMs: null }))
        if (old.ok) {
          const seen = await this.reportedSsid(fresh, live, old)
          if (seen !== ssid) {
            lastSsid = seen ?? (live.wifiNetworkId ? registry.getWifiSecret(live.wifiNetworkId)?.ssid ?? live.label : live.label)
            stillOld += 1
            if (stillOld >= 2) break
          }
        }
      }

      if (discoverIdx < DISCOVER_AT_MS.length && elapsed >= DISCOVER_AT_MS[discoverIdx]! && adapter.discover) {
        discoverIdx += 1
        const found = await this.findOnNetwork(fresh, identity, tp.host)
        if (found) {
          registry.setPathHost(tp.id, found.host, found.port ?? undefined)
          this.log.info(`${device.name} found at ${found.host} after moving to "${ssid}"`)
        }
      }
    }

    if (lastSsid && lastSsid !== ssid) {
      // It came back on its old network: the move did not happen. Do not leave a phantom connection behind.
      if (created) this.removePath(deviceId, targetId)
      await devices.check(deviceId, { force: true }).catch(() => undefined)
      return { ok: false, error: `${device.name} did not join "${ssid}" and is still on "${lastSsid}". Check the password stored for "${ssid}".` }
    }
    const answersAtOldAddress = Boolean(oldHost) && registry.getPath(targetId)?.host === oldHost
    return {
      ok: true,
      needsConfirmation: true,
      result: {
        ssid,
        note: answersAtOldAddress
          ? `${device.name} was told to join "${ssid}", but the hub cannot tell which network it is on now. If it is on "${ssid}", confirm; if its address changed, enter the new one on the "${ssid}" connection.`
          : `${device.name} was told to join "${ssid}" but has not been found there yet. If it is on that network, enter its new address on the "${ssid}" connection.`,
      },
    }
  }

  /** The network the device itself says it is on, read over the given path. Null when it cannot say. */
  private async reportedSsid(device: Device, path: ConnectionPath, probe: ProbeResult): Promise<string | null> {
    if (typeof probe.info?.wifi === 'string' && probe.info.wifi) return probe.info.wifi
    const { devices } = this.deps
    const adapter = devices.adapterFor(device)
    if (!adapter.readState) return null
    try {
      const st = await withTimeout(adapter.readState(devices.context(devices.unmasked(device.id), path)), this.deps.config.deviceTimeoutMs, 'Reading state')
      return typeof st.wifi === 'string' && st.wifi ? st.wifi : null
    } catch {
      return null
    }
  }

  private removePath(deviceId: string, pathId: string): void {
    const device = this.deps.registry.getDevice(deviceId)
    if (!device) return
    this.deps.registry.updateDevice(deviceId, { paths: device.paths.filter((p) => p.id !== pathId).map(pathToInput) })
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
    const base = device.paths[0]
    if (!base) return null
    const unmasked = devices.unmasked(device.id)
    for (const c of candidates) {
      if (c.host === knownHost) continue
      const probePath = { ...base, id: 'probe', host: c.host, port: c.port ?? base.port, kind: 'lan' as const }
      try {
        const res = await withTimeout(adapter.probe(devices.context(unmasked, probePath)), this.deps.config.deviceTimeoutMs, 'Probing candidate')
        if (!res.ok) continue
        // Only accept a candidate that can be told apart: same serial / MAC as before.
        const info = pickIdentity(res.info ?? {})
        const keys = Object.keys(identity).filter((k) => info[k])
        if (keys.length === 0 || keys.some((k) => info[k] !== identity[k])) continue
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
