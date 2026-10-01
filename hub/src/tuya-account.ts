import type { Device, DeviceKind, DiscoveredDevice, TuyaAccountDevice, TuyaAccountStatus } from '@house/shared'
import { TUYA_REGIONS, TuyaApiError, tuyaCloudCall, type TuyaCredentials } from './adapters/tuya-cloud.ts'
import type { SecretBox } from './crypto.ts'
import { getSetting, setSetting, type DB } from './db.ts'
import type { Logger } from './lib/log.ts'
import { ValidationError, type Registry } from './registry.ts'

interface Stored {
  accessId: string
  accessSecret: string
  region: string
  /** Custom address, used by tests and private Tuya deployments. */
  apiBase?: string
}

interface CloudDevice {
  id: string
  name?: string
  category?: string
  product_name?: string
  online?: boolean
  local_key?: string
  uid?: string
}

/** What each Tuya category is, and whether this build can drive it. */
const CATEGORIES: Record<string, { label: string; kind: DeviceKind; supported: boolean; light?: boolean }> = {
  ckmkzq: { label: 'Garage door opener', kind: 'gate', supported: true },
  kg: { label: 'Switch', kind: 'switch', supported: true },
  tdq: { label: 'Switch', kind: 'switch', supported: true },
  cz: { label: 'Socket', kind: 'switch', supported: true },
  pc: { label: 'Power strip', kind: 'switch', supported: true },
  dlq: { label: 'Circuit breaker', kind: 'switch', supported: true },
  dj: { label: 'Light', kind: 'light', supported: true, light: true },
  dd: { label: 'Light strip', kind: 'light', supported: true, light: true },
  xdd: { label: 'Ceiling light', kind: 'light', supported: true, light: true },
  fwd: { label: 'Ambience light', kind: 'light', supported: true, light: true },
  dc: { label: 'String lights', kind: 'light', supported: true, light: true },
  tgkg: { label: 'Dimmer switch', kind: 'light', supported: true, light: true },
  tgq: { label: 'Dimmer', kind: 'light', supported: true, light: true },
  sp: { label: 'Camera', kind: 'camera', supported: false },
  mcs: { label: 'Door sensor', kind: 'sensor', supported: false },
  pir: { label: 'Motion sensor', kind: 'sensor', supported: false },
  cl: { label: 'Curtain', kind: 'other', supported: false },
  clkg: { label: 'Curtain switch', kind: 'other', supported: false },
  wk: { label: 'Thermostat', kind: 'other', supported: false },
  kt: { label: 'Air conditioner', kind: 'other', supported: false },
  fs: { label: 'Fan', kind: 'other', supported: false },
}

export interface ImportRequest {
  id: string
  kind?: DeviceKind
  name?: string
  room?: string
}

/**
 * The link to the owner's Smart Life / Tuya account. With it the hub can list
 * the account's devices with their names and fetch the key each one needs for
 * control inside the house, so adding a Smart Life device is one tap instead of
 * copying codes by hand. The credentials are stored encrypted and never leave
 * the hub.
 */
export class TuyaAccount {
  private cache = new Map<string, CloudDevice>()
  private uid: string | null = null

  constructor(
    private readonly db: DB,
    private readonly box: SecretBox,
    private readonly registry: Registry,
    private readonly log: Logger,
    private readonly timeoutMs: number,
  ) {}

  private stored(): Stored | null {
    const raw = getSetting(this.db, 'tuya_account')
    if (!raw) return null
    try {
      return JSON.parse(this.box.decrypt(raw)) as Stored
    } catch {
      return null
    }
  }

  private cred(s: Stored): TuyaCredentials {
    const base = s.apiBase?.trim() ? s.apiBase.trim().replace(/\/+$/, '') : (TUYA_REGIONS[s.region] ?? TUYA_REGIONS.in!).url
    return { base, accessId: s.accessId, accessSecret: s.accessSecret, timeoutMs: this.timeoutMs }
  }

  status(): TuyaAccountStatus {
    const s = this.stored()
    return { linked: Boolean(s), region: s?.region ?? null, accessIdHint: s ? '…' + s.accessId.slice(-4) : null }
  }

