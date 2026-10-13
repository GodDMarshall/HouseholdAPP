# House Control

One private app for the whole house: cameras, the main gate, the garage door,
lights and switches. Tap a tile and it happens; the phone tells you when it is
done. Every device is added once, stored on your own hub, and can be edited or
removed from the same app. When the house WiFi is reset, the hub falls over to
whatever still reaches the device (a backup WiFi, the device's own SIM, its
cloud, or an SMS) and shows which connection it is using.

Nothing leaves the house except what you send yourself. There is no account
and no cloud of ours.

## Start it

Double-click **`Start House Control.cmd`**.

The first run installs what it needs and builds the phone app (a minute or
two). Then open:

```
http://localhost:8080
```

The first phone or browser to open it chooses the house PIN.

From a terminal, the same thing is:

```powershell
npm install
npm run build
npm start
```

## Then

1. **Add your WiFi networks** (WiFi tab): the main router and any backup router, with passwords.
2. **Add your devices** (the + button): the app scans your network and shows what it finds; tap to add. A recorder (DVR / NVR) offers every camera behind it in one go, one tile each. Smart Life devices need the account linked once. [docs/ADD-YOUR-DEVICES.md](docs/ADD-YOUR-DEVICES.md) covers every route.
3. **Remove the illustrative devices** once your own are in (open one, Edit, Remove).
4. **Live video**: run `scripts\get-go2rtc.ps1` once. Until then cameras show stills.
5. **Use it away from home, and get notifications**: [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md).
6. **Start with Windows**: `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1`.
7. **Back up** now and then: `npm run backup`.

## What is in the box

| Folder | What |
|---|---|
| `hub/` | The server. Device registry (SQLite, passwords encrypted), one adapter per device family, connection checks and failover, the action queue, notifications, video. |
| `app/` | The phone app. Installable, dark, big touch targets. |
| `shared/` | The contracts both sides use. |
| `docs/` | [Blueprint](docs/BLUEPRINT.md), setup guides, and the [protocol notes](docs/protocols/README.md) each adapter was built from. |
| `scripts/` | go2rtc download, autostart, backup, Raspberry Pi setup. |
| `data/` | Created on first run: your registry, keys and pictures. **Back this up; never share it.** |

## Device families

| Family | For |
|---|---|
| ONVIF camera | Almost any IP camera |
| Hikvision camera | Hikvision and Hik-Connect cameras, including 4G models |
| Dahua / CP Plus camera | Dahua and CP Plus cameras and recorders (CP-UVR, NVR, XVR) |
| TP-Link Tapo camera | Tapo C-series |
| Camera by stream address | Anything with an RTSP address (EZVIZ, ICSee and others) |
| Tasmota switch or relay | Sonoff and other ESP switches running Tasmota: lights, sockets, gate relays |
| Shelly relay or dimmer | Shelly relays and dimmers: lights, sockets, gate relays |
| Tuya / Smart Life (over the internet) | Tuya devices through the Tuya cloud, from anywhere |
| Tuya / Smart Life (inside the house) | Tuya devices on the house network |
| MQTT device | Anything that talks to an MQTT broker |
| Relay with web addresses (HTTP) | Relay boards with plain on / off / pulse addresses |
| GSM gate box (SMS) | Gate openers controlled by text message or a call |
| Illustrative device | A pretend camera, gate or light for trying the app |

Every family was written from the makers' documents (see `docs/protocols/`) and
tested against a stand-in device. None has been run against real hardware yet:
the first real device of each kind is the real test. What to look up before
adding each one is in [docs/ADD-YOUR-DEVICES.md](docs/ADD-YOUR-DEVICES.md)
(regenerate it with `npm run guide` after changing an adapter).

## Settings

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `HC_PORT` | `8080` | Port the app is served on |
| `HC_DATA_DIR` | `data` in this folder | Where the registry and keys live |
| `HC_SMS_PORT` | none | Serial port of a USB GSM modem (`COM3`). Without one, texts are handed to your phone to send. |
| `HC_PROBE_INTERVAL_SEC` | `15` | How often each device's connection is checked |
| `HC_SEED_VIRTUAL` | on | Set to `0` to start with an empty house |
| `HC_GO2RTC_URL` | none | Use a go2rtc that is already running instead of starting one |
| `HC_LOG_LEVEL` | `info` | `debug` shows every device call |

## Checks

```powershell
npm test            # hub: registry, sign-in, failover, actions, every adapter against a stand-in device
npm run test:e2e    # the app in a real browser at phone size, on a throwaway hub
npm run typecheck
```

## If something is wrong

* **"Port 8080 is already in use"**: the hub is already running (maybe from autostart). Open http://localhost:8080.
* **Forgot the PIN**: stop the hub, run `npm run reset-pin`, start again and choose a new one. Devices are kept.
* **A device shows Offline**: open it; each connection shows why it is not answering in plain words.
