import type { Family, FamilyDescriptor } from '@house/shared'
import type { Adapter } from './types.ts'
import virtual from './virtual.ts'
import onvif from './onvif.ts'
import hikvision from './hikvision.ts'
import dahua from './dahua.ts'
import tapo from './tapo.ts'
import tasmota from './tasmota.ts'
import shelly from './shelly.ts'
import tuyaCloud from './tuya-cloud.ts'
import tuyaLocal from './tuya-local.ts'
import mqtt from './mqtt.ts'
import httpRelay from './http-relay.ts'
import gsmSms from './gsm-sms.ts'

const ADAPTERS: Adapter[] = [virtual, onvif, hikvision, dahua, tapo, tasmota, shelly, tuyaCloud, tuyaLocal, mqtt, httpRelay, gsmSms]

const byFamily = new Map<Family, Adapter>(ADAPTERS.map((a) => [a.family, a]))

export function getAdapter(family: string): Adapter {
  const a = byFamily.get(family as Family)
  if (!a) throw new Error(`Unknown device family "${family}"`)
  return a
}

export function hasAdapter(family: string): boolean {
  return byFamily.has(family as Family)
}

export function allAdapters(): Adapter[] {
  return ADAPTERS
}

export function familyDescriptors(): FamilyDescriptor[] {
  return ADAPTERS.map((a) => a.describe())
}
