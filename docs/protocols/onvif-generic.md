# onvif-generic

Review: 64 claims confirmed, 3 corrected, 0 could not be verified.

## Summary

ONVIF is feasible as the generic camera adapter for everything the hub needs on the LAN: WS-Discovery (UDP multicast 239.255.255.250:3702) finds cameras and returns their device-service XAddrs; the Device service (fixed entry point /onvif/device_service) gives GetDeviceInformation, GetServices/GetCapabilities, GetNetworkInterfaces/SetNetworkInterfaces, the Dot11 (WiFi) trio GetDot11Capabilities/GetDot11Status/ScanAvailableDot11Networks, and SystemReboot; the Media (ver10, Profile S) or Media2 (ver20, Profile T) service gives GetProfiles/GetStreamUri (RTSP URL for go2rtc) and GetSnapshotUri (JPEG); the PTZ service gives ContinuousMove/Stop/AbsoluteMove/GotoPreset/SetPreset; Imaging gives brightness/IR-cut/focus; and the Events pull-point (CreatePullPointSubscription + long-poll PullMessages, mandatory in both Profile S and T) is the notification source, with tns1:VideoSource/MotionAlarm mandatory on Profile T devices. All of these are verified against the ONVIF Core Spec 26.06, the official WSDLs/XSD and the Profile S 1.3 / Profile T 1.0 specs. Re-pointing a camera to another WiFi network IS defined by ONVIF (SetNetworkInterfaces with NetworkInterface/Extension/Dot11 {SSID as hexBinary, Mode, Alias, Priority, Security{Mode PSK, Algorithm, PSK{Passphrase}}}, answered by RebootNeeded), but it is conditional on the device advertising the Network Dot11Configuration capability, and neither Profile S nor Profile T mandates it, so it must be feature-detected per camera and the SIM path is needed as the fallback the moment the LAN link drops. The npm package "onvif" (agsh/onvif, MIT) is the right library: latest 0.8.3 (JS, callback Cam API, also onvif/promises) covers discovery, device info, network interfaces (IPv4/IPv6 only), stream/snapshot URIs, full PTZ, imaging and an auto-managed pull-point event loop; the 1.0.0-rc.3 TypeScript rewrite (dist-tag rc) adds getDot11Capabilities/getDot11Status/scanAvailableDot11Networks, Media2, typed Subscription filters and a raw onvif.request() escape hatch. Critically, NEITHER version serialises the Dot11 block in setNetworkInterfaces (0.8.3 documents extension.dot11 in JSDoc but the XML builder ignores it; 1.x types accept extension.dot11 but drop it), so the hub must build that one SOAP body itself (0.8.x cam._request or 1.x onvif.request with explicit xmlns, since onvif.xsd is elementFormDefault=qualified). node-onvif (0.1.7, 2018, MIT) is unmaintained and lacks SetNetworkInterfaces, Dot11, imaging and pull-point events; the package name "onvif-ts" does not exist on npm (the nearest are node-onvif-ts, a 2020 TS port of node-onvif with the same gaps, ts-onvif 1.0.1 which is a republish of the agsh 1.x line, and @2bad/onvif, a TS fork of agsh 0.x). Recommendation: build the adapter on onvif@0.8.3 today with a hand-written SetNetworkInterfaces+Dot11 request, or on onvif@rc if the team is comfortable with a release candidate, and keep raw-SOAP fallbacks for the two known routing/serialisation quirks listed in caveats.

## Corrections from review (these override anything below)

- **Claim:** Auth is HTTP Digest (RFC 2617/7616) or legacy WS-Security UsernameToken PasswordDigest=Base64(SHA1(nonce+created+password)); nonce+timestamp mandatory; agsh/onvif gets timeShift from unauthenticated GetSystemDateAndTime first, useWSSecurity default true (Core Spec 5.12)
  **Correction:** Substance is right but the section reference is stale: in the current Core Spec (v26.06) this is s5.9.1 'Authentication over HTTP and HTTPS' and s5.9.5 'Username token profile' (5.12 does not hold this text; SHA-256/RFC 7616 is s5.9.3 and is optional, MD5 is default). Spec also now lists TLS client auth and JWT (HTTPS only) as exceptions, and says a client 'should not simultaneously supply' HTTP-level and WS-level credentials. In onvif@1.x the HTTP layer ALWAYS answers a 401 with a Digest retry (rawRequest), independent of useWSSecurity; useWSSecurity only controls whether the WS-Security header is added. The SHA1 input is raw nonce BYTES (16 random bytes) + Created string + password, nonce is sent base64-encoded.
  Source: https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf ; https://github.com/agsh/onvif/blob/master/src/onvif.ts (passwordDigest, rawRequest 401 branch, getSystemDateAndTime)
- **Claim:** onvif@1.x method surface (constructor options, connect flow, media/media2/ptz/imaging/events/Discovery signatures; getPresets returns Record<token, preset>; stop defaults; timeout ms -> PT<s>S)
  **Correction:** Mostly correct, with these errors: (1) ptz.getPresets() returns PTZPreset[] (Object.values); the token-keyed Record is returned by ptz.getPresetsExtended() (also cached on ptz.presets). Likewise getNodes()/getConfigurations() return arrays, getNodesExtended()/getConfigurationsExtended() return Records. (2) media2.getStreamUri() called directly defaults protocol to 'RtspUnicast' (RTP over UDP), whereas media.getStreamUri() defaults to 'RTSP' (RTP over TCP) -- pass protocol explicitly. (3) connect() is GetSystemDateAndTime -> GetServices (fallback GetCapabilities on error) -> probe Media2 profiles if advertised, else Media1 GetProfiles + GetVideoSources -> getActiveSources. (4) formatPTZSimpleVector uses `pan || x` / `tilt || y`, and always emits a Zoom element; pass a full PTZSpeed object ({panTilt:{x,y}} only) to leave zoom untouched.
  Source: https://github.com/agsh/onvif/blob/master/src/ptz.ts lines 378-400, 557-572, 843-854 (ptz.ts identical at rc.3 commit) ; https://github.com/agsh/onvif/blob/master/src/media2.ts line 1201 ; https://github.com/agsh/onvif/blob/master/src/connection.ts lines 285-311 ; src/onvif.ts lines 53-75, 567-582 ; src/discovery.ts lines 14-26
- **Claim:** Event loop in both onvif versions: on('event') auto-creates pull-point (PT2M in 0.8.x, 4 min in 1.x), PullMessages PT1M / limit 10, renews after each pull, echoes Axis SubscriptionId, back-off, unsubscribes on last listener removed; 1.x Subscription class
  **Correction:** 0.8.3 is as described (renews unconditionally after every successful pull; back-off 10 ms x1.111 up to 2 min; errors emitted as 'eventsError'). In 1.x the loop only calls Renew when the TerminationTime returned by PullMessages is already <= Date.now() (otherwise it just stores msgs.terminationTime), and after a SOAP/connection error it does Renew + SetSynchronizationPoint then restarts with back-off 1 s x1.111 up to 2 min. 1.x surfaces loop errors on the Onvif instance as 'eventsError' (from Subscription 'error'/'connectionError'), not 'error'. 0.8.3 does not unsubscribe via a removeListener hook: the loop stops and unsubscribes on the next _eventPull iteration when listeners('event').length is 0 (so up to one PT1M later); 1.x has an explicit removeListener hook.
  Source: https://raw.githubusercontent.com/agsh/onvif/4ac697bc33a3c894d1f139c3a0b000e984ea4858/lib/events.js lines 104, 261-268, 377-440 and lib/cam.js lines 112-119 ; https://github.com/agsh/onvif/blob/master/src/events.ts lines 137-141, 187-189, 506-580, 588-612 ; src/onvif.ts lines 613-623

## Added by review (things an implementer needs)

