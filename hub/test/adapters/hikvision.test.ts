/**
 * Hikvision ISAPI adapter against a mock camera. Every payload the mock serves
 * is the shape given in docs/protocols/hikvision-isapi.md (DeviceInfo,
 * ResponseStatus, PTZStatus, PTZPresetList, NetworkInterfaceList, Wireless,
 * accessPointList, Dialstatus), behind the digest challenge a real camera sends.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import adapter, { hikvisionBaseUrl, resetHikvisionSessions } from '../../src/adapters/hikvision.ts'
import { sleep } from '../../src/lib/http.ts'
import { makeAction, makeCtx, mockServer, send, TINY_JPEG, type MockServer, type RecordedRequest } from '../helpers.ts'

// ---------------------------------------------------------------- payloads

const XML = '<?xml version="1.0" encoding="UTF-8"?>'
const ISAPI_NS = 'http://www.isapi.org/ver20/XMLSchema'
const HIK_NS = 'http://www.hikvision.com/ver20/XMLSchema'

const DEVICE_INFO = `${XML}
<DeviceInfo version="2.0" xmlns="${HIK_NS}">
<deviceName>Gate camera</deviceName>
<deviceID>88ff2e00-9d3a-11b4-82f1-4419b66d2485</deviceID>
<model>DS-2DE2A404IW-DE3</model>
<serialNumber>DS-2DE2A404IW-DE320200612AAWRE12345678</serialNumber>
<macAddress>44:19:B6:6D:24:85</macAddress>
<firmwareVersion>V5.5.82</firmwareVersion>
<firmwareReleasedDate>build 190220</firmwareReleasedDate>
<bootVersion>V1.3.4</bootVersion>
<hardwareVersion>0x0</hardwareVersion>
<encoderVersion>V7.3</encoderVersion>
<deviceType>IPDome</deviceType>
<telecontrolID>88</telecontrolID>
<supportBeep>false</supportBeep>
</DeviceInfo>`

const status = (url: string, code: number, text: string, sub: string) =>
  `${XML}<ResponseStatus version="2.0" xmlns="${HIK_NS}"><requestURL>${url}</requestURL><statusCode>${code}</statusCode><statusString>${text}</statusString><subStatusCode>${sub}</subStatusCode></ResponseStatus>`

const OK = (url: string) => status(url, 1, 'OK', 'ok')

/** What a camera puts in the body of a 401 that follows a wrong password. */
const loginRefused = (lock: 'unlock' | 'locked', retryTimes: number, resLockTime: number) =>
  `${XML}<ResponseStatus version="2.0" xmlns="http://www.std-cgi.org/ver20/XMLSchema"><requestURL>/ISAPI/System/deviceInfo</requestURL><statusCode>4</statusCode><statusString>Invalid Operation</statusString><subStatusCode>invalidOperation</subStatusCode><lockStatus>${lock}</lockStatus><retryTimes>${retryTimes}</retryTimes><resLockTime>${resLockTime}</resLockTime></ResponseStatus>`

const PTZ_STATUS = `${XML}<PTZStatus version="2.0" xmlns="${HIK_NS}"><AbsoluteHigh><elevation>450</elevation><azimuth>900</azimuth><absoluteZoom>20</absoluteZoom></AbsoluteHigh></PTZStatus>`

const PRESETS = `${XML}<PTZPresetList version="2.0" xmlns="${HIK_NS}">
<PTZPreset version="2.0" xmlns="${ISAPI_NS}"><enabled>true</enabled><id>1</id><presetName>Gate</presetName></PTZPreset>
<PTZPreset version="2.0" xmlns="${ISAPI_NS}"><enabled>true</enabled><id>2</id><presetName>Front door</presetName></PTZPreset>
<PTZPreset version="2.0" xmlns="${ISAPI_NS}"><enabled>false</enabled><id>3</id><presetName>Preset 3</presetName></PTZPreset>
</PTZPresetList>`

const wireless = (ssid: string, extra = '') =>
  `${XML}<Wireless version="2.0" xmlns="${HIK_NS}"><enabled>true</enabled><wirelessNetworkMode>infrastructure</wirelessNetworkMode><channel>6</channel><ssid>${ssid}</ssid><wmmEnabled>true</wmmEnabled><WirelessSecurity><securityMode>WPA2-personal</securityMode><WPA><algorithmType>AES</algorithmType><sharedKey></sharedKey><wpaKeyLength>12</wpaKeyLength></WPA></WirelessSecurity>${extra}</Wireless>`

const INTERFACES_WITH_WIFI = `${XML}<NetworkInterfaceList version="2.0" xmlns="${HIK_NS}">
<NetworkInterface><id>1</id><IPAddress><ipVersion>v4</ipVersion><addressingType>dynamic</addressingType><ipAddress>192.168.1.64</ipAddress><subnetMask>255.255.255.0</subnetMask></IPAddress><Discovery/><Link/><defaultConnection>true</defaultConnection><macAddress>44:19:b6:6d:24:85</macAddress></NetworkInterface>
<NetworkInterface><id>2</id><IPAddress><ipVersion>v4</ipVersion><addressingType>dynamic</addressingType><ipAddress>192.168.1.65</ipAddress><subnetMask>255.255.255.0</subnetMask></IPAddress>${wireless('HouseWiFi').replace(XML, '')}<Discovery/><Link/><defaultConnection>false</defaultConnection><macAddress>44:19:b6:6d:24:86</macAddress></NetworkInterface>
</NetworkInterfaceList>`

/** Firmware that lists the interfaces without the WiFi details inside. */
const INTERFACES_PLAIN = INTERFACES_WITH_WIFI.replace(/<Wireless[\s\S]*<\/Wireless>/, '')

/** What a camera answers for a service the model does not have. */
const notSupported = (url: string): [number, string] => [403, status(url, 4, 'Invalid Operation', 'notSupport')]

const INTERFACES_CABLE_ONLY = `${XML}<NetworkInterfaceList version="2.0" xmlns="${HIK_NS}">
<NetworkInterface><id>1</id><IPAddress><ipVersion>v4</ipVersion><addressingType>static</addressingType><ipAddress>192.168.1.70</ipAddress><subnetMask>255.255.255.0</subnetMask></IPAddress><Discovery/><Link/><defaultConnection>true</defaultConnection><macAddress>44:19:b6:6d:24:90</macAddress></NetworkInterface>
</NetworkInterfaceList>`

const ap = (id: number, ssid: string, signal: number, mode: string, connected = false) =>
  `<accessPoint><id>${id}</id><networkMode>infrastructure</networkMode><channel>6</channel><ssid>${ssid}</ssid><speed>72</speed><signalStrength>${signal}</signalStrength><securityMode>${mode}</securityMode><connected>${connected}</connected><connecting>false</connecting></accessPoint>`

const ACCESS_POINTS = `${XML}<accessPointList version="2.0" xmlns="${HIK_NS}">
${ap(1, 'HouseWiFi', 61, 'WPA2-personal', true)}
${ap(2, 'HouseWiFi2', 78, 'WPA2-personal')}
${ap(3, 'HouseWiFi2', 40, 'WPA2-personal')}
${ap(4, '', 55, 'WPA2-personal')}
${ap(5, 'Cafe', 22, 'disable')}
${ap(6, 'Office', 35, 'WPA2-enterprise')}
</accessPointList>`

