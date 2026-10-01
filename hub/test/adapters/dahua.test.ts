/**
 * Dahua / CP Plus adapter against a mock camera. Every body the mock sends is a
 * sample from docs/protocols/dahua-cpplus-cgi.md (Dahua HTTP API v1.40, Amcrest
 * v2.12 and HTTP API V3.35), with the CRLF line ends real cameras use, behind
 * the digest challenge those documents show.
 */
import type http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import adapter, { MAX_MOVE_SECONDS, cameraBaseUrl, parseIndexed, parseKeyValues, parseWifiScan, resetDahuaRuntimes } from '../../src/adapters/dahua.ts'
import { sleep } from '../../src/lib/http.ts'
import { setLogLevel } from '../../src/lib/log.ts'
import { basicGuard, digestGuard, makeAction, makeCtx, mockServer, send, TINY_JPEG, type MockHandler, type MockServer, type RecordedRequest } from '../helpers.ts'

let server: MockServer | null = null
afterEach(async () => {
  resetDahuaRuntimes()
  vi.restoreAllMocks()
  setLogLevel('info')
  await server?.close()
  server = null
})

// ---------------------------------------------------------------- sample payloads

const lines = (...rows: string[]) => rows.join('\r\n') + '\r\n'

/** V3.35 section 3.4: Digest realm="Device_00408CA5EA04", nonce, qop="auth", opaque. */
const REALM = 'Device_00408CA5EA04'

const SYSTEM_INFO = lines('serialNumber=YZC0GZ05100020', 'deviceType=IPC-HF3300', 'hardwareVersion=1.00')
const DEVICE_TYPE = lines('type=IPC-HF3300')
const SOFTWARE_VERSION = lines('version=2.212.0000.0.R,build:2013-11-14')

const NETWORK = lines(
  'table.Network.DefaultInterface=eth0',
  'table.Network.Domain=dahua',
  'table.Network.Hostname=badak',
  'table.Network.eth0.DefaultGateway=10.7.0.1',
  'table.Network.eth0.DhcpEnable=false',
  'table.Network.eth0.IPAddress=10.7.2.3',
  'table.Network.eth0.MTU=1500',
  'table.Network.eth0.PhysicalAddress=00:10:5c:f2:1c:b4',
  'table.Network.eth0.SubnetMask=255.255.0.0',
)

const WLAN = lines(
  'table.WLan.eth2.Enable=true',
  'table.WLan.eth2.Encryption=off',
  'table.WLan.eth2.KeyFlag=false',
  'table.WLan.eth2.KeyID=0',
  'table.WLan.eth2.KeyType=Hex',
  'table.WLan.eth2.Keys[0]=password1',
  'table.WLan.eth2.Keys[1]=password2',
  'table.WLan.eth2.Keys[2]=password3',
  'table.WLan.eth2.Keys[3]=password4',
  'table.WLan.eth2.LinkMode=Auto',
  'table.WLan.eth2.SSID=dahua',
)

/** Newer firmware (V3.35 4.8.7): interface wlan0, extra keys BSSID and ConnectEnable, newer security name. */
const WLAN_NEW = lines(
  'table.WLan.wlan0.BSSID=28:2c:b2:5c:de:36',
  'table.WLan.wlan0.ConnectEnable=false',
  'table.WLan.wlan0.Enable=true',
  'table.WLan.wlan0.Encryption=WPA2-PSK-AES',
  'table.WLan.wlan0.KeyFlag=false',
  'table.WLan.wlan0.KeyID=0',
  'table.WLan.wlan0.KeyType=ASCII',
  'table.WLan.wlan0.Keys[0]=password1',
  'table.WLan.wlan0.LinkMode=Auto',
  'table.WLan.wlan0.SSID=dahua',
)

const SCAN_ROWS = [
  'wlanDevice[0].ApConnected=0',
  'wlanDevice[0].ApMaxBitRate=54000000',
  'wlanDevice[0].ApNetWorkType=255',
  'wlanDevice[0].AuthMode=7',
  'wlanDevice[0].BSSID=28:2c:b2:5c:de:36',
  'wlanDevice[0].EncrAlgr=3',
  'wlanDevice[0].LinkMode=0',
  'wlanDevice[0].LinkQuality=31',
  'wlanDevice[0].RSSIQuality=0',
  'wlanDevice[0].SSID=xia_yuguo 13098 Internet',
]
/** v1.40 5.6.3 header. */
const SCAN_OLD = lines('Found Num:1', ...SCAN_ROWS)
/** V3.35 4.8.8 header. */
const SCAN_NEW = lines('found=1', ...SCAN_ROWS)
/** What a camera with a dead WiFi module answered (ipcamtalk). */
const SCAN_NONE = lines('found=0')
const SCAN_SSID = 'xia_yuguo 13098 Internet'

/** v1.40 5.1.1: eth0 wired, eth2 wireless, 3G cellular. */
const INTERFACES_OLD = lines(
  'netInterface[0].Name=eth0',
  'netInterface[0].Type=Normal',
  'netInterface[0].Valid=true',
  'netInterface[1].Name=eth2',
  'netInterface[1].Type=Wireless',
  'netInterface[1].Valid=true',
  'netInterface[2].Name=3G',
  'netInterface[2].Type=WCDMA',
  'netInterface[2].Valid=true',
)
/** V3.35 4.8.1: lower-case 3g, a list of types, and the link state. */
const INTERFACES_NEW = lines(
  'netInterface[0].Name=eth0',
  'netInterface[0].Type=Normal',
  'netInterface[0].Valid=true',
  'netInterface[0].NetCardName=eth0',
  'netInterface[0].ConnStatus=Connected',
  'netInterface[1].Name=3g',
  'netInterface[1].Type=Auto,WCDMA,TD-SCDMA,TD-LTE,FDD-LTE',
  'netInterface[1].Valid=true',
  'netInterface[1].NetCardName=lte0',
  'netInterface[1].ConnStatus=Connected',
)
const INTERFACES_WIRED_ONLY = lines('netInterface[0].Name=eth0', 'netInterface[0].Type=Normal', 'netInterface[0].Valid=true')

const PTZ_STATUS = lines('status.UTC=6538920', 'status.MoveStatus=Idle', 'status.ZoomStatus=Idle', 'status.PresetID=10', 'status.Position=120,12,2')
const PRESETS = lines('presets.presets[0].Index=1', 'presets.presets[0].Name=preset1', 'presets.presets[1].Index=2', 'presets.presets[1].Name=preset2')

// ---------------------------------------------------------------- the mock camera

interface CameraOptions {
  password?: string
  /** V3.35: a wrong digest is answered 403, not 401. */
  forbidWrongDigest?: boolean
  /** Older firmware also accepts HTTP Basic (v1.40 section 3.2). */
  basicAuth?: boolean
  /**
   * How the camera says no. The documents give the body ("OK or ERROR"); firmware in the field sends
   * the refusal either as a 200 with that body or as HTTP 400 Bad Request. Default: 200.
   */
  errorStatus?: 200 | 400
  systemInfo?: string
  /** Answer to ptz.cgi start / stop. 'drop' = the camera acts on it but the answer never arrives. */
  ptz?: (req: RecordedRequest) => string
  presets?: string
  wlan?: string
  /** 'hang' = the camera never answers the scan. */
  scan?: string
  interfaces?: string
  /** Answer to configManager setConfig; 'drop' cuts the connection without answering, 'hang' never answers. */
  setConfig?: 'OK' | 'ERROR' | 'drop' | 'hang'
  reboot?: string
  snapshot?: 'jpeg' | 'error' | 'unlabelled' | 'html'
}

function newerFirmwareGuard(username: string, password: string) {
  const inner = digestGuard(username, password, REALM)
  const silent = { writeHead: () => silent, end: () => silent } as unknown as http.ServerResponse
  return (req: RecordedRequest, res: http.ServerResponse): boolean => {
    if (!req.headers.authorization) return inner(req, res)
    if (inner(req, silent)) return true
    res.writeHead(403)
    res.end()
    return false
  }
}

