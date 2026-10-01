import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SECRET_MASK } from '@house/shared'
import { SecretBox, hashPin, verifyPin } from '../../src/crypto.ts'
import { ValidationError } from '../../src/registry.ts'
import { makeHub, type TestHub } from './harness.ts'

let t: TestHub
beforeEach(async () => {
  t = await makeHub()
})
afterEach(async () => {
  await t.close()
})

describe('secrets', () => {
  it('encrypts and decrypts, and refuses tampered values', () => {
    const box = SecretBox.ephemeral()
    const enc = box.encrypt('p@ss word')
    expect(enc).toMatch(/^enc:v1:/)
    expect(enc).not.toContain('p@ss')
    expect(box.decrypt(enc)).toBe('p@ss word')
    const parts = enc.split(':')
    parts[4] = Buffer.from('tampered').toString('base64')
    expect(() => box.decrypt(parts.join(':'))).toThrow()
    expect(() => SecretBox.ephemeral().decrypt(enc)).toThrow()
  })

  it('hashes PINs with a salt', () => {
    const a = hashPin('2468')
    const b = hashPin('2468')
    expect(a).not.toBe(b)
    expect(verifyPin('2468', a)).toBe(true)
    expect(verifyPin('2469', a)).toBe(false)
  })
})

describe('registry: devices', () => {
  const camera = (password = 'cam-secret') => ({
    name: 'Yard camera',
    kind: 'camera' as const,
    family: 'rtsp' as const,
    room: 'Yard',
    config: { username: 'admin', password, streamUrl: 'rtsp://{user}:{pass}@{host}:{port}/stream1' },
    paths: [{ priority: 0, kind: 'lan' as const, label: 'Home WiFi', wifiNetworkId: null, host: '192.168.1.90', port: 554 }],
  })

  it('stores passwords encrypted, shows them masked, and gives the hub the real value', () => {
    const d = t.hub.registry.createDevice(camera())
    expect(d.config.password).toBe(SECRET_MASK)
    expect(t.hub.registry.getDevice(d.id)!.config.password).toBe(SECRET_MASK)
    expect(t.hub.registry.getDeviceUnmasked(d.id)!.config.password).toBe('cam-secret')
    const row = t.hub.db.prepare('SELECT config FROM devices WHERE id = ?').get(d.id) as { config: string }
    expect(row.config).not.toContain('cam-secret')
    expect(row.config).toContain('enc:v1:')
    expect(d.capabilities).toContain('stream')
  })

  it('keeps the stored password when the app sends the mask back, and replaces it when a new one is typed', () => {
    const d = t.hub.registry.createDevice(camera())
    t.hub.registry.updateDevice(d.id, { name: 'Yard cam', config: { ...d.config } })
    expect(t.hub.registry.getDeviceUnmasked(d.id)!.config.password).toBe('cam-secret')
    expect(t.hub.registry.getDevice(d.id)!.name).toBe('Yard cam')
    t.hub.registry.updateDevice(d.id, { config: { ...d.config, password: 'new-secret' } })
    expect(t.hub.registry.getDeviceUnmasked(d.id)!.config.password).toBe('new-secret')
  })

  it('keeps path ids across edits, drops removed paths, and renumbers priorities', () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    const [first, second] = d.paths
    const updated = t.hub.registry.updateDevice(d.id, {
      paths: [
        { ...second!, priority: 0 },
        { priority: 1, kind: 'sms', label: 'SMS', host: '9900000000' },
      ],
    })
    expect(updated.paths.map((p) => p.id)).toContain(second!.id)
    expect(updated.paths.map((p) => p.id)).not.toContain(first!.id)
    expect(updated.paths.map((p) => p.priority)).toEqual([0, 1])
    expect(updated.paths[0]!.id).toBe(second!.id)
  })

  it('rejects bad input with a plain reason', () => {
    const r = t.hub.registry
    expect(() => r.createDevice({ ...camera(), name: '  ' })).toThrow(ValidationError)
    expect(() => r.createDevice({ ...camera(), family: 'nope' as never })).toThrow(/Unknown device family/)
    expect(() => r.createDevice({ ...camera(), kind: 'gate' })).toThrow(/cannot be a gate/)
    expect(() => r.createDevice({ ...camera(), paths: [{ priority: 0, kind: 'lan', label: 'x', host: '1.2.3.4', port: 70000 }] })).toThrow(/Port/)
    expect(() =>
      r.createDevice({ name: 'Gate', kind: 'gate', family: 'virtual', room: '', config: { simulate: 'gate' }, paths: [{ priority: 0, kind: 'sms', label: 'SMS', host: '' }] }),
    ).toThrow(/phone number/)
  })

  it('removes a device with its paths, runtime and history', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    await t.hub.devices.check(d.id, { force: true })
    await t.settle(t.hub.actions.request(d.id, { type: 'power.on' }))
    expect(t.hub.registry.deleteDevice(d.id)).toBe(true)
    expect(t.hub.registry.getDevice(d.id)).toBeNull()
    const count = (table: string) => (t.hub.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    expect(count('paths')).toBe(0)
    expect(count('actions')).toBe(0)
    expect(count('device_runtime')).toBe(0)
    expect(t.hub.registry.deleteDevice(d.id)).toBe(false)
  })

  it('reorders tiles', () => {
    const a = t.add({ name: 'A', simulate: 'light' })
    const b = t.add({ name: 'B', simulate: 'light' })
    t.hub.registry.reorder([b.id, a.id])
    expect(t.hub.registry.listDevices().map((d) => d.name)).toEqual(['B', 'A'])
  })
})

