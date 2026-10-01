import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SECRET_MASK, type Action, type Device, type FamilyDescriptor } from '@house/shared'
import { makeHub, type TestHub } from './harness.ts'

let t: TestHub
beforeEach(async () => {
  t = await makeHub()
})
afterEach(async () => {
  await t.close()
})

const auth = () => ({ authorization: `Bearer ${t.token()}` })

describe('HTTP API', () => {
  it('is closed until a PIN is set, then opens only with a token', async () => {
    const closed = await t.hub.app.inject({ method: 'GET', url: '/api/devices' })
    expect(closed.statusCode).toBe(401)
    expect(closed.json()).toMatchObject({ setup: true })

    const status = await t.hub.app.inject({ method: 'GET', url: '/api/auth/status' })
    expect(status.json()).toEqual({ configured: false, authenticated: false })

    const setup = await t.hub.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { pin: '2468' } })
    expect(setup.statusCode).toBe(200)
    const token = setup.json().token as string
    expect(token.length).toBeGreaterThan(30)

    const again = await t.hub.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { pin: '1111' } })
    expect(again.statusCode).toBe(409)

    const wrong = await t.hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { pin: '0000' } })
    expect(wrong.statusCode).toBe(401)

    const open = await t.hub.app.inject({ method: 'GET', url: '/api/devices', headers: { authorization: `Bearer ${token}` } })
    expect(open.statusCode).toBe(200)
    const viaQuery = await t.hub.app.inject({ method: 'GET', url: `/api/devices?token=${token}` })
    expect(viaQuery.statusCode).toBe(200)
    const bad = await t.hub.app.inject({ method: 'GET', url: '/api/devices', headers: { authorization: 'Bearer nope' } })
    expect(bad.statusCode).toBe(401)
    expect(bad.json()).toMatchObject({ error: 'Not signed in' })
  })

  it('adds, edits and removes a device without ever returning its password', async () => {
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/devices',
      headers: auth(),
      payload: {
        name: 'Yard camera',
        kind: 'camera',
        family: 'rtsp',
        room: 'Yard',
        config: { username: 'admin', password: 'cam-secret' },
        paths: [{ kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '192.168.1.90', port: 554 }],
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.body).not.toContain('cam-secret')
    const device = created.json() as Device
    expect(device.config.password).toBe(SECRET_MASK)
    expect(device.paths[0]!.id).toMatch(/^pth_/)

    const edited = await t.hub.app.inject({ method: 'PUT', url: `/api/devices/${device.id}`, headers: auth(), payload: { name: 'Yard cam', config: device.config } })
    expect(edited.statusCode).toBe(200)
    expect(edited.json().name).toBe('Yard cam')
    expect(t.hub.registry.getDeviceUnmasked(device.id)!.config.password).toBe('cam-secret')

    const list = await t.hub.app.inject({ method: 'GET', url: '/api/devices', headers: auth() })
    expect(list.body).not.toContain('cam-secret')

    const invalid = await t.hub.app.inject({ method: 'POST', url: '/api/devices', headers: auth(), payload: { name: '', kind: 'camera', family: 'rtsp' } })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toMatch(/name/i)

    const removed = await t.hub.app.inject({ method: 'DELETE', url: `/api/devices/${device.id}`, headers: auth() })
    expect(removed.statusCode).toBe(200)
    const gone = await t.hub.app.inject({ method: 'GET', url: `/api/devices/${device.id}`, headers: auth() })
    expect(gone.statusCode).toBe(404)
  })

  it('tests the connections of a device before it is saved', async () => {
    const res = await t.hub.app.inject({
      method: 'POST',
      url: '/api/devices/test',
      headers: auth(),
      payload: {
        name: 'New gate',
        kind: 'gate',
        family: 'virtual',
        config: { simulate: 'gate' },
        paths: [
          { kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '192.168.1.60', port: 80 },
          { kind: 'cellular', label: 'SIM', host: '100.70.0.1', port: 80 },
          { kind: 'sms', label: 'SMS', host: '+919900000002' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { capabilities: string[]; results: Array<{ label: string; ok: boolean; error: string | null; unverifiable: boolean }> }
    expect(body.capabilities).toContain('gate')
    expect(body.results.map((r) => [r.label, r.ok])).toEqual([
      ['Home WiFi', true],
      ['SIM', false],
      ['SMS', true],
    ])
    expect(body.results[1]!.error).toMatch(/private address/)
    expect(body.results[2]!.unverifiable).toBe(true)
    expect(t.hub.registry.listDevices()).toHaveLength(0)
  })

  it('accepts a command and reports it', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    const res = await t.hub.app.inject({ method: 'POST', url: `/api/devices/${d.id}/actions`, headers: auth(), payload: { type: 'power.on' } })
    expect(res.statusCode).toBe(202)
    const action = res.json() as Action
    const done = await t.settle(action)
    expect(done.status).toBe('done')
    const fetched = await t.hub.app.inject({ method: 'GET', url: `/api/actions/${action.id}`, headers: auth() })
    expect(fetched.json().status).toBe('done')
    const refused = await t.hub.app.inject({ method: 'POST', url: `/api/devices/${d.id}/actions`, headers: auth(), payload: { type: 'gate.open' } })
    expect(refused.statusCode).toBe(400)
    const state = await t.hub.app.inject({ method: 'GET', url: `/api/devices/${d.id}/state`, headers: auth() })
    expect(state.json().state.power).toBe(true)
  })

  it('serves camera stills to signed-in phones only', async () => {
    const d = t.add({ name: 'Cam', simulate: 'camera' })
    await t.hub.devices.check(d.id, { force: true })
    const anon = await t.hub.app.inject({ method: 'GET', url: `/api/devices/${d.id}/snapshot` })
    expect(anon.statusCode).toBe(401)
    const pic = await t.hub.app.inject({ method: 'GET', url: `/api/devices/${d.id}/snapshot`, headers: auth() })
    expect(pic.statusCode).toBe(200)
    expect(pic.headers['content-type']).toContain('image/svg+xml')
    expect(pic.headers['cache-control']).toBe('no-store')
    const stream = await t.hub.app.inject({ method: 'GET', url: `/api/devices/${d.id}/stream`, headers: auth() })
    expect(stream.json()).toMatchObject({ available: false, go2rtc: 'missing', canSnapshot: true })
  })

  it('manages WiFi networks without leaking passwords', async () => {
    const created = await t.hub.app.inject({ method: 'POST', url: '/api/wifi', headers: auth(), payload: { ssid: 'Guest', password: 'guest-pass' } })
    expect(created.statusCode).toBe(201)
    expect(created.body).not.toContain('guest-pass')
    const id = created.json().id as string
    const dup = await t.hub.app.inject({ method: 'POST', url: '/api/wifi', headers: auth(), payload: { ssid: 'Guest' } })
    expect(dup.statusCode).toBe(400)
    const list = await t.hub.app.inject({ method: 'GET', url: '/api/wifi', headers: auth() })
    expect(list.body).not.toContain('guest-pass')
    expect(list.body).not.toContain('home-pass')
    const del = await t.hub.app.inject({ method: 'DELETE', url: `/api/wifi/${id}`, headers: auth() })
    expect(del.statusCode).toBe(200)
  })

  it('describes the device families for the add-device form', async () => {
    const res = await t.hub.app.inject({ method: 'GET', url: '/api/families', headers: auth() })
    const families = res.json() as FamilyDescriptor[]
    const ids = families.map((f) => f.id)
    expect(ids).toEqual(expect.arrayContaining(['virtual', 'rtsp']))
    for (const f of families.filter((x) => x.kinds.length > 0)) {
      expect(f.label.length).toBeGreaterThan(2)
      expect(f.pathKinds.length).toBeGreaterThan(0)
      for (const field of f.fields) {
        expect(field.label, `${f.id}.${field.name}`).toBeTruthy()
        if (field.type === 'password') expect(field.secret, `${f.id}.${field.name} must be secret`).toBe(true)
        if (field.type === 'select') expect(field.options?.length, `${f.id}.${field.name} options`).toBeGreaterThan(0)
      }
      // Everything the owner reads: no build-stage wording.
      const shown = [f.label, f.tagline, ...f.notes, ...f.fields.flatMap((x) => [x.label, x.help ?? '', x.placeholder ?? '', ...(x.options ?? []).map((o) => o.label)])]
        .join(' \n ')
        .toLowerCase()
      for (const banned of ['demo', 'prototype', 'placeholder', 'todo', 'stub']) expect(shown, `${f.id} wording`).not.toMatch(new RegExp(`\\b${banned}\\b`))
    }
  })

  it('only proxies video for real cameras, and says so when live video is not installed', async () => {
    const unknown = await t.hub.app.inject({ method: 'GET', url: '/video/api/frame.jpeg?src=nope', headers: auth() })
    expect(unknown.statusCode).toBe(404)
    const raw = await t.hub.app.inject({ method: 'GET', url: '/video/api/frame.jpeg?src=rtsp://1.2.3.4/x', headers: auth() })
    expect(raw.statusCode).toBe(404)
    const cam = t.hub.registry.createDevice({
      name: 'Yard',
      kind: 'camera',
      family: 'rtsp',
      room: '',
      config: {},
      paths: [{ priority: 0, kind: 'lan', label: 'LAN', host: '192.168.1.90', port: 554 }],
    })
    const noVideo = await t.hub.app.inject({ method: 'GET', url: `/video/api/frame.jpeg?src=${cam.id}`, headers: auth() })
    expect(noVideo.statusCode).toBe(503)
    const anon = await t.hub.app.inject({ method: 'GET', url: `/video/api/frame.jpeg?src=${cam.id}` })
    expect(anon.statusCode).toBe(401)
  })

  it('reports hub status and the activity feed', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    await t.settle(t.hub.actions.request(d.id, { type: 'power.on' }))
    await t.hub.video.start() // no go2rtc in the test folder
    await t.hub.sms.start() // no modem configured
    const status = await t.hub.app.inject({ method: 'GET', url: '/api/hub/status', headers: auth() })
    expect(status.json()).toMatchObject({ devices: 1, video: { go2rtc: 'missing' }, sms: { modem: 'disabled' } })
    expect(status.json().video.detail).toMatch(/Live video is not installed yet/)
    expect(status.json().sms.detail).not.toMatch(/HC_/)
    const events = await t.hub.app.inject({ method: 'GET', url: `/api/events?deviceId=${d.id}`, headers: auth() })
    expect((events.json() as Array<{ type: string }>).some((e) => e.type === 'action.done')).toBe(true)
  })
})