function camera(o: CameraOptions = {}): MockHandler {
  const password = o.password ?? 'secret'
  const guard = o.basicAuth
    ? basicGuard('admin', password, REALM)
    : o.forbidWrongDigest
      ? newerFirmwareGuard('admin', password)
      : digestGuard('admin', password, REALM)
  return (req, res, raw) => {
    if (!guard(req, res)) return
    /** "OK" goes out as it is; "ERROR" goes out the way this camera says no. */
    const answer = (body: string) => {
      if (body === 'ERROR' && o.errorStatus === 400) return send(res, 400, 'Error\r\nBad Request!\r\n')
      return send(res, 200, body)
    }
    const action = req.query.get('action')
    switch (req.path) {
      case '/cgi-bin/magicBox.cgi':
        if (action === 'getSystemInfo') return send(res, 200, o.systemInfo ?? SYSTEM_INFO)
        if (action === 'getDeviceType') return send(res, 200, DEVICE_TYPE)
        if (action === 'getSoftwareVersion') return send(res, 200, SOFTWARE_VERSION)
        if (action === 'reboot') return answer(o.reboot ?? 'OK')
        break
      case '/cgi-bin/snapshot.cgi':
        if (o.snapshot === 'error') return answer('ERROR')
        if (o.snapshot === 'html') return send(res, 200, '<html><body>Login</body></html>', 'text/html')
        if (o.snapshot === 'unlabelled') {
          res.writeHead(200)
          res.end(TINY_JPEG)
          return
        }
        return send(res, 200, TINY_JPEG, 'image/jpeg')
      case '/cgi-bin/ptz.cgi':
        if (action === 'start' || action === 'stop') {
          const body = o.ptz ? o.ptz(req) : 'OK'
          if (body === 'drop') {
            raw.socket.destroy()
            return
          }
          return answer(body)
        }
        if (action === 'getPresets') return answer(o.presets ?? PRESETS)
        if (action === 'getStatus') return send(res, 200, PTZ_STATUS)
        break
      case '/cgi-bin/netApp.cgi':
        if (action === 'getInterfaces') return send(res, 200, o.interfaces ?? INTERFACES_OLD)
        break
      case '/cgi-bin/wlan.cgi':
        if (action === 'scanWlanDevices') {
          if (o.scan === 'hang') return
          return answer(o.scan ?? SCAN_OLD)
        }
        break
      case '/cgi-bin/configManager.cgi':
        if (action === 'getConfig' && req.query.get('name') === 'Network') return send(res, 200, NETWORK)
        if (action === 'getConfig' && req.query.get('name') === 'WLan') return answer(o.wlan ?? WLAN)
        if (action === 'setConfig') {
          if (o.setConfig === 'drop') {
            raw.socket.destroy()
            return
          }
          if (o.setConfig === 'hang') return
          return answer(o.setConfig ?? 'OK')
        }
        break
    }
    answer('ERROR')
  }
}

/** The calls that got past the login, as the camera saw them on the wire. */
function calls(s: MockServer): string[] {
  return s.requests.filter((r) => r.headers.authorization).map((r) => r.url)
}

function ctxFor(s: MockServer, config: Record<string, unknown> = {}, extra: { timeoutMs?: number } = {}) {
  return makeCtx({ family: 'dahua', config: { username: 'admin', password: 'secret', ...config }, path: { port: s.port }, ...extra })
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time')
    await sleep(20)
  }
}

async function closedPort(): Promise<number> {
  const s = await mockServer((_req, res) => send(res, 200, 'ok'))
  const port = s.port
  await s.close()
  return port
}

// ---------------------------------------------------------------- tests

describe('dahua adapter: the add-device form', () => {
  it('describes itself in plain words', () => {
    const d = adapter.describe()
    expect(adapter.family).toBe('dahua')
    expect(d.id).toBe('dahua')
    expect(d.label).toBe('Dahua / CP Plus camera')
    expect(d.kinds).toEqual(['camera'])
    expect(d.pathKinds).toEqual(['lan', 'cellular'])
    expect(d.defaultPort).toBe(80)
    const byName = Object.fromEntries(d.fields.map((f) => [f.name, f]))
    expect(Object.keys(byName)).toEqual(expect.arrayContaining(['username', 'password', 'channel', 'https', 'rtspPort', 'ptz', 'wifi', 'cellular']))
    expect(byName.password?.secret).toBe(true)
    expect(byName.username?.secret).toBeFalsy()
    expect(byName.channel?.default).toBe(1)
    expect(byName.rtspPort?.default).toBe(554)
    expect(byName.https?.type).toBe('toggle')
    for (const toggle of ['ptz', 'wifi', 'cellular']) {
      expect(byName[toggle]?.type).toBe('toggle')
      expect(byName[toggle]?.default).toBe(false)
      expect(byName[toggle]?.help).toBeTruthy()
    }
    expect(d.notes.length).toBeGreaterThan(0)
    expect(JSON.stringify(d)).not.toMatch(/\b(demo|prototype|placeholder|stub|todo)\b/i)
  })

  it('offers only what the switches say the camera has', () => {
    expect(adapter.capabilities({}, 'camera').sort()).toEqual(['reboot', 'snapshot', 'state', 'stream'])
    expect(adapter.capabilities({ ptz: true }, 'camera')).toEqual(expect.arrayContaining(['ptz', 'presets']))
    expect(adapter.capabilities({ wifi: 'true' }, 'camera')).toEqual(expect.arrayContaining(['wifi', 'wifi-scan']))
    expect(adapter.capabilities({ cellular: true }, 'camera')).toContain('cellular')
    const all = adapter.capabilities({ ptz: true, wifi: true, cellular: true }, 'camera')
    for (const cap of all) expect(adapter.describe().capabilities).toContain(cap)
    expect(adapter.capabilities({ ptz: false, wifi: false, cellular: false }, 'camera')).not.toContain('ptz')
  })
})

describe('dahua adapter: reading the text formats', () => {
  it('parses key=value lines, dropping the table. prefix and keeping values intact', () => {
    const kv = parseKeyValues(WLAN)
    expect(kv['WLan.eth2.SSID']).toBe('dahua')
    expect(kv['WLan.eth2.Keys[0]']).toBe('password1')
    expect(kv['WLan.eth2.Enable']).toBe('true')
    expect(parseKeyValues('serialNumber=YZC0GZ05100020\ndeviceType=IPC-HF3300\nhardwareVersion=1.00')).toEqual({
      serialNumber: 'YZC0GZ05100020',
      deviceType: 'IPC-HF3300',
      hardwareVersion: '1.00',
    })
    expect(parseKeyValues(SOFTWARE_VERSION)).toEqual({ version: '2.212.0000.0.R,build:2013-11-14' })
    expect(parseKeyValues(SCAN_OLD)['wlanDevice[0].SSID']).toBe(SCAN_SSID)
    expect(parseKeyValues('OK\r\n')).toEqual({})
  })

  it('groups indexed rows', () => {
    expect(parseIndexed(parseKeyValues(PRESETS), 'presets.presets')).toEqual([
      { Index: '1', Name: 'preset1' },
      { Index: '2', Name: 'preset2' },
    ])
    const interfaces = parseIndexed(parseKeyValues(INTERFACES_OLD), 'netInterface')
    expect(interfaces.map((i) => i.Name)).toEqual(['eth0', 'eth2', '3G'])
  })

  it('reads a WiFi scan with either header', () => {
    const expected = [{ ssid: SCAN_SSID, signal: 31, security: 'WPA/WPA2 (AES)' }]
    expect(parseWifiScan(SCAN_OLD)).toEqual(expected)
    expect(parseWifiScan(SCAN_NEW)).toEqual(expected)
    expect(parseWifiScan(SCAN_NONE)).toEqual([])
  })
})

