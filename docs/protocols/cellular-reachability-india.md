# cellular-reachability-india

Review: 60 claims confirmed, 7 corrected, 6 could not be verified.

## Summary

A device sitting on its own consumer/postpaid 4G SIM in India cannot be reached inbound by the hub: Airtel and Jio put mobile subscribers behind carrier-grade NAT (RFC 6598 100.64.0.0/10), and Jio's mobile network is IPv6-only transport with 464XLAT, so there is no public IPv4 at all; unsolicited inbound IPv6 is undocumented and forum reports are mixed. Static/public-IP SIMs exist only as enterprise M2M/IoT products (13-digit numbers, bulk KYC in an entity's name, DoT-mandated whitelisting of a handful of numbers/IPs, private APN) sold by Airtel/Vi/Jio business desks or foreign resellers at roughly a hundred pounds setup plus rental per SIM - not something a homeowner should build on, and BSNL publishes no 4G static-IP SIM offer at all. Everything that works through CGNAT is device-initiated outbound: vendor P2P/cloud (Hik-Connect, Tuya cloud on the India data centre openapi.tuyain.com, camera apps like Ubox/V380), MQTT to a broker the device can reach, or an overlay VPN whose client on the device side dials out (Tailscale/WireGuard/ZeroTier). The strongest fix for cameras is to stop giving each camera its own SIM and instead put them behind one 4G router that runs Tailscale as a subnet router (GL.iNet GL-X3000/XE3000, Teltonika RUTX50) or a WireGuard tunnel to a small VPS; the hub and the phone then reach RTSP/ONVIF/PTZ over the overlay whether or not the home WiFi is up, with Tailscale falling back to its Bengaluru DERP relay when both sides are behind hard NAT. Tailscale's free Personal plan (6 users, unlimited devices) covers hub + phone + router; ZeroTier free is 10 devices/1 network; Cloudflare Tunnel is free and outbound-only but its CDN terms forbid serving video without a paid product and private-network mode requires the WARP client on the phone. For cameras that must keep their own SIM, the only remote path is the vendor's cloud API (Tuya has a real REST API; Hik-Connect-style P2P has none) or SMS if the device accepts SMS commands. SMS is a viable out-of-band channel for the hub itself: a USB LTE modem driven with 3GPP 27.005 AT commands (AT+CMGF=1, AT+CMGS, AT+CNMI/+CMTI), a Huawei HiLink stick via its HTTP/XML API, or a spare Android phone running the open-source SMS Gateway app; a PWA can only hand off to the phone's SMS app via sms:+91...?body=... (works on Android and iPhone). TRAI caps normal SIMs at 200 SMS/day, exempts M2M/P2M traffic, and its Feb-2025 TCCCPR amendment punishes commercial messaging from 10-digit numbers - personal device commands and alerts are non-commercial, but keep volumes low and never promotional. Recommended: hub with its own LTE uplink + Tailscale on hub, phone and 4G camera router; MQTT over TLS on a VPS for SIM-only relays/lights; vendor cloud adapters for SIM cameras; USB modem SMS as last resort.

## Corrections from review (these override anything below)

- **Claim:** BSNL static IP only on wired broadband: free with plans >= Rs 2,799/month, otherwise Rs 1,800-2,000 per year; no 4G static-IP SIM
  **Correction:** The cited TelecomTalk article is dated 29 March 2011 and is stale: it says Rs 2,000/year for plans Rs 1,000-1,499 and Rs 1,800/year for plans Rs 1,500-2,799, by written request; it does not state a free tier in the fetched text. Treat as historical, not current tariff. No BSNL mobile static-IP offer found (absence not provable).
  Source: https://telecomtalk.info/bsnl-to-offer-static-ip-on-request-with-broadband-plans/61282/
