import type { Logger } from './lib/log.ts'
import type { Registry } from './registry.ts'

/**
 * First run: a house with two WiFi networks and a handful of illustrative
 * devices so the app has something to show before the real hardware is added.
 * Nothing here is a real device; delete them from the app when you like.
 */
/** The pretend networks carry this password prefix; that is how the hub knows one has not been made real. */
export const SEED_WIFI_PASSWORD_PREFIX = 'illustrative-'

export function seedIfEmpty(registry: Registry, log: Logger): boolean {
  if (registry.listDevices().length > 0 || registry.listWifi().length > 0) return false
  const home = registry.createWifi({ ssid: 'Home WiFi', password: 'illustrative-home', notes: 'Illustrative, not a real network' })
  const backup = registry.createWifi({ ssid: 'Backup WiFi', password: 'illustrative-backup', notes: 'Illustrative, not a real network' })

  registry.createDevice({
    name: 'Gate camera',
    kind: 'camera',
    family: 'virtual',
    room: 'Main gate',
    config: { simulate: 'camera', simReachable: false, failRate: 0 },
    paths: [
      { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: home.id, host: '192.168.1.50', port: 80 },
      { priority: 1, kind: 'lan', label: 'Backup WiFi', wifiNetworkId: backup.id, host: '192.168.8.50', port: 80 },
      { priority: 2, kind: 'cellular', label: 'SIM', host: '100.72.14.9', port: 80, extra: { carrier: 'Jio' } },
      { priority: 3, kind: 'sms', label: 'SMS', host: '+919900000001' },
    ],
  })
  registry.createDevice({
    name: 'Main gate',
    kind: 'gate',
    family: 'virtual',
    room: 'Main gate',
    config: { simulate: 'gate' },
    paths: [
      { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: home.id, host: '192.168.1.60', port: 80 },
      { priority: 1, kind: 'sms', label: 'SMS', host: '+919900000002' },
    ],
  })
  registry.createDevice({
    name: 'Garage door',
    kind: 'gate',
    family: 'virtual',
    room: 'Garage',
    config: { simulate: 'gate' },
    paths: [
      { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: home.id, host: '192.168.1.61', port: 80 },
      { priority: 1, kind: 'lan', label: 'Backup WiFi', wifiNetworkId: backup.id, host: '192.168.8.61', port: 80 },
    ],
  })
  registry.createDevice({
    name: 'Porch camera',
    kind: 'camera',
    family: 'virtual',
    room: 'Porch',
    config: { simulate: 'camera', simReachable: true },
    paths: [
      { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: home.id, host: '192.168.1.51', port: 80 },
      { priority: 1, kind: 'cellular', label: 'SIM', host: '49.205.12.77', port: 80, extra: { carrier: 'Airtel' } },
    ],
  })
  registry.createDevice({
    name: 'Veranda light',
    kind: 'light',
    family: 'virtual',
    room: 'Veranda',
    config: { simulate: 'light' },
    paths: [{ priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: home.id, host: '192.168.1.71', port: 80 }],
  })
  registry.createDevice({
    name: 'Hall lights',
    kind: 'light',
    family: 'virtual',
    room: 'Hall',
    config: { simulate: 'dimmer' },
    paths: [
      { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: home.id, host: '192.168.1.72', port: 80 },
      { priority: 1, kind: 'lan', label: 'Backup WiFi', wifiNetworkId: backup.id, host: '192.168.8.72', port: 80 },
    ],
  })
  log.info('Seeded two WiFi networks and six illustrative devices')
  return true
}