const dialstatus = (signal: number, ip: string, uim = 'VALID') =>
  `${XML}<Dialstatus version="1.0" xmlns="${HIK_NS}"><RealtimeMode>LTE</RealtimeMode><UIMInfo>${uim}</UIMInfo><SignalStrength>${signal}</SignalStrength><Dialstat>connected</Dialstat><IpAddress><ipAddress>${ip}</ipAddress></IpAddress><SubnetMask>255.255.255.255</SubnetMask><Gateway>0.0.0.0</Gateway><DNSAddress>8.8.8.8</DNSAddress></Dialstatus>`

const CONTINUOUS = (pan: number, tilt: number, zoom: number) =>
  `${XML}<PTZData version="2.0" xmlns="${ISAPI_NS}"><pan>${pan}</pan><tilt>${tilt}</tilt><zoom>${zoom}</zoom></PTZData>`

// ---------------------------------------------------------------- mock camera

const USER = 'admin'
const PASS = 'hik12345'
const REALM = 'IP Camera(C2183)'

/**
 * The login a Hikvision camera does: 401 + `WWW-Authenticate: Digest qop="auth",
 * realm="IP Camera(…)", nonce="…", stale="FALSE"` until the request carries a
 * correct RFC 2617 answer. A wrong answer gets the 401 again, with the lock
 * state in the body.
 */
function cameraLogin(password: string, refusedBody: () => string) {
  const nonce = crypto.randomBytes(16).toString('hex')
  const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')
  return (req: RecordedRequest, res: http.ServerResponse): boolean => {
    const header = req.headers.authorization ?? ''
    const challenge = { 'WWW-Authenticate': `Digest qop="auth", realm="${REALM}", nonce="${nonce}", stale="FALSE"` }
    if (!/^digest/i.test(header)) {
      res.writeHead(401, challenge)
      res.end()
      return false
    }
    const p: Record<string, string> = {}
    const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g
    let m: RegExpExecArray | null
    while ((m = re.exec(header))) p[m[1]!] = (m[2] ?? m[3] ?? '').trim()
    const expected = md5(`${md5(`${p.username}:${REALM}:${password}`)}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${md5(`${req.method}:${p.uri}`)}`)
    if (p.username === USER && p.response === expected && p.uri === req.url && p.qop === 'auth') return true
    res.writeHead(401, { ...challenge, 'Content-Type': 'application/xml; charset="UTF-8"' })
    res.end(refusedBody())
    return false
  }
}

const HANG = Symbol('never answers')
type Reply = string | Buffer | [number, string] | typeof HANG
type Routes = Record<string, Reply | ((req: RecordedRequest) => Reply)>

interface CameraOptions {
  password?: string
  refusedBody?: () => string
  /** When true the camera answers nothing at all (it has left the network). */
  gone?: () => boolean
}

let server: MockServer | null = null

async function camera(routes: Routes, opts: CameraOptions = {}): Promise<MockServer> {
  const login = cameraLogin(opts.password ?? PASS, opts.refusedBody ?? (() => loginRefused('unlock', 4, 0)))
  server = await mockServer((req, res) => {
    if (opts.gone?.()) return
    if (!login(req, res)) return
    const route = routes[`${req.method} ${req.path}`]
    const reply = typeof route === 'function' ? route(req) : route
    if (reply === undefined) return send(res, 404, '')
    if (reply === HANG) return
    if (Buffer.isBuffer(reply)) return send(res, 200, reply, 'image/jpeg')
    if (Array.isArray(reply)) return send(res, reply[0], reply[1], 'application/xml; charset="UTF-8"')
    send(res, 200, reply, 'application/xml; charset="UTF-8"')
  })
  return server
}

/** Requests that carried the login — i.e. what the camera actually acted on. */
function acted(s: MockServer): RecordedRequest[] {
  return s.requests.filter((r) => r.headers.authorization)
}

function calls(s: MockServer): string[] {
  return acted(s).map((r) => `${r.method} ${r.url}`)
}

function ctxFor(s: MockServer, config: Record<string, unknown> = {}, extra: { timeoutMs?: number } = {}) {
  return makeCtx({ family: 'hikvision', config: { username: USER, password: PASS, ...config }, path: { port: s.port }, timeoutMs: extra.timeoutMs })
}

afterEach(async () => {
  vi.useRealTimers()
  resetHikvisionSessions()
  await server?.close()
  server = null
})

/** Move the hub's clock forward without waiting (only the clock: real timers and sockets keep running). */
function later(minutes: number): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.now() + minutes * 60_000))
}

/**
 * A certificate the way a camera makes one for itself (self-signed). Made with
 * openssl when the machine has it; the HTTPS test is skipped when it does not.
 */
const SELF_SIGNED = (() => {
  let dir: string | null = null
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hik-tls-'))
    const keyFile = path.join(dir, 'key.pem')
    const certFile = path.join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=IP Camera'],
      { stdio: 'ignore', timeout: 20_000 },
    )
    return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') }
  } catch {
    return null
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})()

// ---------------------------------------------------------------- tests

describe('hikvision adapter: add-device form', () => {
  it('describes itself in plain words', () => {
    const d = adapter.describe()
    expect(adapter.family).toBe('hikvision')
    expect(d.id).toBe('hikvision')
    expect(d.kinds).toEqual(['camera'])
    expect(d.pathKinds).toEqual(['lan', 'cellular'])
    expect(d.defaultPort).toBe(80)
    expect(d.fields.map((f) => f.name)).toEqual(['username', 'password', 'channel', 'https', 'rtspPort', 'ptz', 'wifi', 'cellular'])
    const field = (name: string) => d.fields.find((f) => f.name === name)!
    expect(field('password').secret).toBe(true)
    expect(field('channel').default).toBe(1)
    expect(field('rtspPort').default).toBe(554)
    expect(field('ptz').default).toBe(false)
    expect(field('wifi').default).toBe(true)
    expect(field('cellular').default).toBe(false)
    expect(field('cellular').label).toBe('This camera has a SIM')
    for (const f of d.fields) expect(f.help, f.name).toBeTruthy()
    const notes = d.notes.join(' ')
    expect(notes).toMatch(/ISAPI/)
    expect(notes).toMatch(/locks the admin login/)
    const visible = JSON.stringify(d)
    expect(visible).not.toMatch(/\b(demo|prototype|placeholder|stub|todo)\b/i)
    expect(field('https').help).toMatch(/443/)
  })

  it('builds the address from the connection in use, and uses the secure port when HTTPS is on', () => {
    const at = (config: Record<string, unknown>, p: Parameters<typeof makeCtx>[0]['path']) =>
      hikvisionBaseUrl(makeCtx({ family: 'hikvision', config: { username: USER, password: PASS, ...config }, path: p }))
    expect(at({}, { host: '192.168.1.64', port: 80 })).toBe('http://192.168.1.64')
    expect(at({}, { host: '49.36.12.200', port: 8080, kind: 'cellular' })).toBe('http://49.36.12.200:8080')
    // The app fills in 80 for every new connection; with HTTPS on that means the usual secure port.
    expect(at({ https: true }, { host: '192.168.1.64', port: 80 })).toBe('https://192.168.1.64')
    expect(at({ https: true }, { host: '192.168.1.64', port: null })).toBe('https://192.168.1.64')
    expect(at({ https: true }, { host: '192.168.1.64', port: 8443 })).toBe('https://192.168.1.64:8443')
  })

  it('works out capabilities from the switches', () => {
    expect(adapter.capabilities({}, 'camera')).toEqual(['stream', 'snapshot', 'reboot', 'state', 'wifi', 'wifi-scan'])
    expect(adapter.capabilities({ ptz: true, wifi: false, cellular: true }, 'camera')).toEqual(['stream', 'snapshot', 'reboot', 'state', 'ptz', 'presets', 'cellular'])
    expect(adapter.capabilities({ ptz: 'true', wifi: 'false' }, 'camera')).toEqual(['stream', 'snapshot', 'reboot', 'state', 'ptz', 'presets'])
    for (const c of adapter.capabilities({ ptz: true, cellular: true }, 'camera')) expect(adapter.describe().capabilities).toContain(c)
  })
})

