# lights-tasmota-shelly-tuya

Review: 81 claims confirmed, 9 corrected, 0 could not be verified.

## Summary

All three light/switch families can be driven from a Node.js hub with plain HTTP over the LAN, no vendor SDK required: Tasmota exposes every console command at GET http://<ip>/cm?cmnd=<command> (JSON reply), Shelly Gen1 uses REST paths like /relay/0?turn=on and /settings/sta, and Shelly Gen2/Gen3 uses JSON-RPC at /rpc/<Method> (GET query string or POST body) protected by SHA-256 digest auth. Tuya devices have two paths: the Tuya IoT Platform OpenAPI (India endpoint https://openapi.tuyain.com, HMAC-SHA256 signed requests, GET /v1.0/token?grant_type=1 then POST /v1.0/iot-03/devices/{id}/commands with {"commands":[{"code":"switch_led","value":true}]}) and a LAN protocol on TCP 6668 that needs the device id + local_key + protocol version (3.3/3.4/3.5) and is implemented by tuyapi (Node) or tinytuya (Python, which also ships a REST bridge on port 8888). Local keys are obtained once by linking the owner's Smart Life account to a cloud project (QR scan) and reading local_key from GET /v1.0/iot-03/devices/{id} or via the tinytuya/tuya-cli wizard; the free IoT Core trial expires after a month and must be renewed, and the key changes whenever a device is re-paired. Re-pointing a device to a different WiFi from the app is fully supported on Tasmota (Backlog SSID1/Password1/SSID2/Password2, WifiScan, WifiTest, AP) and Shelly (Gen1 /settings/sta and /settings/sta1 backup; Gen2 WiFi.SetConfig with sta and sta1, WiFi.Scan), but is NOT possible on Tuya devices through any documented API: they must be re-paired in the Smart Life app, which also rotates the local key. Completion notifications are available natively: Tasmota publishes stat/<topic>/POWER and tele/<topic>/LWT over MQTT, Shelly Gen1 has per-relay URL actions (out_on_url) and MQTT, Shelly Gen2 has Webhook.Create, an outbound websocket (Ws.SetConfig) and MQTT NotifyStatus, and Tuya cloud pushes status changes over its Pulsar/WebSocket message service (wss://mqe.tuyain.com:8285/) while local tuyapi/tinytuya emit 'data' events on a persistent socket. Generic MQTT is best done with mqtt.js against a Mosquitto 2.x broker (Windows installer available) or an embedded aedes broker. The main feasibility limit: none of these lights has a SIM, so when the home WiFi is reset they are unreachable by every path (Tuya cloud included) unless a 4G router is configured as the device's second SSID (Tasmota SSID2 / Shelly sta1), which the hub can pre-provision.

## Corrections from review (these override anything below)

- **Claim:** FACT: Tasmota Power / Power<x> (x=1..4) 0|1|2|3; Dimmer, Color, CT 153..500 (+/- 34), HSBColor, Fade
  **Correction:** x is NOT limited to 1..4: the docs give no such limit and tasmota.h defines MAX_RELAYS_SET = 32. There is also value 4 / blinkoff (stop blink). Everything else is as documented: Dimmer 0..100, + / - by DimmerStep (default 10), < to 1, > to 100, ! stops fade; CT 153..500 with +/- 34; HSBColor hue 0..360, sat/bri 0..100; Fade 0 (default) | 1.
  Source: https://tasmota.github.io/docs/Commands/ ; https://raw.githubusercontent.com/arendst/Tasmota/development/tasmota/include/tasmota.h
- **Claim:** FACT: Tasmota WifiScan 1 / WifiScan results JSON; WifiTest<x> tests credentials before committing (v12.0.2.4)
  **Correction:** WifiScan syntax/responses and the v12.0.2.4 / 6 Aug 2022 merge are correct. But the Commands doc states WifiTest is 'Only available in AP mode' (i.e. while the device is in its own Wi-Fi Manager AP), so it cannot be used to pre-test a new network on a device that is already joined to the LAN. Also x = 0..3: 3 = test without storing anything and without restart.
  Source: https://tasmota.github.io/docs/Commands/ ; https://github.com/arendst/Tasmota/pull/16141
- **Claim:** FACT: Tasmota MQTT scheme cmnd/stat/tele, default topic tasmota_%06X, LWT, PowerRetain, SetOption19 1 enables HA MQTT discovery, MqttPassword min 5 chars
  **Correction:** Topic scheme, LWT (tele/<topic>/LWT Online/Offline), empty payload = query (or '?'), retain commands and 'MqttPassword ... (min 5 chars)' are confirmed. SetOption19 is wrong/outdated: 0 (default) = Tasmota discovery protocol used by the HA Tasmota integration; 1 = deprecated MQTT discovery that 'does not exist in release binaries'. Do not send SetOption19 1. Also: MqttHost must not be a .local name; Topic must not equal MqttClient; SetOption4 changes replies from .../RESULT to .../<COMMAND>; retained power messages override PowerOnState.
  Source: https://tasmota.github.io/docs/Commands/ ; https://tasmota.github.io/docs/MQTT/
- **Claim:** FACT: Shelly Gen1 /relay/<i>, /light/<i>, /color/<i>, /white/<i> parameters (brightness 0-100, white 0-100, rgb 0-255, gain, temp)
  **Correction:** Parameter sets are device-specific. RGBW2 /white/{index} takes only turn, timer, brightness 0..100, transition 0..5000 ms - there is NO temp parameter. On /color/{index} (RGBW2, Bulb) 'white' is 0..255 (not 0-100), plus red/green/blue 0..255, gain 0..100, effect, transition. temp exists only on /light/0 of Shelly Duo (2700..6500 K, with white 0..100) and Shelly Bulb in white mode (3000..6500 K). Dimmer 1/2 /light/0 brightness is 1..100 with dim=up|down|stop and step. Shelly1 /relay/0 response has ison, has_timer, timer_started, timer_duration, timer_remaining, overpower (1PM only), source - 'power' is not in the Shelly1 attribute list.
  Source: https://shelly-api-docs.shelly.cloud/gen1/
- **Claim:** FACT: mqtt.js (npm 'mqtt', MIT, Node 18+) connect/subscribe/publish, MQTT 3.1.1 default and 5.0
  **Correction:** Only the Node floor is wrong: package.json (v5.16.0) declares engines.node ">=16.0.0", not 18+. Defaults: protocolVersion 4, keepalive 60 s, clean true, reconnectPeriod 1000 ms, connectTimeout 30 s. Everything else confirmed; async variants connectAsync/publishAsync/subscribeAsync exist.
  Source: https://raw.githubusercontent.com/mqttjs/MQTT.js/main/package.json ; https://raw.githubusercontent.com/mqttjs/MQTT.js/main/README.md
- **Claim:** ENDPOINT: Tasmota test new credentials before committing - /cm?cmnd=WifiTest2%20{ssid}%2B{password}
  **Correction:** WifiTest is documented as 'Only available in AP mode', so this call does not work on a device that is connected to the home LAN. To add a fallback network on a live device use Backlog SSId2 <ssid>; Password2 <pw> (restarts). WifiTest<x> is usable only while the hub is joined to the Tasmota device's own AP (192.168.4.1): 0 = save slot 1 + restart, 1 = slot 1 no restart, 2 = slot 2 no restart, 3 = test only.
  Source: https://tasmota.github.io/docs/Commands/
- **Claim:** ENDPOINT: Shelly Gen1 light/colour - /light/{i}, /color/0, /white/0?turn=on&brightness=80&temp=4000
  **Correction:** /white/{index} has no temp parameter (turn, timer, brightness 0..100, transition 0..5000 ms only). Colour temperature: /light/0?turn=on&brightness=80&temp=4000 on Shelly Duo (2700..6500 K) or Shelly Bulb in white mode (3000..6500 K). On /color/{i} 'white' is 0..255.
  Source: https://shelly-api-docs.shelly.cloud/gen1/
- **Claim:** ENDPOINT: Tuya cloud list linked app account's devices - GET /v1.0/users/{uid}/devices (uid from the token response)
  **Correction:** The endpoint exists (optional page_no/page_size; response includes local_key), but the uid must be the linked app account's uid, which is not what the simple-mode token returns. tinytuya obtains it by GET /v1.0/devices/{any known device_id} and reading result.uid, then calls /v1.0/users/{uid}/devices - which is why the wizard asks for one device id.
  Source: https://developer.tuya.com/en/docs/cloud/device-management?id=K9g6rfntdz78a ; https://raw.githubusercontent.com/jasonacox/tinytuya/master/tinytuya/Cloud.py
- **Claim:** ENDPOINT: Tuya LAN tuyapi control on TCP 6668; UDP discovery 6666 / 6667 / 7000
  **Correction:** API calls are right, but tuyapi's find() listens only on UDP 6666 and 6667 (UDP 7000 is a tinytuya feature), so 3.5 devices may not be found by find() - pass ip and version explicitly. Constructor default version is '3.1' (not auto), key must be 16 chars, default port 6668.
  Source: https://raw.githubusercontent.com/codetheweb/tuyapi/master/index.js

## Added by review (things an implementer needs)

