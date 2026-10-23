/**
 * Regression tests for what the error hunt found: six testers trying every
 * mistake they could on throwaway hubs. Each test names the failure it guards.
 */
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { SECRET_MASK, type Device } from '@house/shared'
import { ActionError, cleanParams } from '../../src/actions.ts'
import { makeHub, sleep, type TestHub } from './harness.ts'

let t: TestHub
beforeEach(async () => {
  t = await makeHub()
})
afterEach(async () => {
  await t.close()
})

const auth = () => ({ authorization: `Bearer ${t.token()}` })
const camera = (extra: Partial<Device['config']> = {}) => ({
  name: 'Yard camera',
  kind: 'camera' as const,
  family: 'rtsp' as const,
  room: 'Yard',
  config: { username: 'admin', password: 'cam-secret', ...extra },
  paths: [{ priority: 0, kind: 'lan' as const, label: 'Home WiFi', wifiNetworkId: null, host: '192.168.1.90', port: 554 }],
})

describe('saving a device with mistakes in it', () => {
  it('treats a WiFi network that no longer exists as "wired", instead of failing with a server error', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    t.hub.registry.deleteWifi(t.backup)
    const res = await t.hub.app.inject({
      method: 'PUT',
      url: `/api/devices/${d.id}`,
      headers: auth(),
      payload: { paths: [{ id: d.paths[0]!.id, kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '192.168.1.10', port: 80 }, { kind: 'lan', label: 'Backup WiFi', wifiNetworkId: t.backup, host: '192.168.8.10', port: 80 }] },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as Device).paths.map((p) => p.wifiNetworkId)).toEqual([t.home, null])
    const made = await t.hub.app.inject({ method: 'POST', url: '/api/devices', headers: auth(), payload: { ...camera(), paths: [{ kind: 'lan', host: '192.168.1.99', wifiNetworkId: 'wifi_nope' }] } })
    expect(made.statusCode).toBe(201)
    expect((made.json() as Device).paths[0]!.wifiNetworkId).toBeNull()
  })

  it('never lets one device take over another device’s connection', async () => {
    const gate = t.add({ name: 'Main gate', simulate: 'gate' })
    const lamp = t.add({ name: 'Lamp', simulate: 'light' })
    const stolen = gate.paths[0]!
    const res = await t.hub.app.inject({ method: 'PUT', url: `/api/devices/${lamp.id}`, headers: auth(), payload: { paths: [{ id: stolen.id, kind: 'lan', label: 'STOLEN', host: '6.6.6.6', port: 666 }] } })
    expect(res.statusCode).toBe(200)
    const lampNow = t.hub.registry.getDevice(lamp.id)!
    expect(lampNow.paths).toHaveLength(1)
    expect(lampNow.paths[0]!.id).not.toBe(stolen.id)
    expect(lampNow.paths[0]!.host).toBe('6.6.6.6')
    const gateNow = t.hub.registry.getDevice(gate.id)!
    expect(gateNow.paths.map((p) => p.id)).toContain(stolen.id)
    expect(gateNow.paths.find((p) => p.id === stolen.id)).toMatchObject({ label: 'Home WiFi', host: '192.168.1.10' })
    // the same id twice becomes two connections, not one lost one
    const twice = t.hub.registry.updateDevice(lamp.id, { paths: [{ ...lampNow.paths[0]!, label: 'A' }, { ...lampNow.paths[0]!, label: 'B' }] })
    expect(twice.paths.map((p) => p.label)).toEqual(['A', 'B'])
  })

  it('changing the family starts from fresh settings and never shows the old password', async () => {
    const d = t.hub.registry.createDevice(camera())
    const res = await t.hub.app.inject({ method: 'PUT', url: `/api/devices/${d.id}`, headers: auth(), payload: { family: 'virtual', kind: 'camera', config: { simulate: 'camera' } } })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('cam-secret')
    const row = t.hub.db.prepare('SELECT config FROM devices WHERE id = ?').get(d.id) as { config: string }
    expect(row.config).not.toContain('cam-secret')
    const list = await t.hub.app.inject({ method: 'GET', url: '/api/devices', headers: auth() })
    expect(list.body).not.toContain('cam-secret')
    // the usual edit (no family change) still keeps the password masked and intact
    const back = t.hub.registry.createDevice(camera())
    const edited = await t.hub.app.inject({ method: 'PUT', url: `/api/devices/${back.id}`, headers: auth(), payload: { name: 'Yard cam' } })
    expect(edited.json().config.password).toBe(SECRET_MASK)
    expect(t.hub.registry.getDeviceUnmasked(back.id)!.config.password).toBe('cam-secret')
  })

  it('refuses a silly position instead of breaking every later add', async () => {
    const huge = await t.hub.app.inject({ method: 'POST', url: '/api/devices', headers: auth(), payload: { ...camera(), sort: 9007199254740991 } })
    expect(huge.statusCode).toBe(400)
    expect(huge.json().error).toMatch(/position/i)
    t.hub.db.prepare('INSERT INTO devices (id, name, kind, family, room, config, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('dev_odd', 'Odd', 'light', 'virtual', '', '{}', 9007199254740991, 'x', 'x')
    const next = await t.hub.app.inject({ method: 'POST', url: '/api/devices', headers: auth(), payload: camera() })
    expect(next.statusCode).toBe(201)
  })

  it('answers wrong input in plain words, never in validator or server wording', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...camera(), name: 'x'.repeat(200) }, /too long/],
      [{ ...camera(), name: '   ' }, /name/i],
      [{ ...camera(), room: 'r'.repeat(80) }, /too long/],
      [{ ...camera(), paths: [{ kind: 'lan', host: '1.2.3.4', port: 80.5 }] }, /whole number|between 1 and 65535/],
      [{ ...camera(), paths: [{ kind: 'lan', host: '1.2.3.4', port: 'eighty' }] }, /port must be a number/],
      [{ ...camera(), kind: 'spaceship' }, /not one of the choices/],
      [{ ...camera(), config: { ...camera().config, password: 12345 } }, /must be text/],
      [{ ...camera({ deep: { a: { b: { c: { d: { e: 1 } } } } } }) }, /too large/],
      [{ ...camera(), family: 'nope' }, /Unknown device family/],
      [{ name: 'Gate', kind: 'gate', family: 'virtual', config: { simulate: 'spaceship' }, paths: [] }, /not one of the choices/],
    ]
    for (const [payload, expected] of cases) {
      const res = await t.hub.app.inject({ method: 'POST', url: '/api/devices', headers: auth(), payload })
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400)
      expect(res.json().error, JSON.stringify(payload).slice(0, 80)).toMatch(expected)
      expect(res.json().error).not.toMatch(/Expected|received|undefined|\[object|Something went wrong/)
    }
    const big = await t.hub.app.inject({ method: 'GET', url: '/api/events?limit=1.5', headers: auth() })
    expect(big.statusCode).toBe(400)
    expect(big.json().error).toMatch(/whole number/)
    const test = await t.hub.app.inject({ method: 'POST', url: '/api/devices/test', headers: auth(), payload: { ...camera(), family: 'nope' } })
    expect(test.statusCode).toBe(400)
    const gone = await t.hub.app.inject({ method: 'PUT', url: '/api/devices/dev_missing', headers: auth(), payload: { name: 'x' } })
    expect(gone.statusCode).toBe(404)
    const wifiGone = await t.hub.app.inject({ method: 'PUT', url: '/api/wifi/wifi_missing', headers: auth(), payload: { ssid: 'x' } })
    expect(wifiGone.statusCode).toBe(404)
  })

  it('does not let a device be saved on top of a WiFi move that is still running', async () => {
    const d = t.add({ name: 'Cam', simulate: 'camera' })
    await t.hub.devices.check(d.id, { force: true })
    const move = t.hub.actions.request(d.id, { type: 'wifi.set', params: { wifiNetworkId: t.backup } })
    await sleep(600)
    const res = await t.hub.app.inject({ method: 'PUT', url: `/api/devices/${d.id}`, headers: auth(), payload: { name: 'Cam 2' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/moving to another WiFi/)
    await t.settle(move, 30000)
    expect((await t.hub.app.inject({ method: 'PUT', url: `/api/devices/${d.id}`, headers: auth(), payload: { name: 'Cam 2' } })).statusCode).toBe(200)
  }, 40000)
})