describe('hikvision adapter: probe', () => {
  it('logs in with digest and reads who the camera is', async () => {
    const s = await camera({ 'GET /ISAPI/System/deviceInfo': DEVICE_INFO })
    const res = await adapter.probe(ctxFor(s))
    expect(res.ok).toBe(true)
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)
    expect(res.info).toMatchObject({
      model: 'DS-2DE2A404IW-DE3',
      firmware: 'V5.5.82 build 190220',
      serial: 'DS-2DE2A404IW-DE320200612AAWRE12345678',
      mac: '44:19:b6:6d:24:85',
    })
    expect(s.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /ISAPI/System/deviceInfo', 'GET /ISAPI/System/deviceInfo'])
    expect(s.requests[0]!.headers.authorization).toBeUndefined()
    expect(s.requests[1]!.headers.authorization).toMatch(/^Digest username="admin", realm="IP Camera\(C2183\)"/)
  })

  it('says so when the password is wrong, and does not keep knocking', async () => {
    const s = await camera({ 'GET /ISAPI/System/deviceInfo': DEVICE_INFO })
    const wrong = ctxFor(s, { password: 'nope-nope' })
    const first = await adapter.probe(wrong)
    expect(first).toMatchObject({ ok: false, latencyMs: null })
    expect(first.error).toBe('Wrong username or password (the camera allows 4 more tries before it locks this login)')
    expect(acted(s)).toHaveLength(1)

    // The hub checks every few seconds; the camera must not see those.
    const before = s.requests.length
    const second = await adapter.probe(wrong)
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/^Wrong username or password\. The hub will not try again for 10 minutes/)
    expect(second.error).not.toContain('nope-nope')
    const act = await adapter.execute(wrong, makeAction('reboot'))
    expect(act.ok).toBe(false)
    expect(act.error).toMatch(/^Wrong username or password/)
    expect(s.requests.length).toBe(before)

    // Correcting the password is tried straight away.
    expect((await adapter.probe(ctxFor(s))).ok).toBe(true)
  })

  it('stops for good when the camera says tries are running out, until the device is saved again', async () => {
    const s = await camera({ 'GET /ISAPI/System/deviceInfo': DEVICE_INFO }, { refusedBody: () => loginRefused('unlock', 2, 0) })
    const wrong = ctxFor(s, { password: 'still-wrong' })
    expect((await adapter.probe(wrong)).error).toBe('Wrong username or password (the camera allows 2 more tries before it locks this login)')
    const again = await adapter.probe(wrong)
    expect(again.error).toMatch(/The hub has stopped trying/)
    expect(acted(s)).toHaveLength(1)
    wrong.device.updatedAt = new Date(1000).toISOString()
    await adapter.probe(wrong)
    expect(acted(s)).toHaveLength(2)
  })

  it('waits out a lock instead of making it longer', async () => {
    const s = await camera({ 'GET /ISAPI/System/deviceInfo': DEVICE_INFO }, { password: 'changed-on-camera', refusedBody: () => loginRefused('locked', 0, 1680) })
    const res = await adapter.probe(ctxFor(s))
    expect(res.ok).toBe(false)
    expect(res.error).toBe('The camera has locked this login after too many wrong passwords. It unlocks in about 28 minutes.')
    const before = s.requests.length
    const other = await adapter.probe(ctxFor(s, { password: 'changed-on-camera' }))
    expect(other.error).toMatch(/locked this login/)
    expect(s.requests.length).toBe(before)
  })

  it('sends a wrong password once even when several things are read at the same moment', async () => {
    const s = await camera({})
    const ctx = ctxFor(s, { password: 'nope-nope', ptz: true, wifi: true, cellular: true })
    await expect(adapter.readState!(ctx)).rejects.toThrow(/Wrong username or password/)
    expect(acted(s)).toHaveLength(1)
  })

  it('explains a camera that does not answer', async () => {
    const s = await camera({})
    const port = s.port
    await s.close()
    server = null
    const down = await adapter.probe(makeCtx({ family: 'hikvision', config: { username: USER, password: PASS }, path: { port } }))
    expect(down).toMatchObject({ ok: false, latencyMs: null })
    expect(down.error).toMatch(/refused the connection/)

    const silent = await camera({}, { gone: () => true })
    const slow = await adapter.probe(ctxFor(silent, {}, { timeoutMs: 300 }))
    expect(slow.ok).toBe(false)
    expect(slow.error).toBe('The camera did not answer within 1 second')
  })

  it('explains a missing address, a missing login and a device that is not a Hikvision', async () => {
    const noHost = await adapter.probe(makeCtx({ family: 'hikvision', config: { username: USER, password: PASS }, path: { host: '', label: 'SIM', kind: 'cellular' } }))
    expect(noHost).toMatchObject({ ok: false, error: 'No address set on the "SIM" connection' })

    const s = await camera({})
    const noLogin = await adapter.probe(makeCtx({ family: 'hikvision', config: {}, path: { port: s.port } }))
    expect(noLogin.error).toMatch(/username and password/)
    expect(s.requests).toHaveLength(0)

    const other = await adapter.probe(ctxFor(s))
    expect(other.ok).toBe(false)
    expect(other.error).toMatch(/not as a Hikvision camera/)
  })

  it('tries a refused login again after ten minutes, once', async () => {
    const s = await camera({ 'GET /ISAPI/System/deviceInfo': DEVICE_INFO })
    const wrong = ctxFor(s, { password: 'nope-nope' })
    await adapter.probe(wrong)
    await adapter.probe(wrong)
    expect(acted(s)).toHaveLength(1)
    later(11)
    expect((await adapter.probe(wrong)).error).toMatch(/^Wrong username or password \(the camera allows 4 more tries/)
    await adapter.probe(wrong)
    expect(acted(s)).toHaveLength(2)
  })

  it('gives up within the time the hub allows when the camera is slow at every step', async () => {
    const login = cameraLogin(PASS, () => loginRefused('unlock', 4, 0))
    server = await mockServer(async (req, res) => {
      await sleep(220)
      if (login(req, res)) send(res, 200, DEVICE_INFO, 'application/xml; charset="UTF-8"')
    })
    const res = await adapter.probe(ctxFor(server, {}, { timeoutMs: 300 }))
    expect(res).toEqual({ ok: false, latencyMs: null, error: 'The camera did not answer within 1 second' })
  })

  it('explains a camera that hangs up, sends rubbish, is still starting or only answers on https', async () => {
    server = await mockServer((_req, _res, raw) => void raw.socket.destroy())
    const hungUp = await adapter.probe(ctxFor(server))
    expect(hungUp.ok).toBe(false)
    expect(hungUp.error).toMatch(/closed the connection/)
    await server.close()

    const rubbish = await camera({ 'GET /ISAPI/System/deviceInfo': '<html><head><title>Login</title></head><body><h1>Welcome<br></body></html>' })
    expect((await adapter.probe(ctxFor(rubbish))).error).toMatch(/not as a Hikvision camera/)
    await rubbish.close()

    const url = '/ISAPI/System/deviceInfo'
    const starting = await camera({ [`GET ${url}`]: [503, status(url, 2, 'Device Busy', 'deviceBusy')] })
    expect(await adapter.probe(ctxFor(starting))).toEqual({ ok: false, latencyMs: null, error: 'The camera answered, but it is busy or still starting up. It should be back in a minute.' })
    await starting.close()

    server = await mockServer((req, res) => {
      res.writeHead(302, { Location: `https://127.0.0.1${req.url}` })
      res.end()
    })
    const secureOnly = await adapter.probe(ctxFor(server))
    expect(secureOnly.ok).toBe(false)
    expect(secureOnly.error).toMatch(/Turn on “Use HTTPS”/)
    const act = await adapter.execute(ctxFor(server), makeAction('reboot'))
    expect(act.ok).toBe(false)
    expect(act.error).toMatch(/Turn on “Use HTTPS”/)
  })

  it.skipIf(!SELF_SIGNED)('talks to a camera on its secure address and accepts the certificate it made for itself', async () => {
    const login = cameraLogin(PASS, () => loginRefused('unlock', 4, 0))
    const served: string[] = []
    const tls = https.createServer({ key: SELF_SIGNED!.key, cert: SELF_SIGNED!.cert }, (raw, res) => {
      const u = new URL(raw.url ?? '/', 'https://mock')
      const req: RecordedRequest = { method: raw.method ?? 'GET', url: raw.url ?? '/', path: u.pathname, query: u.searchParams, headers: raw.headers, body: '' }
      raw.resume()
      if (!login(req, res)) return
      served.push(`${req.method} ${req.url}`)
      if (req.path === '/ISAPI/System/deviceInfo') return send(res, 200, DEVICE_INFO, 'application/xml; charset="UTF-8"')
      if (req.path === '/ISAPI/Streaming/channels/101/picture') return send(res, 200, TINY_JPEG, 'image/jpeg')
      send(res, 404, '')
    })
    await new Promise<void>((done) => tls.listen(0, '127.0.0.1', done))
    try {
      const ctx = makeCtx({ family: 'hikvision', config: { username: USER, password: PASS, https: true }, path: { port: (tls.address() as AddressInfo).port } })
      const res = await adapter.probe(ctx)
      expect(res.error).toBeUndefined()
      expect(res.ok).toBe(true)
      expect(res.info?.serial).toBe('DS-2DE2A404IW-DE320200612AAWRE12345678')
      expect((await adapter.snapshot!(ctx)).body.equals(TINY_JPEG)).toBe(true)
      expect(served).toEqual(['GET /ISAPI/System/deviceInfo', 'GET /ISAPI/Streaming/channels/101/picture'])
    } finally {
      tls.closeAllConnections()
      await new Promise<void>((done) => tls.close(() => done()))
    }
  })

  it('falls back to the old paths without /ISAPI on old firmware, and remembers it', async () => {
    const s = await camera({
      'GET /System/deviceInfo': DEVICE_INFO.replace(HIK_NS, 'http://www.hikvision.com/ver10/XMLSchema'),
      'PUT /System/reboot': OK('/System/reboot'),
    })
    const ctx = ctxFor(s)
    const res = await adapter.probe(ctx)
    expect(res.ok).toBe(true)
    expect(res.info?.model).toBe('DS-2DE2A404IW-DE3')
    expect(calls(s)).toEqual(['GET /ISAPI/System/deviceInfo', 'GET /System/deviceInfo'])
    expect((await adapter.execute(ctx, makeAction('reboot'))).ok).toBe(true)
    expect(calls(s).slice(2)).toEqual(['PUT /System/reboot'])
  })

  it('does not take a web page that answers on every address for old firmware', async () => {
    server = await mockServer((req, res) => (req.path.startsWith('/ISAPI/') ? send(res, 404, '') : send(res, 200, '<html><body>router</body></html>', 'text/html')))
    const res = await adapter.probe(ctxFor(server))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not as a Hikvision camera/)
  })

  it('explains an HTTPS switch that does not match the camera', async () => {
    const s = await camera({ 'GET /ISAPI/System/deviceInfo': DEVICE_INFO })
    const res = await adapter.probe(ctxFor(s, { https: true }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not accept a secure \(HTTPS\) connection/)
  })
})