  /** Store the project credentials after proving they work. */
  async link(input: { accessId: string; accessSecret: string; region?: string; apiBase?: string }): Promise<TuyaAccountStatus> {
    const accessId = (input.accessId ?? '').trim()
    const accessSecret = (input.accessSecret ?? '').trim()
    const region = (input.region ?? 'in').trim() || 'in'
    if (!accessId || !accessSecret) throw new ValidationError('Enter both the Access ID and the Access Secret')
    if (!input.apiBase && !TUYA_REGIONS[region]) throw new ValidationError('Unknown region')
    const candidate: Stored = { accessId, accessSecret, region, apiBase: input.apiBase }
    try {
      // Any signed call proves the pair: Tuya checks the signature before it looks at the request.
      await tuyaCloudCall(this.cred(candidate), 'GET', '/v1.0/devices/0000000000000000000000')
    } catch (err) {
      if (!(err instanceof TuyaApiError)) throw new ValidationError(`Could not reach Tuya: ${err instanceof Error ? err.message : String(err)}`)
      // 1004 sign invalid, 1005/2009 client id invalid, 1106 no permission, 28841xxx no subscription.
      if ([1004, 1005, 2009, 1001, 1002].includes(err.code)) throw new ValidationError('Tuya refused that Access ID and Secret. Copy both again from the project’s Overview page.')
      if (String(err.code).startsWith('2884')) throw new ValidationError('The Tuya project has no IoT Core service yet. Add it under Service API in the project, then try again.')
      // Any other refusal (device not found, permission on that id) means the credentials themselves were accepted.
    }
    setSetting(this.db, 'tuya_account', this.box.encrypt(JSON.stringify(candidate)))
    this.cache.clear()
    this.uid = null
    return this.status()
  }

  unlink(): void {
    this.db.prepare("DELETE FROM settings WHERE key = 'tuya_account'").run()
    this.cache.clear()
    this.uid = null
  }

