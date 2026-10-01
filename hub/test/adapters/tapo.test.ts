import crypto from 'node:crypto'
import type http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { resetOnvifSessions } from '../../src/adapters/onvif.ts'
import adapter, { resetTapoSessions } from '../../src/adapters/tapo.ts'
import { sleep } from '../../src/lib/http.ts'
import { digestGuard, makeAction, makeCtx, mockServer, send, TINY_JPEG, type MockHandler, type MockServer, type RecordedRequest } from '../helpers.ts'

// ---------------------------------------------------------------------------
// A mock Tapo camera, as docs/protocols/tapo-ezviz-v380.md describes one:
//  - ONVIF entry point http://{ip}:2020/onvif/device_service
//  - GetServices / GetCapabilities give ONE address, http://{ip}:2020/onvif/service,
//    for media, events, imaging and PTZ
//  - login is WS-Security UsernameToken PasswordDigest = Base64(SHA1(nonce + created + password))
//    with the Camera Account
//  - GetStreamUri answers rtsp://{ip}:554/stream1 and /stream2
//  - the ONVIF WiFi (Dot11) calls are not supported
// Element names and fault shapes are the ONVIF WSDL ones (docs/protocols/onvif-generic.md).
// ---------------------------------------------------------------------------

const ENV_OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>\n<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:ter="http://www.onvif.org/ver10/error" ' +
  'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" ' +
  'xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><SOAP-ENV:Body>'
const ENV_CLOSE = '</SOAP-ENV:Body></SOAP-ENV:Envelope>'

const LAN = '192.168.1.71'
const DEVICE_XADDR = `http://${LAN}:2020/onvif/device_service`
const SERVICE_XADDR = `http://${LAN}:2020/onvif/service`
const SERIAL = '5c628b4e'
const MAC = '5c:62:8b:4e:a1:07'

const NS_DEVICE = 'http://www.onvif.org/ver10/device/wsdl'
const NS_MEDIA = 'http://www.onvif.org/ver10/media/wsdl'
const NS_PTZ = 'http://www.onvif.org/ver20/ptz/wsdl'
const NS_SCHEMA = 'http://www.onvif.org/ver10/schema'

interface Tapo {
  username: string
  password: string
  /** A fixed model (no motor): no PTZ service, no PTZ configuration on the profiles. */
  fixed?: boolean
  /** Answers GetSnapshotUri with an address instead of a fault. */
  stills?: boolean
  /** GetServices faults; only GetCapabilities gives the service addresses. */
  capabilitiesOnly?: boolean
  /** No positions saved in the Tapo app yet. */
  noPresets?: boolean
  /** SystemReboot faults ActionNotSupported. */
  noReboot?: boolean
  /** Faults ter:InvalidArgVal when ContinuousMove carries a Timeout element. */
  noMoveTimeout?: boolean
  /** Has no zoom: faults ter:InvalidArgVal when ContinuousMove carries a Zoom element. */
  noZoom?: boolean
  /** Answers a login it does not accept with a bare HTTP 401 instead of a SOAP fault. */
  bare401?: boolean
  /** The Camera Account may look and turn but not restart: SystemReboot faults ter:NotAuthorized. */
  rebootNotAllowed?: boolean
  /** The still-picture address wants a different login than the Camera Account. */
  stillsPassword?: string
  /** Answers Stop with a plain-text HTTP 500 instead of SOAP. */
  stopGarbled?: boolean
}

function soap(res: http.ServerResponse, inner: string, status = 200): void {
  send(res, status, ENV_OPEN + inner + ENV_CLOSE, 'application/soap+xml; charset=utf-8')
}

function fault(res: http.ServerResponse, status: number, code: string, subcodes: string[], reason: string): void {
  let sub = ''
  for (const s of [...subcodes].reverse()) sub = `<SOAP-ENV:Subcode><SOAP-ENV:Value>${s}</SOAP-ENV:Value>${sub}</SOAP-ENV:Subcode>`
  soap(
    res,
    `<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>${code}</SOAP-ENV:Value>${sub}</SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">${reason}</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`,
    status,
  )
}

function notSupported(res: http.ServerResponse): void {
  fault(res, 400, 'SOAP-ENV:Sender', ['ter:ActionNotSupported'], 'Optional Action Not Implemented')
}

function opOf(req: RecordedRequest): string {
  return /<(?:[\w-]+:)?Body[^>]*>\s*<(?:[\w-]+:)?([A-Za-z0-9]+)/.exec(req.body)?.[1] ?? ''
}

/** The operation element exactly as the hub sent it. */
function payload(req: RecordedRequest): string {
  return /<s:Body[^>]*>(.*)<\/s:Body>/s.exec(req.body)?.[1] ?? ''
}

function ops(server: MockServer): string[] {
  return server.requests.filter((r) => r.method === 'POST').map(opOf)
}

function last(server: MockServer, op: string): RecordedRequest {
  const hit = [...server.requests].reverse().find((r) => opOf(r) === op)
  if (!hit) throw new Error(`no ${op} request was sent`)
  return hit
}

function count(server: MockServer, op: string): number {
  return ops(server).filter((o) => o === op).length
}

/** WS-Security UsernameToken with PasswordDigest, checked the way the camera does. */
function wsseOk(body: string, cam: Tapo): boolean {
  const user = /<Username>([^<]*)<\/Username>/.exec(body)?.[1]
  const digest = /<Password Type="[^"]*#PasswordDigest">([^<]+)<\/Password>/.exec(body)?.[1]
  const nonce = /<Nonce EncodingType="[^"]*#Base64Binary">([^<]+)<\/Nonce>/.exec(body)?.[1]
  const created = /<Created[^>]*>([^<]+)<\/Created>/.exec(body)?.[1]
  if (!user || !digest || !nonce || !created) return false
  const expected = crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created + cam.password, 'utf8')]))
    .digest('base64')
  const skew = Math.abs(Date.parse(created) - Date.now())
  return user === cam.username && digest === expected && skew < 5000
}

function service(ns: string, xaddr: string): string {
  return `<tds:Service><tds:Namespace>${ns}</tds:Namespace><tds:XAddr>${xaddr}</tds:XAddr><tds:Version><tt:Major>2</tt:Major><tt:Minor>20</tt:Minor></tds:Version></tds:Service>`
}