describe('dahua adapter: checking the connection', () => {
  it('logs in with digest and reports model, firmware and serial', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server)
    const res = await adapter.probe(ctx)
    expect(res.ok).toBe(true)
    expect(typeof res.latencyMs).toBe('number')
    expect(res.info).toEqual({ serial: 'YZC0GZ05100020', model: 'IPC-HF3300', firmware: '2.212.0000.0.R (2013-11-14)' })

    // First the bare request, then the same one answering the camera's challenge.
    const [bare, authed] = server.requests
    expect(bare?.method).toBe('GET')
    expect(bare?.url).toBe('/cgi-bin/magicBox.cgi?action=getSystemInfo')
    expect(bare?.headers.authorization).toBeUndefined()
    expect(authed?.url).toBe('/cgi-bin/magicBox.cgi?action=getSystemInfo')
    expect(authed?.headers.authorization).toMatch(/^Digest username="admin", realm="Device_00408CA5EA04"/)
    expect(authed?.headers.authorization).toMatch(/qop=auth/)
    expect(authed?.headers.authorization).toMatch(/opaque="[0-9a-f]+"/)
    expect(calls(server).sort()).toEqual([
      '/cgi-bin/magicBox.cgi?action=getDeviceType',
      '/cgi-bin/magicBox.cgi?action=getSoftwareVersion',
      '/cgi-bin/magicBox.cgi?action=getSystemInfo',
    ])
  })

  it('keeps the regular check to one call once it knows the camera', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server)
    await adapter.probe(ctx)
    const before = calls(server).length
    const again = await adapter.probe(ctx)
    expect(again.info).toEqual({ serial: 'YZC0GZ05100020', model: 'IPC-HF3300', firmware: '2.212.0000.0.R (2013-11-14)' })
    expect(calls(server).slice(before)).toEqual(['/cgi-bin/magicBox.cgi?action=getSystemInfo'])
  })

  it('says so when the password is wrong', async () => {
    server = await mockServer(camera())
    const res = await adapter.probe(ctxFor(server, { password: 'not-the-password' }))
    expect(res).toEqual({ ok: false, latencyMs: null, error: 'Wrong username or password' })
  })

  it('understands newer firmware, which answers a wrong login with 403', async () => {
    server = await mockServer(camera({ forbidWrongDigest: true }))
    const wrong = await adapter.probe(ctxFor(server, { password: 'not-the-password' }))
    expect(wrong.ok).toBe(false)
    expect(wrong.error).toMatch(/wrong username or password/i)
    expect(wrong.error).not.toContain('not-the-password')
    const right = await adapter.probe(ctxFor(server))
    expect(right.ok).toBe(true)
  })

  it('reports an unreachable camera in a plain sentence', async () => {
    const port = await closedPort()
    const refused = await adapter.probe(makeCtx({ family: 'dahua', config: { username: 'admin', password: 'secret' }, path: { port } }))
    expect(refused.ok).toBe(false)
    expect(refused.latencyMs).toBeNull()
    expect(refused.error).toMatch(/refused the connection/)

    server = await mockServer(() => {
      /* never answers */
    })
    const started = Date.now()
    const silent = await adapter.probe(ctxFor(server, {}, { timeoutMs: 300 }))
    expect(silent.ok).toBe(false)
    expect(silent.error).toBe('The camera at 127.0.0.1 did not answer in time')
    expect(Date.now() - started).toBeLessThan(1500)

    const nowhere = await adapter.probe(makeCtx({ family: 'dahua', config: { username: 'admin', password: 'secret' }, path: { host: null } }))
    expect(nowhere.ok).toBe(false)
    expect(nowhere.error).toMatch(/No address set/)
  })

  it('tells a camera with CGI switched off, or a different make, from a Dahua one', async () => {
    server = await mockServer((_req, res) => send(res, 404, 'Not Found'))
    const off = await adapter.probe(ctxFor(server))
    expect(off.ok).toBe(false)
    expect(off.error).toMatch(/CGI service/)
    await server.close()

    // Newer firmware with MD5 digest disabled answers 500 to every API call.
    server = await mockServer((_req, res) => send(res, 500, ''))
    const strict = await adapter.probe(ctxFor(server))
    expect(strict.ok).toBe(false)
    expect(strict.error).toMatch(/Authentication Mode/)
    await server.close()

    server = await mockServer((_req, res) => send(res, 200, '<html><body>Welcome</body></html>', 'text/html'))
    const other = await adapter.probe(ctxFor(server))
    expect(other.ok).toBe(false)
    expect(other.error).toMatch(/not the way a Dahua or CP Plus camera does/)
  })
})

describe('dahua adapter: live video and pictures', () => {
  it('gives go2rtc the main stream, then the sub stream, with the login escaped', () => {
    const ctx = makeCtx({ family: 'dahua', config: { username: 'admin', password: 'p@ss/w:rd' }, path: { host: '192.168.1.108' } })
    expect(adapter.streamSources!(ctx)).toEqual([
      'rtsp://admin:p%40ss%2Fw%3Ard@192.168.1.108:554/cam/realmonitor?channel=1&subtype=0',
      'rtsp://admin:p%40ss%2Fw%3Ard@192.168.1.108:554/cam/realmonitor?channel=1&subtype=1',
    ])
  })

  it('uses the camera number, the video port and the address of the path in use', () => {
    const ctx = makeCtx({
      family: 'dahua',
      config: { username: 'admin', password: 'secret', channel: 3, rtspPort: 8554 },
      path: { kind: 'cellular', label: 'SIM', host: '203.0.113.7', port: 8080 },
    })
    expect(adapter.streamSources!(ctx)).toEqual([
      'rtsp://admin:secret@203.0.113.7:8554/cam/realmonitor?channel=3&subtype=0',
      'rtsp://admin:secret@203.0.113.7:8554/cam/realmonitor?channel=3&subtype=1',
    ])
    const v6 = makeCtx({ family: 'dahua', config: { username: 'admin', password: 'secret' }, path: { host: 'fd00::12' } })
    expect(adapter.streamSources!(v6)[0]).toBe('rtsp://admin:secret@[fd00::12]:554/cam/realmonitor?channel=1&subtype=0')
    const noHost = makeCtx({ family: 'dahua', config: { username: 'admin', password: 'secret' }, path: { host: '' } })
    expect(() => adapter.streamSources!(noHost)).toThrow(/No address set/)
  })

  it('fetches a still from snapshot.cgi', async () => {
    server = await mockServer(camera())
    const snap = await adapter.snapshot!(ctxFor(server))
    expect(snap.contentType).toBe('image/jpeg')
    expect(snap.body.equals(TINY_JPEG)).toBe(true)
    expect(calls(server)).toEqual(['/cgi-bin/snapshot.cgi?channel=1'])

    await adapter.snapshot!(ctxFor(server, { channel: 4 }))
    expect(calls(server).at(-1)).toBe('/cgi-bin/snapshot.cgi?channel=4')
  })

  it('fails clearly when there is no picture or the login is wrong', async () => {
    server = await mockServer(camera({ snapshot: 'error' }))
    await expect(adapter.snapshot!(ctxFor(server))).rejects.toThrow(/did not return a picture/)
    await expect(adapter.snapshot!(ctxFor(server, { password: 'nope' }))).rejects.toThrow('Wrong username or password')
  })
})

