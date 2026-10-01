# hikvision-isapi

Review: 71 claims confirmed, 0 corrected, 0 could not be verified.

## Summary

Hikvision ISAPI is a REST-over-HTTP protocol (XML bodies, optional ?format=json on newer firmware) that every Hikvision camera/NVR exposes on the LAN once "Enable ISAPI" is ticked; it uses RFC 2617 HTTP Digest (MD5, qop=auth) and returns 401 + WWW-Authenticate until the client answers with an Authorization: Digest header. From the LAN the hub can do everything the brief needs directly on the device: device info (GET /ISAPI/System/deviceInfo), reboot (PUT /ISAPI/System/reboot), JPEG snapshots (GET /ISAPI/Streaming/channels/101/picture), RTSP live video (rtsp://host:554/Streaming/Channels/101 main, 102 sub; NVR channel N = N01/N02), full PTZ (continuous/momentary/absolute/presets under /ISAPI/PTZCtrl/channels/<ID>/…), a persistent multipart event stream (GET /ISAPI/Event/notification/alertStream) or push-to-hub HTTP notifications (/ISAPI/Event/notification/httpHosts), Wi-Fi scan (…/wireless/accessPointList with ssid/signalStrength/securityMode) and Wi-Fi re-pointing (PUT …/interfaces/<ID>/wireless with <ssid>, <securityMode>WPA2-personal</securityMode>, <WPA><sharedKey>), and on 4G models the cellular ("WirelessDial") group: dial config (APN, dial number, user/pass, SwitchMethod cableFirst/4GFirst…), dial status (RealtimeMode LTE, UIMInfo SIM state, SignalStrength, current IP) and a connect trigger. Browser viewing is best done by fronting RTSP with go2rtc (MIT), which also gives WebRTC/MSE/HLS, JPEG frames and two-way audio via its isapi:// source. The hard limit is the SIM path: ISAPI is inbound-only, and an Indian postpaid SIM normally sits behind carrier NAT, so the hub cannot open a connection to the camera over 4G unless the SIM has a public/static IP or the camera reaches out to something — Hikvision's outbound options are its own cloud (Hik-Connect/EZVIZ P2P, /ISAPI/System/Network/EZVIZ) or an ISUP/EHome server. The only public, self-serve cloud API is the EZVIZ Open Platform (open.ys7.com; appKey/appSecret → accessToken, regional areaDomain; device/add with the sticker verification code; live/address/get for HLS/RTMP/FLV URLs; device/ptz/start|stop; device/capture), which works for devices bound to an EZVIZ/Hik-Connect account; the Hik-Connect OpenAPI itself is partner-only, and the P2P protocol is proprietary (community reverse-engineering exists but is unmerged). So: LAN = full ISAPI adapter; SIM fallback = EZVIZ Open Platform adapter for live view/PTZ/snapshots/status, plus reading 4G health from ISAPI whenever the LAN path is back.

## Added by review (things an implementer needs)

- **There is no PTZ 'stop' resource in ISAPI; a continuous move runs until another command replaces it.** The PTZ spec defines only /continuous (speeds -100..100, all optional) and /momentary (self-stopping after <duration> ms). To stop, PUT /ISAPI/PTZCtrl/channels/1/continuous with <PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>. Confidence medium: zero-speed stop is inferred from the speed semantics and from how the web UI drives /continuous; I found no primary sentence stating it. An ipcamtalk staff post warns that if the stop fails the camera keeps moving. Safer design for a phone PWA: use /momentary with a short duration (e.g. 300-500 ms) repeated while the button is held, and send the zero-speed continuous on release as well. (https://download.catalogosicurezza.com/DOWNLOAD/Hikvision/Software/Pacchetti%20per%20Sviluppo/05%20%20%20ISAPI/HIKVISION%20ISAPI_2.0-PTZ%20Service.pdf ; https://ipcamtalk.com/threads/http-command-for-ptz.8615/)
- **alertStream heartbeat cadence and timeout are specified; use them instead of pyHik's 300 s watchdog.** Heartbeat = EventNotificationAlert with eventType 'videoloss' and eventState 'inactive' (activePostCount increments). Firmware 5.5.0 and higher: one heartbeat every 10 s, 'If no heartbeat received for continuous 30 s ... the heartbeat is timed out'. Firmware below 5.5.0: one every 300 ms. On timeout or disconnect, re-issue the GET. Real videoloss alarms are the same eventType with eventState 'active'. Response header is 'Content-Type: multipart/mixed; boundary=<x>'; each part has Content-Type (application/xml or application/json) and Content-Length, so parse by boundary + Content-Length rather than by line. (https://download.isecj.jp/catalog/misc/isapi.pdf (12.1; 16.2.129 XML_EventNotificationAlert_HeartbeatInfo) ; https://tpp.hikvision.com/wiki/isapi/anpr/GUID-C8398309-7417-4540-AF4F-4DA909E766D2.html)
- **The security=1|2 encryption needs a specific key derivation and encoding; the researcher gave only the query syntax.** 1) GET /ISAPI/Security/capabilities -> <securityVersion opt="1,2"> and <keyIterateNum> (usually 100..1000). 2) Key = SHA256 applied iteratively keyIterateNum times to (password + "AaBbCcDd1234!@#$"), e.g. SHA(SHA(SHA("abcd1234AaBbCcDd1234!@#$"))...). 3) Each sensitive node value: Base64-encode the plaintext first, then AES-128-CBC (security=1) or AES-256-CBC (security=2). 4) iv is 16 random bytes sent as 32 hex chars in ?iv=; reuse the same iv for every encrypted node in the message. 5) Use the lower of client/device supported versions. security=1 encrypts passwords only; security=2 also user names. Without ?security the body is plain XML (which is what older firmware expects). The guide does not say how a 32-byte SHA-256 output is cut to a 16-byte AES-128 key: test against a real device. (https://download.isecj.jp/catalog/misc/isapi.pdf (3.3 Encryption; 16.2.256 XML_SecurityCap))
- **A failed login returns lockout state in the body; the adapter must stop retrying when attempts run low.** 401 body is <ResponseStatus xmlns="http://www.std-cgi.org/ver20/XMLSchema"> with <lockStatus> unlock|locked, <retryTimes> (remaining attempts) and <resLockTime> (remaining lock seconds). 'If the remaining attempts is 0, the user will be locked at the next authentication attempt.' A hub polling with a stale password will lock the account for the vendor app too. Note a normal digest handshake's first 401 is a challenge, not a failure: only count 401s received after sending an Authorization header. (https://download.isecj.jp/catalog/misc/isapi.pdf (3.1; 16.2.254 XML_ResponseStatus_AuthenticationFailed))
- **XML_EZVIZ has a <netWork> node that selects which uplink Hik-Connect uses, plus <operateCode> and <offlineStatus>.** <netWork> xs:integer: 0-null, 1-automatic, 2-wired network priority, 3-wired network (default), 4-3G/4G/GPRS. On a camera that has both LAN/Wi-Fi and a SIM this decides whether the Hik-Connect registration fails over to 4G; with the default 3 it may not. <operateCode> = operation code for binding the device. <offlineStatus> = 'secretKeyInvalid' when registerStatus is false because of a bad verification code. This is the one ISAPI knob directly tied to the 'SIM fallback' requirement. (https://download.isecj.jp/catalog/misc/isapi.pdf (16.2.141 XML_EZVIZ))
- **The SMS whitelist supports remote reboot by SMS, and the device can send/read SMS over ISAPI.** ListMember XML: <id>, <phoneNumber>, <SupportEntryList><SupportEntry><entry> 'SMSAlarm' | 'SMSCtrl' | 'CallCtrl' </entry><enabled/></SupportEntry></SupportEntryList>, <SMSAlarmTypeList> (diskfull, nicbroken, ipconflict, illaccess, vmd, pir, linedetection, fielddetection ...), <SMSCtrlTypeList><SMSCtrlType><type> 'messageReboot' </type><enabled/></SMSCtrlType></SMSCtrlTypeList>. So a whitelisted phone number can reboot the camera by SMS when no IP path exists. /messages/<ID> GET/PUT uses <message><id/><phoneNum/><status/><time/><SMSContent/></message>. The SMS text that triggers messageReboot is not documented in the guide (unknown; check the device UI). Present only in the 2.6-era guide, so probe /messageConfig/messageConfigCap first. (https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf (8.2.79-8.2.83))
- **There is a Wi-Fi connection status endpoint to confirm a re-point succeeded.** GET /ISAPI/System/Network/interfaces/<ID>/wirelessStatus (capabilities: .../wirelessStatus/capabilities) returns <WirelessStatus><enabled/><connectionEnabled/><IpAddress/><SubnetMask/><RouterAddress/><DNSAddressList/>. Together with accessPoint <connected>/<connecting> in accessPointList and <WifiStatus><state> in /ISAPI/System/status this gives a post-change check. Practical consequence the researcher did not spell out: after PUT .../wireless the camera leaves the current SSID, so the ResponseStatus may be the last thing the hub hears on the old network; if the new credentials are wrong the camera is unreachable over Wi-Fi and only Ethernet, the camera's own AP (wirelessServer) or the cloud path can recover it. Validate the SSID against accessPointList before the PUT. (https://download.isecj.jp/catalog/misc/isapi.pdf (15.10.116, 15.10.117, 16.2.317, 16.2.3, 16.2.116))
- **Listening-mode delivery details and a test call exist.** POST /ISAPI/Event/notification/httpHosts/<ID>/test (body XML_HttpHostNotification, returns XML_HttpHostTestResult) checks the hub listener from the camera. Events with pictures arrive as 'Content-Type: multipart/form-data; boundary=...' with parts named e.g. 'Event_Type' (text/xml EventNotificationAlert) and 'Picture_Name' (image). Without pictures the POST body is the XML/JSON alone. GET /ISAPI/Event/notification/httpHosts/capabilities lists supported options. The hub listener must be reachable from the camera's network, so it only works on the LAN path. (https://download.isecj.jp/catalog/misc/isapi.pdf (12.2; 15.3.6; 15.3.7))
- **go2rtc's isapi:// source uses the ISAPI TwoWayAudio resources and supports G.711 only.** GET /ISAPI/System/TwoWayAudio/channels (reads audioCompressionType), PUT /ISAPI/System/TwoWayAudio/channels/<id>/close (sent pre-emptively), PUT .../open, then PUT .../audioData streaming. Codec map: 'G.711ulaw' -> PCMU, 'G.711alaw' -> PCMA, 8000 Hz. The same resources are documented by Hikvision (15.10.185-190). If the camera's two-way audio codec is set to anything else, talk-back will not work. (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/pkg/isapi/client.go ; https://download.isecj.jp/catalog/misc/isapi.pdf (15.10.185-15.10.190))
- **go2rtc API hardening options needed when the hub proxies it.** api.listen default ':1984' (set '127.0.0.1:1984' to keep it local, '' to disable); api.username/api.password = Basic auth; api.local_auth: true forces auth even for localhost (default false, and by default localhost and unix-socket requests bypass auth, which matters when the hub reverse-proxies from 127.0.0.1); api.base_path for a sub-URL; api.origin '*' for CORS; api.tls_listen/tls_cert/tls_key; api.unix_listen. Further useful endpoints: GET /api (version info), GET /api/streams?src= (per-stream info), GET /api/stream.mjpeg, /api/stream.ts, /api/hls/* segments, PUT/DELETE /api/preload, POST /api/exit, PATCH /api/config. README notes MP4-over-WebSocket exists specifically for iOS. (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/api/README.md ; https://raw.githubusercontent.com/AlexxIT/go2rtc/master/website/api/openapi.yaml)
- **EZVIZ Open Platform has additional query endpoints useful for the cloud/SIM path.** POST {areaDomain}/api/lapp/camera/list (pageStart, pageSize; returns deviceSerial, channelNo, status, isEncrypt, videoLevel, picUrl); POST {areaDomain}/api/lapp/device/status/get (deviceSerial, channel; returns privacyStatus, pirStatus, alarmSoundMode, battryStatus, diskNum, diskState, cloudStatus ...); POST {areaDomain}/api/lapp/device/camera/list (deviceSerial; per-channel info incl. status 0-offline/1-online/-1-not reported). device/list 'status' 0/1 is the online flag to poll when Wi-Fi is down. isEncrypt=1 means HLS/FLV URLs need the device verification code ('code' applies to ezopen). Common errors: 10002 token expired, 20007 device offline, 20008 device timeout, 20018 device not owned by this account, 10007/10029 rate limits. (https://open.ys7.com/help/en/476 ; https://open.ys7.com/help/en/479 ; https://open.ys7.com/help/en/472)
- **Default Hikvision ports and where they are changed.** HTTP 80, RTSP 554, HTTPS 443, Server/SDK port 8000 (Configuration > Network > Basic Settings > Port). The adapter config should carry per-device httpPort and rtspPort rather than hard-coding. Source is Hikvision user-manual pages mirrored on ManualsLib (found via search snippet, not opened in full): confidence medium. (https://www.manualslib.com/manual/890278/Hikvision-Network-Camera.html?page=41 ; https://www.surveillance-video.com/media/lanot/attachments/customimport/DS-2TD2637T-15-P-User-Manual.pdf)
- **A factory-fresh or reset camera is 'inactive' and rejects everything until activated.** PUT /ISAPI/System/activate with <ActivateInfo><password/></ActivateInfo> (related: POST /ISAPI/Security/challenge). Hik-Connect must then be enabled and a verification code created (Configuration > Network > Advanced Settings > Platform Access, or via SADP) before the device can be bound to an account. Relevant because 'WiFi reset' workflows on these cameras can end in a device reset. (https://download.isecj.jp/catalog/misc/isapi.pdf (15.10.3; 15.7.8) ; https://www.surveillance-video.com/media/lanot/attachments/customimport/DS-2TD2637T-15-P-User-Manual.pdf)
- **Changing RTSP/WEB digest algorithm away from MD5 breaks third-party clients.** Manual: 'RTSP Digest Algorithm: MD5, SHA256 and MD5/SHA256 ... If you enable the digest algorithm except for MD5, the third-party platform might not be able to login the device or enable live view because of compatibility.' go2rtc/ffmpeg RTSP and most Node digest libraries assume MD5; set both RTSP and WEB algorithm to MD5 (or MD5/SHA256) and RTSP/WEB Authentication to digest (or digest/basic). (https://www.surveillance-video.com/media/lanot/attachments/customimport/DS-2TD2637T-15-P-User-Manual.pdf ; https://docs.frigate.video/configuration/camera_specific/)
- **Case and path variants seen on real devices.** Working community examples use capitalised leaf names (/ISAPI/PTZCtrl/channels/1/Momentary, /Absolute, /Continuous) as well as the spec's lower-case ones, and old firmware answers on the same paths without the /ISAPI prefix (/PTZCtrl/channels/1/Continuous, /System/reboot, /Streaming/channels/1/picture, /Event/notification/alertStream) with a ver10 namespace. Implement: try the spec's lower-case /ISAPI path first, fall back to the legacy prefix only on 404. (https://community.home-assistant.io/t/hikvision-camera-ptz-control-workaround-without-onvif/180366 ; https://ipcamtalk.com/threads/http-command-for-ptz.8615/ ; https://raw.githubusercontent.com/mezz64/pyHik/master/pyhik/hikvision.py)
- **No primary source found that local ISAPI is reachable over the camera's SIM; Hikvision documents 4G access only through Hik-Connect.** Confidence low (absence of evidence). Hikvision's own 4G how-to is titled 'Activating and Accessing 4G Network Cameras via Hik-Connect'; nothing in either ISAPI guide provides an inbound path over a carrier-NATed SIM. The device-initiated options in the specs are: Hik-Connect/EZVIZ registration (/ISAPI/System/Network/EZVIZ, <netWork>), ISUP/EHome registration (/ISAPI/System/Network/Ehome), listening-mode HTTP POSTs (needs a hub address reachable from the SIM network), and SMS (whitelist, messageReboot). Design the SIM path around those, not around the LAN endpoints. Whether the owner's cameras are Hikvision-branded (Hik-Connect, partner-gated OpenAPI) or EZVIZ-branded (EZVIZ Open Platform, appKey) also decides which cloud API applies; a Hikvision device bound to a Hik-Connect account is not shown by the sources to be reachable through open.ys7.com. (https://www.hikvision.com/en/support/how-to/how-to-video/activating-and-accessing-4g-network-cameras-via-hik-connect/ ; https://tpp.hikvision.com/products/HC-Integration)

## Calls

### Digest handshake (all ISAPI calls)

```
http ANY http://<camera>/ISAPI/... → 401 WWW-Authenticate: Digest qop="auth", realm="...", nonce="..." → resend with Authorization: Digest username="admin", realm, nonce, uri, cnonce, nc=00000001, qop="auth", response=MD5(MD5(user:realm:pass):nonce:nc:cnonce:auth:MD5(METHOD:uri))
```
- Params: Use the admin account for network/EZVIZ/verification-code reads; an operator user with Remote PTZ + Notify permissions is enough for PTZ/events.
- Auth: HTTP Digest (RFC 2617, MD5; SHA-256 possible if device 'WEB Digest Algorithm' is changed). Basic only if 'WEB Authentication' = digest/basic.
- Response: 200 with XML (or JSON if ?format=json) / ResponseStatus on error / 401 on bad auth. Account locks after repeated failures.
- Notes: Keep the connection alive and increment nc for subsequent requests; a 401 with stale=TRUE means re-derive with the new nonce.
- Source: https://download.isecj.jp/catalog/misc/isapi.pdf

### Device info

```
http GET /ISAPI/System/deviceInfo
```
- Params: none (PUT with partial <DeviceInfo> to rename etc.)
- Auth: Digest
- Response: <DeviceInfo version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><deviceName/><deviceID/><model/><serialNumber/><macAddress/><firmwareVersion/><firmwareReleasedDate/><bootVersion/><hardwareVersion/><encoderVersion/><deviceType>IPCamera|IPDome|DVR|HybirdNVR|NVR|DVS|IPZoom</deviceType><telecontrolID/><supportBeep/>...</DeviceInfo>
- Notes: Use as the 'is it reachable + which model' probe (also /ISAPI/System/deviceInfo/capabilities).
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### Device capabilities

```
http GET /ISAPI/System/capabilities  and  /ISAPI/System/Network/capabilities
```
- Params: none
- Auth: Digest
- Response: <DeviceCap>…<NetworkCap><isSupportEZVIZ/><isSupportEhome/><isSupportWirelessServer/><isSupportWirelessDial/><WPS/>…<EZVIZSecretKey/>/<secretKey/></NetworkCap>…</DeviceCap>
- Notes: Gate the Wi-Fi tab on the presence of a Wireless interface, the 4G tab on <isSupportWirelessDial>true</isSupportWirelessDial>, the cloud tab on <isSupportEZVIZ>.
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### Device status (CPU/mem/4G signal/Wi-Fi state)

```
http GET /ISAPI/System/status
```
- Params: none
- Auth: Digest
- Response: <DeviceStatus>…<deviceStatus>normal|abnormal</deviceStatus><dialSignalStrength>1..3</dialSignalStrength><USBStatusList/><WifiStatusList><WifiStatus><id/><state>disabled|enable|disconnected|enableHotspot</state></WifiStatus></WifiStatusList>…</DeviceStatus>
- Notes: dialSignalStrength is a coarse 1-3 bar value; the WirelessDial dialstatus gives the raw integer.
- Source: https://download.isecj.jp/catalog/misc/isapi.pdf

### Reboot

```
http PUT /ISAPI/System/reboot
```
- Params: no body
- Auth: Digest
- Response: <ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus> then the device drops; error statusCode 2 / upgrading
- Notes: Expect 30-90 s outage; poll /ISAPI/System/deviceInfo to detect return.
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### RTSP live stream (main/sub)

```
rtsp DESCRIBE/SETUP/PLAY/TEARDOWN rtsp://<user>:<pass>@<camera>:554/Streaming/Channels/101   (102 = sub, 103 = third; NVR: 1301 = channel 13 main, 1302 sub; equivalent path rtsp://<host>:554/ISAPI/Streaming/channels/101)
```
- Params: ID = channelNo*100 + streamType (1 main, 2 sub, 3 third)
- Auth: RTSP Digest (WWW-Authenticate: Digest realm=..., nonce=...)
- Response: SDP with H.264/H.265 video (trackID=1) and PCMA/AAC audio (trackID=2)
- Notes: Feed this to go2rtc; use 102 (sub-stream, low res) for phone tiles and 101 for full screen.
- Source: http://enpinfo.hikvision.com/unzip/20201110210551_77443_doc/GUID-515FF2B5-5E01-4F03-8B81-4CA5BD621965.html

### Streaming channel list / encoding params

```
http GET (PUT to change) /ISAPI/Streaming/channels   and   /ISAPI/Streaming/channels/<ID>
```
- Params: <ID> = 101/102...; PUT StreamingChannel XML to change resolution/fps/bitrate
- Auth: Digest
- Response: <StreamingChannelList><StreamingChannel><id>101</id><channelName/><enabled/><Video><videoCodecType/><videoResolutionWidth/><videoResolutionHeight/><maxFrameRate/>…</Video>…</StreamingChannel>…</StreamingChannelList>
- Notes: On an NVR this enumerates the IDs to use for /picture and RTSP (Hikvision how-to also lists /ISAPI/ContentMgmt/StreamingProxy/channels).
- Source: https://dev.to/gordinmitya/hikvision-camera-configuration-via-isapi-11oh

### JPEG snapshot

```
http GET /ISAPI/Streaming/channels/<ID>/picture?videoResolutionWidth=1920&videoResolutionHeight=1080&snapShotImageType=JPEG
```
- Params: <ID>=101 (channel 1 main); query params optional; main stream only, JPEG only
- Auth: Digest
- Response: Content-Type: image/jpeg + binary body
- Notes: Cheapest 'is the camera alive' tile refresh; some NVRs need 'Picture URL Digest Authentication' left enabled.
- Source: https://download.isecj.jp/catalog/misc/isapi.pdf

### PTZ capabilities / channel list

```
http GET /ISAPI/PTZCtrl/capabilities ; /ISAPI/PTZCtrl/channels ; /ISAPI/PTZCtrl/channels/<ID>/capabilities
```
- Params: none
- Auth: Digest
- Response: <PTZCtrlCap><maxPTZChannleNum>N</maxPTZChannleNum></PTZCtrlCap> (0 = no PTZ); PTZChannelList; PTZChanelCap with XRange/YRange/ZRange
- Notes: PTZ <ID> is the video input channel (1 on a camera; the NVR channel number on an NVR), NOT the stream id 101.
- Source: https://download.catalogosicurezza.com/DOWNLOAD/Hikvision/Software/Pacchetti%20per%20Sviluppo/05%20%20%20ISAPI/HIKVISION%20ISAPI_2.0-PTZ%20Service.pdf

### PTZ continuous move (press-and-hold)

```
http PUT /ISAPI/PTZCtrl/channels/<ID>/continuous
```
- Params: Content-Type: application/xml; body <PTZData version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><pan>60</pan><tilt>0</tilt><zoom>0</zoom></PTZData>; each -100..100 (pan>0 right, tilt>0 up, zoom>0 in)
- Auth: Digest
- Response: <ResponseStatus> statusCode 1 OK
- Notes: Stop = PUT the same URL with <pan>0</pan><tilt>0</tilt><zoom>0</zoom> (values are speeds; community-standard practice, medium confidence). For a touch UI: send on touchstart, zeros on touchend, plus a safety zero after 2-3 s.
- Source: https://download.catalogosicurezza.com/DOWNLOAD/Hikvision/Software/Pacchetti%20per%20Sviluppo/05%20%20%20ISAPI/HIKVISION%20ISAPI_2.0-PTZ%20Service.pdf

### PTZ momentary move (tap = fixed duration)

```
http PUT /ISAPI/PTZCtrl/channels/<ID>/momentary
```
- Params: <PTZData version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><pan>-40</pan><tilt>0</tilt><zoom>0</zoom><Momentary><duration>500</duration></Momentary></PTZData> (duration ms)
- Auth: Digest
- Response: <ResponseStatus>
- Notes: Best fit for 'nothing complicated' tap buttons — no stop call needed.
- Source: https://community.home-assistant.io/t/hikvision-camera-ptz-control-workaround-without-onvif/180366

### PTZ absolute position / read position

```
http PUT (GET status) /ISAPI/PTZCtrl/channels/<ID>/absolute   and   GET /ISAPI/PTZCtrl/channels/<ID>/status
```
- Params: <PTZData version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><AbsoluteHigh><elevation>0</elevation><azimuth>900</azimuth><absoluteZoom>10</absoluteZoom></AbsoluteHigh></PTZData> (elevation -900..2700 = -90.0..270.0°, azimuth 0..3600 = 0..360.0°, absoluteZoom 0..1000)
- Auth: Digest
- Response: <PTZStatus><AbsoluteHigh><elevation/><azimuth/><absoluteZoom/></AbsoluteHigh></PTZStatus>
- Notes: Real DS-2DE2A404IW-DE3 accepted azimuth 0..3300, elevation 0..900, zoom 10..40 — ranges are model-specific, read /capabilities.
- Source: https://download.catalogosicurezza.com/DOWNLOAD/Hikvision/Software/Pacchetti%20per%20Sviluppo/05%20%20%20ISAPI/HIKVISION%20ISAPI_2.0-PTZ%20Service.pdf

### PTZ relative (click-to-centre) / digital zoom

```
http PUT /ISAPI/PTZCtrl/channels/<ID>/relative   ;   /ISAPI/PTZCtrl/channels/<ID>/digital
```
- Params: <PTZData><Relative><positionX>128</positionX><positionY>128</positionY><relativeZoom>0</relativeZoom></Relative></PTZData> (relativeZoom -100..100; openHAB users report X/Y 0..255 with 128,128 = centre); digital: <Digital><positionX/><positionY/><digitalZoomLevel>0..100</digitalZoomLevel></Digital>
- Auth: Digest
- Response: <ResponseStatus>
- Notes: Use for tap-on-video centring.
- Source: https://community.openhab.org/t/hikvision-ptz-control/113686

### PTZ presets list / create / set / delete

```
http GET / POST / PUT / DELETE GET /ISAPI/PTZCtrl/channels/<ID>/presets ; POST /ISAPI/PTZCtrl/channels/<ID>/presets ; PUT|GET|DELETE /ISAPI/PTZCtrl/channels/<ID>/presets/<presetNo>
```
- Params: <PTZPreset version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><enabled>true</enabled><id>1</id><presetName>Gate</presetName></PTZPreset> — PUT to /presets/<id> stores the CURRENT position under that number
- Auth: Digest
- Response: <PTZPresetList><PTZPreset>…</PTZPreset></PTZPresetList> or ResponseStatus
- Notes: Spec note: 'PUT is used to set preset and update title of new preset (Enable ... should be 1 when PUT)'.
- Source: https://download.catalogosicurezza.com/DOWNLOAD/Hikvision/Software/Pacchetti%20per%20Sviluppo/05%20%20%20ISAPI/HIKVISION%20ISAPI_2.0-PTZ%20Service.pdf

### PTZ go to preset

```
http PUT /ISAPI/PTZCtrl/channels/<ID>/presets/<presetNo>/goto
```
- Params: no body per spec; some firmware wants an empty <PTZData></PTZData> (Content-Type application/xml)
- Auth: Digest
- Response: <ResponseStatus>
- Notes: curl example from HA thread: curl -X PUT -T PTZ_Empty.xml http://user:pass@IP/ISAPI/PTZCtrl/channels/1/presets/1/goto ; Node-RED flow uses the same URL for NVR channels.
- Source: https://download.catalogosicurezza.com/DOWNLOAD/Hikvision/Software/Pacchetti%20per%20Sviluppo/05%20%20%20ISAPI/HIKVISION%20ISAPI_2.0-PTZ%20Service.pdf

### PTZ home position / patrols / patterns

```
http PUT / DELETE PUT|DELETE /ISAPI/PTZCtrl/channels/<ID>/homeposition ; PUT /ISAPI/PTZCtrl/channels/<ID>/homeposition/goto ; /ISAPI/PTZCtrl/channels/<ID>/patrols[/<ID>/start|stop|pause|status|schedule] ; /ISAPI/PTZCtrl/channels/<ID>/patterns[/<ID>/recordstart|recordstop|start|stop]
```
- Params: homeposition PUT: no body (sets current pan as zero); DELETE restores default
- Auth: Digest
- Response: <ResponseStatus>
- Notes: Optional for v1.
- Source: https://download.catalogosicurezza.com/DOWNLOAD/Hikvision/Software/Pacchetti%20per%20Sviluppo/05%20%20%20ISAPI/HIKVISION%20ISAPI_2.0-PTZ%20Service.pdf

### Network interface list / single interface

```
http GET (PUT) /ISAPI/System/Network/interfaces ; /ISAPI/System/Network/interfaces/<ID> ; /ISAPI/System/Network/interfaces/<ID>/capabilities
```
- Params: none
- Auth: Digest
- Response: <NetworkInterfaceList><NetworkInterface><id>1</id><IPAddress>…</IPAddress><Wireless>…</Wireless>(opt)<Discovery/><Link/><defaultConnection>true</defaultConnection><macAddress/></NetworkInterface>…</NetworkInterfaceList>
- Notes: Discover which <id> owns the Wireless block; that id is used in all /wireless URLs (commonly 2 on Wi-Fi cameras).
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### Interface IP settings

```
http GET / PUT /ISAPI/System/Network/interfaces/<ID>/ipAddress
```
- Params: <IPAddress version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><ipVersion>v4</ipVersion><addressingType>static|dynamic|apipa</addressingType><ipAddress/><subnetMask/><DefaultGateway><ipAddress/></DefaultGateway><PrimaryDNS><ipAddress/></PrimaryDNS><SecondaryDNS><ipAddress/></SecondaryDNS></IPAddress>
- Auth: Digest
- Response: <ResponseStatus>; errors subStatusCode badIPv4Address, conflictIPv4Address, badNetMask
- Notes: Lets the hub pin a static LAN IP so re-discovery after a router reset is trivial.
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### Wi-Fi capabilities

```
http GET /ISAPI/System/Network/interfaces/<ID>/wireless/capabilities
```
- Params: none
- Auth: Digest
- Response: <Wireless> with opt="..." attribute lists: wirelessNetworkMode infrastructure,adhoc; channel 1..14,auto; securityMode disable,WEP,WPA-personal,WPA2-personal,WPA-RADIUS,WPA-enterprise,WPA2-enterprise; WPA algorithmType TKIP,AES,TKIP/AES; wpaKeyLength min 8 max 64; support64bitKey; newer: <hideSsid/>, <protocol opt="802.11ac"/>, <isSupportConnectStatus/>, <AccessPointList><InterfaceDisplay>… signalStrength, connectionStatus …</AccessPointList>
- Notes: Read once per device to build the security-mode picker.
- Source: https://download.isecj.jp/catalog/misc/isapi.pdf

### Wi-Fi settings GET / re-point to another SSID (PUT)

```
http GET / PUT /ISAPI/System/Network/interfaces/<ID>/wireless   (optionally ?security=1&iv=<hex> to AES-128-CBC-encrypt sensitive nodes on newer firmware)
```
- Params: <Wireless version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><enabled>true</enabled><wirelessNetworkMode>infrastructure</wirelessNetworkMode><channel>auto</channel><ssid>HouseWiFi2</ssid><wmmEnabled>true</wmmEnabled><WirelessSecurity><securityMode>WPA2-personal</securityMode><WPA><algorithmType>AES</algorithmType><sharedKey>PASSPHRASE</sharedKey><wpaKeyLength>10</wpaKeyLength></WPA></WirelessSecurity></Wireless>  (WEP variant: <WEP><authenticationType>open|sharedkey|auto</authenticationType><defaultTransmitKeyIndex>1</defaultTransmitKeyIndex><wepKeyLength>64|128</wepKeyLength><EncryptionKeyList><encryptionKey>HEX</encryptionKey></EncryptionKeyList></WEP>)
- Auth: Digest
- Response: <ResponseStatus>; GET returns the same block (sharedKey usually masked/omitted)
- Notes: Do GET first and echo back unchanged fields (PUT is whole-block). If the command goes over the Wi-Fi you are leaving, the reply may never arrive — treat timeout as 'probably applied', then rediscover the camera (mDNS/SADP/ARP) on the new network. Use accessPointList first so the user taps an SSID instead of typing it.
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### Wi-Fi scan (list visible networks)

```
http GET /ISAPI/System/Network/interfaces/<ID>/wireless/accessPointList   (single: /accessPointList/<n>)
```
- Params: none
- Auth: Digest
- Response: <accessPointList version="2.0"><accessPoint><id>1</id><networkMode>infrastructure</networkMode><channel>6</channel><ssid>HouseWiFi</ssid><speed>72</speed><signalStrength>0..100</signalStrength><securityMode>WPA2-personal</securityMode><connected>true|false</connected><connecting>true|false</connecting></accessPoint>…</accessPointList>
- Notes: Some firmware triggers a fresh scan on each GET (takes a few seconds).
- Source: https://download.isecj.jp/catalog/misc/isapi.pdf

### Camera hotspot / AP mode (WirelessServer)

```
http GET / PUT /ISAPI/System/Network/interfaces/<ID>/wirelessServer  ; /wirelessServer/capabilities ; /wirelessServer/accessDeviceList
```
- Params: <WirelessServer version="2.0"><wifiApEnabled>true</wifiApEnabled><broadcastEnabled/><wlanShareEnabled/><ssid/><WirelessSecurity>…same schema as Wireless…</WirelessSecurity></WirelessServer>
- Auth: Digest
- Response: <ResponseStatus> / accessDeviceList of clients
- Notes: Only on models with <isSupportWirelessServer>; it is the 'manual access when the house Wi-Fi is dead' path for Wi-Fi-only cameras (phone joins the camera's own SSID).
- Source: https://download.isecj.jp/catalog/misc/isapi.pdf

### Ping test from the camera

```
http POST (or GET) /ISAPI/System/Network/pingtest
```
- Params: <pingTestDescription version="2.0"><ipAddress>192.168.1.1</ipAddress></pingTestDescription>
- Auth: Digest
- Response: <pingTestResult><status>used|not used</status></pingTestResult>
- Notes: Handy diagnostic before switching networks.
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### 4G: list dial interfaces

```
http GET (PUT) /ISAPI/System/Network/WirelessDial/Interfaces  ;  /ISAPI/System/Network/WirelessDial/Interfaces/<ID>
```
- Params: none
- Auth: Digest
- Response: <WirelessDialInterfaceList version="1.0"><WirelessDialInterface>…</WirelessDialInterface></WirelessDialInterfaceList>  (IDs 1,2,3…)
- Notes: Only when NetworkCap <isSupportWirelessDial>true</isSupportWirelessDial>.
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### 4G: dial (APN/SIM) configuration

```
http GET / PUT /ISAPI/System/Network/WirelessDial/Interfaces/<ID>/dial   (capabilities: …/dial/capabilities; optional ?security=1&iv=<hex>)
```
- Params: <Dial version="1.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><enabled>true</enabled><DialMethod>auto|manual</DialMethod><SwitchMethod>auto|4GFirst|3GFirst|manualto2G|manualto3G|manualto4G|cableFirst</SwitchMethod><OfflineTime>30..65535</OfflineTime><UIMCardNum/><DialNum>*99#</DialNum><Username/><Password/><APNname>airtelgprs.com</APNname><SIMNum>+91…</SIMNum><MTU>1500</MTU><VerifyProto>auto|CHAP|PAP</VerifyProto><netAPN/><Flow><limitEnabled/><consumeFlow/><threshold/></Flow><pinCode/></Dial>
- Auth: Digest
- Response: <ResponseStatus>; GET returns XML_Dial (Password normally blank)
- Notes: 'cableFirst' = use Ethernet/Wi-Fi when up, 4G otherwise — this is the built-in fallback behaviour the brief wants. APN values are examples only.
- Source: https://download.isecj.jp/catalog/misc/isapi.pdf

### 4G: SIM / signal / connection status

```
http GET (PUT) /ISAPI/System/Network/WirelessDial/Interfaces/<ID>/dialstatus
```
- Params: none
- Auth: Digest
- Response: <Dialstatus version="1.0"><RealtimeMode>LTE|FDD-LTE|TD-LTE|WCDMA|GSM|…|UNKNOWN</RealtimeMode><UIMInfo>UNKNOWN|VALID|NOVALID|ROAM|NOEXIST</UIMInfo><SignalStrength>int</SignalStrength><Dialstat>string</Dialstat><IpAddress><ipAddress/></IpAddress><SubnetMask/><Gateway/><DNSAddress/></Dialstatus>
- Notes: Poll this over the LAN to show 'SIM OK / 4G bars / current 4G IP' per camera; the IP tells you whether the carrier gave a public or CGNAT (100.64.x.x / 10.x) address.
- Source: https://download.isecj.jp/catalog/misc/isapi.pdf

### 4G: force (re)connect / dial schedule / SMS whitelist

```
http GET / PUT GET /ISAPI/System/Network/WirelessDial/Interfaces/<ID>/connect ; GET|PUT …/schedule ; GET|PUT …/messageConfig ; …/messageConfig/WhiteList ; …/messageConfig/WhiteList/<ID> ; …/messages/<ID> ; …/messageConfig/messageConfigCap
```
- Params: connect returns <Connect version="1.0"><enabled>true|false</enabled></Connect>; schedule = TimeBlockList (dayOfWeek, TimeRange beginTime/endTime); messageConfig <enabled/><SMSWhiteList><ListMember/></SMSWhiteList>
- Auth: Digest
- Response: <ResponseStatus> / Connect / Schedule / messageConfig
- Notes: SMS whitelist means some 4G models accept control SMS from listed numbers — device-specific, treat as low-confidence extra.
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### Event stream (pull, persistent)

```
http GET /ISAPI/Event/notification/alertStream   (JSON variant: /ISAPI/Event/notification/alertStream?format=json ; legacy firmware: /Event/notification/alertStream)
```
- Params: none; keep connection open
- Auth: Digest (user needs 'Remote: Notify Surveillance Center / Trigger Alarm Output')
- Response: HTTP 200, Content-Type: multipart/mixed; boundary=<b>; parts '--<b>\r\nContent-Type: application/xml; charset="UTF-8"\r\nContent-Length: n\r\n\r\n<EventNotificationAlert version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><ipAddress/><portNo/><protocol>HTTP</protocol><macAddress/><channelID>1</channelID><dateTime>2009-11-14T15:27Z</dateTime><activePostCount>1</activePostCount><eventType>VMD|IO|videoloss|linedetection|fielddetection|PIR|…</eventType><eventState>active|inactive</eventState><eventDescription/>…</EventNotificationAlert>' (parts may be application/json or image/jpeg on newer firmware)
- Notes: Parse boundary-aware (parts and XML can split across TCP reads). Periodic 'videoloss/inactive' parts act as heartbeat; if none for ~30 s, reconnect with backoff (pyHik: 5,10,15 s). This is the hub's 'camera says done' source for notifications.
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### Supported event types

```
http GET /ISAPI/Event/triggers   (legacy: /Event/triggers)
```
- Params: none
- Auth: Digest
- Response: <EventTriggerList><EventTrigger><id>VMD-1</id><eventType>VMD</eventType><videoInputChannelID>1</videoInputChannelID><EventTriggerNotificationList>…</EventTriggerNotificationList></EventTrigger>…</EventTriggerList>
- Notes: pyHik uses it to build the per-channel sensor list.
- Source: https://raw.githubusercontent.com/mezz64/pyHik/master/pyhik/hikvision.py

### Event push to the hub (listening mode)

```
http GET / PUT /ISAPI/Event/notification/httpHosts   and   /ISAPI/Event/notification/httpHosts/<ID>
```
- Params: <HttpHostNotification version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><id>1</id><url>/hik/event</url><protocolType>HTTP|HTTPS</protocolType><parameterFormatType>XML|querystring</parameterFormatType><addressingFormatType>ipaddress|hostname</addressingFormatType><ipAddress>HUB_IP</ipAddress><portNo>8090</portNo><httpAuthenticationMethod>…</httpAuthenticationMethod></HttpHostNotification>
- Auth: Digest
- Response: Device then POSTs <EventNotificationAlert> XML (or GET with DeviceID=, ChannelID=, Type=, EventState=, ActivePostCount=… query params) to http://HUB_IP:8090/hik/event; the hub must answer 200
- Notes: Works only while camera and hub share a network (LAN); over 4G the camera cannot reach a private hub.
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### Event subscription (arming mode, newer firmware)

```
http POST / PUT POST /ISAPI/Event/notification/subscribeEvent ; PUT /ISAPI/Event/notification/subscribeEvent/<ID>
```
- Params: XML_SubscribeEvent with <type> e.g. statusChanged; <pictureURLType>
- Auth: Digest
- Response: subscription ID; events then arrive on /ISAPI/Event/notification/alertStream
- Notes: Optional; needed only for device-status-change events on 2019+ firmware.
- Source: https://download.isecj.jp/catalog/misc/isapi.pdf

### Motion detection enable/disable

```
http GET / PUT /ISAPI/System/Video/inputs/channels/<ID>/motionDetection
```
- Params: <MotionDetection><enabled>true|false</enabled>…</MotionDetection> (GET first, flip <enabled>)
- Auth: Digest
- Response: <ResponseStatus>
- Notes: Used by Home Assistant's hikvision switch.
- Source: https://raw.githubusercontent.com/mezz64/pyHik/master/pyhik/hikvision.py

### Hik-Connect / EZVIZ P2P enrolment status (on the device)

```
http GET / PUT /ISAPI/System/Network/EZVIZ  ;  PUT /ISAPI/System/Network/EZVIZ/secretKey?format=json  ;  POST /ISAPI/System/Network/verificationCodeCheck
```
- Params: <EZVIZ version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><enabled>true</enabled><registerStatus>true</registerStatus>(ro)<redirect>true</redirect><serverAddress><addressingFormatType>hostname</addressingFormatType><hostName>litedev.ezvizlife.com</hostName></serverAddress><verificationCode>ABCDEF</verificationCode><offlineStatus/>(newer)</EZVIZ>
- Auth: Digest (admin to see verificationCode)
- Response: EZVIZ XML / ResponseStatus (0x60001034 invalidEZVIZSecretKey)
- Notes: Lets the hub read 'is this camera online on the cloud' (registerStatus) and pull the verification code it needs for EZVIZ device/add — the same code printed on the sticker. Hostname above is illustrative.
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### EHome/ISUP server registration (self-hosted outbound path)

```
http GET / PUT /ISAPI/System/Network/Ehome
```
- Params: <Ehome version="2.0"><enabled>true</enabled><addressingFormatType>hostname|ipaddress</addressingFormatType><hostName/><ipAddress/><portNo>7660</portNo><deviceID>cam01</deviceID></Ehome>
- Auth: Digest
- Response: GET adds <registerStatus>(ro) and <version>(ro)
- Notes: Only useful if you can run Hikvision's ISUP/EHome server SDK (partner download) on the hub; noted for completeness, not recommended for v1. Port value illustrative.
- Source: https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf

### EZVIZ cloud: get accessToken

```
cloud POST https://open.ezvizlife.com/api/lapp/token/get
```
- Params: Content-Type: application/x-www-form-urlencoded; appKey=…&appSecret=…
- Auth: appKey + appSecret (from EZVIZ Open Platform developer console)
- Response: {"data":{"accessToken":"at.…","expireTime":1470810222045,"areaDomain":"https://iusopen.ezvizlife.com"},"code":"200","msg":"Operating succeeded!"} — errors 10001, 10005 (appKey frozen), 10017, 10030
- Notes: Cache the token until expireTime (ms epoch) and send every later call to areaDomain (region-locked). Rate limits: 10007 call-count, 10029 frequency.
- Source: https://open.ys7.com/help/en/473

### EZVIZ cloud: bind device to the account

```
cloud POST {areaDomain}/api/lapp/device/add
```
- Params: accessToken, deviceSerial (9-char serial from sticker/deviceInfo), validateCode (6 upper-case verification code)
- Auth: accessToken
- Response: {"code":"200","msg":"Operation succeeded!"}; 20010 wrong verification code, 20013 added by another account, 20017 already added, 20007 offline
- Notes: A device can be bound to one EZVIZ/Hik-Connect account at a time; the hub's 'add camera' screen should collect serial + code once and store them.
- Source: https://open.ys7.com/help/en/475

### EZVIZ cloud: device list / info / delete / rename

```
cloud POST {areaDomain}/api/lapp/device/list ; {areaDomain}/api/lapp/device/info ; {areaDomain}/api/lapp/device/delete ; {areaDomain}/api/lapp/device/name/update
```
- Params: list: pageStart (from 0), pageSize (default 10, max 50); info/delete: deviceSerial; rename: deviceSerial, deviceName
- Auth: accessToken
- Response: {"page":{…},"data":[{"deviceSerial":"…","deviceName":"…","deviceType":"C1","status":1,"defence":1,"isEncrypt":0,"deviceVersion":"V5.3.0 build 150824"}],"code":"200"} — status 0 offline / 1 online
- Notes: status is the cloud's view of the camera — over 4G it is the only 'is it alive' signal the hub gets.
- Source: https://open.ys7.com/help/en/476

### EZVIZ cloud: live stream URL (HLS/RTMP/FLV) for browser playback

```
cloud POST {areaDomain}/api/lapp/live/address/get   (revoke: {areaDomain}/api/lapp/live/address/disable with urlId)
```
- Params: accessToken, deviceSerial, channelNo (default 1), protocol 1-ezopen|2-hls|3-rtmp|4-flv (default 1), code (video encryption password if device encryption on), expireTime seconds (30s..720d), type 1-live|2-SD playback|3-cloud playback, quality 1-HD(main)|2-Fluent(sub), startTime/stopTime for playback
- Auth: accessToken
- Response: {"code":"200","data":{"id":"512628410958159872","url":"https://iusopen.ezvizlife.com/v3/openlive/F00497273_1_1.m3u8?expire=…&id=…&t=…&ev=100","expireTime":"2022-11-16 06:02:17"}}
- Notes: protocol=2 (HLS) plays in any phone browser via hls.js/Safari; use quality=2 for tiles. Latency is several seconds (fine for 'is the gate clear', not for driving PTZ precisely).
- Source: https://open.ys7.com/help/en/534

### EZVIZ cloud: PTZ start / stop / mirror / preset

```
cloud POST {areaDomain}/api/lapp/device/ptz/start ; {areaDomain}/api/lapp/device/ptz/stop ; {areaDomain}/api/lapp/device/ptz/mirror ; {areaDomain}/api/lapp/device/preset/add  (Call preset / Clear preset endpoints exist in the same section; paths not captured in this pass)
```
- Params: start: accessToken, deviceSerial, channelNo, direction 0-Up 1-Down 2-Left 3-Right 4-Upper-left 5-Lower-left 6-Upper-right 7-Lower-right 8-Zoom in 9-Zoom out 10-Focus near 11-Focus far, speed 0-Slow 1-Medium 2-Fast; stop: accessToken, deviceSerial, channelNo, direction; mirror: command 0-Up/Down 1-Left/Right 2-Center; preset/add: accessToken, deviceSerial, channelNo
- Auth: accessToken
- Response: {"code":"200","msg":"Operating succeeded!"}; 20007 offline, 60000 no PTZ, 60001 no permission (encryption on), 60002-60005 limit reached, 60020 unsupported
- Notes: 'call Stop PTZ Control API to stop the PTZ control first' before a different direction — mirror the LAN touch UI: start on touchstart, stop on touchend.
- Source: https://open.ys7.com/help/en/479

### EZVIZ cloud: snapshot

```
cloud POST {areaDomain}/api/lapp/device/capture
```
- Params: accessToken, deviceSerial, channelNo (1 for IPC), quality 0-Smooth 1-HD(720P) 2-4CIF 3-1080P 4-400w
- Auth: accessToken
- Response: {"data":{"picUrl":"http://img.ys7.com/…jpg"},"code":"200"}
- Notes: "only available for the IPC or IPC linked NVR"; picUrl is a temporary hosted JPEG — download and cache on the hub.
- Source: https://open.ys7.com/help/en/475

### EZVIZ cloud: other sections available (names only)

```
cloud POST HTTP Interface index (help/en/474): Message System, Cloud Record, Device > device switch, upgrade, alarm message, detector, fill light mode, device switch (query/set), working mode plan, alarm sound, detection area, play ringtone, disk format; Door Lock; Sub account
```
- Params: see each article under https://open.ys7.com/help/en/474
- Auth: accessToken
- Response: JSON
- Notes: Paths not extracted here; 'alarm message' is the cloud analogue of alertStream for the 4G-only case.
- Source: https://open.ys7.com/help/en/474

### go2rtc: register a camera stream (hub → go2rtc)

```
http PUT http://127.0.0.1:1984/api/streams?name=gate_cam&src=rtsp://admin:PASS@192.168.1.64:554/Streaming/Channels/101   (second source for talk-back: &src=isapi://admin:PASS@192.168.1.64:80/)
```
- Params: name, src (repeatable), dst
- Auth: go2rtc api.username/password (Basic) or none from localhost
- Response: JSON stream object; GET /api/streams lists all
- Notes: Equivalent YAML: streams: gate_cam: [rtsp://…/Streaming/Channels/101, isapi://admin:PASS@192.168.1.64:80/].
- Source: https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/api/README.md

### go2rtc: play in the PWA / snapshot

```
http GET / WS http://<hub>:1984/api/ws?src=gate_cam (MSE/WebRTC signalling used by video-rtc.js) ; http://<hub>:1984/api/stream.mp4?src=gate_cam ; http://<hub>:1984/api/stream.m3u8?src=gate_cam ; http://<hub>:1984/api/frame.jpeg?src=gate_cam ; http://<hub>:1984/stream.html?src=gate_cam ; POST /api/webrtc
```
- Params: src=<stream name>; mp4/m3u8 accept &mp4=flac / codec filters
- Auth: same as above; put go2rtc behind the hub's own auth/reverse proxy
- Response: fragmented MP4 / HLS playlist / JPEG / WebRTC SDP
- Notes: frame.jpeg is a good fallback tile when RTSP works but the ISAPI picture endpoint is slow; latency ~0.5-1 s with MSE/WebRTC on LAN.
- Source: https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/api/README.md

## Facts

- **ISAPI authentication is HTTP Digest per RFC 2617; unauthenticated requests get 401 and the digest is MD5-based.** [high, review: confirmed] General Application Developer Guide ch.3.1: "The authentication must based on HTTP Authentication: Basic and Digest Access Authentication, see RFC2617"; "The request session must contain authentication information, otherwise, device will return 401". Formula: qop="auth": Digest=MD5(MD5(A1):<nonce>:<nc>:<cnonce>:<qop>:MD5(A2)), A1=<user>:<realm>:<password>, A2=<request-method>:<uri>. Worked example in the guide: WWW-Authenticate: Digest qop="auth", realm="IP Camera(C2183)", nonce=..., stale="FALSE" then Authorization: Digest username="admin", realm=..., nonce=..., uri="/ISAPI/Event/notification/alertStream", cnonce=..., nc=00000001, qop="auth", response=... (https://download.isecj.jp/catalog/misc/isapi.pdf)
- **HTTP Basic works only if the device's Security > Authentication 'WEB Authentication' is set to 'digest/basic'; Digest is the default on modern firmware.** [medium] Home Assistant docs: "'WEB Authentication' needs to be set to 'digest/basic'" and must be applied per camera; Frigate docs list RTSP Authentication digest/basic, RTSP Digest Algorithm MD5, WEB Authentication digest/basic, WEB Digest Algorithm MD5 for newer models. Community reference: "Basic authentication is supported by older firmware but disabled by default on modern devices"; repeated failures lock the admin user (typically 5 failures, 30 min). (https://www.home-assistant.io/integrations/hikvision/)
- **ISAPI must be enabled on the device UI before any endpoint answers.** [high, review: confirmed] Hikvision manual page 'ISAPI Service': System > System Service > System Service > tick Enable ISAPI > Apply > restart. (https://enpinfo.hikvision.com/hkwsen/unzip/20230410194813_20373_doc/GUID-32DED0BA-F218-4F6D-BC9F-525FFAB4BDE0.html)
- **RTSP stream ID = (channel No.) x 100 + stream type (1 main, 2 sub, 3 third).** [high] Official ISAPI metadata guide: rtsp://<host>[:port]/ISAPI/Streaming/channels/<ID>, 101 = main stream channel 1, 102 = sub-stream, 1601 = main stream channel 16; RTSP methods DESCRIBE/SETUP/PLAY/TEARDOWN. The classic path rtsp://host:554/Streaming/Channels/101 is the same stream (Frigate docs use /streaming/channels/101, /102, /103). RTSP also uses Digest (guide shows WWW-Authenticate: Digest realm="4419b66d2485" on DESCRIBE). (http://enpinfo.hikvision.com/unzip/20201110210551_77443_doc/GUID-515FF2B5-5E01-4F03-8B81-4CA5BD621965.html)
- **Snapshot endpoint is GET /ISAPI/Streaming/channels/<ID>/picture, main stream only, JPEG only, with optional videoResolutionWidth/videoResolutionHeight/snapShotImageType.** [high] General guide 15.9.5: "Manually capture picture in the video stream of a specific channel"; query (Optional) videoResolutionWidth, videoResolutionHeight, snapShotImageType (only JPEG); "<ID> ... equal to (channel No. x 100 + 1)"; response Content-Type: image/jpeg. Hikvision how-to: on an NVR list channels with GET /ISAPI/Streaming/channels (or /ISAPI/ContentMgmt/StreamingProxy/channels) then /ISAPI/Streaming/channels/1301/picture for channel 13; example ...picture?videoResolutionWidth=1920&videoResolutionHeight=1080. (https://www.hikvisioneurope.com/eu/portal/portal/Technical%20Materials/24%20How%20To/CCTV/How%20to%20use%20API%20to%20capture%20picture.pdf)
- **PTZ continuous move is PUT /ISAPI/PTZCtrl/channels/<ID>/continuous with <PTZData><pan/><tilt/><zoom/></PTZData>, each -100..100 (speed; sign = direction).** [high] IP Surveillance API PTZ Service Specification v2.0 (2013-12) 4.8: Query pan, tilt, zoom; Inbound PTZData; PTZData XML: <pan> -100..100, <tilt> -100..100, <zoom> -100..100. Momentary (4.9) adds <Momentary><duration>ms</duration></Momentary>. Absolute (4.11) uses <AbsoluteHigh><elevation> -900..2700 (=-90.0..270.0 deg), <azimuth> 0..3600, <absoluteZoom> 0..1000. Status (4.13) GET .../status returns PTZStatus/AbsoluteHigh. (https://download.catalogosicurezza.com/DOWNLOAD/Hikvision/Software/Pacchetti%20per%20Sviluppo/05%20%20%20ISAPI/HIKVISION%20ISAPI_2.0-PTZ%20Service.pdf)
- **PTZ presets: GET /presets (PTZPresetList), POST /presets (PTZPreset), GET/PUT/DELETE /presets/<ID> (PUT sets the preset at the current position), PUT /presets/<ID>/goto (no body).** [high] PTZ spec 4.14-4.16. PTZPreset XML: <enabled> req boolean, <id> req, <presetName> req. Notes: "<id> indicates the preset number ... PUT is used to set preset and update title of new preset (Enable value ... should be 1 when PUT)". goto: "Inbound Data None". Home Assistant users report some firmware wants an empty <PTZData></PTZData> body on goto, and a user sending channel 101 got <subStatusCode>badXmlContent</subStatusCode> — PTZ channel ID is the video input channel (1), not the stream ID (101). (https://download.catalogosicurezza.com/DOWNLOAD/Hikvision/Software/Pacchetti%20per%20Sviluppo/05%20%20%20ISAPI/HIKVISION%20ISAPI_2.0-PTZ%20Service.pdf)
- **Reboot is PUT /ISAPI/System/reboot with no body; the ResponseStatus is returned before the device actually reboots.** [high] ISAPI 2.6 IPMD guide 8.1.3: PUT, Inbound None, error statusCode 2 subStatusCode upgrading; "returned before the device proceeds to reboot". Also PUT /ISAPI/System/shutdown?format=json exists on newer firmware (General guide changelog). (https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf)
- **Device info is GET/PUT /ISAPI/System/deviceInfo returning DeviceInfo XML (deviceName, deviceID, model, serialNumber, macAddress, firmwareVersion, deviceType IPCamera/IPDome/NVR...).** [high, review: confirmed] 2.6 guide 8.1.7 and General guide 15.10.21 ("Succeeded: XML_DeviceInfo"); DeviceInfo tail shows firmwareReleasedDate, bootVersion, hardwareVersion, encoderVersion, deviceType ("IPCamera, IPDome, DVR, HybirdNVR, NVR, DVS, IPZoom"), telecontrolID, supportBeep. Capability check: GET /ISAPI/System/capabilities (DeviceCap) and GET /ISAPI/System/Network/capabilities (NetworkCap with <isSupportEZVIZ>, <isSupportEhome>, <isSupportWirelessServer>, <isSupportWirelessDial>). (https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf)
- **Wi-Fi configuration is GET/PUT /ISAPI/System/Network/interfaces/<ID>/wireless with a Wireless XML block (enabled, wirelessNetworkMode, channel, ssid, wmmEnabled, WirelessSecurity/securityMode, WEP or WPA sub-blocks).** [high, review: confirmed] 2.6 guide 8.2.7 Wireless XML: <enabled> req boolean; <wirelessNetworkMode> "infrastructure,adhoc"; <channel> "1-14,auto"; <ssid>; <wmmEnabled>; <WirelessSecurity><securityMode> "disable,WEP,WPA-personal,WPA2-personal,WPA-RADIUS,WPA-enterprise,WPA2-enterprise"; <WEP> authenticationType open/sharedkey/auto, defaultTransmitKeyIndex, wepKeyLength 64/128, EncryptionKeyList/encryptionKey hex; <WPA> algorithmType "TKIP,AES,TKIP/AES", sharedKey (pre-shared key), wpaKeyLength 8-63. The 2019 General guide (15.10.10x) adds optional query ?security=1|2&iv=<hex> to AES-encrypt sensitive nodes on PUT, and the capability block adds <hideSsid>, <protocol opt="802.11ac">, <isSupportConnectStatus>. Interface <ID> comes from GET /ISAPI/System/Network/interfaces (wired usually 1, wireless usually 2 — check the list). (https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf)
- **Wi-Fi scanning is GET /ISAPI/System/Network/interfaces/<ID>/wireless/accessPointList (and /accessPointList/<ID>) returning accessPoint entries with ssid, signalStrength 0-100, securityMode, channel, speed, connected, connecting.** [high] 2.6 guide 8.2.8/8.2.9 ("It is used to get the valid access points on the wireless interface"); accessPoint XML: <id>, <networkMode>, <channel>, <ssid> req, <speed> Mbps, <signalStrength> 0-100, <securityMode>, <connected>. General guide XML_accessPoint adds <connecting> ("whether the device is connecting to the Wi-Fi"); 15.10.108 "Get Wi-Fi hotspot list". (https://download.isecj.jp/catalog/misc/isapi.pdf)
- **4G/cellular on ISAPI is the 'WirelessDial' resource group: /ISAPI/System/Network/WirelessDial/Interfaces/<ID>/dial (config), /dial/capabilities, /dialstatus (SIM + signal + IP), /connect, /schedule, plus SMS whitelist endpoints; capability flag <isSupportWirelessDial>.** [high] 2.6 guide 8.2.71-8.2.83 and General guide 15.10.146-148. Dial XML: <enabled>, <DialMethod> auto/manual, <SwitchMethod> auto,4GFirst,3GFirst,manualto2G,manualto3G,manualto4G,cableFirst, <OfflineTime> 30-65535 s, <UIMCardNum>, <DialNum>, <Username>, <Password>, <APNname>, <SIMNum> (SIM phone number), <MTU> 100-1500, <VerifyProto> auto/CHAP/PAP, <netAPN>, <Flow><limitEnabled/><consumeFlow/><threshold/> (MB), <pinCode> write-only. Dialstatus XML (ro): <RealtimeMode> "CDMA 1x,EVDO,HYBRID,GSM,GPRS,EDGE,WCDMA,HSDPA,HSUPA,HSPA,TDSCDMA,TD-LTE,FDD-LTE,LTE,UNKNOWN", <UIMInfo> "UNKNOWN,VALID,NOVALID,ROAM,NOEXIST", <SignalStrength> integer, <Dialstat> string, <IpAddress>, <SubnetMask>, <Gateway>, <DNSAddress>. Connect XML: <enabled>true|false</enabled>. GET /ISAPI/System/status also carries <dialSignalStrength> ("4G signal strength, it is between 1 and 3") and <WifiStatusList><WifiStatus><state> disabled/enable/disconnected/enableHotspot. (https://download.isecj.jp/catalog/misc/isapi.pdf)
- **Hikvision 4G bullet DS-2CD3T23G1-I/4G has LTE + RJ45 but no Wi-Fi; Micro SIM; supports ISAPI, ONVIF S/G/T, ISUP and Hik-Connect.** [medium] Retailer datasheet copies: "LTE-TDD: Band38/40/41; LTE-FDD: Band1/3/5/7/8/20/28; WCDMA: Band1/5/8 GSM: Band3/5/8", Micro SIM card, "RJ45 10M/100M self-adaptive Ethernet port", WiFi not supported, API "Open Network Video Interface (Profile S, Profile G, Profile T), ISAPI, SDK, ISUP", clients iVMS-4200, Hik-Connect, Hik-Central. Implication: on such models the 'switch Wi-Fi' feature does not apply; the camera itself decides Ethernet vs 4G via <SwitchMethod> (e.g. cableFirst). (https://rxtx.com.au/hikvision-ds-2cd3t23g1-i-4g-solar-4g-network-camera/)
- **Event stream: GET /ISAPI/Event/notification/alertStream keeps an HTTP connection open and server-pushes multipart/mixed parts, each an <EventNotificationAlert> XML (or JSON on newer firmware).** [high] 2.6 guide 8.12.59: "uses HTTP server-push with the MIME type multipart/mixed defined in RFC 2046"; example: Content-Type: multipart/mixed; boundary=<boundary> then parts with Content-Type: application/xml; charset="UTF-8". EventNotificationAlert fields: ipAddress, portNo, protocol, macAddress, channelID, dateTime, activePostCount (sequence starting at 1 per event), eventType ("IO,VMD,videoloss,shelteralarm,facedetection,defocus,audioexception,scenechangedetection,fielddetection,linedetection,regionEntrance,regionExiting,loitering,group,rapidMove,parking,unattendedBaggage,attendedBaggage,PIR,peopleDetection"), eventState active/inactive, eventDescription, DetectionRegionList. General guide 12.1: "Some alarm data is in JSON format, so the Content-Type may be application/xml or application/json"; client must detect heartbeat timeout and reconnect. pyHik (reference impl) parses line-by-line between <EventNotificationAlert and </EventNotificationAlert>, uses periodic 'videoloss' inactive events as the heartbeat, expires stale actives after 5 s, reconnects with 5/10/15 s backoff; legacy firmware uses /Event/notification/alertStream. Community docs show ?format=json variant. (https://raw.githubusercontent.com/mezz64/pyHik/master/pyhik/hikvision.py)
- **Push alternative ('listening mode'): the device POSTs EventNotificationAlert to an HTTP host configured via /ISAPI/Event/notification/httpHosts/<ID>.** [high] 2.6 guide 8.12.53/54: HttpHostNotification XML: <id>, <url>, <protocolType> HTTP/HTTPS, <parameterFormatType> XML/querystring, <addressingFormatType> ipaddress/hostname, hostName/ipAddress, portNo, httpAuthenticationMethod (MD5 Digest supported); 8.12.60 'HTTP Notification Alert': device sends http://<ipAddress>:<portNo>/<url> by POST (XML) or GET (query string DeviceID=, EventState=, Type=, ChannelID=...). General guide 12.2 'Receive Alarm/Event in Listening Mode'. Newer firmware also has POST /ISAPI/Event/notification/subscribeEvent for arming-mode subscriptions (e.g. type statusChanged). (https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf)
- **Hik-Connect/EZVIZ P2P registration is configurable over ISAPI at GET/PUT /ISAPI/System/Network/EZVIZ, and the verification code can be changed with PUT /ISAPI/System/Network/EZVIZ/secretKey?format=json.** [high] 2.6 guide 8.2.67 EZVIZ XML: <enabled> req, <registerStatus> ro, <redirect>, <serverAddress> (addressingFormatType ipaddress/hostname, hostName, ipAddress), <verificationCode> ("only admin account is permitted to see the verification code"). General guide: 'Hik-Connect Access: GET or PUT /ISAPI/System/Network/EZVIZ'; XML_EZVIZ extended with <offlineStatus>; 'Edit verification code for Hik-Connect: PUT /ISAPI/System/Network/EZVIZ/secretKey?format=json' (capability node <secretKey>/<EZVIZSecretKey> in XML_NetworkCap); POST /ISAPI/System/Network/verificationCodeCheck (XML_CheckInfo). Error 0x60001034 invalidEZVIZSecretKey. (https://download.isecj.jp/catalog/misc/isapi.pdf)
- **There is no public self-serve Hik-Connect API: Hik-Connect OpenAPI, Hik-Partner Pro OpenAPI and HikCentral OpenAPI are partner-gated on tpp.hikvision.com.** [high] TPP page: "This feature is exclusively for partners and requires full company information"; partners register on tpp.hikvision.com, create a Hik-Connect account, apply for AK/SK credentials, download the OpenAPI Developer Guide and WASM (JSDecoder) kit. Capabilities listed: device CRUD, live view/playback, alarms/events, two-way audio, P2P without port mapping. (https://tpp.hikvision.com/products/HC-Integration)
- **The Hik-Connect/EZVIZ P2P transport is proprietary; a go2rtc contributor reverse-engineered it (login → P2P setup → UDP hole punch → SRT, HEVC + G.711) in June 2026 but it is a set of unmerged PRs, not an official API.** [medium] go2rtc issue #2289 'EZVIZ / Hik-Connect cloud P2P source (HEVC + audio, no port-forwarding)': proposes scheme ezviz:/hikconnect:, mentions Hik-Connect REST call POST /api/p2p/configurations for session keys; no maintainer response visible at time of reading. (https://github.com/AlexxIT/go2rtc/issues/2289)
- **EZVIZ Open Platform (open.ys7.com) is the public cloud API that reaches Hikvision/EZVIZ devices bound to an EZVIZ account; all calls are POST application/x-www-form-urlencoded returning JSON with code "200".** [high] 'Interface Explain' (help/en/472): "Request Header: content-type: application/x-www-form-urlencoded"; HTTP 200 + JSON; public codes 200 OK, 10007 call times limit, 10029 call frequency limit. Token: POST https://open.ezvizlife.com/api/lapp/token/get (appKey, appSecret) → data.accessToken, data.expireTime (ms epoch), data.areaDomain ("the open api domain name of the user's region, the accessToken is valid only in this region", e.g. https://iusopen.ezvizlife.com; examples also use isgpopen.ezvizlife.com). Errors 10001, 10005 appKey frozen, 10017 appKey not exist, 10030 appKey/appSecret mismatch. (https://open.ys7.com/help/en/473)
- **EZVIZ 'Obtain play address' gives browser-playable HLS/RTMP/FLV URLs for a bound device.** [high] POST {areaDomain}/api/lapp/live/address/get params: accessToken (Y), deviceSerial (Y), channelNo (default 1), protocol 1-ezopen 2-hls 3-rtmp 4-flv (default 1), code (video encryption password for ezopen), expireTime seconds (30s-720d for hls/rtmp/flv), type 1-preview 2-local playback 3-cloud playback, quality 1-HD(main) 2-Fluent(sub), startTime/stopTime. Response data.id, data.url (example ...v3/openlive/F00497273_1_1.m3u8?expire=...), data.expireTime. POST {areaDomain}/api/lapp/live/address/disable (urlId) invalidates it. (https://open.ys7.com/help/en/534)
- **EZVIZ PTZ over the cloud: POST {areaDomain}/api/lapp/device/ptz/start then /ptz/stop; direction 0-11, speed 0-2; presets and mirror flip also exist.** [high] help/en/479: start params accessToken, deviceSerial, channelNo, direction (0-Up, 1-Down, 2-Left, 3-Right, 4-Upper-left, 5-Lower-left, 6-Upper-right, 7-Lower-right, 8-Zoom in, 9-Zoom out, 10-Focus Near, 11-Focus Far), speed (0-Slow, 1-Medium, 2-Fast); "For other operations ... call Stop PTZ Control API to stop the PTZ control first"; stop params accessToken, deviceSerial, channelNo, direction. Mirror: /api/lapp/device/ptz/mirror command 0-Up/Down 1-Left/Right 2-Center. Add preset: /api/lapp/device/preset/add (accessToken, deviceSerial, channelNo). Error codes: 10002 token expired, 20007 device offline, 60000 no PTZ support, 60001 no PTZ permission, 60002-60005 limits reached, 60020 not supported. (https://open.ys7.com/help/en/479)
- **EZVIZ device binding and snapshot: POST {areaDomain}/api/lapp/device/add (deviceSerial, validateCode = six-upper-case sticker code) and POST {areaDomain}/api/lapp/device/capture (channelNo, quality) → picUrl; device list/info via /api/lapp/device/list and /api/lapp/device/info.** [high] help/en/475: device/add errors 20010 verification code error, 20013 added by others, 20017 already added by you; device/delete; device/name/update; device/capture quality 0-Smooth 1-HD(720P) 2-4CIF 3-1080P 4-400w, returns data.picUrl. help/en/476: device/list pageStart (from 0), pageSize (default 10, max 50) → deviceSerial, deviceName, deviceType, status 0-Offline/1-Online, isEncrypt, defence, deviceVersion; device/info by deviceSerial; also 'Get device status information' and 'Get device channel information' endpoints exist in that section. (https://open.ys7.com/help/en/475)
- **EZVIZ Open Platform device access is a paid enterprise service (listed at USD 4.5 per device per year) with docs at open.ys7.com/help/en and SDKs at /developer.** [medium, review: confirmed] EZVIZ global 'Device Access' page: "$4.5 USD per device annually" (Enterprise Package), "99.9% platform availability", contact open-team@ezvizlife.com; the older doc site open.ys7.com/doc/... now only shows a redirect notice, the live docs are a JS app under open.ys7.com/help/en/<id>. (https://isgpopen.ezvizlife.com/product/deviceaccess)
- **go2rtc can front Hikvision RTSP for browsers and adds two-way audio through an isapi:// source; it exposes a small HTTP API for streams, MP4/HLS/WebRTC/MSE and JPEG frames.** [high] isapi README: "isapi://admin:password@192.168.1.123:80/" — "supports only backchannel audio for the Hikvision ISAPI protocol", used as a second source next to rtsp://admin:password@192.168.1.123:554/Streaming/Channels/101. API README: /api/streams (GET/PUT/PATCH/DELETE, params src, name, dst), /api/stream.mp4, /api/stream.m3u8, /api/frame.jpeg, /api/frame.mp4, /api/ws, /api/webrtc, /api/onvif, /api/ffmpeg, /api/restart, /api/config; pages /stream.html, /webrtc.html, /links.html, /add.html; api.username/api.password (Basic) and "go2rtc passes requests from localhost and Unix sockets without HTTP authorization". Latest release v1.9.14 (2026-01-19) ships go2rtc_win64.zip and go2rtc_linux_arm64 binaries; MIT. (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/isapi/README.md)
- **Newer ISAPI firmware supports JSON bodies by appending ?format=json to many URLs, and a 'security'/'iv' query scheme that AES-encrypts sensitive fields (Wi-Fi key, dial password).** [high] General Application guide (2019) uses ?format=json on hundreds of URLs (e.g. PUT /ISAPI/System/Network/EZVIZ/secretKey?format=json, /ISAPI/System/Network/POE?format=json); wireless and dial GET/PUT document "security: ... when security is 1 ... AES128 CBC mode; when security is 2 ... AES256 CBC mode. iv: the initialization vector, required when security is 1 or 2"; omitting the query sends plain XML. (https://download.isecj.jp/catalog/misc/isapi.pdf)
- **ISAPI errors come back as a ResponseStatus XML with statusCode/statusString/subStatusCode.** [high] Real device reply captured on a DS-2DE4A225IW-DE when PUTting /ISAPI/PTZCtrl/channels/101/presets/1/goto: <ResponseStatus xmlns="http://www.hikvision.com/ver20/XMLSchema" version="2.0"><requestURL>...</requestURL><statusCode>6</statusCode><statusString>Invalid Content</statusString><subStatusCode>badXmlContent</subStatusCode></ResponseStatus>. Namespaces seen: http://www.hikvision.com/ver20/XMLSchema (devices) and http://www.isapi.org/ver20/XMLSchema (spec); pyHik reads the namespace dynamically from the root tag. (https://ipcamtalk.com/threads/hikvision-http-command-for-ptz.54898/)
- **An unofficial EZVIZ consumer API (what the EZVIZ/Home Assistant integration uses) exists with login, device list, PTZ and MQTT push endpoints, separate from the Open Platform.** [medium] pyEzvizApi api_endpoints.py: API_ENDPOINT_LOGIN="/v3/users/login/v5", API_ENDPOINT_PAGELIST="/v3/userdevices/v1/resources/pagelist", API_ENDPOINT_DEVICES="/v3/devices/", API_ENDPOINT_PTZCONTROL="/ptzControl", API_ENDPOINT_SWITCH_STATUS="/switchStatus", API_ENDPOINT_ALARMINFO_GET="/v3/alarms/v2/advanced", API_ENDPOINT_DEVICE_SYS_OPERATION="/api/device/v2/sysOper/", API_ENDPOINT_REGISTER_MQTT="/v1/getClientId", API_ENDPOINT_START_MQTT="/api/push/start". It logs in with the user's EZVIZ account password (not an appKey) and is not a supported API. (https://raw.githubusercontent.com/RenierM26/pyEzvizApi/master/pyezvizapi/api_endpoints.py)
- **The camera can also register outbound to a self-hosted EHome/ISUP server (GET/PUT /ISAPI/System/Network/Ehome), which is Hikvision's non-cloud path for NAT-ed 4G devices, but the server side needs Hikvision's ISUP SDK.** [medium] 2.6 guide 8.2.70 Ehome XML: <enabled>, <addressingFormatType> ipaddress/hostname, <hostName>, <ipAddress>, <portNo>, <deviceID> req, <registerStatus> ro, <version> ro; capability <isSupportEhome>. The 4G datasheet lists ISUP among supported APIs. The ISUP/EHome server SDK is distributed through Hikvision's partner portal, not open source. (https://download.viakom.cz/HIKVISION/SDK/HIKVISION%20ISAPI_2.6-IPMD%20Service.pdf)

## Limits and caveats

- Inbound reachability over the SIM path is the blocker: ISAPI, RTSP and the alertStream all require the hub to open a TCP connection TO the camera. An Indian postpaid SIM normally gets a carrier-NAT private address (100.64.0.0/10 or 10.x), so when the house Wi-Fi/broadband is down the hub cannot reach the camera's 4G IP unless the SIM plan includes a public/static IP (an add-on some Indian operators sell to enterprises) or the camera reaches out to a server the hub controls. Verify per camera by reading <IpAddress> in …/WirelessDial/Interfaces/<ID>/dialstatus.
- The only camera-initiated outbound channels are Hikvision's own: Hik-Connect/EZVIZ P2P cloud (configured by /ISAPI/System/Network/EZVIZ) and ISUP/EHome to a Hikvision-SDK server. Therefore the realistic '4G fallback' adapter is the EZVIZ Open Platform HTTP API, not ISAPI-over-4G. Design the device record with both a LAN profile (ip/port/user/pass) and a cloud profile (deviceSerial/validateCode) and let the hub route each action to whichever is reachable.
- EZVIZ Open Platform is regional and commercial: token calls go to open.ezvizlife.com but every other call must use the returned areaDomain (examples show iusopen.ezvizlife.com and isgpopen.ezvizlife.com); the device-access enterprise package is listed at USD 4.5/device/year; call-count (10007) and frequency (10029) limits apply; whether an Indian consumer Hik-Connect account can be bound to a developer appKey should be confirmed with EZVIZ (open-team@ezvizlife.com) before building on it. A device can only be bound to one EZVIZ/Hik-Connect account at a time (error 20013).
- Hik-Connect OpenAPI, Hik-Partner Pro OpenAPI and HikCentral OpenAPI are partner-only (tpp.hikvision.com, 'exclusively for partners and requires full company information'); do not plan on them for a private house. The P2P wire protocol is proprietary; the go2rtc reverse-engineering (issue #2289) is unmerged and could break at any firmware/cloud update.
- The official ISAPI documents (ISAPI Core Protocol / General Application Developer Guide) are distributed through Hikvision's TPP portal behind registration; the copies used here are a 2014 ISAPI 2.6 IPMD guide, a 2019 General Application guide and a 2013 PTZ Service spec mirrored by distributors. Field names and support differ by model and firmware — always GET the block (or …/capabilities) first and echo it back with only the changed nodes, and treat any 'Invalid Content / badXmlContent' as a schema mismatch for that model.
- PTZ channel IDs are video-input channel numbers (1 on a camera, N on an NVR), not stream IDs (101); a user on a DS-2DE4A225IW-DE got badXmlContent using 101. Some firmware requires an empty <PTZData></PTZData> body on presets/<n>/goto; absolute ranges (azimuth/elevation/zoom) are model-specific.
- 'Stop' for continuous PTZ is not spelled out in the 2013 spec; the universal practice is PUT /continuous with pan=tilt=zoom=0. Always send it on touchend and as a watchdog, otherwise a dropped packet leaves the camera spinning.
- Changing Wi-Fi with PUT …/interfaces/<ID>/wireless while talking to the camera over that same Wi-Fi will usually drop the reply; treat a timeout as 'probably applied', wait, then rediscover the camera on the target network (fixed IP via …/ipAddress, mDNS/SADP or ARP scan). Prefer sending Wi-Fi changes over Ethernet, the camera's own hotspot (wirelessServer) or the 4G/cloud path. Newer firmware may require the ?security=1&iv= AES scheme for the sharedKey node; the AES key derivation is described in the General guide's Security chapter and should be implemented from that document (not captured verbatim here).
- Many Hikvision 4G cameras (e.g. DS-2CD3T23G1-I/4G: LTE + RJ45, no Wi-Fi) have no Wi-Fi radio at all; for them 'switch network' means Ethernet vs 4G and is governed by <SwitchMethod> (cableFirst/4GFirst…) in the dial config, not by the wireless endpoints. Only Wi-Fi models (DS-2CD24xx-IW, DS-2CV2xxx, cubes, PT cams) expose …/wireless.
- Authentication details: Digest MD5 with qop=auth is the default; Basic only works when the device's 'WEB Authentication' is set to digest/basic; some models only authenticate admin for certain calls; repeated failures lock the account (~5 tries → 30 min). Do not embed credentials in URLs in logs or the PWA; keep them in the hub's store.
- The alertStream is a long-lived multipart/mixed HTTP response: boundaries and XML can split across reads, parts may be application/json or JPEG on newer firmware, and 'videoloss' inactive parts act as heartbeat; implement a boundary-aware streaming parser and a reconnect/backoff loop (pyHik logic is a good template). HTTP-host push (httpHosts) is simpler but only works when camera and hub share a LAN.
- Browser playback: RTSP cannot be played directly by phones; run go2rtc (MIT, single binary, Windows and Raspberry Pi arm64 builds) next to the hub for WebRTC/MSE/HLS and JPEG frames. Two-way audio via isapi:// requires the camera to have a speaker and the Hikvision two-way-audio ISAPI. go2rtc skips its own auth for localhost, so never expose port 1984 directly — proxy it through the hub's authenticated server.
- Hikvision cloud snapshots (device/capture) return temporary public URLs on img.ys7.com; cache them on the hub rather than linking them in the PWA long-term.
- Sending Wi-Fi passphrases, SIM PINs and APN passwords through ISAPI is plaintext HTTP unless HTTPS is enabled on the camera (self-signed cert) — use https:// with certificate pinning per device on the LAN.
- SMS-based control via the WirelessDial messageConfig/SMS whitelist exists in the spec but is model-specific; not verified on any current 4G camera — treat as optional research, not a design dependency.

## Libraries

- **go2rtc** (binary, MIT, v1.9.14 (2026-01-19)): Turns the camera's RTSP (Streaming/Channels/101|102) into browser-playable WebRTC/MSE/HLS/MP4, serves JPEG frames, adds Hikvision two-way audio via isapi://, and has a tiny HTTP API the hub can drive; ships go2rtc_win64.zip and go2rtc_linux_arm64 for the Raspberry Pi. https://github.com/AlexxIT/go2rtc
- **digest-fetch** (npm, ISC, 3.1.1): Drop-in HTTP Digest (MD5/SHA-256, qop=auth) client for fetch/node-fetch to talk ISAPI; note it was last published ~3 years ago and depends on md5/base-64/js-sha256, so an alternative is a ~60-line hand-rolled RFC 2617 implementation with node:crypto using the exact formula printed in the Hikvision guide. https://registry.npmjs.org/digest-fetch/latest
- **fast-xml-parser** (npm, MIT, 5.11.2): Parse ISAPI XML replies (DeviceInfo, Wireless, Dialstatus, EventNotificationAlert) and build the PUT bodies (PTZData, Wireless, Dial) without native deps. https://registry.npmjs.org/fast-xml-parser/latest
- **pyHik (Home Assistant hikvision integration backend)** (python, MIT, master (Python 3.9+)): Reference implementation to port: alertStream reader (boundary/heartbeat/backoff), /ISAPI/Event/triggers discovery, Basic→Digest fallback, snapshot and motionDetection toggles. https://github.com/mezz64/pyHik
- **hikvisionapi (MissiaL/hikvision-client)** (python, MIT, pip hikvisionapi): Generic ISAPI path-builder client (cam.System.deviceInfo(method='get'), cam.Event.notification.alertStream(type='stream'), cam.Streaming.channels[102].picture(type='opaque_data')) — useful for quick endpoint probing on the bench before writing the TypeScript adapter. https://github.com/MissiaL/hikvision-client
- **node-hikvision-api** (npm, GPL-3.0, 0.0.2 (2016)): Existing Node module with an 'alarm' event emitter over the ISAPI stream; GPL-3.0 and built on the deprecated request/xml2js stack, so use only as a reading reference, not a dependency. https://registry.npmjs.org/node-hikvision-api/latest
- **pyEzvizApi** (python, see repository (not verified in this pass), master): Documents the unofficial EZVIZ consumer endpoints (/v3/users/login/v5, /v3/userdevices/v1/resources/pagelist, /ptzControl, /switchStatus, MQTT push) that the EZVIZ mobile app uses — a fallback only if the official Open Platform cannot be used; unsupported and ToS-sensitive. https://github.com/RenierM26/pyEzvizApi