function profile(cam: Tapo, token: string, name: string, w: number, h: number): string {
  return (
    `<trt:Profiles token="${token}" fixed="true"><tt:Name>${name}</tt:Name>` +
    '<tt:VideoSourceConfiguration token="vsconf"><tt:Name>vsconf</tt:Name><tt:UseCount>2</tt:UseCount><tt:SourceToken>raw_vs1</tt:SourceToken><tt:Bounds x="0" y="0" width="1920" height="1080"/></tt:VideoSourceConfiguration>' +
    `<tt:VideoEncoderConfiguration token="${name}"><tt:Name>${name}</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>${w}</tt:Width><tt:Height>${h}</tt:Height></tt:Resolution><tt:Quality>3</tt:Quality>` +
    '<tt:RateControl><tt:FrameRateLimit>15</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>1024</tt:BitrateLimit></tt:RateControl></tt:VideoEncoderConfiguration>' +
    (cam.fixed ? '' : '<tt:PTZConfiguration token="PTZToken"><tt:Name>PTZ</tt:Name><tt:UseCount>2</tt:UseCount><tt:NodeToken>PTZNODETOKEN</tt:NodeToken><tt:DefaultPTZTimeout>PT10S</tt:DefaultPTZTimeout></tt:PTZConfiguration>') +
    '</trt:Profiles>'
  )
}

const STREAM: Record<string, string> = {
  profile_1: `rtsp://${LAN}:554/stream1`,
  profile_2: `rtsp://${LAN}:554/stream2`,
}

// Positions saved in the Tapo app; the third was never given a name.
const PRESETS =
  '<tptz:GetPresetsResponse>' +
  '<tptz:Preset token="1"><tt:Name>Gate</tt:Name><tt:PTZPosition><tt:PanTilt x="0.25" y="-0.1" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/></tt:PTZPosition></tptz:Preset>' +
  '<tptz:Preset token="2"><tt:Name>Driveway</tt:Name><tt:PTZPosition><tt:PanTilt x="-0.6" y="0.2" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/></tt:PTZPosition></tptz:Preset>' +
  '<tptz:Preset token="3"><tt:Name>Preset 3</tt:Name></tptz:Preset>' +
  '</tptz:GetPresetsResponse>'

function tapoCamera(cam: Tapo): MockHandler {
  const stillsGuard = digestGuard(cam.username, cam.stillsPassword ?? cam.password)
  const preAuth = new Set(['GetSystemDateAndTime', 'GetServices', 'GetCapabilities'])

  const device = (op: string, res: http.ServerResponse): void => {
    switch (op) {
      case 'GetSystemDateAndTime': {
        const d = new Date()
        return soap(
          res,
          '<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:TimeZone><tt:TZ>IST-5:30</tt:TZ></tt:TimeZone>' +
            `<tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>` +
            `<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime>` +
            '</tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>',
        )
      }
      case 'GetDeviceInformation':
        return soap(
          res,
          `<tds:GetDeviceInformationResponse><tds:Manufacturer>tp-link</tds:Manufacturer><tds:Model>Tapo C200</tds:Model><tds:FirmwareVersion>1.3.9 Build 231019 Rel.36348n</tds:FirmwareVersion><tds:SerialNumber>${SERIAL}</tds:SerialNumber><tds:HardwareId>3.0</tds:HardwareId></tds:GetDeviceInformationResponse>`,
        )
      case 'GetServices':
        if (cam.capabilitiesOnly) return notSupported(res)
        return soap(
          res,
          '<tds:GetServicesResponse>' +
            service(NS_DEVICE, DEVICE_XADDR) +
            service(NS_MEDIA, SERVICE_XADDR) +
            service('http://www.onvif.org/ver10/events/wsdl', SERVICE_XADDR) +
            service('http://www.onvif.org/ver20/imaging/wsdl', SERVICE_XADDR) +
            (cam.fixed ? '' : service(NS_PTZ, SERVICE_XADDR)) +
            '</tds:GetServicesResponse>',
        )
      case 'GetCapabilities':
        return soap(
          res,
          '<tds:GetCapabilitiesResponse><tds:Capabilities>' +
            `<tt:Device><tt:XAddr>${DEVICE_XADDR}</tt:XAddr><tt:Network><tt:IPFilter>false</tt:IPFilter><tt:ZeroConfiguration>false</tt:ZeroConfiguration><tt:IPVersion6>false</tt:IPVersion6><tt:DynDNS>false</tt:DynDNS></tt:Network></tt:Device>` +
            `<tt:Events><tt:XAddr>${SERVICE_XADDR}</tt:XAddr><tt:WSSubscriptionPolicySupport>false</tt:WSSubscriptionPolicySupport><tt:WSPullPointSupport>true</tt:WSPullPointSupport></tt:Events>` +
            `<tt:Imaging><tt:XAddr>${SERVICE_XADDR}</tt:XAddr></tt:Imaging>` +
            `<tt:Media><tt:XAddr>${SERVICE_XADDR}</tt:XAddr><tt:StreamingCapabilities><tt:RTPMulticast>false</tt:RTPMulticast><tt:RTP_TCP>true</tt:RTP_TCP><tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP></tt:StreamingCapabilities></tt:Media>` +
            (cam.fixed ? '' : `<tt:PTZ><tt:XAddr>${SERVICE_XADDR}</tt:XAddr></tt:PTZ>`) +
            '</tds:Capabilities></tds:GetCapabilitiesResponse>',
        )
      case 'GetNetworkInterfaces':
        return soap(
          res,
          `<tds:GetNetworkInterfacesResponse><tds:NetworkInterfaces token="eth0"><tt:Enabled>true</tt:Enabled><tt:Info><tt:Name>eth0</tt:Name><tt:HwAddress>${MAC}</tt:HwAddress><tt:MTU>1500</tt:MTU></tt:Info>` +
            `<tt:IPv4><tt:Enabled>true</tt:Enabled><tt:Config><tt:FromDHCP><tt:Address>${LAN}</tt:Address><tt:PrefixLength>24</tt:PrefixLength></tt:FromDHCP><tt:DHCP>true</tt:DHCP></tt:Config></tt:IPv4></tds:NetworkInterfaces></tds:GetNetworkInterfacesResponse>`,
        )
      case 'SystemReboot':
        if (cam.noReboot) return notSupported(res)
        if (cam.rebootNotAllowed) return fault(res, 400, 'SOAP-ENV:Sender', ['ter:NotAuthorized'], 'Sender not Authorized')
        return soap(res, '<tds:SystemRebootResponse><tds:Message>Rebooting</tds:Message></tds:SystemRebootResponse>')
      default:
        // Includes GetDot11Capabilities, GetDot11Status, ScanAvailableDot11Networks, SetNetworkInterfaces.
        return notSupported(res)
    }
  }

  const shared = (op: string, req: RecordedRequest, res: http.ServerResponse): void => {
    const token = /<ProfileToken>([^<]*)<\/ProfileToken>/.exec(req.body)?.[1] ?? ''
    const ptzOps = ['ContinuousMove', 'Stop', 'GetPresets', 'GotoPreset', 'GetStatus']
    if (cam.fixed && ptzOps.includes(op)) return notSupported(res)
    switch (op) {
      case 'GetProfiles':
        return soap(res, '<trt:GetProfilesResponse>' + profile(cam, 'profile_1', 'mainStream', 1920, 1080) + profile(cam, 'profile_2', 'minorStream', 640, 360) + '</trt:GetProfilesResponse>')
      case 'GetStreamUri':
        if (!STREAM[token]) return fault(res, 400, 'SOAP-ENV:Sender', ['ter:InvalidArgVal', 'ter:NoProfile'], 'The requested profile token does not exist')
        return soap(
          res,
          `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>${STREAM[token]}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>`,
        )
      case 'GetSnapshotUri':
        if (!cam.stills) return notSupported(res)
        return soap(
          res,
          `<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://${LAN}:2020/onvif/snapshot</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetSnapshotUriResponse>`,
        )
      case 'ContinuousMove':
        if ((cam.noMoveTimeout && req.body.includes('<Timeout>')) || (cam.noZoom && req.body.includes('<Zoom '))) {
          return fault(res, 400, 'SOAP-ENV:Sender', ['ter:InvalidArgVal'], 'Argument Value Invalid')
        }
        return soap(res, '<tptz:ContinuousMoveResponse/>')
      case 'Stop':
        if (cam.stopGarbled) return send(res, 500, 'Internal Server Error')
        return soap(res, '<tptz:StopResponse/>')
      case 'GetPresets':
        return soap(res, cam.noPresets ? '<tptz:GetPresetsResponse/>' : PRESETS)
      case 'GotoPreset': {
        const preset = /<PresetToken>([^<]*)<\/PresetToken>/.exec(req.body)?.[1] ?? ''
        if (!['1', '2', '3'].includes(preset)) return fault(res, 400, 'SOAP-ENV:Sender', ['ter:InvalidArgVal', 'ter:NoToken'], 'The requested preset token does not exist')
        return soap(res, '<tptz:GotoPresetResponse/>')
      }
      case 'GetStatus':
        // Pan and tilt only: this camera has no zoom.
        return soap(
          res,
          '<tptz:GetStatusResponse><tptz:PTZStatus><tt:Position><tt:PanTilt x="0.25" y="-0.1" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/></tt:Position>' +
            '<tt:MoveStatus><tt:PanTilt>IDLE</tt:PanTilt></tt:MoveStatus><tt:UtcTime>2026-10-01T09:12:04Z</tt:UtcTime></tptz:PTZStatus></tptz:GetStatusResponse>',
        )
      default:
        return notSupported(res)
    }
  }

  return (req, res) => {
    if (req.method === 'GET') {
      if (req.path !== '/onvif/snapshot' || !cam.stills) return send(res, 404, 'Not Found')
      if (!stillsGuard(req, res)) return
      return send(res, 200, TINY_JPEG, 'image/jpeg')
    }
    if (req.path !== '/onvif/device_service' && req.path !== '/onvif/service') return send(res, 404, 'Not Found')
    const op = opOf(req)
    if (!preAuth.has(op) && !wsseOk(req.body, cam)) {
      if (cam.bare401) {
        res.writeHead(401)
        res.end()
        return
      }
      return fault(res, 400, 'SOAP-ENV:Sender', ['ter:NotAuthorized'], 'Sender not Authorized')
    }
    if (req.path === '/onvif/device_service') return device(op, res)
    return shared(op, req, res)
  }
}