describe('dahua adapter: turning and zooming', () => {
  const ptz = { ptz: true }

  it('sends the documented direction codes with speed 1-8', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server, ptz)
    const cases: Array<[Record<string, number>, string]> = [
      [{ pan: -1, tilt: 0, zoom: 0 }, 'code=Left&arg1=0&arg2=8&arg3=0'],
      [{ pan: 0.5 }, 'code=Right&arg1=0&arg2=4&arg3=0'],
      [{ tilt: 1 }, 'code=Up&arg1=0&arg2=8&arg3=0'],
      [{ tilt: -0.25 }, 'code=Down&arg1=0&arg2=2&arg3=0'],
      [{ pan: 0.06 }, 'code=Right&arg1=0&arg2=1&arg3=0'],
      [{ pan: 5 }, 'code=Right&arg1=0&arg2=8&arg3=0'],
    ]
    for (const [params, wire] of cases) {
      resetDahuaRuntimes()
      const res = await adapter.execute(ctx, makeAction('ptz.move', params))
      expect(res.ok).toBe(true)
      const sent = server.requests.at(-1)!
      expect(sent.method).toBe('GET')
      expect(sent.url).toBe(`/cgi-bin/ptz.cgi?action=start&channel=1&${wire}`)
    }
  })

  it('uses the diagonal codes with vertical speed first, then horizontal', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server, ptz)
    const cases: Array<[Record<string, number>, string]> = [
      [{ pan: 1, tilt: 0.5 }, 'code=RightUp&arg1=4&arg2=8&arg3=0'],
      [{ pan: -0.5, tilt: -1 }, 'code=LeftDown&arg1=8&arg2=4&arg3=0'],
      [{ pan: -1, tilt: 1 }, 'code=LeftUp&arg1=8&arg2=8&arg3=0'],
      [{ pan: 1, tilt: -1 }, 'code=RightDown&arg1=8&arg2=8&arg3=0'],
    ]
    for (const [params, wire] of cases) {
      resetDahuaRuntimes()
      await adapter.execute(ctx, makeAction('ptz.move', params))
      expect(calls(server).at(-1)).toBe(`/cgi-bin/ptz.cgi?action=start&channel=1&${wire}`)
    }
  })

  it('zooms with ZoomTele / ZoomWide, alone or together with a direction', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server, ptz)
    await adapter.execute(ctx, makeAction('ptz.move', { pan: 0, tilt: 0, zoom: 1 }))
    expect(calls(server)).toEqual(['/cgi-bin/ptz.cgi?action=start&channel=1&code=ZoomTele&arg1=0&arg2=1&arg3=0'])

    resetDahuaRuntimes()
    await adapter.execute(ctx, makeAction('ptz.move', { zoom: -1 }))
    expect(calls(server).at(-1)).toBe('/cgi-bin/ptz.cgi?action=start&channel=1&code=ZoomWide&arg1=0&arg2=1&arg3=0')

    resetDahuaRuntimes()
    const before = calls(server).length
    await adapter.execute(ctx, makeAction('ptz.move', { pan: 1, zoom: 1 }))
    expect(calls(server).slice(before)).toEqual([
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=Right&arg1=0&arg2=8&arg3=0',
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=ZoomTele&arg1=0&arg2=1&arg3=0',
    ])
  })

  it('stops with the same code and arguments it started with', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server, ptz)
    const moved = await adapter.execute(ctx, makeAction('ptz.move', { pan: -0.5, tilt: 1 }))
    expect(moved.result).toEqual({ stopsAfterSeconds: MAX_MOVE_SECONDS })
    const stopped = await adapter.execute(ctx, makeAction('ptz.stop'))
    expect(stopped.ok).toBe(true)
    expect(calls(server)).toEqual([
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=LeftUp&arg1=8&arg2=4&arg3=0',
      '/cgi-bin/ptz.cgi?action=stop&channel=1&code=LeftUp&arg1=8&arg2=4&arg3=0',
    ])
  })

  it('ends the old movement before starting a different one, and treats "no movement" as stop', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server, ptz)
    await adapter.execute(ctx, makeAction('ptz.move', { pan: -1 }))
    await adapter.execute(ctx, makeAction('ptz.move', { tilt: 1 }))
    await adapter.execute(ctx, makeAction('ptz.move', { pan: 0, tilt: 0, zoom: 0 }))
    expect(calls(server)).toEqual([
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=Left&arg1=0&arg2=8&arg3=0',
      '/cgi-bin/ptz.cgi?action=stop&channel=1&code=Left&arg1=0&arg2=8&arg3=0',
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=Up&arg1=0&arg2=8&arg3=0',
      '/cgi-bin/ptz.cgi?action=stop&channel=1&code=Up&arg1=0&arg2=8&arg3=0',
    ])
  })

  it('still sends a stop when it has no movement on record', async () => {
    server = await mockServer(camera())
    const res = await adapter.execute(ctxFor(server, ptz), makeAction('ptz.stop'))
    expect(res.ok).toBe(true)
    expect(calls(server)).toEqual(['/cgi-bin/ptz.cgi?action=stop&channel=1&code=Up&arg1=0&arg2=0&arg3=0'])
  })

  it('stops by itself after params.seconds', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server, ptz)
    const res = await adapter.execute(ctx, makeAction('ptz.move', { pan: 1, seconds: 0.1 }))
    expect(res).toEqual({ ok: true, result: { stopsAfterSeconds: 0.1 } })
    expect(calls(server)).toEqual(['/cgi-bin/ptz.cgi?action=start&channel=1&code=Right&arg1=0&arg2=8&arg3=0'])
    const s = server
    await waitFor(() => calls(s).length === 2)
    expect(calls(server)[1]).toBe('/cgi-bin/ptz.cgi?action=stop&channel=1&code=Right&arg1=0&arg2=8&arg3=0')
    // Nothing left on record: a later stop is the blind one.
    await adapter.execute(ctx, makeAction('ptz.stop'))
    expect(calls(server)[2]).toBe('/cgi-bin/ptz.cgi?action=stop&channel=1&code=Up&arg1=0&arg2=0&arg3=0')
  })

  it('a stop from the phone cancels the timed stop', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server, ptz)
    await adapter.execute(ctx, makeAction('ptz.move', { pan: 1, seconds: 0.15 }))
    await adapter.execute(ctx, makeAction('ptz.stop'))
    await sleep(350)
    expect(calls(server)).toHaveLength(2)
  })

  it('falls back to channel 0 for older firmware and remembers it', async () => {
    server = await mockServer(camera({ ptz: (req) => (req.query.get('channel') === '0' ? 'OK' : 'ERROR') }))
    const ctx = ctxFor(server, ptz)
    expect((await adapter.execute(ctx, makeAction('ptz.move', { pan: -1 }))).ok).toBe(true)
    expect((await adapter.execute(ctx, makeAction('ptz.stop'))).ok).toBe(true)
    expect(calls(server)).toEqual([
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=Left&arg1=0&arg2=8&arg3=0',
      '/cgi-bin/ptz.cgi?action=start&channel=0&code=Left&arg1=0&arg2=8&arg3=0',
      '/cgi-bin/ptz.cgi?action=stop&channel=0&code=Left&arg1=0&arg2=8&arg3=0',
    ])
  })

  it('uses the movement channel the owner set, and never guesses on a recorder', async () => {
    server = await mockServer(camera())
    await adapter.execute(ctxFor(server, { ptz: true, ptzChannel: 0 }), makeAction('ptz.move', { tilt: -1 }))
    expect(calls(server)).toEqual(['/cgi-bin/ptz.cgi?action=start&channel=0&code=Down&arg1=0&arg2=8&arg3=0'])
    await server.close()
    resetDahuaRuntimes()

    server = await mockServer(camera({ ptz: () => 'ERROR' }))
    const res = await adapter.execute(ctxFor(server, { ptz: true, channel: 3 }), makeAction('ptz.move', { pan: 1 }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not accept the move command/)
    expect(calls(server)).toEqual(['/cgi-bin/ptz.cgi?action=start&channel=3&code=Right&arg1=0&arg2=8&arg3=0'])
  })

  it('goes to a preset by number or by name', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server, ptz)
    const byNumber = await adapter.execute(ctx, makeAction('ptz.preset', { preset: 2 }))
    expect(byNumber).toEqual({ ok: true, result: { preset: 2 } })
    expect(calls(server)).toEqual(['/cgi-bin/ptz.cgi?action=start&channel=1&code=GotoPreset&arg1=0&arg2=2&arg3=0'])

    const byName = await adapter.execute(ctx, makeAction('ptz.preset', { preset: 'preset1' }))
    expect(byName.ok).toBe(true)
    expect(calls(server).slice(1)).toEqual([
      '/cgi-bin/ptz.cgi?action=getPresets&channel=1',
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=GotoPreset&arg1=0&arg2=1&arg3=0',
    ])

    const unknown = await adapter.execute(ctx, makeAction('ptz.preset', { preset: 'front door' }))
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toMatch(/No preset "front door"/)
  })

  it('refuses to move a camera that is not marked as able to', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server)
    for (const type of ['ptz.move', 'ptz.stop', 'ptz.preset'] as const) {
      const res = await adapter.execute(ctx, makeAction(type, { pan: 1, preset: 1 }))
      expect(res.ok).toBe(false)
    }
    expect(server.requests).toHaveLength(0)
  })
})