  /**
   * The account's devices. Tuya only lists them for the app account's user id,
   * which is learned from any one device the hub already knows: one it heard on
   * the house network, one already added, or an id the owner typed.
   */
  async devices(lan: DiscoveredDevice[], hintDeviceId?: string): Promise<TuyaAccountDevice[]> {
    const s = this.stored()
    if (!s) throw new ValidationError('Link your Smart Life account first')
    const cred = this.cred(s)
    const lanById = new Map<string, DiscoveredDevice>()
    for (const d of lan) if (typeof d.config.deviceId === 'string') lanById.set(d.config.deviceId, d)

    if (!this.uid) {
      const known = [hintDeviceId?.trim(), ...lanById.keys(), ...this.registryIds().keys()].filter((x): x is string => Boolean(x))
      if (known.length === 0) {
        throw new ValidationError('The hub has not heard any Smart Life device yet. Switch one on, on the same WiFi as the hub, and scan again. Or type the Device ID of one device.')
      }
      let lastError = ''
      for (const id of known) {
        try {
          const detail = (await tuyaCloudCall(cred, 'GET', `/v1.0/devices/${encodeURIComponent(id)}`)) as CloudDevice
          if (detail?.uid) {
            this.uid = detail.uid
            break
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          this.log.debug(`tuya: device ${id.slice(0, 6)}… not in this account: ${lastError}`)
        }
      }
      if (!this.uid) {
        throw new ValidationError(
          `None of the Smart Life devices the hub knows belongs to the linked project. In the Tuya project open Devices, Link App Account, and scan the code with the Smart Life app.${lastError ? ' Tuya said: ' + lastError : ''}`,
        )
      }
    }

    const list: CloudDevice[] = []
    for (let page = 1; page <= 10; page++) {
      const res = (await tuyaCloudCall(cred, 'GET', `/v1.0/users/${encodeURIComponent(this.uid)}/devices`, { query: { page_no: page, page_size: 100 } })) as CloudDevice[] | { devices?: CloudDevice[] }
      const batch = Array.isArray(res) ? res : res?.devices ?? []
      list.push(...batch)
      if (batch.length < 100) break
    }
    this.cache.clear()
    for (const d of list) this.cache.set(d.id, d)
    const existing = this.registryIds()
    return list.map((d) => {
      const cat = CATEGORIES[d.category ?? '']
      const onLan = lanById.get(d.id)
      return {
        id: d.id,
        name: d.name || d.product_name || 'Smart Life device',
        category: d.category ?? '',
        categoryLabel: cat?.label ?? (d.product_name || 'Other device'),
        productName: d.product_name ?? '',
        online: d.online === true,
        lanHost: onLan?.host ?? null,
        version: typeof onLan?.config.version === 'string' ? onLan.config.version : null,
        suggestedKind: cat?.kind ?? 'switch',
        supported: cat ? cat.supported : true,
        reason: cat && !cat.supported ? `${cat.label}s cannot be driven by this version of the app yet` : null,
        existingDeviceId: existing.get(d.id) ?? null,
      }
    })
  }

  /** Add account devices to the house. On the house network when the hub heard them there, through the cloud otherwise. */
  importDevices(requests: ImportRequest[], lan: DiscoveredDevice[]): Device[] {
    const s = this.stored()
    if (!s) throw new ValidationError('Link your Smart Life account first')
    const lanById = new Map<string, DiscoveredDevice>()
    for (const d of lan) if (typeof d.config.deviceId === 'string') lanById.set(d.config.deviceId, d)
    const existing = this.registryIds()
    const added: Device[] = []
    for (const req of requests) {
      const dev = this.cache.get(req.id)
      if (!dev) throw new ValidationError('That device is not in the list any more. Load the list again.')
      if (existing.has(req.id)) continue
      const cat = CATEGORIES[dev.category ?? '']
      if (cat && !cat.supported) throw new ValidationError(`${dev.name ?? 'That device'} is a ${cat.label.toLowerCase()}, which this version cannot drive yet`)
      const kind: DeviceKind = req.kind ?? cat?.kind ?? 'switch'
      const name = (req.name ?? dev.name ?? dev.product_name ?? 'Smart Life device').trim()
      const onLan = lanById.get(req.id)
      const opener = dev.category === 'ckmkzq'
      if (onLan && dev.local_key) {
        const wifi = this.registry.listWifi()
        added.push(
          this.registry.createDevice({
            name,
            kind,
            family: 'tuya-local',
            room: req.room ?? '',
            config: {
              deviceId: req.id,
              localKey: dev.local_key,
              version: typeof onLan.config.version === 'string' ? onLan.config.version : '3.3',
              dimmer: Boolean(cat?.light) && kind === 'light',
              // A Tuya garage opener holds its switch on while open; a relay wired to a gate button is pressed for a moment.
              gateMode: opener ? 'hold' : 'pulse',
            },
            paths: [{ priority: 0, kind: 'lan', label: wifi.length === 1 ? wifi[0]!.ssid : 'House WiFi', wifiNetworkId: wifi.length === 1 ? wifi[0]!.id : null, host: onLan.host, port: 6668 }],
          }),
        )
      } else {
        added.push(
          this.registry.createDevice({
            name,
            kind,
            family: 'tuya-cloud',
            room: req.room ?? '',
            config: {
              accessId: s.accessId,
              accessSecret: s.accessSecret,
              deviceId: req.id,
              region: s.region,
              apiBase: s.apiBase ?? '',
              dimmable: Boolean(cat?.light) && kind === 'light',
              gateMode: opener ? 'opener' : 'pulse',
            },
            paths: [{ priority: 0, kind: 'cloud', label: 'Smart Life cloud' }],
          }),
        )
      }
    }
    return added
  }

  /** The local key of an account device, for a device added by hand from a scan result. */
  localKey(deviceId: string): string | null {
    return this.cache.get(deviceId)?.local_key ?? null
  }

  /** Tuya device id -> the house device that already uses it. */
  private registryIds(): Map<string, string> {
    const out = new Map<string, string>()
    for (const d of this.registry.listDevices()) {
      if ((d.family === 'tuya-local' || d.family === 'tuya-cloud') && typeof d.config.deviceId === 'string' && d.config.deviceId) out.set(d.config.deviceId, d.id)
    }
    return out
  }
}
