# gate-control

Review: 65 claims confirmed, 10 corrected, 1 could not be verified.

## Summary

Residential gates in India are driven three ways the hub can talk to: (1) GSM gate-opener relay modules (RTU5024 and look-alikes, sold on Amazon.in/robu.in) that pulse a dry-contact relay when an authorised number calls the SIM (call is rejected on the first ring, so it is free) and are configured entirely by SMS; (2) WiFi relay modules (Shelly 1/Plus/Gen3, Sonoff BASICR3/MINI in DIY mode, Sonoff SV, Tuya "garage door opener" modules, or Tasmota-flashed boards) whose relay is wired in parallel with the gate board's push-button input and pulsed for ~0.5-1 s; (3) the gate motor's own connectivity (Nice BiDi-WiFi/IT4WIFI, CAME Connect, BFT U-Link/uControl, FAAC Simply Connect). The GSM path is fully feasible from the hub with a 4G modem (SIMCom SIM7600-class) issuing AT commands: `ATD<number>;` for the missed-call open and `AT+CMGF=1` / `AT+CMGS` for the SMS config commands; the exact SMS dialect depends on the module firmware, and three dialects are documented below (King Pigeon `1234GOT030#`, the `1234#GOT19#` "pwd#CMD#" family, and the Gainwise `*12*1234#…` family). The WiFi path is fully feasible with documented local HTTP APIs: Shelly Gen2 `Switch.Set?id=0&on=true&toggle_after=1`, Shelly Gen1 `/relay/0?turn=on&timer=1`, Sonoff DIY `POST :8081/zeroconf/pulse`, Tasmota `cm?cmnd=Power1 ON` with `PulseTime1`, and tinytuya `set_value(1,True)` for Tuya; Shelly and Sonoff DIY and Tasmota also expose a local call to re-point the device to another WiFi SSID, Tuya does not (re-pair only). Gate state for the "done" notification is best taken from a reed/magnetic switch on the leaf wired to the Shelly SW input (in_mode "detached", Input type "switch", Webhook on input.toggle_on/off) or a Tasmota Switch GPIO (SwitchMode 1 + SetOption114 1 publishes {"Switch1":{"Action":"ON"}} over MQTT); the two-input GSM openers can also report input state by SMS (`*24*1234#` or the pwd# family's alarm inputs), which works when WiFi is down. Commercial brands: Nice's local protocol (NHK/T4 over TLS:443) is undocumented but implemented by open-source integrations; CAME and BFT have reverse-engineered cloud REST APIs (unofficial, may break); FAAC Simply Connect has no public API found; Toshi and Gandhi Automations publish no WiFi/GSM/API capability, so treat their motors as plain dry-contact boards and add a relay module + reed sensor. Generic Chinese sliding/swing boards (THD SL1500ACL manual) expose OPEN/CLOSE/STOP/PED/COMMON and a single "cyclical" step input that cycles OPEN-STOP-CLOSE-STOP; Nice boards expose STEP-BY-STEP (NO), STOP and PHOTO (NC) with a configurable SbS sequence. India-specific: Jio has no 2G, so 2G-only openers need Airtel/Vi/BSNL SIMs, and the 4G RTU5024 lists LTE B1/B3/B5/B7/B8/B20 (no B40) — verify bands before buying.

## Corrections from review (these override anything below)

- **Claim:** FACT: hub can send SMS and missed-call trigger via SIM7500/SIM7600 AT commands: AT+CMGF=1, AT+CMGS, ATD<n>; -> VOICE CALL:BEGIN, ATH needs AT+CVHU=0 or use AT+CHUP, AT+CNMI=1,2,0,0,0 routes '+CMTI: <mem>,<index>', AT+CSQ 0-31
  **Correction:** Everything is correct except the CNMI detail. Per the SIMCom manual, <mt>=2 routes the SMS directly to the TE as '+CMT: <oa>,[<alpha>],<scts><CR><LF><data>' (message is NOT stored and no index is given). '+CMTI: <mem3>,<index>' is produced by <mt>=1 (e.g. AT+CNMI=2,1), after which the hub must AT+CMGR=<index> and AT+CMGD=<index>. Pick one: AT+CNMI=2,1 (stored, read by index) or AT+CNMI=2,2 (pushed as +CMT). Also AT+CSQ can return 99 (unknown).
  Source: https://www.kincony.com/images/SIM7600/SIM7500_SIM7600_Series_AT_Command_Manual_V2.00.pdf (sections 2.2.2 ATD, 2.2.7 ATH, 5.2.1 CVHU, 5.2.2 CHUP, 9.2.9 CNMI, 9.2.13 CMGS, 3.2.8 CSQ)
- **Claim:** FACT: Sonoff SV is 5-24 V DC ESP8266 relay (max 290 mA/240 W), solder-modifiable isolated output, LAN control only via encrypted eWeLink LAN protocol; pysonofflanr3: WebSocket on port 8081, fw V3+, API key 'obtainable from the eWeLink app'
  **Correction:** (1) Transport for V3+ firmware is HTTP POST to http://<ip>:8081/zeroconf/<command> discovered via mDNS _ewelink._tcp, not WebSocket (the pysonofflanr3 README sentence about WebSocket is inherited from the pre-V3 library). Payload: {sequence, deviceid, selfApikey:'123', encrypt:true, iv:<base64 16 bytes>, data:<base64 AES-CBC(PKCS7) of the JSON data>} with AES key = MD5(devicekey). (2) The device key is NOT obtainable from the eWeLink app UI: pysonofflanr3 says it 'is not designed to be captured by users and is not available in any user interfaces' (capture during pairing / tcpdump); AlexxIT/SonoffLAN instead loads device keys from the eWeLink cloud account at start-up. The key is constant across re-pairing. (3) '290 mA / 240 W' could not be verified; Tasmota's SV page says PCB traces are good for about 2 A and isolation is done by removing the two 0-ohm resistors next to the jumper. Sonoff SV is not named in SonoffLAN's README.
  Source: https://raw.githubusercontent.com/AlexxIT/SonoffLAN/master/custom_components/sonoff/core/ewelink/local.py ; https://pysonofflanr3.readthedocs.io/encryption.html ; https://pysonofflanr3.readthedocs.io/readme.html ; https://tasmota.github.io/docs/devices/Sonoff-SV/
- **Claim:** FACT: THD SL1500ACL board J2 terminal: Pedestrian (1), Close (2), Open (3), Stop (4), Common (5), Cyclical (6); J5 limit pins 13 open / 12 common / 11 close; IR NC input; LAMP output; DIP6 single-button cycle; DIP3/4 auto-close 12/24/36 s; DIP5
  **Correction:** The J2 pin numbers are shifted by one. Text coordinates on page 14/15 of the manual pair the numbers and labels as: pin 6 = Pedestrian Signal, pin 5 = Cyclical Signal, pin 4 = Common Signal, pin 3 = Stop Signal, pin 2 = Open Signal, pin 1 = Close Signal. J5 is as claimed (13 Open Limit, 12 Common Limit, 11 Close Limit) plus 10 Sensor Signal, 9 IR Ground, 8 IR NC Signal, 7 IR 15V Supply. DIP6 down = single-button cycle OPEN-STOP-CLOSE-STOP (default), DIP6 up = four separate buttons ('not recommended'); DIP3/DIP4 autoclose: down/up = 12 s, up/down = 24 s, up/up = 36 s, down/down = manual; DIP5 up disables the collision auto-close. The LAMPL/LAMPN outputs on J4 are labelled 'Live Alarm Light Pin'/'Neutral Light Pin' (mains side), not a logic-level signal.
  Source: https://images.thdstatic.com/catalog/pdfImages/8a/8ab75792-d09e-48eb-9e2b-528ea94b9b4b.pdf (SL1500ACL manual V20240325, circuit board diagram page; verified by extracting text positions with pypdf: '6'/'Pedestrian Signal Pin' share y=119.5 ... '1'/'Close Signal Pin' share y=49.4)
- **Claim:** FACT: CAME Connect unofficial cloud API base https://app.cameconnect.net/api; POST /automations/{device_id}/commands/{command_id} 2=open 5=close 129=stop; phases 16/17/32/33/19; OAuth auth-code PKCE + token with Basic client creds scraped from https://www.cameconnect.net/main.XXX.js; discovery /evo/v1/sites; GET /devicestatus; wss events EventId 21; earlier came-connect library archived Oct 2024
  **Correction:** Endpoints, command ids (cover.py: 2 open, 5 close, 129 stop) and phase codes (const.py: 16 open, 17 closed, 32 opening, 33 closing, 19 stopped; 23 = snapshot event) are correct. Wrong/misleading parts: (1) In this integration the client_id/client_secret are NOT scraped from main.XXX.js; the README tells the user to log in at https://app.cameconnect.net with DevTools open, find the request to https://auth.cameconnect.net/oauth/token and Base64-decode its 'Authorization: Basic' header (clientId:clientSecret). (2) /evo/v1/sites and /evo/v1/sites/{site_id}/devices require a query parameter dt=<device_token> and are used for BPT/X1 intercom autodiscovery, not gate discovery; the gate Device ID is typed in by the user and is the number at the end of https://app.cameconnect.net/home/devices/XXXXXX. (3) GET /devicestatus needs ?devices=[<device_id>] and returns {Data:[...]}. (4) jasonmadigan/came-connect is archived (GitHub API: archived=true, last push 2024-07-06); the exact archive month could not be confirmed. Integration confirmed only on a ZLX24SA board.
  Source: https://raw.githubusercontent.com/sdeagh/came_connect/main/custom_components/came_connect/api.py ; .../cover.py ; .../const.py ; https://raw.githubusercontent.com/sdeagh/came_connect/main/README.md ; https://api.github.com/repos/jasonmadigan/came-connect
- **Claim:** FACT: eWeLink cloud OpenAPI documentation could not be retrieved (JS app / 404), so no eWeLink cloud endpoint is cited
  **Correction:** The docs are retrievable with a JS-rendering fetch at https://coolkit-technologies.github.io/eWeLink-API/#/en/APICenterV2. Regional API hosts: https://cn-apia.coolkit.cn (China), https://as-apia.coolkit.cc (Asia - use for India), https://us-apia.coolkit.cc, https://eu-apia.coolkit.cc. Login: POST /v2/user/login with headers X-CK-Appid, X-CK-Nonce and Authorization (Sign). Device control: POST /v2/device/thing/status with body fields type, id, params. WebSocket dispatch: https://as-dispa.coolkit.cc/dispatch/app (cn/us/eu equivalents). An APPID/APP SECRET from the CoolKit developer platform is required. (Extracted through an LLM page query, so re-read the page before coding against it.)
  Source: https://coolkit-technologies.github.io/eWeLink-API/#/en/APICenterV2
- **Claim:** ENDPOINT: pwd# dialect reed-switch state over SMS via alarm inputs - 1234#EA# | 1234#DA# | 1234#AL? | 1234#KEYNO# | 1234#KEYNC# | 1234##TEXT1O...# | 1234##TEXT1C...#
  **Correction:** The command syntax is correct, but the inputs are alarm zones, not a live state report, and will not work as a 'gate opened' confirmation after a hub-triggered open: both manuals state the inputs 'enter Armed status after 10 minutes of the latest dial-in. In the first 10 minutes, when the sensor triggered, will not alarm'. So a reed change caused by the hub's own call is suppressed. After arming, a trigger also drives the siren output for 90 s and SMSes positions 01/02 (001/002). Inputs are disabled by default (send pwd#EA#). On the 64-user unit TEXT1 sets the message for input 2 and TEXT2 for input 1 (swapped); only the 999-user unit has separate open/close texts (TEXT1O/TEXT1C/TEXT2O/TEXT2C, max 30 letters). The 200-user 'RTU5024' pwd# variant has no inputs at all. Use the relay-action SMS (pwd#R#) as the 'command executed' confirmation and a separate sensor for true gate state.
  Source: https://enerna-iotech.com/wp-content/uploads/2020/05/GSM-Access-Control-Gate-Opener-User-Manual.pdf (notice 5, 6.5, 6.6, 6.14) ; https://peatsecurityproducts.ie/resources/files/GSM-Opener-User-Manual.pdf (notice 5, 6.6, 6.14 tips 3-4)
- **Claim:** ENDPOINT: Sonoff SV stock firmware LAN-mode via SonoffLAN / pysonofflanr3 - 'WebSocket/HTTP :8081', pysonofflanr3 --host --device_id --api_key on
  **Correction:** CLI flags are right (--host, --device_id, --inching, --api_key), but the wire protocol for V3+ firmware is plain HTTP POST http://<ip>:8081/zeroconf/switch (port taken from the mDNS _ewelink._tcp record, 8081 default) with body {sequence, deviceid, selfApikey, encrypt:true, iv, data} where data = base64(AES-CBC-PKCS7(JSON, key = MD5(devicekey), random 16-byte iv)); state pushes arrive as mDNS TXT updates (data1..), also encrypted. No WebSocket is involved. The device key must be captured at pairing or pulled from the eWeLink cloud (SonoffLAN does this automatically); it is not shown in the app.
  Source: https://raw.githubusercontent.com/AlexxIT/SonoffLAN/master/custom_components/sonoff/core/ewelink/local.py ; https://pysonofflanr3.readthedocs.io/encryption.html
- **Claim:** ENDPOINT: CAME Connect auth - POST /api/oauth/auth-code (PKCE S256, redirect https://app.cameconnect.net/role) then POST /api/oauth/token; client_id/secret scraped from main.XXX.js, sent as Basic
  **Correction:** Flow and URLs are right; the credential source is wrong. Exact calls in api.py: POST {API}/oauth/auth-code with query params client_id, response_type=code, redirect_uri, state, nonce, code_challenge, code_challenge_method=S256 and form body grant_type=authorization_code, client_id, username, password, header Authorization: Basic base64(client_id:client_secret) -> JSON {code}. Then POST {API}/oauth/token with form grant_type=authorization_code, code, redirect_uri, code_verifier and the same Basic header -> {access_token, expires_in}. The client id/secret are taken by the user from the Basic header of the web app's own request to https://auth.cameconnect.net/oauth/token (browser DevTools), not from main.XXX.js. Redirect URI must match exactly (https://app.cameconnect.net/role, or https://beta.cameconnect.net/role for beta clients).
  Source: https://raw.githubusercontent.com/sdeagh/came_connect/main/custom_components/came_connect/api.py ; https://raw.githubusercontent.com/sdeagh/came_connect/main/README.md
- **Claim:** ENDPOINT: CAME Connect discover, command, status, events - GET /api/evo/v1/sites | /evo/v1/sites/{site_id}/devices | POST /api/automations/{device_id}/commands/{2|5|129} | GET /api/devicestatus | wss://app.cameconnect.net/api/events-real-time (token as subprotocol)
  **Correction:** Command, status and WebSocket endpoints are right; the 'discovery' description is not. /evo/v1/sites and /evo/v1/sites/{site_id}/devices require ?dt=<device_token> and are only used for BPT/X1 intercom autodiscovery; a gate's device_id is entered manually (last path segment of https://app.cameconnect.net/home/devices/XXXXXX). Status call is GET /api/devicestatus?devices=[<device_id>] with Bearer token, returning {Data:[{...}]}. Command call is POST with an empty JSON body {} and succeeds with 200 or 202. WebSocket: connect to wss://app.cameconnect.net/api/events-real-time?language=en-US with the raw JWT as the Sec-WebSocket-Protocol value and header Origin: https://www.cameconnect.net; frames are JSON {Data:{EventId, Data:'<json string>'}} and for EventId 21 the inner Payload is [phase, percent].
  Source: https://raw.githubusercontent.com/sdeagh/came_connect/main/custom_components/came_connect/api.py ; https://raw.githubusercontent.com/sdeagh/came_connect/main/custom_components/came_connect/cover.py
- **Claim:** ENDPOINT: THD SL1500ACL relay-to-terminal map - Relay COM -> J2 pin 5 'Common', NO -> J2 pin 6 'Cyclical'; or NO -> pin 3 Open, pin 2 Close, pin 4 Stop; pin 1 Pedestrian
  **Correction:** Pin numbers are off by one. Correct map from the manual's board diagram: Relay COM -> J2 pin 4 'Common Signal'; Relay NO -> J2 pin 5 'Cyclical Signal' (single-button OPEN-STOP-CLOSE-STOP). Separate functions: pin 2 'Open Signal', pin 1 'Close Signal', pin 3 'Stop Signal', pin 6 'Pedestrian Signal' (each against pin 4 Common). Wiring to the claimed pins would bridge Cyclical-Pedestrian (5-6) instead of Common-Cyclical and would not operate the gate.
  Source: https://images.thdstatic.com/catalog/pdfImages/8a/8ab75792-d09e-48eb-9e2b-528ea94b9b4b.pdf (circuit board diagram page, J2 Terminal table)

## Added by review (things an implementer needs)

- **THD SL1500ACL full terminal map (correct numbering) and safety notes** J2: 1 Close, 2 Open, 3 Stop, 4 Common, 5 Cyclical, 6 Pedestrian. J5: 7 IR 15V supply, 8 IR NC signal, 9 IR ground, 10 sensor signal, 11 close limit, 12 common limit, 13 open limit. Pins 8-9 ship shorted by a wire that must be removed when photocells are fitted. J4 carries MOT1/MOT2/MCOM and LAMPL/LAMPN ('Live Alarm Light Pin', mains side) - never feed these into a Shelly/ESP input. J3 is mains PE/L/N. DIP6 is described as 'Remote Operation Mode'; the manual does not say whether the wired Open/Close/Stop pins need DIP6 up, so test before relying on separate-button wiring. (https://images.thdstatic.com/catalog/pdfImages/8a/8ab75792-d09e-48eb-9e2b-528ea94b9b4b.pdf)
- **Hub modem: receiving the opener's reply/confirmation SMS** Use AT+CMGF=1 then either AT+CNMI=2,1 (URC '+CMTI: <mem3>,<index>' -> AT+CMGR=<index> -> AT+CMGD=<index>) or AT+CNMI=2,2 (URC '+CMT: <oa>,[<alpha>],<scts><CR><LF><text>', message not stored). AT+CPMS selects storage; AT+CMGL="ALL" lists stored messages on start-up to catch SMS that arrived while the hub was down; AT+CMGRD reads and deletes in one step. SIM storage is small, so delete after reading or new confirmations will be rejected. (https://www.kincony.com/images/SIM7600/SIM7500_SIM7600_Series_AT_Command_Manual_V2.00.pdf (sections 9.2.2, 9.2.9, 9.2.11, 9.2.12, 9.2.16, 9.2.19))
- **Hub modem: how to tell a missed-call trigger succeeded** The opener rejects the call, so the modem returns BUSY (only with ATX3/ATX4) or NO CARRIER instead of 'VOICE CALL: BEGIN'. Enable AT+CLCC=1 to get unsolicited '+CLCC: <id>,<dir>,<stat>,...' on every call-state change (stat 2 = dialing, 3 = alerting, 6 = disconnect) and treat 'alerting followed by disconnect within a few seconds' as accepted; hang up with AT+CHUP on timeout (response 'VOICE CALL: END: <time>'). Force caller-ID presentation with AT+CLIR=2 or the 'i' dial modifier (ATD+91...i;), since the opener matches on caller ID. AT+CHUP/ATD maximum response time is 120 s, so serialize AT commands with a queue. Whether the hub SIM can place voice calls at all on a 4G-only network depends on the modem variant/firmware supporting VoLTE - not covered by this manual; test with the actual SIM. (https://www.kincony.com/images/SIM7600/SIM7500_SIM7600_Series_AT_Command_Manual_V2.00.pdf (2.2.2 ATD, 5.2.2 CHUP, 5.2.7 CLCC, 5.2.13 CLIR))
- **King Pigeon RTU5024 has no inputs and several undocumented replies** Terminals are only power +/-, relay NO/COM/NC and antenna - there is no digital input, so this unit can never report gate position; only relay ON/OFF confirmation (GON/GOFF) is available. Hardware RESET (hold button, power on, 6 s) restores password 1234 and parameters but keeps the authorised numbers. Time-limited numbers depend on the unit's clock, which is set by the mandatory pwdTEL...# step. Supply is specified as 9-24 VDC / 2 A (start-up peak), 12 V average 25 mA. Self-check report includes relay status and signal (below 14 = weak). The same pwdA dialect is still in manual V1.8 dated 2020-12-01. (https://dofygate.co.uk/wp-content/uploads/2020/01/RTU5024-GSM-Gate-Opener-User-Manual-V1.5.pdf ; http://www.rtu5024.com/download/RTU5024.pdf)
- **pwd# dialect: per-variant differences the adapter must handle** 64-user (Auto Entry V1.3): 2-digit slots, query '1234#TEL02', delete '1234#TEL#12#', reset by sending plain 'RESET' within 3 min of power-on, no ON/OFF SMS relay command, error text 'Command error, please re send command', relay SMS texts 'The relay is ON' / 'The Relay is OFF'. 200-user 'RTU5024 Ver 2.0': 3-digit slots, query '1234#TEL002?', delete '1234#TEL#012#', pwd#RESET# any time (reply 'Reset Success! Please Reboot your Device'), relay SMS goes only to slot 001 with text 'Relay ON! Operated by xxx' / 'Relay OFF! Operated by xxx', ON/OFF replies 'The relay is ON.' / 'The relay is OFF.', error text 'Command error, please resend command', no inputs. 999-user (Enerna V2.0): query '1234#TEL002?#', ON/OFF replies 'Relay turn ON.' / 'Relay turn OFF.', reset literal '1234#RESET#' within 3 min then power-cycle. All: SIM PIN must be disabled ('cannot support PIN Code Protected SIMCard'); with GOT00 (latch) the 64/999-user manuals say only slots 1-3 may operate the relay; CSQ reply range 0-31/32, 'above 12' needed. (https://peatsecurityproducts.ie/resources/files/GSM-Opener-User-Manual.pdf ; https://enerna-iotech.com/wp-content/uploads/2020/05/GSM-Gate-Opener-Remote-Switch-RTU5024-User-Manual-V3.0.pdf ; https://enerna-iotech.com/wp-content/uploads/2020/05/GSM-Access-Control-Gate-Opener-User-Manual.pdf)
- **'*12*' (First Fence PFGOGSM) dialect gotchas** Input 2 defaults to mode 0 = Egress (acts as an exit button that fires the relay); a reed switch on input 2 must first be set to Trigger with code 211#. Input 1 defaults to Trigger. Other codes: 01[pwd]# programming password, 11[0-99]# door-open confirming time, 14/16[1-9999]# activation time on input 1/2 trigger, 19[0|1]# input 2 NO/NC, 75[N]*# delete alarm contact N, 74*# delete admin, 999# factory reset, *23*1234# list alarm contacts, *32*1234#text# input-2 SMS text (max 100 chars; defaults 'trigger 1 is active' / 'trigger2 is active'). Programming replies are '<code># OK' or '<code># Error'; one SMS is limited to 140 characters; phone numbers 3-14 digits; default country code 886 must be changed (7191# for India). Hardware reset: hold red PCB button while powering up for 5 s. (https://media.firstfence.co.uk/docs/operation-and-maintenance/GSM-Opener-Operation-Manual.pdf)
- **WAFER GSM-KEY extra commands useful for status** #PWD123456#STATUS? returns e.g. 'ALARM1=ON:SMS:10,ALARM2=ON:SMS:20,GOT=1000,WHL=85,ALARM1=H,ALARM2=H,BCPW=34,CSQ=20,RELAY=ON' (relay and both input levels in one reply). #PWD123456#MODE0 = momentary pulse, MODE1 = ratchet/latching. Two alarm inputs configured with #PWD123456#ALARM-IN1=ON:SMS:2,ALARM-IN2=OFF; alarm numbers with #PWD123456#ALARM01=<number>. White list: #PWD123456#WHL001=<number>, query WHL001?, delete WHL001=0000000. Password change #PWD123456#CAP333444#CAP333444 -> 'PWD SETUP OK'. 200 regular numbers. (http://www.waferstar.com/downloads/GSM-KEY-DC200.pdf)
- **Shelly Gen2+ authentication is SHA-256 digest, not Basic** When a password is set, every /rpc call returns 401 with a WWW-Authenticate digest challenge. Username is always 'admin', realm is the device id (e.g. shelly1g4-xxxxxxxxxxxx), ha1 = SHA256('admin:<realm>:<password>'), response = SHA256(ha1:nonce:nc:cnonce:auth:ha2), algorithm SHA-256 (RFC 7616). Set with Shelly.SetAuth {user:'admin', realm, ha1}. Outbound webhooks carry no device auth, so the hub's hook URL should include its own secret token. Webhook limit is 20 per device. Webhook 'enable' defaults to false. WiFi.SetConfig on the STA drops the connection within about 1 s, so the HTTP reply may not arrive - confirm by re-discovering the device on the new network. (https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/ ; https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Webhook/ ; https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/WiFi/)
- **Shelly Gen1 details** /settings/actions accepts index, name, enabled, urls[] (max 5 URLs, 256 chars each); Shelly1 action names: btn_on_url, btn_off_url, longpush_url, shortpush_url, out_on_url, out_off_url (plus add-on temperature/humidity actions). btn_type values include toggle, momentary, edge, detached, momentary_on_release; default_state values are off/on/last/switch. /status 'inputs' entries carry input, event, event_cnt. /settings/login takes enabled, unprotected, username, password. /shelly (no auth) returns type, mac, auth, fw - use it for discovery/identification. (https://shelly-api-docs.shelly.cloud/gen1/)
- **Sonoff stock-firmware LAN protocol and DIY mode specifics** LAN (non-DIY): mDNS service _ewelink._tcp.local., HTTP POST http://<host>:<port|8081>/zeroconf/<switch|switches|info|...>, body {sequence:<ms timestamp string>, deviceid, selfApikey:'123', encrypt:true, iv:base64(16 random bytes), data:base64(AES-CBC, PKCS7, key=MD5(devicekey))}; responses and mDNS TXT data are encrypted the same way. Device key is per device and constant across re-pairing; it is fetched from the eWeLink cloud device list. DIY mode: device type diy_plug, TXT fields txtvers, id, type, apivers, seq, data1; minimum 200 ms between requests; error codes 400/401/404/422; additional endpoints /zeroconf/startup {startup: on|off|stay}, /zeroconf/ota_unlock, /zeroconf/ota_flash {downloadUrl, sha256sum}. Old firmware 3.3 entered DIY mode with a GPIO16 jumper and needed an AP named sonoffDiy / 20170618sn. Sonoff SV under Tasmota exposes spare GPIO4/GPIO5/GPIO14 for a reed switch and is isolated by removing the two 0-ohm resistors beside the jumper. (https://raw.githubusercontent.com/AlexxIT/SonoffLAN/master/custom_components/sonoff/core/ewelink/local.py ; https://help.sonoff.tech/docs/DIY-MODE-API-PROTOCOL ; https://github.com/itead/Sonoff_Devices_DIY_Tools/blob/master/other/SONOFF%20DIY%20MODE%20Protocol%20Doc%20v1.4.md ; https://tasmota.github.io/docs/devices/Sonoff-SV/)
- **eWeLink cloud endpoints (omitted by the researcher)** Asia host for India: https://as-apia.coolkit.cc (others cn-apia.coolkit.cn, us-apia.coolkit.cc, eu-apia.coolkit.cc). POST /v2/user/login with X-CK-Appid, X-CK-Nonce, Authorization: Sign <HMAC of body with app secret>. POST /v2/device/thing/status {type, id, params:{switch:'on'}} with Authorization: Bearer <at>. WebSocket dispatch https://as-dispa.coolkit.cc/dispatch/app. Requires an APPID/secret from the CoolKit developer platform. Extracted via a rendered-page query; re-read before implementing. (https://coolkit-technologies.github.io/eWeLink-API/#/en/APICenterV2)
- **Tuya Cloud signing algorithm and token call** Token: GET /v1.0/token?grant_type=1 with sign = UPPERCASE(HMAC-SHA256(client_id + t + nonce + stringToSign, secret)). Business calls: sign = UPPERCASE(HMAC-SHA256(client_id + access_token + t + nonce + stringToSign, secret)). stringToSign = HTTPMethod + '\n' + SHA256(body) + '\n' + signature headers + '\n' + URL path with sorted query; SHA256 of an empty body is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855. t is a 13-digit millisecond timestamp. tinytuya local: TCP 6668, UDP 6666/6667/7000 discovery, one TCP session per device (close the Smart Life app), errors returned as {Error, Err, Payload} codes 900-914, set_socketPersistent(True) to hold the connection. (https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g ; https://github.com/jasonacox/tinytuya)
- **Tasmota limits relevant to re-pointing WiFi** SSId<x> max 32 chars and Password<x> max 64 chars, neither may contain special characters or whitespace when set by command, and each command restarts the device (put them in one Backlog). WifiConfig 4 (default) retries the other AP without rebooting, which is the wanted behaviour for a primary/backup pair. Web API user is 'admin' (WebPassword). With SetOption114 1 plus SwitchMode 15 the switch is exposed as a pure sensor ({"Switch1":"ON"} on tele/<topic>/SENSOR). (https://tasmota.github.io/docs/Commands/ ; https://tasmota.github.io/docs/Buttons-and-Switches/)
- **CAME / BFT / Nice adapter details not in the claims** CAME: integration is confirmed only on a ZLX24SA board; token TTL from expires_in (refresh ~60 s early); on 401 re-run auth-code + token; 400 with error invalid_grant/invalid_client means bad credentials. BFT: diagnosis JSON fields first_engine_pos_int, second_engine_pos_int, first_engine_vel_int, second_engine_vel_int (open = both 100 and velocities 0; closed = both 0; moving = any velocity > 0; stopped otherwise); 401/403 -> re-authenticate once; token revoke is DELETE {PARTICLE_URL}/v1/access_tokens/{token} with Basic user:password; default timeout 10 s, 3 retries. Nice: the README warns not to update BiDi-WiFi firmware beyond 2.6.4 without retesting because authentication/framing on TCP 443 may change; openHAB MyNice bridge parameters are hostname, macAddress, username (pairing key) and password, and gates are addressed by their id on the T4 bus. (https://raw.githubusercontent.com/sdeagh/came_connect/main/README.md ; https://raw.githubusercontent.com/emanuelbesliu/homeassistant-bft/main/custom_components/bft/bft_api.py ; https://github.com/Jordi-14/homeassistant_nice ; https://www.openhab.org/addons/bindings/mynice/)
- **A GSM opener variant with real digital inputs exists (RTU5025)** BLIIoT/King Pigeon RTU5025 has 2 NC/NO dry-contact inputs ('one channel fixed for access control', SMS alert to owner when triggered), 1 relay 3A/240VAC, up to 3000 numbers, 9-36 VDC, optional WCDMA/TDD-LTE/FDD-LTE, configured by Android app or PC software over USB. This is the model to look at if gate-position feedback over the SIM path is required; its SMS command set was not retrieved (confidence low on protocol). (https://bliiot.com/products/gsm-gprs-3g-4g-gate-opener-relay-switch-rtu5025)
- **4G RTU5024 band list vs Indian networks (confidence low - no primary source found)** The only band list found (B1/B3/B5/B7/B8/B20) comes from a third-party blog; manufacturer pages list no bands and sell region-specific variants. Missing B40/B41 (TDD) removes Jio/Airtel TDD capacity layers, but Indian operators also run FDD LTE on bands in that list (commonly B3 1800 MHz and B5 850 MHz for Jio; B1/B3/B8 for Airtel/Vi) - this is general knowledge, not confirmed from an operator document here. Ask the seller for the exact module/band variant and confirm VoLTE works with the chosen SIM before buying, because a Jio SIM has no 2G/3G fallback for the voice call. (https://gate-opener.app/blog/future-proof-gate-opener-4g/ ; https://www.iot-solution.com/gsm-gate-opener-p00211p1.html)
- **Shelly garage guide configuration for state feedback** Recommended unit is Shelly 1 Gen4 with the Shelly Plus Add-On; the reed switch goes on the Add-On digital input with 'Invert input' enabled and digital input type 'Garage'. Shelly Plus Uni, Shelly 1 Mini Gen4 and Shelly Pro 1 are listed for installs without status. Relay O/I contacts go in parallel with the existing push-button input of the opener, Auto-Off 1 s. (https://shelly.guide/en/application-guide/garage-door-control/)

## Calls

### GSM opener (King Pigeon RTU5024) — missed-call OPEN pulse from hub modem

```
serial AT ATD+91XXXXXXXXXX;   (then after ~5 s: AT+CHUP)
```
- Params: Number of the SIM inside the opener; hub SIM's own number must be in the opener's authorised list (caller-ID must not be withheld)
- Auth: Caller-ID (authorised list)
- Response: OK then 'VOICE CALL:BEGIN'; the opener rejects the call so the modem soon reports NO CARRIER / 'VOICE CALL:END:HHMMSS'
- Notes: Free call. Relay closes for GOT seconds (default 0.5 s when GOT=000). A second call within the GOT window releases the relay early. Set AT+CVHU=0 once if you prefer ATH over AT+CHUP.
- Source: https://www.kincony.com/images/SIM7600/SIM7500_SIM7600_Series_AT_Command_Manual_V2.00.pdf

### Hub modem — send SMS config command (text mode)

```
serial AT AT+CMGF=1\r  then  AT+CMGS="+91XXXXXXXXXX"\r  wait for '>'  then  <SMS text> + 0x1A (Ctrl-Z)
```
- Params: AT+CMGF=1 (text mode); AT+CSCS="GSM" optional; ESC (0x1B) cancels
- Auth: none (SIM PIN removed)
- Response: +CMGS: <mr>  OK   (or +CMS ERROR: <err>)
- Notes: Max 160 chars GSM-7. Incoming replies: AT+CNMI=1,2,0,0,0 (manual example) then read unsolicited +CMT/+CMTI; AT+CMGR=<index> reads, AT+CMGD=<index> deletes.
- Source: https://www.kincony.com/images/SIM7600/SIM7500_SIM7600_Series_AT_Command_Manual_V2.00.pdf

### Hub modem — signal and registration check

```
serial AT AT+CSQ   /   AT+CREG?   /   AT+CPIN?   /   AT+CLIP=1
```
- Params: none
- Auth: none
- Response: +CSQ: <rssi 0-31>,<ber>; +CREG: <n>,<stat>; +CPIN: READY; +CLIP presents caller ID on incoming RING
- Notes: Use +CLIP so the hub can itself act as a 'missed-call receiver' (e.g. an opener that dials back, or the owner's phone ringing the hub).
- Source: https://www.kincony.com/images/SIM7600/SIM7500_SIM7600_Series_AT_Command_Manual_V2.00.pdf

### RTU5024 (King Pigeon dialect) — mandatory start: tell unit its own number

```
sms SMS 1234TEL<opener SIM number>#   e.g. 1234TEL00919XXXXXXXXX#
```
- Params: pwd default 1234; CAPITALS, no spaces
- Auth: password in message
- Response: Set Suces!
- Notes: Required once after install (sets time). No reply at all if the command is malformed.
- Source: https://dofygate.co.uk/wp-content/uploads/2020/01/RTU5024-GSM-Gate-Opener-User-Manual-V1.5.pdf

### RTU5024 (King Pigeon dialect) — change password

```
sms SMS 1234P6666
```
- Params: pwd + P + new 4-digit password
- Auth: password
- Response: Password changed to 6666, please remember it carefully.
- Source: https://dofygate.co.uk/wp-content/uploads/2020/01/RTU5024-GSM-Gate-Opener-User-Manual-V1.5.pdf

### RTU5024 (King Pigeon dialect) — add / time-limit / query / list / delete authorised number

```
sms SMS 1234A003#919XXXXXXXXX#   |  1234A016#919XXXXXXXXX#2609301800#2609302000#   |  1234A002#   |  1234AL002#050#   |  1234A002##
```
- Params: A + serial 001-200 + # + number + # [+ start yymmddhhmm + # + end + #]; AL = list range (10 numbers per reply SMS); A<serial>## deletes
- Auth: password
- Response: Set Suces! / number list SMS
- Notes: Serial position 001 is 'the 1st number' that receives confirmation SMS and self-check reports — store the HUB's SIM there.
- Source: https://dofygate.co.uk/wp-content/uploads/2020/01/RTU5024-GSM-Gate-Opener-User-Manual-V1.5.pdf

### RTU5024 (King Pigeon dialect) — relay pulse length (GOT) and access mode

```
sms SMS 1234GOT030#   |   1234GOT000#   |   1234GOT999#   |   1234AUT#   |   1234ALL#
```
- Params: GOT close time 000-999 s (000 = 0.5 s pulse, 999 = latch until next call); AUT = authorised only (default); ALL = any caller
- Auth: password
- Response: Set Suces!
- Notes: For a gate push-button input use GOT000 or GOT001. Never use ALL# on a gate.
- Source: https://dofygate.co.uk/wp-content/uploads/2020/01/RTU5024-GSM-Gate-Opener-User-Manual-V1.5.pdf

### RTU5024 (King Pigeon dialect) — 'done' confirmation SMS on relay ON/OFF

```
sms SMS 1234GON11#Gate Open#   |   1234GOFF10#Gate Closed#   |   1234GON##  (disable)  |  1234GOFF##
```
- Params: ab digits: a = send to 1st stored number, b = send to caller (1 enable / 0 disable); content = free text
- Auth: password
- Response: unit later sends 'Gate Open' / 'Gate Closed' to the selected numbers whenever the relay changes
- Notes: This is the SIM-path completion notification: the hub's SIM (position 001) receives the text and the hub pushes the phone notification.
- Source: https://dofygate.co.uk/wp-content/uploads/2020/01/RTU5024-GSM-Gate-Opener-User-Manual-V1.5.pdf

### RTU5024 (King Pigeon dialect) — relay ON/OFF by SMS (no call)

```
sms SMS 1234CC   |   1234DD
```
- Params: CC = relay ON (closes for GOT seconds), DD = relay OFF
- Auth: password
- Response: Relay ON  /  Relay OFF  (or the custom GON/GOFF text)
- Notes: Use CC as the SMS fallback when the missed-call path fails (e.g. caller-ID not delivered).
- Source: https://dofygate.co.uk/wp-content/uploads/2020/01/RTU5024-GSM-Gate-Opener-User-Manual-V1.5.pdf

### RTU5024 (King Pigeon dialect) — status / self-check / IMEI

```
sms SMS 1234EE   |   1234T#024#   |   1234T#   |   1234IMEI#
```
- Params: EE = current status; T#xxx# = auto-report every xxx hours (000 off) to 1st number (relay status + GSM signal 0-31); IMEI# = module IMEI + firmware
- Auth: password
- Response: status SMS (relay state, signal)
- Notes: Use 1234EE as the dialect probe: if it answers, the unit is King Pigeon syntax.
- Source: https://dofygate.co.uk/wp-content/uploads/2020/01/RTU5024-GSM-Gate-Opener-User-Manual-V1.5.pdf

### GSM opener ('pwd#CMD#' dialect, 64/200/999-user units) — change password

```
sms SMS 1234#PWD6666#PWD6666#
```
- Params: new password twice
- Auth: password
- Response: Password modified OK.
- Notes: CAPITALS, no spaces. Wrong syntax → 'Command error, please re send command'.
- Source: https://peatsecurityproducts.ie/resources/files/GSM-Opener-User-Manual.pdf

### GSM opener ('pwd#CMD#' dialect) — add / query / delete authorised number

```
sms SMS 1234#TEL919XXXXXXXXX#01#   (64-user: 2-digit serial 01-64)   |   1234#TEL00919XXXXXXXXX#001#   (999-user: 3-digit serial)   |   1234#TEL02   or   1234#TEL002?#   (query)   |   1234#TEL#12#   (delete, 64-user)   |   1234#DEL<number>#   (delete, 999-user manual)
```
- Params: positions 01/02 (or 001/002) receive alarm SMS — put the hub SIM there
- Auth: password
- Response: e.g. 'Tel 1: 004413500001111; Tel 2: Empty; …'
- Notes: The 999-user manual's delete example is inconsistent (shows 1234#TEL13500001111#); test on the real unit.
- Source: https://enerna-iotech.com/wp-content/uploads/2020/05/GSM-Access-Control-Gate-Opener-User-Manual.pdf

### GSM opener ('pwd#CMD#' dialect) — relay pulse time and access mode

```
sms SMS 1234#GOT02#   (=1.0 s)   |   1234#GOT19#   (=9.5 s)   |   1234#GOT00#   (latch until next call)   |   1234#GOT?   |   1234#AU#   |   1234#AA#   |   1234#AC?#
```
- Params: GOT value 00-19, pulse = value x 0.5 s, default 0.5 s
- Auth: password
- Response: GOT? → current value; AC?# → 'Allow User Number can access it only'
- Notes: With GOT00 only the 1st-3rd numbers may operate the unit.
- Source: https://peatsecurityproducts.ie/resources/files/GSM-Opener-User-Manual.pdf

### GSM opener ('pwd#CMD#' dialect) — enable relay-action confirmation SMS, signal, relay by SMS

```
sms SMS 1234#R#   (enable)  |  1234#N#  (disable)  |  1234#M?  (query)  |  1234#CSQ?  |  1234#ON#  |  1234#OFF#  |  1234#RESET#
```
- Params: RESET only accepted within 3 min after power-on (GSM LED red)
- Auth: password
- Response: R → later 'The relay is ON' / 'The Relay is OFF' on every relay action; CSQ? → 0-31 (need >12); ON → 'Relay turn ON.'; OFF → 'Relay turn OFF.'; RESET → 'Reset ok'
- Notes: 1234#ON#/#OFF# documented in the 999-user (Enerna) manual; #R#/#N#/#CSQ? in both.
- Source: https://enerna-iotech.com/wp-content/uploads/2020/05/GSM-Access-Control-Gate-Opener-User-Manual.pdf

### GSM opener ('pwd#CMD#' dialect) — reed-switch state over SMS via alarm inputs

```
sms SMS 1234#EA#   |   1234#DA#   |   1234#AL?   |   1234#KEYNO#   |   1234#KEYNC#   |   1234##TEXT1OGate opened#   |   1234##TEXT1CGate closed#
```
- Params: EA/DA enable/disable inputs; KEYNO/KEYNC input polarity; TEXT1O/TEXT1C = input-1 open/close message (999-user unit), TEXT1/TEXT2 on 64-user unit
- Auth: password
- Response: Alarm Inputs Enabled / Disabled; on input change the unit SMSes the configured text to positions 001 and 002
- Notes: Inputs arm only 10 minutes after the last call-in (manual), so state texts are suppressed right after an open — treat as a delayed report, not real-time.
- Source: https://enerna-iotech.com/wp-content/uploads/2020/05/GSM-Access-Control-Gate-Opener-User-Manual.pdf

### GSM opener ('*12*' Gainwise-type dialect) — set admin number, add / delete users, list

```
sms SMS *12*1234#74919XXXXXXXXX#   (admin, first)   |   *12*1234#7191#7219XXXXXXXXX#7219XXXXXXXXX#   (country code 91 + users)   |   *12*1234#739XXXXXXXXX#   (delete)   |   *12*1234#73*#   (delete all)   |   *22*1234#   (list)
```
- Params: country code without leading zeros; numbers 3-14 digits; up to 100 users; several codes per SMS after one *12*1234# prefix
- Auth: programming password 1234
- Response: '<code># OK' or '<code># Error'; *22* → number list ('E: next page, N: end')
- Notes: Same strings can be keyed as DTMF after dialling in (unit answers with a beep).
- Source: https://media.firstfence.co.uk/docs/operation-and-maintenance/GSM-Opener-Operation-Manual.pdf

### GSM opener ('*12*' dialect) — pulse / latch / release relay and relay time

```
sms SMS *71*5678#   (trigger/pulse)   |   *72*5678#   (hold)   |   *73*5678#   (release)   |   *12*1234#121#   (relay activation time 1 s; 12[1-9999]#)   |   *12*1234#02<newpwd>#   (access password)
```
- Params: 5678 = default access password
- Auth: access password 5678
- Response: no reply for *71/*72/*73
- Notes: Stored numbers open by caller-ID (call rejected, free); unknown numbers are answered and can open by entering *71*5678# as DTMF.
- Source: https://media.firstfence.co.uk/docs/operation-and-maintenance/GSM-Opener-Operation-Manual.pdf

### GSM opener ('*12*' dialect) — read relay + input state, signal, input alarms

```
sms SMS *24*1234#   |   *21*1234#   |   *12*1234#180#   (input1 NO)   |   *12*1234#201#   (input1 mode trigger)   |   *12*1234#751919XXXXXXXXX#   (alarm contact 1)   |   *31*1234#Gate closed#   (input-1 text)
```
- Params: inputs 1-2 dry contacts; 15[min]#/17[min]# repeat SMS while input stays triggered
- Auth: programming password
- Response: *24* → 'Relay 1: hold/release/trigger, Input 1: high/low, Input 2: high/low'; *21* → 'Signal Level = 0~31' + operator
- Notes: Wire the gate's reed switch to Input 1 to get OPEN/CLOSED over SMS on demand when WiFi is down.
- Source: https://media.firstfence.co.uk/docs/operation-and-maintenance/GSM-Opener-Operation-Manual.pdf

### WAFER GSM-KEY (AC200/DC200) — relay pulse time (unverified)

```
sms SMS #PWD123456#GOT500
```
- Params: 6-digit password (default 123456); GOT in milliseconds (default 300)
- Auth: password
- Response: OK / Err
- Notes: From a search snippet only; manual mirrors were unreachable. Verify against the printed manual before implementing.
- Source: https://www.manualslib.com/manual/1156368/Wafer-Dc200.html

### Shelly Gen2+ — one-shot gate pulse

```
http GET http://<ip>/rpc/Switch.Set?id=0&on=true&toggle_after=1
```
- Params: id, on (bool), toggle_after (seconds), tag
- Auth: none unless device password set
- Response: {"was_on":false}
- Notes: POST equivalent: POST http://<ip>/rpc {"id":1,"method":"Switch.Set","params":{"id":0,"on":true,"toggle_after":1}}. Relay COM/NO across the gate board's button input (in parallel with wall button).
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/

### Shelly Gen2+ — persistent gate-safe relay config (detached input, auto-off 1 s)

```
http GET http://<ip>/rpc/Switch.SetConfig?id=0&config={"in_mode":"detached","auto_off":true,"auto_off_delay":1,"initial_state":"off"}
```
- Params: in_mode momentary|follow|flip|detached|cycle|activate; auto_off_delay seconds; initial_state off|on|restore_last|match_input
- Auth: none unless set
- Response: {"restart_required":false}
- Notes: Then a plain Switch.Set?id=0&on=true is always a 1 s pulse and the SW input never drives the relay. initial_state off prevents a relay pulse at power-up.
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/

### Shelly Gen2+ — read relay/pulse status

```
http GET http://<ip>/rpc/Switch.GetStatus?id=0
```
- Params: id
- Auth: none unless set
- Response: {"id":0,"source":"HTTP","output":true,"timer_started_at":…,"timer_duration":1,…}
- Notes: output returning to false after timer_duration confirms the pulse was delivered (not that the gate moved).
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/

### Shelly Gen2+ — reed switch on SW input: configure and read

```
http GET http://<ip>/rpc/Input.SetConfig?id=0&config={"type":"switch","invert":false,"enable":true}   then   http://<ip>/rpc/Input.GetStatus?id=0
```
- Params: type switch|button|analog|count; invert
- Auth: none unless set
- Response: {"id":0,"state":true}   (true = contact closed = magnet present = gate CLOSED when reed is at the closed position)
- Notes: Wire reed between L/ground reference and SW as per model; use invert to make state=true mean CLOSED.
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Input/

### Shelly Gen2+ — push gate-state events to the hub (webhooks)

```
http GET http://<ip>/rpc/Webhook.Create?cid=0&enable=true&event="input.toggle_on"&urls=["http://<hub>/hook/gate/closed"]   and   …event="input.toggle_off"&urls=["http://<hub>/hook/gate/open"]
```
- Params: cid, event, urls (≤5, ≤300 chars), name, condition, repeat_period, active_between, ssl_ca
- Auth: none unless set
- Response: {"id":<hook id>,"rev":n}
- Notes: Also switch.off after the pulse can hit http://<hub>/hook/gate/pulsed. Webhook.ListSupported lists events. Tokens like ${ev.state} can be embedded in the URL.
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Webhook/

### Shelly Gen2+ — re-point WiFi (primary + fallback) and check link

```
http GET http://<ip>/rpc/WiFi.SetConfig?config={"sta":{"ssid":"HomeWiFi","pass":"…","enable":true},"sta1":{"ssid":"Backup4G","pass":"…","enable":true}}   |   http://<ip>/rpc/WiFi.GetStatus   |   http://<ip>/rpc/WiFi.Scan
```
- Params: sta/sta1: ssid, pass, enable, ipv4mode, ip, netmask, gw, nameserver; roam.rssi_thr, roam.interval
- Auth: none unless set
- Response: {"restart_required":false}; GetStatus → {sta_ip, status: got ip, ssid, rssi}
- Notes: Set sta1 to the SIM-router's SSID so the Shelly falls back automatically when the home WiFi is reset. Device AP (ssid=deviceID) stays available for recovery.
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/WiFi/

### Shelly Gen1 (Shelly 1) — timed pulse, config, status, WiFi, action URLs

```
http GET http://<ip>/relay/0?turn=on&timer=1   |   http://<ip>/settings/relay/0?auto_off=1&btn_type=detached&default_state=off   |   http://<ip>/status   |   http://<ip>/settings/sta?ssid=HomeWiFi&key=…&enabled=1   |   http://<ip>/settings/actions?index=0&name=btn_on_url&enabled=true&urls[]=http://<hub>/hook/gate/closed
```
- Params: turn on|off|toggle; timer seconds; btn_type toggle|momentary|momentary_on_release|detached
- Auth: HTTP Basic if enabled via /settings/login
- Response: /status → {"relays":[{"ison":true,…}],"inputs":[{"input":0,…}],…}
- Notes: inputs[0].input is the SW terminal (reed). btn_off_url / out_on_url / out_off_url also available.
- Source: https://shelly-api-docs.shelly.cloud/gen1/

### Sonoff DIY mode (BASICR3/RFR3/MINI R2/R3) — set inching (pulse) mode

```
http POST http://<ip>:8081/zeroconf/pulse   body {"deviceid":"<id>","data":{"pulse":"on","pulseWidth":1000}}
```
- Params: pulseWidth ms, multiples of 500, 500-36000000
- Auth: none (DIY mode is unencrypted)
- Response: {"seq":n,"error":0,"data":{}}
- Notes: Discover via mDNS _ewelink._tcp (TXT id/type/apivers/seq/data1). Errors 400/401/404/422.
- Source: https://help.sonoff.tech/docs/DIY-MODE-API-PROTOCOL

### Sonoff DIY mode — fire the pulse / read state

```
http POST http://<ip>:8081/zeroconf/switch   body {"deviceid":"<id>","data":{"switch":"on"}}   |   http://<ip>:8081/zeroconf/info   body {"deviceid":"<id>","data":{}}
```
- Params: switch on|off
- Auth: none
- Response: info → {"seq":2,"error":0,"data":{"switch":"on","startup":"stay","pulse":"on","pulseWidth":1000,"ssid":"…","otaUnlock":true}}
- Notes: With pulse on, switch on auto-releases after pulseWidth. Set /zeroconf/startup {"startup":"off"} so a power cut never leaves the relay closed.
- Source: https://help.sonoff.tech/docs/DIY-MODE-API-PROTOCOL

### Sonoff DIY mode — re-point to another WiFi / signal

```
http POST http://<ip>:8081/zeroconf/wifi   body {"deviceid":"<id>","data":{"ssid":"Backup4G","password":"…"}}   |   http://<ip>:8081/zeroconf/signal_strength
```
- Params: ssid, password
- Auth: none
- Response: {"seq":n,"error":0}
- Notes: Device reboots onto the new SSID; if it fails you must use the ITEAD-XXXXXXXXXX AP (pw 12345678, http://10.10.7.1/) again. Only one SSID stored (no fallback list).
- Source: https://github.com/itead/Sonoff_Devices_DIY_Tools/blob/master/other/SONOFF%20DIY%20MODE%20Protocol%20Doc%20v1.4.md

### Sonoff SV (stock firmware) — LAN-mode control via SonoffLAN / pysonofflanr3 (encrypted)

```
http WebSocket/HTTP :8081 pysonofflanr3 --host <ip> --device_id <id> --api_key <device key> on   (library call; raw frames are AES-encrypted with the device key)
```
- Params: device id + device key obtained from the eWeLink account
- Auth: eWeLink device key
- Response: state on/off
- Notes: Sonoff SV is not on the official DIY list; either use LAN mode with the key, or flash Tasmota/ESPHome for the open HTTP API. Set 'inching' in the eWeLink app so LAN 'on' becomes a pulse.
- Source: https://pysonofflanr3.readthedocs.io/readme.html

### Tasmota (Sonoff SV/Basic/any ESP relay) — one-time gate config

```
http GET http://<ip>/cm?user=admin&password=<pw>&cmnd=Backlog%20PulseTime1%2010%3B%20SwitchMode1%201%3B%20SetOption114%201%3B%20PowerOnState%200%3B%20TelePeriod%2060
```
- Params: PulseTime1 10 = 1.0 s (1..111 = 0.1 s units; 112..64900 = seconds+100); SwitchMode1 1 = follow (closed=ON); SetOption114 1 = detach switches from relays and publish switch events
- Auth: web password if set
- Response: {"PulseTime1":{"Set":10,"Remaining":0},…}
- Notes: Wire reed between the Switch GPIO and GND. SwitchMode 2 inverts if you want ON = OPEN.
- Source: https://tasmota.github.io/docs/Commands/

### Tasmota — pulse the gate and read state

```
http GET http://<ip>/cm?cmnd=Power1%20ON   |   http://<ip>/cm?cmnd=Status%2010
```
- Params: Power1 0/1/2 (off/on/toggle)
- Auth: web password if set
- Response: {"POWER1":"ON"} then {"POWER1":"OFF"} after PulseTime; Status 10 → StatusSNS with "Switch1":"ON|OFF"
- Source: https://tasmota.github.io/docs/Commands/

### Tasmota — MQTT command/state topics for the hub broker

```
mqtt PUBLISH/SUBSCRIBE publish cmnd/<topic>/POWER1 ON   ;   subscribe stat/<topic>/RESULT  (→ {"POWER1":"ON"} and, with SetOption114 1, {"Switch1":{"Action":"ON"}} on reed change)   ;   subscribe tele/<topic>/SENSOR (periodic Switch1 state)
```
- Params: MqttHost/MqttUser/MqttPassword set on device
- Auth: broker credentials
- Response: JSON payloads as shown
- Notes: SetOption114 switch events are instantaneous; SENSOR telemetry only every TelePeriod.
- Source: https://tasmota.github.io/docs/Buttons-and-Switches/

### Tasmota — store two WiFi networks and switch

```
http GET http://<ip>/cm?cmnd=Backlog%20SSId1%20HomeWiFi%3B%20Password1%20…%3B%20SSId2%20Backup4G%3B%20Password2%20…%3B%20Restart%201   |   http://<ip>/cm?cmnd=AP%202
```
- Params: SSId<x>/Password<x> x=1..2; AP 0 = switch to other, 1/2 = select
- Auth: web password if set
- Response: {"SSId1":"HomeWiFi",…}
- Notes: Tasmota auto-fails over between AP1 and AP2 when one is unreachable.
- Source: https://tasmota.github.io/docs/Commands/

### Tuya garage-door module — local control with tinytuya

```
http library (Tuya local protocol, TCP 6668) d = tinytuya.OutletDevice('<dev_id>','<ip>','<local_key>', version=3.3); d.set_value(1, True)   # switch_1 → module pulses relay ; d.status()['dps']  # {'1': False, '3': False, ...}
```
- Params: dev_id, ip, local_key (16 chars, from 'python -m tinytuya wizard'), version 3.1-3.5
- Auth: local key
- Response: {'dps': {'1': <switch_1>, '3': <doorcontact_state>, ...}}
- Notes: DP 1 = switch_1, DP 3 = doorcontact_state per HA community mapping (Tuya docs give codes, not ids — confirm with d.status()). Local key changes if the device is re-paired; Tuya has no local WiFi-change call.
- Source: https://github.com/jasonacox/tinytuya

### Tuya Cloud OpenAPI (India DC) — command and status

```
cloud POST / GET POST https://openapi.tuyain.com/v1.0/devices/{device_id}/commands   body {"commands":[{"code":"switch_1","value":true}]}   |   GET https://openapi.tuyain.com/v1.0/devices/{device_id}/status
```
- Params: headers client_id, sign, sign_method=HMAC-SHA256, t (13-digit ms), access_token, nonce
- Auth: Tuya IoT project client_id/secret + token
- Response: {"result":true,"success":true,…} ; status → [{"code":"switch_1","value":false},{"code":"doorcontact_state","value":false}]
- Notes: Only useful if the Tuya module itself can reach the internet (e.g. on the SIM router's WiFi); it does not help while the module's WiFi is down.
- Source: https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4

### Nice BiDi-WiFi / IT4WIFI — local NHK/T4 (undocumented; via integration code)

```
https TLS/TCP 443 (proprietary) NHK 'DoorAction' service: open | stop | close | step-by-step | partial 1/2/3 ; status from DMP register 04/01, position 04/11, 04/18, 04/19; live STATUS/CHANGE events
```
- Params: per-device NHK credentials (imported from MyNice account or extracted); certificate verification disabled (self-signed)
- Auth: NHK credentials / pairing key granted in MyNice app
- Response: gate state open/closed/opening/closing/stopped + position
- Notes: Not a public API: port the Jordi-14/homeassistant_nice (BiDi-WiFi) or openHAB MyNice (IT4WIFI, mDNS + MAC + pairing key) implementation. Cloud fallback via the Nice relay is optional.
- Source: https://github.com/Jordi-14/homeassistant_nice

### CAME Connect (cloud, unofficial) — auth

```
cloud POST POST https://app.cameconnect.net/api/oauth/auth-code (PKCE S256, redirect https://app.cameconnect.net/role)   then   POST https://app.cameconnect.net/api/oauth/token
```
- Params: username/password; client_id & client_secret scraped from https://www.cameconnect.net/main.XXX.js sent as Basic auth
- Auth: CAME Connect account
- Response: access token
- Notes: Reverse-engineered by the came_connect HA integration; CAME may change it at any time.
- Source: https://raw.githubusercontent.com/sdeagh/came_connect/main/custom_components/came_connect/api.py

### CAME Connect (cloud, unofficial) — discover, command, status, events

```
cloud GET/POST/WSS GET https://app.cameconnect.net/api/evo/v1/sites   |   GET …/api/evo/v1/sites/{site_id}/devices   |   POST https://app.cameconnect.net/api/automations/{device_id}/commands/{command_id}   (2 = open, 5 = close, 129 = stop)   |   GET …/api/devicestatus   |   wss://app.cameconnect.net/api/events-real-time
```
- Params: Bearer token; WebSocket token passed as subprotocol
- Auth: Bearer
- Response: EventId 21 VarcoStatusUpdate {phase, percent}; phase 16 open, 17 closed, 32 opening, 33 closing, 19 stopped
- Notes: Position 0-100 also lets you infer direction from deltas.
- Source: https://raw.githubusercontent.com/sdeagh/came_connect/main/custom_components/came_connect/const.py

### BFT U-Link / uControl (cloud, unofficial) — login and device list

```
cloud POST / GET POST https://ucontrol-api.bft-automation.com/oauth/token   body grant_type=password&username=…&password=…  (Basic auth particle:particle)   |   GET https://ucontrol-api.bft-automation.com/api/v1/users/?access_token=<token>
```
- Params: BFT uControl account
- Auth: OAuth password grant, client 'particle'/'particle'
- Response: {access_token}; users → data.automations[].uuid, info.name
- Notes: Requires the BFT U-Link + gateway hardware registered to a uControl account.
- Source: https://raw.githubusercontent.com/emanuelbesliu/homeassistant-bft/main/custom_components/bft/bft_api.py

### BFT uControl (cloud, unofficial) — open/close/stop/diagnosis

```
cloud GET GET https://ucontrol-dispatcher.bft-automation.com/automations/{uuid}/execute/{open|close|stop|diagnosis}
```
- Params: Authorization: Bearer <access_token>
- Auth: Bearer
- Response: diagnosis → {first_engine_pos_int, second_engine_pos_int, first_engine_vel_int, second_engine_vel_int} (0 = closed, 100 = open); HTTP 400 'socket not found' = gate offline
- Notes: Poll 5 s while moving, 30 s at rest (integration defaults).
- Source: https://raw.githubusercontent.com/emanuelbesliu/homeassistant-bft/main/custom_components/bft/bft_api.py

### FAAC E145 board — open-source serial gateway (MQTT + REST)

```
mqtt PUBLISH/SUBSCRIBE publish faac/gate/command  open|close|stop   ;   subscribe faac/gate/state (OPEN/CLOSED/MOVING/STOPPED), faac/gate/status (JSON), faac/gate/wing1, faac/gate/wing2 (0-100 %), faac/gate/availability   ;   REST POST /api/command {"command":"open"}
```
- Params: gateway (Python) connected to the E145 via USB/serial
- Auth: broker
- Response: state topics
- Notes: Only for FAAC E145 controllers; FAAC Simply Connect itself has no public API found.
- Source: https://github.com/jens62/FAAC-E145-Gate-Connect

### Generic sliding-gate board (THD SL1500ACL-type) — relay-to-terminal map

```
serial dry-contact pulse (0.5-1 s) Relay COM → J2 pin 5 'Common Signal'; Relay NO → J2 pin 6 'Cyclical Signal' (single-button OPEN→STOP→CLOSE→STOP) — or three relays NO → pin 3 'Open', pin 2 'Close', pin 4 'Stop'; pin 1 'Pedestrian'
```
- Params: DIP6 down = single-button cycle (default); DIP6 up = separate buttons; DIP3/4 auto-close 12/24/36 s
- Auth: n/a
- Response: n/a (limit switches on J5 pins 13 open / 12 common / 11 close stop the motor)
- Notes: Photocell NC on J5 pin 8 (IR NC) — keep it. Do not parallel your reed with the board's own limit inputs; use a separate reed pair to the Shelly/Tasmota input.
- Source: https://images.thdstatic.com/catalog/pdfImages/8a/8ab75792-d09e-48eb-9e2b-528ea94b9b4b.pdf

### Nice control board (RD400-type) — relay-to-terminal map

```
serial dry-contact pulse Relay NO across terminals 1-2 'STEP-BY-STEP' (NO); STOP = terminals 3-4 (NC/NO/8.2k, learnt); PHOTO = 4-6 (NC)
```
- Params: L2 'Step-by-Step function': Open-Stop-Close-Open | Open-Stop-Close-Stop | Condominium; pause 15/30/60 s
- Auth: n/a
- Response: n/a
- Notes: Holding SbS >3 s = 'always open' (gate stays open while contact held) — keep pulses short.
- Source: https://www.niceforyou.com/sites/default/files/upload/manuals/idv0615a00en.pdf

## Facts

- **RTU5024 (King Pigeon) opens the gate on a free call: it rejects the call from an authorised caller-ID on the first ring and then pulses the relay; unknown callers are ignored.** [high] Manual V1.5: 'No call charges. the GSM GPRS Relay Switch rejects the call from authorized number then carries out the turn ON/OFF action on the first ring'; 'Secure - Using caller-ID for identification, unknown callers are ignored'. Up to 200 authorised numbers, one NO/NC dry-contact relay rated 3A/240VAC, 9-24 VDC supply, quad-band 850/900/1800/1900 MHz (2G). (https://dofygate.co.uk/wp-content/uploads/2020/01/RTU5024-GSM-Gate-Opener-User-Manual-V1.5.pdf)
- **RTU5024 relay behaviour toggles on every call: a second call inside the GOT window releases the relay early.** [high] Manual note 3: 'The relay output will change the close or open status by every call in... if the second call in is in the setting time, then the unit will ignore the setting time, and open the relay'. GOT close time 000-999 s; 000 = 0.5 s pulse (latch use), 999 = stay closed until next call. (https://dofygate.co.uk/wp-content/uploads/2020/01/RTU5024-GSM-Gate-Opener-User-Manual-V1.5.pdf)
- **RTU5024 commands must be CAPITAL letters with no spaces, and the unit sends NO reply on a malformed command; add the country code (+91/0091) if SMS/calls are not recognised.** [high] Manual notes 4, 7, 8. Default password 1234. The unit can send a confirmation SMS when the relay goes ON/OFF to the 1st stored number and/or the caller (GON/GOFF commands) — this is the 'done' notification over the SIM path. (https://dofygate.co.uk/wp-content/uploads/2020/01/RTU5024-GSM-Gate-Opener-User-Manual-V1.5.pdf)
- **A second, widely re-sold GSM opener family uses the 'pwd#COMMAND#' dialect (e.g. 1234#TEL…#01#, 1234#GOT19#, 1234#R#); the relay pulse is (GOT value x 0.5 s), default 0.5 s, max 9.5 s, 00 = latch.** [high] Auto Entry Systems manual V1.3 (64 users, 3A relay, 12 VDC, 900/1800 MHz, two alarm inputs): '#GOT19# means the relay closed 19/2=9.5Seconds'; '#GOT00#, the relay will be always closed until next time call in'. Error reply: 'Command error, please re send command'. Enable relay-action SMS with pwd#R# (reply 'The relay is ON'/'The Relay is OFF'). (https://peatsecurityproducts.ie/resources/files/GSM-Opener-User-Manual.pdf)
- **The same 'pwd#' dialect is shipped by Enerna IoTech as a 999-user, 6A/240VAC unit (V2.0, 2019) with 3-digit serials (1234#TEL0044…#001#), 1234#TEL002?# query, 1234#ON#/1234#OFF# relay SMS control and 1234#RESET# factory reset within 3 min of power-on.** [high] Manual also documents per-input open/close alarm texts (pwd##TEXT1O…#, pwd##TEXT1C…#) that are SMSed to positions 001/002 when an input changes, usable as a reed-switch gate-state report over SMS. Work frequency 900/1800 MHz (2G). (https://enerna-iotech.com/wp-content/uploads/2020/05/GSM-Access-Control-Gate-Opener-User-Manual.pdf)
- **The product name 'RTU5024' is used for different firmwares: Enerna's 'RTU5024 User Manual V3.0' PDF actually contains the pwd#TEL#/pwd#GOT# dialect (Ver 2.0, 200 users, 3A relay), not King Pigeon's pwdA/pwdGOT dialect.** [high] Extracted text shows 'pwd#GOTTime#… #GOT19#… 9.5Seconds', 'Up to 200 authorized phone numbers', 'relay rating is 3A/240VAC', 'Connect to GSM/3G/4G antenna'. The hub adapter must therefore be configured per dialect and should probe with a harmless status query before relying on a syntax. (https://enerna-iotech.com/wp-content/uploads/2020/05/GSM-Gate-Opener-Remote-Switch-RTU5024-User-Manual-V3.0.pdf)
- **A third dialect (Gainwise-type, 100 users, 1 output + 2 inputs) uses '*12*1234#<code>#' SMS or DTMF commands; unknown callers are answered and can open with a DTMF access code (*71*5678#), while stored numbers are rejected without answering and open for free.** [high] First Fence PFGOGSM manual: '*71*5678# (Pulse open)', '*72*5678# (Latch open)', '*73*5678# (Un-Latch)'; '*24*1234#' returns 'Relay1: hold/release/trigger, Input1: high/low, Input2: high/low'; '12[Time]#' relay activation time 1-9999 s; inputs can SMS up to 3 alarm contacts on change. 12-24 V AC/DC. (https://media.firstfence.co.uk/docs/operation-and-maintenance/GSM-Opener-Operation-Manual.pdf)
- **WAFER GSM-KEY (AC200/DC200) uses '#PWD123456#GOT500' style commands with 6-digit password, GOT in milliseconds (default 300 ms), #WHL white-list and #CSQ signal, replying OK/Err.** [low] Only seen in a search snippet of the manualslib copy; the waferstar.com and waferlife.com PDF mirrors refused connection and manualslib returned 403, so the exact list could not be verified. (https://www.manualslib.com/manual/1156368/Wafer-Dc200.html)
- **RTU5024-type GSM openers are sold in India on Amazon.in (multiple resellers) and robu.in (RTU5034 variant), typically as 2G units.** [medium] Listings: Segolike 'RTU 5024' (B075FJQY7B), MERISHOPP RTU5024 (B0DBVHSP9F), CALANDIS (B0B6P7CJ6S), 850/900/1800/1900 MHz unit (B0CBKNL1ZS); robu.in RTU5034 (2G) listing. Prices quoted by search summary INR 2,000-7,000 (not verified on page). (https://www.amazon.in/Segolike-Opener-Switch-Controller-Controlled/dp/B075FJQY7B)
- **Jio has no 2G network; 2G-only GSM modules (SIM800-class) will not register on Jio SIMs — use Airtel/Vi/BSNL SIMs for 2G openers or buy a 4G (Cat1/VoLTE) unit.** [medium] Zbotic IoT SIM guide: 'Jio is 4G-only with no 2G fallback… SIM800/SIM900 will never register on Jio'; Airtel/Vi still run 2G with a gradual urban sunset from 2025-26. (https://zbotic.in/gsm-sim-card-for-iot-projects-best-operators-plans-india-2025/)
- **The 4G RTU5024 uses an LTE Cat1bis modem with VoLTE and lists LTE bands B1/B3/B5/B7/B8/B20 with 2G/3G fallback — B40 (2300 MHz, used by Jio and Airtel in India) is not in that list.** [medium] gate-opener.app blog citing BLIIoT product documentation; 'drop-in replacement for the 2G version… identical terminal layout'. Enerna's 4G RTU5024 page adds: up to 999 numbers, 6A/240VAC relay, 12 V DC 1 A, Android/iOS app, but no band list. (https://gate-opener.app/blog/future-proof-gate-opener-4g/)
- **The hub can send the SMS commands and the missed-call trigger itself through a SIMCom SIM7500/SIM7600 modem using standard AT commands.** [high] AT Command Manual V2.00: AT+CMGF=1 selects text mode; AT+CMGS="<number>"<CR> then text then Ctrl-Z returns '+CMGS: <mr>'; ATD<number>; (semicolon) originates a voice call and reports 'VOICE CALL:BEGIN'; ATH only hangs up if AT+CVHU=0 was set, alternatively AT+CHUP; AT+CNMI=1,2,0,0,0 routes new-message indications (+CMTI: <mem>,<index>); AT+CSQ gives RSSI 0-31. (https://www.kincony.com/images/SIM7600/SIM7500_SIM7600_Series_AT_Command_Manual_V2.00.pdf)
- **Shelly Gen2+ (Plus/Pro/Gen3/Gen4) Switch component supports a one-shot pulse via Switch.Set with toggle_after (seconds) and a persistent auto_off/auto_off_delay config; in_mode 'detached' decouples the SW input from the relay.** [high] Switch.Set params id, on, toggle_after, tag → {was_on}; Switch.GetStatus returns output, timer_started_at, timer_duration, source; config in_mode options momentary/follow/flip/detached/cycle/activate; webhook events switch.on/switch.off. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/)
- **Shelly Gen2+ Input component reports a reed/magnetic switch as Input.GetStatus {id, state} when type='switch' (invert available) and fires webhook events input.toggle_on / input.toggle_off.** [high] Button type inputs fire input.button_push/longpush/doublepush/triplepush; enable=false suppresses events. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Input/)
- **Shelly Gen2+ Webhook.Create lets the device call the hub directly on an event (up to 5 URLs, 300 chars each, optional condition/repeat_period, ${ev.*}/${status.*} substitution).** [high] Example: /rpc/Webhook.Create?cid=0&enable=true&event="input.toggle_on"&urls=["http://hub/…"]. Webhook.ListSupported enumerates events. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Webhook/)
- **Shelly Gen2+ WiFi component has a primary 'sta' and a fallback 'sta1' network plus roaming settings; WiFi.SetConfig changes them over HTTP and returns restart_required.** [high] sta/sta1: ssid, pass (write-only), enable, ipv4mode dhcp/static, ip/netmask/gw/nameserver; roam rssi_thr (-80) and interval (60 s); WiFi.GetStatus returns sta_ip, status, ssid, rssi; WiFi.Scan lists networks. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/WiFi/)
- **Shelly Gen1 (Shelly 1) HTTP API: /relay/0?turn=on&timer=N gives a timed pulse; /settings/relay/0 accepts auto_off and btn_type (toggle/momentary/momentary_on_release/detached); /status exposes relays[0].ison and inputs[0].input; /settings/sta re-points WiFi; action URLs (btn_on_url, out_on_url…) call the hub.** [high] Basic HTTP auth applies to everything except /shelly once enabled via /settings/login. (https://shelly-api-docs.shelly.cloud/gen1/)
- **Shelly's own garage/gate guide: wire the potential-free relay output in parallel with the existing wall button, enable Auto-Off with 1 second ('the step that fails most often'), and read a magnetic reed switch for open/closed state (Gen4 via Plus Add-On with input type 'Garage', invert if reversed).** [high] Recommended models Shelly 1 Gen4 (+Add-On for status), Shelly Plus Uni, Shelly 1 Mini Gen4, Shelly Pro 1 (no status). Shelly 1 Gen3 is sold as a dry-contact relay. (https://shelly.guide/en/application-guide/garage-door-control/)
- **Sonoff DIY mode exposes an unencrypted local REST API on port 8081 (mDNS _ewelink._tcp) with /zeroconf/pulse (inching), /zeroconf/switch, /zeroconf/info and /zeroconf/wifi (change SSID/password); supported on BASICR3, RFR3, MINI/MINIR2/MINIR3, D1, SPM-Main and some bulbs; Sonoff SV is NOT listed.** [high] Enter DIY mode by holding the pairing button 5 s, join AP ITEAD-XXXXXXXXXX (pw 12345678) and set WiFi at http://10.10.7.1/. Request {deviceid, data}; response {seq, error, data}; errors 400/401/404/422. pulseWidth: 'positive integer, ms, only supports multiples of 500 in range of 500~36000000'. (https://help.sonoff.tech/docs/DIY-MODE-API-PROTOCOL)
- **Sonoff SV is a 5-24 V DC relay module (ESP8266, max 290 mA/240 W on the same rail as input) with a solder-modifiable isolated-output mode and eWeLink 'LAN Control' (works without internet); it is controlled on the LAN only through the encrypted eWeLink LAN protocol (needs device key from the eWeLink account), not the open DIY API.** [medium] pysonofflanr3 docs: LAN mode = WebSocket on port 8081, firmware V3+, 'API key needed for devices not in DIY mode; obtainable from the eWeLink app'; project unmaintained, points HA users to AlexxIT/SonoffLAN. Sonoff SV specs from Geekworm/reseller pages (official product page 404). (https://pysonofflanr3.readthedocs.io/readme.html)
- **Tasmota (on a Sonoff SV/Basic or any ESP relay) gives a pulse via PulseTime<x> (1..111 = 0.1 s units, 112..64900 = seconds+100), reads a reed via SwitchMode<x> 1 (follow) or 2 (inverted follow), and SetOption114 1 detaches switches from relays and publishes {"Switch<x>":{"Action":"ON"}} over MQTT.** [high] HTTP form http://<ip>/cm?user=&password=&cmnd=<command> (space %20, ; %3B); MQTT cmnd/<topic>/POWER, stat/<topic>/RESULT, tele/<topic>/SENSOR (switch state only every TelePeriod). SSId1/SSId2 + Password1/Password2 store two networks; AP 0/1/2 selects; Restart 1 applies. Reed wiring: GPIO to GND. (https://tasmota.github.io/docs/Commands/)
- **Tuya's 'garage door opener' category (ckmkzq) standard DPs are switch_1 (Boolean, door switch), doorcontact_state (Boolean, report-only, true=open), countdown_1, tr_timecon (travel time 10-120 s), countdown_alarm and switch_alarm_sound.** [high] Tuya's page does not list numeric DP ids; Home Assistant community mapping for common units is dp 1 = switch_1 and dp 3 = doorcontact_state. (https://developer.tuya.com/en/docs/iot/s?id=K9gf7o5rkds8c)
- **tinytuya controls Tuya devices locally with OutletDevice(dev_id, ip, local_key, version) → status()['dps'] and set_value(index, value); the local key comes from a Tuya IoT cloud project via 'python -m tinytuya wizard' and changes whenever the device is re-paired.** [high] Protocol versions 3.1-3.5 supported; devices must first be paired in Smart Life/Tuya app. Re-pairing is the only way to move a Tuya device to another WiFi (no local WiFi-change call). (https://github.com/jasonacox/tinytuya)
- **Tuya Cloud OpenAPI (India endpoint https://openapi.tuyain.com) controls devices with POST /v1.0/devices/{device_id}/commands {"commands":[{"code":"switch_1","value":true}]} and reads GET /v1.0/devices/{device_id}/status, signed with HMAC-SHA256 headers client_id, sign, sign_method, t, access_token.** [high] Regional hosts: tuyacn.com, tuyaus.com, openapi-ueaz.tuyaus.com, tuyaeu.com, openapi-weaz.tuyaeu.com, tuyain.com, openapi-sg.iotbing.com. (https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4)
- **Nice BiDi-WiFi / IT4WIFI speak a local TLS/TCP protocol on port 443 (Nice 'NHK/T4', self-signed cert) that 'is not publicly documented by Nice'; open-source integrations implement open/stop/close, step-by-step, partial 1/2/3, courtesy light and lock, with state from DMP register 04/01 and position from 04/11, 04/18, 04/19, plus zeroconf discovery and an optional Nice cloud relay fallback.** [medium] Per-device NHK credentials are extracted or imported from a MyNice account. Tested on BiDi-WiFi fw 2.6.4 with Robus sliding controllers. openHAB's MyNice binding does the same for IT4WIFI (mDNS discovery, MAC + pairing key, user must be granted in the MyNice app; commands stop/open/close plus discovered T4 commands). (https://github.com/Jordi-14/homeassistant_nice)
- **Nice control boards (RD400 sliding-gate manual) expose STEP-BY-STEP (terminals 1-2, NO devices), STOP (3-4, NC/NO/8.2k), PHOTO (4-6, NC) and a FLASH output; the SbS sequence is programmable as 'Open-Stop-Close-Open', 'Open-Stop-Close-Stop' or 'Condominium', and holding SbS >3 s means 'always open'.** [high] Pause (auto-close) time selectable 15/30/60 s. No dedicated gate-open indicator output on this model; the FLASH lamp output flashes 0.5 s during any manoeuvre. (https://www.niceforyou.com/sites/default/files/upload/manuals/idv0615a00en.pdf)
- **Generic Chinese sliding-gate boards (THD SL1500ACL manual) have a J2 signal terminal with Pedestrian (1), Close (2), Open (3), Stop (4), Common (5) and Cyclical (6) pins, J5 limit-switch pins (13 open limit, 12 common, 11 close limit), an IR NC photocell input, and a LAMP/alarm output.** [high] Default DIP6-down mode: one button 'will cycle through the commands OPEN→STOP→CLOSE→STOP'; DIP6 up = four separate buttons (manufacturer discourages). Auto-close 12/24/36 s via DIP3/4; DIP5 disables auto-close after collision. (https://images.thdstatic.com/catalog/pdfImages/8a/8ab75792-d09e-48eb-9e2b-528ea94b9b4b.pdf)
- **CAME Connect has an unofficial, reverse-engineered cloud REST+WebSocket API (base https://app.cameconnect.net/api) used by the came_connect Home Assistant integration; commands are POST /automations/{device_id}/commands/{command_id} with 2=open, 5=close, 129=stop; phases 16 open, 17 closed, 32 opening, 33 closing, 19 stopped.** [medium] OAuth: POST /oauth/auth-code (PKCE S256) then POST /oauth/token with client_id:secret Basic auth, both scraped from https://www.cameconnect.net/main.XXX.js; discovery GET /evo/v1/sites and /evo/v1/sites/{site_id}/devices; GET /devicestatus; events wss://app.cameconnect.net/api/events-real-time (EventId 21 VarcoStatusUpdate phase/percent). The earlier came-connect library was archived Oct 2024. (https://raw.githubusercontent.com/sdeagh/came_connect/main/custom_components/came_connect/const.py)
- **BFT U-Link gates are cloud-controlled through the uControl API (unofficial): POST https://ucontrol-api.bft-automation.com/oauth/token (grant_type=password, Basic auth 'particle:particle'), GET /api/v1/users/?access_token= to list data.automations[].uuid, and GET https://ucontrol-dispatcher.bft-automation.com/automations/{uuid}/execute/{open|close|stop|diagnosis} with Bearer token.** [medium] Diagnosis returns first_engine_pos_int/second_engine_pos_int (0 closed, 100 open) and velocities → open/closed/moving/stopped. HTTP 400 'socket not found' = device offline. Integration polls 5 s while moving, 30 s at rest. (https://raw.githubusercontent.com/emanuelbesliu/homeassistant-bft/main/custom_components/bft/const.py)
- **FAAC Simply Connect (app + communication modules) has no public developer API found; the only open path for FAAC is the E145 board's serial (USB) port via the FAAC-E145-Gate-Connect gateway (MQTT faac/gate/command open|close|stop, states OPEN/CLOSED/MOVING/STOPPED, wing positions 0-100 %, REST /api/command).** [low] Search of FAAC sites and stores shows only consumer/installer app listings with a developer contact e-mail; no SDK or API docs. (https://github.com/jens62/FAAC-E145-Gate-Connect)
- **Toshi Automation Solutions and Gandhi Automations product pages mention only remote control, sensor-based access, photocells, step-by-step and partial opening — no WiFi, GSM, app, cloud or API — so their motors should be treated as dry-contact boards driven by an added relay module.** [medium] Toshi page: 'Smart automation with remote & sensor-based access'; Gandhi motorised-gates page lists mechanical construction only; the DirectIndustry Gandhi catalogue mentions an electronic control unit with 'partial opening, automatic closing, and step by step control'. (https://toshiautomation.com/automatic-gates)
- **eWeLink cloud OpenAPI documentation could not be retrieved (the docs site is a JS app and the GitHub docs path returned 404), so no eWeLink cloud endpoint is cited here.** [low, review: refuted] Sonoff devices already paired in the owner's eWeLink app can be reached locally (DIY mode or LAN mode) as described; cloud control would need the CoolKit OpenAPI docs to be read separately. (https://coolkit-technologies.github.io/eWeLink-API/)
  - **Corrected:** The docs are retrievable with a JS-rendering fetch at https://coolkit-technologies.github.io/eWeLink-API/#/en/APICenterV2. Regional API hosts: https://cn-apia.coolkit.cn (China), https://as-apia.coolkit.cc (Asia - use for India), https://us-apia.coolkit.cc, https://eu-apia.coolkit.cc. Login: POST /v2/user/login with headers X-CK-Appid, X-CK-Nonce and Authorization (Sign). Device control: POST /v2/device/thing/status with body fields type, id, params. WebSocket dispatch: https://as-dispa.coolkit.cc/dispatch/app (cn/us/eu equivalents). An APPID/APP SECRET from the CoolKit developer platform is required. (Extracted through an LLM page query, so re-read the page before coding against it.)

## Limits and caveats

- SMS dialect is firmware-specific, not model-specific: 'RTU5024' is sold with at least two incompatible command sets (King Pigeon 'pwdGOT030#' vs 'pwd#GOT19#'). The hub adapter must store a dialect per gate device and should probe with a status query (1234EE / 1234#CSQ? / *21*1234#) during onboarding.
- GSM openers toggle rather than pulse on repeated calls within the GOT window (RTU5024 manual note 3): debounce hub-initiated calls and never auto-retry inside the pulse window, or you will release the relay before the gate board registers the press.
- The King Pigeon RTU5024 sends no SMS at all on a malformed command; treat silence as 'unknown', not failure, and rely on the GON/GOFF confirmation or the reed sensor for the 'done' state.
- Caller-ID must be presented: the hub's modem SIM must be stored in the opener's authorised list (position 001 is best), and +91/0091 prefix quirks apply (manuals advise adding the country code if calls/SMS are not recognised).
- India network: Jio SIMs have no 2G, so 2G-only openers (RTU5024 2G, the 900/1800 MHz 'pwd#' units, Gainwise units) need Airtel/Vi/BSNL SIMs; the 4G RTU5024 lists LTE B1/B3/B5/B7/B8/B20 (no B40) — confirm B3 and ideally B40 coverage at the gate before buying. Postpaid SIMs also need SIM-PIN disabled.
- A relay pulse only proves the button was pressed; the gate may be blocked by a photocell (NC PHOTO input) or obstacle. Show 'done' only when the reed sensor changes (or, on the SIM path, when the confirmation SMS or *24*/EE status arrives); otherwise show 'command sent — waiting' with a travel-time timeout (tr_timecon-style 10-120 s).
- Single-button ('cyclical'/'Step-by-Step') inputs are stateful (OPEN→STOP→CLOSE→STOP); without a reed sensor the hub cannot know whether the next pulse opens or closes. Prefer separate OPEN/CLOSE/STOP inputs (three relays, e.g. Shelly Pro 2/Sonoff 4CH in inching mode) for deterministic app buttons.
- Wire the relay in parallel with the existing wall button on a potential-free (dry-contact) output only (Shelly 1 Gen3/Gen4, Shelly 1 Gen1, Sonoff SV isolated mode, Tasmota board with dry-contact relay); never feed mains through the gate board's signal terminals. Set initial_state/PowerOnState/startup to 'off' so a power cut cannot pulse the gate.
- Sonoff SV is not on Sonoff's official DIY-mode device list; stock firmware needs the encrypted eWeLink LAN protocol with the device key (unmaintained libraries), so for an open local API either use BASICR3/MINI R2 (DIY) or flash Tasmota/ESPHome on the SV.
- Tuya modules cannot be re-pointed to another WiFi locally — only by re-pairing in the Smart Life app, which also rotates the local key. Shelly (sta + sta1 fallback), Tasmota (SSId1/SSId2) and Sonoff DIY (/zeroconf/wifi, single SSID) can be re-pointed by the hub.
- CAME Connect and BFT uControl endpoints are reverse-engineered from vendor web/mobile apps by community integrations (one already archived); Nice's local protocol is undocumented; FAAC Simply Connect has no public API found. Treat these as best-effort adapters with fallback to a relay module on the board's push-button input.
- Toshi and Gandhi Automations publish no WiFi/GSM/app/API capability; their gates are motor + control board with remotes and photocells, so the relay-module + reed-sensor approach is the practical integration.
- The Enerna '999-user' manual says alarm inputs only arm 10 minutes after the last call-in, so SMS-reported reed state from those units is delayed; the Gainwise-type unit's *24*1234# on-demand status query has no such delay.
- Wafer GSM-KEY command syntax ('#PWD123456#GOT500') is cited from a search snippet only (mirrors unreachable) — verify against the printed manual before implementing that dialect.

## Libraries

- **serialport** (npm, MIT, 12.x): Talk AT commands to the SIM7600/A7670 USB modem from the Node.js hub (ATD…; missed-call trigger, AT+CMGS SMS config commands, +CMT/+CMTI inbound confirmations). https://www.npmjs.com/package/serialport
- **mqtt** (npm, MIT, 5.x): Subscribe to Tasmota stat/<topic>/RESULT switch events ({"Switch1":{"Action":"ON"}}) and FAAC E145 gateway topics; publish cmnd/<topic>/POWER1 pulses. https://www.npmjs.com/package/mqtt
- **bonjour-service** (npm, MIT, 1.x): mDNS discovery of Sonoff DIY devices (_ewelink._tcp, TXT id/type/apivers) and Shelly devices on the LAN during onboarding. https://www.npmjs.com/package/bonjour-service
- **tinytuya** (python, MIT, 1.x): Local control of Tuya garage/gate modules (OutletDevice.set_value(1, True), status()['dps']['3']) and the wizard that pulls local keys from the Tuya IoT project; run as a small Python sidecar or port the protocol. https://github.com/jasonacox/tinytuya
- **tuyapi** (npm, MIT, 7.x): Node-native alternative to tinytuya for the same Tuya local protocol (needs the same device id + local key); license/version from npm listing not re-verified in this pass. https://www.npmjs.com/package/tuyapi
- **AlexxIT/SonoffLAN (reference implementation)** (python, not verified, 3.x): Reference for the encrypted eWeLink LAN-mode protocol (Sonoff SV on stock firmware) if you keep stock firmware instead of Tasmota; port the AES/device-key framing to Node. https://github.com/AlexxIT/SonoffLAN
- **Jordi-14/homeassistant_nice, sdeagh/came_connect, emanuelbesliu/homeassistant-bft, jens62/FAAC-E145-Gate-Connect (reference implementations)** (python, not verified, main): Only available implementations of the Nice NHK/T4 local protocol, CAME Connect cloud API, BFT uControl cloud API and FAAC E145 serial protocol; port their request/response handling into hub adapters and check each repo's LICENSE file before copying code. https://github.com/Jordi-14/homeassistant_nice

## Could not be verified (treat as uncertain)

- FACT: RTU5024-type openers sold in India on Amazon.in (ASINs B075FJQY7B, B0DBVHSP9F, B0B6P7CJ6S, B0CBKNL1ZS) and robu.in (RTU5034), typically 2G, INR 2,000-7,000