describe('dahua adapter: other commands', () => {
  it('restarts the camera through magicBox.cgi', async () => {
    server = await mockServer(camera())
    const res = await adapter.execute(ctxFor(server), makeAction('reboot'))
    expect(res.ok).toBe(true)
    expect(calls(server)).toEqual(['/cgi-bin/magicBox.cgi?action=reboot'])
    expect(server.requests.at(-1)?.method).toBe('GET')
    await server.close()

    server = await mockServer(camera({ reboot: 'ERROR' }))
    const refused = await adapter.execute(ctxFor(server), makeAction('reboot'))
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/did not accept the restart/)
  })

  it('refuses what a camera cannot do', async () => {
    server = await mockServer(camera())
    const ctx = ctxFor(server, { ptz: true, wifi: true, cellular: true })
    for (const type of ['power.on', 'power.off', 'power.toggle', 'dim.set', 'color.set', 'gate.open', 'gate.close', 'gate.stop', 'gate.pulse', 'sms.send', 'custom'] as const) {
      const res = await adapter.execute(ctx, makeAction(type, { text: 'hi' }))
      expect(res.ok).toBe(false)
      expect(res.error).toContain(type)
    }
    expect(server.requests).toHaveLength(0)
  })

  it('reports a wrong login as an answer, and an unreachable camera as a failure the hub can route around', async () => {
    server = await mockServer(camera())
    const wrong = await adapter.execute(ctxFor(server, { ptz: true, password: 'hunter2-wrong' }), makeAction('ptz.move', { pan: 1 }))
    expect(wrong).toEqual({ ok: false, error: 'Wrong username or password' })
    const wrongReboot = await adapter.execute(ctxFor(server, { password: 'hunter2-wrong' }), makeAction('reboot'))
    expect(wrongReboot).toEqual({ ok: false, error: 'Wrong username or password' })

    const port = await closedPort()
    const gone = makeCtx({ family: 'dahua', config: { username: 'admin', password: 'secret', ptz: true }, path: { port } })
    await expect(adapter.execute(gone, makeAction('ptz.move', { pan: 1 }))).rejects.toThrow(/refused the connection/)
    await expect(adapter.execute(gone, makeAction('reboot'))).rejects.toThrow(/refused the connection/)

    await server.close()
    server = await mockServer(() => {
      /* never answers */
    })
    const silent = ctxFor(server, { ptz: true }, { timeoutMs: 300 })
    await expect(adapter.execute(silent, makeAction('ptz.move', { pan: 1 }))).rejects.toThrow('The camera at 127.0.0.1 did not answer in time')
  })
})

describe('dahua adapter: reading state', () => {
  it('reads only the network table for a plain fixed camera', async () => {
    server = await mockServer(camera())
    const state = await adapter.readState!(ctxFor(server))
    expect(state).toEqual({ mac: '00:10:5c:f2:1c:b4' })
    expect(calls(server)).toEqual(['/cgi-bin/configManager.cgi?action=getConfig&name=Network'])
  })

  it('adds WiFi, position, presets and SIM when the switches are on', async () => {
    server = await mockServer(camera())
    const state = await adapter.readState!(ctxFor(server, { ptz: true, wifi: true, cellular: true }))
    expect(state).toEqual({
      mac: '00:10:5c:f2:1c:b4',
      wifi: 'dahua',
      sim: 'SIM module ready (WCDMA)',
      ptz: { pan: 120, tilt: 12, zoom: 2 },
      presets: [1, 2],
      presetNames: { '1': 'preset1', '2': 'preset2' },
    })
    expect(calls(server).sort()).toEqual([
      '/cgi-bin/configManager.cgi?action=getConfig&name=Network',
      '/cgi-bin/configManager.cgi?action=getConfig&name=WLan',
      '/cgi-bin/netApp.cgi?action=getInterfaces',
      '/cgi-bin/ptz.cgi?action=getPresets&channel=1',
      '/cgi-bin/ptz.cgi?action=getStatus&channel=1',
    ])
    // The WLan answer carries the stored WiFi keys; none of that may reach the app.
    expect(JSON.stringify(state)).not.toMatch(/password\d/)
  })

  it('reports the SIM link state newer firmware gives', async () => {
    server = await mockServer(camera({ interfaces: INTERFACES_NEW }))
    const state = await adapter.readState!(ctxFor(server, { cellular: true }))
    expect(state.sim).toBe('Connected')
    expect(state.signal).toBeUndefined()
    await server.close()

    server = await mockServer(camera({ interfaces: INTERFACES_WIRED_ONLY }))
    const none = await adapter.readState!(ctxFor(server, { cellular: true }))
    expect(none.sim).toBe('No SIM module reported by the camera')
  })

  it('shows no WiFi name when the camera has none to report', async () => {
    server = await mockServer(camera({ wlan: 'ERROR' }))
    const state = await adapter.readState!(ctxFor(server, { wifi: true }))
    expect(state).toEqual({ mac: '00:10:5c:f2:1c:b4', wifi: null })
  })

  it('fails rather than return an empty state when the camera is unreachable or the login is wrong', async () => {
    server = await mockServer(camera())
    await expect(adapter.readState!(ctxFor(server, { password: 'nope' }))).rejects.toThrow('Wrong username or password')
    const port = await closedPort()
    const gone = makeCtx({ family: 'dahua', config: { username: 'admin', password: 'secret' }, path: { port } })
    await expect(adapter.readState!(gone)).rejects.toThrow(/refused the connection/)
  })
})

