# Using House Control away from home, and surviving a WiFi reset

Three things make the system hold up when the house WiFi misbehaves:

1. the **phone can always reach the hub**;
2. the **hub can always reach the internet**, even when the router is down;
3. each **device has a second way in**.

This guide sets up all three. Steps 1 and 2 take about fifteen minutes.

---

## 1. Phone to hub from anywhere: Tailscale

Tailscale is a free private network between your own devices. It works through
mobile networks that block incoming connections, and it gives the hub a proper
`https` address, which the phone needs before it will show notifications.

1. On the hub PC install Tailscale from <https://tailscale.com/download> and sign in.
2. On the phone install the Tailscale app and sign in with the **same account**.
3. In the Tailscale admin console (<https://login.tailscale.com/admin/dns>) switch on **MagicDNS** and **HTTPS Certificates**.
4. On the hub PC, in a terminal:

   ```powershell
   tailscale serve --bg 8080
   ```

   It prints an address like `https://your-pc.your-tailnet.ts.net`. That is the hub, reachable only by your own devices.
5. On the phone open that address, enter the PIN, then:
   * Android: browser menu, **Install app**.
   * iPhone: Share, **Add to Home Screen**, then open it from the home screen.
6. In the app: **Settings, Notifications on this phone, Turn on**, then **Send a test notification**.

The free Personal plan covers this (up to six people, any number of devices).
When both ends are on mobile data, Tailscale relays through its Bengaluru
server; commands and stills are fine, several HD streams at once may stutter.

> On the house WiFi you can also just open `http://<hub address>:8080`. That works
> for control, but phones only allow notifications and installing over `https`,
> so use the Tailscale address on the phone.

## 2. Hub to internet when the router is down

The hub is the one box that must stay up. Give it:

* **Power**: a small UPS, so a power cut does not take it down with the router.
* **A wired connection** to the main router (not WiFi), so a WiFi reset does not cut it off from wired devices.
* **Its own 4G fallback**: a USB 4G dongle, or a second network connection to a 4G router. Windows uses it automatically when the main connection drops, and Tailscale follows.

With that, a WiFi reset looks like this: the phone still reaches the hub over
Tailscale, the hub marks the affected devices' first connection as down, and
moves each one to its next connection.

## 3. A second way in for each device

Be clear-eyed about what a SIM in a device gives you.

### Why "the camera has its own SIM" is not enough by itself

Indian consumer SIMs (Jio, Airtel, Vi, BSNL) sit behind the carrier's network
address translation. The camera can call out; **nothing can call in**. So the
hub cannot open a connection to the camera's SIM address, and the app will say
so on that connection: *"The carrier gives this SIM a private address."*

Public-address SIMs exist only as business M2M products and are not practical
for a house.

### What works instead

| Option | How | Good for |
|---|---|---|
| **A 4G router for the cameras** | Put the cameras on one 4G router that runs Tailscale as a subnet router (for example GL.iNet GL-X3000 or GL-XE3000, firmware 4.2 or later: Applications, Tailscale, **Advertise LAN subnets**). Approve the route in the Tailscale console. Add that network to the app as a second WiFi and give each camera a connection on it. | Cameras. Full video and PTZ whether or not the house WiFi is up. This is the strongest setup. |
| **The maker's cloud** | Devices that talk out to their maker's cloud keep working over their SIM. Add them with the **Tuya (cloud)** family where it applies. | Tuya / Smart Life lights, switches, garage openers. |
| **An MQTT broker** | A relay that dials out to an MQTT broker you run (on the hub over Tailscale, or a small server) is reachable through any SIM. Add it with the **MQTT device** family. | Custom relays and lights on their own SIM. |
| **SMS** | GSM gate boxes, and some 4G cameras, take commands by text. Add an **SMS** connection with the SIM's number. With a USB GSM modem on the hub (`HC_SMS_PORT=COM3`) texts go by themselves; without one, the app hands you the ready-made text to send with one tap. | Gates, garage doors, restart commands. Last resort for everything else. |

In the app, order each device's connections like this:

```
1. Home WiFi        (fast, full control)
2. Backup WiFi      (the 4G router)
3. Cloud or SIM     (if the device has one that can be reached)
4. SMS              (if the device takes texts)
```

### Moving a device to another WiFi from the app

Store both networks under the **WiFi** tab with their passwords. Open the
device, **Move to WiFi**, pick the network. The hub tells the device to join,
waits for it to appear there (it searches the network if the address changed)
and switches the connection over. You get a notification when it is done.

This needs a device whose own interface allows it: Hikvision, Dahua / CP Plus,
Tasmota and Shelly do; most ONVIF cameras and Tapo do not, and the app says so
on those devices. Give cameras a **fixed address** in each router (DHCP
reservation) so they are found again at once.

---

## Running the hub on a small box instead of the PC

Any always-on machine works: a mini PC, or a Raspberry Pi 4 or 5.

```bash
# on the Pi, with Node.js 22.13 or newer installed
git clone <your repository> "Home Control Room"
cd "Home Control Room"
bash scripts/pi/setup.sh
```

To move an existing house across: run `npm run backup` on the PC, copy the zip
to the new box and unzip it into `data/` before the first start.

## Forgot the PIN

Stop the hub, then in the project folder:

```powershell
npm run reset-pin
```

Start the hub. The next phone to open the app chooses a new PIN. Devices and
WiFi networks are untouched; every phone signs in again.

## What to back up

`npm run backup` writes a dated zip into `backups/` with the database and the
key that decrypts the stored passwords. It works while the hub is running.
Whoever holds that zip can control the house, so keep it somewhere private.