describe('commands with mistakes in them', () => {
  it('checks every parameter before anything is queued', () => {
    expect(cleanParams('dim.set', { brightness: '55' })).toEqual({ brightness: 55 })
    expect(() => cleanParams('dim.set', { brightness: 'bright' })).toThrow(/must be a number/)
    expect(() => cleanParams('dim.set', { brightness: 150 })).toThrow(/between 0 and 100/)
    expect(() => cleanParams('dim.set', {})).toThrow(/missing/)
    expect(cleanParams('ptz.move', { pan: 1 })).toEqual({ pan: 1, tilt: 0, zoom: 0 })
    expect(() => cleanParams('ptz.move', { pan: NaN })).toThrow(/must be a number/)
    expect(() => cleanParams('ptz.preset', { preset: { no: 1 } })).toThrow(/name or a number/)
    expect(() => cleanParams('sms.send', { text: '' })).toThrow(/missing/)
    expect(() => cleanParams('sms.send', { text: '   ' })).toThrow(/Give the text/)
    expect(() => cleanParams('sms.send', { text: 'x'.repeat(600) })).toThrow(/too long/)
    expect(cleanParams('wifi.set', { wifiNetworkId: 'wifi_1', password: 'leak' })).toEqual({ wifiNetworkId: 'wifi_1' })
    expect(() => cleanParams('wifi.set', { ssid: 'x', password: 'y' })).toThrow(/missing/)
    expect(() => cleanParams('power.on', { blob: 'x'.repeat(5000) })).toThrow(/too long/)
    expect(() => cleanParams('power.on', [] as never)).toThrow(ActionError)
    expect(cleanParams('path.switch', { pathId: '' })).toEqual({ pathId: null })
  })

  it('a Close that never reaches the gate does not steal the Open’s result', async () => {
    const d = t.add({ name: 'Gate', simulate: 'gate' })
    await t.hub.devices.check(d.id, { force: true })
    const open = t.hub.actions.request(d.id, { type: 'gate.open' })
    await sleep(1200)
    // a command that is refused before delivery (nothing the device can do)
    expect(() => t.hub.actions.request(d.id, { type: 'dim.set', params: { brightness: 3 } })).toThrow()
    const done = await t.settle(open, 15000)
    expect(done.status).toBe('done')
    expect(done.result).toMatchObject({ gate: 'open' })
    expect(done.result?.superseded).toBeUndefined()
  }, 20000)

  it('a gate whose device is removed mid-travel ends as failed, with its name', async () => {
    const d = t.add({ name: 'Garage door', simulate: 'gate' })
    await t.hub.devices.check(d.id, { force: true })
    const open = t.hub.actions.request(d.id, { type: 'gate.open' })
    await sleep(1500)
    t.hub.registry.deleteDevice(d.id)
    const ended = await t.settle(open, 15000)
    expect(ended.status).toBe('failed')
    expect(ended.error).toBe('Garage door was removed while the gate was moving')
  }, 20000)

  it('a hand-off still waiting is told to a phone however many newer commands there are', async () => {
    const gate = t.add({ name: 'Main gate', simulate: 'gate', paths: [{ priority: 0, kind: 'sms', label: 'SMS', host: '9900000002' }] })
    const pending = await t.settle(t.hub.actions.request(gate.id, { type: 'gate.open' }))
    expect(pending.status).toBe('needs-confirmation')
    const lamp = t.add({ name: 'Lamp', simulate: 'light' })
    for (let i = 0; i < 55; i++) await t.settle(t.hub.actions.request(lamp.id, { type: 'power.toggle' }))
    const hello = t.hub.actions.recentWithPending()
    expect(hello.some((a) => a.id === pending.id)).toBe(true)
    expect(hello.filter((a) => a.id === pending.id)).toHaveLength(1)
  }, 30000)

  it('an empty text command is refused rather than left as a hand-off with nothing to send', async () => {
    const gate = t.add({ name: 'Main gate', simulate: 'gate', paths: [{ priority: 0, kind: 'sms', label: 'SMS', host: '9900000002' }] })
    const res = await t.hub.app.inject({ method: 'POST', url: `/api/devices/${gate.id}/actions`, headers: auth(), payload: { type: 'sms.send', params: { text: '' } } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/text is missing/)
  })
})

describe('signing out really signs out', () => {
  it('closes the live channel of a revoked token at once, and only that one', async () => {
    await t.hub.app.listen({ port: 0, host: '127.0.0.1' })
    const port = (t.hub.app.server.address() as AddressInfo).port
    const mine = t.token()
    const other = t.hub.auth.login('2468', 'other phone')
    const openSocket = (token: string) =>
      new Promise<{ ws: WebSocket; closed: Promise<number> }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['hc-token', token])
        const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
        ws.on('open', () => resolve({ ws, closed }))
        ws.on('error', reject)
      })
    const a = await openSocket(mine)
    const b = await openSocket(other)
    expect(a.ws.protocol).toBe('hc-token')
    t.hub.auth.revoke(other)
    expect(await Promise.race([b.closed, sleep(2000).then(() => -1)])).toBe(4401)
    expect(a.ws.readyState).toBe(WebSocket.OPEN)

    // a PIN change keeps this phone and closes every other one
    const c = await openSocket(t.hub.auth.login('2468', 'third'))
    t.hub.auth.changePin('2468', '1357', mine)
    expect(await Promise.race([c.closed, sleep(2000).then(() => -1)])).toBe(4401)
    expect(a.ws.readyState).toBe(WebSocket.OPEN)
    a.ws.close()

    // no token at all: closed with the code the app understands
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.on('close', (c2) => resolve(c2))
      ws.on('error', () => undefined)
    })
    expect(code).toBe(4401)
  })

  it('remembers the wrong-PIN lock across a restart, and refuses the same PIN as a "change"', async () => {
    t.token()
    for (let i = 0; i < 5; i++) expect(() => t.hub.auth.login('0000')).toThrow()
    expect(() => t.hub.auth.login('2468')).toThrow(/Too many wrong PINs/)
    const { Auth } = await import('../../src/auth.ts')
    const again = new Auth(t.hub.db) // a fresh hub on the same data
    expect(() => again.login('2468')).toThrow(/Too many wrong PINs/)
    const row = t.hub.db.prepare("SELECT value FROM settings WHERE key = 'pin_lock'").get() as { value: string }
    expect(JSON.parse(row.value).failures).toBe(5)
  })
})

