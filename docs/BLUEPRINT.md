# House Control — Blueprint

One private app that runs the whole house: cameras, the main gate, lights and
switches. Every device is added once with its details, stored on your own hub,
and controlled by tapping a tile. When the house WiFi is reset, the app still
reaches what it can (the device's own SIM, its cloud, or an SMS), tells you
which connection it is using, and can re-point a device at another WiFi network
without touching the vendor app.

## How it fits together

```
 phone / tablet (PWA)  ──── Tailscale or house WiFi ────▶  HUB  (this PC now, a small box later)
   big tiles, tap to act                                     │
   push notification when done                               ├─ LAN  ──▶ cameras, lights, relays on the house WiFi
                                                             ├─ 4G   ──▶ devices on their own SIM (if the SIM has a public IP)
                                                             ├─ cloud ─▶ Tuya / vendor clouds
                                                             └─ SMS  ──▶ GSM gate box, 4G cameras (USB modem, or handed to the phone)
```

* **Hub** — a Node.js server. Keeps the device registry (SQLite, secrets
  encrypted), talks every device protocol, checks each connection path every
  few seconds, fails over automatically, queues actions and confirms them,
  sends push notifications, and streams camera video to the browser (go2rtc).
* **App** — an installable web app for the phone. Dark, big touch targets,
  nothing to learn: open → tap a tile → act. Add / edit / delete devices from
  the same app.
* **Paths** — every device has an ordered list of ways to reach it:
  `Home WiFi` → `Backup WiFi` → `SIM` → `SMS`. The hub uses the first one that
  answers and shows which one it is on. You can pin one by hand.

## Phases

| # | Phase | Produces |
|---|-------|----------|
| 1 | **Foundation** | Monorepo, hub server, SQLite registry with encrypted secrets, PIN login, realtime channel, action queue with completion notifications (in-app + Web Push), the app shell with tiles, and a set of *virtual* devices so the whole flow runs end to end with no hardware. |
| 2 | **Real device adapters** | ONVIF (any camera), Hikvision ISAPI, Dahua / CP Plus CGI, TP-Link Tapo, Tasmota, Shelly, Tuya cloud + Tuya local, generic MQTT, HTTP relay, GSM gate box over SMS. Each adapter is tested against a mock of the real device. |
| 3 | **Connection paths & failover** | Health checks per path, automatic failover and fail-back, manual switch, "Move to WiFi" (the device is re-pointed, found on the new network, and the tile updates), SIM-path reachability check with a plain explanation when the carrier blocks inbound connections. |
| 4 | **Live video** | go2rtc sidecar for WebRTC / MSE video in the browser, snapshot fallback when go2rtc is not installed, PTZ d-pad and presets. |
| 5 | **Remote access & hub resilience** | Tailscale setup so the phone reaches the hub from anywhere, hub with its own 4G fallback, run-as-service on Windows and on a Raspberry Pi, backup and restore of the registry. |
| 6 | **Polish** | Scenes ("All lights off", "Lock up"), activity feed, device discovery on the network (ONVIF, mDNS), per-device notification rules. |

Phases 1–4 and 6 are code. Phase 5 is setup guides and scripts (`docs/REMOTE-ACCESS.md`, `scripts/`).

## What is honest about the SIM path

An Indian consumer SIM (Jio, Airtel, Vi, BSNL) normally sits behind the
carrier's NAT: nothing on the internet can *connect in* to the camera's SIM
address. That means the SIM path works in one of three ways, and the app says
which one applies to each device:

1. **Public-IP SIM** — the carrier gives the SIM a public / static IP (M2M or
   "static IP" plans). The hub reaches the device directly. The app checks this
   and shows it.
2. **Vendor cloud** — the device talks *out* to its maker's cloud over the SIM
   (Tuya, EZVIZ, Hik-Connect ...). The hub uses the cloud API where one exists.
3. **SMS** — GSM gate boxes and many 4G cameras take commands by text
   (open, reboot, set APN, join WiFi). The hub sends them through a USB GSM
   modem, or hands the ready-made message to your phone with one tap.

## Folder map

```
Home Control Room/
├─ shared/      contracts (types) used by hub and app
├─ hub/         the server: registry, adapters, paths, actions, video, push
├─ app/         the phone app (PWA)
├─ docs/        this blueprint, protocol notes, setup guides
└─ scripts/     Windows / Pi setup helpers (go2rtc download, service install)
```