// ---------------------------------------------------------------------------

const USER = 'hubcamera'
const PASS = 'S3cret/p@ss'
const LOGIN = 'hubcamera:S3cret%2Fp%40ss@'

let server: MockServer | null = null
afterEach(async () => {
  resetTapoSessions()
  resetOnvifSessions()
  await server?.close()
  server = null
})

/** Wait (up to 3 s) for something the hub does on a timer. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 150 && !check(); i++) await sleep(20)
}

async function start(cam: Partial<Tapo> = {}): Promise<MockServer> {
  server = await mockServer(tapoCamera({ username: USER, password: PASS, ...cam }))
  return server
}

/** The mock listens on a random port, so the "control port" setting points at it. */
function ctxFor(s: MockServer, config: Record<string, unknown> = {}, path: Parameters<typeof makeCtx>[0]['path'] = {}) {
  return makeCtx({ family: 'tapo', config: { username: USER, password: PASS, onvifPort: s.port, ...config }, path })
}

describe('tapo adapter', () => {
  // --------------------------------------------------------------- describe

  it('describes itself for the add-device form', () => {
    expect(adapter.family).toBe('tapo')
    const d = adapter.describe()
    expect(d.id).toBe('tapo')
    expect(d.label).toBe('TP-Link Tapo camera')
    expect(d.kinds).toEqual(['camera'])
    expect(d.pathKinds).toEqual(['lan'])
    expect(d.defaultPort).toBeNull()
    expect(d.fields.map((f) => f.name)).toEqual(['username', 'password', 'onvifPort', 'rtspPort', 'ptz', 'cloudPassword'])
    const field = (name: string) => d.fields.find((f) => f.name === name)!
    expect(field('username').required).toBe(true)
    expect(field('username').help).toMatch(/Advanced Settings > Camera Account/)
    expect(field('password')).toMatchObject({ type: 'password', secret: true, required: true })
    expect(field('onvifPort')).toMatchObject({ type: 'number', default: 2020 })
    expect(field('rtspPort')).toMatchObject({ type: 'number', default: 554 })
    expect(field('ptz')).toMatchObject({ type: 'toggle', default: true })
    expect(field('cloudPassword')).toMatchObject({ type: 'password', secret: true })
    expect(field('cloudPassword').required).toBeFalsy()
    expect(field('cloudPassword').help).toMatch(/not the Camera Account/)
    // Every field explains itself.
    for (const f of d.fields) expect(f.help, f.name).toBeTruthy()
    expect(d.capabilities).toEqual(['stream', 'snapshot', 'ptz', 'presets', 'reboot', 'state'])
  })

  it('tells the owner honestly what works, what does not, and where other brands go', () => {
    const notes = adapter.describe().notes
    const all = notes.join('\n')
    expect(all).toMatch(/Advanced Settings > Camera Account/)
    expect(all).toMatch(/Third-Party Compatibility must be switched on/)
    expect(all).toMatch(/stops by itself after 30 seconds/)
    // WiFi cannot be changed by a third party: said plainly, with where to do it.
    expect(notes.filter((n) => /WiFi of a Tapo camera cannot be changed from here/.test(n) && /use the Tapo app for that step/.test(n))).toHaveLength(1)
    expect(all).toMatch(/three local video connections/)
    expect(all).toMatch(/C501GW, TC40GW.*network cable/)
    // One line each for the other brands, pointing at the right family.
    const one = (re: RegExp) => notes.filter((n) => re.test(n))
    expect(one(/^EZVIZ/)).toHaveLength(1)
    expect(one(/^EZVIZ/)[0]).toMatch(/"Camera by stream address".*verification code.*password.*"ONVIF camera"/)
    // That family's ready-made address is a Tapo-style /stream1; an EZVIZ needs its own.
    expect(one(/^EZVIZ/)[0]).toContain('rtsp://{user}:{pass}@{host}:{port}/ch1/main')
    expect(one(/^ICSee \/ XMEye/)).toHaveLength(1)
    expect(one(/^ICSee \/ XMEye/)[0]).toMatch(/"Camera by stream address" with a dvrip:\/\/ address/)
    expect(one(/^V380/)).toHaveLength(1)
    expect(one(/^V380/)[0]).toMatch(/only if yours offers ONVIF or RTSP/)
    expect(JSON.stringify(adapter.describe())).not.toMatch(/\b(demo|prototype|placeholder|stub|todo)\b/i)
  })

  it('works out capabilities from the turning switch and never claims WiFi control', () => {
    expect(adapter.capabilities({}, 'camera')).toEqual(['stream', 'snapshot', 'reboot', 'state', 'ptz', 'presets'])
    expect(adapter.capabilities({ ptz: false }, 'camera')).toEqual(['stream', 'snapshot', 'reboot', 'state'])
    expect(adapter.capabilities({ ptz: 'false' }, 'camera')).toEqual(['stream', 'snapshot', 'reboot', 'state'])
    for (const config of [{}, { wifi: true }, { ptz: false, wifi: true }]) {
      expect(adapter.capabilities(config, 'camera')).not.toContain('wifi')
      expect(adapter.capabilities(config, 'camera')).not.toContain('wifi-scan')
    }
    expect(adapter.describe().capabilities).not.toContain('wifi')
    expect(adapter.setWifi).toBeUndefined()
    expect(adapter.scanWifi).toBeUndefined()
  })

  // ------------------------------------------------------------------ probe

  it('probes with the clock call, then a WS-Security login with the Camera Account', async () => {
    const s = await start()
    const res = await adapter.probe(ctxFor(s))
    expect(res.ok).toBe(true)
    expect(typeof res.latencyMs).toBe('number')
    expect(res.info).toEqual({ model: 'Tapo C200', firmware: '1.3.9 Build 231019 Rel.36348n', serial: SERIAL, hardwareId: '3.0' })

    expect(ops(s)).toEqual(['GetSystemDateAndTime', 'GetDeviceInformation'])
    const [clock, info] = s.requests
    expect(clock!.method).toBe('POST')
    expect(clock!.path).toBe('/onvif/device_service')
    expect(clock!.headers['content-type']).toBe('application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver10/device/wsdl/GetSystemDateAndTime"')
    expect(clock!.body).not.toContain('<Security')
    expect(payload(clock!)).toBe('<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>')

    expect(info!.method).toBe('POST')
    expect(info!.path).toBe('/onvif/device_service')
    expect(info!.headers['content-type']).toBe('application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation"')
    expect(info!.headers.authorization).toBeUndefined()
    expect(payload(info!)).toBe('<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>')
    expect(info!.body).toContain(`<UsernameToken><Username>${USER}</Username>`)
    expect(info!.body).toContain('<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">')
    expect(info!.body).toMatch(/<Nonce EncodingType="[^"]*#Base64Binary">[A-Za-z0-9+/=]+<\/Nonce>/)
    expect(info!.body).not.toContain(PASS)
    expect(JSON.stringify(res)).not.toContain(PASS)
  })

  it('uses the port typed on a connection in place of the control port setting', async () => {
    const s = await start()
    // The setting points nowhere useful; the connection's own port is the one that counts.
    const res = await adapter.probe(ctxFor(s, { onvifPort: 1 }, { port: s.port }))
    expect(res.ok).toBe(true)
    expect(res.info?.serial).toBe(SERIAL)
  })

  it('says so when the Camera Account password is wrong', async () => {
    const s = await start()
    const res = await adapter.probe(ctxFor(s, { password: 'nope-nope' }))
    expect(res.ok).toBe(false)
    expect(res.latencyMs).toBeNull()
    expect(res.error).toBe('Wrong username or password. Use the Camera Account made in the Tapo app, not your TP-Link email and password.')
    expect(JSON.stringify(res)).not.toContain('nope-nope')
  })

  it('says the same when the camera answers a wrong login with a bare HTTP 401', async () => {
    const s = await start({ bare401: true })
    const res = await adapter.probe(ctxFor(s, { password: 'nope-nope' }))
    expect(res).toEqual({ ok: false, latencyMs: null, error: 'Wrong username or password. Use the Camera Account made in the Tapo app, not your TP-Link email and password.' })
    await expect(adapter.readState!(ctxFor(s, { password: 'nope-nope' }))).rejects.toThrow(/^Wrong username or password/)
    // The right login still works on such a camera.
    expect((await adapter.probe(ctxFor(s))).ok).toBe(true)
  })

  it('does not keep knocking with a refused login, but tries a corrected one at once', async () => {
    const s = await start()
    expect((await adapter.probe(ctxFor(s, { password: 'nope-nope' }))).error).toMatch(/^Wrong username or password/)
    const tries = count(s, 'GetDeviceInformation')
    expect(tries).toBeGreaterThan(0)

    // Same wrong password again: the camera is only asked for its clock, not for a login.
    const again = await adapter.probe(ctxFor(s, { password: 'nope-nope' }))
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/^Wrong username or password\..*The hub tries this login again in 5 minutes, so the camera does not lock it out; a changed password is tried at once\.$/)
    expect(again.error).not.toContain('nope-nope')
    expect(count(s, 'GetDeviceInformation')).toBe(tries)
    expect(ops(s).at(-1)).toBe('GetSystemDateAndTime')

    // Commands and state reads are held back too, without a request to the camera.
    const before = s.requests.length
    const stop = await adapter.execute(ctxFor(s, { password: 'nope-nope' }), makeAction('ptz.stop'))
    expect(stop.ok).toBe(false)
    expect(stop.error).toMatch(/tries this login again in 5 minutes/)
    const reboot = await adapter.execute(ctxFor(s, { password: 'nope-nope' }), makeAction('reboot'))
    expect(reboot.ok).toBe(false)
    await expect(adapter.readState!(ctxFor(s, { password: 'nope-nope' }))).rejects.toThrow(/tries this login again/)
    await expect(adapter.snapshot!(ctxFor(s, { password: 'nope-nope' }))).rejects.toThrow(/tries this login again/)
    expect(s.requests.length).toBe(before)

    // The owner fixes the password: tried immediately.
    const fixed = await adapter.probe(ctxFor(s))
    expect(fixed.ok).toBe(true)
    expect(fixed.info?.serial).toBe(SERIAL)
  })

  it('asks for the Camera Account when none is entered, without trying a login', async () => {
    const s = await start()
    const res = await adapter.probe(ctxFor(s, { username: '', password: '' }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/^Enter the Camera Account username and password\..*Advanced Settings > Camera Account\.$/)
    expect(ops(s)).toEqual(['GetSystemDateAndTime'])
  })

  it('reports an unreachable camera in plain words', async () => {
    const s = await start()
    const port = s.port
    await s.close()
    server = null
    const refused = await adapter.probe(makeCtx({ family: 'tapo', config: { username: USER, password: PASS, onvifPort: port } }))
    expect(refused.ok).toBe(false)
    expect(refused.latencyMs).toBeNull()
    expect(refused.error).toMatch(/refused the connection/)
    // What to check on a Tapo when its control port is closed.
    expect(refused.error).toMatch(/Third-Party Compatibility is switched on.*Camera Account has been made/)
    expect(refused.error).not.toContain(PASS)

    // A camera that accepts the connection and then says nothing.
    server = await mockServer(() => undefined)
    const silent = await adapter.probe(makeCtx({ family: 'tapo', config: { username: USER, password: PASS, onvifPort: server.port }, timeoutMs: 250 }))
    expect(silent).toMatchObject({ ok: false, latencyMs: null, error: 'The camera at 127.0.0.1 did not answer in time' })

    const noHost = await adapter.probe(makeCtx({ family: 'tapo', config: { username: USER, password: PASS }, path: { host: '' } }))
    expect(noHost.ok).toBe(false)
    expect(noHost.error).toMatch(/No address set/)
  })

  it('recognises something that is not a Tapo camera', async () => {
    server = await mockServer((_req, res) => send(res, 404, '<html><body>Not Found</body></html>', 'text/html'))
    const res = await adapter.probe(makeCtx({ family: 'tapo', config: { username: USER, password: PASS, onvifPort: server.port } }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not the way a Tapo camera does.*a Tapo uses 2020/)
    await server.close()

    // A web page that answers 200 to everything (a router, another device) is not a camera either.
    resetOnvifSessions()
    resetTapoSessions()
    server = await mockServer((_req, res) => send(res, 200, '<html><body><h1>Welcome</h1></body></html>', 'text/html'))
    const page = await adapter.probe(makeCtx({ family: 'tapo', config: { username: USER, password: PASS, onvifPort: server.port } }))
    expect(page.ok).toBe(false)
    expect(page.error).toMatch(/not the way a Tapo camera does/)
    await server.close()

    // Half an answer: valid SOAP for the clock, then an identity reply with nothing in it.
    resetOnvifSessions()
    resetTapoSessions()
    const real = tapoCamera({ username: USER, password: PASS })
    server = await mockServer((req, res, raw) => (opOf(req) === 'GetDeviceInformation' ? soap(res, '<tds:GetDeviceInformationResponse/>') : real(req, res, raw)))
    const empty = await adapter.probe(makeCtx({ family: 'tapo', config: { username: USER, password: PASS, onvifPort: server.port } }))
    expect(empty.ok).toBe(false)
    expect(empty.error).toMatch(/not the way a Tapo camera does/)
  })

  it('gives a plain sentence, not a crash, when the camera drops the connection', async () => {
    server = await mockServer((_req, _res, raw) => {
      raw.socket.destroy()
    })
    const res = await adapter.probe(makeCtx({ family: 'tapo', config: { username: USER, password: PASS, onvifPort: server.port } }))
    expect(res.ok).toBe(false)
    expect(res.latencyMs).toBeNull()
    expect(res.error).toMatch(/closed the connection/)
    expect(res.error).not.toContain(PASS)
    await server.close()

    // Mid-command: the camera takes the question and hangs up, or never answers. Both are thrown,
    // so the hub can try the camera's other connection.
    resetOnvifSessions()
    resetTapoSessions()
    const real = tapoCamera({ username: USER, password: PASS })
    let mode: 'drop' | 'silent' = 'drop'
    server = await mockServer((req, res, raw) => {
      if (opOf(req) !== 'ContinuousMove' && opOf(req) !== 'SystemReboot') return real(req, res, raw)
      if (mode === 'drop') raw.socket.destroy()
    })
    const ctx = makeCtx({ family: 'tapo', config: { username: USER, password: PASS, onvifPort: server.port }, timeoutMs: 300 })
    await expect(adapter.execute(ctx, makeAction('ptz.move', { pan: 1 }))).rejects.toThrow(/closed the connection/)
    mode = 'silent'
    await expect(adapter.execute(ctx, makeAction('ptz.move', { pan: 1 }))).rejects.toThrow(/did not answer in time/)
    await expect(adapter.execute(ctx, makeAction('reboot'))).rejects.toThrow(/did not answer in time/)
    // Nothing was moved as far as the hub knows, so no Stop was armed.
    await sleep(60)
    expect(count(server, 'Stop')).toBe(0)
  })

  // ------------------------------------------------------------------ state

  it('reads identity, MAC address, saved positions and where the camera points', async () => {
    const s = await start()
    const state = await adapter.readState!(ctxFor(s))
    expect(state).toEqual({
      model: 'Tapo C200',
      firmware: '1.3.9 Build 231019 Rel.36348n',
      serial: SERIAL,
      hardwareId: '3.0',
      mac: MAC,
      presets: ['Gate', 'Driveway', '3'],
      ptz: { pan: 0.25, tilt: -0.1, zoom: 0 },
    })
    // A Tapo tells nothing about its WiFi over ONVIF, and the hub does not ask.
    expect(state).not.toHaveProperty('wifi')
    expect(ops(s).some((o) => /Dot11|SetNetworkInterfaces/.test(o))).toBe(false)
    expect(JSON.stringify(state)).not.toContain(PASS)

    // Media and movement calls go to the single address the camera reported, on OUR port.
    expect(last(s, 'GetServices').path).toBe('/onvif/device_service')
    expect(payload(last(s, 'GetServices'))).toBe('<GetServices xmlns="http://www.onvif.org/ver10/device/wsdl"><IncludeCapability>false</IncludeCapability></GetServices>')
    expect(last(s, 'GetNetworkInterfaces').path).toBe('/onvif/device_service')
    for (const op of ['GetProfiles', 'GetPresets', 'GetStatus']) expect(last(s, op).path, op).toBe('/onvif/service')
    expect(payload(last(s, 'GetProfiles'))).toBe('<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>')
    expect(payload(last(s, 'GetPresets'))).toBe('<GetPresets xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>profile_1</ProfileToken></GetPresets>')
    expect(payload(last(s, 'GetStatus'))).toBe('<GetStatus xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>profile_1</ProfileToken></GetStatus>')
    for (const r of s.requests.filter((x) => opOf(x) !== 'GetSystemDateAndTime')) expect(r.headers.host).toBe(`127.0.0.1:${s.port}`)
  })

  it('reads the service addresses from GetCapabilities when GetServices is not offered', async () => {
    const s = await start({ capabilitiesOnly: true })
    const state = await adapter.readState!(ctxFor(s))
    expect(state.presets).toEqual(['Gate', 'Driveway', '3'])
    expect(payload(last(s, 'GetCapabilities'))).toBe('<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>')
    expect(last(s, 'GetCapabilities').path).toBe('/onvif/device_service')
    expect(last(s, 'GetPresets').path).toBe('/onvif/service')
  })

  it('reads a fixed model without asking for positions it cannot have', async () => {
    const s = await start({ fixed: true })
    const state = await adapter.readState!(ctxFor(s))
    expect(state).toEqual({ model: 'Tapo C200', firmware: '1.3.9 Build 231019 Rel.36348n', serial: SERIAL, hardwareId: '3.0', mac: MAC })
    expect(count(s, 'GetPresets')).toBe(0)

    // With the switch off, the movement service is not even looked up.
    resetOnvifSessions()
    resetTapoSessions()
    const before = s.requests.length
    const off = await adapter.readState!(ctxFor(s, { ptz: false }))
    expect(off).toEqual(state)
    expect(s.requests.slice(before).map(opOf).sort()).toEqual(['GetDeviceInformation', 'GetNetworkInterfaces', 'GetSystemDateAndTime'])
  })

  it('throws when the camera cannot be reached while reading state, so the hub can fail over', async () => {
    const s = await start()
    const ctx = ctxFor(s)
    await s.close()
    server = null
    await expect(adapter.readState!(ctx)).rejects.toThrow(/refused the connection/)
  })

  // -------------------------------------------------------------------- PTZ

  it('turns the camera with a time limit, on the address the camera gave for movement', async () => {
    const s = await start()
    const res = await adapter.execute(ctxFor(s), makeAction('ptz.move', { pan: 0.5, tilt: 0 }))
    expect(res).toEqual({ ok: true, result: { stopsAfterSeconds: 30 } })

    const move = last(s, 'ContinuousMove')
    expect(move.method).toBe('POST')
    expect(move.path).toBe('/onvif/service')
    expect(move.headers['content-type']).toBe('application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver20/ptz/wsdl/ContinuousMove"')
    expect(payload(move)).toBe(
      `<ContinuousMove xmlns="${NS_PTZ}"><ProfileToken>profile_1</ProfileToken><Velocity><PanTilt x="0.5" y="0" xmlns="${NS_SCHEMA}"/></Velocity><Timeout>PT30S</Timeout></ContinuousMove>`,
    )
    // No zoom element for a camera that has no zoom.
    expect(move.body).not.toContain('<Zoom')
    expect(move.body).not.toContain(PASS)
  })

  it('clamps the speed, caps the time limit and stops the camera itself when the time is up', async () => {
    const s = await start()
    const long = await adapter.execute(ctxFor(s), makeAction('ptz.move', { pan: -3, tilt: 0.25, seconds: 500 }))
    expect(long).toEqual({ ok: true, result: { stopsAfterSeconds: 60 } })
    expect(payload(last(s, 'ContinuousMove'))).toBe(
      `<ContinuousMove xmlns="${NS_PTZ}"><ProfileToken>profile_1</ProfileToken><Velocity><PanTilt x="-1" y="0.25" xmlns="${NS_SCHEMA}"/></Velocity><Timeout>PT60S</Timeout></ContinuousMove>`,
    )
    expect(count(s, 'Stop')).toBe(0)

    // A short nudge: the hub sends Stop itself once the time has passed, whatever the camera does.
    const nudge = await adapter.execute(ctxFor(s), makeAction('ptz.move', { tilt: 1, seconds: 0.2 }))
    expect(nudge).toEqual({ ok: true, result: { stopsAfterSeconds: 0.2 } })
    expect(payload(last(s, 'ContinuousMove'))).toContain(`<PanTilt x="0" y="1" xmlns="${NS_SCHEMA}"/></Velocity><Timeout>PT1S</Timeout>`)
    await until(() => count(s, 'Stop') > 0)
    expect(count(s, 'Stop')).toBe(1)
  })

  it('still turns a camera that will not take a time limit, and stops it from the hub', async () => {
    const s = await start({ noMoveTimeout: true })
    const res = await adapter.execute(ctxFor(s), makeAction('ptz.move', { pan: 1, seconds: 0.2 }))
    expect(res).toEqual({ ok: true, result: { stopsAfterSeconds: 0.2 } })
    const moves = s.requests.filter((r) => opOf(r) === 'ContinuousMove').map(payload)
    expect(moves).toEqual([
      `<ContinuousMove xmlns="${NS_PTZ}"><ProfileToken>profile_1</ProfileToken><Velocity><PanTilt x="1" y="0" xmlns="${NS_SCHEMA}"/></Velocity><Timeout>PT1S</Timeout></ContinuousMove>`,
      `<ContinuousMove xmlns="${NS_PTZ}"><ProfileToken>profile_1</ProfileToken><Velocity><PanTilt x="1" y="0" xmlns="${NS_SCHEMA}"/></Velocity></ContinuousMove>`,
    ])
    await until(() => count(s, 'Stop') > 0)
    expect(count(s, 'Stop')).toBe(1)

    // Remembered: the next move goes out once, without the limit.
    expect((await adapter.execute(ctxFor(s), makeAction('ptz.move', { pan: -1, seconds: 0.2 }))).ok).toBe(true)
    expect(count(s, 'ContinuousMove')).toBe(3)
    expect(payload(last(s, 'ContinuousMove'))).not.toContain('<Timeout>')
    await until(() => count(s, 'Stop') > 1)
    expect(count(s, 'Stop')).toBe(2)
  })

  it('passes on the camera’s refusal when it cannot do the move at all', async () => {
    const s = await start({ noZoom: true })
    const res = await adapter.execute(ctxFor(s), makeAction('ptz.move', { zoom: 1 }))
    expect(res).toEqual({ ok: false, error: 'The camera refused turning: Argument Value Invalid' })
    expect(payload(last(s, 'ContinuousMove'))).toBe(`<ContinuousMove xmlns="${NS_PTZ}"><ProfileToken>profile_1</ProfileToken><Velocity><Zoom x="1" xmlns="${NS_SCHEMA}"/></Velocity></ContinuousMove>`)
    // Nothing is moving, so no Stop is armed.
    await sleep(60)
    expect(count(s, 'Stop')).toBe(0)
  })

  it('stops the camera', async () => {
    const s = await start()
    const res = await adapter.execute(ctxFor(s), makeAction('ptz.stop'))
    expect(res).toEqual({ ok: true })
    const stop = last(s, 'Stop')
    expect(stop.path).toBe('/onvif/service')
    expect(payload(stop)).toBe(`<Stop xmlns="${NS_PTZ}"><ProfileToken>profile_1</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>`)

    // A move with no speed at all is a stop.
    const still = await adapter.execute(ctxFor(s), makeAction('ptz.move', { pan: 0, tilt: 0, zoom: 0 }))
    expect(still).toEqual({ ok: true })
    expect(count(s, 'Stop')).toBe(2)
    expect(count(s, 'ContinuousMove')).toBe(0)
  })

  it('says so plainly when the camera answers a command with something that is not an answer', async () => {
    const s = await start({ stopGarbled: true })
    const res = await adapter.execute(ctxFor(s), makeAction('ptz.stop'))
    expect(res).toEqual({ ok: false, error: 'The camera gave an answer the hub could not read when it tried stopping. Try again. If it keeps happening, use the Tapo app for that.' })
    // The camera itself is fine: it is not held back or reported as something else.
    expect((await adapter.probe(ctxFor(s))).ok).toBe(true)
  })

  it('goes to a saved position by its name, its number or its id', async () => {
    const s = await start()
    const ctx = ctxFor(s)
    const byName = await adapter.execute(ctx, makeAction('ptz.preset', { preset: 'Driveway' }))
    expect(byName).toEqual({ ok: true, result: { preset: 'Driveway' } })
    const goto = last(s, 'GotoPreset')
    expect(goto.path).toBe('/onvif/service')
    expect(payload(goto)).toBe(`<GotoPreset xmlns="${NS_PTZ}"><ProfileToken>profile_1</ProfileToken><PresetToken>2</PresetToken></GotoPreset>`)

    // The unnamed third position is shown as "3".
    expect((await adapter.execute(ctx, makeAction('ptz.preset', { preset: 3 }))).ok).toBe(true)
    expect(payload(last(s, 'GotoPreset'))).toContain('<PresetToken>3</PresetToken>')

    expect((await adapter.execute(ctx, makeAction('ptz.preset', { preset: 'gate' }))).ok).toBe(true)
    expect(payload(last(s, 'GotoPreset'))).toContain('<PresetToken>1</PresetToken>')

    const sent = count(s, 'GotoPreset')
    const listed = count(s, 'GetPresets')
    const unknown = await adapter.execute(ctx, makeAction('ptz.preset', { preset: 'Roof' }))
    expect(unknown).toEqual({ ok: false, error: 'The camera has no saved position "Roof"' })
    // The list was read again first, in case the position had only just been saved in the Tapo app.
    expect(count(s, 'GetPresets')).toBe(listed + 1)
    const none = await adapter.execute(ctx, makeAction('ptz.preset', {}))
    expect(none).toEqual({ ok: false, error: 'No saved position chosen' })
    expect(count(s, 'GotoPreset')).toBe(sent)
  })

  it('says where to save positions when the camera has none', async () => {
    const s = await start({ noPresets: true })
    const res = await adapter.execute(ctxFor(s), makeAction('ptz.preset', { preset: '1' }))
    expect(res).toEqual({ ok: false, error: 'The camera lists no saved positions. Save one in the Tapo app first.' })
    expect(count(s, 'GotoPreset')).toBe(0)
    expect((await adapter.readState!(ctxFor(s))).presets).toEqual([])
  })

  it('refuses to turn when turning is switched off, without contacting the camera', async () => {
    const s = await start()
    for (const action of [makeAction('ptz.move', { pan: 1 }), makeAction('ptz.stop'), makeAction('ptz.preset', { preset: '1' })]) {
      const res = await adapter.execute(ctxFor(s, { ptz: false }), action)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/Turning is switched off for this camera/)
    }
    expect(s.requests).toHaveLength(0)
  })

  it('explains a fixed model instead of pretending to turn it', async () => {
    const s = await start({ fixed: true })
    const res = await adapter.execute(ctxFor(s), makeAction('ptz.move', { pan: 1 }))
    expect(res).toEqual({ ok: false, error: 'This Tapo model has no movement controls. Switch off "Camera can turn" in its settings.' })
    expect(count(s, 'ContinuousMove')).toBe(0)
  })

  it('returns a wrong login as a refusal and throws when the camera is unreachable', async () => {
    const s = await start()
    const wrong = await adapter.execute(ctxFor(s, { password: 'nope-nope' }), makeAction('ptz.move', { pan: 1 }))
    expect(wrong.ok).toBe(false)
    expect(wrong.error).toMatch(/^Wrong username or password/)
    expect(wrong.error).not.toContain('nope-nope')

    const ctx = ctxFor(s)
    await s.close()
    server = null
    resetOnvifSessions()
    await expect(adapter.execute(ctx, makeAction('ptz.move', { pan: 1 }))).rejects.toThrow(/refused the connection/)
    await expect(adapter.execute(ctx, makeAction('reboot'))).rejects.toThrow(/refused the connection/)
  })

  // ----------------------------------------------------------------- reboot

  it('restarts the camera', async () => {
    const s = await start()
    const res = await adapter.execute(ctxFor(s), makeAction('reboot'))
    expect(res).toEqual({ ok: true, result: { message: 'Rebooting' } })
    const reboot = last(s, 'SystemReboot')
    expect(reboot.method).toBe('POST')
    expect(reboot.path).toBe('/onvif/device_service')
    expect(reboot.headers['content-type']).toBe('application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver10/device/wsdl/SystemReboot"')
    expect(payload(reboot)).toBe('<SystemReboot xmlns="http://www.onvif.org/ver10/device/wsdl"/>')
    expect(reboot.body).toContain('<Security')
  })

  it('points to the Tapo app when a model will not restart on request', async () => {
    const s = await start({ noReboot: true })
    const res = await adapter.execute(ctxFor(s), makeAction('reboot'))
    expect(res).toEqual({ ok: false, error: 'This Tapo model does not allow restarting from the hub. Use the Tapo app for that.' })
  })

  it('does not mistake "this login may not restart the camera" for a wrong password', async () => {
    const s = await start({ rebootNotAllowed: true })
    const ctx = ctxFor(s)
    expect((await adapter.probe(ctx)).ok).toBe(true)
    const res = await adapter.execute(ctx, makeAction('reboot'))
    expect(res).toEqual({ ok: false, error: 'This Tapo model does not allow restarting from the hub. Use the Tapo app for that.' })
    // The identity call was asked once to tell the two apart.
    expect(ops(s).at(-1)).toBe('GetDeviceInformation')

    // The login is fine, so nothing is held back: the camera stays reachable and still turns.
    const probe = await adapter.probe(ctx)
    expect(probe.ok).toBe(true)
    expect(probe.info?.serial).toBe(SERIAL)
    expect((await adapter.readState!(ctx)).presets).toEqual(['Gate', 'Driveway', '3'])
    expect((await adapter.execute(ctx, makeAction('ptz.move', { pan: 1, seconds: 0.2 }))).ok).toBe(true)
    await until(() => count(s, 'Stop') > 0)
  })

  // ------------------------------------------------------------ unsupported

  it('refuses what a camera cannot do, without contacting it', async () => {
    const s = await start()
    const ctx = ctxFor(s)
    for (const type of ['power.on', 'power.off', 'power.toggle', 'dim.set', 'color.set', 'gate.open', 'gate.close', 'gate.stop', 'gate.pulse', 'sms.send', 'custom'] as const) {
      const res = await adapter.execute(ctx, makeAction(type, { brightness: 50, text: 'hi' }))
      expect(res, type).toEqual({ ok: false, error: `This device cannot do "${type}"` })
    }
    expect(s.requests).toHaveLength(0)
  })

  // --------------------------------------------------------------- snapshot

  it('fetches a still from the address the camera gives, on our port, with a digest login', async () => {
    const s = await start({ stills: true })
    const snap = await adapter.snapshot!(ctxFor(s))
    expect(snap.contentType).toBe('image/jpeg')
    expect(snap.body.equals(TINY_JPEG)).toBe(true)

    expect(last(s, 'GetSnapshotUri').path).toBe('/onvif/service')
    expect(payload(last(s, 'GetSnapshotUri'))).toBe('<GetSnapshotUri xmlns="http://www.onvif.org/ver10/media/wsdl"><ProfileToken>profile_1</ProfileToken></GetSnapshotUri>')
    const gets = s.requests.filter((r) => r.method === 'GET')
    // First the bare request, then the same one answered to the camera's digest challenge.
    expect(gets.map((r) => r.path)).toEqual(['/onvif/snapshot', '/onvif/snapshot'])
    expect(gets[0]!.headers.authorization).toBeUndefined()
    expect(gets[1]!.headers.authorization).toMatch(/^Digest username="hubcamera", realm="IP Camera", nonce="[0-9a-f]+", uri="\/onvif\/snapshot", response="[0-9a-f]{32}"/)
    expect(gets[1]!.headers.host).toBe(`127.0.0.1:${s.port}`)
    expect(gets[1]!.url).not.toContain(USER)
  })

  it('says the picture comes from the live video when the model hands out no stills, and does not keep asking', async () => {
    const s = await start()
    const ctx = ctxFor(s)
    await expect(adapter.snapshot!(ctx)).rejects.toThrow(/does not hand out still pictures by itself.*live video/)
    expect(count(s, 'GetSnapshotUri')).toBe(1)
    const before = s.requests.length
    await expect(adapter.snapshot!(ctx)).rejects.toThrow(/does not hand out still pictures by itself/)
    expect(s.requests.length).toBe(before)
  })

  it('falls back to the live video when the picture address refuses the Camera Account, and keeps the camera online', async () => {
    const s = await start({ stills: true, stillsPassword: 'another-login' })
    const ctx = ctxFor(s)
    await expect(adapter.snapshot!(ctx)).rejects.toThrow(/does not hand out still pictures by itself.*live video/)
    // Not asked again for a while...
    const before = s.requests.length
    await expect(adapter.snapshot!(ctx)).rejects.toThrow(/does not hand out still pictures by itself/)
    expect(s.requests.length).toBe(before)
    // ...and the login that works for everything else is not held back because of it.
    const probe = await adapter.probe(ctx)
    expect(probe.ok).toBe(true)
    expect((await adapter.execute(ctx, makeAction('ptz.stop'))).ok).toBe(true)
  })

  it('treats a picture address that serves a web page as no picture', async () => {
    const real = tapoCamera({ username: USER, password: PASS, stills: true })
    server = await mockServer((req, res, raw) => (req.method === 'GET' ? send(res, 200, '<html><body>Login</body></html>', 'text/html') : real(req, res, raw)))
    await expect(adapter.snapshot!(ctxFor(server))).rejects.toThrow(/does not hand out still pictures by itself/)
  })

  it('throws a plain sentence for a still when the camera is unreachable or the login is wrong', async () => {
    const s = await start({ stills: true })
    await expect(adapter.snapshot!(ctxFor(s, { password: 'nope-nope' }))).rejects.toThrow(/^Wrong username or password/)
    const ctx = ctxFor(s)
    await s.close()
    server = null
    resetOnvifSessions()
    await expect(adapter.snapshot!(ctx)).rejects.toThrow(/refused the connection/)
  })

  // ---------------------------------------------------------------- streams

  it('gives go2rtc the two documented video addresses, sharp one first, with the login encoded', () => {
    const ctx = makeCtx({ family: 'tapo', config: { username: USER, password: PASS }, path: { host: '192.168.1.71' } })
    expect(adapter.streamSources!(ctx)).toEqual([`rtsp://${LOGIN}192.168.1.71:554/stream1`, `rtsp://${LOGIN}192.168.1.71:554/stream2`])
  })

  it('builds the video addresses from the connection in use, never from the control port', () => {
    // The control port (setting or the connection's own) has nothing to do with the video port.
    const lanB = makeCtx({ family: 'tapo', config: { username: USER, password: PASS, onvifPort: 2021 }, path: { host: '10.0.0.44', port: 8020 } })
    expect(adapter.streamSources!(lanB)).toEqual([`rtsp://${LOGIN}10.0.0.44:554/stream1`, `rtsp://${LOGIN}10.0.0.44:554/stream2`])

    const moved = makeCtx({ family: 'tapo', config: { username: USER, password: PASS, rtspPort: 8554 }, path: { host: 'tapo-gate.local' } })
    expect(adapter.streamSources!(moved)).toEqual([`rtsp://${LOGIN}tapo-gate.local:8554/stream1`, `rtsp://${LOGIN}tapo-gate.local:8554/stream2`])

    // A video port set on one connection wins over the setting.
    const forwarded = makeCtx({ family: 'tapo', config: { username: USER, password: PASS, rtspPort: 8554 }, path: { host: '192.168.1.71', extra: { rtspPort: 10554 } } })
    expect(adapter.streamSources!(forwarded)[0]).toBe(`rtsp://${LOGIN}192.168.1.71:10554/stream1`)

    const v6 = makeCtx({ family: 'tapo', config: { username: USER, password: PASS }, path: { host: 'fd00::71' } })
    expect(adapter.streamSources!(v6)[0]).toBe(`rtsp://${LOGIN}[fd00::71]:554/stream1`)

    const junk = makeCtx({ family: 'tapo', config: { username: USER, password: PASS, rtspPort: 'abc' }, path: { host: '192.168.1.71' } })
    expect(adapter.streamSources!(junk)[0]).toBe(`rtsp://${LOGIN}192.168.1.71:554/stream1`)

    expect(() => adapter.streamSources!(makeCtx({ family: 'tapo', config: { username: USER, password: PASS }, path: { host: '' } }))).toThrow(/No address set/)
  })

  it('adds go2rtc’s own Tapo source last, only when the TP-Link account password is filled in', () => {
    const without = makeCtx({ family: 'tapo', config: { username: USER, password: PASS }, path: { host: '192.168.1.71' } })
    expect(adapter.streamSources!(without).some((u) => u.startsWith('tapo://'))).toBe(false)

    // tapo://{cloud password}@{ip}?subtype=0 — the cloud password alone, no username, and not the Camera Account.
    const withCloud = makeCtx({ family: 'tapo', config: { username: USER, password: PASS, cloudPassword: 'Cl0ud p@ss:w/rd' }, path: { host: '192.168.1.71' } })
    expect(adapter.streamSources!(withCloud)).toEqual([
      `rtsp://${LOGIN}192.168.1.71:554/stream1`,
      `rtsp://${LOGIN}192.168.1.71:554/stream2`,
      'tapo://Cl0ud%20p%40ss%3Aw%2Frd@192.168.1.71?subtype=0',
    ])
  })
})
