import crypto from 'node:crypto'
import type http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import adapter, { onvifClient, OnvifError, resetOnvifSessions } from '../../src/adapters/onvif.ts'
import { sleep } from '../../src/lib/http.ts'
import { logger } from '../../src/lib/log.ts'
import { digestGuard, makeAction, makeCtx, mockServer, send, TINY_JPEG, type MockHandler, type MockServer, type RecordedRequest } from '../helpers.ts'

// discover() imports ../discovery.ts on demand; keep the test off the real network.
vi.mock('../../src/discovery.ts', () => ({
  onvifProbe: vi.fn(async () => [
    { family: 'onvif', kind: 'camera', name: 'Front gate', host: '192.168.1.64', port: 80, detail: 'DS-2DE2A404IW-DE3 · /onvif/device_service', config: { username: '', password: '', onvifPath: '/onvif/device_service' } },
  ]),
}))

// ---------------------------------------------------------------------------
// A mock ONVIF camera. Payload shapes follow docs/protocols/onvif-generic.md
// (ONVIF WSDL element names, tds/trt/tr2/tptz/tt prefixes, SOAP 1.2 faults) and
// the two login styles real cameras use: WS-Security UsernameToken
// PasswordDigest, or HTTP 401 + Digest challenge.
// ---------------------------------------------------------------------------

const ENV_OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>\n<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:ter="http://www.onvif.org/ver10/error" ' +
  'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tr2="http://www.onvif.org/ver20/media/wsdl" ' +
  'xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><env:Body>'
const ENV_CLOSE = '</env:Body></env:Envelope>'

const LAN = '192.168.1.64'
const SERIAL = 'DS-2DE2A404IW-DE320210812AAWRG12345678'

interface Cam {
  auth: 'wsse' | 'digest'
  username: string
  password: string
  /** Camera clock minus real time. */
  clockOffsetMs?: number
  /** Old firmware: GetServices faults, only GetCapabilities works. */
  legacy?: boolean
  /** Profile T only: no Media1 service. */
  media2Only?: boolean
  /** Supports ONVIF WiFi (Dot11) configuration. */
  dot11?: boolean
  rebootNeeded?: boolean
  /** Faults ter:TimeoutNotSupported when ContinuousMove carries a Timeout. */
  rejectTimeout?: boolean
  snapshotUri?: string
  /** Replaces the GetNetworkInterfaces answer. */
  networkInterfaces?: string
  /** Acknowledges Stop with a SOAP envelope whose body is empty, instead of <StopResponse/>. */
  emptyStopBody?: boolean
  /** Holds one WiFi network at a time (Dot11Capabilities MultipleConfiguration = false). */
  singleWifi?: boolean
}

function soap(res: http.ServerResponse, inner: string, status = 200): void {
  send(res, status, ENV_OPEN + inner + ENV_CLOSE, 'application/soap+xml; charset=utf-8')
}

function fault(res: http.ServerResponse, status: number, code: string, subcodes: string[], reason: string): void {
  let sub = ''
  for (const s of [...subcodes].reverse()) sub = `<env:Subcode><env:Value>${s}</env:Value>${sub}</env:Subcode>`
  soap(res, `<env:Fault><env:Code><env:Value>${code}</env:Value>${sub}</env:Code><env:Reason><env:Text xml:lang="en">${reason}</env:Text></env:Reason></env:Fault>`, status)
}

function opOf(req: RecordedRequest): string {
  return /<(?:[\w-]+:)?Body[^>]*>\s*<(?:[\w-]+:)?([A-Za-z0-9]+)/.exec(req.body)?.[1] ?? ''
}

/** The operation element exactly as sent. */
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

function wsseOk(body: string, cam: Cam): boolean {
  const user = /<Username>([^<]*)<\/Username>/.exec(body)?.[1]
  const digest = /<Password Type="[^"]*#PasswordDigest">([^<]+)<\/Password>/.exec(body)?.[1]
  const nonce = /<Nonce EncodingType="[^"]*#Base64Binary">([^<]+)<\/Nonce>/.exec(body)?.[1]
  const created = /<Created[^>]*>([^<]+)<\/Created>/.exec(body)?.[1]
  if (!user || !digest || !nonce || !created) return false
  const expected = crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created + cam.password, 'utf8')]))
    .digest('base64')
  // Like a real camera: the timestamp has to be close to the CAMERA's clock.
  const skew = Math.abs(Date.parse(created) - (Date.now() + (cam.clockOffsetMs ?? 0)))
  return user === cam.username && digest === expected && Buffer.from(nonce, 'base64').length === 16 && skew < 5000
}

function service(ns: string, path: string): string {
  return `<tds:Service><tds:Namespace>${ns}</tds:Namespace><tds:XAddr>http://${LAN}${path}</tds:XAddr><tds:Version><tt:Major>17</tt:Major><tt:Minor>12</tt:Minor></tds:Version></tds:Service>`
}

function profile1(token: string, name: string, w: number, h: number): string {
  return (
    `<trt:Profiles token="${token}" fixed="true"><tt:Name>${name}</tt:Name>` +
    `<tt:VideoSourceConfiguration token="VideoSourceToken"><tt:Name>VideoSourceConfig</tt:Name><tt:UseCount>2</tt:UseCount><tt:SourceToken>VideoSource_1</tt:SourceToken><tt:Bounds x="0" y="0" width="2560" height="1440"/></tt:VideoSourceConfiguration>` +
    `<tt:VideoEncoderConfiguration token="VideoEncoderToken_${token}"><tt:Name>VideoEncoder</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>${w}</tt:Width><tt:Height>${h}</tt:Height></tt:Resolution><tt:Quality>3</tt:Quality>` +
    `<tt:RateControl><tt:FrameRateLimit>25</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>4096</tt:BitrateLimit></tt:RateControl></tt:VideoEncoderConfiguration>` +
    `<tt:PTZConfiguration token="PTZToken"><tt:Name>PTZ</tt:Name><tt:UseCount>2</tt:UseCount><tt:NodeToken>PTZNODETOKEN</tt:NodeToken><tt:DefaultPTZTimeout>PT300S</tt:DefaultPTZTimeout></tt:PTZConfiguration></trt:Profiles>`
  )
}

function profile2(token: string, name: string, w: number, h: number): string {
  return (
    `<tr2:Profiles token="${token}" fixed="true"><tr2:Name>${name}</tr2:Name><tr2:Configurations>` +
    `<tr2:VideoSource token="VideoSourceToken"><tt:Name>VideoSourceConfig</tt:Name><tt:UseCount>2</tt:UseCount><tt:SourceToken>VideoSource_1</tt:SourceToken><tt:Bounds x="0" y="0" width="2560" height="1440"/></tr2:VideoSource>` +
    `<tr2:VideoEncoder token="VideoEncoderToken_${token}" GovLength="50" Profile="Main"><tt:Name>VideoEncoder</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>H265</tt:Encoding><tt:Resolution><tt:Width>${w}</tt:Width><tt:Height>${h}</tt:Height></tt:Resolution><tt:Quality>3</tt:Quality></tr2:VideoEncoder>` +
    `<tr2:PTZ token="PTZToken"><tt:Name>PTZ</tt:Name><tt:UseCount>2</tt:UseCount><tt:NodeToken>PTZNODETOKEN</tt:NodeToken></tr2:PTZ></tr2:Configurations></tr2:Profiles>`
  )
}

const STREAM: Record<string, string> = {
  Profile_1: `rtsp://${LAN}:554/Streaming/Channels/101?transportmode=unicast&amp;profile=Profile_1`,
  Profile_2: `rtsp://${LAN}:554/Streaming/Channels/102?transportmode=unicast&amp;profile=Profile_2`,
}

const PRESETS =
  '<tptz:GetPresetsResponse>' +
  '<tptz:Preset token="1"><tt:Name>Gate</tt:Name><tt:PTZPosition><tt:PanTilt x="0.25" y="-0.1" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/><tt:Zoom x="0" space="http://www.onvif.org/ver10/tptz/ZoomSpaces/PositionGenericSpace"/></tt:PTZPosition></tptz:Preset>' +
  '<tptz:Preset token="2"><tt:Name>Driveway</tt:Name><tt:PTZPosition><tt:PanTilt x="-0.6" y="0.2" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/><tt:Zoom x="0.3" space="http://www.onvif.org/ver10/tptz/ZoomSpaces/PositionGenericSpace"/></tt:PTZPosition></tptz:Preset>' +
  '<tptz:Preset token="3"><tt:Name>Preset 3</tt:Name></tptz:Preset>' +
  '</tptz:GetPresetsResponse>'

