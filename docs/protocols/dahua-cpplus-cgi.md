# dahua-cpplus-cgi

Review: 43 claims confirmed, 4 corrected, 2 could not be verified.

## Summary

Dahua's HTTP CGI API (shared by Amcrest, Lorex and CP Plus professional UNC/UNP/UVR lines, which are Dahua OEM) is fully documented for everything the hub needs on the LAN path: HTTP Digest (MD5, qop=auth) or Basic auth on every /cgi-bin/ URL; RTSP at rtsp://user:pass@ip:554/cam/realmonitor?channel=1&subtype=0|1|2; JPEG snapshots via snapshot.cgi; PTZ via ptz.cgi?action=start|stop&channel=0&code=Left|Right|Up|Down|ZoomTele|ZoomWide&arg1..arg3 plus GotoPreset/SetPreset/getPresets/getStatus; reboot and device identity via magicBox.cgi; network interface enumeration via netApp.cgi?action=getInterfaces (interfaces named eth0 wired, eth2 wireless, 3G cellular); WiFi read/write via configManager.cgi getConfig/setConfig name=WLan (WLan.eth2.Enable/SSID/Encryption/KeyType/Keys[0..3]/KeyID/LinkMode) and AP scanning via wlan.cgi?action=scanWlanDevices; and a push event stream via eventManager.cgi?action=attach&codes=[All]&heartbeat=5 (multipart/x-mixed-replace, lines like Code=VideoMotion;action=Start;index=0). Switching a camera to another WiFi is therefore a scan + one setConfig call, and Network.DefaultInterface can be re-pointed between eth0/eth2/3G. What is NOT documented in any public Dahua/Amcrest CGI spec I could find is the cellular (4G) configuration table: the web UI exposes Enable, Network type, APN, AUTH (PAP/CHAP), Dial number, User name, Password and Pulse interval, and firmware JS exposes RPC2 methods netApp.getMobileRSSI and mobile.getStatus, but the configManager table name/keys must be discovered on the real device (Config.backup?action=All dumps every table as JSON; RPC2 system.listMethod lists methods) - treat that part as low confidence. The CP Plus 4G SIM cameras sold in India (CP-V32G, CP-V33G, CP-V33GN, CP-Z32G, CP-D31G, EZ-R33G) are the ezyKam+ consumer line driven by the ezykam+ cloud app; their spec sheets list ONVIF and RTMP (CP-V33G also RTSP/HTTP) but nothing shows they run Dahua firmware or answer /cgi-bin/, so the adapter should probe magicBox.cgi?action=getDeviceType first and fall back to ONVIF (Profile S/T: GetStreamUri, Snapshot, PTZ ContinuousMove) if it 404s. Reaching any camera over its SIM is a network-path problem (carrier NAT), not a CGI problem: the CGI calls are identical over 4G but the hub needs a VPN/tunnel or public APN to get to the camera. Newer Dahua firmware must have Authentication Mode = Compatible with MD5 digest enabled or the CGI returns 401/500. For Node.js, digest-fetch (ISC), @mhoc/axios-digest-auth (MIT) or urllib (MIT) handle Digest; go2rtc (MIT) turns the RTSP stream into WebRTC/MSE/HLS for the browser PWA; the onvif npm package (MIT) covers the ONVIF fallback.

## Corrections from review (these override anything below)

- **Claim:** FACT: No public Dahua/Amcrest CGI specification documents a cellular/4G configuration table (no 3G/Mobile/MobileNet keys, no APN key); only web-UI fields are documented; Dahua France 4G guide shows APN/Dial code/User/Password and P2P
  **Correction:** Public Dahua HTTP API V3.35 (Intelbras-branded, 2023-07-21) documents cellular tables: section 4.8.16 '[Config] Cellular Network Traffic Packages' = configManager getConfig&name=CellularFlux with keys CellularFlux.3G.SIM1.Enable and CellularFlux.3G.SIM1.MonthFlux.{FluxUp,FluxUpUnit,FluxWarn,FluxWarnUnit,FluxStartDay} ('3G naming is reserved, which can actually represent 4G and 5G network adapters'; modules 3G, 3G1, 3G2, 3G3; SIM1..SIM3), plus POST /cgi-bin/api/DataFlux/getFlux and /cgi-bin/api/DataFlux/queryHistoryFlux. Those sections describe the card key as 'the key value of the first-level node under Wireless', and the Dahua NetSDK defines CFG_CMD_WIRELESS = "Wireless" ('wireless connect config CFG_WIRELESS_INFO'), so the dial-up/APN table to probe is getConfig&name=Wireless (first-level keys 3G, 3G1...). What remains true: the individual APN/auth/dial key names inside Wireless are not listed in any HTTP API spec I found, so they must be read from the device. The DahuaWiki UI field list (Network type, APN, AUTH PAP/CHAP, Dial number, User name, Password, Pulse interval, 3G module) is confirmed; the Dahua France 4G guide was not located.
  Source: https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf ; https://raw.githubusercontent.com/18liuyuan/xeyes/master/app/src/main/java/com/company/NetSDK/INetSDK.java ; https://dahuawiki.com/NVRiSettingNetwork
- **Claim:** ENDPOINT: MJPEG stream — GET /cgi-bin/mjpg/video.cgi?channel=1&subtype=1; subtype must be a stream encoded as MJPEG (cited to v1.40)
  **Correction:** The URL exists, but v1.40 section 4.1.4 documents only http://<ip>/cgi-bin/mjpg/video.cgi?[channel=<channelNo>] (default channel 0, no subtype). The subtype parameter comes from Amcrest v2.12 table 4-4: /cgi-bin/mjpg/video.cgi[?channel=<ChannelNo>&subtype=<typeNo>], channel from 1 (default 1), subtype 0 main / 1 extra 1 / 2 extra 2, default 0. Neither spec states that the chosen stream must be MJPEG-encoded; that condition is unverified.
  Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf ; https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf
- **Claim:** ENDPOINT: Cellular/4G configuration — getConfig&name=<cellular table - unknown, discover via Config.backup>
  **Correction:** The table name is not unknown. Probe GET /cgi-bin/configManager.cgi?action=getConfig&name=Wireless (NetSDK CFG_CMD_WIRELESS = "Wireless"; V3.35 says the first-level nodes under Wireless are 3G, 3G1, 3G2, 3G3) and GET ...getConfig&name=CellularFlux (documented in V3.35 4.8.16: table.CellularFlux.3G.SIM1.Enable, .MonthFlux.FluxUp/FluxUpUnit/FluxWarn/FluxWarnUnit/FluxStartDay). Traffic usage: POST /cgi-bin/api/DataFlux/getFlux with JSON body {"card":"3G","SimName":"SIM1","ICCID":"..."}. The APN/auth/dial key names inside Wireless are still undocumented, so read them from the device before writing.
  Source: https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf ; https://raw.githubusercontent.com/18liuyuan/xeyes/master/app/src/main/java/com/company/NetSDK/INetSDK.java
- **Claim:** ENDPOINT: RTSP port / HTTP port config — getConfig&name=RTSP
  **Correction:** getConfig&name=RTSP returns only table.RTSP.Enable, table.RTSP.Port (554), table.RTSP.RTP.StartPort and table.RTSP.RTP.EndPort. It does not contain the HTTP port. No HTTP-port config table was found in v1.40, v2.12 or V3.35.
  Source: v1.40 section 5.9.1 https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf ; V3.35 section 4.8.12

## Added by review (things an implementer needs)