describe('dahua adapter: WiFi', () => {
  const wifi = { wifi: true }
  const SET = '/cgi-bin/configManager.cgi?action=setConfig&'

  it('lists the networks the camera sees', async () => {
    server = await mockServer(camera())
    const found = await adapter.scanWifi!(ctxFor(server, wifi))
    expect(found).toEqual([{ ssid: SCAN_SSID, signal: 31, security: 'WPA/WPA2 (AES)' }])
    expect(calls(server)).toEqual(['/cgi-bin/wlan.cgi?action=scanWlanDevices'])
    await server.close()

    server = await mockServer(camera({ scan: SCAN_NEW }))
    expect(await adapter.scanWifi!(ctxFor(server, wifi))).toEqual(found)
    await server.close()

    server = await mockServer(camera({ scan: SCAN_NONE }))
    expect(await adapter.scanWifi!(ctxFor(server, wifi))).toEqual([])
  })

  it('moves the camera with a scan and one setConfig call, escaped per RFC 3986', async () => {
    server = await mockServer(camera())
    const password = 'p@ss w0rd/+&=#'
    const res = await adapter.setWifi!(ctxFor(server, wifi), { ssid: SCAN_SSID, password })
    expect(res.ok).toBe(true)
    expect(res.state).toEqual({ wifi: SCAN_SSID })
    expect(calls(server)).toEqual([
      '/cgi-bin/configManager.cgi?action=getConfig&name=WLan',
      '/cgi-bin/wlan.cgi?action=scanWlanDevices',
      SET +
        'WLan.eth2.Enable=true&WLan.eth2.SSID=xia_yuguo%2013098%20Internet&WLan.eth2.Encryption=WPA-PSK-CCMP&WLan.eth2.KeyType=ASCII' +
        '&WLan.eth2.Keys[0]=p%40ss%20w0rd%2F%2B%26%3D%23&WLan.eth2.KeyID=0&WLan.eth2.LinkMode=Infrastructure',
    ])
    const write = server.requests.at(-1)!
    expect(write.method).toBe('GET')
    expect(write.query.get('WLan.eth2.SSID')).toBe(SCAN_SSID)
    expect(write.query.get('WLan.eth2.Keys[0]')).toBe(password)
    // The password goes to the camera and nowhere else.
    expect(JSON.stringify(res)).not.toContain(password)
    expect(JSON.stringify(res)).not.toContain('w0rd')
  })

  it('takes the interface name and spelling from newer firmware, and sets its connect switch', async () => {
    server = await mockServer(camera({ wlan: WLAN_NEW, scan: SCAN_NEW }))
    const res = await adapter.setWifi!(ctxFor(server, wifi), { ssid: SCAN_SSID, password: 'correct horse' })
    expect(res.ok).toBe(true)
    expect(calls(server).at(-1)).toBe(
      SET +
        'WLan.wlan0.Enable=true&WLan.wlan0.SSID=xia_yuguo%2013098%20Internet&WLan.wlan0.Encryption=WPA2-PSK-AES&WLan.wlan0.KeyType=ASCII' +
        '&WLan.wlan0.Keys[0]=correct%20horse&WLan.wlan0.KeyID=0&WLan.wlan0.LinkMode=Infrastructure&WLan.wlan0.ConnectEnable=true',
    )
  })

  it('still writes when the camera cannot scan, using the usual home security setting', async () => {
    server = await mockServer(camera({ scan: SCAN_NONE }))
    const res = await adapter.setWifi!(ctxFor(server, wifi), { ssid: 'Home WiFi', password: 'secret-key-1' })
    expect(res.ok).toBe(true)
    expect(calls(server).at(-1)).toBe(
      SET +
        'WLan.eth2.Enable=true&WLan.eth2.SSID=Home%20WiFi&WLan.eth2.Encryption=WPA-PSK-CCMP&WLan.eth2.KeyType=ASCII' +
        '&WLan.eth2.Keys[0]=secret-key-1&WLan.eth2.KeyID=0&WLan.eth2.LinkMode=Infrastructure',
    )
  })

  it('leaves the camera where it is when it cannot see the target network', async () => {
    server = await mockServer(camera())
    const res = await adapter.setWifi!(ctxFor(server, wifi), { ssid: 'Backup WiFi', password: 'secret-key-1' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cannot see "Backup WiFi"/)
    expect(calls(server).some((u) => u.includes('setConfig'))).toBe(false)
  })

  it('reports a camera that rejects the settings, without echoing the password', async () => {
    server = await mockServer(camera({ setConfig: 'ERROR' }))
    const res = await adapter.setWifi!(ctxFor(server, wifi), { ssid: SCAN_SSID, password: 'secret-key-1' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not accept the WiFi settings/)
    expect(JSON.stringify(res)).not.toContain('secret-key-1')
  })

  it('treats the link dropping right after the write as the camera leaving for the new network', async () => {
    server = await mockServer(camera({ setConfig: 'drop' }))
    const res = await adapter.setWifi!(ctxFor(server, wifi), { ssid: SCAN_SSID, password: 'secret-key-1' })
    expect(res.ok).toBe(true)
    expect(res.state).toEqual({ wifi: SCAN_SSID })
    expect(String(res.result?.note)).toMatch(/stopped answering/)
    expect(JSON.stringify(res)).not.toContain('secret-key-1')
  })

  it('refuses when the camera has no WiFi adapter, the login is wrong, or WiFi is switched off here', async () => {
    server = await mockServer(camera({ wlan: 'ERROR', interfaces: INTERFACES_WIRED_ONLY }))
    const none = await adapter.setWifi!(ctxFor(server, wifi), { ssid: SCAN_SSID, password: 'secret-key-1' })
    expect(none.ok).toBe(false)
    expect(none.error).toMatch(/does not report a WiFi adapter/)
    expect(calls(server)).toEqual(['/cgi-bin/configManager.cgi?action=getConfig&name=WLan', '/cgi-bin/netApp.cgi?action=getInterfaces'])

    const wrong = await adapter.setWifi!(ctxFor(server, { wifi: true, password: 'nope' }), { ssid: SCAN_SSID, password: 'secret-key-1' })
    expect(wrong).toEqual({ ok: false, error: 'Wrong username or password' })

    const before = server.requests.length
    const off = await adapter.setWifi!(ctxFor(server), { ssid: SCAN_SSID, password: 'secret-key-1' })
    expect(off.ok).toBe(false)
    await expect(adapter.scanWifi!(ctxFor(server))).rejects.toThrow(/WiFi is switched off/)
    expect(server.requests).toHaveLength(before)
  })

  it('throws when the camera cannot be reached at all, so the hub can try another path', async () => {
    const port = await closedPort()
    const gone = makeCtx({ family: 'dahua', config: { username: 'admin', password: 'secret', wifi: true }, path: { port } })
    await expect(adapter.setWifi!(gone, { ssid: SCAN_SSID, password: 'secret-key-1' })).rejects.toThrow(/refused the connection/)
    await expect(adapter.scanWifi!(gone)).rejects.toThrow(/refused the connection/)
  })
})

// ---------------------------------------------------------------- added by review

describe('dahua adapter: the address it calls', () => {
  const at = (config: Record<string, unknown>, port: number | null) =>
    cameraBaseUrl(makeCtx({ family: 'dahua', config: { username: 'admin', password: 'secret', ...config }, path: { host: '192.168.1.108', port } }))

  it('uses the address and port of the connection', () => {
    expect(at({}, 80)).toBe('http://192.168.1.108')
    expect(at({}, null)).toBe('http://192.168.1.108')
    expect(at({}, 8080)).toBe('http://192.168.1.108:8080')
  })

  it('goes to 443 with HTTPS on, although every connection is saved with the usual port 80', () => {
    // The hub fills in port 80 (this family's usual port) on every new connection.
    expect(adapter.describe().defaultPort).toBe(80)
    expect(at({ https: true }, 80)).toBe('https://192.168.1.108')
    expect(at({ https: true }, null)).toBe('https://192.168.1.108')
    expect(at({ https: true }, 443)).toBe('https://192.168.1.108')
    // A port the owner typed is kept.
    expect(at({ https: true }, 8443)).toBe('https://192.168.1.108:8443')
  })

  it('says so when HTTPS is switched on for a camera that only speaks plain HTTP', async () => {
    server = await mockServer(camera())
    const res = await adapter.probe(ctxFor(server, { https: true }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Use HTTPS/)
    expect(res.error).not.toContain('secret')
  })
})

describe('dahua adapter: older and odd firmware', () => {
  it('logs in with Basic where the camera asks for it', async () => {
    server = await mockServer(camera({ basicAuth: true }))
    const ok = await adapter.probe(ctxFor(server))
    expect(ok.ok).toBe(true)
    expect(ok.info?.serial).toBe('YZC0GZ05100020')
    expect(server.requests.at(-1)?.headers.authorization).toMatch(/^Basic /)
    const wrong = await adapter.probe(ctxFor(server, { password: 'not-the-password' }))
    expect(wrong).toEqual({ ok: false, latencyMs: null, error: 'Wrong username or password' })
  })

  it('does not hand one camera the remembered model of another', async () => {
    server = await mockServer(camera())
    await adapter.probe(ctxFor(server))
    await server.close()
    // Same device entry, another camera answering (as when the hub tries candidates after a WiFi move).
    server = await mockServer(camera({ systemInfo: lines('serialNumber=ZZZ9999999', 'deviceType=IPC-HDW1230', 'hardwareVersion=1.00') }))
    const other = await adapter.probe(ctxFor(server))
    expect(other.info?.serial).toBe('ZZZ9999999')
    expect(calls(server)).toHaveLength(3)
  })

  it('understands a refusal sent as HTTP 400 as well as one sent as the word ERROR', async () => {
    // PTZ: channel 1 refused with 400, channel 0 accepted.
    server = await mockServer(camera({ errorStatus: 400, ptz: (req) => (req.query.get('channel') === '0' ? 'OK' : 'ERROR') }))
    expect((await adapter.execute(ctxFor(server, { ptz: true }), makeAction('ptz.move', { pan: 1 }))).ok).toBe(true)
    expect(calls(server)).toEqual([
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=Right&arg1=0&arg2=8&arg3=0',
      '/cgi-bin/ptz.cgi?action=start&channel=0&code=Right&arg1=0&arg2=8&arg3=0',
    ])
    await server.close()
    resetDahuaRuntimes()

    server = await mockServer(camera({ errorStatus: 400, reboot: 'ERROR', wlan: 'ERROR', snapshot: 'error', interfaces: INTERFACES_WIRED_ONLY }))
    const refused = await adapter.execute(ctxFor(server), makeAction('reboot'))
    expect(refused).toEqual({ ok: false, error: 'The camera did not accept the restart command' })
    await expect(adapter.snapshot!(ctxFor(server))).rejects.toThrow(/did not return a picture/)
    // No WiFi table: the state still arrives, with no network name.
    expect(await adapter.readState!(ctxFor(server, { wifi: true }))).toEqual({ mac: '00:10:5c:f2:1c:b4', wifi: null })
    const moved = await adapter.setWifi!(ctxFor(server, { wifi: true }), { ssid: SCAN_SSID, password: 'secret-key-1' })
    expect(moved.ok).toBe(false)
    expect(moved.error).toMatch(/does not report a WiFi adapter/)
  })

  it('reads presets from firmware that leaves out the first word of each line', async () => {
    // Same rows as the documented sample, as presets[i] instead of presets.presets[i].
    server = await mockServer(camera({ presets: lines('presets[0].Index=1', 'presets[0].Name=preset1', 'presets[1].Index=2', 'presets[1].Name=preset2') }))
    const ctx = ctxFor(server, { ptz: true })
    const state = await adapter.readState!(ctx)
    expect(state.presets).toEqual([1, 2])
    expect(state.presetNames).toEqual({ '1': 'preset1', '2': 'preset2' })
    const res = await adapter.execute(ctx, makeAction('ptz.preset', { preset: 'preset2' }))
    expect(res).toEqual({ ok: true, result: { preset: 2 } })
  })

  it('keeps the rest of the state when one part cannot be read', async () => {
    server = await mockServer(camera({ errorStatus: 400, presets: 'ERROR' }))
    const state = await adapter.readState!(ctxFor(server, { ptz: true, wifi: true }))
    expect(state.mac).toBe('00:10:5c:f2:1c:b4')
    expect(state.wifi).toBe('dahua')
    expect(state.ptz).toEqual({ pan: 120, tilt: 12, zoom: 2 })
    expect(state.presets).toBeUndefined()
  })
})

describe('dahua adapter: answers that are not what a camera sends', () => {
  it('copes with a web page where the camera should be', async () => {
    // A router or another make of camera: every address answers 200 with HTML.
    server = await mockServer((_req, res) => send(res, 200, '<html><head><meta charset="utf-8"></head><body>Login</body></html>', 'text/html'))
    const ctx = ctxFor(server, { ptz: true, wifi: true, cellular: true })
    expect((await adapter.probe(ctx)).ok).toBe(false)
    const reboot = await adapter.execute(ctx, makeAction('reboot'))
    expect(reboot).toEqual({ ok: false, error: 'The camera did not accept the restart command' })
    const move = await adapter.execute(ctx, makeAction('ptz.move', { pan: 1 }))
    expect(move.ok).toBe(false)
    expect(move.error).toMatch(/did not accept the move command/)
    await expect(adapter.snapshot!(ctx)).rejects.toThrow(/did not return a picture/)
    expect(await adapter.scanWifi!(ctx)).toEqual([])
    const state = await adapter.readState!(ctx)
    expect(state.mac).toBeUndefined()
    expect(state.wifi).toBeNull()
    expect(state.presets).toEqual([])
    const wifi = await adapter.setWifi!(ctx, { ssid: SCAN_SSID, password: 'secret-key-1' })
    expect(wifi.ok).toBe(false)
    expect(wifi.error).toMatch(/does not report a WiFi adapter/)
  })

  it('reports a connection the camera cuts as a failure the hub can route around', async () => {
    server = await mockServer((_req, _res, raw) => {
      raw.socket.destroy()
    })
    const ctx = ctxFor(server, { ptz: true, wifi: true })
    const probe = await adapter.probe(ctx)
    expect(probe).toEqual({ ok: false, latencyMs: null, error: 'The camera at 127.0.0.1 closed the connection' })
    await expect(adapter.execute(ctx, makeAction('reboot'))).rejects.toThrow('The camera at 127.0.0.1 closed the connection')
    await expect(adapter.readState!(ctx)).rejects.toThrow(/closed the connection/)
    await expect(adapter.snapshot!(ctx)).rejects.toThrow(/closed the connection/)
    await expect(adapter.scanWifi!(ctx)).rejects.toThrow(/closed the connection/)
    await expect(adapter.setWifi!(ctx, { ssid: SCAN_SSID, password: 'secret-key-1' })).rejects.toThrow(/closed the connection/)
  })

  it('gives up on a silent camera within the time the hub allows', async () => {
    server = await mockServer(() => {
      /* never answers */
    })
    const ctx = ctxFor(server, { ptz: true, wifi: true, cellular: true }, { timeoutMs: 300 })
    let started = Date.now()
    // The hub cuts a state read off after one device timeout; the adapter's own answer must come first.
    const patient = ctxFor(server, { ptz: true, wifi: true, cellular: true }, { timeoutMs: 800 })
    await expect(adapter.readState!(patient)).rejects.toThrow('The camera at 127.0.0.1 did not answer in time')
    expect(Date.now() - started).toBeLessThan(800)
    started = Date.now()
    await expect(adapter.snapshot!(ctx)).rejects.toThrow(/did not answer in time/)
    expect(Date.now() - started).toBeLessThan(600)
    started = Date.now()
    await expect(adapter.scanWifi!(ctx)).rejects.toThrow(/did not answer in time/)
    expect(Date.now() - started).toBeLessThan(900)
    started = Date.now()
    await expect(adapter.setWifi!(ctx, { ssid: SCAN_SSID, password: 'secret-key-1' })).rejects.toThrow(/did not answer in time/)
    expect(Date.now() - started).toBeLessThan(600)
  })

  it('accepts a picture by its bytes when the camera does not label it, and refuses a web page', async () => {
    server = await mockServer(camera({ snapshot: 'unlabelled' }))
    const snap = await adapter.snapshot!(ctxFor(server))
    expect(snap.contentType).toBe('image/jpeg')
    expect(snap.body.equals(TINY_JPEG)).toBe(true)
    await server.close()

    server = await mockServer(camera({ snapshot: 'html' }))
    await expect(adapter.snapshot!(ctxFor(server))).rejects.toThrow(/did not return a picture/)
  })
})

describe('dahua adapter: a move never goes without its stop', () => {
  const ptz = { ptz: true }

  it('stops a move whose answer was lost on the way back', async () => {
    // The camera gets the start and begins to turn, but the answer never reaches the hub.
    let lose = true
    server = await mockServer(
      camera({
        ptz: (req) => {
          if (req.query.get('action') === 'start' && lose) {
            lose = false
            return 'drop'
          }
          return 'OK'
        },
      }),
    )
    const ctx = ctxFor(server, ptz)
    await expect(adapter.execute(ctx, makeAction('ptz.move', { pan: 1 }))).rejects.toThrow(/closed the connection/)
    // Letting go of the button stops that very movement, not a blind guess.
    const stopped = await adapter.execute(ctx, makeAction('ptz.stop'))
    expect(stopped.ok).toBe(true)
    expect(calls(server)).toEqual([
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=Right&arg1=0&arg2=8&arg3=0',
      '/cgi-bin/ptz.cgi?action=stop&channel=1&code=Right&arg1=0&arg2=8&arg3=0',
    ])
  })

  it('sends the timed stop even when the start was never confirmed', async () => {
    server = await mockServer(camera({ ptz: (req) => (req.query.get('action') === 'start' ? 'drop' : 'OK') }))
    const ctx = ctxFor(server, ptz)
    await expect(adapter.execute(ctx, makeAction('ptz.move', { tilt: 1, seconds: 0.1 }))).rejects.toThrow(/closed the connection/)
    const s = server
    await waitFor(() => calls(s).some((u) => u.includes('action=stop')))
    expect(calls(server)).toEqual([
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=Up&arg1=0&arg2=8&arg3=0',
      '/cgi-bin/ptz.cgi?action=stop&channel=1&code=Up&arg1=0&arg2=8&arg3=0',
    ])
  })

  it('keeps trying by itself when the stop does not get through', async () => {
    let stops = 0
    server = await mockServer(
      camera({
        ptz: (req) => {
          if (req.query.get('action') !== 'stop') return 'OK'
          stops += 1
          return stops === 1 ? 'drop' : 'OK'
        },
      }),
    )
    const ctx = ctxFor(server, ptz)
    await adapter.execute(ctx, makeAction('ptz.move', { pan: -1 }))
    // The first stop is lost: the hub is told (so it can try another connection) ...
    await expect(adapter.execute(ctx, makeAction('ptz.stop'))).rejects.toThrow(/closed the connection/)
    // ... and the adapter sends it again without being asked.
    const s = server
    await waitFor(() => stops >= 2)
    await sleep(50)
    expect(calls(s)).toEqual([
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=Left&arg1=0&arg2=8&arg3=0',
      '/cgi-bin/ptz.cgi?action=stop&channel=1&code=Left&arg1=0&arg2=8&arg3=0',
      '/cgi-bin/ptz.cgi?action=stop&channel=1&code=Left&arg1=0&arg2=8&arg3=0',
    ])
    // Delivered: nothing is left on record, so a later stop is the blind one.
    await adapter.execute(ctx, makeAction('ptz.stop'))
    expect(calls(s).at(-1)).toBe('/cgi-bin/ptz.cgi?action=stop&channel=1&code=Up&arg1=0&arg2=0&arg3=0')
  })

  it('keeps a running direction on record when the camera turns down a change of speed', async () => {
    let starts = 0
    server = await mockServer(
      camera({
        ptz: (req) => {
          if (req.query.get('action') !== 'start') return 'OK'
          starts += 1
          return starts === 1 ? 'OK' : 'ERROR'
        },
      }),
    )
    const ctx = ctxFor(server, { ptz: true, ptzChannel: 1 })
    await adapter.execute(ctx, makeAction('ptz.move', { pan: 0.5 }))
    const faster = await adapter.execute(ctx, makeAction('ptz.move', { pan: 1 }))
    expect(faster.ok).toBe(false)
    await adapter.execute(ctx, makeAction('ptz.stop'))
    // The stop matches the start the camera did accept (speed 4).
    expect(calls(server).at(-1)).toBe('/cgi-bin/ptz.cgi?action=stop&channel=1&code=Right&arg1=0&arg2=4&arg3=0')
  })

  it('does not put a move on record when the camera rejects the login', async () => {
    server = await mockServer(camera())
    const wrong = await adapter.execute(ctxFor(server, { ptz: true, password: 'nope' }), makeAction('ptz.move', { pan: 1, seconds: 0.05 }))
    expect(wrong).toEqual({ ok: false, error: 'Wrong username or password' })
    const before = server.requests.length
    await sleep(200)
    // No stop was scheduled for a movement that never began.
    expect(server.requests).toHaveLength(before)
  })
})

describe('dahua adapter: WiFi moves on a slow or silent camera', () => {
  const wifi = { wifi: true }

  it('writes without the scan check when the scan gets no answer in time', async () => {
    server = await mockServer(camera({ scan: 'hang' }))
    const started = Date.now()
    const res = await adapter.setWifi!(ctxFor(server, wifi, { timeoutMs: 400 }), { ssid: 'Home WiFi', password: 'secret-key-1' })
    expect(res.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(800)
    expect(calls(server).at(-1)).toBe(
      '/cgi-bin/configManager.cgi?action=setConfig&WLan.eth2.Enable=true&WLan.eth2.SSID=Home%20WiFi&WLan.eth2.Encryption=WPA-PSK-CCMP&WLan.eth2.KeyType=ASCII' +
        '&WLan.eth2.Keys[0]=secret-key-1&WLan.eth2.KeyID=0&WLan.eth2.LinkMode=Infrastructure',
    )
  })

  it('finishes inside the two timeouts the hub allows when the camera goes quiet after the write', async () => {
    server = await mockServer(camera({ setConfig: 'hang' }))
    const started = Date.now()
    const res = await adapter.setWifi!(ctxFor(server, wifi, { timeoutMs: 400 }), { ssid: SCAN_SSID, password: 'secret-key-1' })
    expect(Date.now() - started).toBeLessThan(800)
    expect(res.ok).toBe(true)
    expect(res.state).toEqual({ wifi: SCAN_SSID })
    expect(String(res.result?.note)).toMatch(/stopped answering/)
  })

  it('escapes a network name and password made of awkward characters', async () => {
    const ssid = 'Café ; / ? : @ = + , $ & #1'
    const password = 'pä$$ "quoted" 100% <ok>'
    server = await mockServer(camera({ scan: SCAN_NONE }))
    const res = await adapter.setWifi!(ctxFor(server, wifi), { ssid, password })
    expect(res.ok).toBe(true)
    const write = server.requests.at(-1)!
    // Nothing but letters, digits and - . _ ~ travels unescaped inside a value (RFC 3986).
    const values = write.url.split('&').slice(1).map((pair) => pair.slice(pair.indexOf('=') + 1))
    for (const value of values) expect(value).toMatch(/^(?:[A-Za-z0-9\-._~]|%[0-9A-F]{2})*$/)
    expect(write.query.get('WLan.eth2.SSID')).toBe(ssid)
    expect(write.query.get('WLan.eth2.Keys[0]')).toBe(password)
    expect([...write.query.keys()]).toEqual([
      'action',
      'WLan.eth2.Enable',
      'WLan.eth2.SSID',
      'WLan.eth2.Encryption',
      'WLan.eth2.KeyType',
      'WLan.eth2.Keys[0]',
      'WLan.eth2.KeyID',
      'WLan.eth2.LinkMode',
    ])
  })
})

describe('dahua adapter: secrets stay inside the hub', () => {
  it('never writes a password into a log line, an error, a result or the state', async () => {
    setLogLevel('debug')
    const printed: string[] = []
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(' '))
      })
    }
    const camPassword = 'cam-Pa55/word'
    const wifiPassword = 'wifi-Pa55 word&more'
    const seen: string[] = []
    const note = (value: unknown) => seen.push(value instanceof Error ? value.message : JSON.stringify(value))

    server = await mockServer(camera({ password: camPassword, scan: 'hang', setConfig: 'drop' }))
    const good = ctxFor(server, { password: camPassword, ptz: true, wifi: true, cellular: true }, { timeoutMs: 300 })
    note(await adapter.probe(good))
    note(await adapter.readState!(good))
    note(await adapter.setWifi!(good, { ssid: SCAN_SSID, password: wifiPassword }))
    note(await adapter.execute(good, makeAction('ptz.move', { pan: 1, seconds: 0.05 })))
    await server.close()
    // The camera is gone when the timed stop fires: that failure is logged.
    await sleep(300)

    const port = await closedPort()
    const gone = makeCtx({ family: 'dahua', config: { username: 'admin', password: camPassword, wifi: true, ptz: true }, path: { port } })
    note(await adapter.probe(gone))
    note(await adapter.setWifi!(gone, { ssid: SCAN_SSID, password: wifiPassword }).catch((err: unknown) => err))
    note(await adapter.execute(gone, makeAction('reboot')).catch((err: unknown) => err))
    note(await adapter.snapshot!(gone).catch((err: unknown) => err))

    const everything = [...seen, ...printed].join('\n')
    expect(printed.length).toBeGreaterThan(0)
    for (const secret of [camPassword, encodeURIComponent(camPassword), wifiPassword, encodeURIComponent(wifiPassword), 'Pa55', 'password1']) {
      expect(everything).not.toContain(secret)
    }
  })
})

describe('dahua adapter: video address details', () => {
  it('lets a connection publish video on its own port', () => {
    // A SIM or forwarded connection often maps video to a different outside port than the one at home.
    const ctx = makeCtx({
      family: 'dahua',
      config: { username: 'admin', password: 'secret', rtspPort: 554 },
      path: { kind: 'cellular', label: 'SIM', host: '203.0.113.7', port: 8080, extra: { rtspPort: 10554 } },
    })
    expect(adapter.streamSources!(ctx)).toEqual([
      'rtsp://admin:secret@203.0.113.7:10554/cam/realmonitor?channel=1&subtype=0',
      'rtsp://admin:secret@203.0.113.7:10554/cam/realmonitor?channel=1&subtype=1',
    ])
  })

  it('does not put the HTTPS switch or the control port into the video address', () => {
    const ctx = makeCtx({ family: 'dahua', config: { username: 'admin', password: 'secret', https: true }, path: { host: '192.168.1.108', port: 80 } })
    expect(adapter.streamSources!(ctx)[0]).toBe('rtsp://admin:secret@192.168.1.108:554/cam/realmonitor?channel=1&subtype=0')
  })
})