const NETWORK_INTERFACES =
  '<tds:GetNetworkInterfacesResponse>' +
  '<tds:NetworkInterfaces token="eth0"><tt:Enabled>true</tt:Enabled><tt:Info><tt:Name>eth0</tt:Name><tt:HwAddress>44:19:b6:5a:1c:9e</tt:HwAddress><tt:MTU>1500</tt:MTU></tt:Info>' +
  '<tt:Link><tt:AdminSettings><tt:AutoNegotiation>true</tt:AutoNegotiation><tt:Speed>100</tt:Speed><tt:Duplex>Full</tt:Duplex></tt:AdminSettings><tt:OperSettings><tt:AutoNegotiation>true</tt:AutoNegotiation><tt:Speed>100</tt:Speed><tt:Duplex>Full</tt:Duplex></tt:OperSettings><tt:InterfaceType>6</tt:InterfaceType></tt:Link>' +
  `<tt:IPv4><tt:Enabled>true</tt:Enabled><tt:Config><tt:FromDHCP><tt:Address>${LAN}</tt:Address><tt:PrefixLength>24</tt:PrefixLength></tt:FromDHCP><tt:DHCP>true</tt:DHCP></tt:Config></tt:IPv4></tds:NetworkInterfaces>` +
  '<tds:NetworkInterfaces token="wlan0"><tt:Enabled>true</tt:Enabled><tt:Info><tt:Name>wlan0</tt:Name><tt:HwAddress>44:19:b6:5a:1c:9f</tt:HwAddress><tt:MTU>1500</tt:MTU></tt:Info>' +
  '<tt:IPv4><tt:Enabled>true</tt:Enabled><tt:Config><tt:FromDHCP><tt:Address>192.168.1.65</tt:Address><tt:PrefixLength>24</tt:PrefixLength></tt:FromDHCP><tt:DHCP>true</tt:DHCP></tt:Config></tt:IPv4>' +
  // SSID is hexBinary: 486F6D652057694669 = "Home WiFi". The key is never returned.
  '<tt:Extension><tt:InterfaceType>71</tt:InterfaceType><tt:Dot11><tt:SSID>486F6D652057694669</tt:SSID><tt:Mode>Infrastructure</tt:Mode><tt:Alias>wifi-home</tt:Alias><tt:Priority>5</tt:Priority><tt:Security><tt:Mode>PSK</tt:Mode><tt:Algorithm>CCMP</tt:Algorithm></tt:Security></tt:Dot11></tt:Extension>' +
  '</tds:NetworkInterfaces></tds:GetNetworkInterfacesResponse>'

// The same camera, but with the interface type under Link (the other place the schema has an
// InterfaceType) and no Extension at all.
const NETWORK_INTERFACES_TYPE_UNDER_LINK =
  '<tds:GetNetworkInterfacesResponse>' +
  '<tds:NetworkInterfaces token="eth0"><tt:Enabled>true</tt:Enabled><tt:Info><tt:Name>eth0</tt:Name><tt:HwAddress>44:19:b6:5a:1c:9e</tt:HwAddress><tt:MTU>1500</tt:MTU></tt:Info>' +
  '<tt:Link><tt:AdminSettings><tt:AutoNegotiation>true</tt:AutoNegotiation><tt:Speed>100</tt:Speed><tt:Duplex>Full</tt:Duplex></tt:AdminSettings><tt:OperSettings><tt:AutoNegotiation>true</tt:AutoNegotiation><tt:Speed>100</tt:Speed><tt:Duplex>Full</tt:Duplex></tt:OperSettings><tt:InterfaceType>6</tt:InterfaceType></tt:Link></tds:NetworkInterfaces>' +
  '<tds:NetworkInterfaces token="wlan0"><tt:Enabled>true</tt:Enabled><tt:Info><tt:Name>wlan0</tt:Name><tt:HwAddress>44:19:b6:5a:1c:9f</tt:HwAddress><tt:MTU>1500</tt:MTU></tt:Info>' +
  '<tt:Link><tt:AdminSettings><tt:AutoNegotiation>false</tt:AutoNegotiation><tt:Speed>54</tt:Speed><tt:Duplex>Half</tt:Duplex></tt:AdminSettings><tt:OperSettings><tt:AutoNegotiation>false</tt:AutoNegotiation><tt:Speed>54</tt:Speed><tt:Duplex>Half</tt:Duplex></tt:OperSettings><tt:InterfaceType>71</tt:InterfaceType></tt:Link></tds:NetworkInterfaces>' +
  '</tds:GetNetworkInterfacesResponse>'

const SCAN =
  '<tds:ScanAvailableDot11NetworksResponse>' +
  // "Backup WiFi", weak
  '<tds:Networks><tt:SSID>4261636B75702057694669</tt:SSID><tt:BSSID>a4:2b:b0:11:22:33</tt:BSSID><tt:AuthAndMangementSuite>PSK</tt:AuthAndMangementSuite><tt:PairCipher>CCMP</tt:PairCipher><tt:GroupCipher>CCMP</tt:GroupCipher><tt:SignalStrength>Bad</tt:SignalStrength></tds:Networks>' +
  // "Home WiFi", strong
  '<tds:Networks><tt:SSID>486F6D652057694669</tt:SSID><tt:BSSID>a4:2b:b0:44:55:66</tt:BSSID><tt:AuthAndMangementSuite>PSK</tt:AuthAndMangementSuite><tt:PairCipher>CCMP</tt:PairCipher><tt:PairCipher>TKIP</tt:PairCipher><tt:GroupCipher>TKIP</tt:GroupCipher><tt:SignalStrength>Very Good</tt:SignalStrength></tds:Networks>' +
  // "Home WiFi" again from a second access point, weaker
  '<tds:Networks><tt:SSID>486F6D652057694669</tt:SSID><tt:BSSID>a4:2b:b0:44:55:67</tt:BSSID><tt:AuthAndMangementSuite>PSK</tt:AuthAndMangementSuite><tt:PairCipher>CCMP</tt:PairCipher><tt:SignalStrength>Good</tt:SignalStrength></tds:Networks>' +
  // "JioFiber-Guest", open
  '<tds:Networks><tt:SSID>4A696F46696265722D4775657374</tt:SSID><tt:AuthAndMangementSuite>None</tt:AuthAndMangementSuite><tt:SignalStrength>Good</tt:SignalStrength></tds:Networks>' +
  '</tds:ScanAvailableDot11NetworksResponse>'