- **PTZ channel base conflicts between spec versions** v1.40 7.2.3: 'ch is PTZ channel range is [0 - n-1]'. Amcrest v2.12 4.10.7: 'range is [1 - n]' but its example uses channel=0. HTTP API V3.35: 'The PTZ channel index; starting from 1' with example ptz.cgi?action=start&channel=1&code=Up&arg1=0&arg2=1&arg3=0. python-amcrest defaults channel=0. The adapter must make the PTZ channel a per-device setting (try 1, fall back to 0) and verify by a getStatus or visible move. (https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf ; https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf ; https://raw.githubusercontent.com/tchellomello/python-amcrest/master/src/amcrest/ptz.py)
- **Newer PTZ commands exist that are safer than start/stop pairs** V3.35 documents ptz.cgi?action=start&code=Continuously&channel=1&arg1=<h>&arg2=<v>&arg3=<zoom -100..100>&arg4=<timeout s, max 3600> ('If the PTZ does not receive the stop command before the preset overtime period, it will stop moving automatically'), stopped with action=stop&code=Continuously. Also ptz.cgi?action=moveAbsolutely&channel=1&arg1=<pan -1..1>&arg2=<tilt -1..1>&arg3=<zoom> (normalised, not degrees), ptz.cgi?action=moveRelatively, and ptz.cgi?action=SetPreset&channel=1&arg1=<index>&arg2=<name> to name a preset. A timeout matters on the SIM path where the stop request can be lost. (https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf (section 8.1))
- **Digest challenge differs on current firmware; do not hardcode the realm or assume Basic** V3.35 section 3.4 documents digest only (RFC 7616), with challenge WWW-Authenticate: Digest realm="Device_00408CA5EA04", nonce="...", qop="auth", opaque="..."; the client must echo opaque. A wrong digest gets HTTP 403, not 401. Basic is not mentioned. rroller notes that selecting more than one digest algorithm on the device is known to break RTSP, so MD5 alone is the working setting. (https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf ; https://raw.githubusercontent.com/rroller/dahua/main/README.md)
- **CGI can be switched off or absent entirely** rroller README: 'The CGI service must be enabled' (System > Safety/Security > System Service > CGI Service); test with http://<address>/cgi-bin/magicBox.cgi?action=getMachineName, where 404 means CGI is off and a login prompt means on. Some devices (cloud-only Imou/Lechange, some doorbells) serve no /cgi-bin/ at all and answer 404 to every path; rroller then falls back to RPC2 polling. If HTTPS is enabled on the device, plain HTTP on port 80 will not connect; use port 443. A never-initialised device has no account and must be initialised first. (https://raw.githubusercontent.com/rroller/dahua/main/README.md)
- **WiFi scan response format changed** Old specs show the first line as 'Found Num:1'. V3.35 shows 'found=1' and a real user got 'found=0' from a camera with a dead WiFi module. Parse both. V3.35 also defines the integer enums: ApConnected 0 not connected / 1 connecting / 2 connected; EncrAlgr 0 NONE, 1 WEP, 2 TKIP, 3 AES(CCMP), 4 TKIP+AES, 5 unknown; LinkMode 0 auto, 1 adhoc, 2 infrastructure; ApNetWorkType 0 11b, 1 11a, 2 11a/n, 3 11b/g, 4 11b/g/n; LinkQuality 0-100 percent; RSSIQuality in dBm (-100..0). AuthMode is an undocumented integer (example value 7). (https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf (4.8.8) ; https://ipcamtalk.com/threads/dahua-ipc-hfw2325s-w-cant-find-any-wifi.70459/)
- **WLan table has extra keys and interface names on newer firmware** V3.35 4.8.7 adds WLan.<if>.BSSID (AP MAC) and WLan.<if>.ConnectEnable ('Connect Manually', bool), and lists wlan0 and wlan1 as other wireless interface names besides eth2. Take the interface name from getConfig&name=WLan or getInterfaces rather than assuming eth2. A re-point flow likely needs ConnectEnable=true as well as SSID/Keys; this is not demonstrated in any source and must be tested. (https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf)
- **getInterfaces returns link state on newer firmware, which is the cheapest WiFi-vs-cellular health check** V3.35 adds per interface: NetCardName (e.g. eth0, wlan0, ppp5, lte0), ConnStatus {Inexistence, Down, Disconn, Connecting, Connected}, Speed, PhysicalAddress, SupportLongPoE. The example cellular entry is netInterface[1].Name=3g (lower case) with Type=Auto,WCDMA,TD-SCDMA,TD-LTE,FDD-LTE, so match the name case-insensitively. (https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf (4.8.1))
- **Camera can push video and events outbound, which is the only spec-documented route that fits the SIM path** V3.35 4.8.19: getConfig&name=RTMP_NVR ('both NVR and IPC will use this configuration') with keys RTMP_NVR.Enable, Address, Port (example 1935), CustomPath, StreamPath, Key, Main[ch].{Enable,ChannelID,Url}, Extra[ch].*, Extra2[ch].*, SSLEncryptEnable; Url example rtmp://livepush.myqcloud.com/live/camera001. Also AlarmServer table (Enable, Protocol, Address, Port, UserName, Password, ReportWeekDay, ReportTime) and PictureHttpUpload (Enable, Type=digest, UploadServerList[i].Address/Port/UserName/Password/Uploadpath). None of the claims explain how the hub reaches a camera's CGI or RTSP over a SIM; no source read here shows inbound access over a cellular link, so plan for camera-initiated push or the vendor cloud and verify on the real SIMs. (https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf)
- **RPC2 / DHIP login details needed to implement the client** Step 1: POST /RPC2_Login {"method":"global.login","params":{"userName":"admin","password":"","clientType":"Web3.0"},"id":1} returns error code 268632079 plus params.realm (e.g. 'Login to 4X02345PAJ9A82F'), params.random and session. Step 2: Hash1 = MD5(user:realm:password) as UPPER-CASE hex, Hash2 = MD5(user:random:Hash1) upper-case; send global.login again with password=Hash2 and the temporary session (rroller sends clientType 'Web5.0', realm, passwordType 'Default', authorityType = params.encryption or 'Default'). Then POST /RPC2 with the session; send global.keepAlive about every 60 s. system.multicall batches calls. DHIP adds loginType 'Direct'. (https://raw.githubusercontent.com/H3xano/dahua-rpc-api/main/README.md ; https://raw.githubusercontent.com/rroller/dahua/main/custom_components/dahua/rpc2.py ; https://raw.githubusercontent.com/OpenIPC/python-dhip/master/README.md)
- **DHIP wire format and response quirks** Little-endian 32-byte header then JSON then optional binary: u32 0x00000020, u32 magic 0x50494844 ('DHIP'), u32 sessionID (0 before login), u32 requestID (mirrors JSON id), u32 packageLength, u32 packageIndex, u32 messageLength, u32 dataLength. Envelope is not uniform: most getters return {result:true, params:{...}}; global.getCurrentTime puts the value in result; errors are {result:false, error:{code,message}}. ptz.moveAbsolutely takes degrees while ptz.getStatus returns raw encoder units. The verified Zenointel OEM camera uses RTSP path /H264?ch={channel}&subtype={subtype}, not /cam/realmonitor. Legacy Dahua framing on TCP 37777 is a different protocol. (https://raw.githubusercontent.com/OpenIPC/python-dhip/master/README.md)
- **keepalive and heartbeat are opposite directions** keepalive=<1-60>: the CLIENT must write data (e.g. the string 'keep alive') to the connection each cycle. heartbeat=<1-60>: the DEVICE sends the string 'Heartbeat' as a text/plain part. V3.35: 'It is recommended to use the Heartbeat parameter instead of the keepalive parameter'. Some firmware rejects long code lists: an IPC-HFW4300S-V2 answered 400 and a Hero A1 answered 500 to a nine-code list while codes=[VideoMotion] worked; rroller retries with codes=[All] and filters locally. In spec examples the commas inside codes=[...] are percent-encoded (%2C). (https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf (4.9.17) ; https://raw.githubusercontent.com/rroller/dahua/main/README.md)
- **go2rtc browser/codec constraints for the PWA** Default ports: API/web 1984, RTSP 8554, WebRTC 8555 TCP/UDP. WebRTC audio accepts only PCMU/8000, PCMA/8000, OPUS/48000/2, so a Dahua stream with AAC audio needs a second source 'ffmpeg:rtsp://...#audio=opus' or the camera set to PCMA/PCMU. iPhone Safari 14+ gets WebRTC and HLS only; MSE needs iOS 17.1+. H265 over WebRTC needs Chrome 136+ / Safari 18+, and Firefox is H264 only, so set the viewed sub-stream to H.264 (rroller README also says H.265 will not render in the browser). (https://raw.githubusercontent.com/AlexxIT/go2rtc/master/README.md ; https://raw.githubusercontent.com/rroller/dahua/main/README.md)
- **ONVIF credentials can differ from the CGI account** V3.35 cybersecurity notes: 'On older IP Camera firmware, the ONVIF password does not change when you change the system's credentials'. getConfig&name=UserGlobal returns table.UserGlobal.OnvifLoginCheck; false means ONVIF is served without login. ONVIF version: /cgi-bin/IntervideoManager.cgi?action=getVersion&Name=Onvif (v1.40 used intervideoManager.cgi?action=getOnvifVersion). (https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf ; https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf)
- **URL encoding and key-name quirks in setConfig** Specs require RFC 3986 escaping of spaces and ; / ? : @ = + , $ inside names and values, which matters for SSIDs and passphrases. The specs spell the network write keys inconsistently ('NetWork.DefaultInterface', 'NetWork.Domain', 'NetWork.eth0.DhcpEnable' in examples vs 'Network.' in reads); which casing a device accepts is untested. Boolean values are the strings true/false. Success body is 'OK', failure 'ERROR'. (https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf (3.1, 5.2.2) ; https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf (4.8.3))
- **The specs used by the researcher are 2014 and 2017; a 2023 spec is public** All researcher citations are v1.40 (2014-5-12) and Amcrest v2.12 (2017). HTTP API V3.35 (2023-07-21, Intelbras-branded Dahua document) is publicly downloadable and should be the adapter's primary reference; it changes channel bases, auth, scan output and adds cellular, RTMP push and normalised PTZ calls. (https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf)
- **No evidence that the CP Plus ezyKam+ 4G cameras are Dahua-firmware devices** Nothing found documents /cgi-bin/, RTSP path or port for ezyKam+ models; a Home Assistant community request for the ezyKam+ RTSP link is unanswered, and the only concrete report is ONVIF on port 8000 after enabling it in the CP Plus app. The Dahua adapter should not be assumed to work for these; build an ONVIF adapter path and probe the real units (HTTP 80/8000, RTSP 554/8554, TCP 5000/37777/34567). (https://community.home-assistant.io/t/cp-plus-integration/431192 ; https://www.poscentral.in/cp-plus-ezykam-cp-z32g-3mp-4g-pan-tilt-camera.html)

## Calls

### Digest auth handshake (all CGI)

```
http GET http://<ip>/cgi-bin/magicBox.cgi?action=getMachineName
```
- Params: none; first request gets 401 + WWW-Authenticate: Digest realm="DH_<MAC>", nonce=..., stale=FALSE, qop="auth"; resend with Authorization: Digest username, realm, nonce, uri, qop=auth, nc, cnonce, response
- Auth: HTTP Digest (MD5, qop=auth) - Basic also accepted on older firmware
- Response: 200 text/plain: name=<machine name>  (401 again = bad credentials)
- Notes: python-amcrest logs in against this URL: tries HTTPBasicAuth, then HTTPDigestAuth; treats a body containing 'invalid' or 'error' as LoginError. Use HTTPS (port 443) when enabled on the camera; same URLs.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### Device type — confirmed

```
http GET http://<ip>/cgi-bin/magicBox.cgi?action=getDeviceType
```
- Params: none
- Auth: digest
- Response: type=IPC-HF3300
- Notes: Use as the 'is this a Dahua-firmware device?' probe for CP Plus units: 200 with type= means Dahua CGI is present; 404/HTML means not.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### System info — confirmed

```
http GET http://<ip>/cgi-bin/magicBox.cgi?action=getSystemInfo
```
- Params: none
- Auth: digest
- Response: serialNumber=YZC0GZ05100020\ndeviceType=IPC-HF3300\nhardwareVersion=1.00
- Notes: Related: action=getSerialNo (sn=...), getHardwareVersion (version=...), getMachineName (name=...), getVendor (vendor=Dahua), getSoftwareVersion (version=2.212.0000.0.R,build:2013-11-14), getProductDefinition&name=MaxExtraStream (table.MaxExtraStream=1).
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### Reboot — confirmed

```
http GET http://<ip>/cgi-bin/magicBox.cgi?action=reboot
```
- Params: optional &delay=<seconds> (python-amcrest)
- Auth: digest
- Response: OK or ERROR
- Notes: action=shutdown also exists. RPC2 equivalent: {"method":"magicBox.reboot"}. Home Assistant integration calls /cgi-bin/magicBox.cgi?action=reboot.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### Current time — confirmed

```
http GET http://<ip>/cgi-bin/global.cgi?action=getCurrentTime
```
- Params: set with global.cgi?action=setCurrentTime&time=<YYYY-MM-DD HH:MM:SS>
- Auth: digest
- Response: result=2024-01-01 12:00:00
- Notes: Cheap liveness probe for the LAN/4G reachability check.
- Source: https://raw.githubusercontent.com/tchellomello/python-amcrest/master/src/amcrest/system.py

### Full config dump (discover table names)

```
http GET http://<ip>/cgi-bin/Config.backup?action=All
```
- Params: none
- Auth: digest
- Response: 200, Content-type: application/binarytet-stream; body is JSON of every config table, e.g. { "ATM" : { "DataSource" : "RS232", ...
- Notes: Grep this for 'APN', 'Dial', 'WLan' to learn the exact cellular table name/keys on the owner's cameras before implementing 4G config writes.
- Source: https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf

### RTSP main stream — confirmed

```
rtsp DESCRIBE/PLAY rtsp://<user>:<pass>@<ip>:554/cam/realmonitor?channel=1&subtype=0
```
- Params: channel = 1-based video channel; subtype 0 = main, 1 = sub stream 1, 2 = sub stream 2 (3 on newer high-end); optional &unicast=true&proto=Onvif
- Auth: RTSP Basic/Digest (same account)
- Response: H.264/H.265 (+AAC/G.711) RTP over TCP or UDP
- Notes: Feed this to go2rtc for WebRTC/MSE/HLS in the PWA. Port comes from configManager.cgi?action=getConfig&name=RTSP (table.RTSP.Port=554, table.RTSP.Enable=true). Frigate recommends subtype=1 for detection and 0 for record.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### JPEG snapshot — confirmed

```
http GET http://<ip>/cgi-bin/snapshot.cgi?channel=1
```
- Params: channel optional; v1.40 IPC spec says default 0 when omitted, Amcrest v2.12 says channels start at 1 (default 1) - test per device
- Auth: digest
- Response: image/jpeg body
- Notes: Home Assistant uses /cgi-bin/snapshot.cgi?channel={n}. Good for the tile thumbnail and for 'action done' notification images.
- Source: https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf

### MJPEG stream (browser <img>)

```
http GET http://<ip>/cgi-bin/mjpg/video.cgi?channel=1&subtype=1
```
- Params: channel; subtype must be a stream whose Encode compression is MJPEG
- Auth: digest
- Response: multipart/x-mixed-replace;boundary=<b> with image/jpeg parts
- Notes: Documented as mjpg/video.cgi?[channel=<n>] in v1.40; the substream must be set to MJPEG in Encode config or the request fails. Low-bandwidth fallback for the 4G path.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### PTZ move start (Left/Right/Up/Down)

```
http GET http://<ip>/cgi-bin/ptz.cgi?action=start&channel=0&code=Left&arg1=0&arg2=<speed 1-8>&arg3=0
```
- Params: channel 0-based PTZ channel; code one of Up, Down, Left, Right; arg1=0; arg2=speed [1-8]; arg3=0
- Auth: digest
- Response: OK or ERROR
- Notes: Camera keeps moving until the matching stop call. Diagonals: code=LeftUp|RightUp|LeftDown|RightDown with arg1=vertical speed [1-8], arg2=horizontal speed [1-8], arg3=0.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### PTZ move stop — confirmed

```
http GET http://<ip>/cgi-bin/ptz.cgi?action=stop&channel=0&code=Left&arg1=0&arg2=<speed>&arg3=0
```
- Params: same code/args as the start call
- Auth: digest
- Response: OK or ERROR
- Notes: HA builds /cgi-bin/ptz.cgi?action={start|stop}&channel={ch}&code={code}&arg1=0&arg2={arg}&arg3=0; for a touch 'nudge' send start, wait ~300-500 ms, send stop.
- Source: https://raw.githubusercontent.com/rroller/dahua/main/custom_components/dahua/client.py

### PTZ zoom — confirmed

```
http GET http://<ip>/cgi-bin/ptz.cgi?action=start&channel=0&code=ZoomTele&arg1=0&arg2=1&arg3=0
```
- Params: code=ZoomTele (zoom in) or ZoomWide (zoom out); arg1=0, arg2=multiple (speed), arg3=0; then action=stop with same args
- Auth: digest
- Response: OK or ERROR
- Notes: Same pattern for FocusNear/FocusFar and IrisLarge/IrisSmall. python-amcrest sends ZoomTele/ZoomWide with arg1=arg2=arg3=0.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### PTZ go to preset — confirmed

```
http GET http://<ip>/cgi-bin/ptz.cgi?action=start&channel=0&code=GotoPreset&arg1=0&arg2=<preset number>&arg3=0
```
- Params: arg2 = preset index (1..caps.PresetMax)
- Auth: digest
- Response: OK or ERROR
- Notes: No stop call needed. code=SetPreset stores the current position as arg2; code=ClearPreset deletes it; code=SetPresetName (arg1=preset number, arg2=title) names it.
- Source: https://raw.githubusercontent.com/rroller/dahua/main/custom_components/dahua/client.py

### PTZ list presets — confirmed

```
http GET http://<ip>/cgi-bin/ptz.cgi?action=getPresets&channel=1
```
- Params: channel (Amcrest v2.12: video channel starting at 1; HA passes its channel number)
- Auth: digest
- Response: presets.presets[0].Index=1\npresets.presets[0].Name=preset1\npresets.presets[1].Index=2 ...
- Notes: Tours: ptz.cgi?action=getTours&channel=1 (tours.tours[i].Index/Name); start/stop with code=StartTour / StopTour, arg1=tour number.
- Source: https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf

### PTZ status / position

```
http GET http://<ip>/cgi-bin/ptz.cgi?action=getStatus&channel=1
```
- Params: channel optional
- Auth: digest
- Response: status.UTC=6538920\nstatus.MoveStatus=Idle\nstatus.ZoomStatus=Idle\nstatus.PresetID=10\nstatus.Position=120,12,2
- Notes: Position is pan,tilt,zoom. Capabilities (PresetMax, PanSpeedMax, TourMax...) via ptz.cgi?action=getCurrentProtocolCaps&channel=<n> -> caps.PresetMax=80 etc.
- Source: https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf

### PTZ absolute position

```
http GET http://<ip>/cgi-bin/ptz.cgi?action=start&channel=0&code=PositionABS&arg1=<pan 0-360>&arg2=<tilt 0-90>&arg3=<zoom multiple>&arg4=<speed 1-8 optional>
```
- Params: arg1 horizontal angle 0-360, arg2 vertical angle 0-90, arg3 zoom multiple, arg4 speed (not mandatory)
- Auth: digest
- Response: OK or ERROR
- Notes: code=Continuously (arg1 h-speed [-8..8], arg2 v-speed [-8..8], arg3 zoom speed, arg4 timeout) is the single-call joystick variant on newer firmware; code=Position (arg1 horizontal position, arg3 zoom change) also exists.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### PTZ click-to-center (3D positioning)

```
http GET http://<ip>/cgi-bin/ptzBase.cgi?action=moveDirectly&channel=0&startPoint[0]=<x>&startPoint[1]=<y>&endPoint[0]=<x>&endPoint[1]=<y>
```
- Params: screen coordinates 0-8192 (e.g. startPoint[0]=7253&startPoint[1]=2275&endPoint[0]=7893&endPoint[1]=3034)
- Auth: digest
- Response: OK or ERROR
- Notes: Lets the touch UI implement 'tap on the video to aim there' and drag-to-zoom.
- Source: https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf

### Network interface enumeration — confirmed

```
http GET http://<ip>/cgi-bin/netApp.cgi?action=getInterfaces
```
- Params: none
- Auth: digest
- Response: netInterface[0].Name=eth0\nnetInterface[0].Type=Normal\nnetInterface[0].Valid=true\nnetInterface[1].Name=eth2\nnetInterface[1].Type=Wireless ...
- Notes: Name: eth0 wired, eth2 wireless, 3G cellular; Type: Normal, Wireless, or Auto/TD-SCDMA/WCDMA/CDMA1x/EDGE/EVDO (newer specs add TD-LTE/FDD-LTE/NR). RPC2 equivalent netApp.getNetInterfaces returns Name, Type, Valid, ConnStatus, PhysicalAddress, Speed. Use Valid=true on the 3G entry as the 'SIM path exists' signal.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### Network basic config (read)

```
http GET http://<ip>/cgi-bin/configManager.cgi?action=getConfig&name=Network
```
- Params: none
- Auth: digest
- Response: table.Network.DefaultInterface=eth0\ntable.Network.Domain=dahua\ntable.Network.Hostname=badak\ntable.Network.eth0.DefaultGateway=10.7.0.1\ntable.Network.eth0.DhcpEnable=false\ntable.Network.eth0.DnsServers[0]=...\ntable.Network.eth0.IPAddress=10.7.2.3\ntable.Network.eth0.MTU=1500\ntable.Network.eth0.PhysicalAddress=00:10:5c:f2:1c:b4\ntable.Network.eth0.SubnetMask=255.255.0.0
- Notes: One block per interface name (eth0, eth2, 3G...). HertzBeat's Dahua monitor reads exactly this URL with Digest auth.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### Switch default interface (wired/WiFi/cellular)

```
http GET http://<ip>/cgi-bin/configManager.cgi?action=setConfig&Network.DefaultInterface=eth2
```
- Params: Network.DefaultInterface = one of the names from getInterfaces; other writable keys: Network.<if>.DhcpEnable, IPAddress, SubnetMask, DefaultGateway, DnsServers[0], DnsServers[1], MTU
- Auth: digest
- Response: OK or ERROR
- Notes: Spec: 'Set default network interface when multiple interfaces exist. Range of interfaces depends on GetInterfaces'. This is the documented lever for 'prefer WiFi' vs 'prefer 4G'; whether a given 4G model honours DefaultInterface=3G must be tested.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### WiFi config (read)

```
http GET http://<ip>/cgi-bin/configManager.cgi?action=getConfig&name=WLan
```
- Params: none
- Auth: digest
- Response: table.WLan.eth2.Enable=true\ntable.WLan.eth2.Encryption=off\ntable.WLan.eth2.KeyFlag=false\ntable.WLan.eth2.KeyID=0\ntable.WLan.eth2.KeyType=Hex\ntable.WLan.eth2.Keys[0]=password1\ntable.WLan.eth2.Keys[1]=password2\ntable.WLan.eth2.Keys[2]=password3\ntable.WLan.eth2.Keys[3]=password4\ntable.WLan.eth2.LinkMode=Auto\ntable.WLan.eth2.SSID=dahua
- Notes: Read first, then write only the keys you change. Newer firmware may return extra keys and redact Keys[].
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### WiFi config (write / re-point to another SSID)

```
http GET http://<ip>/cgi-bin/configManager.cgi?action=setConfig&WLan.eth2.Enable=true&WLan.eth2.SSID=<ssid>&WLan.eth2.Encryption=<enum>&WLan.eth2.KeyType=ASCII&WLan.eth2.Keys[0]=<passphrase>&WLan.eth2.KeyID=0&WLan.eth2.LinkMode=Infrastructure
```
- Params: WLan.<if>.Enable bool; Encryption {Off, On, WEP64Bits, WEP128Bits, WPA-PSK-TKIP, WPA-PSK-CCMP} in the 2014/2017 specs (current firmware also reports strings like WPA2-PSK-AES - copy whatever getConfig returns); KeyType {Hex, ASCII}; Keys[0..3] string; KeyID [0-3]; LinkMode {Auto, Ad-hoc, Infrastructure}; URL-encode the SSID/passphrase (RFC 3986)
- Auth: digest
- Response: OK or ERROR
- Notes: Spec example: setConfig&WLan.eth2.Enable=true&WLan.eth2.KeyType=Hex. Interface name comes from getInterfaces (eth2 on every documented model). Issue this over the wired or 4G path, because the WiFi link drops when the camera re-associates; then poll getConfig&name=Network for the new eth2 IP.
- Source: https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf

### WiFi scan — confirmed

```
http GET http://<ip>/cgi-bin/wlan.cgi?action=scanWlanDevices
```
- Params: optional &SSID=<name> to scan for one network (spaces as %20)
- Auth: digest
- Response: Found Num:1\nwlanDevice[0].ApConnected=0\nwlanDevice[0].ApMaxBitRate=54000000\nwlanDevice[0].ApNetWorkType=255\nwlanDevice[0].AuthMode=7\nwlanDevice[0].BSSID=28:2c:b2:5c:de:36\nwlanDevice[0].EncrAlgr=3\nwlanDevice[0].LinkMode=0\nwlanDevice[0].LinkQuality=31\nwlanDevice[0].RSSIQuality=0\nwlanDevice[0].SSID=xia_yuguo 13098 Internet
- Notes: Real-world usage: curl -g --digest -u user:pass "http://<ip>/cgi-bin/wlan.cgi?action=scanWlanDevices" (ipcamtalk); 'found=0' on a WiFi-capable model indicates a dead WiFi module. Present the SSID list in the app's 'move camera to another WiFi' sheet.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### Cellular / 4G status (RPC2, undocumented params)

```
http POST http://<ip>/RPC2  body {"method":"netApp.getMobileRSSI","params":null,"id":<n>,"session":"<token>"}
```
- Params: none documented; also {"method":"mobile.getStatus"} and {"method":"WlanManager.getSTAInfo"} (WiFi SSID/RSSI/status)
- Auth: RPC2 session from POST /RPC2_Login (global.login challenge; MD5 of user/realm/random) - see H3xano README
- Response: JSON {"result":true,"params":{...}}; exact fields undocumented
- Notes: Reverse engineered from firmware rpc.js; confirm on the device with {"method":"system.listMethod"}. CGI equivalents for cellular status/APN were not found in any public spec (confidence low).
- Source: https://github.com/H3xano/dahua-rpc-api/blob/main/modules/09-network.md

### Cellular / 4G configuration (table name unknown)

```
http GET http://<ip>/cgi-bin/configManager.cgi?action=getConfig&name=<cellular table - discover via Config.backup?action=All>
```
- Params: UI fields known from Dahua docs: Enable, Network type, APN, AUTH (PAP/CHAP), Dial number (e.g. *99#), User name, Password, Pulse interval; India APNs are carrier-specific
- Auth: digest
- Response: table.<Name>.<Key>=<value> lines (unverified)
- Notes: NOT VERIFIED: no public Dahua/Amcrest CGI document lists the 3G/4G table (searched for name=3G, Mobile, MobileNet, table.3G, APN). Implement read-only display from the dumped JSON first; only add setConfig after the key names are seen on the owner's cameras. Dahua's own 4G guide says after APN entry the camera 'obtains an IP automatically' and is then reached via P2P.
- Source: https://dahuawiki.com/NVRiSettingNetwork

### Generic config read/write — confirmed

```
http GET http://<ip>/cgi-bin/configManager.cgi?action=getConfig&name=<Table>   |   http://<ip>/cgi-bin/configManager.cgi?action=setConfig&<Table>[.<idx>].<Key>=<value>[&...]
```
- Params: name = table (e.g. Network, WLan, RTSP, Encode, MotionDetect, VideoInOptions, NTP, UPnP, PPPoE, General.MachineName); setConfig accepts many key=value pairs in one call
- Auth: digest
- Response: getConfig: table.<Table>.<Key>=<value> lines; setConfig: OK or ERROR
- Notes: Example from HA: setConfig&Lighting[0][2].Mode=Manual; from ipcamtalk: setConfig&VideoInOptions[1].NightOptions.SwitchMode=3. Sub-keys can be read directly: getConfig&name=VideoColor[0][0].Brightness.
- Source: https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf

### Event stream (push notifications)

```
http GET (long-lived) http://<ip>/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5
```
- Params: codes=[VideoMotion,AlarmLocal,CrossLineDetection,...] or [All]; heartbeat=<1-60> seconds (older spec: &keepalive=20); optional &channel=1 on some firmware
- Auth: digest
- Response: 200 OK, Connection: close, Content-Type: multipart/x-mixed-replace; boundary=<b>; each part: --<b>\r\nContent-Type: text/plain\r\nContent-Length: <n>\r\n\r\nCode=VideoMotion;action=Start;index=0[;data=<JSON>]\r\n\r\n ; plus literal 'Heartbeat' parts
- Notes: action is Start / Stop / Pulse. Documented codes: VideoMotion, VideoLoss, VideoBlind, AlarmLocal, MDResult, StorageNotExist, StorageFailure, StorageLowSpace, AlarmOutput, CrossLineDetection, CrossRegionDetection, SmartMotionHuman, FaceDetection, LeftDetection, TakenAwayDetection, AudioMutation, HeatImagingTemper, CrowdDetection, FireWarning. Some firmware refuses a code list - HA falls back to [All] and filters. Reconnect when no heartbeat arrives within ~2x interval. Parse by Content-Length (python-amcrest) or by boundary.
- Source: https://github.com/rroller/dahua

### Event capabilities / current state

```
http GET http://<ip>/cgi-bin/eventManager.cgi?action=getCaps   |   http://<ip>/cgi-bin/eventManager.cgi?action=getEventIndexes&code=VideoMotion
```
- Params: code = VideoMotion, VideoLoss, VideoBlind, AlarmLocal ...
- Auth: digest
- Response: getEventIndexes: channels[0]=0\nchannels[1]=2 (channels where the event is currently active)
- Notes: Polling alternative when the attach stream is unavailable (e.g. RPC2-only devices use eventManager.getEventIndexes).
- Source: https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf

### Snapshot-on-event stream — confirmed

```
http GET (long-lived) http://<ip>/cgi-bin/snapManager.cgi?action=attachFileProc&Flags[0]=Event&Events=[VideoMotion,AlarmLocal]&channel=1
```
- Params: Events = event codes; channel optional
- Auth: digest
- Response: multipart stream of image/jpeg parts, one per event
- Notes: Gives the notification thumbnail without a second snapshot round-trip.
- Source: https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf

### RTSP port / HTTP port config — refuted

```
http GET http://<ip>/cgi-bin/configManager.cgi?action=getConfig&name=RTSP
```
- Params: none
- Auth: digest
- Response: table.RTSP.Enable=true\ntable.RTSP.Port=554\ntable.RTSP.RTP.StartPort=20000\ntable.RTSP.RTP.EndPort=40000
- Notes: Store the port per device; ISPs/routers often need 554 changed when exposing over 4G.
- **Review:** getConfig&name=RTSP returns only table.RTSP.Enable, table.RTSP.Port (554), table.RTSP.RTP.StartPort and table.RTSP.RTP.EndPort. It does not contain the HTTP port. No HTTP-port config table was found in v1.40, v2.12 or V3.35.
- Source: https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf

### DHIP JSON-RPC (TCP 5000) - alternate transport

```
serial TCP framed JSON tcp://<ip>:5000  {"method":"magicBox.getSystemInfo","params":null,"id":1,"session":"<sid>"}
```
- Params: same method names as RPC2: configManager.getConfig {"name":"General"}, ptz.start {"channel":0,"code":"Left","arg1":0,"arg2":<speed>,"arg3":0}, ptz.getStatus, ptz.getPresets, magicBox.reboot, eventManager.attach {"codes":["All"]}
- Auth: global.login two-step (challenge + MD5) over the same socket
- Response: JSON {"result":true,"params":{...},"id":1}
- Notes: Transport listed as 'serial' only because the schema has no raw-TCP option; it is Dahua's binary-framed DHIP protocol on port 5000 (HA uses it for doorbells). Useful if a CP Plus/Dahua unit disables HTTP CGI but leaves 5000 open.
- Source: https://github.com/OpenIPC/python-dhip

### CP Plus ezyKam+ 4G cameras - ONVIF fallback

```
soap POST http://<ip>:80/onvif/device_service (GetDeviceInformation, GetCapabilities) -> media service GetStreamUri / GetSnapshotUri -> ptz service ContinuousMove / Stop / GotoPreset
```
- Params: ProfileToken from GetProfiles; Velocity.PanTilt x/y in [-1,1] for ContinuousMove
- Auth: WS-UsernameToken (digest) with the camera's admin account
- Response: SOAP XML; GetStreamUri returns the RTSP URL the camera actually uses
- Notes: CP-V32G/CP-Z32G spec sheets say 'Onvif Supported' and 'RTMP Supported'; no evidence of Dahua CGI. The onvif npm package (MIT) implements these calls. Confidence low until the owner's unit is probed; the ezykam+ cloud app is the only officially documented control path for these models.
- Source: https://www.poscentral.in/cp-plus-ezykam-cp-z32g-3mp-4g-pan-tilt-camera.html

## Facts

- **Dahua CGI supports Basic and Digest authentication; an unauthenticated request gets HTTP 401 with WWW-Authenticate: Digest realm="DH_...", nonce, stale=FALSE, qop="auth", and the client answers with an MD5 digest over username, password, nonce, realm, method and URI.** [high] Section 3.2 Authentication of the Dahua IPC HTTP API v1.40 and section 3.5 of the Amcrest (Dahua OEM) HTTP API v2.12 both show the exact 401 challenge and the Authorization: Digest username="admin", realm="DH_00408CA5EA04", nc=00000001, cnonce=..., qop="auth", nonce=..., uri="/cgi-bin/magicBox.cgi?action=getLanguageCaps", response=... header. (https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf)
- **RTSP live URL is rtsp://<username>:<password>@<ip>:<port>/cam/realmonitor?channel=<channelNo>&subtype=<typeNo>; port defaults to 554, channel starts at 1, subtype 0 = main stream, 1 = extra stream 1, 2 = extra stream 2; RTSP also accepts Basic/Digest auth.** [high] Section 4.1.1 GetStream of the Dahua IPC HTTP API v1.40; the number of extra streams is read with magicBox.cgi?action=getProductDefinition&name=MaxExtraStream. Frigate's camera-specific docs confirm subtype=0/1 and that higher-end models add subtype=2 and subtype=3. (https://docs.frigate.video/configuration/camera_specific/)
- **PTZ continuous movement is a pair of GET calls: ptz.cgi?action=start&channel=<0-based>&code=<Code>&arg1=..&arg2=..&arg3=.. and the same URL with action=stop; for Up/Down/Left/Right arg1=0, arg2=speed 1-8, arg3=0; for LeftUp/RightUp/LeftDown/RightDown arg1=vertical speed 1-8 and arg2=horizontal speed 1-8; for ZoomTele/ZoomWide/FocusNear/FocusFar/IrisLarge/IrisSmall arg1=0, arg2=multiple, arg3=0.** [high] Section 7.2.3 PTZ control commands, Dahua IPC HTTP API v1.40 (also table 4-134 in Amcrest v2.12). The Home Assistant Dahua integration issues stop with the same code and args it used for start. (https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf)
- **Presets use the same ptz.cgi start URL with code=GotoPreset, SetPreset or ClearPreset and arg1=0&arg2=<preset number>&arg3=0; the list is read with ptz.cgi?action=getPresets&channel=<n> which returns presets.presets[i].Index and presets.presets[i].Name.** [high] Amcrest HTTP API v2.12 table 4-132 (getPresets, channel starts from 1 in that document) and PTZ code table; rroller/dahua client.py builds /cgi-bin/ptz.cgi?action=start&channel={0}&code=GotoPreset&arg1=0&arg2={1}&arg3=0. (https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf)
- **magicBox.cgi exposes reboot, shutdown, getDeviceType (type=IPC-HF3300), getHardwareVersion, getSerialNo (sn=...), getMachineName, getSystemInfo (serialNumber=, deviceType=, hardwareVersion=), getVendor (vendor=Dahua) and getSoftwareVersion (version=2.212.0000.0.R,build:2013-11-14).** [high] Section 9.8 System Operation of the Dahua IPC HTTP API v1.40; reboot/shutdown answer OK or ERROR. python-amcrest additionally sends magicBox.cgi?action=reboot&delay=<seconds>. (https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf)
- **WiFi configuration lives in the WLan table: configManager.cgi?action=getConfig&name=WLan returns table.WLan.eth2.Enable, Encryption, KeyFlag, KeyID, KeyType, Keys[0..3], LinkMode and SSID; it is written with configManager.cgi?action=setConfig&WLan.eth2.<key>=<value>[&...] which answers OK or ERROR.** [high] Sections 5.6.1 GetWlanConfig and 5.6.2 SetWlanConfig (Dahua IPC v1.40) and 4.7.6 (Amcrest v2.12). Documented enums: Encryption {Off, On, WEP64Bits, WEP128Bits, WPA-PSK-TKIP, WPA-PSK-CCMP}; KeyType {Hex, ASCII}; KeyID [0-3]; LinkMode {Auto, Ad-hoc, Infrastructure}. Amcrest example: setConfig&WLan.eth2.Enable=true&WLan.eth2.KeyType=Hex. (https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf)
- **Available access points are scanned with wlan.cgi?action=scanWlanDevices[&SSID=<name>]; the response is 'Found Num:N' followed by wlanDevice[i].SSID, BSSID, AuthMode, EncrAlgr, LinkMode, LinkQuality, RSSIQuality, ApConnected, ApMaxBitRate, ApNetWorkType.** [high] Section 5.6.3 ScanWlanDevices (added in v1.38, 2014) of the Dahua IPC HTTP API and table 4-85 of Amcrest v2.12; ipcamtalk users run it as curl -g --digest -u user:pass "http://<ip>/cgi-bin/wlan.cgi?action=scanWlanDevices" on real Dahua WiFi cameras. (https://ipcamtalk.com/threads/dahua-ipc-hfw2325s-w-cant-find-any-wifi.70459/)
- **netApp.cgi?action=getInterfaces enumerates every network interface as netInterface[n].Name / Type / Valid; documented names are eth0 (wired), eth2 (wireless) and 3G (cellular), with Type Normal, Wireless or a cellular type (Auto, TD-SCDMA, WCDMA, CDMA1x, EDGE, EVDO in the 2014-2017 specs).** [high] Section 5.1.1 GetInterfaces (Dahua IPC v1.40) and 4.7.1 (Amcrest v2.12). The Network table (getConfig&name=Network) then holds table.Network.DefaultInterface plus per-interface IPAddress/SubnetMask/DefaultGateway/DhcpEnable/DnsServers/MTU/PhysicalAddress, and setConfig&Network.DefaultInterface=<name> 'sets default network interface when multiple interfaces exist'. A newer spec version quoted in search results extends the cellular types with TD-LTE, FDD-LTE and NR. (https://wiki.dno-it.ru/wp-content/uploads/2023/06/dahua_http_api_for_ipcsd-v1.40.pdf)
- **No public Dahua/Amcrest CGI specification I could obtain documents a cellular/4G configuration table (no name=3G / Mobile / MobileNet keys, no APN key); only the web-UI field set is documented: 3G Enable, Network type, APN, AUTH (PAP/CHAP), Dial number, User name, Password, Pulse interval, 3G module, plus SMS/Tel activation on IPC3G models.** [low] Searched Dahua IPC HTTP API v1.40, Amcrest v2.12, the Jeedom-hosted IPC API, the reverse-engineered RPC reference (H3xano) and DahuaConsole; DahuaWiki NVR and IPC3G pages describe the UI fields. The Dahua France 4G guide (models DH-IPC-HFW4230MP-4G-AS-I2, DH-SD49425XB-HNR-G, alarm hub) shows APN / Dial code / User / Password per carrier and says the 4G camera then goes online through P2P. (https://dahuawiki.com/NVRiSettingNetwork)
- **Dahua firmware JavaScript exposes RPC2 (JSON-RPC over POST /RPC2) methods netApp.getNetInterfaces, netApp.getMobileRSSI ('gets mobile/cellular signal strength'), mobile.getStatus ('mobile network connection status'), WlanManager.getSTAInfo (SSID/RSSI/connection status) and netApp.connectByWps; parameters for the mobile ones are undocumented.** [medium] H3xano/dahua-rpc-api modules/09-network.md, reverse engineered from rpc.js/rpcBase.js; the README notes system.listMethod returns every RPC method the firmware supports, which is how to confirm availability on a given camera. (https://github.com/H3xano/dahua-rpc-api/blob/main/modules/09-network.md)
- **Event push: GET eventManager.cgi?action=attach&codes=[<code>,<code>...] (or codes=[All]) keeps the HTTP connection open and streams multipart/x-mixed-replace parts whose text/plain body is 'Code=VideoMotion;action=Start;index=0' (action Start/Stop/Pulse; some events add data=<JSON>); an optional heartbeat=<1-60> makes the device send the literal 'Heartbeat' every N seconds, and older specs document [&keepalive=20].** [high, review: confirmed] Section 6.10 Attach (Dahua v1.40), table 4-124 (Amcrest v2.12), the Heartbeat docstring copied from the Dahua spec in rroller/dahua client.py, and the README example curl -s --digest -u admin:$PW 'http://192.168.1.203/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5'. Documented codes include VideoMotion, VideoLoss, VideoBlind, AlarmLocal, MDResult, StorageNotExist, StorageFailure, StorageLowSpace, AlarmOutput, CrossLineDetection, CrossRegionDetection, SmartMotionHuman, FaceDetection, LeftDetection, TakenAwayDetection, AudioMutation. (https://github.com/rroller/dahua)
- **Newer Dahua firmware only answers CGI when System > Security > Authentication Mode is 'Compatible' (not 'Safety'/'Security') and the digest algorithm includes MD5; with MD5 disabled the device answers 500 to API calls.** [high] rroller/dahua README requirements section; the integration authenticates with aiohttp DigestAuth and requires a local device account rather than cloud credentials. (https://github.com/rroller/dahua)
- **CP Plus cameras are 'primarily Dahua OEM products' that use the same /cam/realmonitor RTSP pattern and /cgi-bin/snapshot.cgi, with default port 554, credentials admin/admin and ONVIF on most models; some models use a different /VideoInput/1/mpeg4/1 path.** [medium] VisioForge CP Plus connection guide; it lists UNC (IP cameras), RNP (NVRs), VAC, Guard+, E series and Cosmic lines but does not state which lines are Dahua-based. Secondary source, not a CP Plus statement. (https://www.visioforge.com/help/docs/dotnet/camera-brands/cp-plus/)
- **CP Plus's 4G SIM cameras (CP-V32G bullet, CP-V33G, CP-V33GN, CP-D31G dome, CP-Z32G pan/tilt, EZ-R33G) are the ezyKam+ consumer line: managed by the ezykam+ cloud app (QR-code onboarding, PTZ, two-way talk, web client at ezykam.cppluscloud.com); the CP-V32G/CP-Z32G spec lists 'Onvif Supported', 'RTMP Supported', RJ45 10-100 Mbps, 4G bands FDD LTE B1/B3/B5/B8, TDD LTE B34/B38/B39/B40/B41, WCDMA B1/B5/B8, microSD up to 256 GB; nothing shows Dahua firmware or /cgi-bin/ support.** [low] cpplusworld product pages (cp-v32g, cp-v33g, cp-v33gn, cp-z32g, cp-d31g, ez-r33g) returned 404 to automated fetches; the PosCentral reseller spec sheet and the App Store listing were readable. An App Store reviewer asking for an RTSP/local URL was told to contact support, so local access is at best undocumented. Whether these units answer Dahua CGI must be probed on the real hardware. (https://www.poscentral.in/cp-plus-ezykam-cp-z32g-3mp-4g-pan-tilt-camera.html)
- **go2rtc (MIT) is the standard bridge from Dahua RTSP to a browser: the README uses rtsp://admin:password@192.168.1.123/cam/realmonitor?channel=1&subtype=0 as its example source (optionally &unicast=true&proto=Onvif) and outputs WebRTC, MSE and HLS for Chrome, Firefox, Safari and iPhone Safari.** [high] go2rtc README 'Codecs negotiation' example for a Dahua IPC-K42 and browser support table; Apple devices need HLS or WebRTC, not progressive HTTP. (https://github.com/AlexxIT/go2rtc)
- **Dahua also speaks the same JSON-RPC ('DHIP') over TCP port 5000 with methods magicBox.getSystemInfo, configManager.getConfig/setConfig, ptz.start/stop/getStatus/getPresets/moveAbsolutely, magicBox.reboot and eventManager.attach; a 2026 MIT Python client (python-dhip) was verified against a Zenointel SD-2N-4G PTZ dome.** [medium] OpenIPC/python-dhip README method table; useful as a second transport when a camera's HTTP CGI is disabled but 5000 is open. (https://github.com/OpenIPC/python-dhip)
- **Config.backup?action=All downloads the device's entire configuration as a JSON document (Content-type application/binarytet-stream), which is the practical way to discover undocumented table names such as the cellular one before writing them with setConfig.** [high] Amcrest HTTP API v2.12 table 4-69 'Backup of config' shows the JSON body starting with {"ATM": {...}}; python-amcrest system.py calls the same Config.backup?action=All. (https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf)

## Limits and caveats

- Cellular/4G configuration keys are NOT documented in any public Dahua/Amcrest CGI spec I could obtain (v1.40 IPC, v2.12 Amcrest, Jeedom copy, reverse-engineered RPC list); only the UI field set (Enable, Network type, APN, AUTH PAP/CHAP, Dial number, User name, Password, Pulse interval) is known. Discover the real table on the owner's cameras with Config.backup?action=All (JSON) or RPC2 system.listMethod before implementing writes.
- CGI over the SIM path is identical to LAN, but Indian postpaid 4G SIMs normally sit behind carrier NAT, so the hub cannot open inbound HTTP/RTSP to the camera over 4G without a VPN/tunnel, a public-IP APN, or the vendor's P2P cloud; Dahua's own 4G guide reaches 4G cameras via P2P. Plan the 4G path as 'camera dials out' (VPN client on the camera/router) rather than 'hub dials in'. This was not researched further here.
- Newer Dahua firmware requires System > Security > Authentication Mode = Compatible and the MD5 digest algorithm enabled; in Safety/Security mode with MD5 off, CGI calls return 401/500 (rroller/dahua README).
- Channel numbering is inconsistent: ptz.cgi channel is 0-based, RTSP channel is 1-based, snapshot.cgi channel defaults to 0 in the 2014 IPC spec but is 1-based in the 2017 Amcrest spec. Verify per device and store the working value.
- Every PTZ start must be followed by a stop with the same code/args, or the head keeps moving; implement press-and-hold on the touch UI with a watchdog stop.
- WLan.Encryption enums in the specs (Off/On/WEP64Bits/WEP128Bits/WPA-PSK-TKIP/WPA-PSK-CCMP) predate WPA2; current firmware reports other strings (a forum example uses WPA2-PSK-AES). Always read getConfig&name=WLan and reuse the returned enum family. Writing WLan drops the live WiFi link - send it over Ethernet/4G and then poll for the new address.
- Some firmware rejects a codes=[...] list on eventManager.cgi attach; fall back to codes=[All] and filter locally. The stream is one HTTP connection per camera held open indefinitely; reconnect on missing Heartbeat.
- CP Plus 4G SIM cameras (CP-V32G, CP-V33G, CP-V33GN, CP-Z32G, CP-D31G, EZ-R33G) are the ezyKam+ consumer line, not the Dahua-OEM UNC/UNP professional line; their pages on cpplusworld.com could not be fetched (404 to automation). Spec sheets list ONVIF and RTMP only; treat Dahua-CGI support as unverified and probe magicBox.cgi?action=getDeviceType, then ONVIF.
- The claim that ezykam+ is built on Tuya could not be confirmed; the app is CP Plus's own cloud (ezykam.cppluscloud.com). Do not assume the Tuya API applies.
- Older Dahua firmware returns WiFi passphrases (Keys[0..3]) in plain text over HTTP; put the hub on HTTPS or LAN-only and never log these responses.
- python-amcrest is GPL-2.0 and node-dahua-api is GPL-3.0: use them as behavioural references only unless the hub itself is GPL-compatible. rroller/dahua, python-dhip, H3xano reference, go2rtc, onvif, digest-fetch, @mhoc/axios-digest-auth and urllib are MIT/ISC.
- The Dahua 'Heartbeat: integer, range is [1,60]' and the extended event-code list come from a newer Dahua spec quoted inside rroller/dahua's client.py; the newer spec PDF itself (v2.x/v3.x) is only on Scribd and was not fetched.

## Libraries

- **digest-fetch** (npm, ISC, 3.1.1): HTTP Digest (and Basic) auth wrapper around fetch/node-fetch for every /cgi-bin/ call, including the long-lived eventManager.cgi stream. https://www.npmjs.com/package/digest-fetch
- **@mhoc/axios-digest-auth** (npm, MIT, 0.8.0): Alternative Digest-auth client if the hub standardises on axios. https://www.npmjs.com/package/@mhoc/axios-digest-auth
- **urllib** (npm, MIT, 4.9.0): Full-featured HTTP client with built-in basic and digest authentication and streaming responses; good fit for the multipart event stream. https://www.npmjs.com/package/urllib
- **go2rtc** (binary, MIT, latest release (GitHub)): Ingests rtsp://.../cam/realmonitor?channel=1&subtype=0 and serves WebRTC / MSE / HLS to the browser PWA (iPhone Safari needs HLS or WebRTC); single static binary for Windows and Raspberry Pi. https://github.com/AlexxIT/go2rtc
- **onvif** (npm, MIT, 0.8.3): ONVIF Profile S client (GetStreamUri, GetSnapshotUri, PTZ ContinuousMove/Stop/GotoPreset) - the fallback adapter for CP Plus ezyKam+ 4G cameras and any camera that does not answer Dahua CGI. https://www.npmjs.com/package/onvif
- **rroller/dahua (Home Assistant integration)** (python, MIT, main (active 2026)): Reference implementation of every endpoint above (Digest auth, snapshot, PTZ, presets, reboot, configManager, eventManager attach with heartbeat, RPC2/DHIP fallbacks); port its client.py URL builders to TypeScript. https://github.com/rroller/dahua
- **python-amcrest** (python, GPL-2.0, master): Reference only (GPL): shows netApp.cgi?action=getInterfaces, WLan/Network config reads, magicBox actions, ptz.cgi code/arg table and Content-Length-based event-stream parsing. https://github.com/tchellomello/python-amcrest
- **OpenIPC/python-dhip** (python, MIT, master): Reference for the DHIP JSON-RPC transport on TCP 5000 (ptz.start/stop/getStatus, configManager.getConfig/setConfig, eventManager.attach) if HTTP CGI is disabled on a camera. https://github.com/OpenIPC/python-dhip
- **H3xano/dahua-rpc-api** (python, MIT, docs, main): Reverse-engineered list of 275+ RPC2 methods including netApp.getNetInterfaces, netApp.getMobileRSSI, mobile.getStatus and WlanManager.getSTAInfo - the only lead found for cellular status. https://github.com/H3xano/dahua-rpc-api
- **node-dahua-api** (npm, GPL-3.0, 1.0.2): Existing Node wrapper for Dahua CGI; GPL-3.0 so avoid linking it into the hub - listed so the developer does not adopt it unknowingly. https://www.npmjs.com/package/node-dahua-api

## Could not be verified (treat as uncertain)

- ENDPOINT: WiFi config write — setConfig&WLan.eth2.Enable=true&WLan.eth2.SSID=..&Encryption=..&KeyType=ASCII&Keys[0]=..&KeyID=0&LinkMode=Infrastructure; current firmware also reports strings like WPA2-PSK-AES — Every key and enum is documented (v1.40 5.6.2, Amcrest 4.7.6, V3.35 4.8.7), but the only documented write example is setConfig&WLan.eth2.Enable=true&WLan.eth2.KeyType=Hex. No source shows this full multi-key write joining a WPA2 network, and no source shows a 'WPA2-PSK-AES' value: V3.35 (2023) still lists only {Off, On, WEP64Bits, WEP128Bits, WPA-PSK-TKIP, WPA-PSK-CCMP}. The documented key-length rules are WEP only (ASCII 5/13 chars, Hex 10/26). Must be tested on the real camera.
- ENDPOINT: CP Plus ezyKam+ 4G ONVIF fallback — SOAP POST http://<ip>:80/onvif/device_service, WS-UsernameToken with the camera's admin account — The cited reseller page only says 'Onvif' is supported; it gives no port, path or account. The one user report found says CP Plus app-managed cameras expose ONVIF on port 8000 (not 80), with username admin, after ONVIF is enabled and an IP/password are set in the CP Plus app. Use WS-Discovery (UDP 3702) or probe 80/8000/8899 instead of hardcoding port 80, and expect a separate ONVIF password.