- **Claim:** Tailscale node addresses come from 100.64.0.0/10; doc warns of conflicts with other VPNs and gives no carrier workaround
  **Correction:** The address-range part is correct, but Tailscale DOES document the carrier case: the reserved-IP-addresses page says 'Some internet service providers (ISPs) use this range, which can cause CGNAT conflicts' and points to a CGNAT-conflict troubleshooting section with fixes (IP pools, disabling IPv4 selectively or tailnet-wide). Real bug reports exist for routers whose WAN is in 100.64/10 (OpenWrt DHCP unicast renew intercepted, issue #18762; issue #12829). --netfilter-mode=off|nodivert is the CLI escape hatch on Linux.
  Source: https://tailscale.com/docs/reference/reserved-ip-addresses ; https://github.com/tailscale/tailscale/issues/18762
- **Claim:** Hik-Connect / EZVIZ P2P: device dials out to Hikvision cloud; no public API; go2rtc #2289 open, not supported
  **Correction:** P2P/outbound behaviour is plausible but the Visiotech page returned 403 (unverified). 'No public API' is too strong for EZVIZ: Home Assistant's ezviz integration uses the EZVIZ app cloud API (apiieu.ezvizlife.com) for PTZ, alarm arm/disarm, wake and OTA, while video is still pulled from the camera's LOCAL RTSP (must be enabled; verification code is the RTSP password). go2rtc issue #2289 is open and its author reports a working reverse-engineered Hik-Connect/EZVIZ P2P source (HEVC + G.711A) in stacked PRs, not merged upstream.
  Source: https://www.home-assistant.io/integrations/ezviz/ ; https://github.com/AlexxIT/go2rtc/issues/2289
- **Claim:** SMS Gateway for Android (capcom6, Apache-2.0, Android 5.0+): POST http://<phone-ip>:8080/message, basic auth, JSON message + phoneNumbers, cloud/private modes, webhooks sms:received/delivered/failed, multi-SIM
  **Correction:** Everything is right except the body: the top-level "message" string is marked deprecated in the OpenAPI spec. Current body is {"textMessage":{"text":"GATE OPEN"},"phoneNumbers":["+91..."]} with optional simNumber, withDeliveryReport, ttl/validUntil, priority, isEncrypted, id. Events also include sms:sent, mms:downloaded, system:ping. Cloud endpoint: https://api.sms-gate.app/3rdparty/v1/message. JWT bearer auth is now preferred; Basic is labelled legacy.
  Source: https://github.com/capcom6/android-sms-gateway ; https://capcom6.github.io/android-sms-gateway/ ; https://docs.sms-gate.app/integration/api/
- **Claim:** TRAI limits ordinary SIMs to 200 SMS/day (raised from 100); M2M and P2M exempted 25 Jan 2012; practical constraint is the 200/day cap
  **Correction:** The 2011 raise to 200 and the 25 Jan 2012 M2M/P2M exemption are real, but the cap no longer binds personal SMS: the Delhi High Court quashed the 200 SMS/day/SIM limit for non-commercial messages in July 2012 (kept only for UCC), and TRAI's later 50-paise charge beyond 100 SMS/day was removed by the Telecom Tariff (65th Amendment) Order on 3 June 2020. The real limit today is the operator plan's own SMS allowance/fair-use terms; check the specific postpaid plan.
  Source: https://www.medianama.com/2012/07/223-implications-of-delhi-high-courts-removal-of-the-200-sms-per-day-limit-in-india/ ; https://www.medianama.com/2020/06/223-trai-removes-regulation-requiring-telcos-to-charge-for-more-than-100-sms-per-user/ ; https://www.pib.gov.in/newsite/PrintRelease.aspx?relid=79880
- **Claim:** Licences: tailscale BSD-3-Clause, cloudflared Apache-2.0, ZeroTierOne Business Source License 1.1
  **Correction:** tailscale BSD-3-Clause and cloudflared Apache-2.0 are correct. ZeroTierOne is no longer BSL 1.1: LICENSE.txt on the dev branch says MPL-2.0 for node/, osdep/, service/ and everything except ext/ and nonfree/; nonfree/ (source-available, includes the controller) has its own licence.
  Source: https://raw.githubusercontent.com/zerotier/ZeroTierOne/dev/LICENSE.txt
- **Claim:** ENDPOINT Android SMS Gateway: POST http://<phone-ip>:8080/message body {"message":"GATE OPEN","phoneNumbers":[...]} with HTTP Basic
  **Correction:** Use {"textMessage":{"text":"GATE OPEN"},"phoneNumbers":["+919876543210"]}; the top-level "message" field is deprecated. URL, port 8080 and Basic auth (credentials shown in the app's Local Server settings) are correct.
  Source: https://github.com/capcom6/android-sms-gateway ; https://capcom6.github.io/android-sms-gateway/

## Added by review (things an implementer needs)

- **Tailscale on a 4G router whose WAN is in 100.64.0.0/10 can break the WAN itself** Tailscale's own docs acknowledge ISP CGNAT conflicts ('Some internet service providers (ISPs) use this range, which can cause CGNAT conflicts') and offer fixes: IP pools, or disabling IPv4 selectively/tailnet-wide. On OpenWrt-based routers (GL.iNet firmware is OpenWrt-based) issue #18762 reports Tailscale's nftables/policy-routing intercepting unicast DHCP renewals to a carrier DHCP server in 100.64/10, dropping WAN until broadcast renew; issue #12829 reports a machine on a CGNAT network being cut off after install. Linux escape hatch: --netfilter-mode=off|nodivert. Test the exact SIM + router before relying on it and have the hub alert when a router peer goes offline. (https://tailscale.com/docs/reference/reserved-ip-addresses ; https://github.com/tailscale/tailscale/issues/18762 ; https://github.com/tailscale/tailscale/issues/12829)
- **Tailscale reserved addresses the hub must not treat as peers** 100.100.100.100 is the local MagicDNS/management address (Quad100); 100.100.0.0/24, 100.100.100.0/24 and 100.115.92.0/23 are reserved; IPv6 tailnet addresses are in fd7a:115c:a1e0::/48. A CGNAT detector must therefore distinguish 'interface is tailscale' from 'carrier WAN is 100.64/10' by interface, not by address range alone. (https://tailscale.com/docs/reference/reserved-ip-addresses)
- **Tailscale fallback order and ports** When direct fails Tailscale first tries peer relays in the tailnet, then DERP. Ports: TCP 443 (control plane + DERP over HTTPS), UDP 41641 (default WireGuard source port), UDP 3478 (STUN), TCP 80 (captive-portal detection). Linux clients must opt in to subnet routes with 'tailscale set --accept-routes'; Windows, Android, iOS, macOS pick them up automatically. Subnet routers SNAT by default (cameras see the router's LAN IP); '--snat-subnet-routes=false' (Linux only) disables that. On the Windows hub use 'tailscale up --unattended'. (https://tailscale.com/kb/1082/firewall-ports ; https://tailscale.com/kb/1232/derp-servers ; https://tailscale.com/kb/1019/subnets ; https://tailscale.com/docs/reference/tailscale-cli/up)
- **GL.iNet Tailscale is flagged beta and conflicts with other VPN clients** GL.iNet doc: 'This feature is currently in beta, and may have some bugs', and using it together with OpenVPN Client, WireGuard Client, GoodCloud Site to Site, ZeroTier or AstroWarp is not recommended because of route conflicts. v4.9+ adds 'Run Exit Node' and 'IP Masquerading' options; 'Allow Remote Access WAN' was renamed 'Advertise WAN Subnets'. (https://docs.gl-inet.com/router/en/4/interface_guide/tailscale/)
- **Shelly outbound websocket is NOT protected by device authentication** Shelly Gen2 auth is RFC 7616 digest with SHA-256, fixed username 'admin', realm = device id, set via Shelly.SetAuth with ha1 = SHA256(admin:<realm>:<password>). But the docs state all communication is protected EXCEPT MQTT, UART and Outbound Websocket. So the hub's wss endpoint must authenticate the device itself (unguessable per-device URL path/token, TLS, check device id in the first NotifyFullStatus frame) and never expose that endpoint unauthenticated on a public VPS. For inbound WS/HTTP RPC the hub must add the 'auth' object (realm, username, nonce, cnonce, nc, response, algorithm SHA-256; ha2 uses 'dummy_method:dummy_uri' on non-HTTP transports). (https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/)
- **Shelly Ws.SetConfig needs a reboot; WiFi re-pointing does not** Ws.SetConfig returns restart_required and takes effect after reboot; Ws.GetStatus returns {connected: bool}. WiFi.SetConfig takes config.sta and config.sta1 (each: ssid, pass, is_open, enable, ipv4mode), sta1 'will be used as fallback when the device is unable to connect to the sta network'; no restart needed, device reconnects about a second after the config is stored. HTTP GET form: /rpc/WiFi.SetConfig?config={"sta":{"ssid":"X","pass":"Y","enable":true}}. Safe re-point pattern: write the new network to sta1 first, verify, then swap. WiFi.Scan lists visible networks. Switch control: /rpc/Switch.Set?id=0&on=true (optional toggle_after seconds, response {was_on}); Switch.Toggle?id=0; Switch.GetStatus?id=0. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/WiFi/ ; https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/ ; https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Ws/)
- **Tasmota TLS and HTTP auth specifics** MQTT over TLS needs 'SetOption103 1' and a TLS-capable build: ESP32 builds support it, ESP8266 requires a custom compile. MqttPort range 2-32766; MqttPassword 5+ chars in the doc summary; 'MqttHost 0' clears the host; .local hostnames are not supported. HTTP command auth is in the query string: /cm?user=admin&password=<pw>&cmnd=<urlencoded>. Backlog max 30 commands separated by ';'. Wi-Fi: SSID1/SSID2, Password1/Password2 (max 64 chars), 'AP 0|1|2' to select/switch AP, WifiConfig for fallback behaviour. Default FullTopic is %prefix%/%topic%/; LWT is a retained message on tele/<topic>/LWT. (https://tasmota.github.io/docs/Commands/ ; https://tasmota.github.io/docs/MQTT/)
- **Tuya cloud token lifetime, signing constants and alternate paths** GET /v1.0/token?grant_type=1 returns {access_token, refresh_token, expire_time, uid}; expire_time is in seconds (example 7200), so the adapter must cache and refresh. Content-SHA256 of an empty body is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855. stringToSign = METHOD + "\n" + Content-SHA256 + "\n" + (Signature-Headers key:value lines, usually empty) + "\n" + path with query params sorted alphabetically. Headers: client_id, sign, t (13-digit ms), sign_method: HMAC-SHA256, nonce, access_token (business calls). Other endpoints on the same page: GET /v1.0/devices/{id}/specifications, GET /v1.0/functions/{category}, GET /v1.0/devices/functions (up to 20 devices). Command response: {success:true,t:...,result:true}. tinytuya uses /v1.0/iot-03/devices/{id}/commands|status|functions and /v1.0/users/{uid}/devices. All data-centre hosts: tuyacn, tuyaus, -ueaz.tuyaus, tuyaeu, -weaz.tuyaeu, tuyain, openapi-sg.iotbing.com; the project must be created in (and the app account linked from) the India data centre or devices will not be visible. (https://developer.tuya.com/en/docs/cloud/6c1636a9bd?id=Ka7kjumkoa53v ; https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g ; https://developer.tuya.com/en/docs/cloud/device-control?id=K95zu01ksols7 ; https://raw.githubusercontent.com/jasonacox/tinytuya/master/tinytuya/Cloud.py ; https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4)
- **Tuya IoT Core trial renewal is an application, not automatic** Tuya: after the trial expires 'you can no longer use relevant APIs'; renewal requires an application that must be approved (Cloud > project > IoT Core > 'Extend Trial Period' form). tinytuya's docs say up to 6 months can be requested and re-requested, with a result typically within a working day. The hub should detect the expiry error from the API and surface a 'renew Tuya trial' notice rather than silently failing. (https://support.tuya.com/en/help/_detail/Kbm9zue1v7vvu ; https://github.com/jasonacox/tinytuya/pull/737)
- **Huawei HiLink session/token and login details needed for an adapter** All API paths are under /api/. Token acquisition order in huawei-lte-api: (1) csrf_token meta tags in the home page HTML, (2) GET api/webserver/token -> token, (3) GET api/webserver/SesTokInfo -> TokInfo (plus SesInfo cookie). Each POST sends header __RequestVerificationToken and Content-Type application/xml with the payload wrapped in <request>...</request>; tokens are single-use on many firmwares and are replenished from response headers __RequestVerificationTokenone / __RequestVerificationTokentwo (or __RequestVerificationToken). Login: GET api/user/state-login (State, password_type), then POST api/user/login with Username, Password, password_type; for password_type 4 the password is base64(sha256hex(username + base64(sha256hex(password)) + token)). Newer firmware uses SCRAM via api/user/challenge_login and api/user/authentication_login. Inbox: POST api/sms/sms-list {PageIndex:1, ReadCount:20, BoxType:1 (local inbox), SortType:0, Ascending:0, UnreadPreferred:0}; api/sms/delete-sms {Index}; api/sms/set-read {Index}; GET api/sms/sms-count. Connection string form: http://admin:PASSWORD@192.168.8.1/. Only HiLink-mode devices; not serial/stick mode. (https://raw.githubusercontent.com/Salamek/huawei-lte-api/master/huawei_lte_api/Session.py ; https://raw.githubusercontent.com/Salamek/huawei-lte-api/master/huawei_lte_api/api/User.py ; https://raw.githubusercontent.com/Salamek/huawei-lte-api/master/huawei_lte_api/api/Sms.py)
- **SMS Gateway for Android current API shape** Local: POST http://<phone>:8080/message; Cloud: POST https://api.sms-gate.app/3rdparty/v1/message. Body fields: textMessage{text} (or dataMessage), phoneNumbers[], simNumber, withDeliveryReport, ttl or validUntil, priority, isEncrypted, id; 'message' is deprecated. Response has id, state, recipients; poll GET /message/{id}. Webhook events: sms:received, sms:sent, sms:delivered, sms:failed, mms:downloaded, system:ping; received payload includes simNumber. Auth: JWT bearer preferred, Basic is legacy. The local server is only reachable on the phone's LAN (or via the phone's Tailscale address). (https://capcom6.github.io/android-sms-gateway/ ; https://docs.sms-gate.app/integration/api/ ; https://github.com/capcom6/android-sms-gateway)
- **Cloudflare private-network extras** For a locally-managed tunnel the config.yml needs 'warp-routing: enabled: true' alongside tunnel and credentials-file; run with --config if the file is not in the default location. SNI-inspecting firewalls must also allow cftunnel.com, h2.cftunnel.com and quic.cftunnel.com on 7844; optional outbound 443 to api.cloudflare.com, update.argotunnel.com, <team>.cloudflareaccess.com. Zero Trust Free is capped at 50 users. cloudflared must run on something inside the camera LAN; a consumer 4G router cannot run it, so this path needs a Pi/PC behind each SIM router, unlike GL.iNet's built-in Tailscale. (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/ ; https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/deploy-tunnels/tunnel-with-firewall/ ; https://www.cloudflare.com/plans/zero-trust-services/)
- **EZVIZ cloud API exists and is used by Home Assistant; live video still needs LAN/VPN** Home Assistant's ezviz integration talks to the EZVIZ mobile-app API (documented host apiieu.ezvizlife.com; region-specific hosts exist) for PTZ, alarm control panel (arm away/sleep/disarm), wake-from-sleep and OTA, i.e. these commands work over the camera's own SIM path. Video is NOT relayed: it uses the camera's local RTSP (must be enabled on the camera; the verification code printed by the QR label is the RTSP password), so for a SIM-only camera the hub still needs a VPN/subnet route to pull video. go2rtc issue #2289 (open) describes a working reverse-engineered Hik-Connect/EZVIZ cloud P2P source not yet merged. (https://www.home-assistant.io/integrations/ezviz/ ; https://github.com/AlexxIT/go2rtc/issues/2289)
- **The core architectural gap: a camera with its own built-in SIM cannot run a VPN client** Every tunnel option the researcher lists (Tailscale subnet router, WireGuard, cloudflared, ZeroTier) requires software on a router or computer in front of the camera. A camera with an embedded SIM slot has no such gateway and, per the Jio 464XLAT and Airtel CGNAT findings, no inbound path; for those devices the only command path is the vendor cloud (Tuya OpenAPI, EZVIZ cloud API, vendor P2P) or SMS if the firmware supports SMS commands. The hub's device model should record per device: transport = lan | tailnet-subnet | vendor-cloud | sms, and whether live video is possible on the fallback path. (https://anuragbhatia.com/post/2023/02/jio-5g-ipv6-only/ ; https://tailscale.com/kb/1019/subnets)
- **Jio 464XLAT implications for a tunnel endpoint** On Jio 5G/LTE the device has only IPv6 on transport and reaches IPv4 through NAT64 (DNS64 synthesises 64:ff9b::/96 addresses) or the CLAT at 192.0.0.2. A WireGuard/MQTT endpoint given as a hostname with only an A record works through DNS64/CLAT, but giving the VPS an AAAA record avoids NAT64 entirely and is the more robust choice; IPv4 literals depend on the modem/router implementing CLAT. (https://anuragbhatia.com/post/2023/02/jio-5g-ipv6-only/)
- **SMS volume rules in India are not what the researcher stated** The 200 SMS/day/SIM regulatory cap was quashed for personal (non-commercial) SMS by the Delhi High Court in July 2012, and TRAI removed the 50-paise charge above 100 SMS/day on 3 June 2020. The binding limit is the postpaid plan's own SMS allowance and operator fair-use terms. The Feb 2025 TCCCPR amendment adds pattern analysis by operators (unusually high volumes, low incoming-to-outgoing ratios) to flag suspected spammers, so the hub should rate-limit and de-duplicate SMS commands to avoid looking like an unregistered sender; penalties are 15-day outgoing bar then one-year disconnection. (https://www.medianama.com/2012/07/223-implications-of-delhi-high-courts-removal-of-the-200-sms-per-day-limit-in-india/ ; https://www.medianama.com/2020/06/223-trai-removes-regulation-requiring-telcos-to-charge-for-more-than-100-sms-per-user/ ; https://www.pib.gov.in/PressReleasePage.aspx?PRID=2102413&reg=48&lang=2)
- **M2M SIM whitelist is 100 IPs/URLs by DoT rule but exempt on private networks/VPN** After the 21 March 2024 amendment: calls and SMS to/from max 4 predefined numbers each, data to max 100 predefined public IPs/URLs with fixed APN; restrictions 'do not apply to data communication on private networks or virtual private networks'; the list is given to the TSP at issuance and can be changed on request; emergency numbers exempt. If M2M SIMs are ever used, the hub's SMS modem number and the owner's phone must be among the 4 numbers, and the VPS/Tailscale control and DERP hosts would need whitelisting (impractical for Tailscale; fits a single fixed-IP VPS + WireGuard/MQTT). (https://www.saikrishnaassociates.com/dot-amends-the-kyc-instructions-for-the-m2m-connections/)
- **AT/SMS adapter gotchas not covered** AT+CMGL response in text mode: '+CMGL: index,status,address,[address_text],[timestamp][,address_type,length]<CR><LF>body', default filter REC UNREAD; PDU mode returns SMSC+TPDU instead. Query AT+CNMI=? and AT+CMGF=? before setting, since supported tuples vary. PDU length for AT+CMGS counts TPDU octets only (hex chars / 2, excluding the SMSC prefix). serialport-gsm (4.0.1) has not been published since Nov 2022, so plan to drive the modem directly with serialport 13.0.0 and a small AT state machine (wait for '> ' before sending body, terminate with 0x1A, treat +CMS ERROR as failure, serialise commands). On LTE-only networks check AT+CEREG? and confirm the modem supports SMS over LTE (IMS/SGs) with the chosen operator. (https://www.developershome.com/sms/cmglCommand.asp ; https://www.developershome.com/sms/cmgsCommand4.asp ; https://registry.npmjs.org/serialport-gsm)
- **ZeroTier licence and relay behaviour** ZeroTierOne core is now MPL-2.0 with a separate source-available licence for nonfree/ (controller); the free Personal plan is for 'personal, non-commercial use'. Relay check: 'zerotier-cli peers' shows a TCP-relay note; self-hosted relay is configured in local.conf with "tcpFallbackRelay": "<ip>/<port>" and optionally "forceTcpRelay": true. (https://raw.githubusercontent.com/zerotier/ZeroTierOne/dev/LICENSE.txt ; https://docs.zerotier.com/relay/ ; https://www.zerotier.com/pricing/)

## Calls

### Detect CGNAT on a SIM device/router

```
http GET Compare the modem/router's reported WAN IP (router status page, or AT+CGPADDR on a modem) with the address seen by an external echo service; if WAN IP is in 100.64.0.0/10, 10/8, 172.16/12, 192.168/16 or equals 192.0.0.2 (464XLAT), inbound is impossible
```
- Params: none
- Auth: router admin login where applicable
- Response: WAN IP string
- Notes: Jio mobile shows 192.0.0.2/32 (464XLAT CLAT); Airtel mobile typically 100.64.x.x. Do not attempt inbound adapters when this test fails.
- Source: https://datatracker.ietf.org/doc/html/rfc6598

### Tailscale: bring hub up

```
tailscale CLI tailscale up --hostname=house-hub
```
- Params: --ssh optional; --advertise-tags=tag:hub optional
- Auth: Tailscale account (free Personal plan, 6 users)
- Response: login URL on first run; 'Success.'
- Notes: Run on the Windows hub now and the Pi later; the phone installs the Android app (Android 8.0+).
- Source: https://tailscale.com/kb/1019/subnets

### Tailscale: 4G router / Pi as subnet router for camera LAN

```
tailscale CLI tailscale set --advertise-routes=192.168.50.0/24
```
- Params: comma-separated CIDRs of the camera LAN behind the 4G router
- Auth: Tailscale admin console: Machines > device > Edit route settings > approve (or autoApprovers in ACL)
- Response: route appears in admin console as pending until approved
- Notes: Linux needs net.ipv4.ip_forward=1. On GL.iNet use the GUI instead (next endpoint).
- Source: https://tailscale.com/kb/1019/subnets

### GL.iNet cellular router: enable Tailscale + advertise LAN

```
http GUI Admin Panel > APPLICATIONS > Tailscale > Enable > Apply > click 'Device Bind Link' > authenticate > enable 'Allow Remote Access LAN' (v4.9+: 'Advertise LAN Subnets')
```
- Params: none
- Auth: router admin password + Tailscale login
- Response: router shows its 100.x Tailscale IP
- Notes: Firmware >= 4.2. Supported cellular models: GL-X3000 (Spitz AX), GL-XE3000 (Puli AX), GL-X2000. GL-X750/GL-XE300 are NOT supported.
- Source: https://docs.gl-inet.com/router/en/4/interface_guide/tailscale/

### Tailscale: check relay vs direct / DERP list

```
tailscale CLI tailscale status ; tailscale netcheck ; tailscale ping <peer>
```
- Params: none
- Auth: local
- Response: status shows 'relay "blr"' (Bengaluru DERP) or 'direct <ip:port>' per peer; netcheck lists nearest DERP and NAT type
- Notes: Both sides behind hard NAT (typical for CGNAT 4G) stay on DERP; expose UDP 41641 on any peer with a public IP (e.g. VPS) to get direct paths.
- Source: https://tailscale.com/kb/1232/derp-servers

### Reach camera over tailnet (RTSP/ONVIF/HTTP)

```
rtsp GET rtsp://<user>:<pass>@192.168.50.21:554/<vendor-path>  (via advertised subnet) or http://192.168.50.21/<vendor-cgi>
```
- Params: camera LAN IP behind the 4G router
- Auth: camera credentials
- Response: stream / ONVIF SOAP
- Notes: Works only for cameras placed behind the Tailscale-capable router; not for a camera holding its own SIM. go2rtc/Frigate on the hub can consume this and re-stream to the PWA.
- Source: https://tailscale.com/kb/1019/subnets

### WireGuard: 4G router to VPS rendezvous (peer behind CGNAT)

```
wireguard-udp config [Peer] PublicKey=<vps-key> Endpoint=<vps-public-ip>:51820 AllowedIPs=10.7.0.0/24 PersistentKeepalive=25
```
- Params: router side initiates; VPS side AllowedIPs=10.7.0.2/32,192.168.50.0/24 and no Endpoint
- Auth: WireGuard key pairs
- Response: handshake in 'wg show'
- Notes: Alternative to Tailscale when you want no third-party control plane; requires a VPS with a public IP. Hub and phone also peer with the VPS.
- Source: https://www.wireguard.com/quickstart/

### Cloudflare Tunnel: create and run (hub HTTP API only)

```
https CLI cloudflared tunnel login ; cloudflared tunnel create house-hub ; cloudflared tunnel route dns house-hub hub.example.com ; cloudflared tunnel run house-hub
```
- Params: config.yml: tunnel: <UUID> credentials-file: <path>/<UUID>.json ingress:   - hostname: hub.example.com     service: http://localhost:8000   - service: http_status:404
- Auth: Cloudflare account with domain DNS on Cloudflare
- Response: tunnel registered; hostname resolves to Cloudflare edge
- Notes: Outbound only: allow TCP+UDP 7844 to region1.v2.argotunnel.com / region2.v2.argotunnel.com. Free. Do not push camera video through it (CDN terms). Put Cloudflare Access in front of the hostname.
- Source: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/

### Cloudflare private network route (non-HTTP, needs WARP on phone)

```
https CLI cloudflared tunnel route ip add 192.168.50.0/24 house-hub
```
- Params: CIDR of camera LAN, tunnel name
- Auth: Zero Trust org; phone must run Cloudflare One (WARP) client enrolled in the org
- Response: route listed in Zero Trust > Networks > Routes
- Notes: Doc confirms private routes carry HTTP and non-HTTP traffic and require the client; the exact 'route ip add' CLI string was not captured from the fetched page (medium confidence on syntax).
- Source: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/

### ZeroTier: join network

```
zerotier-udp CLI zerotier-cli join <16-hex-network-id> ; then authorize the node in my.zerotier.com
```
- Params: network id
- Auth: ZeroTier Central account (free: 10 devices, 1 network, 1 admin)
- Response: '200 join OK'; node gets a ZT IP after authorization
- Notes: UDP 9993 hole-punching; falls back to a slow TCP relay when UDP fails; self-host 'zerotier/pylon reflect' if needed.
- Source: https://www.zerotier.com/pricing/

### MQTT broker for SIM-only relays/lights (device dials out)

```
mqtt CONNECT/SUBSCRIBE mqtts://broker.example.com:8883  (broker on VPS or on the hub if the hub is reachable via a public path)
```
- Params: username/password per device; TLS; keepalive 60
- Auth: per-device credentials
- Response: CONNACK
- Notes: Because the hub itself is usually behind Jio/Airtel fibre CGNAT, the broker must live where the SIM device can reach it (VPS), and the hub subscribes outbound. Node: aedes (broker) or Mosquitto; mqtt (client).
- Source: https://tasmota.github.io/docs/MQTT/

### Tasmota: switch a relay over MQTT

```
mqtt PUBLISH topic cmnd/<device_topic>/POWER  payload ON | OFF | TOGGLE
```
- Params: POWER1..POWERn for multi-channel
- Auth: broker credentials
- Response: stat/<device_topic>/POWER  ON|OFF ; availability on tele/<device_topic>/LWT Online|Offline
- Notes: Use the stat/... reply as the 'done' event that triggers the phone notification.
- Source: https://tasmota.github.io/docs/MQTT/

### Tasmota: point device at broker (and change WiFi)

```
http GET http://<device-ip>/cm?cmnd=Backlog%20MqttHost%20broker.example.com%3B%20MqttPort%208883%3B%20MqttUser%20u%3B%20MqttPassword%20p%3B%20Topic%20gate1
```
- Params: same Backlog can carry 'SSID2 <ssid>; Password2 <pw>' to add a second WiFi; Tasmota fails over between SSID1/SSID2
- Auth: Tasmota web password if set
- Response: JSON echo of each command; device reboots
- Notes: The same Backlog can be sent as an MQTT payload to cmnd/<topic>/Backlog when the device is already connected - this is the SIM-path way to re-point WiFi.
- Source: https://tasmota.github.io/docs/MQTT/

### Shelly Gen2+: outbound websocket to hub

```
http POST http://<shelly-ip>/rpc  body {"id":1,"method":"Ws.SetConfig","params":{"config":{"enable":true,"server":"wss://hub.example.com/shelly","ssl_ca":"ca.pem"}}}
```
- Params: enable, server (wss:// for TLS), ssl_ca ('*' disables validation)
- Auth: Shelly device auth if enabled
- Response: {"restart_required":true} then device reconnects outbound and sends NotifyFullStatus
- Notes: Over that socket the hub sends RPC frames {"id":n,"src":"hub","method":"Switch.Set","params":{"id":0,"on":true}} and WiFi.SetConfig to re-point networks; Mqtt.SetConfig is the MQTT equivalent.
- Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Ws/

### Tuya cloud (India DC): get token

```
cloud GET https://openapi.tuyain.com/v1.0/token?grant_type=1
```
- Params: headers: client_id, sign, t (13-digit ms), sign_method=HMAC-SHA256, nonce (uuid)
- Auth: sign = HMAC-SHA256(client_id + t + nonce + stringToSign, secret).toUpperCase(); stringToSign = METHOD\n + SHA256(body)\n + \n + URL
- Response: {"result":{"access_token","expire_time","refresh_token","uid"},"success":true}
- Notes: Empty-body SHA256 = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855. Region 'in' per tinytuya.
- Source: https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g

### Tuya cloud: send command to a SIM device (camera PTZ / relay)

```
cloud POST https://openapi.tuyain.com/v1.0/devices/{device_id}/commands
```
- Params: {"commands":[{"code":"switch_1","value":true}]}  (codes from GET /v1.0/devices/{device_id}/functions, e.g. ptz_control)
- Auth: headers client_id, access_token, sign (str = client_id + access_token + t + nonce + stringToSign), t, sign_method, nonce
- Response: {"result":true,"success":true,"t":...}
- Notes: Works through CGNAT because the device holds its own MQTT session to Tuya. IoT Core trial expires monthly - renew or the calls fail.
- Source: https://developer.tuya.com/en/docs/cloud/device-control?id=K95zu01ksols7

### Tuya cloud: device status / functions

```
cloud GET https://openapi.tuyain.com/v1.0/devices/{device_id}/status ; https://openapi.tuyain.com/v1.0/devices/{device_id}/functions
```
- Params: device_id from Tuya IoT platform (link the Smart Life app account)
- Auth: same signed headers
- Response: {"result":[{"code":"switch_1","value":true}, ...]}
- Notes: Poll for 'done' confirmation after a command, or subscribe to Tuya's message service (wss://mqe.tuyain.com:8285/).
- Source: https://developer.tuya.com/en/docs/cloud/device-control?id=K95zu01ksols7

### Hikvision Hik-Connect (vendor P2P) - no API

```
cloud n/a Device menu Network > Advanced > Platform Access > Hik-Connect: enable, set verification code; control only via Hik-Connect app/SDK
```
- Params: none
- Auth: Hik-Connect account
- Response: status Online
- Notes: Device dials out; the hub cannot script it. For hub control of a Hikvision camera on a SIM, place it behind the Tailscale router and use ISAPI on the LAN instead.
- Source: https://support.visiotechsecurity.com/hc/en-us/articles/8385761017756-P2P-cloud-ports-targeted-by-a-Hikvision-device

### USB LTE modem: init and health (AT)

```
serial AT AT\r ; ATE0\r ; AT+CPIN?\r ; AT+CSQ\r ; AT+CREG?\r ; AT+COPS?\r
```
- Params: serial port e.g. COM5 (Windows) or /dev/ttyUSB2 (Pi), 115200 8N1
- Auth: none (PIN via AT+CPIN="1234" if set)
- Response: OK ; +CPIN: READY ; +CSQ: <rssi>,<ber> ; +CREG: 0,1 (home) or 0,5 (roaming) ; +COPS: 0,0,"<operator>",7
- Notes: Use an LTE modem (SIM7600/A7670/EC200U or E3372 in stick mode); 2G modules cannot register on Jio.
- Source: https://www.developershome.com/sms/operatingMode2.asp

### USB LTE modem: select SMS text mode and charset

```
serial AT AT+CMGF=1\r ; AT+CSCS="GSM"\r
```
- Params: AT+CMGF=? -> +CMGF: (0,1)
- Auth: none
- Response: OK
- Notes: Text mode is enough for ASCII commands like 'GATE OPEN'. For Unicode/Kannada or >160 chars, use PDU mode (AT+CMGF=0) with UCS-2 and concatenation UDH.
- Source: https://www.developershome.com/sms/operatingMode2.asp

### USB LTE modem: send SMS (text mode)

```
serial AT AT+CMGS="+919876543210"\r  -> wait for '> '  -> GATE OPEN  -> 0x1A
```
- Params: optional ,145 type-of-address for international format
- Auth: none
- Response: +CMGS: <mr>\r\nOK  (or +CMS ERROR: <n>); send 0x1B (ESC) to abort at the prompt
- Notes: Serialize commands; wait for the '> ' prompt before writing the body; 30 s timeout.
- Source: https://www.diafaan.com/sms-tutorials/gsm-modem-tutorial/at-cmgs-text-mode/

### USB LTE modem: send SMS (PDU mode)

```
serial AT AT+CMGF=0\r ; AT+CMGS=<tpdu_len>\r -> '> ' -> <hex SMSC+TPDU> -> 0x1A
```
- Params: tpdu_len = octets of TPDU excluding SMSC (e.g. 42)
- Auth: none
- Response: +CMGS: <mr> OK
- Notes: Needed for status reports, validity period, flash SMS, UCS-2 and concatenated SMS.
- Source: https://www.developershome.com/sms/cmgsCommand4.asp

### USB LTE modem: receive SMS notifications

```
serial AT AT+CNMI=2,1,0,0,0\r
```
- Params: mode=2 buffer/forward URCs, mt=1 -> +CMTI index notifications
- Auth: none
- Response: unsolicited: +CMTI: "SM",<index>  ; then AT+CMGR=<index> -> +CMGR: "REC UNREAD","+91...",,"26/09/30,10:15:00+22"\r\n<body>
- Notes: Use for device 'DONE' replies (GSM relays / gate controllers that answer by SMS). +CDSI/+CDS carry delivery status reports.
- Source: https://www.developershome.com/sms/resultCodes3.asp

### USB LTE modem: list and delete SMS

```
serial AT AT+CMGL="REC UNREAD"\r  |  AT+CMGL="ALL"\r  ;  AT+CMGD=<index>\r
```
- Params: status: REC UNREAD | REC READ | STO UNSENT | STO SENT | ALL
- Auth: none
- Response: +CMGL: 1,"REC READ","+85291234567",,"07/05/01,08:00:15+32",145,37\r\n<body> ... OK ; AT+CMGD -> OK
- Notes: Poll AT+CMGL as a fallback if +CMTI URCs are missed; delete after processing to avoid SIM storage filling (typically 20-50 slots).
- Source: https://www.developershome.com/sms/cmglCommand.asp

### Huawei HiLink stick: send SMS via HTTP/XML

```
http POST http://192.168.8.1/api/sms/send-sms
```
- Params: XML: <request><Index>-1</Index><Phones><Phone>+919876543210</Phone></Phones><Sca></Sca><Content>GATE OPEN</Content><Length>9</Length><Reserved>1</Reserved><Date>2026-09-30 10:15:00</Date></request>
- Auth: GET /api/webserver/SesTokInfo first; send Cookie: SessionID and header __RequestVerificationToken; admin login for some firmwares
- Response: <response>OK</response> or <error><code>...</code></error>
- Notes: E3372/E3131/E8372h/E3531 in HiLink (NETwork) mode only. Raw XML fields from MikroTik-forum write-up (medium); use huawei-lte-api (Python, LGPL-3.0) or its Node ports to avoid hand-rolling the token dance.
- Source: https://github.com/Salamek/huawei-lte-api

### Android SMS Gateway app (spare phone) - send

```
http POST http://<phone-lan-or-tailscale-ip>:8080/message
```
- Params: {"message":"GATE OPEN","phoneNumbers":["+919876543210"]}
- Auth: HTTP Basic (username/password shown in the app)
- Response: {"id":"...","state":"Pending","recipients":[...]}
- Notes: Local-server mode; put the phone on the tailnet so the hub can reach it from anywhere. Webhooks (sms:received, sms:delivered, sms:failed) POST back to the hub.
- Source: https://github.com/capcom6/android-sms-gateway

### PWA manual SMS hand-off (Android)

```
sms link sms:+919876543210?body=GATE%20OPEN
```
- Params: body = encodeURIComponent(text); alternative scheme smsto:+91...
- Auth: none
- Response: opens default SMS app with recipient and body prefilled; user taps Send
- Notes: Use <a href> or location.href from the PWA; multiple recipients 'sms:+91a,+91b?body=' work on Android only. No way to send silently from the web.
- Source: https://sethmlarson.dev/sms-urls

### PWA manual SMS hand-off (iPhone)

```
sms link sms:+919876543210?body=GATE%20OPEN
```
- Params: single recipient only; '&body=' is the legacy iOS form (unverified here)
- Auth: none
- Response: opens Messages with body prefilled
- Notes: Apple's archived scheme doc documents only 'sms:1-408-555-1212' (digits, +, -, .) and predates body support; tested behaviour shows ?body= works.
- Source: https://sethmlarson.dev/sms-urls

### Android native compose intent (if a wrapper app is ever built)

```
sms intent Intent(Intent.ACTION_SENDTO).apply { data = Uri.parse("smsto:+919876543210"); putExtra("sms_body", "GATE OPEN") }
```
- Params: smsto: URI + sms_body extra
- Auth: none
- Response: SMS app opens; 'Only SMS apps respond to this'
- Notes: Silent sending would need SEND_SMS permission in a native app - not available to a PWA.
- Source: https://developer.android.com/guide/components/intents-common

## Facts

- **100.64.0.0/10 is IANA 'Shared Address Space' reserved for carrier-grade NAT (CGN) between ISP and CPE; addresses in it are not globally routable.** [high] RFC 6598 allocates 100.64.0.0/10 (100.64.0.0-100.127.255.255) for service providers to number CGN-to-CPE links. A WAN/mobile IP in this range means the device is behind CGNAT and unsolicited inbound packets never reach it. (https://datatracker.ietf.org/doc/html/rfc6598)
- **Airtel places residential fibre, AirFiber and cellular connections behind CGNAT on 100.64.0.0/10 and drops unsolicited inbound packets at its gateway, so port-forwarding rules on the router do nothing.** [medium] Third-party guide; no Airtel primary statement found. Consistent with generic cellular guidance (pondiot, roamingsim) that a mobile interface IP starting 100.64-127, 10., or 172.16-31 is private and unreachable from outside. (https://natchecker.com/blog/airtel-port-forwarding)
- **Jio mobile (5G, and LTE once 5G has been enabled on the SIM) is an IPv6-only 464XLAT network: the handset gets 192.0.0.2/32 (RFC 7335 service-continuity prefix) for IPv4, IPv4 destinations are reached via DNS64/NAT64, and 'there is no IPv4 on transport'.** [high] Network engineer Anurag Bhatia's measurements on Jio 5G in Feb 2023. Implication: a Jio-SIM device has no public IPv4 by construction; only an IPv6 global address exists. (https://anuragbhatia.com/post/2023/02/jio-5g-ipv6-only/)
- **Jio connections receive a global IPv6 address (2xxx:/3xxx:) and at least one JioFiber user exposed services inbound over native IPv6 without IPv4 or port-forwarding; but other users report Jio blocking inbound IPv6 upstream and filtering ICMPv6 at its edge.** [low] dev.to write-up used dynv6 + IPv6 firewall rules on a JioFiber router successfully. broadband.forum threads titled 'Jio blocked port forwarding on IPv6' and 'JioFiber blocks ICMPv6 entirely' report the opposite (threads could not be fetched; search snippets only). Unsolicited inbound IPv6 to a Jio *mobile* SIM device is not documented anywhere found. Treat IPv6 inbound as unreliable. (https://dev.to/jagadeesh0074/exposing-services-behing-cgnat-my-home-lab-experience-with-jio-fiber-2ed2)
- **Jio has no 2G/3G network (4G/VoLTE only), so 2G-only GSM modules (SIM800L/SIM900A) will never register with a Jio SIM; use an LTE module/modem (SIM7600, A7670, Quectel EC200U, Huawei E3372) or an Airtel/BSNL SIM for 2G modules.** [medium] Relevant when choosing the hub's USB modem for SMS. Secondary (Indian hobby-electronics vendor) source. (https://zbotic.in/sim800l-vs-sim7600-gsm-vs-4g-lte-module-comparison-india/)
- **India uses a separate 13-digit numbering scheme for SIM-based M2M devices (implemented from 2018) and DoT's 16.05.2018 KYC letter requires M2M SIMs to be issued in the name of the entity providing the M2M service under the bulk-connection procedure.** [high] DoT letter of 09.12.2016 approved the 13-digit plan (+91, 3-digit M2M identifier, 4-digit licensee id, 6-digit device number); implementation from 1 Oct 2018. Consumer 10-digit postpaid SIMs are outside this regime. (https://www.indialawoffices.com/legal-articles/dot-guidelines-for-m2m-lot-stakeholders)
- **DoT's 2018 'restrictive features' for M2M SIMs limit calls and SMS to a maximum of 4 predefined numbers and data to predefined public IP addresses/URLs with a fixed APN (list supplied to the TSP at issuance); DoT amended these KYC instructions on 21.03.2024 to relax them (search snippet cites up to 100 IPs/URLs after amendment).** [medium] Page returned 403 to direct fetch; figures come from the search snippet of this law-firm summary plus the DoT summary above. The point for this project: an Indian M2M/IoT SIM is deliberately restricted to talking to a whitelist, which fits a hub-on-VPS design but not general internet use. (https://www.saikrishnaassociates.com/dot-amends-the-kyc-instructions-for-the-m2m-connections/)
- **Airtel Business IoT SIMs come with a secure/private APN, 'voice/SMS whitelisting (restricted to 4 numbers) and IP/URL whitelisting (limited to 4 addresses)', support 5G/4G/NB-IoT/LTE-M/2G, and are sold via 'Talk to an Expert' (no online price, no static-IP statement).** [medium] Airtel's own IoT page. Resellers on IndiaMART list Airtel M2M SIMs at about Rs 550-600 per SIM per year (about 10 MB/month + 200 SMS) and Airtel advertises IoT plans from Rs 29/month for 1 MB - prices are reseller/blog figures, not an Airtel tariff page. (https://www.airtel.in/b2b/iot-connectivity)
- **A public fixed-IP SIM on an Indian network is available from foreign M2M resellers at roughly GBP 95 one-off setup for 'Public Fixed IP Address with Inbound Filtering' plus about GBP 95.40 per 12 months IP rental, on top of data (search snippet: 2 GB/month, 12 months, Bharti Airtel network).** [low] Product page returned 504 twice and could not be verified directly; numbers are from the search result snippet. Illustrates that public-IP SIMs are an enterprise product costing far more than a consumer postpaid plan. (https://m2mdataconnect.com/product/india-public-fixed-ip-sim-card-2gb-prepaid-12-month/)
- **Vi Business IoT pages describe multi-network IoT eSIMs and the 'IoT Smart Central' SIM-lifecycle portal but say nothing about static or public IP; purchase is via corporate sales (7292000444 / corporatecare.india@vodafoneidea.com).** [medium] No Vi consumer or business page offering a static-IP mobile SIM was found. (https://www.myvi.in/business/internet-of-things/iot-esims)
- **Jio's business IoT pages advertise NB-IoT smart-metering and 'JioThings' solutions but publish no IoT SIM tariff, private APN or static-IP option for mobile SIMs; static IP on Jio is documented only for JioFiber business plans (third-party guides cite from about Rs 1,499/month).** [medium] jio.com/business/services/iot/ fetched; sarathifiber.com and netspaceindia.com guides for JioFiber static IP are secondary sources. (https://www.jio.com/business/services/iot/)
- **BSNL offers static IP only on wired broadband (free with plans >= Rs 2,799/month, otherwise Rs 1,800-2,000 per year on request); no BSNL 4G mobile static-IP SIM offer was found.** [low] BSNL launched pan-India 4G only in Sept 2025; search found no 4G static-IP tariff. (https://telecomtalk.info/bsnl-to-offer-static-ip-on-request-with-broadband-plans/61282/)
- **Tailscale: 'All connections start as relayed through a DERP server, and Tailscale then tries to upgrade them to a direct connection. If that fails, Tailscale tries to connect them using a peer relay. If that fails, the connection remains relayed through the DERP server.' Tailscale 'can't establish a direct connection if both devices are behind a hard NAT'.** [high] Opening UDP 41641 on a public IP guarantees direct connections; that is impossible behind CGNAT, so a 4G-router peer will usually be relayed unless the other side (hub) has a public UDP path. Relay is adequate for control and moderate video. (https://tailscale.com/docs/reference/connection-types)
- **Tailscale operates a DERP relay in Bengaluru (India); DERP is the fallback 'when a direct connection isn't possible' due to 'hard NAT, firewalls, or another reason'; 'tailscale netcheck' lists the DERP servers applicable to a device.** [high] Low relay latency from Karnataka. DERP runs over HTTPS (TCP 443), which survives almost any carrier filtering. (https://tailscale.com/kb/1232/derp-servers)
- **Tailscale Personal plan is '$0 Free forever', 'Up to 6 users', 'Unlimited user devices', 'Up to 3 ACL groups', 'Up to 50 tagged resources to start', '1,000 mins per month for ephemeral resources'; the next tier (Standard) is $8 per user per month.** [high] Validated on Tailscale's pricing page and the free-plans doc (last validated 8 April 2026). (https://tailscale.com/pricing)
- **A Tailscale subnet router advertises a LAN so devices that cannot run Tailscale ('printers or cameras') become reachable: 'tailscale set --advertise-routes=192.0.2.0/24' (Linux needs IP forwarding), then approve the route in the admin console (or autoApprovers).** [high] This is how a 4G router or Pi in front of cameras exposes their RTSP/ONVIF/HTTP to the hub and phone over the tailnet. (https://tailscale.com/kb/1019/subnets)
- **Tailscale assigns node addresses from the same 100.64.0.0/10 CGNAT range carriers use; the doc warns 'conflicts might occur' when other VPNs use the same space and gives no specific carrier workaround.** [medium] On a 4G router whose WAN address is 100.64.x.x, a Tailscale 100.x peer address could overlap; keep an eye on routing tables and use MagicDNS names rather than raw 100.x IPs. (https://tailscale.com/kb/1015/100.x-addresses)
- **Tailscale's Android client requires Android 8.0+, is installed from Play Store, and needs the user to accept installing a VPN configuration.** [high] Owner's phone joins the tailnet with Google SSO; no root needed. (https://tailscale.com/docs/install/android)
- **GL.iNet routers have built-in Tailscale since firmware 4.2 (Admin Panel > APPLICATIONS > Tailscale) with 'Allow Remote Access LAN' (renamed 'Advertise LAN Subnets' in 4.9+), exit-node options, and a 'Device Bind Link' login; cellular models GL-X3000 (Spitz AX), GL-XE3000 (Puli AX) and GL-X2000 (Spitz Plus) are supported, while GL-X750 and GL-XE300 are unsupported for lack of memory.** [high] A ready-made 4G router that can be the cameras' gateway and Tailscale subnet router with one SIM. (https://docs.gl-inet.com/router/en/4/interface_guide/tailscale/)
- **Teltonika: Tailscale is an installable package on RUTX/RUTM routers (e.g. RUTX50 Package Downloads), but low-RAM/flash models such as RUT241/RUT200 do not support it; all RutOS models support WireGuard.** [medium] Community answer from Teltonika staff plus the RUTX50 package list. (https://community.teltonika.lt/t/tailscale-supported-devices/5993)
- **WireGuard behind NAT: 'a peer behind NAT or a firewall wishes to receive incoming packets, he must keep the NAT/firewall mapping valid, by periodically sending keepalive packets'; 'A sensible interval that works with a wide variety of firewalls is 25 seconds' (PersistentKeepalive = 25).** [high] For a 4G router to VPS WireGuard tunnel: router side has Endpoint=<vps>:51820 and PersistentKeepalive=25; VPS side has AllowedIPs covering the router's tunnel IP and camera LAN. The VPS then acts as the rendezvous for hub and phone. (https://www.wireguard.com/quickstart/)
- **Cloudflare Tunnel is 'a secure way to connect your resources to Cloudflare without a publicly routable IP address'; cloudflared makes outbound connections and 'traffic flows in both directions over the tunnel'.** [high] Firewall doc: allow outbound port 7844 TCP and UDP (http2/quic) to region1.v2.argotunnel.com and region2.v2.argotunnel.com; 'No inbound ports are required'. (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/deploy-tunnels/tunnel-with-firewall/)
- **Cloudflare made the outbound-only Tunnel feature free on 15 April 2021: 'any organization can use the secure, outbound-only connection feature of the product at no cost'.** [high] Free-plan user cap for Zero Trust (widely reported as 50 users) could not be confirmed from a fetched Cloudflare page in this pass. (https://blog.cloudflare.com/tunnel-for-everyone/)
- **Cloudflare private-network routes through a tunnel 'can expose both HTTP and non-HTTP resources' (so RTSP/ONVIF work), but 'end users must connect their device to Cloudflare and enroll in your Zero Trust organization' using the Cloudflare One (WARP) client.** [high] Means the owner's phone would need the WARP client enrolled - functionally similar to installing Tailscale, with more account setup. (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/)
- **Cloudflare's application-services terms reserve the right to limit CDN use 'if you use or are suspected of using the CDN without such Paid Services to serve video or a disproportionate percentage of pictures, audio files, or other large files'.** [high] Publishing camera video on a public hostname through a free tunnel risks throttling/termination; keep video on Tailscale/WireGuard or a WARP private route. (https://www.cloudflare.com/service-specific-terms-application-services/)
- **ZeroTier Personal (free) plan: 10 devices, 1 network, 1 admin; Essential tier $18/month with 10 devices included then $2.00 each.** [high] ZeroTier's TCP relay is the fallback when UDP hole-punching fails: 'This relay service is slow for various reasons'; self-hosting a relay uses 'zerotier/pylon reflect' plus tcpFallbackRelay/forceTcpRelay in local.conf. (https://www.zerotier.com/pricing/)
- **Hik-Connect / EZVIZ P2P: the device initiates outbound connections to Hikvision's cloud, the app rendezvous through the server and then streams P2P, so no port forwarding is needed - but there is no public API; access is only through the vendor app/SDK.** [medium] Source is a Hikvision distributor knowledge base listing P2P cloud ports; go2rtc has an open feature request (#2289) for an EZVIZ/Hik-Connect cloud source, i.e. not supported today. (https://support.visiotechsecurity.com/hc/en-us/articles/8385761017756-P2P-cloud-ports-targeted-by-a-Hikvision-device)
- **Tuya-based devices (many 4G solar cameras, plugs, relays sold in India) can be commanded through Tuya's cloud REST API: POST /v1.0/devices/{device_id}/commands with {"commands":[{"code":"switch_1","value":true}]}, GET /v1.0/devices/{device_id}/status, GET /v1.0/devices/{device_id}/functions.** [high] India data centre endpoint is https://openapi.tuyain.com (tinytuya region 'in'; MQTT endpoint wss://mqe.tuyain.com:8285/). Works regardless of CGNAT because the device keeps its own outbound MQTT session to Tuya. (https://developer.tuya.com/en/docs/cloud/device-control?id=K95zu01ksols7)
- **Tuya IoT Core 'Trial Edition' expires after one month; after expiry 'the API cannot be called successfully' until the trial is extended (Cloud > Project > Extend trial period questionnaire) or a paid plan is bought.** [high] Operational risk for a Tuya-cloud adapter; build an expiry reminder into the hub. (https://support.tuya.com/en/help/_detail/Kbm9zue1v7vvu)
- **Tasmota devices control relays over MQTT with topics cmnd/<topic>/POWER (payload on/off/toggle), reply on stat/<topic>/POWER, publish availability on tele/<topic>/LWT (Online/Offline), and are pointed at a broker with 'Backlog MqttHost <host>; MqttPort <port>; MqttUser <u>; MqttPassword <p>; Topic <t>'.** [high] Device-initiated outbound TCP to the broker - works through CGNAT if the broker is on a public host (VPS) reachable from the SIM path. (https://tasmota.github.io/docs/MQTT/)
- **Shelly Gen2+ devices can hold an 'Outbound Websocket' to a server (Ws.SetConfig {enable, server (wss:// for TLS), ssl_ca}) that carries the full RPC channel 'supporting all features of inbound WS and MQTT channels' plus full status notifications on connect; they also support MQTT.** [high] Lets a Shelly relay behind a SIM router dial out to the hub/VPS and accept RPC (Switch.Set, WiFi.SetConfig) over that socket. (https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Ws/)
- **3GPP 27.005 SMS: AT+CMGF=? returns +CMGF: (0,1); 0 = PDU mode, 1 = text mode; PDU mode is the default when implemented.** [high] Text mode is simpler; PDU mode is required for status reports, validity period, flash SMS, and in practice for UCS-2/concatenated messages (text mode is limited by the modem's charset/160 GSM-7 chars). (https://www.developershome.com/sms/operatingMode2.asp)
- **Text-mode send: AT+CMGF=1 / OK, AT+CMGS="+31628870634"<CR>, modem replies '> ', write the text, terminate with Ctrl-Z (0x1A); modem answers '+CMGS: 198' then 'OK' (198 = message reference). ESC (0x1B) aborts.** [high] Optional second parameter is type-of-address (145 international, 129 unknown): AT+CMGS="+85291234567",145. (https://www.diafaan.com/sms-tutorials/gsm-modem-tutorial/at-cmgs-text-mode/)
- **PDU-mode send: AT+CMGS=<TPDU length in octets><CR> then the hex SMSC+TPDU string then Ctrl-Z; the length excludes the SMSC part.** [high] Example: AT+CMGS=42<CR>07915892000000F001000B915892214365F7000021493A283D0795C3F33C88FE06CDCB6E32885EC6D341EDF27C1E3E97E72E<Ctrl+z> (https://www.developershome.com/sms/cmgsCommand4.asp)
- **Incoming SMS: AT+CNMI enables unsolicited result codes; +CMTI reports a new message and its storage index (e.g. +CMTI: "SM",5, read with AT+CMGR=5), +CMT forwards the message directly, +CDSI/+CDS do the same for status reports. AT+CNMI=2,1,0,0,0 is the common setting for +CMTI notifications.** [high] AT+CMGL="REC UNREAD" / "ALL" lists stored messages as '+CMGL: index,status,address,,timestamp' followed by the body; AT+CMGD=<index> deletes. (https://www.developershome.com/sms/resultCodes3.asp)
- **Huawei HiLink USB sticks (E3372, E3131, E8372h, E3531) expose an HTTP/XML API at http://192.168.8.1/ rather than a serial AT port; huawei-lte-api (LGPL-3.0, Python) wraps it: client.sms.send_sms(['+91...'], 'text'). It 'wont work with serial mode'.** [high] Raw endpoint used by the library: POST /api/sms/send-sms with an XML <request> (Index -1, Phones, Sca, Content, Length, Reserved 1, Date) after fetching a session/token from /api/webserver/SesTokInfo and sending __RequestVerificationToken (MikroTik forum write-up, medium confidence). (https://github.com/Salamek/huawei-lte-api)
- **'SMS Gateway for Android' (capcom6, Apache-2.0, Android 5.0+) turns a spare phone into an SMS API: local HTTP server on the phone (POST http://<phone-ip>:8080/message, basic auth, JSON message + phoneNumbers), optional cloud/private server mode, webhooks for sms:received, sms:delivered, sms:failed, multi-SIM support.** [high] Alternative to a USB modem on Windows/Pi; a Jio/Airtel postpaid SIM in the phone is a normal 10-digit consumer SIM. (https://github.com/capcom6/android-sms-gateway)
- **RFC 5724 sms URI: sms:<recipient>[,<recipient>]?body=<percent-encoded UTF-8>, fields separated by '&'; example sms:+15105550101?body=hello%20there. Implementations must convert the body to a suitable SMS charset (usually GSM 7-bit).** [high] ABNF: sms-uri = 'sms:' sms-hier-part [ '?' sms-fields ]; body MUST NOT appear more than once. (https://www.rfc-editor.org/rfc/rfc5724.html)
- **Tested behaviour: 'sms:+15551234567?body=Hello%20world!' opens the SMS composer with the body prefilled on both Android and iPhone; multiple comma-separated recipients work on Android but not on iPhone.** [high] Apple's archived URL-scheme doc only documents 'sms:1-408-555-1212' and says the string 'must not include any message text' - it predates iOS body support; the older iOS form 'sms:+1555&body=...' is widely reported but was not verified by a primary source here (low). (https://sethmlarson.dev/sms-urls)
- **Android native composing: Intent(ACTION_SENDTO) with data Uri 'smsto:<phone_number>' and extra "sms_body" = message; 'Only SMS apps respond to this'.** [high] A PWA cannot fire this intent directly; it uses an <a href="sms:...?body=..."> or location.href, which Chrome hands to the default SMS app. There is no web API to send SMS silently. (https://developer.android.com/guide/components/intents-common)
- **TRAI limits ordinary SIMs to 200 SMS per day per SIM (raised from 100), with registered telemarketers/transactional senders exempt; on 25 Jan 2012 TRAI exempted machine-to-machine and person-to-machine messages from the 200/day limit.** [high] PR No.13of2012. Home-automation commands from a personal SIM to the owner's own devices are P2M/P2P non-commercial traffic; the practical constraint is the 200/day cap unless the SIM is registered for M2M. (https://www.trai.gov.in/what-s-new/trai-extends-100-sms-day-sim-limit-200-sms-day-sim)
- **TRAI's TCCCPR Second Amendment (12 Feb 2025) targets commercial communication sent from ordinary 10-digit numbers by Unregistered Telemarketers: action threshold cut to 5 complaints in 10 days, response time 5 days, first breach bars outgoing services on all the sender's telecom resources for 15 days, repeat breaches disconnect all resources for one year; promotional content mixed into any message makes the whole message promotional.** [medium] DLT/A2P registration (header + template) is required only for commercial/promotional or business transactional traffic; a homeowner's device commands and 'done' notifications to himself are not commercial communication, but avoid anything that looks promotional and keep volume low. (https://www.pib.gov.in/PressReleasePage.aspx?PRID=2102413&reg=48&lang=2)
- **Node serialport 13.0.0 (MIT) supports Linux, macOS and Windows with prebuilt binaries; serialport-gsm 4.0.1 (MIT) wraps AT SMS commands but was last published Nov 2022; aedes 1.2.0 (MIT) is an embeddable MQTT broker; mqtt 5.16.0 (MIT) is the client; web-push 3.6.7 is MPL-2.0.** [high] Queried from the npm registry API (registry.npmjs.org/<pkg>/latest) on 2026-09-30. (https://registry.npmjs.org/serialport/latest)
- **Licences: tailscale (BSD-3-Clause), cloudflared (Apache-2.0), ZeroTierOne (Business Source License 1.1).** [high] From the projects' GitHub LICENSE files. (https://github.com/tailscale/tailscale/blob/main/LICENSE)

## Limits and caveats

- Inbound to a consumer SIM is not a solvable engineering problem: Airtel/Vi/BSNL mobile use CGNAT (100.64/10) and Jio mobile is IPv6-only 464XLAT with no IPv4 on transport; only device-initiated outbound paths, vendor clouds, SMS, or a public-IP M2M SIM (enterprise KYC, whitelisted IPs, roughly GBP 95 setup + GBP 95/yr rental per SIM via resellers - low confidence on price) can reach such a device.
- IPv6 inbound on Jio is contradictory in the wild: one JioFiber user exposed services over native IPv6; forum threads report Jio blocking inbound IPv6 and ICMPv6 upstream. Nothing was found documenting unsolicited inbound IPv6 to a Jio mobile SIM device. Do not design around it.
- Indian M2M/IoT SIMs (13-digit numbers) are legally restricted: DoT 2018 rules whitelist calls/SMS to 4 numbers and data to a fixed set of public IPs/URLs on a fixed APN (relaxed by a March 2024 amendment - exact new limits unverified, page 403). They are issued to entities under bulk KYC, not to individuals.
- The hub's own home connection (Jio Fibre / Airtel Xstream) is also CGNAT, so the phone reaching the hub requires the same overlay (Tailscale/WireGuard/Cloudflare) - and the hub needs its own LTE uplink (USB modem or 4G router as second WAN) to stay reachable when the home router is reset.
- Tailscale and carriers both use 100.64.0.0/10; Tailscale's docs only warn of conflicts with other VPNs, but a 4G router whose WAN is 100.64.x.x could collide with a tailnet address - prefer MagicDNS names and check routes. Two CGNAT peers stay on the Bengaluru DERP relay, which is fine for commands/PTZ but throughput-limited for multiple HD streams; a VPS with UDP 41641 open (or Tailscale peer relay) restores direct paths.
- Cloudflare Tunnel is free but its terms let Cloudflare throttle accounts that serve video or large media through the CDN without a paid product; private-network mode needs the WARP client enrolled on the phone. Use it only for the hub's HTTP UI/API, not for camera video.
- ZeroTier's free tier shrank to 10 devices / 1 network / 1 admin, and its TCP relay fallback is explicitly 'slow'; acceptable but Tailscale's free tier is more generous for this use.
- SMS regulation: 200 SMS/day/SIM cap on ordinary SIMs (M2M/P2M exempt only for registered senders), and the Feb-2025 TCCCPR amendment can bar a 10-digit number for 15 days / disconnect for a year if it is reported as an unregistered telemarketer (5 complaints in 10 days). Personal device commands to your own devices are non-commercial P2P/P2M traffic, but keep them terse, never promotional, low-volume, and only to numbers you own. No DLT registration is needed for that; it would be needed if the hub ever messages other people commercially.
- SMS text mode is GSM-7 only (160 chars); Kannada/Unicode or long messages need PDU mode with UCS-2 and UDH concatenation. Most 4G cameras do not accept SMS commands at all - SMS is mainly useful for GSM relay/gate modules and for hub<->owner alerts.
- Huawei HiLink sticks (E3372 etc.) are not serial modems; they need the HTTP/XML API with session/token handling. Stick-mode firmware exposes AT ports instead. Buy one or the other deliberately.
- serialport-gsm (npm) is MIT but has not been published since Nov 2022; consider driving AT commands directly with serialport (13.0.0, MIT) and a small state machine, or use the Android SMS Gateway app (Apache-2.0) on a spare phone.
- Tuya IoT Core's free Trial Edition expires monthly; when it lapses every cloud call fails until extended. Hik-Connect/EZVIZ P2P cameras have no public API at all - a SIM camera of that kind can only be controlled from the vendor app.
- Several sources could not be fetched directly (PIB and law-firm pages 403, broadband.forum browser-check, m2mdataconnect 504) and the Firecrawl MCP account is out of credits; those facts are marked medium/low and taken from search snippets or secondary summaries. The TRAI 2025 amendment PDF was fetched but is binary; figures come from PIB/Khaitan summaries.

## Libraries

- **tailscale** (binary, BSD-3-Clause, current (Windows, Linux/arm64, Android)): Overlay network for hub, phone and the cameras' 4G router; free Personal plan (6 users, unlimited devices); DERP relay in Bengaluru handles CGNAT; subnet-router mode exposes camera LAN. https://github.com/tailscale/tailscale
- **wireguard-tools / wireguard-go** (binary, GPL-2.0 (kernel/tools) / MIT (wireguard-go), current): Self-hosted alternative: 4G router and hub both dial out to a small VPS with PersistentKeepalive=25; no third-party control plane. https://www.wireguard.com/quickstart/
- **cloudflared** (binary, Apache-2.0, current): Free outbound-only tunnel for the hub's HTTP UI/API behind Cloudflare Access; not for video. https://github.com/cloudflare/cloudflared
- **zerotier-one** (binary, BUSL-1.1, current): Alternative overlay; free tier 10 devices / 1 network; slower TCP relay fallback. https://github.com/zerotier/ZeroTierOne
- **serialport** (npm, MIT, 13.0.0): Drive a USB LTE modem's AT port from Node on Windows now and the Pi later (prebuilt binaries for win32 and linux-arm). https://registry.npmjs.org/serialport/latest
- **serialport-gsm** (npm, MIT, 4.0.1 (last published 2022-11-24)): Ready-made sendSMS / onNewMessage / executeCommand over AT; usable but stale - fall back to raw serialport if it misbehaves with a modern LTE modem. https://registry.npmjs.org/serialport-gsm/latest
- **aedes** (npm, MIT, 1.2.0): Embeddable MQTT broker (run on the VPS or hub) for Tasmota/Shelly relays that must dial out through CGNAT. https://registry.npmjs.org/aedes/latest
- **mqtt** (npm, MIT, 5.16.0): Hub-side MQTT client (subscribe to stat/tele topics to fire completion notifications). https://registry.npmjs.org/mqtt/latest
- **web-push** (npm, MPL-2.0, 3.6.7): Send Web Push notifications to the PWA when an action completes; outbound-only from the hub so it works from behind CGNAT. https://registry.npmjs.org/web-push/latest
- **huawei-lte-api** (python, LGPL-3.0, current): Reference implementation of the Huawei HiLink token/session dance and /api/sms/send-sms XML if an E3372-class HiLink stick is used; port the logic to Node or shell out. https://github.com/Salamek/huawei-lte-api
- **tinytuya** (python, MIT (per repository; not re-verified in this pass), current): Reference for Tuya cloud signing and the India region endpoint (openapi.tuyain.com); its Cloud.sendcommand mirrors POST /v1.0/devices/{id}/commands for Tuya-based 4G cameras/relays. https://github.com/jasonacox/tinytuya/blob/master/README.md
- **android-sms-gateway (SMS Gateway for Android)** (binary, Apache-2.0, current APK from GitHub releases): Turns a spare Android phone with a postpaid SIM into an HTTP SMS API (local server on :8080, webhooks for received/delivered) - simplest SMS path on a Windows hub without a modem. https://github.com/capcom6/android-sms-gateway

## Could not be verified (treat as uncertain)

- Jio gives global IPv6; one JioFiber user exposed services inbound over IPv6; others report Jio blocking inbound IPv6 / ICMPv6 — The dev.to JioFiber success case is confirmed (dynv6 AAAA + router IPv6 firewall rule at 192.168.29.1 + UFW). The 'Jio blocks inbound IPv6 / ICMPv6' forum reports could not be fetched and nothing documents inbound IPv6 to a Jio mobile SIM. Treat as unknown; test per SIM.
- Public fixed-IP SIM on an Indian network from m2mdataconnect at about GBP 95 setup + GBP 95.40 per 12 months IP rental — Product URL now returns HTTP 404; no price could be confirmed. Do not rely on these numbers.
- ENDPOINT cloudflared tunnel route ip add 192.168.50.0/24 house-hub (phone needs WARP client enrolled) — The WARP/enrolment requirement is confirmed, and the create-local-tunnel page shows that a locally-managed tunnel used for private networks needs 'warp-routing: enabled: true' in config.yml. The exact 'tunnel route ip add' CLI line could not be quoted from a fetched page in this pass (it is the long-standing cloudflared syntax; verify with 'cloudflared tunnel route ip --help').
- ENDPOINT Hik-Connect: device menu Network > Advanced > Platform Access > Hik-Connect, verification code; control only via app/SDK — Cited Visiotech page returns 403 and the menu path was not checked against a Hikvision manual. See the Hik-Connect/EZVIZ fact verdict: EZVIZ-branded cameras do have a usable cloud API (Home Assistant ezviz integration).
- ENDPOINT Modem init: AT, ATE0, AT+CPIN?, AT+CSQ, AT+CREG?, AT+COPS?; 115200 8N1; COM5 or /dev/ttyUSB2 — These are standard 3GPP TS 27.007 commands but the cited developershome page only covers AT+CMGF; port names and baud rate are modem-specific examples, not sourced. On an LTE-only network (Jio) registration should be checked with AT+CEREG? rather than AT+CREG?.
- ENDPOINT AT+CNMI=2,1,0,0,0 for +CMTI notifications — URC semantics confirmed; the exact parameter tuple is not on the cited page and accepted values differ per modem (query AT+CNMI=?).
