# tapo-ezviz-v380

Review: 69 claims confirmed, 12 corrected, 2 could not be verified.

## Summary

Tapo is the most hub-friendly of the four families: every non-battery Tapo camera exposes RTSP on 554 (/stream1 HD, /stream2 SD), ONVIF Profile S with PTZ on port 2020 (camera-account credentials), and a reverse-engineered local HTTPS JSON API (pytapo) on 443 for PTZ, presets, privacy mask, reboot and status; TP-Link's own FAQ says the only way to change a Tapo camera's Wi-Fi is to reset and reconfigure it, and the 4G models (C501GW/TC40GW) lose ONVIF in 4G mode and have no public cloud API, so over the SIM path a Tapo camera is reachable only from the Tapo app. EZVIZ cameras give local RTSP with admin + the 6-letter verification code once RTSP is enabled (per-camera app toggle, or flip it programmatically through Hikvision HCNetSDK on port 8000), ONVIF only on a published model/firmware list, and PTZ / Wi-Fi list / reboot / snapshots through the consumer cloud API (pyEzvizApi, unofficial) or the official EZVIZ Open Platform HTTP API (token, live address, PTZ start/stop) - both of which keep working over a SIM because they go through EZVIZ's cloud. V380 Pro cameras speak an encrypted proprietary protocol on TCP 8800; RTSP/ONVIF can sometimes be unlocked by an SD-card file (ceshi.ini), otherwise the V380Decoder bridge converts a LAN or cloud-relay session into RTSP/ONVIF; XMEye/ICSee (Xiongmai) cameras speak DVRIP/Sofia on TCP 34567 (go2rtc dvrip://, python-dvr) which gives live video, two-way audio, OPPTZControl, reboot and - uniquely - a documented Wi-Fi change (ConfigSet NetWork.Wifi), but neither V380 nor XMEye has a public cloud API, so for a third-party hub they are LAN-only. Generic Amazon.in/Flipkart "4G SIM cameras" are rebadged V380, ICSee, CamHi/HiP2P (Hi3510 CGI), YCC365 or Tuya units; CamHi is the only one with a documented HTTP API to read/scan/set Wi-Fi, YCC365 exposes RTSP plus ONVIF-style PTZ SOAP on port 80, and Tuya is cloud-only (allocate an RTSP/HLS URL, send ptz_control commands) but therefore works over the SIM path via Tuya Cloud. In every family the SIM puts the camera behind carrier CGNAT: no inbound RTSP/ONVIF/HTTP is possible, so "manual access when Wi-Fi is reset" must go via a vendor cloud API (EZVIZ, Tuya, V380 relay) or via a local SoftAP the camera raises after reset (EZVIZ_<SN>, XM xmTEXT/camera_XXXX) that the phone joins directly.

## Corrections from review (these override anything below)

- **Claim:** FACT 6: pytapo uses HTTPS 443 + stream port 8800; control POST https://{host}/stok={stok}/ds wrapped in multipleRequest; transports klap/tpap/pytapo; TPAP discovered via GET https://host/ returning {tpap:{pake:[2]}}; login uses camera-account credentials; -40401 = stok expired
  **Correction:** Ports, /stok=<stok>/ds, multipleRequest wrapping, the three transport names and -40401 retry are correct. Two errors: (1) TPAP discovery is NOT a GET. It is POST https://{host}:443/ with JSON {"method":"login","params":{"sub_method":"discover"}}; TPAP is selected when result.tpap.pake contains 2, OR when the legacy probe POST {"method":"login","params":{"encrypt_type":"3","username":"admin","cnonce":<16 hex upper>}} answers error_code -40211 (some firmware, e.g. C510W 1.3.4, refuses discover with -40209). (2) Credentials: pytapo README says try the Camera Account first; if that gives 'Invalid authentication data' use user 'admin' with the TP-Link CLOUD account password. TPAP (SPAKE2+) firmware (e.g. C200 hw5 fw 1.4.6) needs the cloud password: Tapo(host,'admin',password,cloudPassword=cloud_password). KLAP is detected by GET http://{host}:443 whose body contains '200 OK'.
  Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/tpap/tpap.py ; https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/__init__.py ; https://raw.githubusercontent.com/JurajNyiri/pytapo/main/README.md
- **Claim:** FACT 7: pytapo legacy secure login (cnonce / encrypt_type 3 / -40413 / device_confirm / digest_passwd / stok + start_seq / user_group root), insecure form hashed:true MD5
  **Correction:** The formulas are right (device_confirm == SHA256(cnonce+HP+nonce).upper()+nonce+cnonce; digest_passwd = SHA256(HP+cnonce+nonce).upper()+cnonce+nonce; HP = MD5-upper or SHA256-upper of the password; user_group must be 'root'), but the username is NOT hard-coded 'admin': the code sends "username": self.user (whatever the caller passed). With user 'admin' the password must be the TP-Link cloud password, not the camera-account password. Request encryption after secure login is AES-128-CBC: hashedKey = SHA256(cnonce+HP+nonce).upper(); lsk = SHA256('lsk'+cnonce+nonce+hashedKey)[:16]; ivb = SHA256('ivb'+cnonce+nonce+hashedKey)[:16]; body = {"method":"securePassthrough","params":{"request":base64(AES-CBC(pkcs7(json)))}}; headers Seq:<seq> and Tapo_tag: SHA256(SHA256(HP+cnonce).upper()+json+str(seq)).upper().
  Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/pytapo/pytapo.py (lines 94-103, 292, 467, 573-583, 658, 685-696)
- **Claim:** FACT 19: EZVIZ PTZ values UP/DOWN/LEFT/RIGHT with START/STOP; HA sends START on press and STOP on release
  **Correction:** String values are right, but Home Assistant's button press() sends START and then STOP immediately in the same call (a short nudge); there is no press/release pairing. For hold-to-move the hub must send action=START on pointer-down and action=STOP on pointer-up itself.
  Source: https://raw.githubusercontent.com/home-assistant/core/dev/homeassistant/components/ezviz/button.py
- **Claim:** FACT 42: LTE/4G carriers normally place SIM devices behind CGNAT so port forwarding does not work; workaround mesh VPN or vendor cloud
  **Correction:** The cited article says the opposite about mobile: 'A cellular/mobile data connection (4G/5G) typically provides a real public IP address - most mobile carriers have not deployed CGNAT at scale, though this is changing.' It does confirm that port forwarding fails under CGNAT and that Tailscale/ZeroTier/cloud relay work because they are outbound. For India the conclusion still holds on community evidence (Jio gives no public IPv4; Airtel now hands out CGNAT addresses; IPv6 inbound is firewalled), but it is not established by the cited source. Design rule: assume SIM path = vendor cloud only, and have the hub record per SIM whether the WAN address is in 100.64.0.0/10 or IPv6-only.
  Source: https://therelay.net/blog/ip-cameras-behind-cgnat ; https://dev.to/jagadeesh0074/exposing-services-behing-cgnat-my-home-lab-experience-with-jio-fiber-2ed2 ; https://techenclave.com/t/airtel-fiber-port-forwarding-over-ipv6/274228
- **Claim:** ENDPOINT 2: Tapo ONVIF POST http://{ip}:2020/onvif/device_service plus /onvif/media_service and /onvif/ptz_service; WS-UsernameToken digest; Camera Account
  **Correction:** http://{ip}:2020/onvif/device_service and WS-Security UsernameToken PasswordDigest (Base64(SHA1(nonce+created+password))) are confirmed by go2rtc. The paths /onvif/media_service and /onvif/ptz_service are not in any source; reports of real Tapo responses show GetServices/GetCapabilities returning http://{ip}:2020/onvif/service as the XAddr for media, events, imaging and PTZ. Never hard-code: read XAddrs from GetCapabilities (Category All) and use them. Content-Type application/soap+xml;charset=utf-8.
  Source: https://raw.githubusercontent.com/AlexxIT/go2rtc/master/pkg/onvif/client.go ; https://raw.githubusercontent.com/AlexxIT/go2rtc/master/pkg/onvif/envelope.go ; https://github.com/KelianS/vyzio/issues/89 (third-party, medium confidence)
- **Claim:** ENDPOINT 3: Tapo transport discovery: GET https://{ip}:443/ reveals {tpap:{pake:[2]}}; http://{ip}:443 returning '200 OK' => KLAP; else legacy
  **Correction:** TPAP discovery is POST https://{ip}:443/ with body {"method":"login","params":{"sub_method":"discover"}} (TLS verify off); TPAP when result.tpap.pake includes 2. Fallback detection: POST {"method":"login","params":{"encrypt_type":"3","username":"admin","cnonce":"<16 hex upper>"}} returning error_code -40211 also means TPAP. The KLAP check (plain HTTP GET http://{ip}:443, body contains '200 OK', 2 s timeout) is correct. Order in pytapo: KLAP check, then TPAP, else legacy.
  Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/tpap/tpap.py (lines 58-99) ; https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/__init__.py (lines 70-81, 142-152)
- **Claim:** ENDPOINT 4: Tapo legacy insecure login POST https://{ip}:443/ {method:login, params:{hashed:true, password:<UPPER MD5 of camera-account password>, username:'admin'}}
  **Correction:** Body shape is right but username is the caller-supplied user ("username": self.user), not a fixed 'admin'. Use either {camera-account username + MD5-upper of camera-account password} or {'admin' + MD5-upper of the TP-Link cloud password}. Required headers: Host, Referer https://{ip}:443, User-Agent 'Tapo CameraClient Android', requestByApp 'true', Content-Type 'application/json; charset=UTF-8'; self-signed TLS.
  Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/pytapo/pytapo.py ; https://raw.githubusercontent.com/JurajNyiri/pytapo/main/README.md
- **Claim:** ENDPOINT 5: Tapo secure login (encrypt_type 3) two round-trips with cnonce/nonce/device_confirm/digest_passwd, username admin, Camera Account
  **Correction:** Flow and hash formulas are correct; username is the caller-supplied user, and when it is 'admin' the password is the TP-Link cloud password. Success response gives result.stok, result.start_seq and result.user_group (must be 'root'). Lockout: response data.code -40404 with sec_left > 0 means 'Temporary Suspension: try again in N seconds' - stop retrying; -40411 = invalid credentials. Newer firmware answers this probe with -40211, meaning use TPAP instead.
  Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/pytapo/pytapo.py (lines 467-752)
- **Claim:** ENDPOINT 14: EZVIZ enable RTSP via HCNetSDK login on 8000 then NET_DVR_STDXMLConfig PUT /ISAPI/EZVIZ/IPC/System/servicesSwitch?format=json body {servicesSwitch:{hiksdk:1,web:1,upnp:0,rtsp:1}}
  **Correction:** The tool sends ServiceSwitchConfig(1, 1, 1, 1), i.e. {"servicesSwitch":{"hiksdk":1,"web":1,"upnp":1,"rtsp":1}} - upnp is 1, and upnp:0 is untested. The whole string 'PUT /ISAPI/EZVIZ/IPC/System/servicesSwitch?format=json\r\n{json}\r\n' is passed as lpRequestUrl with lpInBuffer = null. Port 8000 is the tool's default (--port). README notes RTSP is turned off again at every reboot on a C3X, hence the watchdog loop.
  Source: https://raw.githubusercontent.com/ylemoigne/ezviz-enable-rtsp/main/src/main/java/fr/javatic/ezvizEnableRtsp/Main.java ; .../hikvisionSdk/Hikvision.java ; .../hikvisionSdk/ServiceSwitchConfig.java
- **Claim:** ENDPOINT 20: EZVIZ reboot POST /api/device/v2/sysOper/{serial}; snapshot POST /v3/devconfig/v1/{serial}/{channel}/capture; switch PUT /v3/devices/{serial}/switchStatus {enable, serial, channelNo, type}
  **Correction:** Reboot is correct: POST /api/device/v2/sysOper/{serial} form {oper:1, deviceSerial, delay:1}, success resultCode '0', '-1' = unreachable (retry). Snapshot is PUT (not POST) /v3/devconfig/v1/{serial}/{channel}/capture with no body. Switch (v3) is PUT /v3/devices/{serial}/{channel}/{0|1}/{switch_type}/switchStatus with no body; fallback legacy is POST /api/device/switchStatus form {serial, enable:'0'|'1', type, channel}.
  Source: https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/client.py (lines 1461-1535, 2416-2443, 2906-2923)
