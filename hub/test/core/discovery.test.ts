/**
 * Finding devices: Smart Life announcements, recognising what answers at an
 * address, and the Smart Life account link that turns a found device into one
 * the hub can control.
 */
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SECRET_MASK, type DiscoveredDevice, type TuyaAccountDevice } from '@house/shared'
import { resetTuyaCloud } from '../../src/adapters/tuya-cloud.ts'
import { better, decodeTuyaBroadcast, identify, tuyaScan } from '../../src/discovery.ts'
import { logger } from '../../src/lib/log.ts'
import type { ServerResponse } from 'node:http'
import { mockServer, send, type MockServer, type RecordedRequest } from '../helpers.ts'
import { makeHub, type TestHub } from './harness.ts'

const log = logger('test')
const KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest()
const ANNOUNCE = { ip: '192.168.1.7', gwId: 'd79c9d00aa11bb22cchkq7', active: 2, ablilty: 0, encrypt: true, productKey: 'key8tg9kykj4g8dw', version: '3.5' }

/** A Tuya 3.3 / 3.4 announcement: 000055aa header, AES-ECB body, crc + suffix. */
function packet33(obj: object): Buffer {
  const c = crypto.createCipheriv('aes-128-ecb', KEY, null)
  const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
  const head = Buffer.alloc(20)
  head.writeUInt32BE(0x000055aa, 0)
  head.writeUInt32BE(0x13, 8)
  head.writeUInt32BE(body.length + 12, 12)
  return Buffer.concat([head, body, Buffer.from('000000000000aa55', 'hex')])
}

/** A Tuya 3.5 announcement: 00006699 header, AES-GCM body with the header as extra data. */
function packet35(obj: object): Buffer {
  const iv = crypto.randomBytes(12)
  const plain = Buffer.concat([Buffer.alloc(4), Buffer.from(JSON.stringify(obj))])
  const head = Buffer.alloc(18)
  head.writeUInt32BE(0x00006699, 0)
  head.writeUInt32BE(0x23, 10)
  head.writeUInt32BE(12 + plain.length + 16, 14)
  const c = crypto.createCipheriv('aes-128-gcm', KEY, iv)
  c.setAAD(head.subarray(4, 18))
  const enc = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([head, iv, enc, c.getAuthTag(), Buffer.from('00009966', 'hex')])
}

let t: TestHub | null = null
const servers: MockServer[] = []
afterEach(async () => {
  await t?.close()
  t = null
  for (const s of servers.splice(0)) await s.close()
  resetTuyaCloud()
})

describe('Smart Life announcements', () => {
  it('reads protocol 3.5, 3.3 and plain 3.1 announcements, and ignores anything else', () => {
    expect(decodeTuyaBroadcast(packet35(ANNOUNCE))).toEqual({ ip: '192.168.1.7', gwId: 'd79c9d00aa11bb22cchkq7', version: '3.5', productKey: 'key8tg9kykj4g8dw' })
    expect(decodeTuyaBroadcast(packet33({ ...ANNOUNCE, version: '3.3' }))).toMatchObject({ gwId: ANNOUNCE.gwId, version: '3.3' })
    const plain = Buffer.concat([Buffer.from('000055aa000000000000001300000000', 'hex').subarray(0, 16), Buffer.alloc(4), Buffer.from(JSON.stringify({ ip: '10.0.0.5', gwId: 'abc', version: '3.1' })), Buffer.alloc(8)])
    expect(decodeTuyaBroadcast(plain)).toMatchObject({ ip: '10.0.0.5', gwId: 'abc', version: '3.1' })
    expect(decodeTuyaBroadcast(Buffer.from('hello, not a tuya packet at all, just noise'))).toBeNull()
    const tampered = packet35(ANNOUNCE)
    tampered.writeUInt8(tampered.readUInt8(40) ^ 0xff, 40)
    expect(decodeTuyaBroadcast(tampered)).toBeNull()
    expect(decodeTuyaBroadcast(Buffer.alloc(3))).toBeNull()
  })

  it('hears a device on the network and says what is still needed to add it', async () => {
    // a free UDP port stands in for 6667
    const probe = dgram.createSocket('udp4')
    await new Promise<void>((r) => probe.bind(0, '127.0.0.1', r))
    const port = (probe.address() as AddressInfo).port
    probe.close()
    const heard: DiscoveredDevice[] = []
    const scan = tuyaScan(1.2, log, (d) => heard.push(d), [port])
    const sender = dgram.createSocket('udp4')
    await new Promise((r) => setTimeout(r, 150))
    sender.send(packet35(ANNOUNCE), port, '127.0.0.1')
    sender.send(packet35(ANNOUNCE), port, '127.0.0.1') // announcements repeat; one device, one entry
    const found = await scan
    sender.close()
    expect(found).toHaveLength(1)
    expect(heard).toHaveLength(1)
    expect(found[0]).toMatchObject({ family: 'tuya-local', host: '192.168.1.7', port: 6668, via: 'tuya', needs: ['localKey'], config: { deviceId: ANNOUNCE.gwId, version: '3.5' } })
    expect(found[0]!.hint).toMatch(/Smart Life account/)
  })
})

