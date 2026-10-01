/**
 * Regression tests for defects found in the independent review of the core.
 * Each test names the failure it guards against.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from '../../src/lib/http.ts'
import { basicGuard, digestGuard, mockServer, send, TINY_JPEG, type MockServer } from '../helpers.ts'
import { makeHub, sleep, type TestHub } from './harness.ts'

let t: TestHub
let server: MockServer | null = null
beforeEach(async () => {
  t = await makeHub()
})
afterEach(async () => {
  await t.close()
  await server?.close()
  server = null
})

const auth = () => ({ authorization: `Bearer ${t.token()}` })

describe('gate commands', () => {
  it('Stop reaches a gate that is still opening, and the overtaken Open does not claim success or failure', async () => {
    const d = t.add({ name: 'Main gate', simulate: 'gate' })
    await t.hub.devices.check(d.id, { force: true })
    const open = t.hub.actions.request(d.id, { type: 'gate.open' })
    await sleep(2000)
    expect(t.hub.devices.getState(d.id)!.state.gate).toBe('opening')
    const started = Date.now()
    const stop = await t.settle(t.hub.actions.request(d.id, { type: 'gate.stop' }))
    expect(Date.now() - started).toBeLessThan(2500) // not after the 6 s travel
    expect(stop.status).toBe('done')
    expect(stop.result).toMatchObject({ gate: 'stopped' })
    expect(t.hub.devices.getState(d.id)!.state.gate).toBe('stopped')
    const overtaken = await t.settle(open)
    expect(overtaken.status).toBe('done')
    expect(overtaken.result).toMatchObject({ gate: 'stopped', superseded: true })
    expect(t.pushes.some((p) => p.title === 'Main gate: Open gate')).toBe(false)
    expect(t.pushes.some((p) => /failed/.test(p.title))).toBe(false)
    expect(t.pushes.some((p) => p.title === 'Main gate: Stop gate' && p.body === 'Gate stopped')).toBe(true)
  }, 20000)

  it('Close tapped during an Open runs straight away and wins', async () => {
    const d = t.add({ name: 'Main gate', simulate: 'gate' })
    await t.hub.devices.check(d.id, { force: true })
    const open = t.hub.actions.request(d.id, { type: 'gate.open' })
    await sleep(1500)
    const close = t.hub.actions.request(d.id, { type: 'gate.close' })
    await sleep(700)
    expect(t.hub.devices.getState(d.id)!.state.gate).toBe('closing')
    const [o, c] = await Promise.all([t.settle(open, 20000), t.settle(close, 20000)])
    expect(c.status).toBe('done')
    expect(c.result).toMatchObject({ gate: 'closed' })
    expect(o.status).toBe('done')
    expect(o.result).toMatchObject({ superseded: true })
  }, 25000)

  it('a gate that takes the command but does not move is reported as failed, not done', async () => {
    const d = t.add({ name: 'Garage door', simulate: 'gate', config: { jammed: true } })
    await t.hub.devices.check(d.id, { force: true })
    const failed = await t.settle(t.hub.actions.request(d.id, { type: 'gate.open' }), 15000)
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('The gate did not open. It still reads closed.')
    expect(failed.result).toMatchObject({ gate: 'closed' })
    expect(t.pushes.some((p) => p.title === 'Garage door: Open gate failed')).toBe(true)
    expect(t.pushes.some((p) => p.title === 'Garage door: Open gate')).toBe(false)
  }, 20000)

  it('says "text sent", never "done", when a command went by SMS and the gate cannot answer', async () => {
    t.hub.sms.send = async () => ({ sent: true })
    const d = t.add({ name: 'Main gate', simulate: 'gate', paths: [{ priority: 0, kind: 'sms', label: 'SMS', host: '9900000002' }] })
    const done = await t.settle(t.hub.actions.request(d.id, { type: 'gate.open' }))
    expect(done.status).toBe('done')
    expect(done.result).toMatchObject({ via: 'sms' })
    expect(t.events.some((e) => e.type === 'action.done' && /Text sent\. The device cannot report back\./.test(e.message))).toBe(true)
    expect(t.pushes.some((p) => p.body === 'Text sent. The device cannot report back.')).toBe(true)
  })

  it('a text command goes to the number of the SIM, whichever connection is live', async () => {
    const d = t.add({
      name: 'Main gate',
      simulate: 'gate',
      paths: [
        { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '192.168.1.60', port: 80 },
        { priority: 1, kind: 'sms', label: 'SMS', host: '9900000002' },
      ],
    })
    await t.hub.devices.check(d.id, { force: true })
    expect(t.hub.devices.activePath(d.id)!.kind).toBe('lan')
    const pending = await t.settle(t.hub.actions.request(d.id, { type: 'sms.send', params: { text: '1234#STATUS#' } }))
    expect(pending.status).toBe('needs-confirmation')
    expect(String(pending.result!.handoff)).toBe('sms:+919900000002?body=1234%23STATUS%23')
  })
})

describe('moving a device to another WiFi', () => {
  it('puts the new connection next to the other WiFi ones, ahead of SMS, and ends up on it', async () => {
    const d = t.add({
      name: 'Cam',
      simulate: 'camera',
      paths: [
        { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '192.168.1.50', port: 80 },
        { priority: 1, kind: 'sms', label: 'SMS', host: '9900000001' },
      ],
    })
    await t.hub.devices.check(d.id, { force: true })
    const done = await t.settle(t.hub.actions.request(d.id, { type: 'wifi.set', params: { wifiNetworkId: t.backup } }), 30000)
    expect(done.status).toBe('done')
    expect(done.result).toMatchObject({ ssid: 'Backup WiFi', onTarget: true })
    const after = t.hub.registry.getDevice(d.id)!
    expect(after.paths.map((p) => p.label)).toEqual(['Home WiFi', 'Backup WiFi', 'SMS'])
    expect(after.paths.map((p) => p.priority)).toEqual([0, 1, 2])
    expect(after.paths[0]!.id).toBe(d.paths[0]!.id) // existing connections keep their identity
    const state = t.hub.devices.getState(d.id)!
    expect(after.paths.find((p) => p.id === state.activePathId)!.label).toBe('Backup WiFi')
  }, 40000)

  it('does not claim success when the device restarts and comes back on its old network', async () => {
    const d = t.add({
      name: 'Cam',
      simulate: 'camera',
      config: { joinFails: true },
      paths: [{ priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '192.168.1.50', port: 80 }],
    })
    await t.hub.devices.check(d.id, { force: true })
    const failed = await t.settle(t.hub.actions.request(d.id, { type: 'wifi.set', params: { wifiNetworkId: t.backup } }), 40000)
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('Cam did not join "Backup WiFi" and is still on "Home WiFi". Check the password stored for "Backup WiFi".')
    // no phantom "Backup WiFi" connection is left behind, and the camera is usable where it is
    const after = t.hub.registry.getDevice(d.id)!
    expect(after.paths.map((p) => p.label)).toEqual(['Home WiFi'])
    expect(t.hub.devices.getState(d.id)!.online).toBe(true)
    expect(t.events.some((e) => e.type === 'wifi.moved')).toBe(false)
    expect(t.pushes.some((p) => /Now on Backup WiFi/.test(p.body))).toBe(false)
  }, 50000)
})

describe('the hub survives', () => {
  it('a device removed while its connection check is still running', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' }) // the upsert starts a background check
    t.hub.registry.deleteDevice(d.id)
    await sleep(400)
    const e = t.add({ name: 'Lamp 2', simulate: 'light' })
    const pending = t.hub.devices.check(e.id, { force: true })
    t.hub.registry.deleteDevice(e.id)
    await pending.catch(() => undefined)
    await sleep(300)
    // vitest fails the run on an unhandled rejection; reaching here with a working hub is the assertion
    const f = t.add({ name: 'Lamp 3', simulate: 'light' })
    expect((await t.hub.devices.check(f.id, { force: true })).online).toBe(true)
  })

  it('a pin chosen by hand is not reported as a failure', async () => {
    const d = t.add({
      name: 'Gate',
      simulate: 'gate',
      paths: [
        { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '192.168.1.10', port: 80 },
        { priority: 1, kind: 'sms', label: 'SMS', host: '+919900000002' },
      ],
    })
    await t.hub.devices.check(d.id, { force: true })
    t.events.length = 0
    t.pushes.length = 0
    await t.hub.devices.pinPath(d.id, d.paths[1]!.id)
    const switched = t.events.find((e) => e.type === 'path.switched')!
    expect(switched.level).toBe('info')
    expect(t.pushes.some((p) => /stopped answering/.test(p.body))).toBe(false)
  })
})

describe('sign-in and API guard', () => {
  it('cannot be bypassed by spelling the path differently', async () => {
    t.token() // a PIN exists
    const d = t.add({ name: 'Main gate', simulate: 'gate' })
    for (const url of ['/%61pi/devices', '/%61%70%69/devices', '/api/devices/', '//api/devices', '/API/devices', `/%76ideo/api/frame.jpeg?src=${d.id}`, '/%61pi/hub/status']) {
      const res = await t.hub.app.inject({ method: 'GET', url })
      expect([401, 404], `${url} -> ${res.statusCode}`).toContain(res.statusCode)
      expect(res.body, url).not.toContain(d.id)
    }
    const open = await t.hub.app.inject({ method: 'POST', url: `/%61pi/devices/${d.id}/actions`, payload: { type: 'gate.open' } })
    expect(open.statusCode).toBe(401)
    const pin = await t.hub.app.inject({ method: 'POST', url: '/%61pi/auth/pin', payload: { current: '2468', next: '1111' } })
    expect(pin.statusCode).toBe(401)
    expect(t.hub.actions.list()).toHaveLength(0)
    // the three public calls still work, spelled normally
    expect((await t.hub.app.inject({ method: 'GET', url: '/api/auth/status' })).statusCode).toBe(200)
  })

  it('changing the PIN signs every other phone out, keeps this one in, and is throttled like sign-in', async () => {
    const mine = t.hub.auth.setup('2468', 'my phone')
    const other = t.hub.auth.login('2468', 'other phone')
    const res = await t.hub.app.inject({ method: 'POST', url: '/api/auth/pin', headers: { authorization: `Bearer ${mine}` }, payload: { current: '2468', next: '13579' } })
    expect(res.statusCode).toBe(200)
    expect(t.hub.auth.verify(mine)).toBe(true)
    expect(t.hub.auth.verify(other)).toBe(false)
    for (let i = 0; i < 5; i++) {
      const bad = await t.hub.app.inject({ method: 'POST', url: '/api/auth/pin', headers: { authorization: `Bearer ${mine}` }, payload: { current: '0000', next: '1111' } })
      expect(bad.statusCode).toBe(401)
    }
    const locked = await t.hub.app.inject({ method: 'POST', url: '/api/auth/pin', headers: { authorization: `Bearer ${mine}` }, payload: { current: '13579', next: '1111' } })
    expect(locked.statusCode).toBe(429)
  })
})

describe('pictures from devices', () => {
  const camera = (port: number, snapshotPath: string) =>
    t.hub.registry.createDevice({
      name: 'Yard',
      kind: 'camera',
      family: 'rtsp',
      room: '',
      config: { snapshotUrl: `http://{host}:${port}${snapshotPath}` },
      paths: [{ priority: 0, kind: 'lan', label: 'LAN', host: '127.0.0.1', port }],
    })

  it('never stores or serves what a device calls a picture but is not one', async () => {
    server = await mockServer((req, res) => {
      if (req.path === '/evil.svg') return send(res, 200, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', 'image/svg+xml')
      if (req.path === '/mislabelled') return send(res, 200, TINY_JPEG, 'text/html')
      send(res, 404, 'no')
    })
    const evil = camera(server.port, '/evil.svg')
    await t.hub.devices.check(evil.id, { force: true })
    const failed = await t.settle(t.hub.actions.request(evil.id, { type: 'snapshot' }))
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('The camera did not send a picture')
    const live = await t.hub.app.inject({ method: 'GET', url: `/api/devices/${evil.id}/snapshot`, headers: auth() })
    expect(live.statusCode).toBe(503)

    const odd = camera(server.port, '/mislabelled')
    await t.hub.devices.check(odd.id, { force: true })
    const ok = await t.settle(t.hub.actions.request(odd.id, { type: 'snapshot' }))
    expect(ok.status).toBe('done')
    const stored = await t.hub.app.inject({ method: 'GET', url: String(ok.result!.url), headers: auth() })
    expect(stored.headers['content-type']).toBe('image/jpeg') // from the bytes, not from the device's label
    expect(stored.headers['content-security-policy']).toContain('sandbox')
    expect(stored.headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('device passwords on the wire', () => {
  it('are sent as a digest, and in clear only when the caller allows it', async () => {
    const digest = digestGuard('admin', 'secret')
    const basic = basicGuard('admin', 'secret')
    server = await mockServer((req, res) => {
      if (req.path === '/digest') {
        if (digest(req, res)) send(res, 200, 'ok')
      } else if (req.path === '/both') {
        // Basic listed first, Digest second: the hub must pick Digest
        if (/^digest/i.test(req.headers.authorization ?? '')) send(res, 200, 'ok')
        else {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x", Digest realm="IP Camera", qop="auth", nonce="abc123", opaque="xyz"' })
          res.end()
        }
      } else if (basic(req, res)) {
        send(res, 200, 'ok')
      }
    })
    const creds = { username: 'admin', password: 'secret' }
    expect((await request(`${server.url}/digest`, { digest: creds })).status).toBe(200)

    expect((await request(`${server.url}/both`, { digest: creds })).status).toBe(200)
    expect(server.requests.filter((r) => r.path === '/both').some((r) => /^basic/i.test(r.headers.authorization ?? ''))).toBe(false)

    const refused = await request(`${server.url}/basic`, { digest: creds })
    expect(refused.status).toBe(401)
    expect(server.requests.filter((r) => r.path === '/basic').every((r) => !r.headers.authorization)).toBe(true)

    expect((await request(`${server.url}/basic`, { digest: { ...creds, allowBasic: true } })).status).toBe(200)
  })
})

describe('the illustrative starter set', () => {
  it('takes its pretend WiFi networks with it, and does not come back after a restart', async () => {
    await t.close()
    t = await makeHub({ seedVirtual: true }) // a fresh data folder: the hub seeds it
    const { seedIfEmpty } = await import('../../src/seed.ts')
    const { logger } = await import('../../src/lib/log.ts')
    expect(t.hub.registry.listDevices().length).toBeGreaterThan(3)
    expect(t.hub.registry.listDevices().every((d) => d.family === 'virtual')).toBe(true)
    expect(t.hub.registry.listWifi()).toHaveLength(2)
    expect(t.hub.registry.listWifi().every((w) => /Illustrative/.test(w.notes))).toBe(true)
    const real = t.hub.registry.listWifi()[0]!
    t.hub.registry.updateWifi(real.id, { ssid: 'My real router', password: 'a-real-password', notes: 'Main router' })

    for (const d of t.hub.registry.listDevices()) {
      const res = await t.hub.app.inject({ method: 'DELETE', url: `/api/devices/${d.id}`, headers: auth() })
      expect(res.statusCode).toBe(200)
    }
    // the network the owner made real is kept; the untouched pretend one is gone
    expect(t.hub.registry.listWifi().map((w) => w.ssid)).toEqual(['My real router'])
    // a restart with an empty house must not bring the pretend devices back
    expect(t.hub.db.prepare("SELECT value FROM settings WHERE key = 'seeded'").get()).toEqual({ value: '1' })
    expect(seedIfEmpty(t.hub.registry, logger('test'))).toBe(false)
  })
})