function onvifCamera(cam: Cam): MockHandler {
  const guard = digestGuard(cam.username, cam.password)
  const preAuth = new Set(['GetSystemDateAndTime', 'GetServices', 'GetCapabilities', 'GetServiceCapabilities'])
  const pad = (n: number) => String(n)

  const device = (op: string, req: RecordedRequest, res: http.ServerResponse): void => {
    switch (op) {
      case 'GetSystemDateAndTime': {
        const d = new Date(Date.now() + (cam.clockOffsetMs ?? 0))
        return soap(
          res,
          '<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:TimeZone><tt:TZ>IST-5:30</tt:TZ></tt:TimeZone>' +
            `<tt:UTCDateTime><tt:Time><tt:Hour>${pad(d.getUTCHours())}</tt:Hour><tt:Minute>${pad(d.getUTCMinutes())}</tt:Minute><tt:Second>${pad(d.getUTCSeconds())}</tt:Second></tt:Time>` +
            `<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${pad(d.getUTCMonth() + 1)}</tt:Month><tt:Day>${pad(d.getUTCDate())}</tt:Day></tt:Date></tt:UTCDateTime>` +
            '</tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>',
        )
      }
      case 'GetDeviceInformation':
        return soap(
          res,
          `<tds:GetDeviceInformationResponse><tds:Manufacturer>HIKVISION</tds:Manufacturer><tds:Model>DS-2DE2A404IW-DE3</tds:Model><tds:FirmwareVersion>V5.7.3 build 220315</tds:FirmwareVersion><tds:SerialNumber>${SERIAL}</tds:SerialNumber><tds:HardwareId>88</tds:HardwareId></tds:GetDeviceInformationResponse>`,
        )
      case 'GetServices':
        if (cam.legacy) return fault(res, 400, 'env:Sender', ['ter:ActionNotSupported'], 'Optional Action Not Implemented')
        return soap(
          res,
          '<tds:GetServicesResponse>' +
            service('http://www.onvif.org/ver10/device/wsdl', '/onvif/device_service') +
            (cam.media2Only ? '' : service('http://www.onvif.org/ver10/media/wsdl', '/onvif/Media')) +
            service('http://www.onvif.org/ver20/media/wsdl', '/onvif/Media2') +
            service('http://www.onvif.org/ver20/ptz/wsdl', '/onvif/PTZ') +
            service('http://www.onvif.org/ver20/imaging/wsdl', '/onvif/Imaging') +
            service('http://www.onvif.org/ver10/events/wsdl', '/onvif/Events') +
            '</tds:GetServicesResponse>',
        )
      case 'GetCapabilities':
        return soap(
          res,
          '<tds:GetCapabilitiesResponse><tds:Capabilities>' +
            `<tt:Device><tt:XAddr>http://${LAN}/onvif/device_service</tt:XAddr><tt:Network><tt:IPFilter>false</tt:IPFilter><tt:ZeroConfiguration>true</tt:ZeroConfiguration><tt:IPVersion6>false</tt:IPVersion6><tt:DynDNS>false</tt:DynDNS><tt:Extension><tt:Dot11Configuration>false</tt:Dot11Configuration></tt:Extension></tt:Network></tt:Device>` +
            `<tt:Events><tt:XAddr>http://${LAN}/onvif/Events</tt:XAddr><tt:WSSubscriptionPolicySupport>true</tt:WSSubscriptionPolicySupport><tt:WSPullPointSupport>true</tt:WSPullPointSupport></tt:Events>` +
            `<tt:Imaging><tt:XAddr>http://${LAN}/onvif/Imaging</tt:XAddr></tt:Imaging>` +
            `<tt:Media><tt:XAddr>http://${LAN}/onvif/Media</tt:XAddr><tt:StreamingCapabilities><tt:RTPMulticast>false</tt:RTPMulticast><tt:RTP_TCP>true</tt:RTP_TCP><tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP></tt:StreamingCapabilities></tt:Media>` +
            `<tt:PTZ><tt:XAddr>http://${LAN}/onvif/PTZ</tt:XAddr></tt:PTZ>` +
            '</tds:Capabilities></tds:GetCapabilitiesResponse>',
        )
      case 'GetServiceCapabilities':
        return soap(
          res,
          `<tds:GetServiceCapabilitiesResponse><tds:Capabilities><tds:Network IPFilter="false" ZeroConfiguration="true" IPVersion6="false" DynDNS="false" Dot11Configuration="${cam.dot11 ? 'true' : 'false'}" HostnameFromDHCP="false" NTP="1"/>` +
            '<tds:Security TLS1.2="true" OnboardKeyGeneration="false" UsernameToken="true" HttpDigest="true"/><tds:System DiscoveryResolve="false" DiscoveryBye="true" RemoteDiscovery="false" SystemBackup="false" SystemLogging="true" FirmwareUpgrade="false"/></tds:Capabilities></tds:GetServiceCapabilitiesResponse>',
        )
      case 'GetNetworkInterfaces':
        return soap(res, cam.networkInterfaces ?? NETWORK_INTERFACES)
      case 'GetDot11Capabilities':
        if (!cam.dot11) return fault(res, 400, 'env:Receiver', ['ter:ActionNotSupported', 'ter:InvalidDot11'], 'IEEE 802.11 configuration is not supported')
        return soap(
          res,
          `<tds:GetDot11CapabilitiesResponse><tds:Capabilities><tt:TKIP>true</tt:TKIP><tt:ScanAvailableNetworks>true</tt:ScanAvailableNetworks><tt:MultipleConfiguration>${cam.singleWifi ? 'false' : 'true'}</tt:MultipleConfiguration><tt:AdHocStationMode>false</tt:AdHocStationMode><tt:WEP>false</tt:WEP></tds:Capabilities></tds:GetDot11CapabilitiesResponse>`,
        )
      case 'GetDot11Status':
        if (!cam.dot11) return fault(res, 400, 'env:Receiver', ['ter:ActionNotSupported', 'ter:InvalidDot11'], 'IEEE 802.11 configuration is not supported')
        if (!req.body.includes('<InterfaceToken>wlan0</InterfaceToken>')) return fault(res, 400, 'env:Sender', ['ter:InvalidArgVal', 'ter:NotDot11'], 'The interface is not an IEEE 802.11 interface')
        return soap(
          res,
          '<tds:GetDot11StatusResponse><tds:Status><tt:SSID>486F6D652057694669</tt:SSID><tt:BSSID>a4:2b:b0:44:55:66</tt:BSSID><tt:PairCipher>CCMP</tt:PairCipher><tt:GroupCipher>CCMP</tt:GroupCipher><tt:SignalStrength>Good</tt:SignalStrength><tt:ActiveConfigAlias>wifi-home</tt:ActiveConfigAlias></tds:Status></tds:GetDot11StatusResponse>',
        )
      case 'ScanAvailableDot11Networks':
        if (!cam.dot11) return fault(res, 400, 'env:Receiver', ['ter:ActionNotSupported', 'ter:InvalidDot11'], 'IEEE 802.11 configuration is not supported')
        if (!req.body.includes('<InterfaceToken>wlan0</InterfaceToken>')) return fault(res, 400, 'env:Sender', ['ter:InvalidArgVal', 'ter:NotDot11'], 'The interface is not an IEEE 802.11 interface')
        return soap(res, SCAN)
      case 'SetNetworkInterfaces':
        if (!cam.dot11) return fault(res, 400, 'env:Sender', ['ter:InvalidArgVal', 'ter:InvalidDot11'], 'IEEE 802.11 configuration is not supported')
        return soap(res, `<tds:SetNetworkInterfacesResponse><tds:RebootNeeded>${cam.rebootNeeded ? 'true' : 'false'}</tds:RebootNeeded></tds:SetNetworkInterfacesResponse>`)
      case 'SystemReboot':
        return soap(res, '<tds:SystemRebootResponse><tds:Message>Rebooting in 30 seconds</tds:Message></tds:SystemRebootResponse>')
      default:
        return fault(res, 400, 'env:Sender', ['ter:ActionNotSupported'], 'Optional Action Not Implemented')
    }
  }

  const media = (op: string, req: RecordedRequest, res: http.ServerResponse): void => {
    const token = /<ProfileToken>([^<]*)<\/ProfileToken>/.exec(req.body)?.[1] ?? ''
    switch (op) {
      case 'GetProfiles':
        return soap(res, '<trt:GetProfilesResponse>' + profile1('Profile_1', 'mainStream', 2560, 1440) + profile1('Profile_2', 'subStream', 640, 360) + '</trt:GetProfilesResponse>')
      case 'GetStreamUri':
        if (!STREAM[token]) return fault(res, 400, 'env:Sender', ['ter:InvalidArgVal', 'ter:NoProfile'], 'The requested profile token does not exist')
        return soap(
          res,
          `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>${STREAM[token]}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT60S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>`,
        )
      case 'GetSnapshotUri':
        return soap(
          res,
          `<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>${cam.snapshotUri ?? `http://${LAN}/onvif-http/snapshot?${token}`}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT60S</tt:Timeout></trt:MediaUri></trt:GetSnapshotUriResponse>`,
        )
      default:
        return fault(res, 400, 'env:Sender', ['ter:ActionNotSupported'], 'Optional Action Not Implemented')
    }
  }

  const media2 = (op: string, req: RecordedRequest, res: http.ServerResponse): void => {
    const token = /<ProfileToken>([^<]*)<\/ProfileToken>/.exec(req.body)?.[1] ?? ''
    switch (op) {
      case 'GetProfiles':
        return soap(res, '<tr2:GetProfilesResponse>' + profile2('Profile_1', 'mainStream', 2560, 1440) + profile2('Profile_2', 'subStream', 640, 360) + '</tr2:GetProfilesResponse>')
      case 'GetStreamUri':
        return soap(res, `<tr2:GetStreamUriResponse><tr2:Uri>${STREAM[token] ?? ''}</tr2:Uri></tr2:GetStreamUriResponse>`)
      case 'GetSnapshotUri':
        return soap(res, `<tr2:GetSnapshotUriResponse><tr2:Uri>http://${LAN}/onvif-http/snapshot?${token}</tr2:Uri></tr2:GetSnapshotUriResponse>`)
      default:
        return fault(res, 400, 'env:Sender', ['ter:ActionNotSupported'], 'Optional Action Not Implemented')
    }
  }

  const ptz = (op: string, req: RecordedRequest, res: http.ServerResponse): void => {
    switch (op) {
      case 'ContinuousMove':
        if (cam.rejectTimeout && req.body.includes('<Timeout>')) return fault(res, 400, 'env:Sender', ['ter:InvalidArgVal', 'ter:TimeoutNotSupported'], 'The specified timeout argument is not within the supported timeout range')
        return soap(res, '<tptz:ContinuousMoveResponse/>')
      case 'Stop':
        return soap(res, cam.emptyStopBody ? '' : '<tptz:StopResponse/>')
      case 'GetPresets':
        return soap(res, PRESETS)
      case 'GotoPreset': {
        const preset = /<PresetToken>([^<]*)<\/PresetToken>/.exec(req.body)?.[1] ?? ''
        if (!['1', '2', '3'].includes(preset)) return fault(res, 400, 'env:Sender', ['ter:InvalidArgVal', 'ter:NoToken'], 'The requested preset token does not exist')
        return soap(res, '<tptz:GotoPresetResponse/>')
      }
      case 'GetStatus':
        return soap(
          res,
          '<tptz:GetStatusResponse><tptz:PTZStatus><tt:Position><tt:PanTilt x="0.25" y="-0.1" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/><tt:Zoom x="0.5" space="http://www.onvif.org/ver10/tptz/ZoomSpaces/PositionGenericSpace"/></tt:Position>' +
            '<tt:MoveStatus><tt:PanTilt>IDLE</tt:PanTilt><tt:Zoom>IDLE</tt:Zoom></tt:MoveStatus><tt:UtcTime>2026-10-01T09:12:04Z</tt:UtcTime></tptz:PTZStatus></tptz:GetStatusResponse>',
        )
      default:
        return fault(res, 400, 'env:Sender', ['ter:ActionNotSupported'], 'Optional Action Not Implemented')
    }
  }

  return (req, res) => {
    if (req.method === 'GET') {
      if (req.path !== '/onvif-http/snapshot') return send(res, 404, 'Not Found')
      // Stills are always behind HTTP digest, whatever the SOAP login style.
      if (!guard(req, res)) return
      return send(res, 200, TINY_JPEG, 'image/jpeg')
    }
    const routes: Record<string, (op: string, req: RecordedRequest, res: http.ServerResponse) => void> = {
      '/onvif/device_service': device,
      '/onvif/PTZ': ptz,
      '/onvif/Media2': media2,
      ...(cam.media2Only ? {} : { '/onvif/Media': media }),
    }
    const route = routes[req.path]
    if (!route) return send(res, 404, 'Not Found')
    const op = opOf(req)
    if (!preAuth.has(op)) {
      if (cam.auth === 'digest') {
        if (!guard(req, res)) return
      } else if (!wsseOk(req.body, cam)) {
        return fault(res, 400, 'env:Sender', ['ter:NotAuthorized'], 'Sender not Authorized')
      }
    }
    route(op, req, res)
  }
}