- **Claim:** ENDPOINT 35: Hi3510 PTZ GET /cgi-bin/hi3510/ptzctrl.cgi?-step={0|1}&-act={...}&-speed={1..63}; preset.cgi?-act=presetgo|presetsave&-number=n
  **Correction:** The cited source sends only -step and -act: GET /cgi-bin/hi3510/ptzctrl.cgi?-step=<0|1>&-act=<action> (default step 0), and treats the call as successful only if the body contains '[Succeed]'. There is no -speed parameter in ha-hi3510; its README documents a speed of 0-4 (PTZ_MAX_SPEED = 4, PTZ_MAX_PRESETS = 16). The '-speed=1..63' range is INSTAR-specific and was not found in the cited file - omit it unless verified on the actual camera. Preset URLs are correct.
  Source: https://raw.githubusercontent.com/spagonic/ha-hi3510/main/custom_components/hi3510/api.py (lines 301-316) ; .../const.py
- **Claim:** ENDPOINT 37: YCC365 Plus RTSP /0/av0, /0/av1; PTZ POST http://{ip}/onvif/PTZ ContinuousMove Profile_1 with x=+/-1, y=+/-1; Stop PanTilt true Zoom true
  **Correction:** The code uses velocity 0.5, not 1: left <tt:PanTilt x="-0.5" y="0"/>, right x="0.5", up y="0.5", down y="-0.5", always with <tt:Zoom x="1"/>; header Content-Type: application/soap+xml;charset=UTF8; no auth header; then sleeps move_time (default 0.3 s) and POSTs tptz:Stop (ProfileToken Profile_1, PanTilt true, Zoom true). RTSP URLs are correct (1280x720 H.264; av0/av1 carry mono 8 kHz audio).
  Source: https://raw.githubusercontent.com/fjramirez1987/PTZ-YCC365/master/custom_components/ptz_camera/__init__.py ; https://raw.githubusercontent.com/fjramirez1987/PTZ-YCC365/master/README.md

## Added by review (things an implementer needs)