describe('registry: wifi networks', () => {
  it('never returns the password and refuses duplicates', () => {
    const r = t.hub.registry
    const list = r.listWifi()
    expect(list).toHaveLength(2)
    expect(JSON.stringify(list)).not.toContain('home-pass')
    expect(list[0]!.hasPassword).toBe(true)
    expect(r.getWifiSecret(t.home)).toMatchObject({ ssid: 'Home WiFi', password: 'home-pass' })
    expect(() => r.createWifi({ ssid: 'Home WiFi', password: 'x' })).toThrow(/already in the list/)
    expect(() => r.createWifi({ ssid: '  ' })).toThrow(/required/)
  })

  it('keeps the password on rename and clears a path link when the network is deleted', () => {
    const r = t.hub.registry
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    r.updateWifi(t.home, { ssid: 'Home 5G', password: SECRET_MASK })
    expect(r.getWifiSecret(t.home)).toMatchObject({ ssid: 'Home 5G', password: 'home-pass' })
    r.updateWifi(t.home, { ssid: 'Home 5G', password: 'changed' })
    expect(r.getWifiSecret(t.home)!.password).toBe('changed')
    expect(r.deleteWifi(t.backup)).toBe(true)
    const after = r.getDevice(d.id)!
    expect(after.paths.find((p) => p.label === 'Backup WiFi')!.wifiNetworkId).toBeNull()
  })
})

describe('sign-in', () => {
  it('sets the PIN once, signs in, throttles wrong PINs', () => {
    const a = t.hub.auth
    expect(a.isConfigured()).toBe(false)
    const token = a.setup('2468', 'Phone')
    expect(a.verify(token)).toBe(true)
    expect(a.verify('nope')).toBe(false)
    expect(() => a.setup('1111')).toThrow(/already set/)
    expect(() => a.login('0000')).toThrow(/Wrong PIN/)
    const second = a.login('2468')
    expect(second).not.toBe(token)
    a.revoke(token)
    expect(a.verify(token)).toBe(false)
    expect(a.verify(second)).toBe(true)
    for (let i = 0; i < 5; i++) expect(() => a.login('0000')).toThrow()
    expect(() => a.login('2468')).toThrow(/Too many wrong PINs/)
  })

  it('changes the PIN only with the current one', () => {
    const a = t.hub.auth
    a.setup('2468')
    expect(() => a.changePin('0000', '9999')).toThrow(/Current PIN is wrong/)
    expect(() => a.changePin('2468', '12')).toThrow(/4 to 8 digits/)
    expect(() => a.changePin('2468', 'abcd')).toThrow(/4 to 8 digits/)
    a.changePin('2468', '1357')
    expect(() => a.login('2468')).toThrow()
    expect(a.verify(a.login('1357'))).toBe(true)
  })
})