describe('hikvision adapter: state', () => {
  it('reads PTZ position, presets, WiFi and SIM', async () => {
    const s = await camera({
      'GET /ISAPI/PTZCtrl/channels/1/status': PTZ_STATUS,
      'GET /ISAPI/PTZCtrl/channels/1/presets': PRESETS,
      'GET /ISAPI/System/Network/interfaces': INTERFACES_WITH_WIFI,
      'GET /ISAPI/System/Network/interfaces/2/wireless': wireless('HouseWiFi'),
      'GET /ISAPI/System/Network/WirelessDial/Interfaces/1/dialstatus': dialstatus(68, '100.72.14.9'),
    })
    const state = await adapter.readState!(ctxFor(s, { ptz: true, cellular: true }))
    expect(state.ptz).toEqual({ pan: 0.5, tilt: 0.5, zoom: 2, azimuth: 90, elevation: 45 })
    expect(state.presets).toEqual([1, 2])
    expect(state.presetNames).toEqual({ '1': 'Gate', '2': 'Front door' })
    expect(state.wifi).toBe('HouseWiFi')
    expect(state.signal).toBe(68)
    expect(state.sim).toBe('SIM OK, LTE, private address (cannot be reached from outside)')
    expect(state).toMatchObject({ simNetwork: 'LTE', simAddress: '100.72.14.9', simAddressPublic: false })
    expect(calls(s).sort()).toEqual(
      [
        'GET /ISAPI/PTZCtrl/channels/1/presets',
        'GET /ISAPI/PTZCtrl/channels/1/status',
        'GET /ISAPI/System/Network/WirelessDial/Interfaces/1/dialstatus',
        'GET /ISAPI/System/Network/interfaces',
        'GET /ISAPI/System/Network/interfaces/2/wireless',
      ].sort(),
    )
  })

  it('reads a 4G camera with no WiFi: public SIM address, signal in dBm, missing SIM', async () => {
    let reply = dialstatus(-75, '49.36.12.200')
    const s = await camera({
      'GET /ISAPI/System/Network/interfaces': INTERFACES_CABLE_ONLY,
      'GET /ISAPI/System/Network/WirelessDial/Interfaces/1/dialstatus': () => reply,
    })
    const ctx = ctxFor(s, { cellular: true })
    const state = await adapter.readState!(ctx)
    expect('wifi' in state).toBe(false)
    expect(state.signal).toBe(61)
    expect(state.sim).toBe('SIM OK, LTE, public address')
    expect(state.simAddressPublic).toBe(true)

    reply = dialstatus(0, '0.0.0.0', 'NOEXIST').replace('<RealtimeMode>LTE<', '<RealtimeMode>UNKNOWN<')
    const next = await adapter.readState!(ctx)
    expect(next.sim).toBe('No SIM in the camera')
    expect(next.signal).toBe(0)
    // The interface list said "no WiFi" once; it is not asked again on every check.
    expect(calls(s).filter((c) => c === 'GET /ISAPI/System/Network/interfaces')).toHaveLength(1)
  })

  it('skips what the model does not have and stops asking for it', async () => {
    const s = await camera({
      'GET /ISAPI/System/Network/interfaces': INTERFACES_WITH_WIFI,
      'GET /ISAPI/System/Network/interfaces/2/wireless': wireless('HouseWiFi'),
    })
    const ctx = ctxFor(s, { ptz: true })
    expect(await adapter.readState!(ctx)).toEqual({ wifi: 'HouseWiFi' })
    const before = calls(s).filter((c) => c.includes('PTZCtrl')).length
    expect(await adapter.readState!(ctx)).toEqual({ wifi: 'HouseWiFi' })
    expect(calls(s).filter((c) => c.includes('PTZCtrl')).length).toBe(before)
  })

  it('takes the camera’s own "not supported" answer as a missing feature, and asks again later', async () => {
    const ptzStatus = '/ISAPI/PTZCtrl/channels/1/status'
    const presets = '/ISAPI/PTZCtrl/channels/1/presets'
    const dial = '/ISAPI/System/Network/WirelessDial/Interfaces/1/dialstatus'
    let fitted = false
    const s = await camera({
      [`GET ${ptzStatus}`]: () => (fitted ? PTZ_STATUS : notSupported(ptzStatus)),
      [`GET ${presets}`]: () => (fitted ? PRESETS : notSupported(presets)),
      [`GET ${dial}`]: notSupported(dial),
      'GET /ISAPI/System/Network/interfaces': INTERFACES_WITH_WIFI,
      'GET /ISAPI/System/Network/interfaces/2/wireless': wireless('HouseWiFi'),
    })
    const ctx = ctxFor(s, { ptz: true, cellular: true })
    expect(await adapter.readState!(ctx)).toEqual({ wifi: 'HouseWiFi' })
    // A camera that was only still starting up has these services a little later.
    fitted = true
    expect(await adapter.readState!(ctx)).toEqual({ wifi: 'HouseWiFi' })
    expect(calls(s).filter((c) => c.includes('PTZCtrl'))).toHaveLength(2)
    later(11)
    const state = await adapter.readState!(ctx)
    expect(state.presets).toEqual([1, 2])
    expect(state.ptz).toMatchObject({ pan: 0.5, tilt: 0.5, zoom: 2 })
    expect(calls(s).filter((c) => c.includes('PTZCtrl'))).toHaveLength(4)
  })

  it('finds the WiFi interface even when the interface list leaves the WiFi details out', async () => {
    const s = await camera({
      'GET /ISAPI/System/Network/interfaces': INTERFACES_PLAIN,
      'GET /ISAPI/System/Network/interfaces/2/wireless': wireless('HouseWiFi'),
      'GET /ISAPI/System/Network/interfaces/2/wireless/accessPointList': ACCESS_POINTS,
    })
    const ctx = ctxFor(s)
    expect(await adapter.readState!(ctx)).toEqual({ wifi: 'HouseWiFi' })
    expect((await adapter.scanWifi!(ctx)).map((n) => n.ssid)).toContain('HouseWiFi2')
    expect(calls(s).filter((c) => c === 'GET /ISAPI/System/Network/interfaces')).toHaveLength(1)
  })

  it('looks again for WiFi after a while instead of writing the camera off for good', async () => {
    let list = INTERFACES_CABLE_ONLY
    const s = await camera({
      'GET /ISAPI/System/Network/interfaces': () => list,
      'GET /ISAPI/System/Network/interfaces/2/wireless': wireless('HouseWiFi'),
    })
    const ctx = ctxFor(s)
    expect(await adapter.readState!(ctx)).toEqual({})
    list = INTERFACES_WITH_WIFI
    expect(await adapter.readState!(ctx)).toEqual({})
    later(11)
    expect(await adapter.readState!(ctx)).toEqual({ wifi: 'HouseWiFi' })
  })

  it('fails with a plain sentence when the camera answers with something that is not ISAPI', async () => {
    const page = '<html><body>Please log in</body></html>'
    const s = await camera({ 'GET /ISAPI/System/Network/interfaces': page, 'GET /ISAPI/System/Network/interfaces/2/wireless': page })
    await expect(adapter.readState!(ctxFor(s))).rejects.toThrow('The camera sent an answer this hub could not read.')
  })

  it('reads nothing when every switch is off, and throws when the camera is unreachable', async () => {
    const s = await camera({})
    expect(await adapter.readState!(ctxFor(s, { wifi: false }))).toEqual({})
    expect(s.requests).toHaveLength(0)
    const port = s.port
    await s.close()
    server = null
    await expect(adapter.readState!(makeCtx({ family: 'hikvision', config: { username: USER, password: PASS }, path: { port } }))).rejects.toThrow(/refused the connection/)
  })
})