- **Tapo: 'Third-Party Compatibility' must be switched on in the Tapo app before any local API/RTSP/ONVIF client works on current firmware** Tapo App -> Me -> Third-Party Compatibility -> On. The Tapo-Control README troubleshooting says to toggle it off/on and open the camera once in the Tapo app on the same LAN when logins fail with 'Invalid cloud password'. The hub's Tapo onboarding screen must tell the owner to do this, in addition to creating the Camera Account. (https://raw.githubusercontent.com/JurajNyiri/HomeAssistant-Tapo-Control/main/README.md (lines 51-55, 213-220))
- **Tapo Camera Account constraints and menu path** Tapo app: camera Live View -> gear icon -> Advanced Settings -> Camera Account. Username and password must each be 6 to 32 characters; TP-Link advises avoiding special characters if RTSP fails. RTSP form: rtsp://username:password@IP:554/stream1. (https://www.tp-link.com/support/faq/2680/ ; https://www.tapo.com/us/faq/724/ (Q13 step 3))
- **Tapo TPAP (SPAKE2+) login bodies - required for current firmware** All to POST https://{ip}:443/ as {"method":"login","params":{...}} with headers requestByApp:true, Referer:https://{ip}:443, User-Agent:'Tapo CameraClient Android', Content-Type/Accept application/json. Step 1 params {sub_method:'pake_register', username:<md5 hex of 'admin', or SHA256-upper of 'admin' when discover returned user_hash_type==1>, user_random:<base64 of 32 random bytes>, cipher_suites:[1], encryption:['aes_128_ccm'], passcode_type:'userpw'}. Step 2 params {sub_method:'pake_share', user_share:<base64>, user_confirm:<base64>}; result has dev_confirm, stok, start_seq, expired (seconds, default 3600). Passcode candidates in order: md5_hex(cloud password), SHA256-upper(cloud password), each passed through 'extra_crypt' from the register result. Channel: POST {base}/stok={stok}/ds, Content-Type application/octet-stream, body = seq (u32 big-endian) + AES-128-CCM ciphertext + 16-byte tag, nonce = sessionNonce[:8] + seq (u32 BE), seq increments per request; only multipleRequest is accepted on /ds. A plain-JSON reply (starts with '{') means the request was refused before decryption. Error -40401 on pake_share = wrong passcode; sec_left > 0 = lockout. C200 fw 1.4.6 rejects the first pake_share after a session ends, so retry the known-good passcode once rather than trying another. (https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/tpap/tpap.py ; protocol write-up referenced there: https://github.com/freeKC/tapo-v4-protocol)
- **Tapo login lockout must be respected by the hub** Failed logins trigger a temporary suspension: responses carry data.code -40404 and sec_left (seconds). pytapo raises 'Temporary Suspension: Try again in N seconds'. The adapter must back off for sec_left and never loop password variants, otherwise the owner's Tapo app is locked out of the camera too. The passwordless probe (encrypt_type 3 with cnonce only) does not count toward lockout. (https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/pytapo/pytapo.py (lines 724-738) ; https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/tpap/tpap.py (rejects_legacy_login docstring))
- **Tapo 8800 stream implementation details the researcher omitted** Plain HTTP (not TLS) to port 8800. First POST /stream returns 401 with WWW-Authenticate: Digest; after auth the 200 response has a 'Key-Exchange' header containing nonce="..." (and encrypt_type="3" / username="none" markers). Requests are written as multipart parts: '----client-stream-boundary--\r\nContent-Type: application/json\r\nContent-Length: N\r\n\r\n{json}\r\n'; the reply part JSON gives params.session_id. Media parts arrive under boundary '--device-stream-boundary--' with Content-Type video/mp2t and a Content-Length; decrypt each part with AES-128-CBC (IV reset per part) and strip PKCS7 padding, then demux MPEG-TS. Audio is PCMA/8000, but newer firmware sends PCMU/16000 (go2rtc transcodes). For hub child cameras add ?deviceId=<id> to the POST URL; ?channel=N selects the channel. Two-way audio uses a second connection. go2rtc already does all of this, so the hub should hand tapo:// URLs to go2rtc rather than re-implement. (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/pkg/tapo/client.go)
- **Tapo ONVIF: read service XAddrs, do not assume per-service paths; auth is WS-Security PasswordDigest** go2rtc posts to http://{ip}:2020/onvif/device_service with Content-Type application/soap+xml;charset=utf-8 and a wsse:UsernameToken where Password Type=...#PasswordDigest = Base64(SHA1(nonce + created + password)), Nonce Base64, Created RFC3339 UTC. First call tds:GetCapabilities with Category All and use the returned media/PTZ/events XAddrs (reported as http://{ip}:2020/onvif/service on Tapo). Events: Tapo-Control notes some cameras/firmwares freeze when both webhook and PullPoint subscriptions are created, and Tapo cameras cannot post to HTTPS webhooks. (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/pkg/onvif/envelope.go ; https://raw.githubusercontent.com/AlexxIT/go2rtc/master/pkg/onvif/client.go ; https://raw.githubusercontent.com/JurajNyiri/HomeAssistant-Tapo-Control/main/README.md (lines 436-441) ; https://github.com/KelianS/vyzio/issues/89)
- **Tapo extra LAN ports and discovery behaviour** Besides 443/8800/554/2020: UDP/20005 broadcast carries doorbell-press events, and chimes are controlled on TCP/80 (control port 80 instead of 443). SD card + Tapo Care together disables NVR (RTSP/ONVIF) recording. The integration warns never to forward these ports on the WAN. (https://raw.githubusercontent.com/JurajNyiri/HomeAssistant-Tapo-Control/main/README.md (lines 35-49, 67))
- **EZVIZ cloud client requirements: headers, password hashing, error codes, account type** Password is sent as lowercase MD5 hex of the account password. Session headers used by pyEzvizApi: featureCode (stable per install), clientType '3', customno '1000001', clientNo 'web_site', appId 'ys7', language 'en_GB', lang 'en', User-Agent 'okhttp/3.12.1'; after login add header sessionId. Login response: meta.code 200 -> loginSession.sessionId, loginSession.rfSessionId, loginArea.apiDomain (use this host from then on); 1100 = wrong region, retry against loginArea.apiDomain; 1012 bad MFA code; 1013 bad username; 1014 bad password; 1015 user locked; 6002 MFA required (library then POSTs /v3/sms/nologin/checkcode with {from: account, bizType:'TERMINAL_BIND'} and login must be retried with smsCode, msgType '3', bizType 'TERMINAL_BIND'). Session refresh endpoint /v3/apigateway/login, logout /v3/users/logout/v2. Home Assistant docs: needs a native EZVIZ account with two-step verification disabled; Google/Facebook/TikTok OAuth accounts do not work. Default host apiieu.ezvizlife.com (Russia apirus.ezvizru.com); a bare region code 'xx' expands to apii{xx}.ezvizlife.com. (https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/client.py ; https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/constants.py ; https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/api_endpoints.py ; https://raw.githubusercontent.com/home-assistant/home-assistant.io/current/source/_integrations/ezviz.markdown)
- **EZVIZ cloud: additional useful endpoints (push events, absolute PTZ)** Push/alarm notifications: MQTT registration /v1/getClientId, start /api/push/start, stop /api/push/stop (this is how the hub can get 'action completed'/alarm events over the SIM path). Absolute PTZ: PUT via /v3/iot-feature/action/{SERIAL}/... resource 'Video_1', local index '1', domain 'PTZManualCtrl', action 'CtrlPTZ3DPosition', payload {positionCtrlType:'point', positionPoint:{x:0..1,y:0..1}, positionRect:{height:1.0,width:1.0,x:0.0,y:0.0}}. Siren: PUT /v3/devices/{serial}/alarm/sound. The cloud pagelist also reports each camera's local_ip and local_rtsp_port, which Home Assistant uses to build rtsp://{user}:{verification code}@{local_ip}:{local_rtsp_port}/Streaming/Channels/102. (https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/api_endpoints.py ; https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/client.py (lines 4081-4135) ; https://raw.githubusercontent.com/home-assistant/core/dev/homeassistant/components/ezviz/camera.py (line 58))
- **EZVIZ local RTSP is not persistent and not universal** On at least the C3X, RTSP is disabled again at every camera reboot, so the hub needs a watchdog (probe TCP 554; re-enable via HCNetSDK on port 8000 or prompt the owner). Some models have no RTSP at all (EZVIZ support told a user the EP3X Pro doorbell does not support it; DP2C likewise). The HCNetSDK route needs Hikvision's native library (the reference tool ships as a Docker image), which is a real cost for a Windows-now / Raspberry-Pi-later Node hub. (https://raw.githubusercontent.com/ylemoigne/ezviz-enable-rtsp/main/README.md ; https://community.home-assistant.io/t/ezviz-rtsp-enable/736416)
- **EZVIZ EB8 4G has no Wi-Fi, so 'Wi-Fi with SIM fallback' applies only to EB8 Pro 4G / HB8 Lite 4G class models** The EB8 4G product page states it does not support using a Wi-Fi network (4G LTE only, Micro SIM with Nano-to-Micro adapter). EB8 Pro 4G and HB8 Lite 4G are Wi-Fi + 4G with automatic switch and Nano SIM. For a 4G-only camera there is no LAN path at all: live view and PTZ are cloud-only. (https://www.ezviz.com/product/EB8-4G/46565 ; https://www.ezviz.com/product/eb8+pro+4g/190111 ; https://www.ezviz.com/product/hb8-lite-4g/68027)
- **DVRIP PTZ start/stop semantics (hold-to-move) and framing gotchas** python-dvr's ptz_step shows the real continuous-move protocol: send OPPTZControl with the direction Command and Parameter.Preset = 65535 to START moving, then the same Command with Parameter.Preset = -1 to STOP; if the stop message is lost the camera keeps moving forever, so the hub must always send stop on pointer-up and on disconnect. That variant also includes "POINT":{bottom:0,left:0,right:0,top:0} and "Pattern":"SetBegin". ptz() sets Tour = 1 for StartTour/StopTour. Message framing: len field = JSON bytes + 2 and the payload ends with 0x0A 0x00; SessionID is the string '0x%08X'; KeepAlive body {"Name":"KeepAlive","SessionID":"0x.."} every AliveInterval seconds (default 20) or the session drops. The login reply key is literally 'DeviceType ' with a trailing space. Useful Ret codes: 100 OK, 106/203 bad credentials, 205 IP locked, 150 OK restart required, 502 invalid command, 605 feature not supported. (https://raw.githubusercontent.com/OpenIPC/python-dvr/master/dvrip.py (lines 20-88, 307-372, 631-641, 667-702, 1087-1117))
- **DVRIP default credentials differ between libraries** go2rtc logs in as admin/admin when the URL has no user info; python-dvr defaults to user 'admin' with an empty password. Many XM cameras ship with an empty admin password, so always put explicit credentials in the dvrip:// URL (dvrip://admin:@ip for empty) rather than relying on the default. (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/pkg/dvrip/client.go (lines 76-78) ; https://raw.githubusercontent.com/OpenIPC/python-dvr/master/dvrip.py (lines 146-154))
- **XM battery cameras sleep, which breaks always-on hub polling** The dvrip-cam target (Hi3518EV200, LiteOS, battery) goes to sleep after roughly 30-90 s idle; DVRIP on TCP 34567 is its only control/video channel, the web UI on :80 is a stock OCX page, and video is H.264 1080p Main / D1 Extra with G.711 A-law 8 kHz audio. The hub must treat such units as wake-on-demand, not as permanently reachable LAN devices. (https://raw.githubusercontent.com/kwebmn/dvrip-cam/main/docs/SPEC.md (section 2))
- **Hi3510 CGI response format and extra commands needed by an adapter** Responses are JavaScript-style lines 'var key="value";' that must be parsed; setters/PTZ succeed only when the body contains '[Succeed]'. Device probe: GET /cgi-bin/hi3510/param.cgi?cmd=getserverinfo; network info cmd=getnetattr; reboot cmd=sysreboot; ONVIF can be toggled via the integration's set_onvif_attr (default port 8080 in that code). HTTP 401 carries WWW-Authenticate: Basic realm="hi3510". Default HTTP port 80, RTSP 554. Query values must be URL-encoded while the '-key' names stay raw. Wi-Fi test flow on INSTAR: chkwirelessattr then poll getchkwireless for the result before calling setwirelessattr. (https://raw.githubusercontent.com/spagonic/ha-hi3510/main/custom_components/hi3510/api.py ; https://raw.githubusercontent.com/spagonic/ha-hi3510/main/README.md ; https://wiki.instar.com/en/1080p_Series_CGI_List/Network_Menu/WiFi/)
- **V380Decoder runtime footprint and control API** Requires .NET 10 SDK to build, plus FFmpeg (snapshots), GStreamer base/good/bad/RTSP plugins and MediaMTX for RTSP output - heavy for a Raspberry Pi; a Docker image bundles MediaMTX. REST control when --enable-api: POST http://host:8080/api/ptz/{right|left|up|down}, POST /api/light/{on|off|auto}, POST /api/image/{color|bw|auto|flip}, GET /api/status; ONVIF endpoint http://host:8080/onvif/device_service; MJPEG at /mjpeg; --secure reuses the camera's username/password. /live-low is video-only. theMavl's repo is a fork; upstream is PyanSofyan/V380Decoder, and neither publishes a licence, so the code cannot be vendored - run it as an external process only. (https://raw.githubusercontent.com/theMavl/V380Decoder/main/README.md ; https://api.github.com/repos/theMavl/V380Decoder)
- **V380 cloud credentials are weakly protected - relevant to using --source cloud over the SIM path** Besides cleartext relay credentials, the research cites a hard-coded key 'macrovideo+*#!^@' used to encrypt packets containing the device admin password sent from the app to the backend, enumeration of cloud device IDs, and observed third-party brute-forcing of device passwords through the relay. Use a unique strong camera password and treat V380 units as untrusted on the LAN (separate VLAN/SSID). (https://raw.githubusercontent.com/dunderhay/CCTV-v380-pro/master/README.md (lines 31-33, 158-182))
- **Tuya India endpoints and WebRTC caveat** go2rtc's region table has India as host protect-in.ismartlife.me (country code IN) for the Tuya Smart API. Not all cameras deliver an hd stream over WebRTC even when the camera supports it (use resolution=sd as fallback). Cloud API mode needs device_id, uid, client_id, client_secret and the 'IoT Video Live Stream' service authorised under Service API in the Tuya Developer Platform (free trial, so it can lapse). (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/pkg/tuya/smart_api.go (lines 254-259) ; https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/tuya/README.md)
- **SIM reachability must be measured, not assumed** The only source cited for 'SIM = CGNAT' actually claims mobile connections typically get a public IP. Evidence for Indian carriers (Jio: no public IPv4; Airtel: CGNAT for newer users; IPv6 inbound blocked by carrier firewall) is community-level only. The hub design should therefore treat the SIM path as vendor-cloud-only by default, but expose a per-device 'reachability' probe result instead of hard-coding the assumption. (https://therelay.net/blog/ip-cameras-behind-cgnat ; https://dev.to/jagadeesh0074/exposing-services-behing-cgnat-my-home-lab-experience-with-jio-fiber-2ed2 ; https://techenclave.com/t/airtel-fiber-port-forwarding-over-ipv6/274228)

## Calls

### Tapo RTSP main stream

```
rtsp RTSP DESCRIBE/PLAY rtsp://{camera_user}:{camera_pass}@{ip}:554/stream1
```
- Params: stream1 = HD; stream2 = SD; dual-lens telephoto stream6/stream7
- Auth: Tapo 'Camera Account' (app: Settings > Advanced Settings > Camera Account)
- Response: H.264 (+AAC/PCM) RTP stream; max 3 concurrent local viewers per camera
- Notes: Not available on battery models C410/C420/C425/D230; feed it to go2rtc (rtsp://... source) to get WebRTC in the browser
- Source: https://www.tapo.com/us/faq/724/

### Tapo ONVIF device/media/PTZ services

```
soap POST (SOAP 1.2, WS-UsernameToken digest) http://{ip}:2020/onvif/device_service (and /onvif/media_service, /onvif/ptz_service returned by GetCapabilities)
```
- Params: PTZ ContinuousMove{ProfileToken, Velocity.PanTilt x/y}, Stop, GotoPreset{PresetToken}, SetPreset; Media GetStreamUri; Events PullPoint for motion
- Auth: Camera Account username/password
- Response: ONVIF Profile S responses; GetStreamUri returns the rtsp://...:554/stream1 URL
- Notes: go2rtc example onvif://admin:password@192.168.1.123:2020; Dot11 (Wi-Fi) operations not documented on Tapo - probe GetDot11Capabilities and expect unsupported
- Source: https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/onvif/README.md

### Tapo local API: transport discovery

```
https GET (TPAP discovery) / POST login probe https://{ip}:443/
```
- Params: GET body reveals {"tpap":{"pake":[2],...}} on newest firmware => use SPAKE2+ (TPAP) transport; http://{ip}:443 returning '200 OK' plain => KLAP; otherwise legacy login
- Auth: none for discovery
- Response: JSON capability blob
- Notes: pytapo selects transport automatically: 'klap' | 'tpap' | 'pytapo' (legacy). Self-signed certificate - verify=False / pin by fingerprint
- Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/tpap/tpap.py

### Tapo local API: legacy insecure login

```
https POST https://{ip}:443/
```
- Params: {"method":"login","params":{"hashed":true,"password":"<UPPERCASE MD5 of camera-account password>","username":"admin"}}
- Auth: Camera Account
- Response: {"result":{"stok":"..."},"error_code":0}
- Notes: Only older firmware; newer firmware answers -40413 and requires the encrypt_type=3 flow
- Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/pytapo/pytapo.py

### Tapo local API: secure login (encrypt_type 3)

```
https POST (two round-trips) https://{ip}:443/
```
- Params: 1) {"method":"login","params":{"cnonce":"<8 hex UPPER>","encrypt_type":"3","username":"admin"}} -> error_code -40413 with result.data.nonce, result.data.device_confirm, result.data.encrypt_type. 2) verify device_confirm == SHA256(cnonce+HP+nonce).upper()+nonce+cnonce where HP = MD5 or SHA256 uppercase hex of the camera-account password (pick whichever matches), then POST {"method":"login","params":{"cnonce":cnonce,"encrypt_type":"3","digest_passwd":SHA256(HP+cnonce+nonce).upper()+cnonce+nonce,"username":"admin"}}
- Auth: Camera Account
- Response: {"result":{"stok":"...","start_seq":n,"user_group":"root"}}; subsequent bodies AES-encrypted with lsk/ivb derived from nonce+cnonce+HP and a Seq header
- Notes: user_group must be 'root' (third-party/shared accounts rejected). Use pytapo rather than re-implementing; error -40401 = stok expired, re-login
- Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/pytapo/pytapo.py

### Tapo local API: control channel

```
https POST https://{ip}:443/stok={stok}/ds
```
- Params: {"method":"multipleRequest","params":{"requests":[{"method":"<name>","params":{...}}, ...]}} (TPAP/secure transports encrypt this body)
- Auth: stok from login
- Response: {"result":{"responses":[{"method":..,"result":{..},"error_code":0}]},"error_code":0}
- Notes: Same path for KLAP/TPAP; the /ds channel only accepts multipleRequest
- Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/tpap/tpap.py

### Tapo local API: device info / status

```
https POST https://{ip}/stok={stok}/ds
```
- Params: {"method":"getDeviceInfo","params":{"device_info":{"name":["basic_info"]}}}; {"method":"getConnectionType","params":{"network":{"get_connection_type":[]}}}; {"method":"getDeviceIpAddress","params":{"network":{"name":["wan"]}}}; {"method":"getSdCard"...}; {"method":"getMotorCapability"} = {"method":"get","motor":{"name":["capability"]}}
- Auth: stok
- Response: basic_info (model, fw, mac, dev_id...), connection type incl. SSID/signal, wan ip
- Notes: Use getConnectionType SSID/RSSI to detect 'Wi-Fi changed / weak' and raise the notification
- Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/__init__.py

### Tapo local API: PTZ move

```
https POST https://{ip}/stok={stok}/ds
```
- Params: {"method":"motorMove","params":{"motor":{"move":{"x_coord":"<deg>","y_coord":"<deg>"}}}}  |  {"method":"relativeMove","params":{"motor":{"movestep":{"direction":"<0|90|180|270>"}}}}  |  {"method":"manualCalibrate","params":{"motor":{"manual_cali":""}}}  |  cruiseMove {"motor":{"cruise":{"coord":"x|y"}}} / cruiseStop {"motor":{"cruise_stop":{}}}
- Auth: stok
- Response: error_code 0
- Notes: pytapo.moveMotor(x,y), moveMotorStep(angle): 0=clockwise,180=counter-clockwise,90=vertical,270=horizontal
- Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/__init__.py

### Tapo local API: PTZ presets

```
https POST https://{ip}/stok={stok}/ds
```
- Params: list: {"method":"getPresetConfig","params":{"preset":{"name":["preset"]}}}  |  save current position: {"method":"addMotorPostion","params":{"preset":{"set_preset":{"name":"<name>","save_ptz":"1"}}}}  |  go to: {"method":"motorMoveToPreset","params":{"preset":{"goto_preset":{"id":"<id>"}}}}  |  delete: {"method":"deletePreset","params":{"preset":{"remove_preset":{"id":["<id>"]}}}}
- Auth: stok
- Response: getPresetConfig -> {"preset":{"preset":{"id":[...],"name":[...]}}}
- Notes: 'addMotorPostion' typo is the real method name on the camera
- Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/__init__.py

### Tapo local API: privacy mode / reboot / LED / alarm

```
https POST https://{ip}/stok={stok}/ds
```
- Params: {"method":"setLensMaskConfig","params":{"lens_mask":{"lens_mask_info":{"enabled":"on|off"}}}}  |  {"method":"rebootDevice","params":{"system":{"reboot":"null"}}} (KLAP devices: {"method":"device_reboot","params":{"delay":0}})  |  setLedStatus, setAlarm (msg_alarm), setPrivacyMode, setNotificationsEnabled per pytapo
- Auth: stok
- Response: error_code 0
- Notes: Reboot is the 'kick the camera' action when Wi-Fi is flaky; it does not change SSID
- Source: https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/__init__.py

### Tapo proprietary stream port 8800 (go2rtc tapo:// / pytapo HttpMediaSession)

```
http POST, long-lived multipart/mixed POST /stream HTTP/1.1 to {ip}:8800 (go2rtc source URL: tapo://{cloud-password}@{ip}?subtype=0|1)
```
- Params: Header Content-Type: multipart/mixed; boundary=--client-stream-boundary--; then JSON parts {"type":"request","seq":n,"params":{"preview":{"channels":[0],"resolutions":["HD"|"VGA"],"audio":["default"]},"method":"get"}}; playback/download uses ?type=sdvod&start_time=
- Auth: HTTP Digest: username admin, password = UPPERCASE MD5 of Tapo CLOUD password, or UPPERCASE SHA256 when challenge contains encrypt_type="3"; go2rtc autodetects when given tapo://cloud-password@ip
- Response: multipart parts Content-Type video/mp2t (AES-128-CBC encrypted with key MD5(nonce:password), iv MD5(username:nonce)) plus JSON notifications (stream_status, session_id)
- Notes: Only route for battery/solar/hub Tapo cameras without RTSP; two-way audio supported by go2rtc; cannot be used as an RTSP source directly - let go2rtc do it
- Source: https://raw.githubusercontent.com/AlexxIT/go2rtc/master/pkg/tapo/client.go

### Tapo Wi-Fi change

```
https n/a NONE - no local or cloud endpoint; TP-Link: 'the only way to change wireless networks is to reset and reconfigure the camera'
```
- Params: Reset button 5s -> Tapo app onboarding (BLE/SoftAP) with new SSID
- Auth: n/a
- Response: n/a
- Notes: Hub can only detect loss (ping/RTSP fail, getConnectionType) and notify; C501GW/TC40GW 4G models fall back to LTE automatically instead
- Source: https://www.tapo.com/us/faq/754/

### EZVIZ local RTSP

```
rtsp RTSP rtsp://admin:{VERIFICATION_CODE}@{ip}:554/ch1/main  (sub: /ch1/sub; some models /Streaming/Channels/101 or /h264_stream)
```
- Params: verification code = 6 capital letters on the camera label
- Auth: admin + verification code
- Response: H.264/H.265 stream
- Notes: RTSP is off by default; enable per camera (app path or HCNetSDK call below). LAN only
- Source: https://support.ezviz.com/faq/article/How-to-set-up-C6N-TY1-TY2-as-a-webcam

### EZVIZ enable RTSP programmatically (Hikvision HCNetSDK)

```
tcp HCNetSDK native call (ISAPI tunnelled through SDK port 8000) NET_DVR_Login_V40({ip}, port 8000, 'admin', verification_code) then NET_DVR_STDXMLConfig(userId, request 'PUT /ISAPI/EZVIZ/IPC/System/servicesSwitch?format=json' + CRLF + body)
```
- Params: body {"servicesSwitch":{"hiksdk":1,"web":1,"upnp":0,"rtsp":1}} (ints)
- Auth: admin + verification code
- Response: XML/JSON status buffer from NET_DVR_XML_CONFIG_OUTPUT; port 554 opens afterwards
- Notes: Wrap the ylemoigne/ezviz-enable-rtsp Docker image (MIT) with --interval to auto-re-enable after firmware resets it; needs HCNetSDK .so/.dll (Hikvision download, proprietary)
- Source: https://raw.githubusercontent.com/ylemoigne/ezviz-enable-rtsp/main/src/main/java/fr/javatic/ezvizEnableRtsp/hikvisionSdk/Hikvision.java

### EZVIZ ONVIF (listed models only)

```
soap POST SOAP http://{ip}/onvif/device_service (port not published by EZVIZ; try 80, then 8000/8899)
```
- Params: Standard Profile S: GetStreamUri, PTZ ContinuousMove/Stop/GotoPreset
- Auth: admin + verification code
- Response: ONVIF responses
- Notes: Only the SKUs/firmware on EZVIZ's ONVIF list; probe per camera
- Source: https://m-support.ezviz.com/faq/article/Whether-EZVIZ-devices-support-ONVIF-protocol

### EZVIZ consumer cloud: login (pyEzvizApi)

```
cloud POST form-encoded POST https://apiieu.ezvizlife.com/v3/users/login/v5  (then use https://{loginArea.apiDomain} - pattern apii<region>.ezvizlife.com)
```
- Params: account, password (MD5 hex of the EZVIZ account password as sent by the app/library), featureCode, cuName, msgType (0 | 3 for SMS), bizType, smsCode
- Auth: EZVIZ account
- Response: loginSession.sessionId, loginSession.rfSessionId, loginArea.apiDomain, loginUser
- Notes: Unofficial; MFA may be triggered; later requests send sessionId header. Works over the SIM path because it is cloud-side
- Source: https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/client.py

### EZVIZ consumer cloud: device list with status/Wi-Fi

```
cloud GET GET https://{apiDomain}/v3/userdevices/v1/resources/pagelist?groupId=-1&limit=30&offset=0&filter=CLOUD,TIME_PLAN,CONNECTION,SWITCH,STATUS,WIFI,NODISTURB,KMS,P2P,TIME_PLAN,CHANNEL,VTM,DETECTOR,FEATURE,CUSTOM_TAG,UPGRADE,VIDEO_QUALITY,QOS,PRODUCTS_INFO
```
- Params: filter tokens as above
- Auth: sessionId
- Response: deviceInfos[], CONNECTION{localIp, wanIp, netType}, WIFI{ssid, signal}, STATUS{online}, SWITCH{...}
- Notes: Gives the camera's current LAN IP for building the RTSP URL, and online/offline + current SSID for the 'Wi-Fi reset' alert
- Source: https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/api_endpoints.py

### EZVIZ consumer cloud: PTZ

```
cloud PUT form-encoded PUT https://{apiDomain}/v3/devices/{serial}/ptzControl
```
- Params: command=UP|DOWN|LEFT|RIGHT, action=START|STOP, channelNo=1, speed=1..9 (default 5), uuid=<uuid4>, serial=<serial>
- Auth: sessionId
- Response: meta.code 200
- Notes: Send START on touch-down and STOP on touch-up; works over SIM
- Source: https://raw.githubusercontent.com/home-assistant/core/dev/homeassistant/components/ezviz/button.py

### EZVIZ consumer cloud: Wi-Fi list / network search / network command

```
cloud GET / POST GET https://{apiDomain}/v3/devconfig/{serial}/{channel}/netWork  |  POST https://{apiDomain}/v3/devconfig/{serial}/{channel}/netWork  |  POST https://{apiDomain}/v3/devconfig/{serial}/{channel}/netWork/command?targetDeviceSerial={serial}
```
- Params: channel = 1 for single-channel cameras
- Auth: sessionId
- Response: GET: Wi-Fi networks detected by the device; POST: starts a scan; /command: pushes a network-config command
- Notes: Present in pyEzvizApi (dev_config_wifi_list / dev_config_search / dev_config_send_config_command) but the SSID/password payload format is not documented - experimental, verify with a packet capture of the EZVIZ app
- Source: https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/client.py

### EZVIZ consumer cloud: reboot / snapshot / switches

```
cloud POST / PUT POST https://{apiDomain}/api/device/v2/sysOper/{serial}  |  POST https://{apiDomain}/v3/devconfig/v1/{serial}/{channel}/capture  |  PUT https://{apiDomain}/v3/devices/{serial}/switchStatus
```
- Params: sysOper: {oper:1, deviceSerial, delay}; switchStatus: {enable:0|1, serial, channelNo, type:<DeviceSwitchType int>}
- Auth: sessionId
- Response: meta.code 200 / picture URL
- Notes: Switch types (privacy, status LED, IR, etc.) enumerated in pyezvizapi constants
- Source: https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/client.py

### EZVIZ Open Platform (official): access token

```
cloud POST form POST https://open.ys7.com/api/lapp/token/get (international: {areaDomain} returned, e.g. isgpopen.ezvizlife.com)
```
- Params: appKey, appSecret
- Auth: developer appKey/appSecret from console
- Response: {"data":{"accessToken":..,"expireTime":..,"areaDomain":..},"code":"200"}
- Notes: Requires a developer account on iusopen.ezviz.com / open.ys7.com; individual eligibility not confirmed
- Source: https://pkg.go.dev/github.com/ChenWoChong/ys7

### EZVIZ Open Platform: add device / list / capture

```
cloud POST form POST {areaDomain}/api/lapp/device/add  |  POST {areaDomain}/api/lapp/device/list  |  POST {areaDomain}/api/lapp/device/capture
```
- Params: add: accessToken, deviceSerial, validateCode (the verification code); list: pageStart, pageSize; capture: deviceSerial, channelNo
- Auth: accessToken
- Response: device records / picUrl
- Notes: Device must be bound to the developer account (not the consumer app account) - one camera cannot be in both
- Source: https://pkg.go.dev/github.com/ChenWoChong/ys7

### EZVIZ Open Platform: live address

```
cloud POST form POST {areaDomain}/api/lapp/live/address/get  (also /api/lapp/live/address/limited)
```
- Params: accessToken, deviceSerial, channelNo (default 1), protocol 1=ezopen 2=hls 3=rtmp 4=flv, quality, expireTime (30s-720d for hls/rtmp/flv)
- Auth: accessToken
- Response: {"data":{"url":..,"expireTime":..}}
- Notes: HLS/FLV URL is playable in the PWA directly (hls.js) - this is the SIM-path video route for EZVIZ; goes through EZVIZ cloud
- Source: https://open.ys7.com/help/en/534

### EZVIZ Open Platform: PTZ start/stop

```
cloud POST form POST {areaDomain}/api/lapp/device/ptz/start  |  POST {areaDomain}/api/lapp/device/ptz/stop
```
- Params: accessToken, deviceSerial, channelNo, direction (0-11: up/down/left/right/diagonals/zoom in-out/focus near-far), speed (0 slow,1 medium,2 fast). Example from doc: deviceSerial=502608888&channelNo=1&direction=2&speed=1
- Auth: accessToken
- Response: {"code":"200","msg":"Operation succeeded!"}
- Notes: Doc page is marked deprecated/moving; direction-code table taken from its search excerpt - confirm in the new help centre
- Source: https://open.ys7.com/doc/en/HTTP/device_ptz.html

### V380 Pro: unlock RTSP/ONVIF via SD card

```
sd-card boot with card, wait 5+ min, remove file File ceshi.ini in root of FAT32 microSD: [CONST_PARAM]\nrtsp = 1\nrtsp_enable = 1\nrtsp_ctrl = 1  (some models rtsp_enable=1 only)
```
- Params: none
- Auth: none
- Response: RTSP on 554: rtsp://{user}:{pass}@{ip}:554/live/ch00_0 (main), /live/ch00_1 (sub); ONVIF on port 8899
- Notes: Works on many dual-lens units; fails on newer 3-lens firmware; may revert after reboot/re-pair; RTSP sometimes unauthenticated
- Source: https://gist.github.com/SolveSoul/9be5d9599c8b4b59f7cfa4cd0ce79c9c

### V380 Pro native protocol (port 8800) via V380Decoder bridge

```
tcp proprietary TCP 8800 (encrypted), bridged ./V380Decoder --id {deviceId} --username admin --password {pw} --ip {ip} --port 8800 --output rtsp --enable-onvif --enable-api  (cloud path: --source cloud, no --ip)
```
- Params: --rtsp-port 8554, --http-port 8080, --secure to require auth on outputs, --discover to find cameras
- Auth: V380 device ID + admin password
- Response: rtsp://{hub}:8554/live (+ /live-low), ONVIF server on {hub}:8080, snapshot http://{hub}:8080/snapshot, REST API for control
- Notes: '--source cloud' relays through V380 servers = the only SIM-path option for V380; tested only on device-version-31 firmware
- Source: https://raw.githubusercontent.com/theMavl/V380Decoder/main/README.md

### XMEye/ICSee DVRIP: login

```
tcp DVRIP frame (20-byte header: 0xFF,version,reserved,sessionId LE32,seq LE32,channel,endflag,msgId LE16,len LE32) + JSON + 0x0A 0x00 TCP {ip}:34567, message id 1000
```
- Params: {"EncryptType":"MD5","LoginType":"DVRIP-Web","PassWord":"<sofia_hash>","UserName":"admin"}; sofia_hash: md5 = MD5(password); for each byte pair (md5[i], md5[i+1]) take chars[(a+b) % 62] with chars=0-9A-Za-z -> 8 chars
- Auth: camera admin password (often empty on new units)
- Response: {"Ret":100,"SessionID":"0x0000000A","AliveInterval":20,"DeviceType ":...}; send KeepAlive (1006) every AliveInterval
- Notes: python-dvr DVRIPCam(ip, user='admin', password='').login()
- Source: https://raw.githubusercontent.com/OpenIPC/python-dvr/master/dvrip.py

### XMEye/ICSee DVRIP: live video / two-way audio

```
tcp DVRIP msg 1413 OPMonitor Claim then 1410 OPMonitor Start; audio: 1434 OPTalk Claim, 1430 Start, 1432 data
```
- Params: {"Name":"OPMonitor","SessionID":"0x..","OPMonitor":{"Action":"Claim"|"Start","Parameter":{"Channel":0,"CombinMode":"NONE","StreamType":"Main"|"Extra1","TransMode":"TCP"}}}; OPTalk AudioFormat {"EncodeType":"G711_ALAW"}
- Auth: session
- Response: binary H.264/H.265 frames with 0x1FC/0x1FD/0x1FA headers
- Notes: Simplest: go2rtc dvrip://admin:pass@{ip}:34567?channel=0&subtype=0 and ?backchannel=1
- Source: https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/dvrip/README.md

### XMEye/ICSee DVRIP: PTZ

```
tcp DVRIP msg 1400 OPPTZControl
```
- Params: {"Name":"OPPTZControl","SessionID":"0x..","OPPTZControl":{"Command":"DirectionUp|DirectionDown|DirectionLeft|DirectionRight|DirectionLeftUp|DirectionLeftDown|DirectionRightUp|DirectionRightDown|ZoomTile|ZoomWide|FocusNear|FocusFar|IrisSmall|IrisLarge|SetPreset|GotoPreset|ClearPreset|StartTour|StopTour","Parameter":{"AUX":{"Number":0,"Status":"On"},"Channel":0,"MenuOpts":"Enter","Pattern":"Start","Preset":<n or -1>,"Step":5,"Tour":0}}}
- Auth: session
- Response: Ret 100
- Notes: python-dvr ptz(cmd, step, preset); ptz_step sends Preset 65535 to start then -1 to stop for continuous moves. Some XM Wi-Fi firmware returns Ret 102/103 (no PTZ)
- Source: https://raw.githubusercontent.com/OpenIPC/python-dvr/master/dvrip.py

### XMEye/ICSee DVRIP: read/write config incl. Wi-Fi change

```
tcp DVRIP msg 1042 ConfigGet {"Name":"<Section>","SessionID":"0x.."}  |  msg 1040 ConfigSet {"Name":"<Section>","SessionID":"0x..","<Section>":{...}}
```
- Params: Sections: NetWork.NetCommon (HostIP hex LE, GateWay, TCPPort, HttpPort, MAC), NetWork.NetDHCP, NetWork.Nat {NatEnable}, NetWork.PMS {Enable}, NetWork.Wifi {"Enable":true,"SSID":"<ssid>","Keys":"<password>","Auth":"WPA2PSK","EncrypType":"AES","KeyType":0,"NetType":"Infra","Channel":0,"WifiMode":true}, Simplify.Encode, Detect.*, Record
- Auth: session
- Response: GET -> {"Name":..,"<Section>":{..},"Ret":100}; SET -> Ret 100 then camera re-associates and gets a new DHCP IP
- Notes: THE documented third-party Wi-Fi change for this family. Camera does not return a scan list; after factory reset join SoftAP xmTEXT / camera_XXXX (pw 1234567890), camera at 192.168.1.10, and send the same SET. python-dvr: cam.set_info("NetWork.Wifi", {...})
- Source: https://raw.githubusercontent.com/kwebmn/dvrip-cam/main/docs/SPEC.md

### XMEye/ICSee DVRIP: reboot / system info / discovery

```
tcp DVRIP / UDP msg 1450 OPMachine {"Action":"Reboot"}  |  msg 1020 SystemInfo  |  discovery: listen UDP 0.0.0.0:34569 for broadcast {"NetWork.NetCommon":{...}}
```
- Params: as shown
- Auth: session (reboot/info); none (discovery)
- Response: Ret 100; SystemInfo {SerialNo, SoftWareVersion, HardWare, DeviceType...}
- Notes: python-dvr reboot(), get_system_info()
- Source: https://raw.githubusercontent.com/OpenIPC/python-dvr/master/dvrip.py

### ICSee/XMEye local RTSP (models that expose it)

```
rtsp RTSP rtsp://{ip}:554/user=admin_password=_channel=0_stream=0.sdp?real_stream  (variants: user=admin&password=&channel=1&stream=0.sdp?real_stream, /onvif1, /onvif2, /live/ch00_0); ONVIF on 8899
```
- Params: stream=0 main, 1 sub
- Auth: admin, often empty password
- Response: H.264/H.265
- Notes: Many Wi-Fi ICSee units have RTSP disabled -> use go2rtc dvrip:// instead
- Source: https://www.ispyconnect.com/camera/icsee

### XMEye Wi-Fi onboarding QR (no vendor app)

```
qr show to reset camera lens Plain-text QR: S:<ssid>\nP:<password>\nE:1\nM:<router MAC no colons>\nI:<last octet of router IP>\nB:<random id>\n
```
- Params: E=1 for WPA2/PSK
- Auth: none
- Response: camera joins SSID and appears on LAN (UDP 34569 broadcast)
- Notes: Recovered from ICSee APK; lets the hub PWA display a re-pairing QR after a Wi-Fi change
- Source: https://gist.githubusercontent.com/jonamat/2be0092f4fbb2f1d343c748e318c6508/raw/704e5287bdfa97bb7b45de8b33c6cfd8854a50a9/xiongmai-qrcode-specs.md

### CamHi/HiP2P (Hi3510) RTSP + snapshot

```
rtsp RTSP / HTTP GET rtsp://{user}:{pass}@{ip}:554/11 (main), /12 (sub); snapshot GET http://{ip}/tmpfs/auto.jpg or /snap.jpg?JpegCam=1
```
- Params: some models use RTSP port 5544
- Auth: HTTP Basic (realm hi3510), default admin/admin
- Response: H.264 stream / JPEG
- Notes: ONVIF also supported (port typically 8080 or 80) - probe
- Source: https://www.ispyconnect.com/camera/camhi

### CamHi/HiP2P (Hi3510) PTZ and presets

```
http GET GET http://{ip}/cgi-bin/hi3510/ptzctrl.cgi?-step={0|1}&-act={left|right|up|down|home|stop|leftup|leftdown|rightup|rightdown|hscan|vscan|zoomin|zoomout|focusin|focusout|irisin|irisout}&-speed={1..63}  |  GET http://{ip}/cgi-bin/hi3510/preset.cgi?-act={presetgo|presetsave}&-number={n}
```
- Params: -step=0 continuous (send -act=stop), -step=1 single step
- Auth: HTTP Basic admin
- Response: 'var ...' text or HTTP 200
- Notes: Paths confirmed from ha-hi3510 const.py (CGI_PTZ, CGI_PRESET); -speed range from INSTAR CGI docs
- Source: https://raw.githubusercontent.com/spagonic/ha-hi3510/main/custom_components/hi3510/const.py

### CamHi/HiP2P (Hi3510) Wi-Fi read / scan / test / set

```
http GET GET http://{ip}/cgi-bin/hi3510/param.cgi?cmd=getwirelessattr  |  ?cmd=searchwireless  |  ?cmd=chkwirelessattr&-wf_ssid=..&-wf_auth=..&-wf_key=..&-wf_enc=..  |  ?cmd=setwirelessattr&-wf_enable=1&-wf_ssid={ssid}&-wf_auth={0 none|1 WEP|2 WPA-PSK|3 WPA2-PSK}&-wf_key={password}&-wf_enc={0 TKIP|1 AES}&-wf_mode=0
```
- Params: as shown; also ?cmd=getserverinfo for model/firmware
- Auth: HTTP Basic admin
- Response: var wf_enable="1"; var wf_ssid="..."; ... / scan list with channel, RSSI, SSID, encryption
- Notes: Documented for INSTAR Hi3510 cameras; CamHi units generally identical - test chkwirelessattr first. Only consumer family here with an HTTP Wi-Fi API
- Source: https://wiki.instar.com/en/1080p_Series_CGI_List/Network_Menu/WiFi/

### YCC365 Plus RTSP + PTZ

```
rtsp RTSP / SOAP POST rtsp://{ip}:554/0/av0 (720p + audio), rtsp://{ip}:554/0/av1 (640x352 + audio), rtsp://{ip}:554 (video only); PTZ: POST http://{ip}/onvif/PTZ with SOAP tptz:ContinuousMove{ProfileToken Profile_1, Velocity PanTilt x,y} / tptz:Stop{PanTilt true, Zoom true}
```
- Params: x=+/-1 for left/right, y=+/-1 for up/down
- Auth: none observed on tested firmware (some units admin/123456 or admin/12345)
- Response: stream / SOAP response
- Notes: Not fully ONVIF-compliant; firmware updates have removed local access on some units
- Source: https://raw.githubusercontent.com/fjramirez1987/PTZ-YCC365/master/custom_components/ptz_camera/__init__.py

### Tuya Cloud: allocate live stream URL

```
cloud POST JSON (Tuya HMAC-SHA256 signed headers: client_id, sign, t, access_token, sign_method) POST https://openapi.tuya{us|eu|in}.com/v1.0/users/{uid}/devices/{device_id}/stream/actions/allocate
```
- Params: {"type":"rtsp"} or {"type":"hls"}
- Auth: Tuya IoT Core project access_id/secret + 'IoT Video Live Stream' service subscription; device linked via Tuya Smart app account
- Response: {"result":{"url":"rtsps://echo:{key}@tx-....tuyacn.com:443/v1/...?signInfo=..."} or .m3u8}
- Notes: Cloud relay only - not a LAN URL; works when the camera is on its SIM. India data centre host is openapi.tuyain.com
- Source: https://developer.tuya.com/en/docs/cloud/19b50885a2?id=Kag2d0i8bjfh3

### Tuya Cloud: PTZ and other camera commands

```
cloud POST JSON signed POST https://openapi.tuya{region}.com/v1.0/iot-03/devices/{device_id}/commands  (alt: POST /v1.0/cameras/{device_id}/configs/ptz)
```
- Params: {"commands":[{"code":"ptz_control","value":"0..7"}]} (0 up,1 upper-right,2 right,3 lower-right,4 down,5 lower-left,6 left,7 upper-left); {"code":"ptz_stop","value":true}; zoom_control "0|1", zoom_stop, basic_private true|false, basic_flip, motion_switch, cruise_switch.  configs/ptz body {"value":"UP|RIGHT_UP|RIGHT|RIGHT_DOWN|DOWN|LEFT_DOWN|LEFT|LEFT_UP|STOP"}
- Auth: Tuya cloud access_token
- Response: {"success":true,"result":true} / {"result":{"sn":..}}
- Notes: Also gives notifications via Tuya message service; no Wi-Fi DP exists - re-pairing required to change SSID
- Source: https://developer.tuya.com/en/docs/cloud/e2512fb901?id=Kag2yag3tiqn5

### Tuya via go2rtc (WebRTC, two-way audio)

```
cloud go2rtc stream source tuya://protect-{region}.ismartlife.me?device_id={id}&email={tuya-smart-email}&password={pw}&resolution=hd|sd  |  tuya://openapi.tuya{region}.com?device_id={id}&uid={uid}&client_id={id}&client_secret={secret}
```
- Params: resolution hd|sd
- Auth: Tuya Smart account (NOT Smart Life) or Tuya cloud project
- Response: WebRTC/MSE to browser, RTSP re-export on go2rtc :8554
- Notes: Use go2rtc web UI Add > Tuya to discover exact URL
- Source: https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/tuya/README.md

### Generic ONVIF Wi-Fi (Dot11) operations - probe only

```
soap POST SOAP POST http://{ip}:{onvif_port}/onvif/device_service  tds:GetDot11Capabilities, tds:GetDot11Status{InterfaceToken}, tds:ScanAvailableDot11Networks{InterfaceToken}, tds:SetNetworkInterfaces{InterfaceToken, NetworkInterface.Link/IPv4/Extension.Dot11{SSID, Mode, Security{Mode, Algorithm, PSK{Key}}}}
```
- Params: interface token from GetNetworkInterfaces
- Auth: ONVIF user
- Response: Dot11 capabilities / scan list / RebootNeeded
- Notes: Standard exists but no consumer family here documents support; implement as optional feature-detected path
- Source: https://www.onvif.org/onvif/ver20/util/operationIndex.html

## Facts

- **Tapo cameras expose RTSP on port 554 at rtsp://[IP]/stream1 (high quality) and rtsp://[IP]/stream2 (low quality) and ONVIF on port 2020; they support ONVIF Profile S which includes PTZ control but not two-way audio; a separate 'camera account' must be created in the Tapo app for third-party access.** [high] Battery models C410, C420, C425, D230 do not support RTSP; D235/D225/TD25 only when hardwired with always-on mode. Dual-lens C246D/C840 telephoto uses stream6/stream7. Only two of Tapo Care, SD recording and NVR/ONVIF can run at once. VPN recommended over port forwarding for remote access. (https://www.tapo.com/us/faq/724/)
- **Tapo local viewing is limited to three simultaneous viewers, and each ONVIF or RTSP connection counts toward that limit.** [high] 'For local viewing, no more than three devices can view the live stream at the same time. Each ONVIF or RTSP connection also counts toward the local viewing limit.' (https://www.tapo.com/us/faq/754/)
- **A Tapo camera's Wi-Fi network cannot be changed from any app or API: 'At this time, the only way to change wireless networks is to reset and reconfigure the camera.'** [high] So 're-point camera from one Wi-Fi to another' is not feasible for Tapo from the hub; the hub can only detect the drop and instruct the user to reset + re-onboard in the Tapo app. (https://www.tapo.com/us/faq/754/)
- **Only Tapo 4G LTE models (Tapo C501GW, TC40GW, C615G KIT, C665G KIT) support using a SIM card as a network source.** [high] Regular Tapo C200/C210/C500 etc. are Wi-Fi only; they cannot have their own SIM. (https://www.tapo.com/us/faq/754/)
- **Tapo C501GW spec: Network '3G/4G LTE/LAN Cable', LTE-FDD B1/3/5/7/8/20/28 + LTE-TDD B38/40/41, '1x Nano-SIM Card Slot', PoE 802.3af/at, RTSP 'Yes', ONVIF 'YES (Only Available in Ethernet Mode)'.** [high] In 4G mode the camera keeps RTSP but not ONVIF; in practice neither is reachable inbound over a carrier SIM (CGNAT), so 4G mode is effectively Tapo-app/cloud only. (https://www.tp-link.com/my/home-networking/cloud-camera/tapo-c501gw/)
- **pytapo talks to Tapo cameras over HTTPS port 443 (controlPort) and streams over port 8800 (streamPort); all control requests after login go to https://{host}/stok={stok}/ds and are wrapped as {"method":"multipleRequest","params":{"requests":[...]}}.** [high] Three transports are auto-detected: 'klap', 'tpap' (newest firmware, SPAKE2+ login + AES-128-CCM channel, discovered via GET https://host/ returning {"tpap":{"pake":[2]}}) and legacy 'pytapo' (JSON login on POST https://host/ returning stok). Login uses the camera-account username/password; error -40401 means stok expired. (https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/__init__.py)
- **pytapo legacy secure login: POST https://host/ {"method":"login","params":{"cnonce":<8 hex upper>,"encrypt_type":"3","username":"admin"}} returns error_code -40413 with result.data.nonce and device_confirm; client verifies device_confirm == SHA256(cnonce + hashedPassword + nonce).upper() + nonce + cnonce (hashedPassword = MD5 or SHA256 upper of camera-account password), then logs in with digest_passwd = SHA256(hashedPassword + cnonce + nonce).upper() + cnonce + nonce; response carries result.stok and start_seq, and user_group must be 'root'.** [high] Insecure (old firmware) form: {"method":"login","params":{"hashed":true,"password":<MD5 upper>,"username":"admin"}}. After secure login, request bodies are AES-encrypted with keys derived from lsk/ivb tokens and a sequence number; the hub should embed pytapo (or port it) rather than re-implement. (https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/transport/pytapo/pytapo.py)
- **pytapo PTZ/preset/system JSON methods: motorMove {"motor":{"move":{"x_coord":"<x>","y_coord":"<y>"}}}; relativeMove {"motor":{"movestep":{"direction":"<0|90|180|270>"}}}; manualCalibrate {"motor":{"manual_cali":""}}; getPresetConfig {"preset":{"name":["preset"]}}; addMotorPostion (sic) {"preset":{"set_preset":{"name":"<n>","save_ptz":"1"}}}; motorMoveToPreset {"preset":{"goto_preset":{"id":"<id>"}}}; deletePreset {"preset":{"remove_preset":{"id":["<id>"]}}}; setLensMaskConfig {"lens_mask":{"lens_mask_info":{"enabled":"on|off"}}}; rebootDevice {"system":{"reboot":"null"}} (KLAP devices: device_reboot {"delay":n}); getDeviceInfo {"device_info":{"name":["basic_info"]}}; getConnectionType {"network":{"get_connection_type":[]}}; getDeviceIpAddress {"network":{"name":["wan"]}}.** [high] cruiseMove/cruiseStop control patrol; getMotorCapability is {"method":"get","motor":{"name":["capability"]}}. No setWifi/scanWifi/setNetwork method exists in pytapo (grep of the 115 kB module finds only getWifiBackup, which is a hub-only 'hub_manage' call). (https://raw.githubusercontent.com/JurajNyiri/pytapo/main/pytapo/__init__.py)
- **Tapo proprietary video on TCP 8800: go2rtc dials host:8800, sends 'POST /stream HTTP/1.1' with Content-Type 'multipart/mixed; boundary=--client-stream-boundary--', authenticates with HTTP Digest (RFC 7616) using username 'admin' and password = UPPERCASE MD5 of the Tapo cloud password (or UPPERCASE SHA256 when the challenge contains encrypt_type="3"); media arrives as multipart video/mp2t parts, AES-decrypted with key MD5(nonce+':'+password) and IV MD5(username+':'+nonce).** [high] go2rtc URL forms: tapo://{cloud-password}@ip (auto hash), tapo://admin:{UPPERCASE-MD5}@ip, tapo://admin:{UPPERCASE-SHA256}@ip, ?subtype=0 HD / ?subtype=1 VGA; two-way audio supported. Note it is the Tapo CLOUD account password, not the camera-account password. Some devices answer username="none" (CVE-2022-37255) with fixed password TPL075526460603. (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/pkg/tapo/client.go)
- **go2rtc documents the Tapo source as: 'use the cloud password, this is not the RTSP password! you do not need to add a login!', stream quality equals RTSP, and provides tapo://cloud-password@192.168.1.123?subtype=1 for the substream.** [high] This is the only way to get video from Tapo devices that lack RTSP (battery/solar/hub cameras). (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/tapo/README.md)
- **The Home Assistant Tapo Control integration lists the ports it uses: TCP/443 control, TCP/8800 proprietary video + recording download, TCP/554 RTSP, TCP/2020 ONVIF (used for motion events), and exposes Network SSID / signal / RSSI sensors but no Wi-Fi change action.** [high] 'Direct' (8800) streams cannot be used with go2rtc/webrtc card; RTSP recommended where available. ONVIF motion events unavailable on battery/solar cameras. (https://raw.githubusercontent.com/JurajNyiri/HomeAssistant-Tapo-Control/main/README.md)
- **go2rtc's ONVIF client works against Tapo on port 2020 (example onvif://admin:password@192.168.1.123:2020; tested with TP-Link Tapo TC60) and go2rtc itself can act as an ONVIF server for other clients.** [high] go2rtc's built-in web UI does ONVIF autodiscovery when the server is on the same subnet (Docker needs network host). (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/onvif/README.md)
- **EZVIZ local RTSP URL is rtsp://admin:<verification code>@<device ip>:554/ch1/main, where the verification code is 'the 6 capital letters code you can find on the device label'; camera and client must be on the same network.** [high] Sub-stream /ch1/sub and Hikvision-style /Streaming/Channels/101 are reported by third-party lists for some models. (https://support.ezviz.com/faq/article/How-to-set-up-C6N-TY1-TY2-as-a-webcam)
- **EZVIZ 'LAN Live View' uses username 'admin by default' and the device verification code as password; after a reset the camera raises a Wi-Fi hotspot named 'EZVIZ_<SN>' with password 'EZVIZ_<verification code>' that a phone can join to view/configure it with no router.** [high] This SoftAP is the vendor's own 'manual access when there is no network' path; the app is required to complete onboarding, but the same LAN Live View credentials are the RTSP credentials. (https://m-support.ezviz.com/faq/article/How-to-use-LAN-Live-View)
- **RTSP is disabled by default on current EZVIZ firmware and must be enabled per camera in the app: Settings > LAN Live View > Start Scanning > select camera > gear icon > Local Server Settings > enable RTSP.** [medium] Home Assistant docs and community threads document the same path; EZVIZ's own support pages only give the URL format. (https://community.home-assistant.io/t/ezviz-rtsp-enable/736416)
- **EZVIZ RTSP can be enabled programmatically without the app: ezviz-enable-rtsp logs in with Hikvision HCNetSDK NET_DVR_Login_V40 on TCP port 8000 (username admin, password = verification code) and calls NET_DVR_STDXMLConfig with 'PUT /ISAPI/EZVIZ/IPC/System/servicesSwitch?format=json' and JSON body {"servicesSwitch":{"hiksdk":..,"web":..,"upnp":..,"rtsp":..}}; it can loop, re-enabling RTSP whenever port 554 closes.** [high] Requires the native HCNetSDK library (Linux/Windows) and works only on the LAN. Which EZVIZ models accept this ISAPI path is not documented by EZVIZ. (https://raw.githubusercontent.com/ylemoigne/ezviz-enable-rtsp/main/src/main/java/fr/javatic/ezvizEnableRtsp/hikvisionSdk/Hikvision.java)
- **EZVIZ officially supports ONVIF only on listed devices: recorders X5S/X5C and X4 kits (latest firmware) and specific camera SKUs (e.g. CS-H8c-R100-1K2WKFL V5.3.8 build 230829, CS-C8W, CS-H3c, CS-C3TN, CS-H4, CS-H6c, CS-CP1, CS-TY1, CS-E6 variants) at or above the listed firmware; models not listed are not supported.** [high] No ONVIF port or enable-switch is documented on that page; ONVIF PTZ on EZVIZ is therefore model-dependent. Cloud PTZ (below) is the portable route. (https://m-support.ezviz.com/faq/article/Whether-EZVIZ-devices-support-ONVIF-protocol)
- **pyEzvizApi (unofficial, reverse-engineered consumer-app API used by Home Assistant) logs in with POST https://apiieu.ezvizlife.com/v3/users/login/v5 (form fields account, password, featureCode, cuName, msgType, bizType, smsCode) and then follows loginArea.apiDomain (region host 'apii<region>.ezvizlife.com'); device list is GET /v3/userdevices/v1/resources/pagelist; PTZ is PUT /v3/devices/{serial}/ptzControl with data {command, action, channelNo:1, speed, uuid, serial}; Wi-Fi list seen by the device is GET /v3/devconfig/{serial}/{channel}/netWork, POST the same path triggers a network search, POST /v3/devconfig/{serial}/{channel}/netWork/command?targetDeviceSerial=... sends a network-config command; reboot is POST /api/device/v2/sysOper/{serial} with {oper:1, deviceSerial, delay}; snapshot is /v3/devconfig/v1/{serial}/{channel}/capture.** [high] MFA/SMS may be required on first login; accounts can be moved between regional hosts on re-login. All of these run through EZVIZ cloud, so they work when the camera is on its SIM. The netWork endpoints are the closest thing to 'change Wi-Fi from a third-party app' but are only exercised by the library for paired/child devices; treat as experimental. (https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/client.py)
- **The exact PTZ string values used against /v3/devices/{serial}/ptzControl are command 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' with action 'START' | 'STOP' (speed integer, default 5).** [high] Home Assistant core's ezviz button platform calls pyezviz_client.ptz_control("UP", serial, run) with run = "START" on press and "STOP" on release. (https://raw.githubusercontent.com/home-assistant/core/dev/homeassistant/components/ezviz/button.py)
- **pyEzvizApi endpoint constants live in api_endpoints.py: API_ENDPOINT_LOGIN=/v3/users/login/v5, API_ENDPOINT_PAGELIST=/v3/userdevices/v1/resources/pagelist, API_ENDPOINT_DEVICES=/v3/devices/, API_ENDPOINT_PTZCONTROL=/ptzControl, API_ENDPOINT_DEVCONFIG_BASE=/v3/devconfig, API_ENDPOINT_DEVICE_SYS_OPERATION=/api/device/v2/sysOper/, API_ENDPOINT_SWITCH_STATUS=/switchStatus, API_ENDPOINT_ALARM_SOUND=/alarm/sound, API_ENDPOINT_REGISTER_MQTT=/v1/getClientId, API_ENDPOINT_START_MQTT=/api/push/start (push notifications via MQTT).** [high] Library licence Apache-2.0. The pagelist 'filter' includes WIFI, which returns the camera's current SSID/signal (pyezviz _get_wifi). (https://raw.githubusercontent.com/RenierM26/pyEzvizApi/main/pyezvizapi/api_endpoints.py)
- **The official EZVIZ Open Platform HTTP API (base https://open.ys7.com, regional {areaDomain}) exposes POST /api/lapp/token/get (appKey, appSecret), /api/lapp/device/add (deviceSerial, validateCode), /api/lapp/device/list (pageStart, pageSize), /api/lapp/device/capture (deviceSerial, channelNo), /api/lapp/live/address/get, /api/lapp/live/address/limited (deviceSerial, channelNo, expireTime), /api/lapp/device/ptz/start (deviceSerial, channelNo, direction, speed) and /api/lapp/device/ptz/stop (deviceSerial, channelNo, direction).** [medium] Confirmed from a Go SDK mirror of the API because open.ys7.com's English doc pages now show a 'documentation being discontinued' notice and the new help centre (open.ys7.com/help/en) is JavaScript-rendered. Direction codes 0-11 (Up, Down, Left, Right, diagonal, Zoom, Focus) and speed 0/1/2 (slow/medium/fast) come from the search excerpt of the deprecated PTZ page; live-address 'protocol' 1=ezopen, 2=hls, 3=rtmp, 4=flv with expireTime 30s-720d. (https://pkg.go.dev/github.com/ChenWoChong/ys7)
- **EZVIZ's international developer portal lists India among its service regions (Asia-Pacific: Thailand, India, Vietnam), offers HTTP API + SDKs + 'Light App' web players, links docs at https://open.ys7.com/help/en and gives contact open-team@ezvizlife.com; it does not state whether individuals (vs enterprises) can register or any free quota.** [low] Treat 'usable by an individual' as unverified: sign-up exists but eligibility/pricing were not published on the portal pages fetched. (https://iusopen.ezviz.com/)
- **EZVIZ sells 4G/SIM cameras (EB8 4G pan-tilt battery camera with Micro SIM; EB8 Pro 4G and HB8 Lite 4G with Nano SIM that fall back to 4G when Wi-Fi drops; H8c 4G with Nano SIM plus RJ45).** [high] All are managed through the EZVIZ cloud, so the cloud APIs above are the SIM-path control channel. (https://www.ezviz.com/product/EB8-4G/46565)
- **V380 Pro cameras ship with RTSP/ONVIF disabled; a community procedure enables them by placing a file named ceshi.ini in the root of a FAT32 microSD with contents [CONST_PARAM] rtsp = 1 (extended: rtsp_enable = 1 / rtsp_ctrl = 1), booting, waiting 5+ minutes, then removing the file. Resulting URLs: rtsp://user:pass@IP:554/live/ch00_0 (main) and /live/ch00_1 (sub); ONVIF on port 8899.** [medium] Comments report it works on dual-lens models, fails on newer 3-lens models that only expose the AES-128-ECB-encrypted port 8800 protocol, may need re-pairing, ports may close again after reboot, and RTSP is sometimes unauthenticated. (https://gist.github.com/SolveSoul/9be5d9599c8b4b59f7cfa4cd0ce79c9c)
- **V380Decoder (.NET) speaks the V380 protocol on port 8800 either on the LAN (--ip) or through V380's cloud relay (--source cloud, relay auto-detected), decrypts the video/audio, and republishes as RTSP (rtsp://host:8554/live, /live-low), an ONVIF server, MJPEG, a snapshot at http://host:8080/snapshot and a REST/Web UI for camera control; it requires the camera device ID, username (admin) and password, and was tested on two cameras with firmware AppEV2W_VA3_V2.5.9.5_20231211 / Hw_AWT3710D_XHR and AppEV2W_VA3_V1.3.7.0_20231211 / Hw_AWT3610E_XHR (device version 31, H264).** [high] Because --source cloud exists, a V380 camera on its own SIM can still be viewed by the hub - but only via V380's relay servers (vendor cloud), and only for the tested firmware generation. Repository publishes no licence file. (https://raw.githubusercontent.com/theMavl/V380Decoder/main/README.md)
- **Security research on V380 Pro found: cameras register to a master server over UDP with their cloud device ID; on a remote view the master tells the camera to connect to a relay server, which forwards the client's username/password in cleartext; the tested camera served RTSP on port 554 on the LAN with no credentials; and during configuration the camera sent the Wi-Fi SSID and password in cleartext to the relay.** [medium] Implication for the hub: do not expose V380 units to the internet; treat the LAN as the trust boundary and prefer the SD-card RTSP route or V380Decoder bridge. (https://raw.githubusercontent.com/dunderhay/CCTV-v380-pro/master/README.md)
- **DVRIP/Sofia (Xiongmai/XMEye/ICSee) as implemented by python-dvr: TCP 34567 (UDP 34568); login is message 1000 with JSON {"EncryptType":"MD5","LoginType":"DVRIP-Web","PassWord":<sofia_hash>,"UserName":"admin"} where sofia_hash = MD5(password) bytes taken in pairs, (a+b) mod 62 mapped to [0-9A-Za-z], 8 chars; response has SessionID and AliveInterval; KeepAlive 1006; ConfigGet 1042 {"Name":"<Section>","SessionID":"0x.."} and ConfigSet 1040 {"Name":"<Section>","SessionID":..,"<Section>":{...}}; OPMonitor Claim 1413 / Start 1410 with Parameter {"Channel":0,"CombinMode":"NONE","StreamType":"Main"|"Extra1","TransMode":"TCP"}; OPPTZControl 1400 with Command one of DirectionUp/Down/Left/Right/LeftUp/LeftDown/RightUp/RightDown/ZoomTile/ZoomWide/FocusNear/FocusFar/IrisSmall/IrisLarge/SetPreset/GotoPreset/ClearPreset/StartTour/StopTour and Parameter {"AUX":{"Number":0,"Status":"On"},"Channel":0,"MenuOpts":"Enter","Pattern":"Start","Preset":<n|-1>,"Step":5,"Tour":0}; OPMachine 1450 {"Action":"Reboot"}; SystemInfo 1020; OPTalk 1434 (Claim) / 1430 (Start) / 1432 (audio data) with G711_ALAW; OPSNAP 1560.** [high] python-dvr (OpenIPC fork, MIT) exposes these as get_info/set_info("NetWork.NetCommon"), get_info("NetWork.NetDHCP"), set_info("NetWork.Nat",{"NatEnable":false}) (detach from cloud), ptz(), reboot(), start_monitor(), snapshot(). Ret codes 100/150/515 are success. (https://raw.githubusercontent.com/OpenIPC/python-dvr/master/dvrip.py)
- **XMEye Wi-Fi can be changed over the network with DVRIP ConfigSet (1040) of section NetWork.Wifi using {"Enable":true,"SSID":"<ssid>","Keys":"<password>","Auth":"WPA2PSK","EncrypType":"AES","KeyType":0,"NetType":"Infra","Channel":0,"WifiMode":true} (Auth: OPEN|WEPAUTO|WPAPSK|WPA2PSK|WPANONE; EncrypType: NONE|WEP|TKIP|AES|TKIPAES); after the write the camera re-associates and takes a new DHCP address. The camera does NOT return a Wi-Fi scan list (the app asks the user). After factory reset the camera raises SoftAP 'xmTEXT' (WPA2 password 1234567890, sometimes open) or 'camera_XXXX', with the camera at 192.168.1.10/.12 and gateway 192.168.1.1, so a phone/hub can join it and send the same SET NetWork.Wifi. Cameras also broadcast NetWork.NetCommon over UDP to port 34569 for discovery.** [medium] The tested (Xiongmai battery/Wi-Fi) firmware returned Ret 102/103 (unsupported) for RTSP, ONVIF, Telnet, UPnP, HTTPS, PTZ, OPSNAP and Wi-Fi scan, so go2rtc's dvrip bridge is needed for RTSP on such units. Reverse-engineered from one camera family; verify per model. (https://raw.githubusercontent.com/kwebmn/dvrip-cam/main/docs/SPEC.md)
- **The ICSee/XMEye Wi-Fi onboarding QR code is plain text with lines S:<ssid>, P:<password>, E:<encryption, 1=WPA2/PSK>, M:<router MAC without colons>, I:<last octet of router IP>, B:<random id>, as recovered from decompiling the ICSee app (com.xm.csee); the same source notes the local RTSP URL rtsp://192.168.x.x:554/user=admin&password=&channel=1&stream=1.sdp?.** [medium] The hub can generate this QR on the phone screen to re-onboard a reset XMEye camera to a new SSID without the vendor app. (https://gist.githubusercontent.com/jonamat/2be0092f4fbb2f1d343c748e318c6508/raw/704e5287bdfa97bb7b45de8b33c6cfd8854a50a9/xiongmai-qrcode-specs.md)
- **go2rtc DVR-IP source: dvrip://username:password@192.168.1.123:34567?channel=0&subtype=0 (subtype 0 = Main, 1 = Extra1), dvrip://...?backchannel=1 for two-way audio, TCP only; defaults to admin/admin when credentials omitted.** [high] go2rtc then serves the stream to browsers via WebRTC/MSE/HLS and also as RTSP on its own port 8554. (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/dvrip/README.md)
- **ICSee (Xiongmai) cameras that do expose RTSP use rtsp://[ip]:554/user=[USER]_password=[PASS]_channel=0_stream=0.sdp?real_stream (also '&'-separated and /onvif1, /onvif2, /live/ch00_0 variants across 121 listed models), support ONVIF discovery, and use ports 554, 34567 and 8899.** [medium] Third-party compatibility database, not vendor documentation; default credentials admin with empty password are common. (https://www.ispyconnect.com/camera/icsee)
- **Indian marketplaces sell 4G SIM cameras that are V380 Pro devices (e.g. Flipkart 'SrO 4G SIM (All Supported) 3MP ... V380 Wireless PTZ Security Camera'), and the OEM icseecam.com states its cameras work with the iCSee, Ubox, V380 and Tuya apps.** [medium] So the 'generic 4G SIM camera' on Amazon.in/Flipkart resolves to one of the four protocol families above (plus CamHi/YCC365 for older stock). (https://www.flipkart.com/sro-4g-sim-all-supported-3mp-full-hd-ip66-outdoor-v380-wireless-ptz-security-camera/p/itmf8258b11589fc)
- **Hi3510-family cameras (the ha-hi3510 project identifies them as those using the 'CamHi, HiP2P, Ctronics, or HiSilicon' apps) use HTTP CGI at /cgi-bin/hi3510/param.cgi?cmd=<name> with HTTP Basic auth (realm 'hi3510'), PTZ at /cgi-bin/hi3510/ptzctrl.cgi?-step=<n>&-act=<direction>, presets at /cgi-bin/hi3510/preset.cgi?-act=presetgo|presetsave&-number=<n>, snapshot at /tmpfs/auto.jpg, RTSP at rtsp://host:554/11, and Wi-Fi read via cmd=getwirelessattr.** [medium] Directions listed: left, right, up, down, home, stop, leftup, leftdown, rightup, rightdown, hscan, vscan, zoomin, zoomout, focusin, focusout, irisin, irisout. Project licence MIT. (https://raw.githubusercontent.com/spagonic/ha-hi3510/main/custom_components/hi3510/const.py)
- **The Hi3510 CGI Wi-Fi commands are param.cgi?cmd=getwirelessattr (returns wf_enable, wf_ssid, wf_auth, wf_key, wf_enc, wf_mode), param.cgi?cmd=setwirelessattr&-wf_enable=1&-wf_ssid=<ssid>&-wf_auth=<0 none|1 WEP|2 WPA-PSK|3 WPA2-PSK>&-wf_key=<pw>&-wf_enc=<0 TKIP|1 AES>&-wf_mode=0, param.cgi?cmd=searchwireless (scan: channel, RSSI, SSID, encryption) and param.cgi?cmd=chkwirelessattr (test credentials before applying).** [medium] Documented on INSTAR's CGI wiki (INSTAR 1080p cameras use the same Hi3510 CGI); CamHi units generally accept the same commands but each model must be verified. This is the only consumer family in this report with a documented HTTP Wi-Fi set/scan API. (https://wiki.instar.com/en/1080p_Series_CGI_List/Network_Menu/WiFi/)
- **CamHi cameras stream RTSP at rtsp://[ip]:554/11 (main) and /12 (sub) (some models /1, /2 or port 5544), support ONVIF discovery, and serve JPEG snapshots at /snap.jpg?JpegCam=[CHANNEL] or /tmpfs/auto.jpg.** [medium] Third-party database of 22 CamHi models. (https://www.ispyconnect.com/camera/camhi)
- **YCC365 Plus cameras expose RTSP at rtsp://IP:554 (720p, no audio), rtsp://IP:554/0/av0 (720p + mono audio) and rtsp://IP:554/0/av1 (640x352 + audio); PTZ works by POSTing ONVIF-style SOAP (tptz:ContinuousMove / tptz:Stop with ProfileToken 'Profile_1') to http://IP/onvif/PTZ, although the cameras 'do not fully comply with the ONVIF protocol'.** [medium] Reverse-engineered with Wireshark on a YCC365 Plus 1080P 360 camera and an exterior model; no credentials were needed in the tested firmware. (https://raw.githubusercontent.com/fjramirez1987/PTZ-YCC365/master/custom_components/ptz_camera/__init__.py)
- **Tuya cloud live video: POST /v1.0/users/{uid}/devices/{device_id}/stream/actions/allocate with body {"type":"rtsp"} or {"type":"hls"} returns result.url; the API sits under the 'IoT Video Live Stream' cloud service which must be subscribed in the Tuya developer project.** [high] The returned RTSP is a cloud relay, e.g. rtsps://echo:{key}@tx-wework9.tuyacn.com:443/v1/...?signInfo=..., not a LAN URL ('The Tuya Cloud provides real-time video access of RTSP protocol'). Expiry not documented. (https://developer.tuya.com/en/docs/cloud/19b50885a2?id=Kag2d0i8bjfh3)
- **Tuya camera PTZ via cloud: POST /v1.0/iot-03/devices/{device_id}/commands with {"commands":[{"code":"ptz_control","value":"<0..7>"}]} (0 up, 1 upper-right, 2 right, 3 lower-right, 4 down, 5 lower-left, 6 left, 7 upper-left) and {"code":"ptz_stop","value":true}; alternatively POST /v1.0/cameras/{device_id}/configs/ptz with {"value":"UP"|"RIGHT_UP"|"RIGHT"|"RIGHT_DOWN"|"DOWN"|"LEFT_DOWN"|"LEFT"|"LEFT_UP"|"STOP"}.** [high] Other standard camera DPs: zoom_control (0/1), zoom_stop, ptz_calibration, cruise_switch, basic_private (privacy), basic_flip, motion_switch. No Wi-Fi DP exists in the standard instruction set. (https://developer.tuya.com/en/docs/iot/f?id=K9gf47qbzhnj3)
- **go2rtc's tuya source streams Tuya cameras over WebRTC with two-way audio using either a Tuya Smart account (tuya://protect-us.ismartlife.me?device_id=..&email=..&password=..; Smart Life accounts are NOT supported) or a Tuya Cloud project (tuya://openapi.tuyaus.com?device_id=..&uid=..&client_id=..&client_secret=.., requires the 'IoT Video Live Stream' free-trial service), with resolution=hd|sd.** [high] Cameras paired in the Smart Life app must be removed and re-added in the Tuya Smart app. (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/internal/tuya/README.md)
- **Only some Tuya/Smart Life cameras offer local RTSP/ONVIF (port 554, default admin / 123456 or blank); 'Not all Smart Life and Tuya cameras support ONVIF and RTSP functionality'.** [low] Third-party guide; there is no vendor list of which SKUs have local RTSP. (https://www.camapp365.com/tuya-smart/get-rtsp-or-onvif-smart-life-and-tuya-camera)
- **ONVIF's Device Management service defines wireless operations ScanAvailableDot11Networks, GetDot11Capabilities, GetDot11Status and SetNetworkInterfaces (Dot11 configuration), alongside PTZ ContinuousMove/GotoPreset/SetPreset and Media GetStreamUri.** [high] So a standards-based 'change Wi-Fi' exists, but none of the consumer families here document implementing the Dot11 operations; the hub should probe GetDot11Capabilities per camera and expect 'ActionNotSupported' on Tapo/EZVIZ/XM. (https://www.onvif.org/onvif/ver20/util/operationIndex.html)
- **LTE/4G carriers normally place SIM devices behind Carrier-Grade NAT without a public IP, so port forwarding to a SIM camera does not work; the standard workaround is an outbound mesh VPN (Tailscale/ZeroTier) on a router or host next to the camera, or the vendor's own cloud relay.** [medium] A camera that carries its own SIM has no host beside it to run a VPN client, so for these cameras the SIM path is vendor-cloud only. (https://therelay.net/blog/ip-cameras-behind-cgnat)

## Limits and caveats

- SIM path reality: a camera with its own postpaid SIM sits behind carrier CGNAT (no public IP), so the hub can never open RTSP/ONVIF/HTTP INTO it; the only 'reach it over the SIM' options are vendor cloud APIs (EZVIZ consumer or Open Platform, Tuya Cloud, V380 cloud relay via V380Decoder). Tapo, XMEye/ICSee and CamHi have no usable public cloud API, so on their SIM they are vendor-app only. Design the app so 'SIM mode' tiles show cloud-backed controls (EZVIZ/Tuya/V380) and 'open vendor app' deep-links for the rest.
- Wi-Fi change from a third-party app is feasible only for XMEye/ICSee (DVRIP SET NetWork.Wifi) and CamHi/Hi3510 (setwirelessattr) - and only while the camera is still reachable on the LAN or via its post-reset SoftAP. Tapo officially requires reset + re-onboarding; EZVIZ's cloud netWork endpoints are undocumented/experimental; Tuya requires re-pairing; V380's config path sends Wi-Fi creds in cleartext through its relay and is not exposed as an API.
- Every Tapo/EZVIZ/XM/Tuya local API here except RTSP/ONVIF is reverse-engineered; firmware updates change it (Tapo has already moved legacy -> KLAP -> TPAP/SPAKE2+; EZVIZ disabled RTSP by default in 2023; XM firmware drops RTSP/ONVIF/PTZ on cheap Wi-Fi SKUs). Pin library versions, wrap each adapter behind a capability probe, and surface 'pending confirmation' in the UI rather than promising features per family.
- Tapo uses two different secrets: the Camera Account (RTSP/ONVIF/local JSON API) and the Tapo cloud password (port 8800 stream via go2rtc). Store both. Tapo local viewing is capped at 3 connections including each RTSP/ONVIF session - go2rtc should be the single consumer and fan out to phones.
- Tapo ONVIF on 4G models is 'Only Available in Ethernet Mode'; RTSP is listed as supported but unreachable inbound over the SIM. If the owner wants hub control of Tapo 4G units, wire them by PoE/Ethernet and keep the SIM as the camera's own fallback.
- EZVIZ ONVIF exists only on the published SKU/firmware list; EZVIZ RTSP must be enabled per camera and can be silently disabled again by firmware - run ezviz-enable-rtsp on an interval (needs the proprietary Hikvision HCNetSDK binary, not redistributable under an open licence).
- EZVIZ Open Platform: endpoints were confirmed from an SDK mirror because open.ys7.com's English docs are being retired and the new help centre is JavaScript-only; whether an individual (non-enterprise) account in India gets API access and what it costs is unverified - contact open-team@ezvizlife.com before depending on it. The consumer cloud API (pyEzvizApi) works with the owner's existing EZVIZ login but is unofficial and subject to MFA and rate limits.
- A camera bound to the EZVIZ Open Platform developer account cannot simultaneously be in the consumer EZVIZ app account; pick one path per camera.
- V380 Pro: the SD-card ceshi.ini trick is community lore with mixed results and can revert; V380Decoder is tested on only two firmware versions and publishes no licence; V380 cloud traffic carries credentials in cleartext. Treat V380 units as LAN-only, low-trust devices.
- XMEye/ICSee: the tested Wi-Fi firmware returned 'unsupported' for RTSP, ONVIF, PTZ, snapshot and Wi-Fi scan; only OPMonitor video, OPTalk audio and config sections worked - so plan on go2rtc dvrip:// for video and expect PTZ to be model-dependent. SET NetWork.Wifi moves the camera off the current network immediately; issue it last and re-discover via UDP 34569.
- Hi3510 (CamHi) commands are documented by INSTAR for their own cameras; CamHi OEM units usually match but must be verified per model; 4G CamHi variants may not expose the Wi-Fi CGI at all.
- YCC365 Plus and other 'no-name' apps frequently lose local RTSP after app-forced firmware updates; disable auto-update in the vendor app if the hub depends on local streams.
- Tuya video is cloud-relayed even for the 'RTSP' type (rtsps://...tuyacn.com) and needs a Tuya developer project with the IoT Video Live Stream service (free trial, then paid); cameras paired in Smart Life must be re-paired into Tuya Smart for go2rtc. Local RTSP/ONVIF exists on only some Tuya SKUs and is undocumented by Tuya.
- ONVIF Dot11 (Wi-Fi) operations are standard but unlikely to be implemented on these consumer cameras; implement as a feature-detected optional path, not a promise.
- Do not expose any of these cameras or the hub directly to the internet; use the hub as the only LAN client and reach the hub from the phone over a VPN (WireGuard/Tailscale) - this also gives the phone a route to LAN cameras while the home Wi-Fi is up.
- Nothing in this report covers the gate controller or lights; those adapters were out of scope for this topic.

## Libraries

- **pytapo** (python, MIT, latest main (transport/tpap SPAKE2+ present)): Reference implementation of the Tapo local HTTPS JSON API: KLAP/TPAP/legacy login, stok channel, PTZ, presets, privacy, reboot, status, and the port-8800 media session. Port the login + a thin JSON client to TypeScript or run it as a Python sidecar. https://github.com/JurajNyiri/pytapo
- **go2rtc** (binary, MIT, >= 1.9.13 (tuya source) - 1.9.x): Single streaming gateway: consumes rtsp://, tapo://, dvrip://, onvif://, tuya:// sources and serves WebRTC/MSE/HLS to the PWA plus two-way audio; also acts as ONVIF server for other clients. https://github.com/AlexxIT/go2rtc
- **pyezvizapi** (python, Apache-2.0, main): EZVIZ consumer-cloud client (login/regions, pagelist status incl. Wi-Fi + LAN IP, ptzControl, netWork Wi-Fi list, reboot, capture, MQTT push). Works over the SIM path. https://github.com/RenierM26/pyEzvizApi
- **python-dvr (OpenIPC fork)** (python, MIT, master): DVRIP/Sofia client for XMEye/ICSee: login/sofia hash, OPMonitor, OPPTZControl, ConfigGet/Set (NetWork.Wifi, NetWork.NetCommon, NetWork.Nat), OPMachine reboot, snapshot, file download. https://github.com/OpenIPC/python-dvr
- **onvif** (npm, MIT, 0.8.3): Node ONVIF client for Tapo (port 2020), EZVIZ listed models, CamHi, YCC365: GetStreamUri, PTZ ContinuousMove/GotoPreset, events, and Dot11 probing. https://www.npmjs.com/package/onvif
- **@tuya/tuya-connector-nodejs** (npm, MIT, 2.1.2): Signed Tuya Cloud requests from Node for stream/actions/allocate and iot-03 device commands (ptz_control, ptz_stop, basic_private). https://www.npmjs.com/package/@tuya/tuya-connector-nodejs
- **V380Decoder** (binary, not stated in repository, latest release (.NET 10)): Bridges V380 Pro port-8800 encrypted protocol (LAN or V380 cloud relay) to RTSP/ONVIF/snapshot/REST so go2rtc can consume it. https://github.com/theMavl/V380Decoder
- **ezviz-enable-rtsp** (binary, MIT (depends on proprietary Hikvision HCNetSDK), main (Docker image)): Flips EZVIZ 'servicesSwitch' rtsp=1 over HCNetSDK port 8000 and can re-apply on an interval when firmware disables RTSP. https://github.com/ylemoigne/ezviz-enable-rtsp
- **ha-hi3510** (python, MIT, main): Reference for Hi3510 (CamHi/HiP2P) CGI paths: param.cgi (getwirelessattr etc.), ptzctrl.cgi, preset.cgi, /tmpfs/auto.jpg, getserverinfo. https://github.com/spagonic/ha-hi3510
- **dvrip-cam (docs/PROTOCOL.md, SPEC.md)** (python, MIT, main): Reverse-engineered DVRIP reference including NetWork.Wifi structure, SoftAP onboarding, UDP 34569 discovery and the list of sections unsupported on XM Wi-Fi firmware; ships tools/wifi_qr.py for the ICSee onboarding QR. https://github.com/kwebmn/dvrip-cam

## Could not be verified (treat as uncertain)

- ENDPOINT 15: EZVIZ ONVIF POST http://{ip}/onvif/device_service (port not published; try 80, 8000, 8899), admin + verification code
- ENDPOINT 23: EZVIZ Open Platform live address POST /api/lapp/live/address/get with protocol 1-4, quality, expireTime 30s-720d (also /live/address/limited)