// ---------------------------------------------------------------------------

const USER = 'admin'
const PASS = 'p@ss/w0rd'
const LOGIN = 'admin:p%40ss%2Fw0rd@'

let server: MockServer | null = null
afterEach(async () => {
  resetOnvifSessions()
  await server?.close()
  server = null
})

/** Wait (up to 3 s) for something the hub does on a timer. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 150 && !check(); i++) await sleep(20)
}

async function start(cam: Partial<Cam> = {}): Promise<MockServer> {
  server = await mockServer(onvifCamera({ auth: 'wsse', username: USER, password: PASS, ...cam }))
  return server
}

function ctxFor(s: MockServer, config: Record<string, unknown> = {}, path: Parameters<typeof makeCtx>[0]['path'] = {}) {
  return makeCtx({ family: 'onvif', config: { username: USER, password: PASS, ...config }, path: { port: s.port, ...path } })
}

describe('onvif adapter', () => {
  it('describes itself for the add-device form', () => {
    const d = adapter.describe()
    expect(d.id).toBe('onvif')
    expect(d.kinds).toEqual(['camera'])
    expect(d.pathKinds).toEqual(['lan', 'cellular'])
    expect(d.defaultPort).toBe(80)
    expect(d.fields.map((f) => f.name)).toEqual(['username', 'password', 'onvifPath', 'ptz', 'wifi'])
    expect(d.fields.find((f) => f.name === 'password')?.secret).toBe(true)
    expect(d.fields.find((f) => f.name === 'onvifPath')?.default).toBe('/onvif/device_service')
    expect(d.fields.find((f) => f.name === 'ptz')?.default).toBe(true)
    const wifi = d.fields.find((f) => f.name === 'wifi')
    expect(wifi?.default).toBe(false)
    expect(wifi?.help).toMatch(/few cameras/i)
    expect(d.notes.length).toBeGreaterThan(2)
    expect(d.notes.join(' ')).toMatch(/stops by itself after 30 seconds/)
    expect(d.capabilities).toEqual(['stream', 'snapshot', 'ptz', 'presets', 'wifi', 'wifi-scan', 'reboot', 'state'])
    expect(JSON.stringify(d)).not.toMatch(/\b(demo|prototype|placeholder|stub|todo)\b/i)
  })

  it('works out capabilities from the two switches', () => {
    expect(adapter.capabilities({}, 'camera')).toEqual(['stream', 'snapshot', 'reboot', 'state', 'ptz', 'presets'])
    expect(adapter.capabilities({ ptz: false }, 'camera')).toEqual(['stream', 'snapshot', 'reboot', 'state'])
    expect(adapter.capabilities({ ptz: false, wifi: true }, 'camera')).toEqual(['stream', 'snapshot', 'reboot', 'state', 'wifi', 'wifi-scan'])
  })

  // ------------------------------------------------------------------ probe

  it('probes with the clock call first, then a WS-Security login on the camera clock', async () => {
    // A camera whose clock is three hours ahead: the token must carry ITS time.
    const s = await start({ clockOffsetMs: 3 * 3600_000 })
    const res = await adapter.probe(ctxFor(s))
    expect(res.ok).toBe(true)
    expect(typeof res.latencyMs).toBe('number')
    expect(res.info).toEqual({ model: 'HIKVISION DS-2DE2A404IW-DE3', firmware: 'V5.7.3 build 220315', serial: SERIAL, hardwareId: '88' })

    expect(ops(s)).toEqual(['GetSystemDateAndTime', 'GetDeviceInformation'])
    const [clock, info] = s.requests
    expect(clock!.method).toBe('POST')
    expect(clock!.path).toBe('/onvif/device_service')
    expect(clock!.headers['content-type']).toBe('application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver10/device/wsdl/GetSystemDateAndTime"')
    expect(clock!.headers['content-length']).toBe(String(Buffer.byteLength(clock!.body)))
    expect(clock!.body).not.toContain('<Security')
    expect(payload(clock!)).toBe('<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>')
    expect(clock!.body.startsWith('<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"')).toBe(true)
    expect(clock!.body).not.toMatch(/>\s+</)

    expect(info!.path).toBe('/onvif/device_service')
    expect(info!.headers['content-type']).toBe('application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation"')
    expect(info!.headers.authorization).toBeUndefined()
    expect(payload(info!)).toBe('<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>')
    expect(info!.body).toContain('<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>admin</Username>')
    expect(info!.body).toContain('<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">')
    expect(info!.body).not.toContain(PASS)
  })

  it('says so when the password is wrong (WS-Security camera)', async () => {
    const s = await start()
    const res = await adapter.probe(ctxFor(s, { password: 'nope' }))
    expect(res).toMatchObject({ ok: false, error: 'Wrong username or password' })
    expect(JSON.stringify(res)).not.toContain('nope')
  })

  it('does not keep knocking with a refused login, but tries a corrected one at once', async () => {
    const s = await start()
    expect((await adapter.probe(ctxFor(s, { password: 'nope' }))).error).toBe('Wrong username or password')
    const tries = ops(s).filter((o) => o === 'GetDeviceInformation').length
    expect(tries).toBeGreaterThan(0)

    // Same wrong password again: the camera is only asked for its clock (is it there?), not for a login.
    const again = await adapter.probe(ctxFor(s, { password: 'nope' }))
    expect(again.ok).toBe(false)
    expect(again.error).toBe('Wrong username or password. The hub tries this login again in 5 minutes, so the camera does not lock it out; a changed password is tried at once.')
    expect(again.error).not.toContain('nope')
    expect(ops(s).filter((o) => o === 'GetDeviceInformation')).toHaveLength(tries)
    expect(ops(s).at(-1)).toBe('GetSystemDateAndTime')

    // The owner fixes the password: tried immediately.
    const fixed = await adapter.probe(ctxFor(s))
    expect(fixed.ok).toBe(true)
    expect(fixed.info?.serial).toBe(SERIAL)
  })

  it('asks for a login when none is set', async () => {
    const s = await start()
    const res = await adapter.probe(ctxFor(s, { username: '', password: '' }))
    expect(res).toMatchObject({ ok: false, error: 'This camera needs a username and password' })
  })

  it('falls back to HTTP digest when the camera answers 401, and remembers it', async () => {
    const s = await start({ auth: 'digest' })
    const ctx = ctxFor(s)
    const res = await adapter.probe(ctx)
    expect(res.ok).toBe(true)
    expect(res.info?.serial).toBe(SERIAL)

    expect(ops(s)).toEqual(['GetSystemDateAndTime', 'GetDeviceInformation', 'GetDeviceInformation', 'GetDeviceInformation'])
    const [, token, challenge, digest] = s.requests
    expect(token!.body).toContain('<Security')
    // After the 401 the WS-Security header is dropped: never both kinds of credentials at once.
    expect(challenge!.body).not.toContain('<Security')
    expect(challenge!.headers.authorization).toBeUndefined()
    expect(digest!.body).not.toContain('<Security')
    expect(digest!.headers.authorization).toMatch(/^Digest username="admin", realm="IP Camera", nonce="[0-9a-f]+", uri="\/onvif\/device_service", response="[0-9a-f]{32}"/)
    expect(digest!.headers['content-type']).toBe('application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation"')

    // Later calls go straight to digest: no WS-Security attempt any more.
    const before = s.requests.length
    const stop = await adapter.execute(ctx, makeAction('ptz.stop'))
    expect(stop.ok).toBe(true)
    expect(s.requests.slice(before).some((r) => r.body.includes('<Security'))).toBe(false)
    expect(last(s, 'Stop').headers.authorization).toMatch(/^Digest /)
  })

  it('says so when the password is wrong (digest camera)', async () => {
    const s = await start({ auth: 'digest' })
    const res = await adapter.probe(ctxFor(s, { password: 'nope' }))
    expect(res).toMatchObject({ ok: false, error: 'Wrong username or password' })
  })

  it('reports an unreachable camera in plain words', async () => {
    const s = await start()
    const port = s.port
    await s.close()
    server = null
    const refused = await adapter.probe(makeCtx({ family: 'onvif', config: { username: USER, password: PASS }, path: { port } }))
    expect(refused.ok).toBe(false)
    expect(refused.latencyMs).toBeNull()
    expect(refused.error).toMatch(/refused the connection|did not answer/)

    // A camera that accepts the connection and then says nothing.
    server = await mockServer(() => undefined)
    const silent = await adapter.probe(makeCtx({ family: 'onvif', config: { username: USER, password: PASS }, path: { port: server.port }, timeoutMs: 250 }))
    expect(silent).toMatchObject({ ok: false, latencyMs: null, error: 'The camera at 127.0.0.1 did not answer in time' })

    const noHost = await adapter.probe(makeCtx({ family: 'onvif', config: { username: USER, password: PASS }, path: { host: '' } }))
    expect(noHost.ok).toBe(false)
    expect(noHost.error).toMatch(/No address set/)
  })

  it('tries HTTP digest when a camera answers the token with a bare HTTP 400', async () => {
    // Seen on some firmware: no SOAP fault for a WS-Security token, just "400 Bad Request".
    const inner = onvifCamera({ auth: 'digest', username: USER, password: PASS })
    server = await mockServer((req, res, raw) => {
      if (req.body.includes('<Security')) return send(res, 400, 'Bad Request')
      return inner(req, res, raw)
    })
    const res = await adapter.probe(ctxFor(server))
    expect(res.ok).toBe(true)
    expect(last(server, 'GetDeviceInformation').headers.authorization).toMatch(/^Digest /)
  })

  it('recognises something that is not an ONVIF camera', async () => {
    server = await mockServer((_req, res) => send(res, 404, '<html><body>Not Found</body></html>', 'text/html'))
    const res = await adapter.probe(makeCtx({ family: 'onvif', config: { username: USER, password: PASS }, path: { port: server.port } }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not as an ONVIF camera/)
  })

  it('does not take a web page, a cut-off answer or a foreign SOAP reply for a camera', async () => {
    const bodies: Array<[string, string]> = [
      ['<html><head><title>Router</title></head><body>Welcome</body></html>', 'text/html'],
      ['<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><tds:GetSystemDateAndTimeResp', 'application/soap+xml'],
      [ENV_OPEN + '<tds:GetHostnameResponse><tds:HostnameInformation><tt:FromDHCP>false</tt:FromDHCP></tds:HostnameInformation></tds:GetHostnameResponse>' + ENV_CLOSE, 'application/soap+xml'],
      ['', 'text/plain'],
      ['\u0000\u0001\u0002 not xml at all <<<', 'application/octet-stream'],
    ]
    for (const [body, type] of bodies) {
      resetOnvifSessions()
      await server?.close()
      server = await mockServer((_req, res) => send(res, 200, body, type))
      const res = await adapter.probe(makeCtx({ family: 'onvif', config: { username: USER, password: PASS }, path: { port: server.port } }))
      expect(res.ok, body.slice(0, 30)).toBe(false)
      expect(res.error).toMatch(/not as an ONVIF camera/)
      expect(res.info).toBeUndefined()
    }
  })

  it('reports a camera that drops the connection, and throws for commands so the hub can fail over', async () => {
    server = await mockServer((_req, _res, raw) => {
      raw.socket.destroy()
    })
    const ctx = makeCtx({ family: 'onvif', config: { username: USER, password: PASS }, path: { port: server.port } })
    const res = await adapter.probe(ctx)
    expect(res.ok).toBe(false)
    expect(res.latencyMs).toBeNull()
    expect(res.error).toMatch(/closed the connection/)
    expect(res.error).not.toContain(PASS)
    await expect(adapter.execute(ctx, makeAction('ptz.stop'))).rejects.toThrow(/closed the connection/)
    await expect(adapter.snapshot!(ctx)).rejects.toThrow(/closed the connection/)
  })

  it('throws a plain sentence when the camera is too slow to answer a command', async () => {
    server = await mockServer(() => undefined)
    const ctx = makeCtx({ family: 'onvif', config: { username: USER, password: PASS }, path: { port: server.port }, timeoutMs: 250 })
    await expect(adapter.execute(ctx, makeAction('reboot'))).rejects.toThrow('The camera at 127.0.0.1 did not answer in time')
    await expect(adapter.readState!(ctx)).rejects.toThrow('The camera at 127.0.0.1 did not answer in time')
    await expect(adapter.snapshot!(ctx)).rejects.toThrow('The camera at 127.0.0.1 did not answer in time')
  })

  it('explains an address that is not just an IP address or name', async () => {
    const res = await adapter.probe(makeCtx({ family: 'onvif', config: { username: USER, password: PASS }, path: { host: 'http://192.168.1.64 /cam' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/is not an address the hub can use/)
  })

  it('uses the ONVIF address path from the settings', async () => {
    server = await mockServer((req, res) => {
      if (req.path !== '/onvif/custom_device') return send(res, 404, 'Not Found')
      const inner = onvifCamera({ auth: 'wsse', username: USER, password: PASS })
      return inner({ ...req, path: '/onvif/device_service' }, res, undefined as never)
    })
    const res = await adapter.probe(ctxFor(server, { onvifPath: 'onvif/custom_device' }))
    expect(res.ok).toBe(true)
    expect(server.requests.every((r) => r.path === '/onvif/custom_device')).toBe(true)
  })

  // ------------------------------------------------- state, streams, stills

  it('reads state and resolves the video addresses onto the address in use', async () => {
    const s = await start()
    const ctx = ctxFor(s)

    // Before anything is known, go2rtc is handed the camera's ONVIF address.
    expect(adapter.streamSources!(ctx)).toEqual([`onvif://${LOGIN}127.0.0.1:${s.port}`])

    const state = await adapter.readState!(ctx)
    expect(state).toEqual({
      model: 'HIKVISION DS-2DE2A404IW-DE3',
      firmware: 'V5.7.3 build 220315',
      serial: SERIAL,
      hardwareId: '88',
      mac: '44:19:b6:5a:1c:9e',
      presets: ['Gate', 'Driveway', '3'],
      ptz: { pan: 0.25, tilt: -0.1, zoom: 0.5 },
    })

    // The camera reported http://192.168.1.64/onvif/...; only the paths were kept.
    const sent = s.requests.map((r) => `${r.path} ${opOf(r)}`)
    expect(sent.slice(0, 4)).toEqual(['/onvif/device_service GetSystemDateAndTime', '/onvif/device_service GetDeviceInformation', '/onvif/device_service GetServices', '/onvif/Media GetProfiles'])
    expect([...sent.slice(4)].sort()).toEqual(
      ['/onvif/Media GetStreamUri', '/onvif/Media GetStreamUri', '/onvif/PTZ GetPresets', '/onvif/PTZ GetStatus', '/onvif/device_service GetNetworkInterfaces'].sort(),
    )
    expect(payload(last(s, 'GetServices'))).toBe('<GetServices xmlns="http://www.onvif.org/ver10/device/wsdl"><IncludeCapability>false</IncludeCapability></GetServices>')
    expect(payload(last(s, 'GetProfiles'))).toBe('<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>')
    const streamCalls = s.requests.filter((r) => opOf(r) === 'GetStreamUri')
    expect(payload(streamCalls[0]!)).toBe(
      '<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl"><StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream><Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport></StreamSetup><ProfileToken>Profile_1</ProfileToken></GetStreamUri>',
    )
    expect(streamCalls[0]!.headers['content-type']).toBe('application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver10/media/wsdl/GetStreamUri"')
    expect(payload(streamCalls[1]!)).toContain('<ProfileToken>Profile_2</ProfileToken>')
    expect(payload(last(s, 'GetPresets'))).toBe('<GetPresets xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>Profile_1</ProfileToken></GetPresets>')

    // Main stream first, then the sub stream; login percent-encoded; LAN address replaced.
    expect(adapter.streamSources!(ctx)).toEqual([
      `rtsp://${LOGIN}127.0.0.1:554/Streaming/Channels/101?transportmode=unicast&profile=Profile_1`,
      `rtsp://${LOGIN}127.0.0.1:554/Streaming/Channels/102?transportmode=unicast&profile=Profile_2`,
    ])

    // A second read only asks for what can change.
    const before = s.requests.length
    await adapter.readState!(ctx)
    expect(ops(s).slice(before)).toEqual(['GetStatus'])
    expect(JSON.stringify(state)).not.toContain(PASS)
  })

  it('reports the WiFi network and signal when WiFi control is switched on', async () => {
    const s = await start({ dot11: true })
    const state = await adapter.readState!(ctxFor(s, { wifi: true, ptz: false }))
    expect(state.wifi).toBe('Home WiFi')
    expect(state.signal).toBe(70)
    expect(state.presets).toBeUndefined()
    expect(payload(last(s, 'GetDot11Status'))).toBe('<GetDot11Status xmlns="http://www.onvif.org/ver10/device/wsdl"><InterfaceToken>wlan0</InterfaceToken></GetDot11Status>')
    expect(ops(s)).not.toContain('GetPresets')
  })

  it('uses a per-connection video port on the SIM path', async () => {
    const s = await start()
    const ctx = ctxFor(s, {}, { kind: 'cellular', label: 'SIM', extra: { rtspPort: 10554 } })
    await adapter.readState!(ctx)
    expect(adapter.streamSources!(ctx)[0]).toBe(`rtsp://${LOGIN}127.0.0.1:10554/Streaming/Channels/101?transportmode=unicast&profile=Profile_1`)
  })

  it('uses GetCapabilities on cameras without GetServices', async () => {
    const s = await start({ legacy: true })
    const ctx = ctxFor(s)
    await adapter.readState!(ctx)
    expect(ops(s).slice(0, 5)).toEqual(['GetSystemDateAndTime', 'GetDeviceInformation', 'GetServices', 'GetCapabilities', 'GetProfiles'])
    expect(payload(last(s, 'GetCapabilities'))).toBe('<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>')
    expect(last(s, 'GetProfiles').path).toBe('/onvif/Media')
    expect(last(s, 'GetStatus').path).toBe('/onvif/PTZ')
    expect(adapter.streamSources!(ctx)).toHaveLength(2)
  })

  it('talks Media2 to a Profile T camera that has no Media1 service', async () => {
    const s = await start({ media2Only: true })
    const ctx = ctxFor(s)
    await adapter.readState!(ctx)
    const profiles = last(s, 'GetProfiles')
    expect(profiles.path).toBe('/onvif/Media2')
    expect(payload(profiles)).toBe('<GetProfiles xmlns="http://www.onvif.org/ver20/media/wsdl"><Type>All</Type></GetProfiles>')
    const stream = s.requests.find((r) => opOf(r) === 'GetStreamUri')!
    expect(stream.path).toBe('/onvif/Media2')
    expect(payload(stream)).toBe('<GetStreamUri xmlns="http://www.onvif.org/ver20/media/wsdl"><Protocol>RTSP</Protocol><ProfileToken>Profile_1</ProfileToken></GetStreamUri>')
    expect(adapter.streamSources!(ctx)).toEqual([
      `rtsp://${LOGIN}127.0.0.1:554/Streaming/Channels/101?transportmode=unicast&profile=Profile_1`,
      `rtsp://${LOGIN}127.0.0.1:554/Streaming/Channels/102?transportmode=unicast&profile=Profile_2`,
    ])
    const snap = await adapter.snapshot!(ctx)
    expect(snap.body.equals(TINY_JPEG)).toBe(true)
    expect(payload(last(s, 'GetSnapshotUri'))).toBe('<GetSnapshotUri xmlns="http://www.onvif.org/ver20/media/wsdl"><ProfileToken>Profile_1</ProfileToken></GetSnapshotUri>')
  })

  it('fetches a still: GetSnapshotUri, then the picture through HTTP digest', async () => {
    const s = await start()
    const ctx = ctxFor(s)
    const snap = await adapter.snapshot!(ctx)
    expect(snap.contentType).toBe('image/jpeg')
    expect(snap.body.equals(TINY_JPEG)).toBe(true)

    expect(payload(last(s, 'GetSnapshotUri'))).toBe('<GetSnapshotUri xmlns="http://www.onvif.org/ver10/media/wsdl"><ProfileToken>Profile_1</ProfileToken></GetSnapshotUri>')
    const gets = s.requests.filter((r) => r.method === 'GET')
    expect(gets).toHaveLength(2)
    expect(gets[0]!.url).toBe('/onvif-http/snapshot?Profile_1')
    expect(gets[0]!.headers.authorization).toBeUndefined()
    expect(gets[1]!.headers.authorization).toMatch(/^Digest username="admin"/)

    // The picture address is remembered: the next still is only the GET.
    const before = s.requests.length
    await adapter.snapshot!(ctx)
    expect(s.requests.slice(before).every((r) => r.method === 'GET')).toBe(true)
  })

  it('does not pass off a login page as a still picture', async () => {
    const inner = onvifCamera({ auth: 'wsse', username: USER, password: PASS })
    server = await mockServer((req, res, raw) => {
      if (req.method === 'GET') return send(res, 200, '<html><body><form action="/login">Please sign in</form></body></html>', 'text/html')
      return inner(req, res, raw)
    })
    const ctx = ctxFor(server)
    await expect(adapter.snapshot!(ctx)).rejects.toThrow('The camera answered the picture request with something that is not a picture')
    // The remembered picture address is dropped, so the next try asks the camera again.
    await expect(adapter.snapshot!(ctx)).rejects.toThrow(/not a picture/)
    expect(ops(server).filter((o) => o === 'GetSnapshotUri')).toHaveLength(2)
  })

  it('accepts a JPEG that the camera labels with the wrong content type', async () => {
    const inner = onvifCamera({ auth: 'wsse', username: USER, password: PASS })
    server = await mockServer((req, res, raw) => {
      if (req.method === 'GET') return send(res, 200, TINY_JPEG, 'application/octet-stream')
      return inner(req, res, raw)
    })
    const snap = await adapter.snapshot!(ctxFor(server))
    expect(snap.contentType).toBe('image/jpeg')
    expect(snap.body.equals(TINY_JPEG)).toBe(true)
  })

  it('refuses a still when the login is wrong', async () => {
    const s = await start({ auth: 'digest' })
    await expect(adapter.snapshot!(ctxFor(s, { password: 'nope' }))).rejects.toThrow(/refused the username or password/)
  })

  // -------------------------------------------------------------------- PTZ

  it('moves with ContinuousMove, sending only the axes that move', async () => {
    const s = await start()
    const ctx = ctxFor(s)
    // Exactly what the app sends when an arrow is pressed: no "seconds".
    const pan = await adapter.execute(ctx, makeAction('ptz.move', { pan: 0.5, tilt: 0, zoom: 0 }))
    expect(pan).toEqual({ ok: true, result: { stopsAfterSeconds: 30 } })
    const move = last(s, 'ContinuousMove')
    expect(move.method).toBe('POST')
    expect(move.path).toBe('/onvif/PTZ')
    expect(move.headers['content-type']).toBe('application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver20/ptz/wsdl/ContinuousMove"')
    expect(payload(move)).toBe(
      // The stop sent when the button is let go can get lost, so the camera is always given a limit of its own.
      '<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>Profile_1</ProfileToken><Velocity><PanTilt x="0.5" y="0" xmlns="http://www.onvif.org/ver10/schema"/></Velocity><Timeout>PT30S</Timeout></ContinuousMove>',
    )

    // Once the camera is known, a tap is a single request.
    const before = s.requests.length
    await adapter.execute(ctx, makeAction('ptz.move', { zoom: 1 }))
    expect(ops(s).slice(before)).toEqual(['ContinuousMove'])
    expect(payload(last(s, 'ContinuousMove'))).toBe(
      '<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>Profile_1</ProfileToken><Velocity><Zoom x="1" xmlns="http://www.onvif.org/ver10/schema"/></Velocity><Timeout>PT30S</Timeout></ContinuousMove>',
    )

    // Out-of-range values are clamped to -1..1.
    await adapter.execute(ctx, makeAction('ptz.move', { pan: -3, tilt: 0.25, zoom: -0.5 }))
    expect(payload(last(s, 'ContinuousMove'))).toContain('<Velocity><PanTilt x="-1" y="0.25" xmlns="http://www.onvif.org/ver10/schema"/><Zoom x="-0.5" xmlns="http://www.onvif.org/ver10/schema"/></Velocity>')

    // A longer limit can be asked for, up to a minute.
    const long = await adapter.execute(ctx, makeAction('ptz.move', { pan: 1, seconds: 600 }))
    expect(long).toEqual({ ok: true, result: { stopsAfterSeconds: 60 } })
    expect(payload(last(s, 'ContinuousMove'))).toContain('<Timeout>PT60S</Timeout>')
    expect(ops(s)).not.toContain('Stop')
  })

  it('accepts a camera that acknowledges with an empty SOAP body', async () => {
    const s = await start({ emptyStopBody: true })
    expect(await adapter.execute(ctxFor(s), makeAction('ptz.stop'))).toEqual({ ok: true })
    expect(last(s, 'Stop').path).toBe('/onvif/PTZ')
  })

  it('stops with Stop, and treats an all-zero move as a stop', async () => {
    const s = await start()
    const ctx = ctxFor(s)
    expect(await adapter.execute(ctx, makeAction('ptz.stop'))).toEqual({ ok: true })
    const stop = last(s, 'Stop')
    expect(stop.path).toBe('/onvif/PTZ')
    expect(payload(stop)).toBe('<Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>Profile_1</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>')

    const before = s.requests.length
    expect(await adapter.execute(ctx, makeAction('ptz.move', { pan: 0, tilt: 0, zoom: 0 }))).toEqual({ ok: true })
    expect(ops(s).slice(before)).toEqual(['Stop'])
    // Values that are not numbers count as "not moving" rather than reaching the camera.
    expect(await adapter.execute(ctx, makeAction('ptz.move', { pan: 'left', tilt: null }))).toEqual({ ok: true })
    expect(ops(s).slice(before)).toEqual(['Stop', 'Stop'])
  })

  it('stops by itself after params.seconds', async () => {
    const s = await start()
    const ctx = ctxFor(s)
    const res = await adapter.execute(ctx, makeAction('ptz.move', { pan: 1, seconds: 0.2 }))
    expect(res.ok).toBe(true)
    // The camera is given the limit too, in whole seconds…
    expect(payload(last(s, 'ContinuousMove'))).toBe(
      '<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>Profile_1</ProfileToken><Velocity><PanTilt x="1" y="0" xmlns="http://www.onvif.org/ver10/schema"/></Velocity><Timeout>PT1S</Timeout></ContinuousMove>',
    )
    expect(ops(s)).not.toContain('Stop')
    // …and the hub sends Stop itself, for cameras that ignore it.
    await until(() => ops(s).includes('Stop'))
    expect(ops(s).filter((o) => o === 'Stop')).toHaveLength(1)
    expect(payload(last(s, 'Stop'))).toContain('<ProfileToken>Profile_1</ProfileToken>')

    // A stop by hand cancels the pending one.
    await adapter.execute(ctx, makeAction('ptz.move', { tilt: 1, seconds: 0.2 }))
    await adapter.execute(ctx, makeAction('ptz.stop'))
    await sleep(500)
    expect(ops(s).filter((o) => o === 'Stop')).toHaveLength(2)
  })

  it('moves without a time limit when the camera rejects the limit', async () => {
    const s = await start({ rejectTimeout: true })
    const res = await adapter.execute(ctxFor(s), makeAction('ptz.move', { pan: 1, seconds: 0.2 }))
    expect(res.ok).toBe(true)
    const moves = s.requests.filter((r) => opOf(r) === 'ContinuousMove')
    expect(moves).toHaveLength(2)
    expect(moves[0]!.body).toContain('<Timeout>PT1S</Timeout>')
    expect(moves[1]!.body).not.toContain('<Timeout>')
    await until(() => ops(s).includes('Stop'))
    expect(ops(s).filter((o) => o === 'Stop')).toHaveLength(1)

    // That is remembered: the next press is one request, and the hub's own stop still guards it.
    const before = s.requests.length
    const next = await adapter.execute(ctxFor(s), makeAction('ptz.move', { tilt: -1 }))
    expect(next).toEqual({ ok: true, result: { stopsAfterSeconds: 30 } })
    expect(ops(s).slice(before)).toEqual(['ContinuousMove'])
    expect(last(s, 'ContinuousMove').body).not.toContain('<Timeout>')
  })

  it('goes to a preset by the name shown in the app', async () => {
    const s = await start()
    const ctx = ctxFor(s)
    const res = await adapter.execute(ctx, makeAction('ptz.preset', { preset: 'Driveway' }))
    expect(res).toEqual({ ok: true, result: { preset: 'Driveway' } })
    const go = last(s, 'GotoPreset')
    expect(go.path).toBe('/onvif/PTZ')
    expect(payload(go)).toBe('<GotoPreset xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>Profile_1</ProfileToken><PresetToken>2</PresetToken></GotoPreset>')

    // "Preset 3" is shown as 3; a number from the app works too.
    await adapter.execute(ctx, makeAction('ptz.preset', { preset: 3 }))
    expect(payload(last(s, 'GotoPreset'))).toContain('<PresetToken>3</PresetToken>')

    const missing = await adapter.execute(ctx, makeAction('ptz.preset', { preset: 'Garage' }))
    expect(missing).toEqual({ ok: false, error: 'The camera has no preset "Garage"' })
    expect(ops(s).filter((o) => o === 'GotoPreset')).toHaveLength(2)
  })

  it('refuses PTZ when it is switched off for this camera', async () => {
    const s = await start()
    const res = await adapter.execute(ctxFor(s, { ptz: false }), makeAction('ptz.move', { pan: 1 }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/switched off/)
    expect(s.requests).toHaveLength(0)
  })

  // ----------------------------------------------------------------- reboot

  it('restarts the camera with SystemReboot on the device service', async () => {
    const s = await start()
    const res = await adapter.execute(ctxFor(s), makeAction('reboot'))
    expect(res).toEqual({ ok: true, result: { message: 'Rebooting in 30 seconds' } })
    const reboot = last(s, 'SystemReboot')
    expect(reboot.path).toBe('/onvif/device_service')
    expect(reboot.headers['content-type']).toBe('application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver10/device/wsdl/SystemReboot"')
    expect(payload(reboot)).toBe('<SystemReboot xmlns="http://www.onvif.org/ver10/device/wsdl"/>')
  })

  it('explains that a restart needs an administrator login', async () => {
    const s = await start()
    const res = await adapter.execute(ctxFor(s, { password: 'nope' }), makeAction('reboot'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/administrator username and password/)
  })

  it('refuses commands it cannot do and throws when the camera cannot be reached', async () => {
    const s = await start()
    const ctx = ctxFor(s)
    for (const type of ['power.on', 'gate.open', 'dim.set', 'sms.send', 'custom'] as const) {
      const res = await adapter.execute(ctx, makeAction(type))
      expect(res.ok).toBe(false)
      expect(res.error).toContain(type)
    }
    expect(s.requests).toHaveLength(0)

    await s.close()
    server = null
    // Transport failures are thrown so the hub can fail over to the next connection.
    await expect(adapter.execute(ctx, makeAction('ptz.stop'))).rejects.toThrow(/refused the connection|did not answer/)
    await expect(adapter.readState!(ctx)).rejects.toThrow(/refused the connection|did not answer/)
  })

  // ------------------------------------------------------------------- WiFi

  it('lists the WiFi networks the camera can see', async () => {
    const s = await start({ dot11: true })
    const networks = await adapter.scanWifi!(ctxFor(s, { wifi: true }))
    expect(networks).toEqual([
      { ssid: 'Home WiFi', signal: 90, security: 'WPA2' },
      { ssid: 'JioFiber-Guest', signal: 70, security: 'Open' },
      { ssid: 'Backup WiFi', signal: 40, security: 'WPA2' },
    ])
    expect(ops(s).slice(-2)).toEqual(['GetNetworkInterfaces', 'ScanAvailableDot11Networks'])
    // The token is the one of the interface with InterfaceType 71 (WiFi), not eth0.
    expect(payload(last(s, 'ScanAvailableDot11Networks'))).toBe(
      '<ScanAvailableDot11Networks xmlns="http://www.onvif.org/ver10/device/wsdl"><InterfaceToken>wlan0</InterfaceToken></ScanAvailableDot11Networks>',
    )
  })

  it('finds the WiFi interface when the camera gives its type under Link', async () => {
    const s = await start({ dot11: true, networkInterfaces: NETWORK_INTERFACES_TYPE_UNDER_LINK })
    const networks = await adapter.scanWifi!(ctxFor(s, { wifi: true }))
    expect(networks.map((n) => n.ssid)).toEqual(['Home WiFi', 'JioFiber-Guest', 'Backup WiFi'])
    expect(payload(last(s, 'ScanAvailableDot11Networks'))).toContain('<InterfaceToken>wlan0</InterfaceToken>')
  })

  it('says so when the camera cannot scan, or WiFi control is off', async () => {
    const s = await start({ dot11: false })
    await expect(adapter.scanWifi!(ctxFor(s, { wifi: true }))).rejects.toThrow('This camera cannot list WiFi networks over ONVIF')
    await expect(adapter.scanWifi!(ctxFor(s))).rejects.toThrow(/switched off/)
  })

  it('re-points the camera: keeps the networks it knows, adds the new one, restarts when asked to', async () => {
    const s = await start({ dot11: true, rebootNeeded: true })
    const res = await adapter.setWifi!(ctxFor(s, { wifi: true }), { ssid: 'Backup WiFi', password: 's3cret&pass<1>' })
    // No state.wifi yet: the camera has only been told. The hub sets it when it finds the camera on the new network.
    expect(res).toEqual({ ok: true, result: { ssid: 'Backup WiFi', rebootNeeded: true, restarted: true } })
    expect(JSON.stringify(res)).not.toContain('s3cret')

    expect(ops(s).slice(-5)).toEqual(['GetServiceCapabilities', 'GetDot11Capabilities', 'GetNetworkInterfaces', 'SetNetworkInterfaces', 'SystemReboot'])
    const set = last(s, 'SetNetworkInterfaces')
    expect(set.method).toBe('POST')
    expect(set.path).toBe('/onvif/device_service')
    expect(set.headers['content-type']).toBe('application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver10/device/wsdl/SetNetworkInterfaces"')
    expect(payload(set)).toBe(
      '<SetNetworkInterfaces xmlns="http://www.onvif.org/ver10/device/wsdl"><InterfaceToken>wlan0</InterfaceToken><NetworkInterface>' +
        '<Enabled xmlns="http://www.onvif.org/ver10/schema">true</Enabled>' +
        '<Extension xmlns="http://www.onvif.org/ver10/schema">' +
        // the network it is on now: same alias, no key, so the camera keeps the stored one
        '<Dot11><SSID>486F6D652057694669</SSID><Mode>Infrastructure</Mode><Alias>wifi-home</Alias><Priority>5</Priority><Security><Mode>PSK</Mode><Algorithm>CCMP</Algorithm></Security></Dot11>' +
        // the new one: SSID as hex of its bytes, higher priority, passphrase XML-escaped
        '<Dot11><SSID>4261636B75702057694669</SSID><Mode>Infrastructure</Mode><Alias>wifi-Backup-WiFi</Alias><Priority>6</Priority><Security><Mode>PSK</Mode><Algorithm>Any</Algorithm><PSK><Passphrase>s3cret&amp;pass&lt;1&gt;</Passphrase></PSK></Security></Dot11>' +
        '</Extension></NetworkInterface></SetNetworkInterfaces>',
    )
  })

  it('updates the entry in place when the camera already knows the network, without a restart when none is needed', async () => {
    const s = await start({ dot11: true, rebootNeeded: false })
    const res = await adapter.setWifi!(ctxFor(s, { wifi: true }), { ssid: 'Home WiFi', password: 'new-password-1' })
    expect(res).toEqual({ ok: true, result: { ssid: 'Home WiFi', rebootNeeded: false, restarted: false } })
    expect(ops(s)).not.toContain('SystemReboot')
    expect(payload(last(s, 'SetNetworkInterfaces'))).toContain(
      '<Extension xmlns="http://www.onvif.org/ver10/schema"><Dot11><SSID>486F6D652057694669</SSID><Mode>Infrastructure</Mode><Alias>wifi-home</Alias><Priority>0</Priority><Security><Mode>PSK</Mode><Algorithm>Any</Algorithm><PSK><Passphrase>new-password-1</Passphrase></PSK></Security></Dot11></Extension>',
    )
  })

  it('warns when the camera can hold only one WiFi network and the old one is replaced', async () => {
    const s = await start({ dot11: true, singleWifi: true })
    const res = await adapter.setWifi!(ctxFor(s, { wifi: true }), { ssid: 'Backup WiFi', password: 'long-enough-pass' })
    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ ssid: 'Backup WiFi', rebootNeeded: false, restarted: false, replaced: ['Home WiFi'] })
    expect(String(res.result?.warning)).toMatch(/"Backup WiFi" takes the place of "Home WiFi"/)
    // Only the new network is sent: resending the old one would be refused by a camera that holds one.
    expect(payload(last(s, 'SetNetworkInterfaces'))).toContain(
      '<Extension xmlns="http://www.onvif.org/ver10/schema"><Dot11><SSID>4261636B75702057694669</SSID><Mode>Infrastructure</Mode><Alias>wifi-Backup-WiFi</Alias><Priority>0</Priority><Security><Mode>PSK</Mode><Algorithm>Any</Algorithm><PSK><Passphrase>long-enough-pass</Passphrase></PSK></Security></Dot11></Extension>',
    )
  })

  it('sends a 64-character WiFi key as a key, not as a passphrase', async () => {
    const s = await start({ dot11: true })
    const key = '0123456789abcdef'.repeat(4)
    const res = await adapter.setWifi!(ctxFor(s, { wifi: true }), { ssid: 'Café ☕', password: key })
    expect(res.ok).toBe(true)
    expect(res.result?.replaced).toBeUndefined()
    const sent = payload(last(s, 'SetNetworkInterfaces'))
    // SSID as hex of its UTF-8 bytes; children of PSK in schema order (Key, then Passphrase).
    expect(sent).toContain(`<Dot11><SSID>${Buffer.from('Café ☕', 'utf8').toString('hex').toUpperCase()}</SSID><Mode>Infrastructure</Mode><Alias>wifi-Caf</Alias><Priority>6</Priority><Security><Mode>PSK</Mode><Algorithm>Any</Algorithm><PSK><Key>${key}</Key></PSK></Security></Dot11>`)
    expect(sent).not.toContain('<Passphrase>')
    expect(JSON.stringify(res)).not.toContain(key)
  })

  it('treats a camera that goes quiet on the WiFi change as moving, not as a failure', async () => {
    // A camera that switches networks at once drops off before it can answer SetNetworkInterfaces.
    for (const how of ['silent', 'dropped'] as const) {
      resetOnvifSessions()
      await server?.close()
      const inner = onvifCamera({ auth: 'wsse', username: USER, password: PASS, dot11: true })
      server = await mockServer((req, res, raw) => {
        if (opOf(req) !== 'SetNetworkInterfaces') return inner(req, res, raw)
        if (how === 'dropped') raw.socket.destroy()
      })
      const ctx = makeCtx({ family: 'onvif', config: { username: USER, password: PASS, wifi: true }, path: { port: server.port }, timeoutMs: 300 })
      const res = await adapter.setWifi!(ctx, { ssid: 'Backup WiFi', password: 'long-enough-pass' })
      expect(res.ok, how).toBe(true)
      expect(res.result).toMatchObject({ ssid: 'Backup WiFi', answered: false })
      expect(String(res.result?.note)).toMatch(/stopped answering/)
      expect(res.state).toBeUndefined()
      expect(JSON.stringify(res)).not.toContain('long-enough-pass')
      expect(ops(server).at(-1)).toBe('SetNetworkInterfaces')
    }
  })

  it('throws when the camera cannot be reached for a WiFi change at all', async () => {
    const s = await start({ dot11: true })
    const ctx = ctxFor(s, { wifi: true })
    await s.close()
    server = null
    await expect(adapter.setWifi!(ctx, { ssid: 'Backup WiFi', password: 'long-enough-pass' })).rejects.toThrow(/refused the connection|did not answer/)
  })

  it('needs an administrator login for a WiFi change', async () => {
    const s = await start({ dot11: true })
    const res = await adapter.setWifi!(ctxFor(s, { wifi: true, password: 'nope' }), { ssid: 'Backup WiFi', password: 'long-enough-pass' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/administrator username and password/)
    expect(JSON.stringify(res)).not.toMatch(/nope|long-enough-pass/)
    expect(ops(s)).not.toContain('SetNetworkInterfaces')
  })

  it('changes nothing on a camera that does not allow WiFi changes over ONVIF', async () => {
    const s = await start({ dot11: false })
    const res = await adapter.setWifi!(ctxFor(s, { wifi: true }), { ssid: 'Backup WiFi', password: 'long-enough-pass' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/does not allow its WiFi to be changed over ONVIF/)
    expect(ops(s)).not.toContain('SetNetworkInterfaces')
    expect(payload(last(s, 'GetServiceCapabilities'))).toBe('<GetServiceCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"/>')
  })

  it('checks the WiFi details before talking to the camera', async () => {
    const s = await start({ dot11: true })
    const on = ctxFor(s, { wifi: true })
    expect((await adapter.setWifi!(ctxFor(s), { ssid: 'Backup WiFi', password: 'long-enough-pass' })).error).toMatch(/switched off/)
    expect((await adapter.setWifi!(on, { ssid: '', password: 'long-enough-pass' })).error).toBe('No network name given')
    expect((await adapter.setWifi!(on, { ssid: 'Backup WiFi', password: '' })).error).toBe('No password stored for "Backup WiFi"')
    const short = await adapter.setWifi!(on, { ssid: 'Backup WiFi', password: 'short' })
    expect(short.ok).toBe(false)
    expect(short.error).toMatch(/8 to 63/)
    expect(short.error).not.toContain('short')
    expect(s.requests).toHaveLength(0)
  })

  // -------------------------------------------------------------- discovery

  it('finds cameras through the hub discovery, imported on demand', async () => {
    const found = await adapter.discover!(1, logger('test'))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ family: 'onvif', kind: 'camera', host: '192.168.1.64', port: 80 })
    const { onvifProbe } = await import('../../src/discovery.ts')
    expect(onvifProbe).toHaveBeenCalledWith(1, expect.anything())
  })
})

// ---------------------------------------------------------------------------
// The client other adapters reuse
// ---------------------------------------------------------------------------

describe('onvifClient', () => {
  it('offers the shared calls with addresses rewritten and no credentials in them', async () => {
    const s = await start()
    const cam = onvifClient({ host: '127.0.0.1', port: s.port, username: USER, password: PASS, timeoutMs: 2000 })

    expect(await cam.getDeviceInformation()).toEqual({ manufacturer: 'HIKVISION', model: 'DS-2DE2A404IW-DE3', firmware: 'V5.7.3 build 220315', serial: SERIAL, hardwareId: '88' })

    const profiles = await cam.getProfiles()
    expect(profiles).toEqual([
      { token: 'Profile_1', name: 'mainStream', encoding: 'H264', width: 2560, height: 1440, ptz: true, media2: false },
      { token: 'Profile_2', name: 'subStream', encoding: 'H264', width: 640, height: 360, ptz: true, media2: false },
    ])

    expect(await cam.getStreamUri('Profile_1')).toBe('rtsp://127.0.0.1:554/Streaming/Channels/101?transportmode=unicast&profile=Profile_1')
    expect(await cam.getSnapshotUri('Profile_1')).toBe(`http://127.0.0.1:${s.port}/onvif-http/snapshot?Profile_1`)
    expect((await cam.fetchSnapshot(await cam.getSnapshotUri('Profile_1'))).body.equals(TINY_JPEG)).toBe(true)

    await cam.continuousMove('Profile_1', { pan: 0.3, tilt: -0.3, zoom: 0 })
    expect(payload(last(s, 'ContinuousMove'))).toContain('<PanTilt x="0.3" y="-0.3" xmlns="http://www.onvif.org/ver10/schema"/></Velocity>')
    await cam.stop('Profile_1')
    expect(ops(s).at(-1)).toBe('Stop')

    expect(await cam.getPresets('Profile_1')).toEqual([
      { token: '1', name: 'Gate' },
      { token: '2', name: 'Driveway' },
      { token: '3', name: 'Preset 3' },
    ])
    await cam.gotoPreset('Profile_1', 1)
    expect(payload(last(s, 'GotoPreset'))).toContain('<PresetToken>1</PresetToken>')
    await expect(cam.gotoPreset('Profile_1', '9')).rejects.toMatchObject({ kind: 'fault', codes: ['Sender', 'InvalidArgVal', 'NoToken'], message: 'The requested preset token does not exist' })

    expect(await cam.reboot()).toBe('Rebooting in 30 seconds')
  })

  it('keeps a still-picture port that is not the ONVIF port', async () => {
    const s = await start({ snapshotUri: `http://${LAN}:8080/cgi-bin/snapshot.cgi?chn=1&amp;u=admin` })
    const cam = onvifClient({ host: '127.0.0.1', port: s.port, username: USER, password: PASS, timeoutMs: 2000 })
    expect(await cam.getSnapshotUri('Profile_1')).toBe('http://127.0.0.1:8080/cgi-bin/snapshot.cgi?chn=1&u=admin')
  })

  it('tells refusals apart from an unreachable camera', async () => {
    const s = await start()
    const wrong = onvifClient({ host: '127.0.0.1', port: s.port, username: USER, password: 'nope', timeoutMs: 2000 })
    const refused = await wrong.getDeviceInformation().catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(OnvifError)
    expect((refused as OnvifError).kind).toBe('auth')
    expect((refused as OnvifError).message).not.toContain('nope')

    const port = s.port
    await s.close()
    server = null
    const gone = onvifClient({ host: '127.0.0.1', port, username: USER, password: PASS, timeoutMs: 500 })
    const down = await gone.getProfiles().catch((e: unknown) => e)
    expect(down).toBeInstanceOf(Error)
    expect(down).not.toBeInstanceOf(OnvifError)
  })
})