- **onvif@1.0.0-rc.3 PTZ requests are probably sent with a broken namespace** src/ptz.ts calls super(onvif, 'PTZ') but the XMLNS map in src/service.ts only has a lowercase 'ptz' key, so Service.request sets body[root].$ = {xmlns: undefined}. fast-xml-builder stringifies attribute-group values with String(val), so the wire body becomes e.g. <ContinuousMove xmlns="undefined"> and no SOAP action is added to Content-Type. Lenient cameras may still accept it, strict (gSOAP) ones will fault. This is from reading source at the rc.3 commit and master, NOT from running it -- confirm by logging onvif.on('requestBody', xml => ...) before relying on 1.x PTZ. Safe path: build PTZ bodies yourself via onvif.request({service:'PTZ', body:{ContinuousMove:{$:{xmlns:'http://www.onvif.org/ver20/ptz/wsdl'}, ...}}}) (service key 'PTZ' is what connection.ts stores the PTZ XAddr under), or use 0.8.3 for PTZ. (https://github.com/agsh/onvif/blob/4409b8852f2ddc1c7677e64d7acfa2a8917cfaa8/src/ptz.ts#L174 ; https://github.com/agsh/onvif/blob/4409b8852f2ddc1c7677e64d7acfa2a8917cfaa8/src/service.ts ; https://github.com/agsh/onvif/blob/master/src/connection.ts (namespaceSplitted[1] = 'PTZ') ; https://github.com/NaturalIntelligence/fast-xml-builder/blob/main/src/fxb.js (lines 296-303) and src/util.js valToStr)
- **Sending Dot11 elements in SetNetworkInterfaces most likely replaces the camera's whole WiFi list for that interface** Spec: 'A wireless configuration, including the alias, shall only exist while it's part of a network interface configuration' and the device retains its 802.11 configuration only 'if the IEEE 802.11 configuration element isn't present in the request'. So to ADD a backup SSID the hub should first GetNetworkInterfaces, then resend every existing Extension/Dot11 entry (same Alias, PSK element omitted so the stored key is kept) plus the new one with a PSK. Sending only the new network risks deleting the SSID the camera is currently on. This is an inference from the spec text; verify per camera. Also only works if MultipleConfiguration=true in GetDot11Capabilities ('should', not 'shall'). (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf s8.2.11, s8.2.22, s8.2.22.3, s8.2.22.4.2)
- **Schema ordering and required fields for the Dot11 body** onvif.xsd uses xs:sequence everywhere: NetworkInterface children must be in order Enabled, Link, MTU, IPv4, IPv6, Extension; Extension children Dot3*, Dot11*; Dot11 children SSID, Mode, Alias, Priority, Security (all five required); Security children Mode, Algorithm?, PSK?, Dot1X?; PSK children Key?, Passphrase?. SSID is hex of the raw SSID bytes (UTF-8), 1-32 bytes. Passphrase must match [ -~]{8,63} and must be XML-escaped (& < >). Key, if used, is 64 hex chars and wins over Passphrase. All these elements are in namespace http://www.onvif.org/ver10/schema (elementFormDefault=qualified), while InterfaceToken and NetworkInterface are in the tds namespace. (https://www.onvif.org/ver10/schema/onvif.xsd (lines 3070-3112, 3228-3335) ; https://www.onvif.org/ver10/device/wsdl/devicemgmt.wsdl lines 1440-1463)
- **Finding the WiFi interface token** Call GetNetworkInterfaces and pick the entry whose Extension/InterfaceType == 71 (ieee80211); its token attribute is the InterfaceToken for SetNetworkInterfaces/GetDot11Status/ScanAvailableDot11Networks. Its Extension/Dot11[] lists configured networks (SSID hex, Alias, Priority, Security without PSK). A wired interface is ifType 6. Passing a non-WiFi token to the Dot11 calls faults ter:NotDot11. (https://www.onvif.org/ver10/schema/onvif.xsd NetworkInterfaceExtension (InterfaceType tt:IANA-IfTypes) ; Core Spec s8.2.22, s8.2.22.6)
- **Renew is not guaranteed on every camera; pull-point keep-alive is PullMessages itself** Core Spec 9.1.3: a device shall support Renew only 'if it signals support for [WS-Base Notification] via the MaxNotificationProducers capability'. 9.1.1: 'By default the pull point keep alive is controlled via the PullMessages operation ... after a PullMessages response is returned, the subscription should be active for at least the timeout specified in the PullMessages request.' So the hub's own loop must tolerate a Renew fault and just keep pulling; and it must never run two PullMessages concurrently on one subscription (device 'should return UnableToGetMessagesFault'). If Timeout is too large the device returns PullMessagesFaultResponse with MaxTimeout/MaxMessageLimit. Device capability MaxPullPoints limits how many subscriptions exist; always Unsubscribe on shutdown or the camera can run out of pull points until they expire. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf s9.1.1, 9.1.2, 9.1.3, 9.1.6)
- **HTTP transport details the adapter must reproduce if it hand-builds SOAP** POST with Content-Type: application/soap+xml;charset=utf-8;action="<namespace>/<Operation>" (SOAP 1.2; agsh notes some devices such as Pelco return an empty body without the action, and mishandle pretty-printed XML -- send compact XML). Envelope namespace http://www.w3.org/2003/05/soap-envelope. WS-Security header: wsse:Security/UsernameToken with Username, Password Type=...#PasswordDigest, Nonce (base64), Created (camera-clock UTC ISO time = local time + timeShift). On HTTP 401 with WWW-Authenticate: Digest, retry with an Authorization: Digest header (MD5 default; qop/nc/cnonce only if qop offered). (https://github.com/agsh/onvif/blob/master/src/onvif.ts (rawRequest lines 700-780, envelopeHeader 647-680, passwordDigest 684-698, digestAuth 843-910) ; Core Spec s5.9.1, s5.9.3)
- **Reaching a camera through NAT/SIM path: service XAddrs come back as LAN addresses** GetServices/GetCapabilities return XAddrs with the device's local IP ('if the device is behind a NAT that device may return the local address'), and the SubscriptionReference address for PullMessages is likewise device-generated. Use preserveAddress:true (both 0.8.x and 1.x) so the library keeps the hostname/port you connected to and only takes the path from each XAddr; a hand-written adapter must do the same rewrite, including for the pull-point URL, the RTSP URI from GetStreamUri and the snapshot URI. WS-Discovery is link-local multicast and will not work over the SIM/WAN path at all -- persist each camera's device-service URL instead. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf s8.1.2.2 ; https://github.com/agsh/onvif/blob/master/src/onvif.ts parseUrl (lines 967-985, preserveAddress) ; https://raw.githubusercontent.com/agsh/onvif/4ac697bc33a3c894d1f139c3a0b000e984ea4858/lib/cam.js lines 1272-1284)
- **Detecting that a camera has rejoined after a WiFi change** After SetNetworkInterfaces with RebootNeeded=false the device 'may not be responsive for a short period of time until it signals availability at the new address via the discovery Hello messages'. The hub should keep a UDP socket joined to 239.255.255.250:3702 and match Hello messages by endpoint reference (urn:uuid, stable across interfaces per s7.3.1) to learn the new IP, and/or re-Probe. If RebootNeeded=true, call SystemReboot and then wait for Hello. If the new SSID is on a different subnet than the hub, Hello will not be seen -- fall back to the SIM path or DHCP lease lookup. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf s7.2, 7.3.1, 7.3.2, 8.2.11)
- **Snapshot and stream URIs need their own authentication** GetSnapshotUri returns a plain HTTP GET URL (JPEG regardless of profile encoding, valid indefinitely); the GET itself must be authenticated with HTTP Digest using the same ONVIF user (spec: 'When authenticating RTSP or HTTP methods, an ONVIF compliant device shall use digest authentication [RFC 2617]'). The RTSP URI from GetStreamUri carries no credentials; RTSP is authenticated at the RTSP level with the same user, so the hub must inject user:pass (URL-encoded) when handing the URI to go2rtc/ffmpeg. (https://www.onvif.org/specs/srv/media/ONVIF-Media-Service-Spec.pdf s5.16.1 ; https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf s5.9.1)
- **ONVIF relay outputs can drive a gate/light contact on cameras that have an alarm-out terminal** Device service: GetRelayOutputs (READ_MEDIA) -> RelayOutput[]{token, Properties{Mode Monostable|Bistable, DelayTime, IdleState open|closed}}; SetRelayOutputState{RelayOutputToken, LogicalState 'active'|'inactive'} (ACTUATE); SetRelayOutputSettings (ACTUATE). Body: <SetRelayOutputState xmlns="http://www.onvif.org/ver10/device/wsdl"><RelayOutputToken>{token}</RelayOutputToken><LogicalState>active</LogicalState></SetRelayOutputState>. Conditional feature in Profile S (s8.13); capability Device/IO/RelayOutputs >= 1. node-onvif exposes getRelayOutputs only; agsh 0.8.3 has no relay methods in the files checked, so use the raw request hatch. (https://www.onvif.org/ver10/device/wsdl/devicemgmt.wsdl lines 2061-2065 ; https://www.onvif.org/ver10/schema/onvif.xsd RelayLogicalState ; Core Spec s8.6.1-8.6.3 ; Profile S v1.3 s8.13)
- **PTZ touch-and-hold behaviour and timeouts** ContinuousMove Timeout overrides the configuration's DefaultPTZTimeout; without it the camera moves for DefaultPTZTimeout (can be long). 'A device shall stop movement in a particular axis when zero is sent as the ContinuousMove parameter for that axis', so sending velocity 0 is an alternative to Stop. Timeouts outside the node's range fault ter:TimeoutNotSupported (range from GetConfigurationOptions). For a phone UI: send ContinuousMove with a short Timeout (e.g. PT1S-PT2S) repeatedly while the finger is down and Stop on release, so a lost Stop over a flaky 4G link cannot leave the camera spinning. In agsh 1.x a numeric timeout is milliseconds (1000 -> 'PT1S'). (https://www.onvif.org/specs/srv/ptz/ONVIF-PTZ-Service-Spec.pdf s5.3.3 (lines on DefaultPTZTimeout and zero velocity), s5.1 DefaultPTZTimeout ; https://github.com/agsh/onvif/blob/master/src/ptz.ts continuousMove)
- **onvif@1.x library gotchas beyond those listed** (a) ptz.gotoHomePosition has the same lowercase 'speed' key bug as gotoPreset. (b) media2.getStreamUri defaults to 'RtspUnicast' (UDP). (c) rawRequest sets timeout: this.timeout AFTER spreading options, so the per-call timeout passed by Subscription.pullMessages (PT1M + 2 s) appears to be overridden by the instance timeout (default 120000 ms) -- do not set the Onvif timeout below ~65 s if you use events. (d) Event-loop failures arrive as onvif.on('eventsError'), connection/auth failures on autoConnect as 'error' -- attach both or Node will throw on unhandled 'error'. (e) onvif.on('requestBody') emits every outgoing SOAP body for debugging. (f) master has moved on from rc.3 (service.ts, onvif.ts, connection.ts, discovery.ts differ), so pin the exact version. (https://github.com/agsh/onvif/blob/master/src/ptz.ts lines 675-685 ; src/media2.ts line 1201 ; src/onvif.ts lines 700-725, 613-630, 935 ; src/events.ts lines 187-189, 600-612)
- **Access-control mapping: which ONVIF user level the hub account needs** Default access policy (Core Table 7): ACTUATE operations (PTZ moves, SetImagingSettings, SetRelayOutputState) need Operator or Administrator; WRITE_SYSTEM (SetNetworkInterfaces) and UNRECOVERABLE (SystemReboot) need Administrator; READ_MEDIA (profiles, stream URI, events) is not available to Anonymous. So WiFi re-pointing and reboot require the hub to hold an Administrator-level ONVIF user; a separate Operator user is enough for viewing/PTZ. The PDF table did not extract cleanly, so confirm the exact matrix in the spec before designing roles. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf s5.9.4.3, s5.9.4.4 Table 7)
- **Core Spec version actually published at the cited URL** The URL serves ONVIF Core Specification v26.06 (June 2026); onvif.xsd is version 25.12 and devicemgmt.wsdl schema version 26.06. Section numbers quoted by the researcher match this version except security (now 5.9.x, not 5.12). Newer spec content the researcher did not mention and that could matter later: Event Broker / MQTT-style event delivery (s9.12, AddEventBroker/GetEventBrokers; exposed in agsh 1.x as events.addEventBroker etc.) as an outbound, NAT-friendly alternative to pull points on cameras that support it. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf (title page, ToC s9.12) ; https://github.com/agsh/onvif/blob/master/src/events.ts lines 303-340)
- **No primary-source evidence that consumer WiFi/4G cameras implement the ONVIF Dot11 operations** Everything about Dot11 here is from the ONVIF spec/schema; neither agsh/onvif (0.8.3 or 1.x) nor node-onvif can send a Dot11 block, which suggests it is rarely exercised in the open-source ecosystem. Profile S/T do not require it. The hub must treat ONVIF WiFi re-pointing as capability-gated (Network/@Dot11Configuration == true AND GetDot11Capabilities succeeds) and fall back to vendor-specific adapters otherwise. Confidence that the house's cameras support it: low until probed. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf s8.2.22 ; https://github.com/agsh/onvif/blob/master/src/device.ts lines 545-600 ; https://github.com/futomi/node-onvif/tree/master/lib/modules)

## Calls

### WS-Discovery Probe (find cameras on the LAN)

```
soap UDP multicast udp://239.255.255.250:3702  body: <Envelope xmlns="http://www.w3.org/2003/05/soap-envelope" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><Header><wsa:MessageID xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">urn:uuid:{uuid}</wsa:MessageID><wsa:To xmlns:wsa="...">urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To><wsa:Action xmlns:wsa="...">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action></Header><Body><Probe xmlns="http://schemas.xmlsoap.org/ws/2005/04/discovery"><Types>dn:NetworkVideoTransmitter</Types><Scopes/></Probe></Body></Envelope>
```
- Params: messageId uuid; optional Types tds:Device; optional Scopes onvif://www.onvif.org/...; send from every IPv4 interface address, listen ~5 s
- Auth: none
- Response: ProbeMatches/ProbeMatch{EndpointReference/Address urn:uuid:..., Types, Scopes (space-separated onvif://www.onvif.org/Profile|hardware|name|location|...), XAddrs (space-separated http://ip[:port]/onvif/device_service), MetadataVersion}
- Notes: Core Spec 7.3; spec ref http://specs.xmlsoap.org/ws/2005/04/discovery/ws-discovery.pdf. Library: onvif 0.8.x `Discovery.probe({timeout=5000, resolve=true, messageId, device, listeningPort, bufferSize}, (err, cams)=>{})` + `Discovery.on('device',(cam, rinfo, xml))`; onvif 1.x `await Discovery.probe({timeout, resolve, device, type, bufferSize})` -> Onvif[] with hostname/port/path/urn/xaddrs; node-onvif `await onvif.startProbe()` -> [{urn,name,hardware,location,types,xaddrs,scopes}]. Windows: bind per-interface, allow UDP 3702 in the firewall. Only works on the LAN, never over the SIM path.
- Source: https://github.com/agsh/onvif/blob/master/src/discovery.ts

### GetSystemDateAndTime (clock offset for WS-Security, pre-auth)

```
soap POST POST http://{ip}/onvif/device_service  body: <GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>
```
- Params: none
- Auth: none (PRE_AUTH; some Panasonic/Digital Barriers require auth)
- Response: SystemDateAndTime{DateTimeType, DaylightSavings, TimeZone{TZ}, UTCDateTime{Date{Year,Month,Day},Time{Hour,Minute,Second}}, LocalDateTime}
- Notes: Both agsh versions call this first in connect() to compute timeShift = deviceUTC - local; needed for PasswordDigest Created timestamp. 0.8.x `cam.getSystemDateAndTime(cb)`; 1.x `await onvif.getSystemDateAndTime()`.
- Source: https://www.onvif.org/ver10/device/wsdl/devicemgmt.wsdl

### GetDeviceInformation

```
soap POST POST {device XAddr}  body: <GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>
```
- Params: none
- Auth: WS-UsernameToken PasswordDigest or HTTP Digest (READ_SYSTEM)
- Response: GetDeviceInformationResponse{Manufacturer, Model, FirmwareVersion, SerialNumber, HardwareId}
- Notes: 0.8.x `cam.getDeviceInformation(cb)` -> {manufacturer, model, firmwareVersion, serialNumber, hardwareId}; 1.x `await onvif.device.getDeviceInformation()`; node-onvif `device.services.device.getDeviceInformation()` or `device.init()` result. Store SerialNumber/HardwareId as the stable device id in the hub DB.
- Source: https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf

### GetServices (service XAddr map + capabilities)

```
soap POST POST {device XAddr}  body: <GetServices xmlns="http://www.onvif.org/ver10/device/wsdl"><IncludeCapability>true</IncludeCapability></GetServices>
```
- Params: IncludeCapability boolean
- Auth: PRE_AUTH (usually works unauthenticated)
- Response: GetServicesResponse/Service[]{Namespace (e.g. http://www.onvif.org/ver20/media/wsdl), XAddr, Version{Major,Minor}, Capabilities (untyped per-service)}
- Notes: Core 8.1.2.2: XAddr matches the scheme/IP of the request; NAT devices may return a LAN address -- the hub should rewrite XAddr host to the address it dialled when using the SIM path (agsh option preserveAddress:true does exactly this). 0.8.x `cam.getServices(true, cb)`; 1.x `await onvif.device.getServices({includeCapability:true})`; node-onvif `services.device.getServices({IncludeCapability:true})`. Presence of namespace .../ver20/media/wsdl = Media2 (Profile T).
- Source: https://www.onvif.org/ver10/device/wsdl/devicemgmt.wsdl

### GetCapabilities (legacy service map)

```
soap POST POST {device XAddr}  body: <GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>
```
- Params: Category: All|Analytics|Device|Events|Imaging|Media|PTZ (optional, repeatable)
- Auth: PRE_AUTH
- Response: Capabilities{Device{XAddr, Network{IPFilter,ZeroConfiguration,IPVersion6,DynDNS,Extension{Dot11Configuration bool,...}}, System, IO, Security}, Events{XAddr, WSSubscriptionPolicySupport, WSPullPointSupport}, Imaging{XAddr}, Media{XAddr, StreamingCapabilities{RTPMulticast,RTP_TCP,RTP_RTSP_TCP}}, PTZ{XAddr}, Extension{DeviceIO...}}
- Notes: Fallback when GetServices is unsupported (agsh connect() tries GetServices first, then GetCapabilities). 0.8.x `cam.getCapabilities(cb)` also fills cam.uri.{device,media,ptz,imaging,events}.
- Source: https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf

### GetServiceCapabilities (device) -- detect WiFi (Dot11) support

```
soap POST POST {device XAddr}  body: <GetServiceCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"/>
```
- Params: none
- Auth: PRE_AUTH
- Response: Capabilities{Network attrs: IPFilter, ZeroConfiguration, IPVersion6, DynDNS, Dot11Configuration (bool), Dot1XConfigurations, HostnameFromDHCP, NTP, DHCPv6; Security attrs: TLS1.0/1.1/1.2, OnboardKeyGeneration, ...; System attrs: DiscoveryResolve, DiscoveryBye, RemoteDiscovery, SystemBackup, SystemLogging, FirmwareUpgrade, HttpFirmwareUpgrade,...; Misc}
- Notes: If Network@Dot11Configuration != true, skip all Dot11 UI for that camera (operations will fault ter:InvalidDot11). 1.x `await onvif.device.getServiceCapabilities()` (parses attrs); 0.8.x `cam.getServiceCapabilities(cb)`.
- Source: https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf

### GetNetworkInterfaces

```
soap POST POST {device XAddr}  body: <GetNetworkInterfaces xmlns="http://www.onvif.org/ver10/device/wsdl"/>
```
- Params: none
- Auth: READ_SYSTEM
- Response: NetworkInterfaces[] each: @token, Enabled, Info{Name, HwAddress, MTU}, Link?{AdminSettings{AutoNegotiation,Speed,Duplex}, OperSettings, InterfaceType}, IPv4?{Enabled, Config{Manual[]{Address,PrefixLength}, LinkLocal, FromDHCP{Address,PrefixLength}, DHCP bool}}, IPv6?, Extension?{InterfaceType (71 = ieee80211), Dot3[], Dot11[]{SSID hex, Mode, Alias, Priority, Security{Mode, Algorithm, Dot1X}} (PSK never returned)}
- Notes: The @token is the InterfaceToken you need for SetNetworkInterfaces/GetDot11Status/ScanAvailableDot11Networks. 0.8.x `cam.getNetworkInterfaces(cb)` -> array (since 0.6.5); 1.x `await onvif.device.getNetworkInterfaces()` -> NetworkInterface[] (token under `.token`, arrays forced for networkInterfaces & manual); node-onvif `services.device.getNetworkInterfaces()`.
- Source: https://www.onvif.org/ver10/schema/onvif.xsd

### SetNetworkInterfaces -- IPv4 (static/DHCP) change

```
soap POST POST {device XAddr}  body: <SetNetworkInterfaces xmlns="http://www.onvif.org/ver10/device/wsdl"><InterfaceToken>{token}</InterfaceToken><NetworkInterface><Enabled xmlns="http://www.onvif.org/ver10/schema">true</Enabled><IPv4 xmlns="http://www.onvif.org/ver10/schema"><Enabled>true</Enabled><Manual><Address>192.168.1.50</Address><PrefixLength>24</PrefixLength></Manual><DHCP>false</DHCP></IPv4></NetworkInterface></SetNetworkInterfaces>
```
- Params: InterfaceToken; NetworkInterface{Enabled?, Link?{AutoNegotiation,Speed,Duplex}, MTU?, IPv4?{Enabled?, Manual*{Address,PrefixLength}, DHCP?}, IPv6?}
- Auth: WRITE_SYSTEM
- Response: SetNetworkInterfacesResponse{RebootNeeded bool}
- Notes: Core 8.2.11 semantics: RebootNeeded=false -> reachable at the new address immediately (wait for Hello); true -> old address until SystemReboot. Faults ter:InvalidNetworkInterface / InvalidIPv4Address / InvalidMtuValue. 0.8.x `cam.setNetworkInterfaces({interfaceToken, networkInterface:{enabled, IPv4:{enabled, manual:{address, prefixLength}, DHCP}}}, (err,{rebootNeeded})=>{})` (manual is a single object, and cam.hostname is rewritten to the new address); 1.x `await onvif.device.setNetworkInterfaces({interfaceToken, networkInterface:{enabled, IPv4:{enabled, manual:[{address, prefixLength}], DHCP}}})` -> {rebootNeeded}. node-onvif: not implemented.
- Source: https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf

### SetNetworkInterfaces -- re-point camera to another WiFi (Dot11)

```
soap POST POST {device XAddr}  body: <SetNetworkInterfaces xmlns="http://www.onvif.org/ver10/device/wsdl"><InterfaceToken>{wifiInterfaceToken}</InterfaceToken><NetworkInterface><Enabled xmlns="http://www.onvif.org/ver10/schema">true</Enabled><Extension xmlns="http://www.onvif.org/ver10/schema"><Dot11><SSID>{hex of SSID bytes, e.g. 486F6D6557694669}</SSID><Mode>Infrastructure</Mode><Alias>{alias, e.g. wifi-backup}</Alias><Priority>{0..31}</Priority><Security><Mode>PSK</Mode><Algorithm>Any</Algorithm><PSK><Passphrase>{8..63 ASCII}</Passphrase></PSK></Security></Dot11></Extension></NetworkInterface></SetNetworkInterfaces>
```
- Params: InterfaceToken of the 802.11 interface (ifType 71); Dot11{SSID hexBinary 1-32 bytes, Mode Ad-hoc|Infrastructure|Extended, Alias tt:Name (unique per interface; reuse to update), Priority 0-31 (higher = preferred), Security{Mode None|WEP|PSK|Dot1X|Extended, Algorithm? CCMP|TKIP|Any|Extended, PSK?{Key? 64-hex | Passphrase? 8-63 chars}, Dot1X? token}}; Dot11 is maxOccurs unbounded (several alternative networks); omit PSK on update to keep the stored one; do not send Link
- Auth: WRITE_SYSTEM
- Response: SetNetworkInterfacesResponse{RebootNeeded bool} -- then optionally SystemReboot; expect the camera to drop off the current WiFi
- Notes: Only valid when Dot11Configuration capability is true. NOT supported by onvif 0.8.3 (builder ignores extension) nor onvif 1.0.0-rc.3 (drops extension.dot11) nor node-onvif; send it raw: 0.8.x `cam._request({service:'device', body: cam._envelopeHeader() + '<SetNetworkInterfaces ...>' + cam._envelopeFooter()}, cb)`; 1.x `await onvif.request({service:'device', body:{SetNetworkInterfaces:{$:{xmlns:'http://www.onvif.org/ver10/device/wsdl'}, InterfaceToken:token, NetworkInterface:{Enabled:{$:{xmlns:'http://www.onvif.org/ver10/schema'},_:true}, Extension:{$:{xmlns:'http://www.onvif.org/ver10/schema'}, Dot11:{SSID:hex, Mode:'Infrastructure', Alias:'backup', Priority:1, Security:{Mode:'PSK', Algorithm:'Any', PSK:{Passphrase:pw}}}}}}}})` -> [data, xml]. Faults: ter:InvalidDot11, ter:InvalidSecurityMode, ter:InvalidStationMode, ter:MissingPSK, ter:MissingDot11. Because the camera will leave the LAN, issue this over the SIM path or accept losing contact until it re-Hellos on the new SSID.
- Source: https://www.onvif.org/ver10/schema/onvif.xsd

### GetDot11Capabilities

```
soap POST POST {device XAddr}  body: <GetDot11Capabilities xmlns="http://www.onvif.org/ver10/device/wsdl"/>
```
- Params: none
- Auth: READ_SYSTEM
- Response: Capabilities{TKIP bool, ScanAvailableNetworks bool, MultipleConfiguration bool, AdHocStationMode bool, WEP bool}
- Notes: Fault ter:InvalidDot11 when WiFi config unsupported. 1.x `await onvif.device.getDot11Capabilities()`; 0.8.x and node-onvif: not implemented (send raw).
- Source: https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf

### GetDot11Status (which SSID am I on, signal)

```
soap POST POST {device XAddr}  body: <GetDot11Status xmlns="http://www.onvif.org/ver10/device/wsdl"><InterfaceToken>{wifiInterfaceToken}</InterfaceToken></GetDot11Status>
```
- Params: InterfaceToken
- Auth: READ_SYSTEM
- Response: Status{SSID hex, BSSID?, PairCipher? CCMP|TKIP|Any|Extended, GroupCipher?, SignalStrength? None|Very Bad|Bad|Good|Very Good|Extended, ActiveConfigAlias}
- Notes: Faults ter:InvalidDot11, ter:NotDot11, ter:InvalidNetworkInterface, ter:NotConnectedDot11 (not associated). 1.x `await onvif.device.getDot11Status({interfaceToken})`. Good for the hub's 'WiFi health' tile.
- Source: https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf

### ScanAvailableDot11Networks (list SSIDs the camera can see)

```
soap POST POST {device XAddr}  body: <ScanAvailableDot11Networks xmlns="http://www.onvif.org/ver10/device/wsdl"><InterfaceToken>{wifiInterfaceToken}</InterfaceToken></ScanAvailableDot11Networks>
```
- Params: InterfaceToken
- Auth: READ_SYSTEM
- Response: Networks[]{SSID hex, BSSID?, AuthAndMangementSuite[]? None|Dot1X|PSK|Extended, PairCipher[]?, GroupCipher[]?, SignalStrength?}
- Notes: Only 'should'; check Dot11Capabilities.ScanAvailableNetworks first; fault ter:NotScanAvailable otherwise. 1.x `await onvif.device.scanAvailableDot11Networks({interfaceToken})` -> [] when none. Decode SSID from hex for display.
- Source: https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf

### SystemReboot

```
soap POST POST {device XAddr}  body: <SystemReboot xmlns="http://www.onvif.org/ver10/device/wsdl"/>
```
- Params: none
- Auth: UNRECOVERABLE (admin)
- Response: SystemRebootResponse{Message string, e.g. 'Rebooting in 30 seconds'}
- Notes: Response is sent before reboot. 1.x `await onvif.device.systemReboot()` -> message string; node-onvif `services.device.reboot()`; 0.8.3 `cam.systemReboot(cb)` is routed via service 'deviceIO' and fails on cameras without a DeviceIO XAddr -- use cam._request({service:'device', ...}) instead.
- Source: https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf

### Media1 GetProfiles

```
soap POST POST {media XAddr}  body: <GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>
```
- Params: none
- Auth: READ_MEDIA
- Response: Profiles[]{@token, @fixed, Name, VideoSourceConfiguration{@token, Name, SourceToken, Bounds}, VideoEncoderConfiguration{Encoding JPEG|MPEG4|H264, Resolution, RateControl,...}, AudioEncoderConfiguration?, PTZConfiguration?{@token, NodeToken, DefaultPTZSpeed, ...}, MetadataConfiguration?}
- Notes: 0.8.x `cam.getProfiles(cb)` (auto-uses Media2 when present and reshapes to the Media1 form); 1.x `await onvif.media.getProfiles()`; node-onvif `services.media.getProfiles()`. Pick the profile with the highest resolution for the viewer and a sub-stream for tiles.
- Source: https://www.onvif.org/ver10/media/wsdl/media.wsdl

### Media1 GetVideoSources (video source tokens for Imaging)

```
soap POST POST {media XAddr}  body: <GetVideoSources xmlns="http://www.onvif.org/ver10/media/wsdl"/>
```
- Params: none
- Auth: READ_MEDIA
- Response: VideoSources[]{@token, Framerate, Resolution{Width,Height}, Imaging{...}}
- Notes: 0.8.x `cam.getVideoSources(cb)`; 1.x `await onvif.media.getVideoSources()`; agsh connect() combines this with profiles into activeSource{sourceToken/videoSourceToken, profileToken, ptz?}.
- Source: https://www.onvif.org/ver10/media/wsdl/media.wsdl

### Media1 GetStreamUri (RTSP URL for go2rtc / viewer)

```
soap POST POST {media XAddr}  body: <GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl"><StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream><Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport></StreamSetup><ProfileToken>{profileToken}</ProfileToken></GetStreamUri>
```
- Params: StreamSetup.Stream RTP-Unicast|RTP-Multicast; StreamSetup.Transport.Protocol UDP|TCP(deprecated)|RTSP|HTTP; ProfileToken
- Auth: READ_MEDIA
- Response: MediaUri{Uri rtsp://..., InvalidAfterConnect false, InvalidAfterReboot false, Timeout PT0S}
- Notes: RTSP URL usually needs the ONVIF user:pass inserted (agsh README does `.replace('://', '://user:pass@')`). 0.8.x `cam.getStreamUri({protocol:'RTSP', stream:'RTP-Unicast', profileToken}, (err,{uri})=>{})`; 1.x `await onvif.media.getStreamUri({protocol:'RTSP', profileToken})` (read res.mediaUri?.uri ?? res.uri); node-onvif `services.media.getStreamUri({ProfileToken, Protocol:'RTSP'})` or `device.getUdpStreamUrl()`.
- Source: https://www.onvif.org/ver10/media/wsdl/media.wsdl

### Media1 GetSnapshotUri (JPEG still for tiles/notifications)

```
soap POST POST {media XAddr}  body: <GetSnapshotUri xmlns="http://www.onvif.org/ver10/media/wsdl"><ProfileToken>{profileToken}</ProfileToken></GetSnapshotUri>
```
- Params: ProfileToken
- Auth: READ_MEDIA
- Response: MediaUri{Uri http://ip/...jpg, InvalidAfterConnect, InvalidAfterReboot, Timeout}
- Notes: Then HTTP GET the Uri with Basic/Digest auth (node-onvif `device.fetchSnapshot()` does this and returns {headers, body Buffer}). 0.8.x `cam.getSnapshotUri({profileToken}, (err,{uri})=>{})`; 1.x `await onvif.media.getSnapshotUri({profileToken})` -> {mediaUri:{uri}}.
- Source: https://www.onvif.org/ver10/media/wsdl/media.wsdl

### Media2 GetProfiles

```
soap POST POST {media2 XAddr}  body: <GetProfiles xmlns="http://www.onvif.org/ver20/media/wsdl"><Type>All</Type></GetProfiles>
```
- Params: Token? (single profile); Type* All|VideoSource|VideoEncoder|AudioSource|AudioEncoder|AudioOutput|AudioDecoder|Metadata|Analytics|PTZ
- Auth: READ_MEDIA
- Response: Profiles[]{@token, @fixed, Name, Configurations{VideoSource, VideoEncoder{Encoding JPEG|H264|H265,...}, AudioSource, AudioEncoder, PTZ, Analytics, Metadata,...}}
- Notes: Only when GetServices lists http://www.onvif.org/ver20/media/wsdl. 1.x `await onvif.media2.getProfiles({type:'All'})`; 0.8.x getProfiles switches automatically when cam.media2Support.
- Source: https://github.com/agsh/onvif/blob/master/src/media2.ts

### Media2 GetStreamUri

```
soap POST POST {media2 XAddr}  body: <GetStreamUri xmlns="http://www.onvif.org/ver20/media/wsdl"><Protocol>RtspUnicast</Protocol><ProfileToken>{profileToken}</ProfileToken></GetStreamUri>
```
- Params: Protocol RtspUnicast|RtspMulticast|RtspsUnicast|RtspsMulticast|RTSP (RTP over TCP)|RtspOverHttp; ProfileToken
- Auth: READ_MEDIA
- Response: GetStreamUriResponse{Uri}
- Notes: Mandatory on Profile T devices. 1.x `await onvif.media2.getStreamUri({protocol:'RtspUnicast', profileToken})` -> {uri}; 0.8.x `cam.getStreamUri({protocol:'RTSP'|'UDP'|'HTTP'})` auto-maps to Media2 protocol names.
- Source: https://www.onvif.org/wp-content/uploads/2018/09/ONVIF_Profile_T_Specification_v1-0.pdf

### Media2 GetSnapshotUri

```
soap POST POST {media2 XAddr}  body: <GetSnapshotUri xmlns="http://www.onvif.org/ver20/media/wsdl"><ProfileToken>{profileToken}</ProfileToken></GetSnapshotUri>
```
- Params: ProfileToken
- Auth: READ_MEDIA
- Response: GetSnapshotUriResponse{Uri}
- Notes: 1.x `await onvif.media2.getSnapshotUri({profileToken})` -> {uri}.
- Source: https://github.com/agsh/onvif/blob/master/src/media2.ts

### PTZ ContinuousMove (touch-and-hold pan/tilt/zoom)

```
soap POST POST {ptz XAddr}  body: <ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>{profileToken}</ProfileToken><Velocity><PanTilt x="0.5" y="0" xmlns="http://www.onvif.org/ver10/schema"/><Zoom x="0" xmlns="http://www.onvif.org/ver10/schema"/></Velocity><Timeout>PT1S</Timeout></ContinuousMove>
```
- Params: ProfileToken; Velocity{PanTilt x,y in -1..1 (generic velocity space), Zoom x in -1..1} (omit an axis to leave it unchanged; optional space attr); Timeout xs:duration (optional; move stops automatically after it)
- Auth: ACTUATE
- Response: ContinuousMoveResponse (empty)
- Notes: Pattern for a touch pad: send ContinuousMove with Timeout ~PT1S on press/repeat every ~500 ms, Stop on release. 0.8.x `cam.continuousMove({x, y, zoom, timeout(ms), profileToken?, onlySendPanTilt?, onlySendZoom?}, cb)`; 1.x `await onvif.ptz.continuousMove({velocity:{x, y, zoom}, timeout: 1000})`; node-onvif `device.ptzMove({speed:{x,y,z}, timeout: 1})` or `services.ptz.continuousMove({ProfileToken, Velocity:{x,y,z}, Timeout})`. Some Sony cameras reject PanTilt+Zoom together (agsh onlySendPanTilt/onlySendZoom flags).
- Source: https://www.onvif.org/ver20/ptz/wsdl/ptz.wsdl

### PTZ Stop

```
soap POST POST {ptz XAddr}  body: <Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>{profileToken}</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>
```
- Params: ProfileToken; PanTilt? bool; Zoom? bool
- Auth: ACTUATE
- Response: StopResponse (empty)
- Notes: 0.8.x `cam.stop({profileToken?, panTilt:true, zoom:true}, cb)`; 1.x `await onvif.ptz.stop()` (defaults both true); node-onvif `device.ptzStop()`.
- Source: https://www.onvif.org/ver20/ptz/wsdl/ptz.wsdl

### PTZ AbsoluteMove

```
soap POST POST {ptz XAddr}  body: <AbsoluteMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>{profileToken}</ProfileToken><Position><PanTilt x="0" y="0" xmlns="http://www.onvif.org/ver10/schema"/><Zoom x="0" xmlns="http://www.onvif.org/ver10/schema"/></Position><Speed><PanTilt x="1" y="1" xmlns="http://www.onvif.org/ver10/schema"/></Speed></AbsoluteMove>
```
- Params: ProfileToken; Position{PanTilt x,y -1..1, Zoom x 0..1 in generic position spaces}; Speed? {PanTilt x,y, Zoom x 0..1}
- Auth: ACTUATE
- Response: AbsoluteMoveResponse (empty)
- Notes: Only if the PTZ node advertises an absolute space (GetNodes/GetConfigurationOptions). 0.8.x `cam.absoluteMove({x, y, zoom, speed?:{x,y,zoom}}, cb)`; 1.x `await onvif.ptz.absoluteMove({position:{x, y, zoom}, speed?})`; node-onvif `services.ptz.absoluteMove({ProfileToken, Position:{x,y,z}, Speed?})`.
- Source: https://www.onvif.org/ver20/ptz/wsdl/ptz.wsdl

### PTZ RelativeMove (nudge)

```
soap POST POST {ptz XAddr}  body: <RelativeMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>{profileToken}</ProfileToken><Translation><PanTilt x="0.1" y="0" xmlns="http://www.onvif.org/ver10/schema"/></Translation></RelativeMove>
```
- Params: ProfileToken; Translation{PanTilt x,y; Zoom x}; Speed?
- Auth: ACTUATE
- Response: RelativeMoveResponse (empty)
- Notes: 0.8.x `cam.relativeMove({x,y,zoom,speed?})`; 1.x `await onvif.ptz.relativeMove({translation:{x,y,zoom}})`; node-onvif `services.ptz.relativeMove`.
- Source: https://www.onvif.org/ver20/ptz/wsdl/ptz.wsdl

### PTZ GetPresets

```
soap POST POST {ptz XAddr}  body: <GetPresets xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>{profileToken}</ProfileToken></GetPresets>
```
- Params: ProfileToken
- Auth: READ_MEDIA
- Response: Preset[]{@token, Name, PTZPosition{PanTilt x,y, Zoom x}}
- Notes: 0.8.x `cam.getPresets({profileToken?}, (err, presetsByName)=>{})` (also fills cam.presets keyed by token); 1.x `await onvif.ptz.getPresets()` -> Record<token, preset>; node-onvif `services.ptz.getPresets({ProfileToken})`.
- Source: https://www.onvif.org/ver20/ptz/wsdl/ptz.wsdl

### PTZ SetPreset

```
soap POST POST {ptz XAddr}  body: <SetPreset xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>{profileToken}</ProfileToken><PresetName>Gate</PresetName></SetPreset>
```
- Params: ProfileToken; PresetName? (optional); PresetToken? (overwrite existing)
- Auth: ACTUATE
- Response: SetPresetResponse{PresetToken}
- Notes: Fails if the camera is moving. 0.8.x `cam.setPreset({presetName, presetToken?}, cb)`; 1.x `await onvif.ptz.setPreset({presetName, presetToken?})` -> token; node-onvif `services.ptz.setPreset({ProfileToken, PresetName?, PresetToken?})`.
- Source: https://www.onvif.org/ver20/ptz/wsdl/ptz.wsdl

### PTZ GotoPreset

```
soap POST POST {ptz XAddr}  body: <GotoPreset xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>{profileToken}</ProfileToken><PresetToken>{presetToken}</PresetToken></GotoPreset>
```
- Params: ProfileToken; PresetToken; Speed? (only if speed spaces exist)
- Auth: ACTUATE
- Response: GotoPresetResponse (empty)
- Notes: 0.8.x `cam.gotoPreset({preset: presetToken, speed?}, cb)` (note the option is named `preset` but takes the TOKEN); 1.x `await onvif.ptz.gotoPreset({presetToken})` (avoid passing speed -- serialised as lowercase <speed>); node-onvif `services.ptz.gotoPreset({ProfileToken, PresetToken, Speed?})`.
- Source: https://www.onvif.org/ver20/ptz/wsdl/ptz.wsdl

### PTZ RemovePreset / GetStatus / GotoHomePosition

```
soap POST POST {ptz XAddr}  bodies: <RemovePreset xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken/><PresetToken/></RemovePreset> | <GetStatus ...><ProfileToken/></GetStatus> | <GotoHomePosition ...><ProfileToken/><Speed?/></GotoHomePosition>
```
- Params: ProfileToken (+PresetToken for RemovePreset)
- Auth: ACTUATE / READ_MEDIA
- Response: empty | PTZStatus{Position{PanTilt,Zoom}, MoveStatus{PanTilt IDLE|MOVING|UNKNOWN, Zoom}, Error?, UtcTime} | empty
- Notes: 0.8.x `cam.removePreset({presetToken})`, `cam.getStatus({profileToken?}, cb)`, `cam.gotoHomePosition({speed?})`; 1.x `onvif.ptz.removePreset({presetToken})`, `getStatus()`, `gotoHomePosition()`; node-onvif equivalents on services.ptz.
- Source: https://www.onvif.org/ver20/ptz/wsdl/ptz.wsdl

### Imaging GetImagingSettings

```
soap POST POST {imaging XAddr}  body: <GetImagingSettings xmlns="http://www.onvif.org/ver20/imaging/wsdl"><VideoSourceToken>{videoSourceToken}</VideoSourceToken></GetImagingSettings>
```
- Params: VideoSourceToken (from GetVideoSources / profile.VideoSourceConfiguration.SourceToken -- not the profile token)
- Auth: READ_MEDIA
- Response: ImagingSettings{BacklightCompensation{Mode,Level}, Brightness, ColorSaturation, Contrast, Exposure{Mode AUTO|MANUAL, Priority, ExposureTime, Gain, Iris,...}, Focus{AutoFocusMode AUTO|MANUAL, DefaultSpeed, NearLimit, FarLimit}, IrCutFilter AUTO|ON|OFF, Sharpness, WideDynamicRange{Mode,Level}, WhiteBalance{Mode,CrGain,CbGain}, Extension{ImageStabilization, IrCutFilterAutoAdjustment}}
- Notes: 0.8.x `cam.getImagingSettings({token?}, cb)`; 1.x `await onvif.imaging.getImagingSettings({videoSourceToken?})` (camelCase result); node-onvif: no imaging service.
- Source: https://www.onvif.org/ver20/imaging/wsdl/imaging.wsdl

### Imaging SetImagingSettings (brightness / IR cut / night mode)

```
soap POST POST {imaging XAddr}  body: <SetImagingSettings xmlns="http://www.onvif.org/ver20/imaging/wsdl"><VideoSourceToken>{videoSourceToken}</VideoSourceToken><ImagingSettings><Brightness xmlns="http://www.onvif.org/ver10/schema">60</Brightness><IrCutFilter xmlns="http://www.onvif.org/ver10/schema">AUTO</IrCutFilter></ImagingSettings><ForcePersistence>true</ForcePersistence></SetImagingSettings>
```
- Params: VideoSourceToken; ImagingSettings (any subset of the ImagingSettings20 fields; ranges from GetOptions); ForcePersistence? bool
- Auth: ACTUATE
- Response: SetImagingSettingsResponse (empty)
- Notes: 0.8.x `cam.setImagingSettings({token?, brightness, colorSaturation, contrast, sharpness, irCutFilter:'AUTO'|'ON'|'OFF', exposure:{mode,...}, focus:{autoFocusMode,...}}, cb)` (falsy/0 values are skipped by the builder); 1.x `await onvif.imaging.setImagingSettings({videoSourceToken?, imagingSettings:{brightness:60, irCutFilter:'AUTO'}, forcePersistence:true})`; use `onvif.imaging.getOptions()` for valid ranges.
- Source: https://www.onvif.org/ver20/imaging/wsdl/imaging.wsdl

### Imaging Move / Stop (focus)

```
soap POST POST {imaging XAddr}  body: <Move xmlns="http://www.onvif.org/ver20/imaging/wsdl"><VideoSourceToken>{videoSourceToken}</VideoSourceToken><Focus><Continuous xmlns="http://www.onvif.org/ver10/schema"><Speed>0.5</Speed></Continuous></Focus></Move>  |  <Stop xmlns="...imaging/wsdl"><VideoSourceToken/></Stop>
```
- Params: VideoSourceToken; Focus{Absolute{Position,Speed?} | Relative{Distance,Speed?} | Continuous{Speed}} (check GetMoveOptions)
- Auth: ACTUATE
- Response: empty
- Notes: 0.8.x `cam.imagingMove({token?, continuous:{speed}}|{absolute:{position,speed}}|{relative:{distance,speed}}, cb)`, `cam.imagingStop({token?}, cb)`, `cam.imagingGetMoveOptions`, `cam.imagingGetStatus`; 1.x `onvif.imaging.move({focus:{continuous:{speed}}})`, `stop()`, `getMoveOptions()`, `getStatus()`.
- Source: https://www.onvif.org/ver20/imaging/wsdl/imaging.wsdl

### Events GetEventProperties (discover topics such as motion)

```
soap POST POST {events XAddr}  body: <GetEventProperties xmlns="http://www.onvif.org/ver10/events/wsdl"/>
```
- Params: none
- Auth: READ_MEDIA
- Response: TopicNamespaceLocation[], FixedTopicSet, TopicSet (tree of tns1 topics with wstop:topic attrs, e.g. VideoSource/MotionAlarm, RuleEngine/CellMotionDetector/Motion, Device/Trigger/DigitalInput), TopicExpressionDialect[], MessageContentFilterDialect[] (must include http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter on Profile T)
- Notes: 0.8.x `cam.getEventProperties(cb)` (also stored in cam.events.properties); 1.x `await onvif.events.getEventProperties()`; node-onvif `services.events.getEventProperties()` (its only events method).
- Source: https://www.onvif.org/ver10/events/wsdl/event.wsdl

### Events CreatePullPointSubscription

```
soap POST POST {events XAddr}  body: <CreatePullPointSubscription xmlns="http://www.onvif.org/ver10/events/wsdl" xmlns:tns1="http://www.onvif.org/ver10/topics" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"><Filter><wsnt:TopicExpression Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:VideoSource/MotionAlarm</wsnt:TopicExpression></Filter><InitialTerminationTime>PT2M</InitialTerminationTime></CreatePullPointSubscription>
```
- Params: Filter? (wsnt:TopicExpression with ConcreteSet dialect, may list several topics separated by |; wsnt:MessageContent with ItemFilter dialect XPath); InitialTerminationTime? (xs:duration or absolute UTC dateTime); SubscriptionPolicy? {tev:ChangedOnly}
- Auth: READ_MEDIA
- Response: SubscriptionReference{Address (unique per pull point, e.g. http://ip/onvif/Subscription?Idx=0), ReferenceParameters? (Axis: SubscriptionId)}, CurrentTime (UTC 'Z'), TerminationTime (UTC 'Z')
- Notes: Core 9.1.1; no Filter = all events. 0.8.x `cam.createPullPointSubscription(cb)` (fixed PT2M, no filter); 1.x `await onvif.events.createPullPointSubscription({filter:{topicExpression:[{expression:'tns1:VideoSource/MotionAlarm', dialect:'http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet'}]}, initialTerminationTime:'PT4M'})` or `new Subscription(onvif, {filter}).subscribe()`; Profile T devices support >= 2 concurrent pull points.
- Source: https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf

### Events PullMessages (long-poll; the hub's notification source)

```
soap POST POST {SubscriptionReference.Address}  header: <wsa:Action>http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest</wsa:Action><wsa:To>{SubscriptionReference.Address}</wsa:To> (+ Axis SubscriptionId reference parameter if returned)  body: <PullMessages xmlns="http://www.onvif.org/ver10/events/wsdl"><Timeout>PT1M</Timeout><MessageLimit>10</MessageLimit></PullMessages>
```
- Params: Timeout xs:duration (device must accept >= PT1M; HTTP socket timeout must exceed it); MessageLimit int
- Auth: READ_MEDIA (same credentials, WS-Security header again)
- Response: PullMessagesResponse{CurrentTime, TerminationTime, NotificationMessage*{Topic Dialect=... 'tns1:VideoSource/MotionAlarm', Message/tt:Message{@UtcTime, @PropertyOperation Initialized|Changed|Deleted, Source{SimpleItem @Name @Value e.g. VideoSourceConfigurationToken}, Key?, Data{SimpleItem @Name='State'|'IsMotion' @Value='true'}}}} -- empty list only on timeout
- Notes: Core 9.1.2 verbatim rules: immediate return when messages exist, otherwise blocks until a message or Timeout. 0.8.x runs this loop for you on `cam.on('event', (msg, xml) => ...)` (msg.topic._ and msg.message.message.data.simpleItem.$.{Name,Value}); manual `cam.pullMessages({messageLimit}, cb)`. 1.x `onvif.on('event', msg => ...)` or `sub.on('data', msg => msg.topic._, msg.message.message.data)`; manual `sub.pullMessages({timeout:'PT1M', messageLimit:10})`. Use PropertyOperation=Changed + Data IsMotion/State=true to fire the phone notification; the Initialized burst after subscribe is the current state, not new activity.
- Source: https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf

### Events Renew / Unsubscribe / SetSynchronizationPoint

```
soap POST POST {SubscriptionReference.Address}  Renew: header wsa:Action http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest, body <Renew xmlns="http://docs.oasis-open.org/wsn/b-2"><TerminationTime>PT2M</TerminationTime></Renew>  |  Unsubscribe: wsa:Action http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest, body <Unsubscribe xmlns="http://docs.oasis-open.org/wsn/b-2"/>  |  SetSynchronizationPoint: wsa:Action http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/SetSynchronizationPointRequest, body <SetSynchronizationPoint xmlns="http://www.onvif.org/ver10/events/wsdl"/>
```
- Params: Renew: TerminationTime duration or UTC dateTime
- Auth: READ_MEDIA
- Response: RenewResponse{TerminationTime, CurrentTime} | UnsubscribeResponse | SetSynchronizationPointResponse (then all property states are re-sent with PropertyOperation=Initialized)
- Notes: 0.8.x `cam.renew(cb)`, `cam.unsubscribe(cb, preserveListeners)`; 1.x Subscription `renew()`, `unsubscribe()`, `setSynchronizationPoint()`; the built-in loops renew after every pull because Axis does not extend TerminationTime otherwise. Pull points may not survive a camera power cycle (Core 9.1.6) -- recreate on error.
- Source: https://www.onvif.org/ver10/events/wsdl/event.wsdl

### Events Subscribe (push / WS-BaseNotification, optional)

```
soap POST POST {events XAddr}  header wsa:Action http://docs.oasis-open.org/wsn/bw-2/NotificationProducer/SubscribeRequest  body: <Subscribe xmlns="http://docs.oasis-open.org/wsn/b-2"><ConsumerReference><a:Address>http://{hubIp}:{port}/onvif-events</a:Address></ConsumerReference><InitialTerminationTime>PT2M</InitialTerminationTime></Subscribe>
```
- Params: ConsumerReference URL the camera can reach (LAN only); InitialTerminationTime; Filter?
- Auth: READ_MEDIA
- Response: SubscribeResponse{SubscriptionReference, CurrentTime, TerminationTime}; camera then HTTP POSTs wsnt:Notify envelopes to the consumer URL
- Notes: 0.8.x `cam.subscribe({url}, cb)` + `cam.parseEventXML(xml, cb)`; 1.x `await onvif.events.subscribe({url, terminationTime?, filter?, renew:true})`. Not usable over the SIM path (camera cannot reach the hub); prefer pull point.
- Source: https://github.com/agsh/onvif/blob/master/src/events.ts

## Facts

- **The device management service entry point is fixed to /onvif/device_service and is the target of WS-Discovery; every ONVIF device must provide the device management and event services.** [high] Core Spec 5.1.1: 'The entry point for the device management service is fixed to: /onvif/device_service'. 5.1.2: 'An ONVIF compliant device shall provide the device management and event service.' (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf)
- **Authentication is HTTP Digest (RFC 2617/7616) or, on legacy devices, WS-Security UsernameToken with PasswordDigest = Base64(SHA1(nonce + created + password)); the client must know the camera's clock offset because nonce/timestamp are checked.** [high] Core Spec 5.12: services 'shall be protected using digest authentication according to [RFC 2617] with the following exceptions: Legacy devices supporting [WS-UsernameToken]...'; 'A client shall use both nonce and timestamps as defined in [WS-UsernameToken]'. agsh/onvif computes timeShift from an unauthenticated GetSystemDateAndTime (PRE_AUTH) before any other call and defaults useWSSecurity=true, with HTTP Digest when useWSSecurity=false. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf)
- **WS-Discovery: devices default to discoverable mode, answer multicast Probe messages, and send Hello when they join the network (including after an IP change); the ProbeMatch carries XAddrs (device service URLs, one per scheme/IP) and Scopes of the form onvif://www.onvif.org/<path>.** [high] Core Spec 7.2, 7.3.2.2 (scopes Profile/Location/Hardware/Name/MacAddress/SerialNumber; 'A device shall include at least one fixed entry ... of the profile, hardware and name categories'), 7.3.2.3 ('A device shall include the <d:XAddrs> element with the address(es) for the device service in the Hello message'), 7.3.3 (XAddrs in ProbeMatch). Normative ref: WS-Discovery April 2005, namespace http://schemas.xmlsoap.org/ws/2005/04/discovery. Endpoint reference uses urn:uuid (7.3.1). (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf)
- **The concrete Probe used by every Node library is a SOAP 1.2 envelope sent by UDP to 239.255.255.250:3702 with wsa:Action http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe, wsa:To urn:schemas-xmlsoap-org:ws:2005:04:discovery and <Types>dn:NetworkVideoTransmitter</Types> (dn = http://www.onvif.org/ver10/network/wsdl).** [high] agsh/onvif src/discovery.ts (1.x) and lib/discovery.js (0.8.x) build exactly this envelope and call socket.send(request, 0, request.length, 3702, '239.255.255.250'); node-onvif additionally probes for dp0:Device and dp0:NetworkVideoDisplay. The Core Spec itself only requires tds:Device in Hello Types (7.3.2.1). (https://github.com/agsh/onvif/blob/master/src/discovery.ts)
- **GetServices(IncludeCapability) returns one tds:Service per service with Namespace, XAddr, Version and optional Capabilities; XAddr matches the scheme and IP of the request, but a device behind NAT may return its local address. GetCapabilities(Category) is the backward-compatible form.** [high] Core Spec 8.1.2.2 and 8.1.2.4; devicemgmt.wsdl tds:GetServices{IncludeCapability xs:boolean} -> tds:GetServicesResponse{Service[]}; tds:GetCapabilities{Category tt:CapabilityCategory*} -> Capabilities. Service namespaces: device http://www.onvif.org/ver10/device/wsdl, media http://www.onvif.org/ver10/media/wsdl, media2 http://www.onvif.org/ver20/media/wsdl, ptz http://www.onvif.org/ver20/ptz/wsdl, imaging http://www.onvif.org/ver20/imaging/wsdl, events http://www.onvif.org/ver10/events/wsdl. (https://www.onvif.org/ver10/device/wsdl/devicemgmt.wsdl)
- **GetDeviceInformation returns Manufacturer, Model, FirmwareVersion, SerialNumber, HardwareId (access class READ_SYSTEM).** [high] Core Spec 8.3.1; devicemgmt.wsdl tds:GetDeviceInformationResponse. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf)
- **GetNetworkInterfaces returns tt:NetworkInterface[] (token attribute, Enabled, Info{Name,HwAddress,MTU}, Link{AdminSettings,OperSettings,InterfaceType}, IPv4{Enabled,Config{Manual[],LinkLocal,FromDHCP,DHCP}}, IPv6, Extension{InterfaceType, Dot3[], Dot11[]}); for an 802.11 interface the device reports IANA ifType 71 (ieee80211) and omits the Link element.** [high] onvif.xsd complexType NetworkInterface / NetworkInterfaceExtension (line ~2533-2580); Core Spec 8.2.22: 'shall as a response to the GetNetworkInterfaces method return ieee80211 (71) as the IANA-IfTypes for the 802.11 interface(s). A device shall not return any link element in the GetNetworkInterfaces reply and it shall ignore any Link element in the SetNetworkInterfaces request.' Profile S 7.4.3 makes GetNetworkInterfaces/SetNetworkInterfaces mandatory for devices. (https://www.onvif.org/ver10/schema/onvif.xsd)
- **SetNetworkInterfaces(InterfaceToken, NetworkInterface{Enabled?,Link?,MTU?,IPv4?{Enabled?,Manual[]{Address,PrefixLength},DHCP?},IPv6?,Extension?{Dot3[],Dot11[]}}) returns RebootNeeded; if false the device is reachable at the new address at once (may be briefly unresponsive until it sends Hello), if true the old address stays active until SystemReboot.** [high] Core Spec 8.2.11 verbatim: 'If a device responds with RebootNeeded set to false, the device can be reached via the new IP address without further action... If a device responds with RebootNeeded set to true, it will be further available under its previous IP address. The settings will only be activated when the device is rebooted via the SystemReboot command. For interoperability with a client unaware of the IEEE 802.11 extension a device shall retain its IEEE 802.11 configuration if the IEEE 802.11 configuration element isn't present in the request.' Faults include ter:InvalidNetworkInterface, ter:InvalidMtuValue, ter:InvalidIPv4Address, ter:InvalidDot11 (802.11 not supported), ter:InvalidSecurityMode, ter:InvalidStationMode, ter:MissingDot11, ter:MissingPSK, ter:MissingDot1X. XSD: NetworkInterfaceSetConfiguration / NetworkInterfaceSetConfigurationExtension. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf)
- **tt:Dot11Configuration = { SSID: hexBinary 1..32 bytes (NOT a plain string), Mode: 'Ad-hoc'|'Infrastructure'|'Extended', Alias: tt:Name, Priority: integer 0..31 (higher wins), Security: { Mode: 'None'|'WEP'|'PSK'|'Dot1X'|'Extended', Algorithm?: 'CCMP'|'TKIP'|'Any'|'Extended', PSK?: { Key?: hexBinary 32 bytes (64 hex chars), Passphrase?: 8..63 printable ASCII }, Dot1X?: ReferenceToken } }.** [high] onvif.xsd lines 3228-3335: Dot11SSIDType restriction base xs:hexBinary minLength 1 maxLength 32; Dot11PSK hexBinary length 32; Dot11PSKPassphrase pattern [ -~]{8,63}; 'Either Key or Passphrase shall be given, if both are supplied Key shall be used by the device and Passphrase ignored... If only Passphrase is supplied the Key shall be derived using the algorithm described in IEEE802.11-2007 section H.4'. So the hub must hex-encode the SSID bytes (e.g. 'HomeWiFi' -> 486F6D6557694669). (https://www.onvif.org/ver10/schema/onvif.xsd)
- **802.11 rules: the device must support Infrastructure mode, security modes None and PSK, cipher CCMP (TKIP optional, WEP out of scope), manual (CCMP/TKIP) and automatic ('Any') algorithm selection; multiple WiFi configs per interface are identified by Alias and prioritised by Priority; the device never returns the PSK in GetNetworkInterfaces; on ADD a PSK is required, on UPDATE omitting the PSK retains the stored one.** [high] Core Spec 8.2.22.1-8.2.22.4.2 verbatim: 'The client shall supply the alias in the SetNetworkInterfaces request. If the client wants to update an existing wireless configuration the same alias shall be used.' 'it shall not return the PSK in a response to a GetNetworkInterfaces operation call.' 'A client shall include a PSK value in the SetNetworkInterfaces request [when adding]'; 'The device receiving a SetNetworkInterfaces request without a PSK value shall retain its PSK value'. These requirements apply only to devices that signal the Network Dot11Configuration capability. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf)
- **WiFi support is feature-detected from GetServiceCapabilities (device service) Network.Dot11Configuration boolean attribute (or GetCapabilities Device/Network/Extension/Dot11Configuration); if false, all Dot11 operations fault with ter:InvalidDot11. Neither Profile S nor Profile T mandates 802.11 configuration.** [high] onvif.xsd NetworkCapabilities has element Dot11Configuration xs:boolean; Core Spec Annex example '<tds:Network IPFilter="false" ZeroConfiguration="true" IPVersion6="false" DynDNS="false" Dot11Configuration="false" HostnameFromDHCP="false" NTP="0" />'. Grep of Profile S v1.3 and Profile T v1.0 texts finds no 802.11/Dot11/wireless requirement. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf)
- **GetDot11Capabilities (empty request) returns {TKIP, ScanAvailableNetworks, MultipleConfiguration, AdHocStationMode, WEP} booleans; GetDot11Status(InterfaceToken) returns {SSID (shall), BSSID, PairCipher, GroupCipher, SignalStrength: 'None'|'Very Bad'|'Bad'|'Good'|'Very Good'|'Extended', ActiveConfigAlias (shall)}; ScanAvailableDot11Networks(InterfaceToken) returns Networks[]{SSID, BSSID, AuthAndMangementSuite[] ('None'|'Dot1X'|'PSK'|'Extended'), PairCipher[], GroupCipher[], SignalStrength} and is only 'should'-level (capability ScanAvailableNetworks; fault ter:NotScanAvailable).** [high] Core Spec 8.2.22.5-8.2.22.7 and Table 10; onvif.xsd Dot11Capabilities, Dot11Status, Dot11AvailableNetworks, Dot11SignalStrength, Dot11AuthAndMangementSuite (sic, misspelled in the schema). Faults: ter:InvalidDot11, ter:NotDot11, ter:InvalidNetworkInterface, ter:NotConnectedDot11, ter:NotScanAvailable. Access class READ_SYSTEM. (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf)
- **SystemReboot (empty request) returns a Message string such as 'Rebooting in x seconds'; the response is sent before the reboot; access class UNRECOVERABLE.** [high] Core Spec 8.3.13 verbatim: 'This operation reboots a device. Before the device reboots the response message shall be sent. The device shall support reboot through the SystemReboot command.' (https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf)
- **Media (ver10, Profile S): GetProfiles returns tt:Profile[] (token attr, Name, VideoSourceConfiguration.SourceToken, VideoEncoderConfiguration, PTZConfiguration...); GetStreamUri(StreamSetup{Stream 'RTP-Unicast'|'RTP-Multicast', Transport{Protocol 'UDP'|'TCP'(deprecated)|'RTSP'|'HTTP'}}, ProfileToken) returns MediaUri{Uri, InvalidAfterConnect, InvalidAfterReboot, Timeout}; GetSnapshotUri(ProfileToken) returns a MediaUri to an HTTP JPEG.** [high] media.wsdl target namespace http://www.onvif.org/ver10/media/wsdl; onvif.xsd StreamSetup/StreamType/Transport/TransportProtocol/MediaUri ('Uri: Stable Uri to be used for requesting the media stream'; Timeout 'PT0S to indicate that this stream URI is indefinitely valid'). Profile S 7.x: GetStreamUri Media M for devices; Profile T 1.0: GetStreamUri is Media 2 M. (https://www.onvif.org/ver10/media/wsdl/media.wsdl)
- **Media2 (ver20, Profile T): GetProfiles(Type='All'), GetStreamUri(Protocol 'RtspUnicast'|'RtspMulticast'|'RtspsUnicast'|'RtspsMulticast'|'RTSP'|'RtspOverHttp', ProfileToken) returns {Uri}; GetSnapshotUri(ProfileToken) returns {Uri}; Profile T devices must answer GetStreamUri on Media2 and provide a JPEG snapshot URI.** [high] agsh/onvif src/interfaces/media.2.ts TransportProtocol union and src/media2.ts getStreamUri; Profile T v1.0 lines 809/866 ('Device shall return the stream URI in response to the GetStreamUri operation', 'GetStreamUri Media 2 M') and 1524 ('Device shall provide a JPEG snapshot URI in response to the GetSnapshotUri operation'). agsh detects Media2 when GetServices lists namespace ver20/media and maps Media1 options (HTTP->RtspOverHttp, UDP+RTP-Unicast->RtspUnicast, UDP+RTP-Multicast->RtspMulticast, else RTSP). (https://www.onvif.org/wp-content/uploads/2018/09/ONVIF_Profile_T_Specification_v1-0.pdf)
- **PTZ (ver20): ContinuousMove{ProfileToken, Velocity: PTZSpeed{PanTilt x,y; Zoom x}, Timeout? xs:duration}; Stop{ProfileToken, PanTilt? bool, Zoom? bool}; AbsoluteMove{ProfileToken, Position: PTZVector, Speed?}; RelativeMove{ProfileToken, Translation, Speed?}; GotoPreset{ProfileToken, PresetToken, Speed?}; SetPreset{ProfileToken, PresetName?, PresetToken?} -> PresetToken; GetPresets -> Preset[]{token, Name, PTZPosition}; RemovePreset; GetStatus -> PTZStatus; GotoHomePosition. PanTilt/Zoom elements live in the tt namespace with x/y attributes and an optional 'space' attribute; omitting PanTilt or Zoom leaves that axis unaffected.** [high] ptz.wsdl target namespace http://www.onvif.org/ver20/ptz/wsdl (docs quoted verbatim: 'Set true when we want to stop ongoing pan and tilt movements'; 'The SetPreset command saves the current device position parameters...'); onvif.xsd PTZSpeed: 'If omitted in a request, the current (if any) PanTilt movement should not be affected.' Value ranges depend on the space; the generic spaces used by both libraries are pan/tilt -1..1 and zoom 0..1 (absolute) / -1..1 (velocity) per agsh JSDoc. Profile S: PTZ is conditional ('if supported'), ContinuousMove M for devices that have PTZ; Profile T: 'Device shall support the ContinuousMove and Stop operations' in the PTZ section. (https://www.onvif.org/ver20/ptz/wsdl/ptz.wsdl)
- **Imaging (ver20) is keyed by the VIDEO SOURCE token (from GetVideoSources or profile.VideoSourceConfiguration.SourceToken), not the profile token: GetImagingSettings(VideoSourceToken) -> ImagingSettings20{BacklightCompensation, Brightness, ColorSaturation, Contrast, Exposure, Focus, IrCutFilter, Sharpness, WideDynamicRange, WhiteBalance, Extension{ImageStabilization, IrCutFilterAutoAdjustment}}; SetImagingSettings(VideoSourceToken, ImagingSettings, ForcePersistence?); GetOptions; Move(VideoSourceToken, Focus{Absolute|Relative|Continuous}); Stop; GetStatus; GetMoveOptions.** [high] imaging.wsdl target namespace http://www.onvif.org/ver20/imaging/wsdl; onvif.xsd ImagingSettings20 ('The supported options and ranges can be obtained via the GetOptions command'). (https://www.onvif.org/ver20/imaging/wsdl/imaging.wsdl)
- **Events pull-point: CreatePullPointSubscription{Filter?, InitialTerminationTime?, SubscriptionPolicy?} -> {SubscriptionReference{Address, ReferenceParameters?}, CurrentTime, TerminationTime}; PullMessages{Timeout xs:duration, MessageLimit int} is POSTed to the SubscriptionReference address and long-polls: returns immediately with waiting messages, or with new messages as they occur, or with zero messages only when Timeout elapses; devices must support Timeout >= 1 minute; Renew/Unsubscribe go to the same address (WS-BaseNotification SubscriptionManager); a pull point lives until TerminationTime or Unsubscribe and is not guaranteed to survive a power cycle.** [high] Core Spec 9.1.1, 9.1.2 ('The device shall support a Timeout of at least one minute... The device shall not return a response with zero messages prior to reaching the Timeout.'), 9.1.6; sample request 9.10.5 uses wsa:Action http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest and wsa:To <subscription address>. event.wsdl: PullMessagesResponse{CurrentTime, TerminationTime, NotificationMessage*}. Profile S 7.7: pull point M for devices; Profile T 7.7: SetSynchronizationPoint, CreatePullPointSubscription, PullMessages, GetEventProperties, Unsubscribe, Filter parameter and ItemFilter dialect all M, at least two concurrent pull points. (https://www.onvif.org/ver10/events/wsdl/event.wsdl)
- **Profile T devices must emit the motion event topic tns1:VideoSource/MotionAlarm (tns1 = http://www.onvif.org/ver10/topics); many Profile S cameras instead use tns1:RuleEngine/CellMotionDetector/Motion (data SimpleItem Name='IsMotion'). Topic filters use dialect http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet; message-content filters use http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter.** [high] Profile T v1.0 7.20 'Device shall generate Motion Alarm events... tns1:VideoSource/MotionAlarm Event M'; agsh innerDocs/events.md example filter uses 'tns1:RuleEngine/CellMotionDetector/Motion' with the ConcreteSet dialect; Profile T 7.7.1 mandates the ItemFilter dialect. Use GetEventProperties (TopicSet) to enumerate what a given camera actually emits. (https://www.onvif.org/wp-content/uploads/2018/09/ONVIF_Profile_T_Specification_v1-0.pdf)
- **npm 'onvif' (agsh/onvif) dist-tags: latest = 0.8.3 (published 2026-09-07), rc = 1.0.0-rc.3 (published 2026-09-24), legacy = 0.8.1; licence MIT; repository git+https://github.com/agsh/onvif.git.** [high] npm view onvif dist-tags/time. 0.8.3: main lib/onvif.js, types index.d.ts, JS callback API (`Cam`) plus `onvif/promises`. 1.0.0-rc.3: main build/index.js, types build/index.d.ts, single runtime dependency fast-xml-parser ^5.11, engines node >=18, TypeScript Promise API (`Onvif` class, lazy service modules) plus `onvif/compatibility` and `onvif/compatibility/promises` re-implementing the 0.x Cam shape. CHANGELOG calls 0.8.2 'Probably the last stable v0.x before v1'. (https://www.npmjs.com/package/onvif)
- **onvif@0.8.3 exposes (Cam.prototype, callback style, promisified in onvif/promises): getDeviceInformation, getCapabilities (sends Category=All), getServices(includeCapability?, cb), getNetworkInterfaces (always an array), setNetworkInterfaces({interfaceToken, networkInterface}), systemReboot, getSystemDateAndTime, getScopes/setScopes, getHostname, getDNS/setDNS, getNTP/setNTP, getNetworkProtocols, getNetworkDefaultGateway/setNetworkDefaultGateway, getUsers/createUsers/setUsers/deleteUsers, getProfiles, getVideoSources, getStreamUri({stream?,protocol?,profileToken?}), getSnapshotUri({profileToken?}), continuousMove, absoluteMove, relativeMove, stop, getPresets, gotoPreset, setPreset, removePreset, gotoHomePosition, setHomePosition, getStatus, getNodes, getConfigurations, getImagingSettings, setImagingSettings, imagingMove, imagingStop, imagingGetStatus, imagingGetMoveOptions, getEventProperties, createPullPointSubscription, pullMessages, renew, unsubscribe, subscribe (push), plus Discovery.probe.** [high] Verified by grepping Cam.prototype.* in lib/cam.js, lib/device.js, lib/media.js, lib/ptz.js, lib/imaging.js, lib/events.js and Discovery.probe in lib/discovery.js of the published onvif-0.8.3.tgz. Cam options: {hostname, username, password, port (80/443), path ('/onvif/device_service'), timeout (120000), useSecure, secureOpts, useWSSecurity (default true; false = HTTP Digest), autoconnect (true), preserveAddress, agent}. (https://registry.npmjs.org/onvif/-/onvif-0.8.3.tgz)
- **onvif@0.8.3 setNetworkInterfaces does NOT support Dot11: the XML builder emits only Enabled, Link{AutoNegotiation,Speed,Duplex}, MTU, IPv4{Enabled, Manual{Address,PrefixLength} (single object, not array), DHCP} and IPv6; the JSDoc typedef documents extension.dot11.{SSID,mode,alias,priority,security{mode,algorithm,PSK{key,passphrase},dot1X}} and index.d.ts declares `extension?: object`, but the value is never serialised. There are no getDot11Capabilities/getDot11Status/scanAvailableDot11Networks methods in 0.8.3.** [high] lib/device.js Cam.prototype.setNetworkInterfaces builds the body by string concatenation with no <Extension>/<Dot11> branch; grep -i dot11 across lib/*.js matches only JSDoc comment lines 158-166. index.d.ts NetworkInterfaceOptions.networkInterface.extension?: object. Callback receives {rebootNeeded}. Workaround: cam._request({service:'device', body: cam._envelopeHeader() + '<SetNetworkInterfaces xmlns="http://www.onvif.org/ver10/device/wsdl">...' + cam._envelopeFooter()}, cb). (https://registry.npmjs.org/onvif/-/onvif-0.8.3.tgz)
- **onvif@1.0.0-rc.3 (TypeScript) exposes device.getDot11Capabilities(), device.getDot11Status({interfaceToken}) and device.scanAvailableDot11Networks({interfaceToken}) (returns networks[] or []), and device.setNetworkInterfaces({interfaceToken, networkInterface}) typed with extension?.dot11?: Dot11Configuration[] -- but the implementation serialises only Enabled/Link/MTU/IPv4/IPv6, so a dot11 block passed in options is silently dropped.** [high] src/device.ts lines 545-600 (SetNetworkInterfaces body has no Extension mapping) and 1086-1106 (Dot11 getters); src/interfaces/onvif.ts NetworkInterfaceSetConfigurationExtension{dot3?, dot11?: Dot11Configuration[]}, Dot11Configuration{SSID: Dot11SSIDType (typed as unknown), mode, alias, priority, security{mode, algorithm?, PSK?{key?, passphrase?}, dot1X?}}. Return {rebootNeeded}; on a manual IPv4/IPv6 change the library rewrites onvif.hostname to the new address. Same gap exists in the compatibility Cam (src/compatibility/cam.ts delegates to device.setNetworkInterfaces). (https://github.com/agsh/onvif/blob/master/src/device.ts)
- **onvif@1.x provides a raw escape hatch: onvif.request({service:'device', body:{Operation:{$:{xmlns:...}, ...children}}}) builds the SOAP envelope (WS-Security header + body) with fast-xml-parser, where '$' holds attributes, resolves [data, xml] and derives the SOAP action from body[op].$.xmlns ?? XMLNS[service]. Service.request() (used by all typed methods) auto-injects $.xmlns for the service; a direct onvif.request must set it explicitly.** [high] src/onvif.ts request()/envelopeBody()/envelopeHeader(), src/service.ts XMLNS map and Service.request (body[root].$ = {xmlns: this.xmlns, ...}), src/utils.ts soapActionFromBody. OnvifRequestOptions: {service?, body, url?, timeout?, soapHeaders?, array?, rawXML?}. Because onvif.xsd is elementFormDefault="qualified", children of NetworkInterface belong to http://www.onvif.org/ver10/schema; 0.8.x sets xmlns on each direct child (Enabled/Link/MTU/IPv4/IPv6) while 1.x lets them inherit the tds namespace, which strict (gSOAP) devices may reject -- set $.xmlns='http://www.onvif.org/ver10/schema' on Enabled/IPv4/Extension when hand-building the Dot11 body. (https://github.com/agsh/onvif/blob/master/src/onvif.ts)
- **onvif@1.x method surface for the hub: new Onvif({hostname, username, password, port?, path?, timeout?, useSecure?, secureOptions?, useWSSecurity? (default true), agent?, preserveAddress?, autoConnect?, urn?, xaddrs?}); await onvif.connect() (GetSystemDateAndTime -> GetServices/GetCapabilities -> GetProfiles+GetVideoSources -> activeSource); onvif.device.*, onvif.media.getProfiles()/getProfile({profileToken})/getVideoSources()/getStreamUri({profileToken?, stream?, protocol?})/getSnapshotUri({profileToken?}); onvif.media2.getProfiles({type?})/getStreamUri({protocol?, profileToken?})/getSnapshotUri({profileToken?}); onvif.ptz.continuousMove({velocity, timeout?, profileToken?})/stop({profileToken?, panTilt?, zoom?})/absoluteMove({position, speed?, profileToken?})/relativeMove({translation, speed?})/gotoPreset({presetToken, speed?, profileToken?})/setPreset({presetName?, presetToken?, profileToken?})/getPresets()/removePreset({presetToken})/getStatus()/gotoHomePosition()/getNodes()/getConfigurations(); onvif.imaging.getImagingSettings({videoSourceToken?})/setImagingSettings({videoSourceToken?, imagingSettings, forcePersistence?})/getOptions()/move({videoSourceToken?, focus})/stop()/getStatus()/getMoveOptions(); onvif.events.createPullPointSubscription({filter?, initialTerminationTime?, subscriptionPolicy?})/getEventProperties()/subscribe({url, terminationTime?, filter?, renew?}) plus the Subscription class; Discovery.probe({timeout?, resolve?, messageId?, device?, listeningPort?, type?, bufferSize?}) -> Promise<Onvif[]>.** [high] Verified in src/onvif.ts (OnvifOptions, constructor defaults), src/media.ts (GetStreamUriOptions: stream 'RTP-Unicast'|'RTP-Multicast'; protocol 'RtspUnicast'|'RtspMulticast'|'RTSP'|'RtspOverHttp'|'UDP'|'TCP'|'HTTP'), src/media2.ts, src/ptz.ts (velocity/position accept {x,y,zoom} or {pan,tilt,zoom} simple vectors or full PTZSpeed/PTZVector; timeout number = ms -> 'PT<s>S' or ISO string; stop defaults panTilt=true, zoom=true; setPreset returns the token string; getPresets returns Record<token, preset>), src/imaging.ts, src/events.ts, src/discovery.ts. profileToken defaults to onvif.activeSource.profileToken; videoSourceToken defaults to activeSource.videoSourceToken. (https://github.com/agsh/onvif/blob/master/src/ptz.ts)
- **Event loop in both onvif versions: adding a listener with cam.on('event', ...) (0.8.x) / onvif.on('event', ...) (1.x) automatically creates a pull-point subscription (InitialTerminationTime PT2M in 0.8.x; 4 min in 1.x), long-polls PullMessages with Timeout PT1M and MessageLimit 10 (socket reply timeout 80 s / timeout+2 s), Renews after each pull (Axis needs it), echoes the Axis SubscriptionId reference parameter, and reconnects with exponential back-off (10 ms x1.111 up to 2 min in 0.8.x; 1 s..2 min in 1.x); removing the last listener unsubscribes. 1.x additionally offers new Subscription(onvif, {filter:{topicExpression:[{expression, dialect}], messageContent?}}) with 'data'/'error'/'connectionError' events and explicit pullMessages/renew/setSynchronizationPoint/unsubscribe.** [high] lib/events.js (_eventRequest/_eventPull/_restartEventRequest, pullMessages body '<Timeout>PT1M</Timeout><MessageLimit>10</MessageLimit>', replyTimeout 80000) and lib/cam.js newListener hook in 0.8.3; src/events.ts Subscription class, PULL_TIMEOUT='PT1M', MESSAGE_LIMIT=10, PULL_TERMINATION_TIME=4*PT1M, MIN/MAX_EVENT_RECONNECT_MS, and src/onvif.ts newListener/removeListener hooks in 1.x. Emitted message shape (1.x NotificationMessage): {topic:{_: 'tns1:...', dialect?}, message:{message:{utcTime: Date, propertyOperation?: 'Initialized'|'Changed'|'Deleted', source?, key?, data?}}}; 0.8.x emits (message, xml) with topic._ and message.message.{source,data} in xml2js/linerase form. (https://github.com/agsh/onvif/blob/master/src/events.ts)
- **onvif@0.8.3 quirk: Cam.prototype.systemReboot sends the SystemReboot body with service:'deviceIO'; _requestPart2 uses this.uri[service].path if that service XAddr exists, otherwise the literal string 'deviceIO' as the HTTP path, so on cameras that do not advertise a DeviceIO service the reboot request goes to an invalid path.** [high] lib/cam.js lines 1165-1171 (service: 'deviceIO') and 293-294 (path: options.service ? (this.uri && this.uri[options.service] ? this.uri[options.service].path : options.service) : this.path). Workaround: cam._request({service:'device', body: cam._envelopeHeader() + '<SystemReboot xmlns="http://www.onvif.org/ver10/device/wsdl"/>' + cam._envelopeFooter()}, cb). 1.x device.systemReboot() posts to the device service correctly. (https://registry.npmjs.org/onvif/-/onvif-0.8.3.tgz)
- **onvif@1.x return-shape inconsistency: media.getStreamUri() is typed Promise<GetStreamUriResponse> = {mediaUri: MediaUri}; the Media2 branch returns {mediaUri:{uri,...}} but the Media1 branch returns response.getStreamUriResponse.mediaUri (the MediaUri object itself), and the README example reads `.uri` directly. Read `res.mediaUri?.uri ?? res.uri`.** [medium] src/media.ts getStreamUri (Media2 branch `return { mediaUri: {...} }`, Media1 branch `return response.getStreamUriResponse.mediaUri;`), src/interfaces/media.ts GetStreamUriResponse{mediaUri}, README example `(await onvif.media.getStreamUri({ protocol: 'RTSP' })).uri`. Also ptz.gotoPreset serialises the optional speed under a lowercase 'speed' key (src/ptz.ts ~line 665) which would emit <speed> instead of <Speed>; omit speed on gotoPreset. (https://github.com/agsh/onvif/blob/master/src/media.ts)
- **node-onvif (futomi/node-onvif) is 0.1.7, MIT, last published 2018-08-14 (registry metadata modified 2022-07); it has startProbe() (returns {urn,name,hardware,location,types,xaddrs,scopes}[]), new OnvifDevice({xaddr,user,pass}), init(), getUdpStreamUrl(), fetchSnapshot() (returns {headers, body: Buffer}), ptzMove({speed:{x,y,z}, timeout seconds}), ptzStop(), services.device.{getCapabilities,getServices({IncludeCapability}),getDeviceInformation,getNetworkInterfaces,reboot,getScopes,setScopes,getHostname,setHostname,getDNS,setDNS,getNetworkProtocols,setNetworkProtocols,getNetworkDefaultGateway,setNetworkDefaultGateway,getUsers,createUsers,deleteUsers,setUser,getNTP,setNTP,getRelayOutputs,getSystemDateAndTime,setSystemDateAndTime}, services.media.{getProfiles,getProfile,getStreamUri({ProfileToken, Protocol:'UDP'|'HTTP'|'RTSP'}),getSnapshotUri({ProfileToken}),getVideoSources,...}, services.ptz.{continuousMove({ProfileToken,Velocity:{x,y,z},Timeout}),absoluteMove({ProfileToken,Position:{x,y,z},Speed?}),relativeMove,stop({ProfileToken,PanTilt?,Zoom?}),gotoHomePosition,setHomePosition,setPreset({ProfileToken,PresetName?,PresetToken?}),getPresets,gotoPreset({ProfileToken,PresetToken,Speed?}),removePreset,getNodes,getConfigurations,getStatus}; services.events has ONLY getEventProperties. It has no SetNetworkInterfaces, no Dot11 methods, no Imaging service, no pull-point/PullMessages, no Media2.** [high] Verified by grepping *.prototype.* in lib/modules/service-device.js, service-media.js, service-ptz.js, service-events.js, device.js and lib/node-onvif.js of the GitHub source; grep -i 'dot11|SetNetworkInterfaces|PullMessages|CreatePullPoint' lib/ returns nothing. Probe sends three Probe types (NetworkVideoTransmitter, Device, NetworkVideoDisplay) with retries. (https://github.com/futomi/node-onvif)
- **There is no npm package named 'onvif-ts' (registry returns 404). Nearest alternatives: node-onvif-ts 0.1.7 (MIT, 2020-07, 'typescript version of node-onvif', same feature gaps as node-onvif); ts-onvif 1.0.1 (MIT, 2026-08-25, repository agsh/onvif, README identical to the agsh 1.x README -- a republish of the same TypeScript line); @2bad/onvif 1.0.0-beta.6 (MIT, 2026-05, TypeScript fork of the agsh 0.x Cam API, Profile S + G).** [high] npm view onvif-ts -> E404; npm view node-onvif-ts / ts-onvif / @2bad/onvif version,license,time.modified,repository.url; npm search onvif listing. (https://www.npmjs.com/package/node-onvif-ts)
- **Profile S v1.3 device requirements relevant to the hub: WS-Discovery M; GetNetworkInterfaces/SetNetworkInterfaces, GetHostname/SetHostname, GetDNS/SetDNS, GetNetworkProtocols, GetNetworkDefaultGateway M; pull-point events (CreatePullPointSubscription/PullMessages) and WS-BaseNotification M; GetStreamUri (Media ver10) M; PTZ conditional (ContinuousMove M if PTZ present). Profile T v1.0 adds Media2 GetStreamUri M, GetSnapshotUri M, pull-point with Filter and ItemFilter dialect M, at least two concurrent pull points, tns1:VideoSource/MotionAlarm M, ContinuousMove+Stop M if PTZ.** [high] Profile S sections 7.4.3 (Network Configuration Function List for Devices, all 'M'), 7.7.1-7.7.3, 8.3 'PTZ (if supported)'; Profile T sections 7.7.1-7.7.3, 7.20, 1524, 1671-1716. (https://www.onvif.org/wp-content/uploads/2019/12/ONVIF_Profile_-S_Specification_v1-3.pdf)

## Limits and caveats

- Re-pointing a camera's WiFi via ONVIF only works on devices whose device-service GetServiceCapabilities reports Network Dot11Configuration=true; neither Profile S nor Profile T mandates it, and consumer WiFi cameras frequently omit it even when otherwise ONVIF-conformant. Feature-detect per camera and fall back to the vendor/cloud or SIM-side mechanism (other research topics) when absent.
- No Node library serialises the Dot11 block of SetNetworkInterfaces: onvif@0.8.3 ignores networkInterface.extension entirely (only JSDoc mentions dot11), onvif@1.0.0-rc.3 types extension.dot11 but drops it, node-onvif has no SetNetworkInterfaces at all. The hub must send that one SOAP body itself (cam._request in 0.8.x, onvif.request in 1.x) and hex-encode the SSID (tt:Dot11SSIDType is xs:hexBinary), pass the passphrase as <PSK><Passphrase> (8-63 printable ASCII) or a 64-hex <Key>, and give each network an Alias and Priority.
- ONVIF over the 4G/SIM path is only possible if the camera's ONVIF port (default 80/8080/2020...) is reachable from the hub on that path (public/static IP, port-forward or a VPN/APN on the SIM); WS-Discovery multicast and push (Subscribe) notifications never traverse it, and GetServices XAddrs will contain the LAN IP, so the hub must rewrite XAddr hosts to the dialled address (onvif option preserveAddress:true) when talking over the SIM.
- After SetNetworkInterfaces (IP or WiFi) the camera may be unreachable at its old address; when RebootNeeded=true you must call SystemReboot, and in both cases wait for the WS-Discovery Hello / re-probe by SerialNumber to learn the new address. Store SerialNumber+HardwareId, not IP, as the device identity.
- onvif@0.8.3 quirk: Cam.prototype.systemReboot posts through the 'deviceIO' service key; on cameras that do not advertise a DeviceIO XAddr the HTTP path becomes the literal string 'deviceIO' and the reboot fails. Send SystemReboot via cam._request({service:'device', ...}) or use 1.x device.systemReboot().
- onvif@1.0.0-rc.3 is a release candidate (npm dist-tag 'rc', not 'latest'): media.getStreamUri() returns the MediaUri object on the Media1 path but {mediaUri} on the Media2 path (README uses .uri), ptz.gotoPreset serialises an optional speed as lowercase <speed>, and Dot11SSIDType is typed unknown. Pin the exact version and wrap these calls.
- WS-Security PasswordDigest depends on clock offset; both agsh versions compute timeShift from an unauthenticated GetSystemDateAndTime in connect(). Cameras with replay-attack protection (Axis) reject requests if the hub clock drifts; keep the hub on NTP. If a camera returns HTTP 401, switch to HTTP Digest (onvif useWSSecurity:false).
- PTZ value ranges depend on the camera's PTZ node spaces: generic pan/tilt -1..1, zoom position 0..1 / velocity -1..1 are the common defaults used by the libraries, but read GetNodes/GetConfigurationOptions for the real ranges; some cameras (Sony) reject PanTilt and Zoom in the same ContinuousMove (agsh onlySendPanTilt/onlySendZoom).
- Imaging operations take the VIDEO SOURCE token, not the profile token; agsh derives it as activeSource.videoSourceToken (1.x) / activeSource.sourceToken (0.8.x). Passing a profile token yields ter:NoSource faults.
- Pull-point PullMessages blocks up to Timeout (>= 1 min per spec); the HTTP client timeout must exceed it (agsh uses 80 s / timeout+2 s) and one blocking pull per subscription at a time (device should return UnableToGetMessagesFault otherwise). Motion topics differ by vendor (tns1:VideoSource/MotionAlarm on Profile T, tns1:RuleEngine/CellMotionDetector/Motion on many Profile S cameras, tns1:VideoAnalytics/... for AI cams) -- enumerate via GetEventProperties and let the user pick.
- node-onvif (0.1.7, 2018) is unmaintained and missing SetNetworkInterfaces, Dot11, Imaging, Media2 and pull-point events; do not build the adapter on it. The package name 'onvif-ts' does not exist on npm; node-onvif-ts inherits node-onvif's gaps, ts-onvif 1.0.1 is a republish of agsh 1.x (prefer the canonical 'onvif' package), @2bad/onvif is a 0.x-API TypeScript fork still in beta.
- onvif.xsd is elementFormDefault=qualified: children of tds:NetworkInterface (Enabled, IPv4, Extension, Dot11...) belong to http://www.onvif.org/ver10/schema. onvif@0.8.3 sets that xmlns on the direct children; onvif@1.x lets them inherit the tds namespace, which strict gSOAP-based cameras may reject. When hand-building the Dot11 request, set xmlns="http://www.onvif.org/ver10/schema" on Enabled/IPv4/Extension.
- The default PTZ space URIs (http://www.onvif.org/ver10/tptz/...) were not verified against a primary source in this research session; treat range statements as library conventions (confidence medium) until read from the camera's GetConfigurationOptions.

## Libraries

- **onvif** (npm, MIT, 0.8.3 (dist-tag latest, published 2026-09-07); 1.0.0-rc.3 (dist-tag rc, published 2026-09-24)): Canonical Node ONVIF client (agsh/onvif, contributors Andrew Laptev / Roger Hardiman). 0.8.3: JS callback `Cam` + `onvif/promises`, covers WS-Discovery, GetDeviceInformation/GetServices/GetCapabilities, GetNetworkInterfaces/SetNetworkInterfaces (IPv4/IPv6 only), SystemReboot (deviceIO routing quirk), Media/Media2 GetProfiles/GetStreamUri/GetSnapshotUri, full PTZ (continuousMove/stop/absoluteMove/relativeMove/gotoPreset/setPreset/getPresets/removePreset/gotoHomePosition/getStatus), Imaging (get/setImagingSettings, imagingMove/Stop), auto pull-point event loop via cam.on('event'). 1.0.0-rc.3: TypeScript Promise API (`Onvif` class, lazy services device/media/media2/ptz/imaging/events, single dependency fast-xml-parser, Node >= 18), adds getDot11Capabilities/getDot11Status/scanAvailableDot11Networks, typed Subscription with topic/message-content filters, raw onvif.request() for hand-built bodies, and an `onvif/compatibility` Cam shim. Neither serialises Dot11 in setNetworkInterfaces -- send that body raw. https://www.npmjs.com/package/onvif
- **node-onvif** (npm, MIT, 0.1.7 (last published 2018-08-14)): Alternative evaluated and NOT recommended: startProbe(), OnvifDevice({xaddr,user,pass}).init(), getUdpStreamUrl(), fetchSnapshot(), ptzMove({speed:{x,y,z},timeout})/ptzStop(), services.device.{getNetworkInterfaces, reboot, getServices, getDeviceInformation, ...}, services.media.{getStreamUri({ProfileToken,Protocol}), getSnapshotUri, getProfiles}, services.ptz.{continuousMove, absoluteMove, stop, setPreset, gotoPreset, getPresets}. Missing SetNetworkInterfaces, all Dot11 operations, Imaging, Media2 and pull-point events (only getEventProperties); unmaintained since 2018. https://www.npmjs.com/package/node-onvif
- **node-onvif-ts** (npm, MIT, 0.1.7 (2020-07, metadata modified 2022-05)): The nearest thing to the requested 'onvif-ts' (which does not exist on npm): a TypeScript port of node-onvif by YoshieraHuang with the same feature gaps (no SetNetworkInterfaces/Dot11/imaging/pull-point). Not recommended. https://www.npmjs.com/package/node-onvif-ts
- **ts-onvif** (npm, MIT, 1.0.1 (2026-08-25)): Republish of the agsh/onvif 1.x TypeScript line under another name (repository field points to agsh/onvif, README identical). Prefer the canonical `onvif@rc` so fixes land in one place. https://www.npmjs.com/package/ts-onvif
- **@2bad/onvif** (npm, MIT, 1.0.0-beta.6 (2026-05)): TypeScript fork of the agsh 0.x Cam API (Profile S live + Profile G replay). Beta; no advantage over `onvif` for this project's Dot11/Media2/events needs. https://www.npmjs.com/package/@2bad/onvif