describe('hikvision adapter: moving the camera', () => {
  const PTZ = { ptz: true }

  it('sends a continuous move as speeds from -100 to 100 on the video channel', async () => {
    const s = await camera({ 'PUT /ISAPI/PTZCtrl/channels/1/continuous': OK('/ISAPI/PTZCtrl/channels/1/continuous') })
    const ctx = ctxFor(s, PTZ)
    const res = await adapter.execute(ctx, makeAction('ptz.move', { pan: 0.6, tilt: 0, zoom: 0 }))
    expect(res).toEqual({ ok: true, result: { pan: 60, tilt: 0, zoom: 0, stopsAfterSeconds: 30 } })
    const put = acted(s)[0]!
    expect(put.method).toBe('PUT')
    expect(put.url).toBe('/ISAPI/PTZCtrl/channels/1/continuous')
    expect(put.body).toBe(CONTINUOUS(60, 0, 0))
    expect(put.headers['content-type']).toMatch(/^application\/xml/)
    expect(put.headers['content-length']).toBe(String(Buffer.byteLength(put.body)))
    expect(put.headers['transfer-encoding']).toBeUndefined()

    await adapter.execute(ctx, makeAction('ptz.move', { pan: -5, tilt: 0.254, zoom: 3 }))
    expect(acted(s)[1]!.body).toBe(CONTINUOUS(-100, 25, 100))
  })

  it('stops by sending zero speeds', async () => {
    const s = await camera({ 'PUT /ISAPI/PTZCtrl/channels/1/continuous': OK('/ISAPI/PTZCtrl/channels/1/continuous') })
    const ctx = ctxFor(s, PTZ)
    await adapter.execute(ctx, makeAction('ptz.move', { tilt: 1 }))
    expect(await adapter.execute(ctx, makeAction('ptz.stop'))).toEqual({ ok: true, result: { stopped: true } })
    expect(acted(s).map((r) => r.body)).toEqual([CONTINUOUS(0, 100, 0), CONTINUOUS(0, 0, 0)])
    // A move with nothing to move is a stop too.
    await adapter.execute(ctx, makeAction('ptz.move', { pan: 0, tilt: 0, zoom: 0 }))
    expect(acted(s)[2]!.body).toBe(CONTINUOUS(0, 0, 0))
  })

  it('stops by itself after the asked time', async () => {
    const s = await camera({ 'PUT /ISAPI/PTZCtrl/channels/1/continuous': OK('/ISAPI/PTZCtrl/channels/1/continuous') })
    const res = await adapter.execute(ctxFor(s, PTZ), makeAction('ptz.move', { pan: 1, seconds: 0.2 }))
    expect(res.result).toMatchObject({ stopsAfterSeconds: 0.2 })
    expect(acted(s)).toHaveLength(1)
    await sleep(700)
    expect(acted(s).map((r) => r.body)).toEqual([CONTINUOUS(100, 0, 0), CONTINUOUS(0, 0, 0)])
  })

  it('keeps a stop behind the move it belongs to', async () => {
    const s = await camera({ 'PUT /ISAPI/PTZCtrl/channels/1/continuous': OK('/ISAPI/PTZCtrl/channels/1/continuous') })
    const ctx = ctxFor(s, PTZ)
    await adapter.probe(ctx)
    const n = acted(s).length
    await Promise.all([adapter.execute(ctx, makeAction('ptz.move', { pan: 1 })), adapter.execute(ctx, makeAction('ptz.stop'))])
    expect(acted(s).slice(n).map((r) => r.body)).toEqual([CONTINUOUS(100, 0, 0), CONTINUOUS(0, 0, 0)])
  })

  it('keeps trying to stop a camera whose stop did not get through', async () => {
    const url = '/ISAPI/PTZCtrl/channels/1/continuous'
    let n = 0
    const s = await camera({ [`PUT ${url}`]: () => (++n === 2 ? HANG : OK(url)) })
    const ctx = ctxFor(s, PTZ, { timeoutMs: 300 })
    expect((await adapter.execute(ctx, makeAction('ptz.move', { pan: 1 }))).ok).toBe(true)
    // Thrown, so the hub can try another connection; the camera must not be left turning meanwhile.
    await expect(adapter.execute(ctx, makeAction('ptz.stop'))).rejects.toThrow('The camera did not answer within 1 second')
    await sleep(900)
    expect(acted(s).map((r) => r.body)).toEqual([CONTINUOUS(100, 0, 0), CONTINUOUS(0, 0, 0), CONTINUOUS(0, 0, 0)])
  })

  it('still stops a move whose answer never came back', async () => {
    const url = '/ISAPI/PTZCtrl/channels/1/continuous'
    let n = 0
    const s = await camera({ [`PUT ${url}`]: () => (++n === 1 ? HANG : OK(url)) })
    const ctx = ctxFor(s, PTZ, { timeoutMs: 300 })
    await expect(adapter.execute(ctx, makeAction('ptz.move', { tilt: -1, seconds: 0.2 }))).rejects.toThrow(/did not answer/)
    await sleep(600)
    expect(acted(s).map((r) => r.body)).toEqual([CONTINUOUS(0, -100, 0), CONTINUOUS(0, 0, 0)])
  })

  it('stops a held move when the preset that should have replaced it is refused', async () => {
    const move = '/ISAPI/PTZCtrl/channels/1/continuous'
    const goto = '/ISAPI/PTZCtrl/channels/1/presets/9/goto'
    const s = await camera({ [`PUT ${move}`]: OK(move), [`PUT ${goto}`]: notSupported(goto) })
    const ctx = ctxFor(s, PTZ)
    await adapter.execute(ctx, makeAction('ptz.move', { pan: 1 }))
    const res = await adapter.execute(ctx, makeAction('ptz.preset', { preset: 9 }))
    expect(res).toEqual({ ok: false, error: 'The camera has no preset 9, or it cannot move.' })
    await sleep(800)
    expect(acted(s).filter((r) => r.path === move).map((r) => r.body)).toEqual([CONTINUOUS(100, 0, 0), CONTINUOUS(0, 0, 0)])
  })

  it('uses the recorder channel for PTZ, never the stream id', async () => {
    const s = await camera({ 'PUT /ISAPI/PTZCtrl/channels/3/continuous': OK('/ISAPI/PTZCtrl/channels/3/continuous') })
    expect((await adapter.execute(ctxFor(s, { ptz: true, channel: 3 }), makeAction('ptz.stop'))).ok).toBe(true)
    expect(calls(s)).toEqual(['PUT /ISAPI/PTZCtrl/channels/3/continuous'])
  })

  it('reports what the camera refused', async () => {
    const url = '/ISAPI/PTZCtrl/channels/1/continuous'
    const s = await camera({ [`PUT ${url}`]: [400, status(url, 6, 'Invalid Content', 'badXmlContent')] })
    const res = await adapter.execute(ctxFor(s, PTZ), makeAction('ptz.move', { pan: 1 }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Invalid Content, badXmlContent/)

    // A fixed camera has no PTZ service at all.
    resetHikvisionSessions()
    const fixed = await adapter.execute(ctxFor(s, { ptz: true, channel: 2 }), makeAction('ptz.move', { pan: 1 }))
    expect(fixed.ok).toBe(false)
    expect(fixed.error).toMatch(/fixed camera/)
  })

  it('goes to a preset with no body, as the specification says', async () => {
    const url = '/ISAPI/PTZCtrl/channels/1/presets/2/goto'
    const s = await camera({ [`PUT ${url}`]: OK(url) })
    const res = await adapter.execute(ctxFor(s, PTZ), makeAction('ptz.preset', { preset: 2 }))
    expect(res).toEqual({ ok: true, result: { preset: 2 } })
    const put = acted(s)[0]!
    expect(`${put.method} ${put.url}`).toBe(`PUT ${url}`)
    expect(put.body).toBe('')
    expect(put.headers['content-length']).toBe('0')
  })

  it('repeats the preset call with an empty PTZData for firmware that wants one', async () => {
    const url = '/ISAPI/PTZCtrl/channels/1/presets/1/goto'
    const s = await camera({
      [`PUT ${url}`]: (req) => (req.body ? OK(url) : [400, status(url, 5, 'Invalid Format', 'badXmlFormat')]),
    })
    const res = await adapter.execute(ctxFor(s, PTZ), makeAction('ptz.preset', { preset: '1' }))
    expect(res.ok).toBe(true)
    expect(acted(s).map((r) => r.body)).toEqual(['', `${XML}<PTZData></PTZData>`])
    expect(acted(s)[1]!.headers['content-type']).toMatch(/^application\/xml/)
  })

  it('finds a preset by its name', async () => {
    const url = '/ISAPI/PTZCtrl/channels/1/presets/2/goto'
    const s = await camera({ 'GET /ISAPI/PTZCtrl/channels/1/presets': PRESETS, [`PUT ${url}`]: OK(url) })
    const ctx = ctxFor(s, PTZ)
    expect(await adapter.execute(ctx, makeAction('ptz.preset', { preset: 'front door' }))).toEqual({ ok: true, result: { preset: 2 } })
    expect(calls(s)).toEqual(['GET /ISAPI/PTZCtrl/channels/1/presets', `PUT ${url}`])
    const missing = await adapter.execute(ctx, makeAction('ptz.preset', { preset: 'Garage' }))
    expect(missing).toEqual({ ok: false, error: 'The camera has no preset called "Garage"' })
    expect((await adapter.execute(ctx, makeAction('ptz.preset', {}))).ok).toBe(false)
  })

  it('does not move a camera whose PTZ switch is off', async () => {
    const s = await camera({})
    for (const type of ['ptz.move', 'ptz.stop', 'ptz.preset'] as const) {
      const res = await adapter.execute(ctxFor(s), makeAction(type, { pan: 1, preset: 1 }))
      expect(res.ok).toBe(false)
    }
    expect(s.requests).toHaveLength(0)
  })
})

describe('hikvision adapter: restart and other commands', () => {
  it('restarts with a bodyless PUT', async () => {
    const s = await camera({ 'PUT /ISAPI/System/reboot': OK('/ISAPI/System/reboot') })
    const res = await adapter.execute(ctxFor(s), makeAction('reboot'))
    expect(res).toEqual({ ok: true, result: { backInSeconds: 60 } })
    const put = acted(s)[0]!
    expect(`${put.method} ${put.url}`).toBe('PUT /ISAPI/System/reboot')
    expect(put.body).toBe('')
  })

  it('passes on a refusal while the camera is updating', async () => {
    const s = await camera({ 'PUT /ISAPI/System/reboot': [503, status('/ISAPI/System/reboot', 2, 'Device Busy', 'upgrading')] })
    const res = await adapter.execute(ctxFor(s), makeAction('reboot'))
    expect(res).toEqual({ ok: false, error: 'The camera is updating its software. Try again in a few minutes.' })
  })

  it('throws when the camera cannot be reached, so the hub can try another connection', async () => {
    const s = await camera({})
    const port = s.port
    await s.close()
    server = null
    const ctx = makeCtx({ family: 'hikvision', config: { username: USER, password: PASS }, path: { port } })
    await expect(adapter.execute(ctx, makeAction('reboot'))).rejects.toThrow(/refused the connection/)
  })

  it('refuses commands a camera cannot do', async () => {
    const s = await camera({})
    for (const type of ['power.on', 'power.toggle', 'dim.set', 'gate.open', 'sms.send', 'custom'] as const) {
      const res = await adapter.execute(ctxFor(s, { ptz: true }), makeAction(type))
      expect(res.ok).toBe(false)
      expect(res.error).toContain(type)
    }
    expect(s.requests).toHaveLength(0)
  })
})

describe('hikvision adapter: pictures and live video', () => {
  it('takes a still from the main stream of the channel', async () => {
    const s = await camera({ 'GET /ISAPI/Streaming/channels/101/picture': TINY_JPEG, 'GET /ISAPI/Streaming/channels/201/picture': TINY_JPEG })
    const snap = await adapter.snapshot!(ctxFor(s))
    expect(snap.contentType).toBe('image/jpeg')
    expect(snap.body.equals(TINY_JPEG)).toBe(true)
    await adapter.snapshot!(ctxFor(s, { channel: 2 }))
    expect(calls(s)).toEqual(['GET /ISAPI/Streaming/channels/101/picture', 'GET /ISAPI/Streaming/channels/201/picture'])
  })

  it('fails clearly when there is no picture', async () => {
    const url = '/ISAPI/Streaming/channels/101/picture'
    const s = await camera({ [`GET ${url}`]: [503, status(url, 2, 'Device Busy', 'deviceBusy')] })
    await expect(adapter.snapshot!(ctxFor(s))).rejects.toThrow('The camera is busy. Try again in a moment.')
    await expect(adapter.snapshot!(ctxFor(s, { channel: 4 }))).rejects.toThrow('The camera gave no picture for camera number 4.')
    resetHikvisionSessions()
    await expect(adapter.snapshot!(ctxFor(s, { password: 'nope-nope' }))).rejects.toThrow(/^Wrong username or password/)
  })

  it('throws when the camera goes quiet or sends a web page instead of a picture', async () => {
    const quiet = await camera({ 'GET /ISAPI/Streaming/channels/101/picture': HANG })
    await expect(adapter.snapshot!(ctxFor(quiet, {}, { timeoutMs: 300 }))).rejects.toThrow('The camera did not answer within 1 second')
    await quiet.close()
    const page = await camera({ 'GET /ISAPI/Streaming/channels/101/picture': '<html><body>Please log in</body></html>' })
    await expect(adapter.snapshot!(ctxFor(page))).rejects.toThrow('The camera answered, but not with a picture')
  })

  it('gives go2rtc the main stream, then the sub stream, with the login encoded', () => {
    const ctx = makeCtx({ family: 'hikvision', config: { username: 'admin', password: 'p@ss/w:rd#1' }, path: { host: '192.168.1.64', port: 80 } })
    expect(adapter.streamSources!(ctx)).toEqual([
      'rtsp://admin:p%40ss%2Fw%3Ard%231@192.168.1.64:554/Streaming/Channels/101',
      'rtsp://admin:p%40ss%2Fw%3Ard%231@192.168.1.64:554/Streaming/Channels/102',
    ])
  })

  it('follows the channel, the video port and the address of the connection in use', () => {
    const nvr = makeCtx({ family: 'hikvision', config: { username: 'admin', password: 'x', channel: 13, rtspPort: 8554 }, path: { host: '10.0.0.5' } })
    expect(adapter.streamSources!(nvr)).toEqual(['rtsp://admin:x@10.0.0.5:8554/Streaming/Channels/1301', 'rtsp://admin:x@10.0.0.5:8554/Streaming/Channels/1302'])

    const sim = makeCtx({
      family: 'hikvision',
      config: { username: 'admin', password: 'x' },
      path: { kind: 'cellular', label: 'SIM', host: '49.36.12.200', port: 8080, extra: { rtspPort: 10554 } },
    })
    expect(adapter.streamSources!(sim)[0]).toBe('rtsp://admin:x@49.36.12.200:10554/Streaming/Channels/101')

    const v6 = makeCtx({ family: 'hikvision', config: { username: 'admin', password: 'x' }, path: { host: 'fe80::1' } })
    expect(adapter.streamSources!(v6)[1]).toBe('rtsp://admin:x@[fe80::1]:554/Streaming/Channels/102')

    const noHost = makeCtx({ family: 'hikvision', config: { username: 'admin', password: 'x' }, path: { host: null } })
    expect(() => adapter.streamSources!(noHost)).toThrow(/No address set/)
  })
})

describe('hikvision adapter: WiFi', () => {
  const WIFI_ROUTES: Routes = {
    'GET /ISAPI/System/Network/interfaces': INTERFACES_WITH_WIFI,
    'GET /ISAPI/System/Network/interfaces/2/wireless': wireless('HouseWiFi'),
    'GET /ISAPI/System/Network/interfaces/2/wireless/accessPointList': ACCESS_POINTS,
    'PUT /ISAPI/System/Network/interfaces/2/wireless': OK('/ISAPI/System/Network/interfaces/2/wireless'),
  }
  const puts = (s: MockServer) => acted(s).filter((r) => r.method === 'PUT')

  it('lists the networks the camera sees, strongest first', async () => {
    const s = await camera(WIFI_ROUTES)
    const found = await adapter.scanWifi!(ctxFor(s))
    expect(found).toEqual([
      { ssid: 'HouseWiFi2', signal: 78, security: 'WPA2' },
      { ssid: 'HouseWiFi', signal: 61, security: 'WPA2' },
      { ssid: 'Office', signal: 35, security: 'WPA2 Enterprise' },
      { ssid: 'Cafe', signal: 22, security: 'Open' },
    ])
    expect(calls(s)).toEqual(['GET /ISAPI/System/Network/interfaces', 'GET /ISAPI/System/Network/interfaces/2/wireless/accessPointList'])
  })

  it('says so when the camera has no WiFi to scan with', async () => {
    const s = await camera({ 'GET /ISAPI/System/Network/interfaces': INTERFACES_CABLE_ONLY })
    await expect(adapter.scanWifi!(ctxFor(s))).rejects.toThrow(/has no WiFi/)
    const res = await adapter.setWifi!(ctxFor(s), { ssid: 'HouseWiFi2', password: 'PASSPHRASE' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/has no WiFi/)
    expect(puts(s)).toHaveLength(0)
  })

  it('re-points the camera with the Wireless block from the specification', async () => {
    const s = await camera(WIFI_ROUTES)
    const res = await adapter.setWifi!(ctxFor(s), { ssid: 'HouseWiFi2', password: 'PASSPHRASE' })
    expect(res).toEqual({ ok: true, result: { ssid: 'HouseWiFi2' }, state: { wifi: 'HouseWiFi2' } })
    // Read the interface, read the current settings, check the network is in range, then change it.
    expect(calls(s)).toEqual([
      'GET /ISAPI/System/Network/interfaces',
      'GET /ISAPI/System/Network/interfaces/2/wireless',
      'GET /ISAPI/System/Network/interfaces/2/wireless/accessPointList',
      'PUT /ISAPI/System/Network/interfaces/2/wireless',
    ])
    const put = puts(s)[0]!
    expect(put.body).toBe(
      `${XML}<Wireless version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><enabled>true</enabled><wirelessNetworkMode>infrastructure</wirelessNetworkMode><channel>auto</channel><ssid>HouseWiFi2</ssid><wmmEnabled>true</wmmEnabled><WirelessSecurity><securityMode>WPA2-personal</securityMode><WPA><algorithmType>AES</algorithmType><sharedKey>PASSPHRASE</sharedKey><wpaKeyLength>10</wpaKeyLength></WPA></WirelessSecurity></Wireless>`,
    )
    expect(put.headers['content-type']).toMatch(/^application\/xml/)
    expect(put.headers['content-length']).toBe(String(Buffer.byteLength(put.body)))
    expect(put.query.toString()).toBe('')
    expect(JSON.stringify(res)).not.toContain('PASSPHRASE')
  })

  it('keeps the settings it does not change and escapes awkward characters', async () => {
    const current = wireless('HouseWiFi', '<hideSsid>false</hideSsid>')
      .replace('<wmmEnabled>true</wmmEnabled>', '<wmmEnabled>false</wmmEnabled>')
      .replace(
        '<WPA>',
        '<WEP><authenticationType>open</authenticationType><defaultTransmitKeyIndex>1</defaultTransmitKeyIndex><wepKeyLength>64</wepKeyLength><EncryptionKeyList><encryptionKey></encryptionKey></EncryptionKeyList></WEP><WPA>',
      )
    const s = await camera({
      ...WIFI_ROUTES,
      'GET /ISAPI/System/Network/interfaces/2/wireless': current,
      'GET /ISAPI/System/Network/interfaces/2/wireless/accessPointList': `${XML}<accessPointList version="2.0">${ap(1, 'Tom &amp; Jerry&apos;s &lt;5G&gt;', 70, 'WPA2-personal')}</accessPointList>`,
    })
    const res = await adapter.setWifi!(ctxFor(s), { ssid: "Tom & Jerry's <5G>", password: 'a<b>&"c\'d1' })
    expect(res.ok).toBe(true)
    expect(puts(s)[0]!.body).toBe(
      `${XML}<Wireless version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><enabled>true</enabled><wirelessNetworkMode>infrastructure</wirelessNetworkMode><channel>auto</channel><ssid>Tom &amp; Jerry&apos;s &lt;5G&gt;</ssid><wmmEnabled>false</wmmEnabled>` +
        `<WirelessSecurity><securityMode>WPA2-personal</securityMode><WEP><authenticationType>open</authenticationType><defaultTransmitKeyIndex>1</defaultTransmitKeyIndex><wepKeyLength>64</wepKeyLength><EncryptionKeyList><encryptionKey></encryptionKey></EncryptionKeyList></WEP>` +
        `<WPA><algorithmType>AES</algorithmType><sharedKey>a&lt;b&gt;&amp;&quot;c&apos;d1</sharedKey><wpaKeyLength>10</wpaKeyLength></WPA></WirelessSecurity><hideSsid>false</hideSsid></Wireless>`,
    )
  })

  it('leaves the camera alone when it cannot see the network', async () => {
    const s = await camera(WIFI_ROUTES)
    const res = await adapter.setWifi!(ctxFor(s), { ssid: 'Farmhouse', password: 'PASSPHRASE' })
    expect(res).toEqual({ ok: false, error: 'The camera cannot see "Farmhouse" from where it is, so it was left on its current network.' })
    expect(puts(s)).toHaveLength(0)
  })

  it('refuses passwords and security types it cannot set, before touching the WiFi settings', async () => {
    const s = await camera(WIFI_ROUTES)
    const ctx = ctxFor(s)
    expect((await adapter.setWifi!(ctx, { ssid: 'HouseWiFi2', password: 'short' })).error).toMatch(/8 to 63 characters/)
    expect((await adapter.setWifi!(ctx, { ssid: 'HouseWiFi2', password: '' })).error).toMatch(/No password stored/)
    expect((await adapter.setWifi!(ctx, { ssid: 'Office', password: 'PASSPHRASE' })).error).toMatch(/WPA2 Enterprise security/)
    expect((await adapter.setWifi!(ctx, { ssid: '', password: 'PASSPHRASE' })).ok).toBe(false)
    expect((await adapter.setWifi!(ctxFor(s, { wifi: false }), { ssid: 'HouseWiFi2', password: 'PASSPHRASE' })).ok).toBe(false)
    expect(puts(s)).toHaveLength(0)
  })

  it('uses the list from a scan the owner just ran instead of scanning again', async () => {
    const s = await camera(WIFI_ROUTES)
    const ctx = ctxFor(s)
    await adapter.scanWifi!(ctx)
    expect((await adapter.setWifi!(ctx, { ssid: 'HouseWiFi2', password: 'PASSPHRASE' })).ok).toBe(true)
    expect(calls(s).filter((c) => c.endsWith('/accessPointList'))).toHaveLength(1)
  })

  it('still moves a camera whose firmware cannot list networks', async () => {
    const { ['GET /ISAPI/System/Network/interfaces/2/wireless/accessPointList']: _none, ...routes } = WIFI_ROUTES
    const s = await camera(routes)
    const res = await adapter.setWifi!(ctxFor(s), { ssid: 'HouseWiFi2', password: 'PASSPHRASE' })
    expect(res.ok).toBe(true)
    expect(puts(s)[0]!.body).toContain('<ssid>HouseWiFi2</ssid>')
  })

  it('passes on the camera’s refusal', async () => {
    const url = '/ISAPI/System/Network/interfaces/2/wireless'
    const s = await camera({ ...WIFI_ROUTES, [`PUT ${url}`]: [400, status(url, 6, 'Invalid Content', 'badXmlContent')] })
    const res = await adapter.setWifi!(ctxFor(s), { ssid: 'HouseWiFi2', password: 'PASSPHRASE' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Invalid Content, badXmlContent/)
    expect(res.error).not.toContain('PASSPHRASE')
  })

  it('treats silence after the change as the camera having left for the new network', async () => {
    let left = false
    const s = await camera(
      {
        ...WIFI_ROUTES,
        'PUT /ISAPI/System/Network/interfaces/2/wireless': () => {
          left = true
          return HANG
        },
      },
      { gone: () => left },
    )
    const res = await adapter.setWifi!(ctxFor(s, {}, { timeoutMs: 400 }), { ssid: 'HouseWiFi2', password: 'PASSPHRASE' })
    expect(res.ok).toBe(true)
    expect(res.needsConfirmation).toBeUndefined()
    expect(res.state).toEqual({ wifi: 'HouseWiFi2' })
    expect(String(res.result?.note)).toMatch(/stopped answering right after it was told to move/)
  })

  it('does not claim a move when the camera is still there on its old network', async () => {
    const s = await camera({ ...WIFI_ROUTES, 'PUT /ISAPI/System/Network/interfaces/2/wireless': HANG })
    const started = Date.now()
    const res = await adapter.setWifi!(ctxFor(s, {}, { timeoutMs: 400 }), { ssid: 'HouseWiFi2', password: 'PASSPHRASE' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/still set to its old network/)
    // The hub waits twice the device timeout for this command; the adapter must be done before that.
    expect(Date.now() - started).toBeLessThan(800)
  })

  it('throws when the camera is unreachable before anything was changed', async () => {
    const s = await camera(WIFI_ROUTES)
    const port = s.port
    await s.close()
    server = null
    const ctx = makeCtx({ family: 'hikvision', config: { username: USER, password: PASS }, path: { port } })
    await expect(adapter.setWifi!(ctx, { ssid: 'HouseWiFi2', password: 'PASSPHRASE' })).rejects.toThrow(/refused the connection/)
  })
})