describe('recognising what answers at an address', () => {
  const at = async (handler: (req: RecordedRequest, res: ServerResponse) => unknown) => {
    const s = await mockServer((req, res) => {
      handler(req, res)
    })
    servers.push(s)
    return s
  }

  it('tells a Shelly, a Tasmota, a Hikvision, a Dahua and an ONVIF camera apart without any login', async () => {
    const shelly = await at((req, res) => (req.path === '/shelly' ? send(res, 200, { type: 'SHSW-1', mac: 'AABBCC112233', auth: false, fw: '1.14.0' }) : send(res, 404, 'no')))
    const tasmota = await at((req, res) => (req.path === '/cm' ? send(res, 200, { Status: { DeviceName: 'Veranda switch', FriendlyName: ['Veranda'] } }) : send(res, 404, 'no')))
    const locked = await at((req, res) => (req.path === '/cm' ? send(res, 401, { WARNING: 'Need user=<username>&password=<password>' }) : send(res, 404, 'no')))
    const hik = await at((req, res) => {
      if (req.path.startsWith('/ISAPI/')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Digest qop="auth", realm="IP Camera(C2183)", nonce="4e3238", stale="FALSE"' })
        return res.end()
      }
      send(res, 404, 'no')
    })
    const dahua = await at((req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="Login to 4C03D21PAJ4F1E2", qop="auth", nonce="1629884", opaque="abc"' })
      res.end()
    })
    const onvif = await at((req, res) =>
      req.method === 'POST' && req.path === '/onvif/device_service' && /GetSystemDateAndTime/.test(req.body)
        ? send(res, 200, '<s:Envelope><s:Body><tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime/></tds:GetSystemDateAndTimeResponse></s:Body></s:Envelope>', 'application/soap+xml')
        : send(res, 404, 'no'),
    )
    // a web page that even contains the words the checks look for must not be taken for a device
    const router = await at((_req, res) => send(res, 200, '<!doctype html><html><title>Router</title><script type="module"></script>DeviceInfo "Status": type=x</html>', 'text/html'))

    const one = async (s: MockServer) => (await identify('127.0.0.1', [s.port], log, s.port))[0]
    expect(await one(shelly)).toMatchObject({ family: 'shelly', kind: 'switch', port: shelly.port, needs: [], config: { generation: 'gen1' } })
    expect(await one(tasmota)).toMatchObject({ family: 'tasmota', name: 'Veranda switch', needs: [] })
    expect(await one(locked)).toMatchObject({ family: 'tasmota', needs: ['password'] })
    expect(await one(hik)).toMatchObject({ family: 'hikvision', kind: 'camera', needs: ['password'], config: { username: 'admin' } })
    expect(await one(dahua)).toMatchObject({ family: 'dahua', kind: 'camera', needs: ['password'] })
    expect(await one(onvif)).toMatchObject({ family: 'onvif', kind: 'camera', port: onvif.port, needs: ['username', 'password'] })
    expect(await identify('127.0.0.1', [router.port], log, router.port)).toEqual([]) // a router is not a device to add

    // recognising must never log in or switch anything
    for (const s of [shelly, tasmota, hik, dahua, onvif]) {
      expect(s.requests.every((r) => !r.headers.authorization)).toBe(true)
      expect(s.requests.every((r) => !/turn=|Power|relay/i.test(r.url))).toBe(true)
    }
  })

  it('falls back to what the open ports say', async () => {
    expect((await identify('192.0.2.10', [554], log))[0]).toMatchObject({ family: 'rtsp', kind: 'camera', port: 554 })
    expect((await identify('192.0.2.10', [34567], log))[0]).toMatchObject({ family: 'rtsp', name: 'ICSee / XMEye camera', config: { streamUrl: expect.stringContaining('dvrip://') } })
    expect((await identify('192.0.2.10', [6668], log))[0]).toMatchObject({ family: 'tuya-local', needs: ['deviceId', 'localKey'] })
    expect(await identify('192.0.2.10', [], log)).toEqual([])
  })

  it('answers "I know its address" through the API, and says plainly when nothing is there', async () => {
    t = await makeHub()
    const headers = { authorization: `Bearer ${t.token()}` }
    const shelly = await at((req, res) => (req.path === '/shelly' ? send(res, 200, { type: 'SHSW-1', mac: 'AABBCC112233', auth: true }) : send(res, 404, 'no')))
    const ok = await t.hub.app.inject({ method: 'POST', url: '/api/detect', headers, payload: { host: `http://127.0.0.1:${shelly.port}/` } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()[0]).toMatchObject({ family: 'shelly', host: '127.0.0.1', port: shelly.port, via: 'address', needs: ['password'], existingDeviceId: null })

    const added = t.hub.registry.createDevice({ name: 'Pump', kind: 'switch', family: 'shelly', room: '', config: {}, paths: [{ priority: 0, kind: 'lan', label: 'LAN', host: '127.0.0.1', port: shelly.port }] })
    const again = await t.hub.app.inject({ method: 'POST', url: '/api/detect', headers, payload: { host: `127.0.0.1:${shelly.port}` } })
    expect(again.json()[0].existingDeviceId).toBe(added.id)

    const port = shelly.port
    await shelly.close()
    servers.splice(servers.indexOf(shelly), 1)
    const none = await t.hub.app.inject({ method: 'POST', url: '/api/detect', headers, payload: { host: `127.0.0.1:${port}` } })
    expect(none.statusCode).toBe(404)
    expect(none.json().error).toMatch(/Nothing the hub recognises answered at 127\.0\.0\.1/)
    for (const bad of ['not an address!', '192.168.1.5:99999', 'a b']) {
      const res = await t.hub.app.inject({ method: 'POST', url: '/api/detect', headers, payload: { host: bad } })
      expect(res.statusCode, bad).toBe(400)
    }
    expect((await t.hub.app.inject({ method: 'POST', url: '/api/detect', payload: { host: '127.0.0.1' } })).statusCode).toBe(401)
  })
})

describe('the Smart Life account link', () => {
  const GATE_KEY = 'a1b2c3d4e5f6g7h8'
  /** Stands in for Tuya's cloud: one project (good-id / good-secret is not checked by signature here, only the id). */
  const tuyaCloud = () =>
    mockServer((req, res) => {
      const ok = (result: unknown) => send(res, 200, { result, success: true, t: Date.now() })
      const fail = (code: number, msg: string) => send(res, 200, { code, msg, success: false, t: Date.now() })
      if (req.headers.client_id !== 'good-id') return fail(1004, 'sign invalid')
      if (req.path === '/v1.0/token') return ok({ access_token: 'tok-1', expire_time: 7200, refresh_token: 'r', uid: 'project-uid' })
      if (req.headers.access_token !== 'tok-1') return fail(1010, 'token invalid')
      if (req.path === '/v1.0/devices/gate1') return ok({ id: 'gate1', uid: 'app-user-1', name: 'Main Gate' })
      if (req.path.startsWith('/v1.0/devices/')) return fail(1106, 'permission deny')
      if (req.path === '/v1.0/users/app-user-1/devices')
        return ok([
          { id: 'gate1', name: 'Main Gate', category: 'ckmkzq', product_name: 'Garage Door Opener', online: true, local_key: GATE_KEY },
          { id: 'bulb1', name: 'Porch bulb', category: 'dj', product_name: 'Smart Bulb', online: true, local_key: 'bulbbulbbulbbulb' },
          { id: 'cam1', name: 'Yard camera', category: 'sp', product_name: '4G Camera', online: true, local_key: 'camcamcamcamcamc' },
        ])
      return fail(1108, 'uri path invalid')
    })
  const heardGate: DiscoveredDevice = { family: 'tuya-local', kind: 'switch', name: 'Smart Life device', host: '192.168.1.7', port: 6668, detail: 'Tuya protocol 3.5', config: { deviceId: 'gate1', version: '3.5' }, via: 'tuya', needs: ['localKey'] }

  it('refuses wrong codes, stores right ones encrypted, and never shows the secret again', async () => {
    t = await makeHub()
    const cloud = await tuyaCloud()
    servers.push(cloud)
    await expect(t.hub.tuya.link({ accessId: 'bad-id', accessSecret: 'x', apiBase: cloud.url })).rejects.toThrow(/Tuya refused that Access ID and Secret/)
    expect(t.hub.tuya.status().linked).toBe(false)
    await expect(t.hub.tuya.link({ accessId: '', accessSecret: '' })).rejects.toThrow(/Enter both/)

    const status = await t.hub.tuya.link({ accessId: 'good-id', accessSecret: 'very-secret-value', apiBase: cloud.url })
    expect(status).toEqual({ linked: true, region: 'in', accessIdHint: '…d-id' })
    const row = t.hub.db.prepare("SELECT value FROM settings WHERE key = 'tuya_account'").get() as { value: string }
    expect(row.value).toMatch(/^enc:v1:/)
    expect(row.value).not.toContain('very-secret-value')
    const api = await t.hub.app.inject({ method: 'GET', url: '/api/tuya/account', headers: { authorization: `Bearer ${t.token()}` } })
    expect(api.body).not.toContain('very-secret-value')

    t.hub.tuya.unlink()
    expect(t.hub.tuya.status().linked).toBe(false)
  })

  it('lists the account with real names, and adds a device heard on the WiFi with its key in one step', async () => {
    t = await makeHub()
    const cloud = await tuyaCloud()
    servers.push(cloud)
    await t.hub.tuya.link({ accessId: 'good-id', accessSecret: 's', apiBase: cloud.url })

    const list = await t.hub.tuya.devices([heardGate])
    expect(list.map((d: TuyaAccountDevice) => [d.name, d.categoryLabel, d.suggestedKind, d.supported, d.lanHost])).toEqual([
      ['Main Gate', 'Garage door opener', 'gate', true, '192.168.1.7'],
      ['Porch bulb', 'Light', 'light', true, null],
      ['Yard camera', 'Camera', 'camera', false, null],
    ])
    expect(JSON.stringify(list)).not.toContain(GATE_KEY) // keys stay on the hub

    const [gate, bulb] = t.hub.tuya.importDevices([{ id: 'gate1' }, { id: 'bulb1' }], [heardGate])
    // on the WiFi: controlled inside the house, with the key the account gave
    expect(gate).toMatchObject({ name: 'Main Gate', kind: 'gate', family: 'tuya-local', config: { deviceId: 'gate1', version: '3.5', gateMode: 'hold', localKey: SECRET_MASK } })
    expect(gate!.paths[0]).toMatchObject({ kind: 'lan', host: '192.168.1.7', port: 6668 })
    expect(gate!.capabilities).toEqual(expect.arrayContaining(['gate', 'gate-state']))
    expect(t.hub.registry.getDeviceUnmasked(gate!.id)!.config.localKey).toBe(GATE_KEY)
    // not heard on the WiFi: reached through the cloud
    expect(bulb).toMatchObject({ name: 'Porch bulb', kind: 'light', family: 'tuya-cloud', config: { deviceId: 'bulb1', accessSecret: SECRET_MASK } })
    expect(bulb!.paths[0]!.kind).toBe('cloud')

    // adding twice does nothing; the list now points at the house device
    expect(t.hub.tuya.importDevices([{ id: 'gate1' }], [heardGate])).toEqual([])
    const again = await t.hub.tuya.devices([heardGate])
    expect(again[0]!.existingDeviceId).toBe(gate!.id)
    expect(() => t!.hub.tuya.importDevices([{ id: 'cam1' }], [])).toThrow(/camera, which this version cannot drive yet/)
    // the owner can say a plain switch is the gate
    t.hub.registry.deleteDevice(gate!.id)
    const asSwitch = t.hub.tuya.importDevices([{ id: 'gate1', kind: 'switch', name: 'Gate relay' }], [heardGate])[0]!
    expect(asSwitch).toMatchObject({ name: 'Gate relay', kind: 'switch' })
  })

  it('explains what to do when the hub knows no device of the account yet', async () => {
    t = await makeHub()
    const cloud = await tuyaCloud()
    servers.push(cloud)
    await expect(t.hub.tuya.devices([])).rejects.toThrow(/Link your Smart Life account first/)
    await t.hub.tuya.link({ accessId: 'good-id', accessSecret: 's', apiBase: cloud.url })
    await expect(t.hub.tuya.devices([])).rejects.toThrow(/has not heard any Smart Life device yet/)
    const stranger: DiscoveredDevice = { ...heardGate, config: { deviceId: 'someone-elses', version: '3.3' } }
    await expect(t.hub.tuya.devices([stranger])).rejects.toThrow(/Link App Account/)
    expect((await t.hub.tuya.devices([], 'gate1')).length).toBe(3) // a typed device id is enough
  })
})

describe('one address found by two methods', () => {
  const dahua: DiscoveredDevice = { family: 'dahua', kind: 'camera', name: 'Dahua / CP Plus camera', host: '192.168.1.5', port: 80, detail: 'Dahua or CP Plus', config: { username: 'admin' }, via: 'scan', needs: ['password'] }
  const onvif: DiscoveredDevice = { family: 'onvif', kind: 'camera', name: 'CPPLUS', host: '192.168.1.5', port: 80, detail: 'CP-UVR-0801E1-CV4 · /onvif/device_service', config: { username: '', password: '', onvifPath: '/onvif/device_service' }, via: 'onvif', needs: ['username', 'password'] }

  it('keeps the maker\u2019s own family over the generic ONVIF answer, whichever came first, and borrows the model name', () => {
    for (const [first, second] of [
      [onvif, dahua],
      [dahua, onvif],
    ] as const) {
      const kept = better(better(undefined, first), second)
      expect(kept.family).toBe('dahua')
      expect(kept.detail).toBe('CP-UVR-0801E1-CV4 · Dahua or CP Plus')
      expect(kept.config).toEqual({ username: 'admin' })
      expect(kept.needs).toEqual(['password'])
    }
  })

  it('a Smart Life device announcing itself beats the sweep\u2019s guess and keeps its id', () => {
    const sweep: DiscoveredDevice = { family: 'tuya-local', kind: 'switch', name: 'Smart Life device', host: '192.168.1.2', port: 6668, detail: 'Tuya', config: {}, via: 'scan', needs: ['deviceId', 'localKey'] }
    const heard: DiscoveredDevice = { ...sweep, detail: 'Tuya protocol 3.5', config: { deviceId: 'd79c9d1dc34fc0628bhkq7', version: '3.5' }, via: 'tuya', needs: ['localKey'] }
    for (const [first, second] of [
      [sweep, heard],
      [heard, sweep],
    ] as const) {
      const kept = better(better(undefined, first), second)
      expect(kept.detail).toBe('Tuya protocol 3.5')
      expect(kept.needs).toEqual(['localKey'])
      expect(kept.config).toEqual({ deviceId: 'd79c9d1dc34fc0628bhkq7', version: '3.5' })
    }
  })

  it('an ONVIF camera without a model name, or bare video, adds nothing to what is known', () => {
    const first = better(undefined, dahua)
    expect(better(first, { ...dahua })).toBe(first)
    expect(better(first, { ...onvif, detail: '/onvif/device_service' })).toBe(first)
    expect(better(first, { family: 'rtsp', kind: 'camera', name: 'Camera with video address', host: '192.168.1.5', port: 554, detail: 'Video (RTSP) on port 554', config: {}, via: 'scan', needs: ['streamUrl'] })).toBe(first)
    // generic ONVIF still beats bare video
    const rtsp = better(undefined, { family: 'rtsp', kind: 'camera', name: 'Camera with video address', host: '192.168.1.9', port: 554, detail: 'Video (RTSP) on port 554', config: {}, via: 'scan', needs: ['streamUrl'] })
    expect(better(rtsp, { ...onvif, host: '192.168.1.9' }).family).toBe('onvif')
  })
})