describe('after a hub restart', () => {
  it('commands that were cut off are told to the owner, not just failed quietly', async () => {
    const d = t.add({ name: 'Main gate', simulate: 'gate' })
    t.hub.db.prepare("INSERT INTO actions (id, device_id, type, params, status, path_id, label, source, requested_at) VALUES ('act_cut', ?, 'gate.open', '{}', 'running', NULL, 'Open gate', 'app', ?)").run(d.id, new Date().toISOString())
    const { ActionQueue } = await import('../../src/actions.ts')
    const { logger } = await import('../../src/lib/log.ts')
    const restarted = new ActionQueue({ db: t.hub.db, registry: t.hub.registry, devices: t.hub.devices, bus: t.hub.bus, events: t.hub.events, notifier: t.hub.notifier, wifi: {} as never, video: null, log: logger('test'), config: t.config })
    expect(restarted.get('act_cut')!.status).toBe('failed')
    expect(t.events.some((e) => e.type === 'action.interrupted' && /Main gate: Open gate was cut off by a hub restart/.test(e.message))).toBe(true)
  })
})

describe('a recorder with several cameras', () => {
  it('is offered as its cameras, each with its own number; anything else answers with an empty list', async () => {
    const input = { name: 'Recorder', kind: 'camera', family: 'virtual', room: 'Yard', config: { simulate: 'camera', recorderChannels: 3 }, paths: [{ kind: 'lan', host: '192.168.1.5', port: 80 }] }
    const res = await t.hub.app.inject({ method: 'POST', url: '/api/devices/channels', headers: auth(), payload: input })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ channels: [{ channel: 1, name: 'Gate' }, { channel: 2, name: 'Drive' }, { channel: 3, name: 'Porch' }] })
    const single = await t.hub.app.inject({ method: 'POST', url: '/api/devices/channels', headers: auth(), payload: { ...input, config: { simulate: 'camera' } } })
    expect(single.json()).toEqual({ channels: [] })
    const gate = await t.hub.app.inject({ method: 'POST', url: '/api/devices/channels', headers: auth(), payload: { ...input, kind: 'gate', config: { simulate: 'gate', recorderChannels: 3 } } })
    expect(gate.json()).toEqual({ channels: [] })
    const noPath = await t.hub.app.inject({ method: 'POST', url: '/api/devices/channels', headers: auth(), payload: { ...input, paths: [] } })
    expect(noPath.json()).toEqual({ channels: [] })
    // the same checks as Save: a bad device is refused in plain words
    const bad = await t.hub.app.inject({ method: 'POST', url: '/api/devices/channels', headers: auth(), payload: { ...input, family: 'nope' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/Unknown device family/)
    const noAuth = await t.hub.app.inject({ method: 'POST', url: '/api/devices/channels', payload: input })
    expect(noAuth.statusCode).toBe(401)
  })
})

describe('the phone app finding the hub', () => {
  it('answers /api/hello to anyone, from any origin, with who it is and no secrets', async () => {
    const res = await t.hub.app.inject({ method: 'GET', url: '/api/hello', headers: { origin: 'http://localhost' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    const body = res.json()
    expect(body.app).toBe('house-control')
    expect(typeof body.name).toBe('string')
    expect(Array.isArray(body.addresses)).toBe(true)
    expect(Number.isInteger(body.port)).toBe(true)
    expect(Object.keys(body).sort()).toEqual(['addresses', 'app', 'name', 'port', 'version'])
    // everything else still needs the PIN
    const other = await t.hub.app.inject({ method: 'GET', url: '/api/hub/status' })
    expect(other.statusCode).toBe(401)
    expect(other.headers['access-control-allow-origin']).toBeUndefined()
  })
})