- **Shelly Gen2/3/4 firmware 1.8 breaks plain-HTTP local control** Shelly's network design guide (published July 2026) says firmware 1.8 'enforces HTTPS': port 80 redirects to HTTPS 443, 'WebSocket must use wss:// instead of ws://', each device has a per-device TLS certificate issued by Shelly's private CA (not publicly trusted until the chain is imported), unauthenticated setup is limited to 15 minutes from first power-on/factory reset, Bluetooth auto-disables once provisioned, and failed logins get backoff (10s -> 30s -> 60s -> 5min). Applies to ESP32-based Gen2/Gen3/Gen4. The adapter must read 'ver' from /shelly, try https://{ip}/rpc with a pinned/Shelly-CA trust store when http is redirected, and never hammer auth retries. (https://us.shelly.com/blogs/documentation/network-design-guide-for-shelly-gen2-devices)
- **Tasmota /cm auth and failure behaviour** HandleHttpCommand first tries HTTP Basic auth, then falls back to user=/password= query args (user buffer 33 bytes, username fixed 'admin'). Wrong or missing credentials return HTTP 401 with body {"WARNING":"Need user=<username>&password=<password>"}. An empty/oversized cmnd returns {"WARNING":"Enter command cmnd="}. The reply body is assembled from JSON log lines produced during the command, so a Backlog or a command that restarts the device may return just {} - confirm via a follow-up Status or MQTT, not the HTTP body. (https://raw.githubusercontent.com/arendst/Tasmota/development/tasmota/tasmota_xdrv_driver/xdrv_01_9_webserver.ino)
- **Tasmota HTTP API referer check (SetOption128)** SetOption128 'Web referrer check for HTTP API commands' exists (docs: 1 = enabled, default). In source, when the referer check is active a request is accepted only if its Referer header starts with http://<device hostname or IP>; otherwise it logs "Referer denied. Use 'SO128 1' for HTTP API commands". If hub calls to /cm are rejected, send 'Referer: http://{ip}/' or set SetOption128 1, and set a WebPassword. (https://tasmota.github.io/docs/Commands/ ; https://raw.githubusercontent.com/arendst/Tasmota/development/tasmota/tasmota_xdrv_driver/xdrv_01_9_webserver.ino)
- **Tasmota WiFi re-pointing constraints** SSId max 32 chars, Password max 64 chars, and docs say 'Do not use special characters or white spaces' in either; Password and Password1 are equivalent. WifiTest is AP-mode only. Safe re-point pattern on a live device: write the new network to slot 2 (Backlog SSId2 x; Password2 y), let it restart, keep slot 1 as the old network; WifiConfig 4 (default) then retries the other AP without rebooting. Wi-Fi Manager AP (WifiConfig 2) serves at 192.168.4.1 for 3 minutes. (https://tasmota.github.io/docs/Commands/)
- **Tasmota discovery/retain gotchas** SetOption19 0 (default) is the current Tasmota discovery protocol; 1 is a deprecated mode absent from release binaries. Retained power messages override PowerOnState (a retained cmnd/.../POWER will re-fire on reconnect) - never publish commands with retain. Every device also listens on GroupTopic 'tasmotas' and a fallback topic DVES_XXXXXX_fb. (https://tasmota.github.io/docs/MQTT/ ; https://tasmota.github.io/docs/Commands/)
- **Shelly Gen2 nonce/throttle limits the hub must respect** Firmware 2.0.0+: device keeps a circular buffer of 32 nonces; when full it returns HTTP 429 for a 2-second window. Failed-auth tracking uses a 10-minute sliding window: 11-20 failures = 10 s between attempts, 21-30 = 30 s, 31-40 = 60 s, 40+ = 5 min, returned as 429 (not 401). nc must strictly increase per nonce; reuse a nonce up to 30,000 requests / 1 hour; on 401 with stale=true just take the new nonce. Pre-2.0.0 firmware: numeric nonce, nc not tracked, full 401 round-trip per request. curl equivalent: curl --anyauth -u admin:<pw>. (https://shelly-api-docs.shelly.cloud/gen2/General/Authentication)
- **Shelly Gen2 channels that are NOT protected by auth** When auth is enabled everything is protected except MQTT, UART, outbound websocket, Shelly.GetDeviceInfo and /shelly. WiFi.ListAPClients also needs no auth. So the broker and the hub's outbound-websocket endpoint must be secured separately. (https://shelly-api-docs.shelly.cloud/gen2/General/Authentication ; https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/WiFi)
- **Shelly Gen2 WiFi events and re-point side effects** After WiFi.SetConfig the device reconnects about 1 s later and inbound websocket / MQTT sessions drop. NotifyEvent frames with component 'wifi' report sta_connect_fail (reason code), sta_disconnected, sta_connecting, sta_connected, sta_ip_acquired (with sta_ip, ssid, rssi) - use these (via MQTT events/rpc or outbound WS) to confirm a WiFi move. Shelly.ResetWiFiConfig resets WiFi config. AP config supports range_extender.enable. pass must always accompany ssid and is never returned by GetConfig. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/WiFi ; https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Shelly)
- **Shelly Gen2 MQTT defaults** MQTT is disabled by default (enable false); status_ntf defaults false so <prefix>/status/<component:id> is silent unless enabled; rpc_ntf true; QoS 1 is the supported level; a reboot is required after MQTT.SetConfig; <prefix>/command/switch:<id> accepts on[,<s>] | off[,<s>] | toggle | status_update; <prefix>/command accepts status_update | announce; shellies/command is a broadcast topic. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt ; https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch)
- **Shelly Gen1 request semantics** 'The HTTP method used for performing any of the requests is intentionally ignored' - GET with query string or POST application/x-www-form-urlencoded both work; booleans accept 1/y/t/true. Enabling MQTT disables the Shelly cloud on Gen1 (so the vendor app stops working remotely) and requires a reboot. CoIoT (CoAP, default port 5683, coiot_peer mcast or ip[:port], update period 15..65535 s) is the Gen1 push channel that does not disable cloud. (https://shelly-api-docs.shelly.cloud/gen1/)
- **Mosquitto 2.x refuses LAN clients by default** Without a configured listener Mosquitto 2.x binds only to 127.0.0.1/::1, and allow_anonymous defaults to false once a listener is defined. For Tasmota/Shelly devices to connect, mosquitto.conf needs 'listener 1883' plus a password_file (or an explicit allow_anonymous true) and a Windows firewall rule for TCP 1883. (https://mosquitto.org/documentation/migrating-to-2-0/)
- **Tuya app-account uid and tinytuya's actual cloud calls** tinytuya Cloud: hosts cn/us/us-e/eu/eu-w/in/sg as in Tuya docs; token via GET /v1.0/token?grant_type=1 (re-requested on 'token invalid', no refresh_token use); uid via GET /v1.0/devices/{device_id} -> result.uid; device list GET /v1.0/users/{uid}/devices; status /v1.0/iot-03/devices/{id}/status; functions /v1.0/iot-03/devices/{id}/functions; spec /v1.0/iot-03/devices/{id}/specification; DP-id mapping GET /v1.1/devices/{id}/specifications; commands POST /v1.0/iot-03/devices/{id}/commands; logs /v1.0/devices/{id}/logs. Tuya's current IoT Core index also offers GET /v2.0/cloud/thing/{device_id} and shadow/properties endpoints. (https://raw.githubusercontent.com/jasonacox/tinytuya/master/tinytuya/Cloud.py ; https://developer.tuya.com/en/docs/cloud/device-connection-service?id=Kb0b8geg6o761)
- **Tuya linking and local-control limits** Each Smart Life app account can be linked to at most two cloud projects. Battery-powered Tuya devices cannot be controlled locally. Some 22-character-ID devices need dev_type 'device22'. tuyapi requires a 16-character key and defaults to protocol 3.1 unless version is passed; LAN firewall must allow UDP 6666/6667/7000 and TCP 6668. (https://developer.tuya.com/en/docs/iot/link-devices?id=Ka471nu1sfmkl ; https://raw.githubusercontent.com/jasonacox/tinytuya/master/README.md ; https://raw.githubusercontent.com/codetheweb/tuyapi/master/index.js)
- **SIM-fallback path is not covered by any of these local APIs** None of the verified Tasmota, Shelly or Tuya-LAN endpoints work when the device is not on the hub's LAN: Tasmota and Shelly Gen1/Gen2 reach the hub only if they can route to the broker/webhook host (devices dial out for MQTT, Shelly outbound websocket and webhooks), and Tuya works off-LAN only via the cloud OpenAPI/Pulsar endpoints. No primary source was found describing a per-device 4G path for these light modules; design the off-LAN route as device-dials-out (MQTT/outbound WS to a reachable hub address) or Tuya cloud. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Ws ; https://tasmota.github.io/docs/MQTT/ ; https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4)

## Calls

### Tasmota: run any command over HTTP

```
http GET http://{ip}/cm?cmnd={urlencoded command}
```
- Params: cmnd = command text with spaces as %20 and ';' as %3B; optional user=admin&password={WebPassword} when a web password is set
- Auth: Plaintext user/password query parameters (username admin); none if WebPassword 0
- Response: JSON, e.g. {"POWER":"ON"}
- Notes: Base for every Tasmota call below. Keep LAN-only; credentials travel in the URL.
- Source: https://tasmota.github.io/docs/Commands/

### Tasmota: relay on/off/toggle

```
http GET http://{ip}/cm?cmnd=Power{n}%20{ON|OFF|TOGGLE}
```
- Params: n omitted or 1..4 for multi-channel; values 0|off|false, 1|on|true, 2|toggle, 3|blink
- Auth: user/password params if set
- Response: {"POWER":"ON"} or {"POWER1":"OFF"}
- Notes: Empty value (cmnd=Power) queries state.
- Source: https://tasmota.github.io/docs/Commands/

### Tasmota: dimmer / colour / colour temperature

```
http GET http://{ip}/cm?cmnd=Dimmer%2050  |  cmnd=Color%20%23FF8800  |  cmnd=CT%20300  |  cmnd=HSBColor%20120,100,50
```
- Params: Dimmer 0..100 (+/-/</>); Color #RRGGBB or r,g,b or preset 1-12; CT 153..500; HSBColor hue,sat,bri; Fade 0|1
- Auth: user/password params if set
- Response: JSON with current light state (e.g. {"POWER":"ON","Dimmer":50,"Color":"...","HSBColor":"...","CT":300}) — exact keys depend on light type
- Source: https://tasmota.github.io/docs/Commands/

### Tasmota: status (all / network / state)

```
http GET http://{ip}/cm?cmnd=Status%200  |  Status%205  |  Status%2011
```
- Params: 0 = everything; 5 = StatusNET (Hostname, IPAddress, Gateway, Subnetmask, DNSServer, Mac, Webserver, WifiConfig); 11 = StatusSTS (Time, Uptime, POWER, Wifi{AP,SSId,RSSI,...})
- Auth: user/password params if set
- Response: {"StatusNET":{...}} / {"StatusSTS":{...}} / combined object for Status 0
- Source: https://tasmota.github.io/docs/JSON-Status-Responses/

### Tasmota: set both WiFi slots and restart in one call

```
http GET http://{ip}/cm?cmnd=Backlog%20SSID1%20{ssid1}%3B%20Password1%20{pw1}%3B%20SSID2%20{ssid2}%3B%20Password2%20{pw2}%3B%20Restart%201
```
- Params: Backlog joins up to 30 commands with ';' — required because each of SSID<x>/Password<x> restarts the device on its own
- Auth: user/password params if set
- Response: {"Backlog":"..."}-style acks then device restarts; poll Status 5 on the new network
- Notes: SSID<x> value 0 clears the slot, 1 restores firmware default. Device then falls back between slot 1 and 2 per WifiConfig 4 (default).
- Source: https://tasmota.github.io/docs/Commands/

### Tasmota: test new credentials before committing (slot 2, no restart)

```
http GET http://{ip}/cm?cmnd=WifiTest2%20{ssid}%2B{password}
```
- Params: WifiTest0 = test, save slot 1, restart; WifiTest/WifiTest1 = save slot 1 no restart; WifiTest2 = save slot 2 no restart; SSID and password joined with '+'
- Auth: user/password params if set
- Response: {"WifiTest":"Testing"} then later {"WifiTest":"Successful"} or "Connect failed" / "no IP address received" / "AP cannot be reached" / "AP timeout"; poll with cmnd=WifiTest
- Notes: Requires Tasmota >= 12.0.2.4.
- Source: https://github.com/arendst/Tasmota/pull/16141

### Tasmota: scan for WiFi networks

```
http GET http://{ip}/cm?cmnd=WifiScan%201  then  http://{ip}/cm?cmnd=WifiScan
```
- Params: WifiScan 1 starts; WifiScan reads results (valid ~1 minute)
- Auth: user/password params if set
- Response: {"WifiScan":"Scanning"} | {"WifiScan":"Busy"} | {"WifiScan":"Not Started"} | {"WiFiScan":{"NET1":{"SSId":"..","BSSId":"..","Channel":"1","Signal":"-31","RSSI":"100","Encryption":"WPA2/PSK"},"NET2":{...}}}
- Source: https://github.com/arendst/Tasmota/pull/16141

### Tasmota: switch to the other saved AP / choose AP

```
http GET http://{ip}/cm?cmnd=AP%20{0|1|2}
```
- Params: 0 = switch to the other AP, 1 = use AP1 (SSID1), 2 = use AP2 (SSID2)
- Auth: user/password params if set
- Response: {"AP":n} then reconnect
- Source: https://tasmota.github.io/docs/Commands/

### Tasmota: WiFi fallback behaviour

```
http GET http://{ip}/cm?cmnd=WifiConfig%20{0|2|4|5|6|7}
```
- Params: 4 = retry other AP without rebooting (default); 5 = wait for selected AP; 2 = start Wi-Fi Manager captive portal; 0 = disable Wi-Fi Manager and reboot; 7 = Wi-Fi Manager restricted to reset. Also SetOption56 1 (pick strongest on restart), SetOption57 1 (periodic rescan)
- Auth: user/password params if set
- Response: {"WifiConfig":n}
- Source: https://tasmota.github.io/docs/Commands/

### Tasmota: configure MQTT broker in one call

```
http GET http://{ip}/cm?cmnd=Backlog%20MqttHost%20{hubip}%3B%20MqttPort%201883%3B%20MqttUser%20{user}%3B%20MqttPassword%20{pw}%3B%20Topic%20{name}%3B%20SetOption3%201%3B%20PowerRetain%201
```
- Params: MqttPassword min 5 chars; Topic default tasmota_%06X; SetOption3 1 enables MQTT; SetOption19 1 adds Home Assistant discovery if wanted
- Auth: user/password params if set
- Response: acks then restart
- Source: https://tasmota.github.io/docs/Commands/

### Tasmota: MQTT command

```
mqtt PUBLISH cmnd/{topic}/POWER  payload ON|OFF|TOGGLE   (multi-channel: cmnd/{topic}/POWER1 ... POWER4; any command: cmnd/{topic}/Backlog payload "SSID2 x; Password2 y")
```
- Params: empty payload = query state
- Auth: broker credentials
- Response: stat/{topic}/RESULT {"POWER":"ON"} and stat/{topic}/POWER ON
- Source: https://tasmota.github.io/docs/MQTT/

### Tasmota: MQTT state / availability subscriptions (completion notifications)

```
mqtt SUBSCRIBE stat/{topic}/POWER, stat/{topic}/RESULT, tele/{topic}/STATE, tele/{topic}/SENSOR, tele/{topic}/LWT
```
- Params: LWT payload Online / Offline (retained by broker); STATE every TelePeriod
- Auth: broker credentials
- Response: POWER: ON|OFF; RESULT/STATE: JSON
- Notes: Set PowerRetain 1 so the last state is retained for the phone app on reconnect.
- Source: https://tasmota.github.io/docs/MQTT/

### Shelly Gen1: identify device (no auth)

```
http GET http://{ip}/shelly
```
- Auth: none
- Response: {"type":"SHSW-21","mac":"5ECF7F1632E8","auth":true,"fw":"...","longid":1,"discoverable":true}
- Notes: Use to detect Gen1 vs Gen2 (Gen2 answers /shelly too but with gen field; prefer /rpc/Shelly.GetDeviceInfo for Gen2).
- Source: https://shelly-api-docs.shelly.cloud/gen1/

### Shelly Gen1: relay control

```
http GET http://{ip}/relay/{i}?turn={on|off|toggle}[&timer={seconds}]
```
- Auth: HTTP Basic if enabled via /settings/login
- Response: {"ison":true,"has_timer":false,"timer_started":0,"timer_duration":0,"timer_remaining":0,"power":0,"overpower":false,"source":"http"}
- Source: https://shelly-api-docs.shelly.cloud/gen1/

### Shelly Gen1: light / colour control

```
http GET http://{ip}/light/{i}?turn=on&brightness=50  |  http://{ip}/color/0?turn=on&red=255&green=0&blue=0&gain=100  |  http://{ip}/white/0?turn=on&brightness=80&temp=4000
```
- Params: turn on|off|toggle; brightness 0-100; white 0-100; red/green/blue 0-255; gain 0-100; temp = colour temperature; timer seconds
- Auth: HTTP Basic if enabled
- Response: JSON light status (ison, brightness, ...)
- Source: https://shelly-api-docs.shelly.cloud/gen1/

### Shelly Gen1: device status and settings

```
http GET http://{ip}/status   and   http://{ip}/settings
```
- Auth: HTTP Basic if enabled
- Response: /status: wifi_sta{connected,ssid,ip,rssi}, cloud, mqtt.connected, time, update, ram_*, fs_*, uptime, relays[]/lights[]; /settings: device, wifi_ap, wifi_sta, wifi_sta1, mqtt, coiot, login, cloud, sntp...
- Source: https://shelly-api-docs.shelly.cloud/gen1/

### Shelly Gen1: set primary WiFi

```
http GET http://{ip}/settings/sta?enabled=1&ssid={ssid}&key={password}&ipv4_method=dhcp
```
- Params: enabled bool, ssid, key, ipv4_method dhcp|static, ip, netmask, gateway, dns
- Auth: HTTP Basic if enabled
- Response: echo of sta settings (key not returned)
- Notes: Device reconnects to the new network; hub must re-discover it there.
- Source: https://shelly-api-docs.shelly.cloud/gen1/

### Shelly Gen1: set backup WiFi (fallback network, e.g. 4G router)

```
http GET http://{ip}/settings/sta1?enabled=1&ssid={ssid2}&key={password2}&ipv4_method=dhcp
```
- Params: same as /settings/sta
- Auth: HTTP Basic if enabled
- Response: echo of sta1 settings
- Source: https://shelly-api-docs.shelly.cloud/gen1/

### Shelly Gen1: AP roaming and reboot

```
http GET http://{ip}/settings?ap_roaming_enabled=true&ap_roaming_threshold=-70   |   http://{ip}/reboot
```
- Auth: HTTP Basic if enabled
- Response: settings JSON / {}
- Source: https://shelly-api-docs.shelly.cloud/gen1/

### Shelly Gen1: enable HTTP auth

```
http GET http://{ip}/settings/login?enabled=1&username={user}&password={pw}
```
- Params: enabled bool, username 1-50 chars, password 1-50 chars, unprotected bool
- Auth: HTTP Basic (current creds) if already enabled
- Response: {"enabled":true,"unprotected":false,"username":"..."}
- Source: https://shelly-api-docs.shelly.cloud/gen1/

### Shelly Gen1: URL action callback to hub on relay change (notification)

```
http GET http://{ip}/settings/actions?index=0&name=out_on_url&enabled=true&urls[]=http://{hub}:{port}/hook/shelly/{deviceId}/on   (and name=out_off_url ... /off)
```
- Params: index = channel; name out_on_url|out_off_url|btn_on_url|btn_off_url; up to 5 URLs of 256 chars
- Auth: HTTP Basic if enabled
- Response: actions JSON
- Source: https://shelly-api-docs.shelly.cloud/gen1/

### Shelly Gen1: MQTT command and state

```
mqtt PUBLISH/SUBSCRIBE shellies/{model}-{deviceid}/relay/0/command payload on|off|toggle ; subscribe shellies/{model}-{deviceid}/relay/0 (on|off|overpower), shellies/{model}-{deviceid}/online, shellies/announce
```
- Auth: broker credentials (set via /settings/mqtt? or /settings?mqtt_server=...)
- Response: state topics as above
- Source: https://shelly-api-docs.shelly.cloud/gen1/

### Shelly Gen2/3: identify device (no auth)

```
http GET http://{ip}/rpc/Shelly.GetDeviceInfo
```
- Auth: none
- Response: {"id":"shellypro4pm-f008d1d8b8b8","mac":"F008D1D8B8B8","model":"SPSW-004PE16EU","gen":2,"fw_id":"...","ver":"0.6.7","app":"FourPro","auth_en":true,"auth_domain":"shellypro4pm-f008d1d8b8b8"}
- Notes: auth_domain is the digest realm.
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Shelly

### Shelly Gen2/3: switch on/off (GET form)

```
http GET http://{ip}/rpc/Switch.Set?id={0..n}&on={true|false}[&toggle_after={s}]
```
- Auth: HTTP digest SHA-256, user admin, realm = device id (only when auth_en)
- Response: {"was_on":false}
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch

### Shelly Gen2/3: switch on/off (POST forms)

```
http POST http://{ip}/rpc/Switch.Set  body {"id":0,"on":true}    or    http://{ip}/rpc  body {"id":1,"src":"housecontrol","method":"Switch.Set","params":{"id":0,"on":true}}
```
- Auth: HTTP digest, or auth object inside the JSON frame
- Response: /rpc/<Method>: {"was_on":false}; /rpc: {"id":1,"src":"<device id>","dst":"housecontrol","result":{"was_on":false}} or {"error":{"code":-105,"message":"..."}}
- Source: https://shelly-api-docs.shelly.cloud/gen2/General/RPCChannels

### Shelly Gen2/3: toggle and read switch

```
http GET http://{ip}/rpc/Switch.Toggle?id=0   |   http://{ip}/rpc/Switch.GetStatus?id=0
```
- Auth: HTTP digest if enabled
- Response: Toggle: {"was_on":bool}; GetStatus: {"id":0,"source":"http","output":true,"apower":..,"voltage":..,"current":..,"aenergy":{"total":..},"temperature":{"tC":..,"tF":..}}
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch

### Shelly Gen2/3: dimmer

```
http GET http://{ip}/rpc/Light.Set?id=0&on=true&brightness=60&transition_duration=1   |   http://{ip}/rpc/Light.Toggle?id=0   |   http://{ip}/rpc/Light.GetStatus?id=0
```
- Params: on bool, brightness 0-100, transition_duration s, toggle_after s, offset -100..100; at least one of on/brightness
- Auth: HTTP digest if enabled
- Response: Set: {} ; GetStatus: {"id":0,"source":"..","output":true,"brightness":60,"temperature":{..}}
- Notes: Colour products use RGB.Set / RGBW.Set / CCT.Set namespaces.
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Light

### Shelly Gen2/3: full status / config / method list

```
http GET http://{ip}/rpc/Shelly.GetStatus   |   /rpc/Shelly.GetConfig   |   /rpc/Shelly.ListMethods   |   /rpc/Shelly.GetComponents?include=["status"]
```
- Auth: HTTP digest if enabled
- Response: objects keyed by component:id, e.g. {"switch:0":{...},"wifi":{...},"sys":{...}}
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Shelly

### Shelly Gen2/3: WiFi status and scan

```
http GET http://{ip}/rpc/WiFi.GetStatus   |   http://{ip}/rpc/WiFi.Scan   |   http://{ip}/rpc/WiFi.GetConfig
```
- Auth: HTTP digest if enabled
- Response: GetStatus: {"sta_ip":"192.168.206.97","status":"got ip","ssid":"...","rssi":-56}; Scan: {"results":[{"ssid":"..","bssid":"..","auth":3,"channel":6,"rssi":-60}]}; GetConfig: {"ap":{..},"sta":{"ssid":..,"enable":..,"ipv4mode":..},"sta1":{..},"roam":{"rssi_thr":-80,"interval":60}} (pass never returned)
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/WiFi

### Shelly Gen2/3: set primary and backup WiFi

```
http GET http://{ip}/rpc/WiFi.SetConfig?config={"sta":{"ssid":"{ssid}","pass":"{pw}","enable":true,"ipv4mode":"dhcp"},"sta1":{"ssid":"{ssid2}","pass":"{pw2}","enable":true}}   (URL-encode the JSON; or POST /rpc/WiFi.SetConfig body {"config":{...}})
```
- Params: sta/sta1: enable, ssid, pass (write-only, required with ssid), ipv4mode dhcp|static, ip, netmask, gw, nameserver; roam.rssi_thr, roam.interval
- Auth: HTTP digest if enabled
- Response: {"restart_required":false}
- Notes: Device reconnects ~1 s after a station change and drops MQTT/websocket sessions; hub must re-discover it on the new network.
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/WiFi

### Shelly Gen2/3: first-time provisioning over the device AP

```
http GET http://192.168.33.1/rpc/WiFi.SetConfig?config={"sta":{"ssid":"{home ssid}","pass":"{pw}","enable":true}}
```
- Params: phone/hub joins the open AP named after the model+MAC first
- Auth: none (factory)
- Response: {"restart_required":false}
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/WiFi

### Shelly Gen2/3: set admin password

```
http POST http://{ip}/rpc  body {"id":1,"method":"Shelly.SetAuth","params":{"user":"admin","realm":"{device id}","ha1":"{sha256hex('admin:'+deviceId+':'+password)}"}}
```
- Auth: current digest creds if already set
- Response: null / {}
- Notes: Clear auth by sending ha1 null (per docs' SetAuth description).
- Source: https://shelly-api-docs.shelly.cloud/gen2/General/Authentication

### Shelly Gen2/3: HTTP digest handshake (hub implementation)

```
http GET First request -> 401 with WWW-Authenticate: Digest realm="{device id}", nonce="..", algorithm=SHA-256, qop="auth"; retry with Authorization: Digest username="admin", realm, nonce, uri, cnonce, nc=00000001, qop=auth, algorithm=SHA-256, response=SHA256(HA1:nonce:nc:cnonce:auth:HA2)
```
- Params: HA1 = SHA256(admin:realm:password); HA2 = SHA256(METHOD:uri) for HTTP; for JSON-RPC frames HA2 = SHA256("dummy_method:dummy_uri") and the auth object is embedded in the frame
- Auth: digest
- Response: normal RPC result
- Notes: Node built-in crypto is sufficient; nonces reusable up to 30,000 times within 1 hour on fw 2.0.0+.
- Source: https://shelly-api-docs.shelly.cloud/gen2/General/Authentication

### Shelly Gen2/3: webhook to hub on switch events (notification)

```
http GET http://{ip}/rpc/Webhook.Create?cid=0&enable=true&event="switch.on"&name="hub-on"&urls=["http://{hub}:{port}/hook/shelly/{deviceId}?output=${ev.output}"]   (repeat with event="switch.off")
```
- Params: event, cid, urls[] (max 5 x 300 chars), enable, name, condition, repeat_period, active_between; max 20 hooks per device
- Auth: HTTP digest if enabled
- Response: {"id":1,"rev":3}
- Notes: Webhook.List / Webhook.Update / Webhook.Delete / Webhook.ListSupported for management.
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Webhook

### Shelly Gen2/3: outbound websocket to the hub (push status)

```
http GET http://{ip}/rpc/Ws.SetConfig?config={"enable":true,"server":"ws://{hub}:{port}/shelly"}   then   http://{ip}/rpc/Shelly.Reboot
```
- Params: server ws:// or wss:// (ssl_ca "*" to skip validation)
- Auth: HTTP digest if enabled
- Response: {"restart_required":true}; after reboot the device connects to the hub and sends NotifyFullStatus then NotifyStatus/NotifyEvent frames
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Ws

### Shelly Gen2/3: device-hosted websocket

```
http WS ws://{ip}/rpc  — send {"id":1,"src":"housecontrol","method":"Shelly.GetStatus"} then receive responses and NotifyStatus frames
```
- Auth: auth object in frame when auth_en
- Response: JSON-RPC frames
- Notes: Must send at least one request with a valid src to receive notifications.
- Source: https://shelly-api-docs.shelly.cloud/gen2/General/RPCChannels

### Shelly Gen2/3: enable MQTT

```
http GET http://{ip}/rpc/MQTT.SetConfig?config={"enable":true,"server":"{hubip}:1883","user":"{u}","pass":"{p}","rpc_ntf":true,"status_ntf":true,"enable_control":true}   then   /rpc/Shelly.Reboot
```
- Params: client_id and topic_prefix default to device id; ssl_ca for TLS
- Auth: HTTP digest if enabled
- Response: {"restart_required":true}
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt

### Shelly Gen2/3: MQTT control and notifications

```
mqtt PUBLISH/SUBSCRIBE publish {deviceid}/command/switch:0 payload on|off|toggle ; or publish {deviceid}/rpc {"id":1,"src":"housecontrol","method":"Switch.Set","params":{"id":0,"on":true}} and subscribe housecontrol/rpc ; subscribe {deviceid}/online (true|false), {deviceid}/events/rpc (NotifyStatus/NotifyEvent), {deviceid}/status/switch:0 ; publish {deviceid}/command payload status_update
```
- Auth: broker credentials
- Response: as listed
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt

### Shelly discovery via mDNS — confirmed

```
http mDNS browse _shelly._tcp.local (Gen2/3) and _http._tcp.local (Gen1 + Gen2/3); TXT gen=2|3, app, ver; hostname e.g. Shelly2PMG4-7C2C67640B38.local, port 80
```
- Auth: none
- Response: instance name, host, addresses, txt
- Notes: Tasmota devices are found by mDNS _http._tcp only if SetOption55 1 and compiled with mDNS; otherwise probe http://{ip}/cm?cmnd=Status%200 across the subnet.
- Source: https://shelly-api-docs.shelly.cloud/gen2/General/mDNS/

### Tuya cloud: get token

```
https GET https://openapi.tuyain.com/v1.0/token?grant_type=1
```
- Params: headers: client_id, sign, sign_method=HMAC-SHA256, t (ms), nonce (uuid). sign = HMAC-SHA256(client_id + t + nonce + "GET\n" + e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 + "\n" + "\n" + "/v1.0/token?grant_type=1", secret).toUpperCase()
- Auth: Access ID / Access Secret of the IoT Platform cloud project
- Response: {"result":{"access_token":"..","expire_time":7200,"refresh_token":"..","uid":".."},"success":true,"t":...}
- Source: https://developer.tuya.com/en/docs/cloud/6c1636a9bd?id=Ka7kjumkoa53v

### Tuya cloud: refresh token

```
https GET https://openapi.tuyain.com/v1.0/token/{refresh_token}
```
- Params: same headers as token request (no access_token in signature)
- Auth: client_id/secret signature
- Response: {"result":{"access_token","expire_time","refresh_token","uid"}}
- Notes: refresh_token is single-use; store the new one.
- Source: https://developer.tuya.com/en/docs/cloud/80bb968f1d?id=Ka7kjv3j8jgvr

### Tuya cloud: device details incl. local_key

```
https GET https://openapi.tuyain.com/v1.0/iot-03/devices/{device_id}
```
- Params: headers: client_id, access_token, sign, sign_method, t, nonce; sign string includes access_token after client_id
- Auth: signed + access_token
- Response: {"result":{"id","uuid","category","name","product_id","product_name","local_key","sub","asset_id","ip","lon","lat","model","time_zone","active_time","update_time","create_time","online"}}
- Notes: This is how the hub harvests local keys for LAN control after the Smart Life account is linked.
- Source: https://developer.tuya.com/en/docs/cloud/d00d20c097?id=Kag2xtiyewd3r

### Tuya cloud: list the linked app account's devices

```
https GET https://openapi.tuyain.com/v1.0/users/{uid}/devices?page_no=1&page_size=100
```
- Params: uid from the token response or the linked app account
- Auth: signed + access_token
- Response: result: array of devices (id, name, local_key, category, product_id, online, status[...])
- Source: https://developer.tuya.com/en/docs/cloud/device-management?id=K9g6rfntdz78a

### Tuya cloud: read device status

```
https GET https://openapi.tuyain.com/v1.0/iot-03/devices/{device_id}/status
```
- Auth: signed + access_token
- Response: {"result":[{"code":"switch_led","value":true},{"code":"work_mode","value":"scene_2"}],"t":1591872112140,"success":true}
- Source: https://developer.tuya.com/en/docs/cloud/1ef1a3044b?id=Kconf2usgnfwo

### Tuya cloud: send command (light / switch)

```
https POST https://openapi.tuyain.com/v1.0/iot-03/devices/{device_id}/commands
```
- Params: Content-Type: application/json; body {"commands":[{"code":"switch_led","value":true}]}  |  {"commands":[{"code":"bright_value_v2","value":500}]}  |  {"commands":[{"code":"colour_data_v2","value":{"h":201,"s":511,"v":899}}]}  |  switches: {"commands":[{"code":"switch_1","value":true}]}; Content-SHA256 in the signature is the hex SHA-256 of the exact body bytes
- Auth: signed + access_token
- Response: {"result":true,"t":1551851043862,"success":true}
- Source: https://developer.tuya.com/en/docs/cloud/e2512fb901?id=Kag2yag3tiqn5

### Tuya cloud: discover a device's supported DP codes

```
https GET https://openapi.tuyain.com/v1.0/iot-03/devices/{device_id}/specification   |   /v1.0/iot-03/devices/{device_id}/functions   |   /v1.0/iot-03/devices/status?device_ids={id1},{id2}
```
- Auth: signed + access_token
- Response: specification: {category, functions:[{code,type,values}], status:[...]}; functions: list of {code,type,values}
- Notes: Batch status query parameter name (device_ids) not verified on this run — check the 'Get latest status of multiple devices' page in the IoT Core index.
- Source: https://developer.tuya.com/en/docs/cloud/device-connection-service?id=Kb0b8geg6o761

### Tuya cloud: push notifications (Message Service / Pulsar over WebSocket)

```
cloud WSS wss://mqe.tuyain.com:8285/  (env PROD, accessId = Access ID, accessKey = Access Secret) via Tuya's Node Pulsar SDK: client.open(); client.message(cb); client.ackMessage(id)
```
- Auth: Access ID / Secret
- Response: decrypted messages with bizCode e.g. statusReport, data {devId, status:[{code,value,t}]}
- Notes: Message Service must be enabled in the cloud project; SDK is a download from the docs page, not an npm package.
- Source: https://developer.tuya.com/en/docs/iot/Pulsar-SDK-get-message-nodejs?id=Kawfmtxp8yscg

### Tuya LAN: tuyapi (Node) control

```
serial TCP 6668 const d = new TuyAPI({id:'{device_id}', key:'{local_key}', ip:'{ip}', version:'3.3'}); await d.find(); await d.connect(); await d.set({dps:1, set:true}); await d.set({multiple:true, data:{'20':true,'22':500}}); const s = await d.get({schema:true}); d.on('data', ...); d.disconnect()
```
- Params: version '3.1'|'3.3'|'3.4'|'3.5' per device (find() auto-detects on the LAN); UDP broadcast discovery 6666 (3.1 plaintext) / 6667 (encrypted) / 7000 (3.5)
- Auth: local_key (AES)
- Response: {"dps":{"1":true,"9":0}} style objects; 'data' events on change
- Notes: Exactly one TCP client per device: keep one persistent connection in the hub and close the Smart Life app. Bulb type B DPS: 20 switch_led, 21 work_mode, 22 bright_value_v2 (10-1000), 23 temp_value_v2 (0-1000), 24 colour_data_v2; switches DPS 1..6.
- Source: https://github.com/codetheweb/tuyapi

### Tuya LAN: tinytuya REST bridge (alternative to speaking the protocol in Node)

```
http GET http://127.0.0.1:8888/devices | /status/{id} | /turnon/{id}[/{switchNo}] | /turnoff/{id}[/{switchNo}] | /set/{id}/{dpsKey}/{dpsValue} | /delayedoff/{id}/{switchNo}/{seconds} | /sync | /cloudconfig/{apiKey}/{apiSecret}/{apiRegion}/{apiDeviceID} | /offline
```
- Params: run python3 server.py in the folder holding devices.json (from python -m tinytuya wizard)
- Auth: none (bind to localhost)
- Response: JSON status / DPS objects
- Source: https://github.com/jasonacox/tinytuya/tree/master/server

### Tuya: obtain local keys (one-time owner step)

```
cloud wizard npm i -g @tuyapi/cli && tuya-cli wizard   (or: pip install tinytuya && python -m tinytuya wizard)  -> asks for Access ID, Access Secret, region 'in', a device id; writes devices.json {name,id,key,mac,uuid,category,product_name,ip,version}
```
- Params: Prerequisites at iot.tuya.com: Cloud > Development > Create project (Smart Home) > subscribe IoT Core (trial) > Devices > Link Tuya App Account > scan QR with Smart Life > choose India data centre
- Auth: IoT Platform account
- Response: devices.json with local keys
- Notes: Repeat after any device re-pair (key rotates) and renew the IoT Core trial monthly.
- Source: https://github.com/codetheweb/tuyapi/blob/master/docs/SETUP.md

### Generic MQTT client in the hub (mqtt.js)

```
mqtt connect/subscribe/publish const client = mqtt.connect('mqtt://127.0.0.1:1883', {username, password, clientId:'housecontrol-hub', clean:false, reconnectPeriod:1000, will:{topic:'housecontrol/hub/LWT', payload:'Offline', qos:1, retain:true}}); client.subscribe(['stat/+/POWER','tele/+/LWT','shellies/+/relay/+','+/events/rpc'], {qos:1}); client.publish('cmnd/light1/POWER','ON',{qos:1}); client.on('message',(topic,payload)=>...)
```
- Auth: broker username/password (mqtts:// for TLS)
- Response: message events
- Source: https://github.com/mqttjs/MQTT.js

## Facts

- **Tasmota accepts any console command over HTTP at /cm?cmnd=<url-encoded command>, with optional user/password query params when a web password is set** [high, review: confirmed] Documented examples: http://<ip>/cm?cmnd=Power%20TOGGLE and http://<ip>/cm?user=admin&password=joker&cmnd=Power%20On. Spaces must be %20 and semicolons %3B. 'If you have set a password for web user interface access, this must be included (in plaintext) in the URL of the HTTP request.' Default username is admin. Response is JSON such as {"POWER":"ON"}. (https://tasmota.github.io/docs/Commands/)
- **Tasmota Power commands: Power / Power<x> (x=1..4) with 0|off|false, 1|on|true, 2|toggle, 3|blink; response {"POWER":"ON"} or {"POWER1":"OFF"}** [high] Light commands: Dimmer 0..100 (also + / - / < / >), Color #RRGGBB or r,g,b or preset 1-12, CT 153..500 (cold..warm, +/- steps 34), HSBColor <hue>,<sat>,<bri>, Fade 0|1. (https://tasmota.github.io/docs/Commands/)
- **Tasmota Backlog runs up to 30 semicolon-separated commands in one call and is the documented way to change WiFi/MQTT settings that would each restart the device** [high, review: confirmed] Documented network example: Backlog SSID1 <myssid>; Password1 <mypassword>; SSID2 <myssid2>; Password2 <mypassword2>. MQTT example: Backlog MqttHost <yourhost>; MqttUser <user>; MqttPassword <password>; Topic <customtopic>; SetOption53 1; PowerRetain on. Backlog0 runs without inter-command delay. Web-encoded form: Backlog%20Power%20Toggle%3BPower1%20off. (https://tasmota.github.io/docs/Commands/)
- **Tasmota keeps two WiFi credential slots (SSID1/Password1, SSID2/Password2) and can switch/fallback between them; setting SSID<x>/Password<x> restarts the device** [high] SSID<x>, Password<x> with x = 1..2: value 1 resets to firmware default, 0 clears, any other value sets it and restarts. AP 0 = switch to the other AP, AP 1|2 = select AP 1 or 2. WifiConfig 4 = 'retry other AP without rebooting (default)', 5 = wait until selected AP is available again, 2 = start Wi-Fi Manager (captive portal), 0 = disable Wi-Fi Manager and reboot, 7 = Wi-Fi Manager restricted to reset only. SetOption56 = scan for strongest signal on restart, SetOption57 = re-scan/alternate AP. Restart 1 = restart with config saved, 99 = force restart without saving. (https://tasmota.github.io/docs/Commands/)
- **Tasmota WifiScan 1 starts a scan; WifiScan then returns a JSON list of networks; WifiTest<x> tests credentials before committing them** [high] Responses: {"WifiScan":"Scanning"}, {"WifiScan":"Busy"}, {"WifiScan":"Not Started"}, results (valid 1 minute, ordered by RSSI): {"WiFiScan":{"NET1":{"SSId":"NetworkName","BSSId":"XX:XX:XX:XX:XX:XX","Channel":"1","Signal":"-31","RSSI":"100","Encryption":"WPA2/PSK"}}}. WifiTest syntax: WifiTest[0-2] SSID+PASSWORD ('+' separator because '+' is not allowed in an SSID); WifiTest0 = test, save to slot 1, restart; WifiTest1 = save to slot 1 no restart; WifiTest2 = save to slot 2 no restart; responses {"WifiTest":"Testing"} then {"WifiTest":"Successful"} or failure strings. Landed in Tasmota v12.0.2.4 (PR merged 6 Aug 2022). (https://github.com/arendst/Tasmota/pull/16141)
- **Tasmota Status 0 returns everything; Status 5 (StatusNET) returns IP/gateway/MAC/WifiConfig; Status 11 (StatusSTS) returns POWER state plus Wifi.SSId/RSSI** [high] Status 5 sample: {"StatusNET":{"Hostname":"XXX","IPAddress":"192.168.178.XX","Gateway":"...","Subnetmask":"...","DNSServer":"...","Mac":"2C:3A:E8:XX:XX:XX","Webserver":2,"WifiConfig":4}}. Status 11 sample: {"StatusSTS":{"Time":"2018.02.15 01:00:50","Uptime":"1 02:33:26","POWER":"OFF","Wifi":{"AP":1,"SSId":"XXX","RSSI":100,...}}}. Status 0 contains Status, StatusPRM, StatusFWR, StatusLOG, StatusMEM, StatusNET, StatusTIM, StatusSNS, StatusSTS. (https://tasmota.github.io/docs/JSON-Status-Responses/)
- **Tasmota MQTT scheme: cmnd/%topic%/<command> to command, stat/%topic%/RESULT and stat/%topic%/POWER for replies, tele/%topic%/STATE, tele/%topic%/SENSOR and tele/%topic%/LWT (Online/Offline)** [high] Default FullTopic is %prefix%/%topic%/ and default topic is tasmota_%06X (last 6 hex of MAC, e.g. tasmota_3D5E26). Publishing an empty payload to cmnd/<topic>/Power queries state. PowerRetain 1 / SensorRetain 1 make the broker retain last state. LWT is set on connect at tele/<topic>/LWT. SetOption19 1 enables Home Assistant MQTT discovery. MqttHost/MqttUser/MqttPassword (min 5 chars)/MqttPort/MqttClient/Topic/FullTopic configure the broker connection (each restarts, so use Backlog). (https://tasmota.github.io/docs/MQTT/)
- **Shelly Gen1 devices are controlled with plain HTTP GET paths and protected, when enabled, by HTTP Basic auth; /shelly is always unauthenticated** [high] 'All resources except for /shelly will require Basic HTTP authentication when it is enabled via /settings/login.' /settings/login params: enabled (bool), username (1-50 chars), password (1-50 chars), unprotected (bool). /shelly returns {"type":"SHSW-21","mac":"5ECF7F1632E8","auth":true,"fw":"...","longid":1,"discoverable":true}. (https://shelly-api-docs.shelly.cloud/gen1/)
- **Shelly Gen1 relay and light control: /relay/<i>?turn=on|off|toggle[&timer=<s>], /light/<i>, /color/<i>, /white/<i>** [high] /relay/0 response: {"ison":true|false,"has_timer":bool,"timer_started":n,"timer_duration":n,"timer_remaining":n,"power":n,"overpower":bool,"source":"..."}. Light params: turn (on|off|toggle), brightness 0-100, white 0-100, red/green/blue 0-255, gain 0-100, temp (colour temperature), timer. /color/0 handles RGB(W) mode, /white/0 warm/cool mode (RGBW2 etc.). (https://shelly-api-docs.shelly.cloud/gen1/)
- **Shelly Gen1 has a primary WiFi client config (/settings/sta) and an identical backup (/settings/sta1), plus AP roaming settings** [high] /settings/sta and /settings/sta1 params: enabled (bool), ssid, key (password), ipv4_method dhcp|static, ip, netmask, gateway, dns. 'An identical /settings/sta1 resource allows devices to maintain an alternative WiFi client configuration for fallback connectivity.' /settings?ap_roaming_enabled=<bool>&ap_roaming_threshold=<dBm>. Factory AP: http://192.168.33.1/, SSID shelly<MODEL>-XXXXXXXXXXXX, open. /settings/ap: enabled, ssid, key. /reboot triggers a reboot. (https://shelly-api-docs.shelly.cloud/gen1/)
- **Shelly Gen1 can call the hub back on relay events (URL actions) and speaks MQTT with the shellies/<model>-<id>/ topic scheme** [high] Actions: GET /settings/actions?index=0&name=out_on_url&enabled=true&urls[]=http://192.168.1.4/on (names out_on_url, out_off_url, btn_on_url, btn_off_url; up to 5 URLs of 256 chars since v1.8.0; legacy /settings/relay/0?out_on_url=...). MQTT: shellies/<model>-<deviceid>/relay/0/command accepts on|off|toggle; shellies/<model>-<deviceid>/relay/0 reports on|off|overpower; shellies/announce and shellies/<id>/announce; LWT at shellies/<id>/online (payload false). mDNS: _http._tcp, hostname shelly<model>-<12-hex-MAC>. (https://shelly-api-docs.shelly.cloud/gen1/)
- **Shelly Gen2/Gen3 use JSON-RPC 2.0 over HTTP in three forms: GET /rpc/<Method>?<params>, POST /rpc/<Method> with params JSON body, or POST /rpc with a full frame** [high] Documented curl: curl "http://${SHELLY}/rpc/Switch.Set?id=0&on=true" and curl -X POST -d '{"id":0, "on":true}' "http://${SHELLY}/rpc/Switch.Set". POST /rpc with {"id":0,"method":"Switch.Set","params":{"id":0,"on":true}} returns the full frame with id and result/error; GET /rpc/<Method> and POST /rpc/<Method> return only the result/error contents. GET accepts URL-encoded JSON objects or dotted notation (config.device.name="value"). Websocket at ws://<ip>/rpc (device is server; clients must send one request with a valid src to receive notifications). Max 6 simultaneous non-persistent RPC channels. 'Protection through digest authentication over HTTP is enforced when enabled.' (https://shelly-api-docs.shelly.cloud/gen2/General/RPCChannels)
- **Shelly Gen2 request frame fields are id (required), src (required, any string), method, params; response has id, src, dst and result or error {code, message}; devices also emit NotifyStatus and NotifyEvent frames** [high] Example: {"id":2,"src":"user_1","method":"Switch.Set","params":{"id":1,"on":true}} -> {"id":2,"src":"shellypro4pm-f008d1d8b8b8","dst":"user_1","result":{"was_on":false}}. Error example: {"error":{"code":-105,"message":"Bad id=12"}}. NotifyStatus example params: {"ts":1623243781.01,"switch:3":{"id":3,"aenergy":{...}}}. (https://shelly-api-docs.shelly.cloud/gen2/General/RPCProtocol)
- **Shelly Gen2 authentication is RFC 7616 digest with SHA-256; username is always admin and realm is the device id; passwords are set via Shelly.SetAuth with a precomputed HA1** [high] HA1 = SHA256(admin:<realm>:<password>). 401 body contains auth_type "digest", nonce, realm (device id), algorithm "SHA-256", optional stale. For websocket/POST JSON-RPC add an auth object: {"realm":"shellypro4pm-f008d1d8b8b8","username":"admin","nonce":...,"cnonce":313273957,"nc":"00000001","response":"<hex>","algorithm":"SHA-256"} where response = SHA256(HA1:nonce:nc:cnonce:auth:HA2) and HA2 = SHA256("dummy_method:dummy_uri"). Firmware 2.0.0+: nonces valid 1 hour with up to 30,000 reuses via nc increments; brute-force backoff. (https://shelly-api-docs.shelly.cloud/gen2/General/Authentication)
- **Shelly Gen2 Switch component: Switch.Set {id,on,toggle_after}, Switch.Toggle {id}, Switch.GetStatus {id} -> output/apower/voltage/current/aenergy/temperature** [high] Switch.Set and Switch.Toggle return {"was_on":<bool>}. Switch.SetConfig config: name, in_mode (momentary|follow|flip|detached), initial_state (off|on|restore_last), auto_on/auto_off (bool), auto_on_delay/auto_off_delay (s). HTTP example: http://192.168.33.1/rpc/Switch.Set?id=0&on=true (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch)
- **Shelly Gen2 Light component (dimmers): Light.Set {id, on, brightness 0-100, transition_duration s, toggle_after, offset -100..100}; at least one of on/brightness required; RGB/RGBW/CCT are separate components** [high] Light.Toggle {id}. Light.GetStatus -> {id, source, output, brightness, temperature{tC,tF}}. RGB.Set / RGBW.Set / CCT.Set exist as separate namespaces for colour products. A legacy-style HTTP endpoint /light/{id}?turn=on|off|toggle&brightness=&timer=&transition= is also documented for Gen2 dimmers. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Light)
- **Shelly Gen2 WiFi component supports two station configs (sta and sta1) and an on-device scan; SetConfig with sta/sta1 reconnects the device ~1 s later** [high] WiFi.SetConfig example: http://192.168.33.1/rpc/WiFi.SetConfig?config={"sta":{"ssid":"Shelly","pass":"Shelly","enable":true}} -> {"restart_required":false}. Station config fields: enable, ssid, pass (write-only, required with ssid; never returned by WiFi.GetConfig), is_open (read-only), ipv4mode dhcp|static, ip, netmask, gw, nameserver. roam: rssi_thr (default -80), interval (default 60 s). WiFi.GetStatus -> {"sta_ip":"192.168.206.97","status":"got ip","ssid":"...","rssi":-56}. WiFi.Scan -> results[] with ssid, bssid, auth (0-5), channel, rssi. ap config: ssid (null = default), pass, is_open, enable, range_extender. Station changes trigger reconnection about 1 second later and drop MQTT/websocket sessions. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/WiFi)
- **Shelly Gen2 Shelly.* methods: GetDeviceInfo (unauthenticated identification incl. auth_en), GetStatus, GetConfig, ListMethods, GetComponents, Reboot, SetAuth, CheckForUpdate, Update, FactoryReset** [high] GET http://<ip>/rpc/Shelly.GetDeviceInfo -> {"id":"shellypro4pm-f008d1d8b8b8","mac":"F008D1D8B8B8","model":"SPSW-004PE16EU","gen":2,"fw_id":"...","ver":"0.6.7","app":"FourPro","auth_en":true,"auth_domain":"shellypro4pm-f008d1d8b8b8"}. Shelly.Reboot {delay_ms >= 500, default 1000}. Shelly.SetAuth {user:"admin", realm:<device id>, ha1:<sha256>}. Shelly.GetComponents {offset, include:["config","status"], keys, dynamic_only}. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Shelly)
- **Shelly Gen2 can push completion events to the hub via Webhook.Create (HTTP callbacks, up to 20 hooks x 5 URLs) or an outbound websocket (Ws.SetConfig) that streams NotifyFullStatus/NotifyStatus/NotifyEvent** [high] Webhook.Create params: event (e.g. "switch.on", "switch.off", "input.toggle_on"), cid, urls[], enable (default false), name, condition, repeat_period, active_between ["HH:MM","HH:MM"], ssl_ca; response {"id":n,"rev":n}; URL tokens like ${ev.output}, ${status["switch:0"].output}, ${config.sys.device.mac}. Example: http://192.168.33.1/rpc/Webhook.Create?cid=0&enable=true&event="switch.on"&urls=["http://example.com/action"]. Ws.SetConfig?config={"enable":true,"server":"ws://host:port/path"} (wss:// with ssl_ca) returns restart_required true; after restart the device connects out, sends a full status then incremental frames. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Webhook)
- **Shelly Gen2 MQTT topics: <prefix>/rpc for requests, <src>/rpc for responses, <prefix>/online (LWT true/false), <prefix>/events/rpc for NotifyStatus/NotifyEvent, <prefix>/status/<component:id>, and <prefix>/command/switch:0 accepting on|off|toggle** [high] MQTT.SetConfig config: enable, server "host:port", client_id (default device id), user, pass (write-only), ssl_ca (null | "*" | "user_ca.pem" | "ca.pem"), topic_prefix (default device id, max 300 chars), rpc_ntf (publish notifications on <prefix>/events/rpc), status_ntf (publish <prefix>/status/<component:id>), use_client_cert, enable_rpc, enable_control. <prefix>/command accepts status_update or announce. Example request on <prefix>/rpc: {"id":123,"src":"mynewtopic","method":"Shelly.GetStatus"} -> response on mynewtopic/rpc. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt)
- **Shelly Gen2/Gen3 advertise _shelly._tcp and _http._tcp over mDNS with TXT gen=2 or gen=3; Gen1 only advertises _http._tcp** [high, review: confirmed] '_http._tcp — a web server serving on port 80. This service is also advertised for Gen1 shellies'; '_shelly._tcp — service instance specific to Gen2+ Shelly devices'; 'In the TXT record for both services devices include gen=2 or gen=3', usable to tell Gen1 from Gen2 when browsing _http._tcp. Shelly's own KB shows instance names like shelly2pmg4-7c2c67640b38._shelly._tcp.local. with TXT app and ver keys. Sys config device.discoverable controls whether the device is shown in discovery. (https://shelly-api-docs.shelly.cloud/gen2/General/mDNS/)
- **Tuya OpenAPI has regional hosts; India accounts use https://openapi.tuyain.com; POST bodies must be application/json** [high] China https://openapi.tuyacn.com, Western America https://openapi.tuyaus.com, Eastern America https://openapi-ueaz.tuyaus.com, Central Europe https://openapi.tuyaeu.com, Western Europe https://openapi-weaz.tuyaeu.com, India https://openapi.tuyain.com, Singapore https://openapi-sg.iotbing.com. Required headers: client_id, sign, sign_method=HMAC-SHA256, t (13-digit ms timestamp), access_token (all but token endpoints), nonce (UUID, optional), Signature-Headers (optional). (https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4)
- **Tuya request signature: sign = HMAC-SHA256(client_id + [access_token] + t + [nonce] + stringToSign, secret).toUpperCase(), where stringToSign = METHOD\nSHA256(body)\n<signature headers>\n<path?sorted query>** [high] Token APIs omit access_token: str = client_id + t + nonce + stringToSign. Business APIs: str = client_id + access_token + t + nonce + stringToSign. Content-SHA256 of an empty body is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855. The headers line is 'key:value\n' pairs for headers named in Signature-Headers (empty line if none). URL = path plus query parameters sorted alphabetically. Worked example with client_id 1KAD46OrT9HafiKdsXeg, t 1588925778000, nonce 5138cc3a9033d69856923fd07b491173 for GET /v1.0/token?grant_type=1 yields sign 9E48A3E93B302EEECC803C7241985D0A34EB944F40FB573C7B5C2A82158AF13E. (https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g)
- **Tuya token: GET /v1.0/token?grant_type=1 returns access_token (valid expire_time=7200 s), refresh_token (single-use, no expiry) and uid; refresh with GET /v1.0/token/{refresh_token}** [high] Sample: {"expire_time":7200,"access_token":"**","uid":"eu*****","refresh_token":"**"}. grant_type 1 = simple mode using client_id/secret; 2 = OAuth code mode. Refresh endpoint returns the same four fields; 'The refresh_token has no limit on validity period but only takes effect once.' (https://developer.tuya.com/en/docs/cloud/6c1636a9bd?id=Ka7kjumkoa53v)
- **Tuya IoT Core device endpoints: GET /v1.0/iot-03/devices/{device_id} (includes local_key), GET .../status, POST .../commands, GET .../specification, GET .../functions, GET /v1.0/iot-03/devices/status (batch)** [high] Send commands: POST /v1.0/iot-03/devices/{device_id}/commands body {"commands":[{"code":"switch_led","value":true}]} -> {"result":true,"t":1551851043862,"success":true}. Status: GET /v1.0/iot-03/devices/{device_id}/status -> {"result":[{"code":"switch_led","value":true},{"code":"work_mode","value":"scene_2"}],"t":...,"success":true}. Device info response fields include id, uuid, category, name, product_id, product_name, local_key ('Secret key'), sub, asset_id, ip, lon, lat, model, time_zone, active_time, update_time, create_time, online. Legacy /v1.0/devices/{device_id}, /v1.0/devices/{device_id}/status, /v1.0/devices/{device_id}/functions, POST /v1.0/devices/{device_id}/commands and GET /v1.0/users/{uid}/devices are also documented. (https://developer.tuya.com/en/docs/cloud/device-connection-service?id=Kb0b8geg6o761)
- **Tuya standard DP codes for lights (category dj): switch_led, work_mode, bright_value_v2 10-1000, temp_value_v2 0-1000, colour_data_v2 {h 0-360, s 0-1000, v 0-1000}, countdown_1 0-86400** [high] Older bulbs use bright_value 25-255, temp_value 0-255, colour_data {h 0-360,s 0-255,v 0-255}. work_mode enum: white, colour, scene, music, scene_1..scene_4. Example command: {"commands":[{"code":"colour_data_v2","value":{"h":201,"s":511,"v":899}}]}. Also scene_data_v2, music_data, control_data, flash_scene_1..4. (https://developer.tuya.com/en/docs/iot/dj?id=K9i5ql3v98hn3)
- **Tuya standard DP codes for switches/sockets/power strips (kg/cz/pc): switch, switch_1..switch_6, countdown_1..countdown_6 (0-86400 s), switch_usb1..6, child_lock, relay_status (power_on|power_off|last), light_mode (none|relay|pos), switch_backlight** [high, review: confirmed] All switch_* codes are Boolean true=On false=Off. relay_status 'last' restores the last state after power loss. (https://developer.tuya.com/en/docs/iot/switch-socket-and-power-strip?id=K9gf7o3qbbklt)
- **To get Tuya local keys the owner links the Smart Life app account to a cloud project by QR code; the project's data centre must match the app account's region (India)** [high] Steps: Cloud > Development > project > Devices > 'Link Tuya App Account' > 'Add App Account' > scan the QR code with the SmartLife app > 'Confirm login'. 'Switch to your desired data center in the top right corner of the Devices page' and align it with the app account's region. After linking, the account's devices appear in the project and local_key is readable via the device-info API or the tinytuya / tuya-cli wizards. (https://developer.tuya.com/en/docs/iot/link-devices?id=Ka471nu1sfmkl)
- **The Tuya IoT Core subscription needed for the cloud API and key retrieval is a free trial that expires after one month and must be renewed/extended; trial cloud calls are limited** [high] tinytuya README: 'The IoT Core subscription is a free trial that expires after one month' and 'The free Tuya IoT Developer (Trial) account allows a very limited number of Cloud API calls.' Tuya support: after expiry the APIs stop working; apply for a trial extension (Cloud > Project Management > Upgrade IoT Core Plan > Trial edition / 'Extend trial period'), approved within 1-2 workdays; trial is for individual/debugging use, commercial use prohibited. (https://support.tuya.com/en/help/_detail/Kbm9zue1v7vvu)
- **tinytuya (Python, MIT) provides the wizard that writes devices.json with local keys, local control on TCP 6668 for protocol 3.1-3.5, UDP discovery on 6666/6667/7000, and a Cloud class with apiRegion 'in'** [high] python -m tinytuya wizard (needs API Key, API Secret, region, one device id); python -m tinytuya scan. devices.json fields: name, id, key, mac, uuid, category, product_name, ip, version. d = tinytuya.OutletDevice(dev_id, address, local_key, version=3.3); d.status(); d.turn_on(); d.turn_off(); d.set_value(index, value); BulbDevice.set_colour(r,g,b), set_white(brightness,colourtemp), set_brightness_percentage(), set_mode('white'|'colour'). Persistent socket: persist=True, d.status(nowait=True), loop d.receive(), d.heartbeat(). v3.4/3.5 devices need session-key negotiation (handled by the lib). Cloud: tinytuya.Cloud(apiRegion="in", apiKey, apiSecret, apiDeviceID); c.getdevices(); c.getstatus(id); c.sendcommand(id, {"commands":[{"code":"switch_1","value":True}]}). 'Tuya devices only allow one TCP connection at a time. Make sure you close the TuyaSmart or SmartLife app before using TinyTuya to connect.' (https://github.com/jasonacox/tinytuya)
- **tinytuya ships a local REST/web server (port 8888) that a Node hub can call instead of speaking the Tuya LAN protocol itself** [high] Start with python3 server.py (or -d for debug) in the directory containing devices.json; listens on HTTP 8888 and UDP 6666/6667/7000. Endpoints: /devices, /device/{id|name}, /numdevices, /status/{id|name}, /set/{id|name}/{dpsKey}/{dpsValue}, /turnon/{id}[/{switchNo}], /turnoff/{id}[/{switchNo}], /delayedoff/{id}/{switchNo}/{seconds}, /sync (pull device list + local keys from cloud), /cloudconfig/{apiKey}/{apiSecret}/{apiRegion}/{apiDeviceID}, /offline, /help. (https://github.com/jasonacox/tinytuya/tree/master/server)
- **tuyapi (npm 'tuyapi', MIT) controls Tuya devices locally from Node: new TuyAPI({id, key, ip, version:'3.3'}), find(), connect(), get(), set({dps, set}), events connected/disconnected/error/data/dp-refresh; protocol 3.5 was added in v7.7.0** [medium] Constructor options include issueGetOnConnect and issueRefreshOnConnect; device.refresh() forces newer devices to report. 'Newer firmware may use protocol 3.3. If you are not using find(), you will need to manually pass version: 3.3 to the constructor.' 'Only one TCP connection can be in use with a device at once. If using this, do not have the app on your phone open.' Release v7.7.0 (latest at time of research): 'Adding protocol 3.5'. Protocol 3.4 support was tracked in issue #481; confirm against the CHANGELOG before relying on 3.4 devices. (https://github.com/codetheweb/tuyapi)
- **Tuya local keys change every time a device is removed and re-paired in the Smart Life app, so the hub must re-fetch local_key after any re-pair** [high] tinytuya docs: 'if you ever reset or re-pair your smart devices, the Local_Key will be reset and you will need to repeat the steps above to obtain the new local key.' This also means there is no local API to move a Tuya device to another WiFi; re-pairing (which sets new WiFi) rotates the key. (https://pypi.org/project/tinytuya/)
- **Tuya cloud can push device status changes to the hub via its Pulsar-based Message Service over WebSocket; India endpoint wss://mqe.tuyain.com:8285/** [medium] Node.js SDK is downloaded from the docs page (depends on crypto-js 4.0.0+ and ws 7.4.5+), configured with accessId, accessKey, url, env (TEST|PROD), maxRetryTimes; client.open(), message callback, client.ackMessage(). Regional URLs: China wss://mqe.tuyacn.com:8285/, US wss://mqe.tuyaus.com:8285/, Europe wss://mqe.tuyaeu.com:8285/, India wss://mqe.tuyain.com:8285/, Singapore wss://mqe-sg.iotbing.com:8285/. Messages carry an encrypted payload decrypted to devId, status[] etc.; bizCode statusReport must be enabled in the project's Message Service. (https://developer.tuya.com/en/docs/iot/Pulsar-SDK-get-message-nodejs?id=Kawfmtxp8yscg)
- **@tuya/tuya-connector-nodejs (MIT, v2.1.2) is Tuya's official Node SDK that handles signing and token refresh: new TuyaContext({baseUrl, accessKey, secretKey}) then tuya.request({method, path, body}) or tuya.device.detail({device_id})** [high] package.json: name @tuya/tuya-connector-nodejs, version 2.1.2, license MIT, dependencies axios ^0.21.1 and qs ^6.10.1 (old axios — audit before use). Supports a custom token store (TuyaTokenStorInterface) and custom HTTP client. (https://raw.githubusercontent.com/tuya/tuya-connector-nodejs/master/package.json)
- **mqtt.js (npm 'mqtt', MIT, Node 18+) is the standard Node MQTT client: mqtt.connect('mqtt://host:1883', {username, password, clientId, clean, reconnectPeriod, will}) with subscribe/publish/on('message')** [high] Supports MQTT 3.1.1 (protocolVersion 4, default) and 5.0 (protocolVersion: 5), TLS via mqtts://, websockets via ws:// and wss://. Events: connect, message (topic, payloadBuffer), reconnect, close, error, offline. publish(topic, message, {qos, retain}, cb); subscribe(topic, {qos}, cb); client.end(). (https://github.com/mqttjs/MQTT.js)
- **Eclipse Mosquitto 2.1.2 (EPL-2.0 / EDL-1.0) ships a Windows x64 installer and supports MQTT 5.0, 3.1.1 and 3.1; aedes (npm, MIT) is an embeddable alternative broker supporting MQTT 3.1/3.1.1 only** [high] Download page lists mosquitto-2.1.2-install-windows-x64.exe. Repo: 'Mosquitto is an open source implementation of a server for version 5.0, 3.1.1, and 3.1 of the MQTT protocol', licence files epl-v20 and edl-v10. aedes minimal server: const aedes = require('aedes')(); require('net').createServer(aedes.handle).listen(1883); MQTT 5.0 'not support yet'. (https://github.com/eclipse-mosquitto/mosquitto)
- **bonjour-service (npm, MIT) browses mDNS from Node: instance.find({type:'http'}, service => ...) yielding name, host, port, addresses, txt, fqdn** [high] Use type 'shelly' for Gen2+ (_shelly._tcp) and 'http' for Gen1/Tasmota; filter Shelly Gen2 by txt.gen. Publish example: instance.publish({name, type:'http', port}). (https://github.com/onlxltd/bonjour-service)
- **Shelly Gen2 devices are first provisioned by joining the device's own open AP and calling the RPC on 192.168.33.1** [medium] Factory AP SSID contains the model and MAC (e.g. ShellyPlus1-XXXX), open unless configured; web UI and RPC at http://192.168.33.1 (all Gen2 doc examples use this IP, e.g. http://192.168.33.1/rpc/WiFi.SetConfig?config={...}). Shelly WiFi devices are 2.4 GHz only. (https://us.shelly.com/blogs/documentation/network-design-guide-for-shelly-gen2-devices)

## Limits and caveats

- None of these lights/switches has a SIM. When the home WiFi is reset every path to them dies, including Tuya cloud (the bulb itself needs internet). The only way to keep light control alive through a router reset is to give devices a second network (a 4G router as Tasmota SSID2 / Shelly sta1) which the hub can pre-provision from the endpoints above; Tuya devices cannot be given a second SSID by API.
- Tuya devices cannot be re-pointed to another WiFi through any documented cloud or LAN API; the owner must re-pair them in Smart Life, which also rotates the local_key, so the hub must re-fetch keys (GET /v1.0/iot-03/devices/{id}) after every re-pair.
- Tuya cloud access depends on an IoT Core subscription whose free trial expires after one month; APIs stop working until the trial is extended (approval 1-2 workdays) and the trial is limited to non-commercial use with a small call quota. Use LAN control (tuyapi/tinytuya) as the primary path and cloud only for key retrieval and remote fallback.
- Tuya LAN protocol allows exactly one TCP connection per device; the hub must own a single persistent socket per device and the Smart Life app must not be open at the same time, or commands fail intermittently.
- tuyapi protocol 3.4 support could not be verified from the release page (3.5 is confirmed in v7.7.0); check the CHANGELOG or fall back to tinytuya's REST bridge for 3.4/3.5 devices. @tuya/tuya-connector-nodejs pins axios ^0.21.1 (old); audit or implement the ~40-line signing routine with Node crypto instead.
- Tuya Pulsar Node SDK is a download from the docs page, not an npm package, and the Message Service must be enabled in the project; details of enabling it were not fully verified (medium confidence). Tuya batch-status query parameter name was not verified.
- Tasmota HTTP auth sends user/password in the URL in plaintext and Shelly Gen1 uses HTTP Basic — keep both LAN-only (never port-forward); rely on the hub's own TLS/PWA login for remote access. Shelly Gen2 digest is SHA-256, so common Node digest libraries that only do MD5 will not work; implement with crypto.
- Shelly Gen2 WiFi.SetConfig pass is write-only and the device reconnects ~1 s after a station change, dropping MQTT/websocket sessions; Tasmota SSID/Password commands restart the device — always send via Backlog and expect the device to reappear on the new network with a new IP (re-discover via mDNS/UDP scan). Shelly Gen2 allows at most 6 simultaneous non-persistent RPC channels.
- Tasmota WifiScan/WifiTest need firmware >= 12.0.2.4; Tasmota mDNS (SetOption55) is only present in builds compiled with mDNS support, so subnet probing of /cm?cmnd=Status%200 may be needed for discovery. All three vendors' WiFi devices are 2.4 GHz only.
- Some pages were read through a summarising fetch tool; re-check exact JSON field names against the cited source pages while implementing (all URLs above are the primary vendor/GitHub documents).

## Libraries

- **mqtt** (npm, MIT, 5.x (Node 18+)): Hub-side MQTT client for Tasmota (cmnd/stat/tele), Shelly Gen1 (shellies/...) and Shelly Gen2 (<id>/rpc, <id>/events/rpc) plus the hub's own notification bus https://github.com/mqttjs/MQTT.js
- **mosquitto** (binary, EPL-2.0 / EDL-1.0, 2.1.2 (Windows x64 installer)): Local MQTT broker on the Windows hub now and Raspberry Pi later; supports MQTT 5/3.1.1/3.1 https://github.com/eclipse-mosquitto/mosquitto
- **aedes** (npm, MIT): Embedded MQTT 3.1.1 broker inside the Node process if installing Mosquitto is undesirable (no MQTT 5) https://github.com/moscajs/aedes
- **tuyapi** (npm, MIT, 7.7.0): Local (LAN, TCP 6668) control of Tuya bulbs/switches with device id + local_key; emits 'data' events for completion notifications https://github.com/codetheweb/tuyapi
- **@tuyapi/cli** (npm, MIT (same author as tuyapi; not re-verified on this run)): tuya-cli wizard: one-time retrieval of device ids and local keys from the linked Smart Life account https://github.com/codetheweb/tuyapi/blob/master/docs/SETUP.md
- **@tuya/tuya-connector-nodejs** (npm, MIT, 2.1.2): Official Tuya OpenAPI client with automatic HMAC-SHA256 signing and token refresh (baseUrl https://openapi.tuyain.com); optional — signing is simple enough to hand-roll with Node crypto https://raw.githubusercontent.com/tuya/tuya-connector-nodejs/master/package.json
- **tinytuya** (python, MIT): Wizard (python -m tinytuya wizard) for local keys, LAN scanner, and an optional REST bridge on port 8888 for protocol 3.4/3.5 devices; also documents DPS maps https://github.com/jasonacox/tinytuya
- **bonjour-service** (npm, MIT): mDNS browsing for _shelly._tcp / _http._tcp (Shelly Gen1/Gen2/3, Tasmota with SetOption55) to find devices after they move networks https://github.com/onlxltd/bonjour-service
- **ws** (npm, MIT): WebSocket client/server for Shelly Gen2 ws://<ip>/rpc, the hub endpoint that receives Shelly outbound websocket (Ws.SetConfig) frames, and Tuya's Pulsar SDK dependency (ws >= 7.4.5) https://www.npmjs.com/package/ws
- **node:crypto (built-in)** (npm, MIT (Node.js)): HMAC-SHA256 for Tuya request signing and SHA-256 digest computation for Shelly Gen2 auth (HA1/HA2/response); no third-party digest library needed https://shelly-api-docs.shelly.cloud/gen2/General/Authentication
