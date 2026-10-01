# Adding your devices

Everything is added from the app: the **+** button on the House screen. It takes five steps: what the thing is, how it connects, its details, the ways to reach it, then a test and save. You can change any of it later from the device’s page (the pencil), or remove the device there.

Do these two things first; they save trouble later:

1. **Store your WiFi networks** under the WiFi tab, with their passwords: the main router, and any backup router.
2. **Give each device a fixed address** in the router (often called a DHCP reservation or static lease), so the address you type stays right after a restart.

Nothing in this build has been tried on real hardware yet. Every family was written from the makers’ documents and checked against a stand-in device, so the first real device of each kind is the real test. If the test in step 5 says no, the message tells you why in plain words.

## Which family is my device?

| You have | Choose |
|---|---|
| A Hikvision camera (also sold as Hik-Connect, HiLook, some Prama) | Hikvision camera |
| A CP Plus or Dahua camera | Dahua / CP Plus camera |
| A TP-Link Tapo camera | TP-Link Tapo camera |
| Any other IP camera that mentions ONVIF | ONVIF camera |
| A camera that only gives a video address (RTSP), such as EZVIZ or ICSee / XMEye | Camera by stream address |
| A Sonoff or other switch flashed with Tasmota | Tasmota |
| A Shelly relay or dimmer | Shelly |
| Smart Life / Tuya bulbs, switches or garage openers | Tuya (cloud) if it must work from anywhere, including when the house WiFi is down for the hub. Tuya (local) for speed when the hub is on the same network. |
| A gate box with a SIM card that you text or call | GSM gate box (SMS) |
| A relay board with web addresses for on and off | HTTP relay |
| Anything that talks to an MQTT broker (ESPHome, Zigbee2MQTT, a relay on its own SIM) | MQTT device |

Not sure which camera family? Try **Find devices on the network** in step 2. Cameras with ONVIF switched on answer it.

## The ways to reach a device

In step 4 you list the connections, best first. The hub uses the first one that answers and moves down the list by itself when it stops.

| Connection | What to enter | When it works |
|---|---|---|
| WiFi / wired | The device’s address on that network, and which stored WiFi it is | Whenever the hub is on that network |
| SIM (4G) | The public address of the SIM | Only with a SIM that has a public address. Ordinary Indian consumer SIMs do not, and the test says so. See [REMOTE-ACCESS.md](REMOTE-ACCESS.md). |
| Cloud | Nothing; the account details are in step 3 | Anywhere the device has internet |
| SMS | The phone number of the SIM in the device | Wherever there is mobile signal. The device cannot report back. |

## ONVIF camera

Works with most IP cameras. ONVIF is the common language nearly every camera brand understands.

**Can be:** camera.  
**Connections:** WiFi / wired, SIM (4G) (usual port 80).  
**Can do, at best:** live video; still pictures; turn and zoom; saved positions; can be moved to another WiFi from the app; can list the WiFi networks it sees; restart.

### Before you add it

- Switch ONVIF on in the camera's own settings or app (many cameras ship with it off).
- Create or note the ONVIF username and password on the camera; many brands use a separate ONVIF user. Use an administrator-level login if restart or WiFi change from the hub is wanted.
- Find the camera's ONVIF port: usually 80, but some brands use 8000, 8080, 8899 or 2020 (manual or app says which).
- Leave the ONVIF address path at /onvif/device_service unless the manual gives another.
- Switch off 'Camera can turn and zoom' for a fixed camera.
- Only switch on 'Let the hub change the camera's WiFi' if the camera is known to allow it; otherwise use the camera's own app for WiFi.
- For the SIM connection: the SIM needs a public/static address or a port-forward/VPN that exposes both the ONVIF port and the video port (usually 554).
- Keep the hub's clock on network time; the login depends on the clock difference between hub and camera.

### What the app asks for

| Field | What to enter |
|---|---|
| Username | The camera login. Many cameras have a separate ONVIF user that you create in the camera’s own settings. |
| Password (optional) | Stored encrypted on the hub. Leave empty only if the camera really has no password. |
| ONVIF address path (optional) | Leave as it is. Only change it if the camera’s manual gives a different ONVIF address. Starts as: /onvif/device_service. |
| Camera can turn and zoom (optional) | Shows the arrows and saved positions. Switch off for a fixed camera. |
| Let the hub change the camera’s WiFi (optional) | Few cameras allow this over ONVIF. If yours does not, the hub says so when you try and nothing is changed; use the camera’s own app instead. |

### Good to know

- ONVIF has to be switched on in the camera first. On many cameras you also create an ONVIF user there; use that login here.
- If the camera refuses the login, the hub waits five minutes before trying the same one again, so the camera does not lock the account. A corrected password is tried straight away.
- The port is usually 80. Some brands use another one, such as 8000, 8080, 8899 or 2020: the camera’s manual or app says which.
- Live video, still pictures, turning and zooming, saved positions and restart work on most cameras. Restart needs an administrator login.
- The camera turns or zooms while you hold the button. If letting go does not get through from the phone, it stops by itself after 30 seconds.
- Changing the camera’s WiFi from here only works on the few cameras that allow it over ONVIF. When a camera does not, the hub tells you and changes nothing.
- Some cameras remember only one WiFi network. On those the new network replaces the old one, so if the camera cannot join it (wrong WiFi password, too far from the router) it has to be put back on WiFi with its own app.
- Over the SIM connection the camera must be reachable from outside on its ONVIF port and on its video port (usually 554). Most ordinary SIM cards do not allow that.
- Motion alerts are not read from the camera through this option.

## Hikvision camera

Hikvision and Hik-Connect cameras, including 4G models with a SIM. Live view, pictures, turning the camera, WiFi change.

**Can be:** camera.  
**Connections:** WiFi / wired, SIM (4G) (usual port 80).  
**Can do, at best:** live video; still pictures; turn and zoom; saved positions; can be moved to another WiFi from the app; can list the WiFi networks it sees; reports its SIM and signal; restart.

### Before you add it

- Switch on ISAPI on the camera: its web page > System > System Service > tick 'Enable ISAPI' > apply > restart the camera.
- Have the camera's own username and password (usually 'admin'), not the Hik-Connect app account. A few wrong tries lock the login for about 30 minutes.
- Know the camera's IP address on each house WiFi, and the port if it is not 80 (443 with 'Use HTTPS').
- In the camera's Security settings keep 'WEB Authentication' and 'RTSP Authentication' on digest (or digest/basic) with MD5, otherwise login or live view can fail.
- Check the video (RTSP) port if it was changed from 554.
- Turn on 'This camera can turn and zoom' for PTZ models; turn off 'This camera has WiFi' for cable-only or 4G-only models; turn on 'This camera has a SIM' for 4G models.
- For a recorder (NVR), enter which camera number (channel) is wanted.
- For a SIM connection: confirm the plan gives a public/static IP and enter that address. The state key simAddressPublic shows whether the current SIM address is public.
- Before moving a camera to another WiFi, make sure that network's password is stored correctly in the hub. A wrong one can drop the camera off WiFi until it is recovered by cable or its own app.

### What the app asks for

| Field | What to enter |
|---|---|
| Username | The login of the camera itself, usually “admin”. This is not your Hik-Connect app account. |
| Password | The camera’s own password. Stored encrypted on the hub. Type it carefully: after a few wrong tries the camera locks the login for about half an hour. |
| Camera number (optional) | Leave at 1 for a single camera. If this address is a recorder (NVR) with several cameras, enter which camera you want. Starts as: 1. |
| Use HTTPS (optional) | Turn on if the camera’s own settings page opens with https://. The hub then uses the usual secure port (443) and accepts the certificate the camera made for itself; if your camera uses a different secure port, enter it as the port of the connection. With this off, passwords travel unprotected inside your house network. |
| Video port (optional) | The port live video comes from (the camera’s settings call it RTSP). It is 554 unless you changed it on the camera. Starts as: 554. |
| This camera can turn and zoom (optional) | Turn on for cameras with a motor (PTZ). Leave off for fixed cameras. |
| This camera has WiFi (optional) | Shows which WiFi the camera is on and lets you move it to another one. Turn off for cable-only models and for 4G models without WiFi. |
| This camera has a SIM (optional) | Turn on for 4G models. The hub then shows the SIM state and signal whenever it can reach the camera. |

### Good to know

- First switch on ISAPI on the camera — that is the camera’s built-in control service, and without it the camera ignores the hub. Open the camera’s web page, go to System > System Service, tick “Enable ISAPI”, apply and restart the camera.
- Use the camera’s own login. After a few wrong passwords the camera locks the admin login for about 30 minutes, for the Hik-Connect app too. To avoid that, the hub stops trying after a wrong password until you correct it here.
- What works on the house network: live view, pictures, restart, and — when switched on above — turning and zooming, presets, the WiFi the camera is on, moving it to another WiFi, and SIM signal.
- Before moving the camera to another WiFi the hub checks that the camera can see that network. If the stored WiFi password is wrong, the camera can still drop off WiFi; it then needs a network cable or its own app to bring it back. Networks that hide their name, and company-style logins, have to be set in the camera’s own app.
- SIM connection: most SIM cards get a private address from the mobile company, so nothing can connect in to the camera over 4G. Add a SIM connection here only if your plan gives the SIM a public (static) address. Otherwise use the Hik-Connect app when the house internet is down.
- If live view does not start, open the camera’s Security settings and set both “RTSP Authentication” and “WEB Authentication” to digest (or digest/basic) with the MD5 option.
- Motion alerts and talking through the camera are not handled by the hub; keep using Hik-Connect for those.

## Dahua / CP Plus camera

Dahua cameras and recorders, and CP Plus models made by Dahua. Live view, pictures, turn and zoom, WiFi change.

**Can be:** camera.  
**Connections:** WiFi / wired, SIM (4G) (usual port 80).  
**Can do, at best:** live video; still pictures; turn and zoom; saved positions; can be moved to another WiFi from the app; can list the WiFi networks it sees; reports its SIM and signal; restart.

### Before you add it

- Know the camera's own login (often 'admin') and password. This is the camera's local account, not the CP Plus / Dahua phone-app account.
- In the camera's own settings page, switch on 'CGI service' (System > Security > System Service). On newer firmware also set Authentication Mode to 'Compatible' with MD5 digest only; otherwise the camera answers 401/500.
- Make sure RTSP is on, and note the RTSP port if it was changed from 554.
- If the camera's settings page opens with https://, switch on 'Use HTTPS' (the hub then uses port 443 unless the connection has its own port).
- For a camera behind a recorder (NVR/DVR), enter the camera's number on the recorder as 'Camera number'.
- Switch on the matching toggles: 'This camera can turn or zoom', 'This camera has WiFi', 'This camera has its own SIM (4G)'. The hub cannot detect these itself.
- If a PTZ camera does not move, enter 0 in 'Movement channel' (on a recorder: the camera number minus 1).
- Reserve a fixed address for the camera in each router, and add a connection path for each house WiFi, so the hub can find it after a WiFi move.
- For the SIM path: the SIM needs a public address or a VPN/tunnel; ordinary Indian SIMs block incoming connections. Enter the forwarded HTTP port on that path.
- If live video is black in the phone browser, set the camera's stream encoding to H.264 instead of H.265.

### What the app asks for

| Field | What to enter |
|---|---|
| Username | The login of the camera itself (often "admin"), not your phone-app account. |
| Password | The camera's own password. Stored encrypted on the hub. |
| Camera number (optional) | Use 1 for a single camera. On a recorder (NVR / DVR) with several cameras, enter this camera's number on the recorder. Starts as: 1. |
| Use HTTPS (optional) | Switch on only if the camera's own settings page opens with https://. The hub then uses the usual secure port (443). If your camera uses a different one, enter it as the port of the connection. |
| Video port (optional) | The port the camera sends live video on (RTSP). It is 554 unless you changed it in the camera. Starts as: 554. |
| This camera can turn or zoom (optional) | Switch on for pan / tilt / zoom (PTZ) models. Leave off for fixed cameras. The hub cannot tell the two apart by itself. |
| Movement channel (optional) | Normally leave empty. Older cameras count from 0 instead of 1: if the camera does not move when you press the arrows, enter 0 here (on a recorder, the camera number minus 1). |
| This camera has WiFi (optional) | Switch on for WiFi models. The hub then shows which network the camera is on and can move it to another one. |
| This camera has its own SIM (4G) (optional) | Switch on for 4G models. The hub then shows whether the SIM link is up. |

### Good to know

- Works with Dahua cameras and recorders and with CP Plus models built by Dahua (most wired and professional CP Plus cameras). Live video, still pictures and restart work on all of them.
- CP Plus ezyKam+ SIM cameras (CP-V32G, CP-Z32G and similar) are a different design and usually do not answer this way. If the connection check fails for one of those, add it as an ONVIF camera instead.
- In the camera's own settings page, "CGI service" must be on, and on newer cameras Authentication Mode must be "Compatible" (MD5 digest). Otherwise the camera rejects the hub.
- These cameras lock a login for some minutes after a few wrong passwords. If you correct the password here and the camera still refuses it, wait a while and check again.
- Turning and zooming continue while you hold the button. If letting go does not get through from the phone, the hub sends the stop itself after 30 seconds.
- Changing WiFi follows Dahua's published method, but it has not been proven on every model. The first time, keep a network cable or SIM connection as a second path so the camera stays reachable if it does not join.
- After a WiFi change the hub looks for the camera at the address saved on that network's connection. Reserve a fixed address for the camera in each router. Hidden WiFi networks cannot be chosen.
- The new WiFi password is sent to the camera over the network it is on now. Use HTTPS if the camera supports it.
- SIM (4G): the hub shows whether the SIM link is up, but these cameras do not report signal strength this way. The hub can only reach a camera through its SIM if the SIM has a public address or a private tunnel (VPN); ordinary SIMs block incoming connections.
- If live video stays black on the phone, set the camera's video format to H.264 (not H.265) in the camera's own settings.

## TP-Link Tapo camera

Tapo C200, C210, C500, C510 and similar. Live video, pictures, turning and saved positions on the house network.

**Can be:** camera.  
**Connections:** WiFi / wired.  
**Can do, at best:** live video; still pictures; turn and zoom; saved positions; restart.

### Before you add it

- In the Tapo app, open the camera, tap the gear icon, then Advanced Settings > Camera Account, and make a username and password (6 to 32 characters each; plain letters and digits work best). Enter that login in the hub, not the TP-Link email and password.
- In the Tapo app, switch on Me > Third-Party Compatibility. If the hub later cannot log in, switch it off and on again and open the camera once in the Tapo app.
- Find the camera's address on each house WiFi (router device list or the Tapo app's device info) and enter it on the matching connection. A fixed/reserved address in the router is advisable.
- Leave Control port at 2020 and Video port at 554 unless they were changed.
- Switch off 'Camera can turn' for a fixed model.
- Optional: fill in the TP-Link account password only if the normal video address gives nothing. It must be typed correctly, because repeated wrong tries make the camera refuse all logins for a while, including the Tapo app's.
- Keep other viewers (recorder, other apps) to two at most: a Tapo allows three local video connections and the hub uses one.
- Do not run SD-card recording and Tapo Care together; that switches RTSP/ONVIF access off in the camera.
- A 4G model must be on a network cable for the hub to reach it.

### What the app asks for

| Field | What to enter |
|---|---|
| Camera Account username | The username of the Camera Account. You make it in the Tapo app: open the camera, tap the gear icon, then Advanced Settings > Camera Account. It is not your TP-Link email. |
| Camera Account password | The password of that Camera Account (6 to 32 characters). Stored encrypted on the hub. |
| Control port (optional) | The port the camera takes commands on (ONVIF, the common language of network cameras). A Tapo uses 2020: leave it as it is. If one connection needs a different port, type it into that connection’s own port box instead. Starts as: 2020. |
| Video port (optional) | The port the camera sends live video on (RTSP, the usual way cameras send video). A Tapo uses 554: leave it as it is. Starts as: 554. |
| Camera can turn (optional) | Shows the arrows and the saved positions. Switch off for a fixed Tapo that cannot turn. |
| TP-Link account password (optional) (optional) | Normally leave this empty. It is the password you sign in to the Tapo app with, not the Camera Account. When it is filled in, the hub keeps a second way to get video (the one the Tapo app itself uses) for when the normal video address gives nothing. Stored encrypted on the hub. Type it carefully: after a few wrong tries the camera refuses every login for a while, the Tapo app’s too. |

### Good to know

- First, in the Tapo app: open the camera, tap the gear icon, then Advanced Settings > Camera Account, and make a username and password (6 to 32 characters each; plain letters and digits work best). Enter that login here.
- Also in the Tapo app: Me > Third-Party Compatibility must be switched on, or the camera does not answer the hub. If the hub suddenly cannot log in, switch it off and on again and open the camera once in the Tapo app.
- Works on the house network: live video (a sharp and a light version), still pictures, turning and saved positions. Still pictures come from the live video when the camera does not hand them out itself.
- Restart is sent the standard way for network cameras. If your model does not take it, the hub says so and you restart the camera from the Tapo app.
- The camera turns while you hold the button. If letting go does not get through from the phone, it stops by itself after 30 seconds.
- Saved positions are made in the Tapo app. The hub lists them and sends the camera to them; it does not create new ones.
- The WiFi of a Tapo camera cannot be changed from here, nor from any other app. TP-Link only allows it by resetting the camera (hold its reset button for 5 seconds) and setting it up again in the Tapo app, so use the Tapo app for that step. The hub tells you when the camera stops answering.
- If the camera refuses the login, the hub waits five minutes before trying the same one again, so the camera does not lock the account. A corrected password is tried straight away.
- A Tapo allows three local video connections at a time. The hub takes one and shares it with every phone, so leave room for it if a recorder or another app also watches this camera.
- 4G models (C501GW, TC40GW): the hub reaches them only while they are on a network cable. On the SIM alone a Tapo can be reached only from the Tapo app, so no SIM connection is offered here.
- Battery models (C410, C420, C425, D230) do not offer video this way and cannot be added. Recording to an SD card and Tapo Care together also switches this kind of access off in the camera.
- Motion alerts are not read from the camera through this option.
- EZVIZ cameras do not belong here. Add them as "Camera by stream address" with the video address rtsp://{user}:{pass}@{host}:{port}/ch1/main, the username admin and the 6-letter verification code from the camera’s label as the password (switch on RTSP in the EZVIZ app first), or as "ONVIF camera" if your model supports ONVIF.
- ICSee / XMEye cameras do not belong here. Add them as "Camera by stream address" with a dvrip:// address, for example dvrip://{user}:{pass}@{host}:34567?channel=0&subtype=0.
- V380 cameras can be added only if yours offers ONVIF or RTSP (many do not): then use "ONVIF camera" or "Camera by stream address". Otherwise they work only in the V380 app.

## Camera by stream address

Any camera with an RTSP video address. Live view and pictures only.

**Can be:** camera.  
**Connections:** WiFi / wired, SIM (4G) (usual port 554).  
**Can do, at best:** live video; still pictures.

### Before you add it

- Find the camera's RTSP video address in its manual or app, and switch RTSP on if it is off.
- Note the username and password the camera asks for.

### What the app asks for

| Field | What to enter |
|---|---|
| Video address | Keep {host} and {port} so each connection uses its own address; {user} and {pass} are filled from below. Other schemes go2rtc reads also work, e.g. dvrip://{user}:{pass}@{host}:34567?channel=0 for XMEye / ICSee cameras. Starts as: rtsp://{user}:{pass}@{host}:{port}/stream1. |
| Username (optional) | Leave empty if the camera has no login. |
| Password (optional) |  |
| Still picture address (optional) | Optional. An http address that returns a JPEG, e.g. http://{host}/snapshot.jpg. Without it, pictures are cut from the live video (needs ffmpeg on the hub). |

### Good to know

- Find the video address in the camera’s manual or its app under RTSP. Many cameras need RTSP switched on first.
- This kind of camera cannot be moved between WiFi networks from here; use its own app for that.

## Tasmota switch or relay

Sonoff and other WiFi switches running Tasmota: lights, switches, and gate or garage-door buttons.

**Can be:** light, switch, gate or garage door.  
**Connections:** WiFi / wired (usual port 80).  
**Can do, at best:** on and off; brightness; colour; open, stop and close; tells you whether it is open or closed; can be moved to another WiFi from the app; can list the WiFi networks it sees; restart.

### Before you add it

- Have the device running Tasmota and joined to the house WiFi, and note its IP address (ideally reserve it in the router).
- If the device's web page asks for a login, enter that web password (username is always admin and can be left blank).
- Enter the relay number (1 on a single switch).
- For dimmers or colour bulbs, turn on 'Can be dimmed' / 'Can change colour'.
- For a gate or garage door: wire a dry-contact relay across the motor's push-button terminals, choose 'A gate or garage door' under 'What it controls', and pick one button or separate open / close / stop relays with their numbers.
- For a gate, type once in the device's Console: Backlog PowerOnState 0; SetOption114 1; SwitchMode1 1 (keeps the relay off after a power cut and stops the door sensor working the relay by itself).
- If a door sensor is fitted: set it up in Tasmota as a Switch, enter its number, check the tile with the gate shut and flip 'Sensor reads ON when the gate is' if it shows the opposite, and set the travel time.
- For WiFi scan, update Tasmota to 12.1 or newer.

### What the app asks for

| Field | What to enter |
|---|---|
| What it controls | Choose the gate option when the relay is wired across the push-button terminals of a gate or garage-door motor; the gate settings then appear below. A device added as a gate is always treated as one. Choices: A light or a switch (stays on or off) / A gate or garage door (short press of its button). Starts as: switch. |
| Username (optional) | Only needed if the device’s own web page asks you to log in. Tasmota always uses "admin", so you can leave this empty. |
| Password (optional) | The web password set on the device. Leave empty if its web page opens without a login. Stored encrypted on the hub. |
| Relay number (optional) | Which switch on the device to use: 1 on a single switch; 2, 3, 4 … on boards with several. For a one-button gate this is the relay that presses the button. Starts as: 1. |
| Can be dimmed (optional) | Turn on for dimmer modules and dimmable bulbs. Leave off for plain on / off switches. |
| Can change colour (optional) | Turn on for colour bulbs and strips, and for bulbs that go from warm to cool white. |
| Gate buttons (optional) | One button: a single relay is wired to the motor’s step input. Separate: one relay each for the open, close and stop inputs, which makes every tap do exactly what it says. Choices: One button (each press steps open → stop → close) / Separate open / close / stop relays. Starts as: single. |
| Open relay number (optional) | Starts as: 1. |
| Close relay number (optional) | Starts as: 2. |
| Stop relay number (optional) | Leave at 0 if no relay is wired to the stop input. Starts as: 0. |
| Press length (milliseconds) (optional) | How long the relay holds the button. 800 suits most gate motors. The device times the press itself, so the relay lets go even if WiFi drops in the middle of it. Starts as: 800. |
| Door sensor input (0 = none) (optional) | If a magnetic door sensor is wired to the device and set up in Tasmota as Switch 1, 2 …, enter that number so the tile can show open or closed. Fit the sensor where the gate is fully closed. Leave 0 if there is no sensor. Starts as: 0. |
| Sensor reads ON when the gate is (optional) | If the tile shows open while the gate is shut, switch this over. Choices: Closed / Open. Starts as: closed. |
| Time to open or close fully (seconds) (optional) | Used with the door sensor to show "opening" and "closing" while the gate is moving. Starts as: 20. |

### Good to know

- Works on the house WiFi only: the device has no SIM, so the hub must be on the same network as it.
- On, off, dimming and colour take effect at once, and the tile shows the state the device itself reports.
- Gate or garage door: each tap is one short press of the relay. The hub sets the device’s own press timer (PulseTime) so the button is never left held down, then checks that the relay let go. A press proves the button was pressed, not that the gate moved.
- With one button, the hub cannot know whether the next press opens or closes unless a door sensor is fitted. With a sensor, Close is ignored when the gate is already closed and Open when it is already open. Without one, every tap presses the button.
- Stop on a one-button gate is also just a press: it stops a gate that is moving, but it sets a gate that is standing part-way open moving. A second Stop straight after the first is ignored for that reason. After a stop, the next press may turn the gate round instead of carrying on; that depends on the motor.
- The door sensor sits at the closed position, so "closed" is certain and "open" means "not closed".
- For a gate, open the device’s own web page, go to Console and enter once: Backlog PowerOnState 0; SetOption114 1; SwitchMode1 1 — this keeps the relay off after a power cut and stops the door sensor from working the relay by itself. Without it, the sensor can press the gate button by itself whenever the gate moves. If the sensor is on Switch 2, write SwitchMode2 instead of SwitchMode1.
- Move to another WiFi: the hub saves the new network in the device’s spare WiFi slot and restarts it. The network it is on now stays saved, so it falls back to it if the new one cannot be joined. A WiFi name or password containing a semicolon (;) or an unmatched curly bracket cannot be sent, and Tasmota advises against spaces and special characters in them.
- After changing network the device usually gets a new address. Reserve its address in the router, or enter the new one on that connection.
- Listing nearby WiFi networks needs Tasmota 12.1 or newer.
- Tasmota sends its password unencrypted, so keep the device on the house network and never open it to the internet.

## Shelly relay or dimmer

Shelly switches, dimmers and gate relays on the house WiFi. Works without the Shelly cloud.

**Can be:** light, switch, gate or garage door.  
**Connections:** WiFi / wired (usual port 80).  
**Can do, at best:** on and off; brightness; open, stop and close; tells you whether it is open or closed; can be moved to another WiFi from the app; can list the WiFi networks it sees; restart.

### Before you add it

- Join the Shelly to the house WiFi with the Shelly app or its own setup hotspot first, and note its IP address (or use the hub's scan).
- If a password is set on the Shelly (its web page: Settings > Authentication / Restrict login), enter the same one here. First-generation models also need the username; newer ones always use 'admin'.
- Know the output number: 0 for a single-relay Shelly, 1 for the second relay of a two-relay model.
- For a dimmer, switch on 'This is a dimmer'.
- For a gate: wire the relay's dry contacts across the gate board's push-button (step) terminal, in parallel with the wall button, and set the Shelly's power-on default to OFF so a power cut cannot press the button. Never feed mains through the gate board's signal terminals.
- For separate OPEN / CLOSE (and STOP) inputs: use a multi-relay Shelly and enter which output goes to which terminal.
- For open/closed status: wire a magnetic reed switch to the Shelly's SW input (or a Plus Add-On input, usually number 100), set that input's type to Switch and detached from the relay in the Shelly's settings, then enter the input number and whether 'closed' reads on or off.
- Enter roughly how many seconds the gate takes to travel (default 20).
- For WiFi moves with a fallback: store both house networks with their passwords in the hub and link the device's connection to the network it is on.

### What the app asks for

| Field | What to enter |
|---|---|
| Which Shelly is it (optional) | Older and newer Shellys are spoken to in different ways. Leave this on automatic unless the hub gets it wrong. Choices: Find out automatically / First generation (Shelly 1, 1PM, 2.5, Dimmer 2) / Plus, Pro, Gen3 or Gen4. Starts as: auto. |
| Password (optional) | Only if you set one on the Shelly itself (on its own page under Settings: "Authentication" or "Restrict login"). Leave empty otherwise. Stored encrypted on the hub. |
| Username (optional) | Only first-generation Shellys let you choose a username. Newer ones always use "admin". Starts as: admin. |
| Output number (optional) | Which relay on the Shelly this tile controls. Counting starts at 0: a single-relay Shelly is 0, the second relay of a two-relay model is 1. For a gate, this is the relay wired to the gate’s button terminal (or to its OPEN terminal). Starts as: 0. |
| This is a dimmer (optional) | Switch on for Shelly Dimmer models so the brightness slider appears. Leave off for plain on/off relays. Not used for gates. |
| Gate wiring (optional) | Gates only. "One button" is a single relay across the gate board’s push-button (step) terminal. "Separate relays" needs a Shelly with two or more relays, wired to the board’s OPEN and CLOSE terminals. Choices: One button: each press steps open, stop, close / Separate relays for open and close. Starts as: one-button. |
| Output number for CLOSE (optional) | The relay wired to the gate board’s CLOSE terminal. "Output number" above is then the OPEN relay. Starts as: 1. |
| Output number for STOP (optional) | The relay wired to the gate board’s STOP terminal. Leave empty if there is none; the Stop button then says so instead of guessing. |
| Press length (milliseconds) (optional) | Gates only. How long the relay stays closed, like holding the button down. The Shelly counts in whole seconds, so this is rounded up: 1000 is one second, which suits most gate boards. Starts as: 1000. |
| Gate sensor input number (optional) | Gates only. If a magnetic door sensor is wired to the Shelly’s switch input (SW), enter that input’s number: usually 0, or 100 on a Shelly Plus Add-On. The app then shows whether the gate is closed. Leave empty if there is no sensor. Important: on the Shelly’s own settings page choose the "Detached" switch mode for that input, so the sensor is only read and never switches the relay by itself. |
| When the gate is closed, the sensor input is (optional) | If the app shows open when the gate is closed, switch this over. Choices: On (the usual case: magnet next to the sensor) / Off. Starts as: on. |
| Seconds the gate takes to open or close (optional) | Used with a gate sensor. The app shows "opening" or "closing" for this long, then reports what the sensor says. At most 85. Starts as: 20. |
| Always use a secure connection (optional) | Shelly firmware 1.8 and later only answers over a secure connection (HTTPS). The hub notices this by itself, so you can normally leave this off. |

### Good to know

- Works over the house network only. A Shelly has no SIM, so while its WiFi is down the hub cannot reach it. Giving it a second house network (for example a 4G router) as fallback keeps it reachable.
- On, off, brightness and restart work on all models. Colour bulbs and RGBW controllers are not covered: only on/off and brightness.
- Moving a Shelly to another house WiFi works from here. When the network it is leaving is one of the stored house networks, that network is kept on the Shelly as its fallback, so a wrong password does not strand it. After a move it asks the router for its address, so a fixed address set on the Shelly is replaced.
- Listing the WiFi networks a Shelly can see works on Plus, Pro, Gen3 and Gen4 models, not on first-generation ones.
- For a gate or garage door: wire the relay’s contacts across the gate board’s push-button terminal, next to the wall button, and set the Shelly’s power-on default to OFF so a power cut cannot press the button. Each tap closes the relay for the press length, then the Shelly releases it by itself.
- Without a sensor the hub cannot tell whether a gate is open. On a one-button gate Open, Close and Stop then all send the same press, and Stop will start a gate that is standing still.
- With one magnetic sensor at the closed position the app knows closed from not closed. It will not press the button of a gate that is already where you asked, and it reports "open" for a gate that is only part-way. It cannot tell a moving gate from one standing open, so on a one-button gate Stop still presses the button whenever the gate is not closed.
- If a gate sensor is wired to the Shelly’s switch input, choose the "Detached" switch mode for it on the Shelly’s own settings page. Otherwise the sensor switches the relay every time the gate moves, which presses the gate’s button again.
- If the answer to a gate press or a toggle is lost, the hub does not send it again, so a gate is never pressed twice by mistake. Check the gate, then try again.
- If a password is wrong the hub waits a minute before trying again, because newer Shellys lock out logins after repeated wrong attempts.
- On firmware 1.8 and later the connection is encrypted with the Shelly’s own certificate. The hub accepts that certificate without checking who issued it, so keep the Shelly on your own network.

## Tuya / Smart Life (over the internet)

Smart Life and Tuya lights, switches and garage door openers, through Tuya’s own cloud. Works from anywhere the device has internet.

**Can be:** light, switch, gate or garage door.  
**Connections:** Cloud.  
**Can do, at best:** on and off; brightness; colour; open, stop and close; tells you whether it is open or closed.

### Before you add it

- On iot.tuya.com: create a cloud project (type Smart Home) in the India data centre and add the free IoT Core service to it.
- In the project open Devices > Link Tuya App Account and scan the code with the Smart Life app (the project's data centre must match the Smart Life account's region; one account can be linked to at most two projects).
- Copy the Access ID and Access Secret from the project's Overview page, and each device's Device ID from the project's Devices list.
- Renew the IoT Core trial about once a month (Tuya takes 1-2 working days to approve); when it lapses this connection stops working.
- Add the device with a single 'cloud' connection; the address can be left empty.
- For a gate: choose whether it is a Tuya garage door opener or a plain switch wired to the gate's push-button, and for the latter set the press length (default 1 s).
- For lights: turn off 'can be dimmed' for on/off-only lights and turn on 'can change colour' for colour bulbs.

### What the app asks for

| Field | What to enter |
|---|---|
| Access ID | Also called Client ID. Shown on the Overview page of your cloud project on the Tuya developer website (iot.tuya.com). |
| Access Secret | Also called Client Secret, shown next to the Access ID. Stored encrypted on the hub. |
| Device ID | The long code next to the device in the Devices list of your cloud project. |
| Region (data centre) | Must be the region your Smart Life account lives in. Accounts made in India use India. Choices: India / Singapore / Central Europe / Western Europe / Western America / Eastern America / China. Starts as: in. |
| This light can be dimmed (optional) | Only used for lights. Turn it off for a light that is just on / off. |
| This light can change colour (optional) | Only used for lights. Turn it on for colour bulbs and strips, and for bulbs that can change between warm and cool white. |
| How the gate or garage door is driven (optional) | Only used when this device is a gate or garage door. Choices: Tuya garage door opener (has Open and Close, knows open / closed) / Plain Tuya switch wired to the gate’s push-button (one press each time). Starts as: opener. |
| Button press length (seconds) (optional) | How long the switch stays on to press the gate’s button. Most gates need about one second. Starts as: 1. |
| Ask Tuya for the status every (seconds) (optional) | Tuya’s free plan allows only a limited number of requests each month, so the status is not asked for more often than this. A change made at the wall switch or in the Smart Life app can take this long to show here. Commands you send from here always go out straight away. Use a smaller number only on a paid Tuya plan. Starts as: 300. |
| On/off code (optional) (optional) | Leave empty and the hub finds it (switch_led for bulbs, switch_1 or switch for switches). Fill it in only for a switch with several buttons, for example switch_2 for the second button. |
| Brightness code (optional) (optional) | Leave empty and the hub finds it (bright_value_v2 or bright_value). Fill it in only if the brightness slider does nothing. |
| Custom cloud address (optional) (optional) | Leave empty to use the region above. Only needed if Tuya gave you a different address, for example https://openapi.tuyain.com. |

### Good to know

- One-time setup on the Tuya developer website (iot.tuya.com): create a cloud project of the type Smart Home in the India data centre, add the free IoT Core service to it, then open Devices > Link Tuya App Account and scan the code with the Smart Life app. Your devices then appear in the project with their Device IDs; the Access ID and Access Secret are on the project’s Overview page.
- The project’s data centre must match the region of your Smart Life account, otherwise the devices do not show up. One Smart Life account can be linked to at most two cloud projects.
- The free IoT Core service is a trial: it runs out after one month and has to be renewed on the same website (Tuya takes 1 to 2 working days to approve), and it allows only a limited number of requests. When it has run out, this connection stops working until it is renewed.
- This connection needs internet at both ends, the hub and the device. It keeps working when the device is on a different network from the hub, but not when the device itself has no internet.
- To stay inside the request limit the hub asks Tuya for the status only every few minutes, so changes made elsewhere show up late. Commands from here go out straight away.
- Garage door openers: Open and Close are sent to the opener and its door sensor tells the hub whether the door is open or closed; these openers have no Stop command. A plain switch wired to the gate’s push-button can only press that button; the hub cannot tell which way the gate then moves.
- A Tuya device cannot be moved to another WiFi network from here. That is done by pairing it again in the Smart Life app.

## Tuya / Smart Life (inside the house)

Tuya and Smart Life bulbs, switches, sockets and gate relays, controlled directly over your WiFi. Works with the internet down.

**Can be:** light, switch, gate or garage door.  
**Connections:** WiFi / wired (usual port 6668).  
**Can do, at best:** on and off; brightness; open, stop and close; tells you whether it is open or closed.

### Before you add it

- Get the Device ID and 16-character local key once per device: free account at iot.tuya.com, cloud project in the India data centre, add IoT Core, Devices > Link Tuya App Account > scan with Smart Life, then run 'tuya-cli wizard' or 'python -m tinytuya wizard' (it also lists address and protocol version).
- Enter the device's address on the WiFi path and reserve that address in the router so it does not change (port 6668 is the default).
- Pick the protocol version the key list shows (3.3 for most; 3.4 / 3.5 for newer devices).
- Close the Smart Life app on phones on the same WiFi when the hub reports the device is busy: the device allows only one local connection.
- Fetch the local key again whenever a device is removed and re-paired in Smart Life.
- Multi-button switch: add each button as its own device with 'On/off channel number' 1, 2, 3 and so on.
- Dimmable device: turn on 'Can be dimmed'; older bulbs need the range set to 25-255 and brightness channel 3.
- Gate or garage door: wire the relay across the motor's push-button input and choose button-press or hold mode; adjust the press length if 1 second does not suit the motor.

### What the app asks for

| Field | What to enter |
|---|---|
| Device ID | The long code Tuya gives each device (20 or 22 letters and digits). It is listed next to the local key; the notes below say how to get both. |
| Local key | A 16-character code that lets the hub talk to the device inside the house. Stored encrypted on the hub. |
| Protocol version | Your key list shows this as "version". If the check fails although the key is right, try the next one. Choices: 3.3 (most devices) / 3.4 (newer devices) / 3.5 (newest devices) / 3.1 (old devices). Starts as: 3.3. |
| On/off channel number (optional) | Tuya numbers each function of a device. Leave empty and the hub works it out: 1 on switches, sockets and relays, 20 on light bulbs. For a switch with several buttons, add each button as its own device and enter 1, 2, 3 and so on. |
| Can be dimmed (optional) | Turn on for dimmable bulbs and dimmer switches. |
| Brightness channel number (optional) | Leave empty for the usual one: 22 on bulbs, 2 on dimmer switches, 3 on older bulbs. |
| Lowest brightness value (optional) | The device’s own number for its dimmest setting. Most use 10; older bulbs use 25. Starts as: 10. |
| Highest brightness value (optional) | The device’s own number for full brightness. Most use 1000; older bulbs use 255. Starts as: 1000. |
| Gate or garage door: how the relay works (optional) | Only used when this device is a gate or garage door. Most gate motors need the short button press. Choices: Presses the motor’s push button for a moment / Stays on while open, off while closed. Starts as: pulse. |
| Gate: length of the button press (milliseconds) (optional) | 1000 is one second, which suits most gate motors. The longest press is 5000 (five seconds). Starts as: 1000. |

### Good to know

- Works over your own WiFi with no internet. The hub and the device must be on the same network, and the device should keep the same address: reserve it in your router.
- To get the Device ID and local key (once per device): make a free account at iot.tuya.com, create a cloud project in the India data centre, add the "IoT Core" service, then under Devices choose "Link Tuya App Account" and scan the code with the Smart Life app. After that run "tuya-cli wizard" (or "python -m tinytuya wizard") on a computer: it lists every device with its id, key, address and version. One Smart Life account can be linked to two such projects at most.
- The local key changes every time the device is removed and paired again in Smart Life. If the hub starts saying the key is wrong, fetch the key again. The free Tuya service used to read keys runs out after a month, but you only need it when a key has changed.
- These devices allow only one local connection at a time. If the Smart Life app is open on a phone on the same WiFi it can block the hub: close the app and try again. The hub itself connects only for a few seconds at a time, for each command and each routine check.
- A change made at the wall button or in the Smart Life app shows up here at the hub’s next routine check, some seconds later, not instantly.
- On, off and brightness are controlled from here. Colour and warm/cool white are not; use the Smart Life app for those. If a bulb is showing a colour or a scene, setting its brightness here puts it back on white light, because that is the only light its brightness setting controls.
- Gates and garage doors: wire the relay across the motor’s push-button input. In button-press mode every gate command presses that button once, like the remote: the gate itself decides whether that means open, stop or close, and the hub cannot see where the gate is.
- The hub cannot move a Tuya device to another WiFi network. That needs pairing again in Smart Life, which also changes the local key.
- Battery-powered Tuya devices sleep most of the time and cannot be controlled this way.

## MQTT device

Lights, switches, gates and sensors that talk through an MQTT broker: Tasmota, ESPHome, Zigbee2MQTT, Shelly, home-made relays.

**Can be:** light, switch, gate or garage door, sensor.  
**Connections:** WiFi / wired, Cloud (usual port 1883).  
**Can do, at best:** on and off; brightness; open, stop and close; tells you whether it is open or closed.

### Before you add it

- Have an MQTT broker running that both the hub and the device can reach (Mosquitto on the hub PC for house WiFi devices; a broker on the internet for a relay on its own SIM, since the relay must dial out).
- For Mosquitto 2: add 'listener 1883' and a password file (or 'allow_anonymous true') to its settings and allow port 1883 in Windows Firewall, otherwise it refuses every other machine.
- Point the device at the broker in the device's own settings (broker address, port, username, password, and its topic name).
- Look up the device's topics and words: command topic, state topic, availability topic and its online/offline words (Tasmota: cmnd/<name>/POWER, stat/<name>/POWER or stat/<name>/RESULT with item POWER, tele/<name>/LWT with Online/Offline).
- Enter the broker's address as the connection address (not the device's), with the broker's username and password if it has a login.
- For a broker on the internet: turn on the secure connection, use port 8883, and only tick 'Accept a self-made certificate' for your own broker with a self-signed certificate.
- For a dimmable light: fill in the brightness topic and the number the device uses for full brightness (100 Tasmota, 254 Zigbee2MQTT).
- For a gate with a single step button: clear the open, close and stop messages and fill in only the pulse message (for a Tasmota relay: ON, with PulseTime set on the relay).

### What the app asks for

| Field | What to enter |
|---|---|
| Command topic (optional) | The topic (the "address" inside the broker) the device listens on for commands. Tasmota: cmnd/porch/POWER. Zigbee2MQTT: zigbee2mqtt/porch/set. Leave empty for a sensor. |
| State topic (optional) | The topic where the device reports what it is doing. Tasmota: stat/porch/POWER. It must be a different topic from the command topic. Leave empty if the device never reports back; the hub then shows what it asked for, not what was confirmed. |
| Item to read from the report (optional) | Only for devices that report in JSON, a message that looks like {"POWER":"ON"}. Write the name of the item, here POWER. For an item inside another, join the names with a dot, for example state.power. Leave empty when the report is a single word such as ON. |
| Message that turns it on (optional) | Sent to the command topic. Zigbee2MQTT wants {"state":"ON"}. Starts as: ON. |
| Message that turns it off (optional) | Sent to the command topic. Zigbee2MQTT wants {"state":"OFF"}. Starts as: OFF. |
| Report that means on (optional) | Leave empty if the device reports with the same word as the on message. Capital letters do not matter. Shelly Gen2 and newer report true. |
| Report that means off (optional) | Leave empty if the device reports with the same word as the off message. Shelly Gen2 and newer report false. |
| Availability topic (optional) | Optional but worth filling in. The topic where the device announces that it is connected, and where the broker announces when it drops off. Tasmota: tele/porch/LWT. Shelly: shellies/<name>/online. The device must publish this as a kept ("retained") message; Tasmota, ESPHome, Shelly and Zigbee2MQTT all do. |
| Announcement that means connected (optional) | Tasmota says Online, Shelly says true, Zigbee2MQTT says {"state":"online"} (online is enough for that one). Capital letters do not matter. Starts as: online. |
| Announcement that means disconnected (optional) | Tasmota says Offline, Shelly says false. Starts as: offline. |
| Brightness command topic (optional) | Lights that can be dimmed only. Tasmota: cmnd/porch/Dimmer. Leave empty for a plain on/off light. |
| Brightness message (optional) | What is sent to set the brightness; {value} is replaced by the number. Zigbee2MQTT wants {"brightness":{value}}. Starts as: {value}. |
| Brightness report topic (optional) | Where the light reports its brightness. Tasmota: stat/porch/RESULT. Leave empty if it is reported on the state topic above. |
| Brightness item in the report (optional) | For JSON reports: the name of the brightness item. Tasmota: Dimmer. Zigbee2MQTT: brightness. Leave empty when the report is just a number. |
| Number the device uses for full brightness (optional) | 100 for Tasmota. 254 for Zigbee2MQTT. 255 for many home-made dimmers. The app always shows 0 to 100 %. Starts as: 100. |
| Gate: message that opens it (optional) | Gates only. Left empty, the hub sends OPEN. If the gate has a single step button, leave this empty and fill in the step-button message below; Open is then one press of that button. |
| Gate: message that closes it (optional) | Gates only. Left empty, the hub sends CLOSE. Leave it empty for a single-button gate. |
| Gate: message that stops it (optional) | Gates only. Left empty, the hub sends STOP. Leave it empty for a single-button gate. |
| Gate: message for one press of the step button (optional) | For gate motors and garage doors with one button that goes open, stop, close in turn. For a Tasmota relay wired to that button this is ON (set PulseTime on the relay so it lets go again). When this is filled in and the three boxes above are empty, Open, Close and Stop are all done with presses of this button. |
| Gate: report that means open (optional) | Starts as: open. |
| Gate: report that means closed (optional) | Starts as: closed. |
| Gate: report that means opening (optional) | Starts as: opening. |
| Gate: report that means closing (optional) | Starts as: closing. |
| Gate: report that means stopped part-way (optional) | Starts as: stopped. |
| Broker username (optional) | The login for the broker, not for the device. Leave empty if the broker has no login. |
| Broker password (optional) | Stored encrypted on the hub. |
| Secure connection (TLS) (optional) | Turn on for a broker on the internet, and set the port of that connection to 8883, where secure brokers usually listen (a house WiFi connection is filled in with 1883, the port for plain connections). A connection whose port is 8883 is always made secure; one with no port uses 8883 when this is on and 1883 when it is off. |
| Accept a self-made certificate (optional) | Only for your own broker whose security certificate you made yourself. The connection is still encrypted, but the hub no longer checks that it is talking to the right broker. |
| Ask the broker to keep the last command (optional) | Leave off unless you know you need it. A kept command is delivered again every time the device reconnects; Tasmota in particular must not get kept commands. Never used for gate commands. |
| Delivery care (QoS) (optional) | Choices: 0 - send once, no confirmation / 1 - the broker confirms it got the message (recommended) / 2 - confirmed exactly once (few devices support it). Starts as: 1. |

### Good to know

- MQTT devices do not talk to the hub directly. The device and the hub both connect to a "broker", a small message-passing program (Mosquitto is the usual one). The address on each connection below is the address of the broker, not of the device.
- This is the one arrangement that works for a relay on its own SIM card: Indian mobile networks do not let anything connect in to a SIM, but the relay can dial out to a broker on the internet and the hub meets it there. Add that broker as a "Cloud" connection with the secure connection turned on.
- Fill in the availability topic if the device has one. Without it the hub can only tell that the broker is answering, not whether the device itself is switched on.
- Without a state topic the hub cannot hear back from the device, so after a command it shows what it asked for. With a state topic, a light or switch command counts as done only when the device reports back; if it stays silent the app asks you to look and confirm.
- After the hub restarts it only knows what the broker has kept. For a Tasmota device, type PowerRetain 1 in its console so its last on/off report is kept.
- Shelly: on the older (Gen1) models, switching MQTT on switches the Shelly cloud off, so the Shelly app stops working away from home. On Gen2 and newer, the MQTT settings page has two more switches that must be on: status updates over MQTT (called status_ntf) and MQTT control (enable_control). Without them the device stays silent and ignores commands.
- A gate motor or garage door with a single step button: leave the open, close and stop messages empty and fill in only the step-button message. Open and Close then each send one press. If the gate does not report its position, the hub cannot know which way that press will move it.
- Changing colour, restarting the device and moving it to another WiFi network cannot be done through this kind of connection. Use the device’s own app or web page for those.
- A Mosquitto 2 broker refuses every other machine until its settings file has "listener 1883" and a password file, and Windows Firewall must allow port 1883.

## Relay with web addresses (HTTP)

Relay boards and home-made WiFi switches that are controlled by simple web addresses.

**Can be:** light, switch, gate or garage door.  
**Connections:** WiFi / wired, SIM (4G) (usual port 80).  
**Can do, at best:** on and off; open, stop and close; tells you whether it is open or closed; restart.

### Before you add it

- Find the board's on, off and (if any) toggle, pulse, status and restart addresses in its manual or on its own web page.
- Give the device a fixed IP address on each house WiFi and enter it on each connection path, with the port if it is not 80.
- If the device asks for a login, enter the username and password; use {user} and {pass} in the address for devices that want them in the link (e.g. Tasmota), so the password stays in the encrypted field.
- For on/off display, enter the status address and what it reads when on (e.g. POWER=ON or relays.0.ison=true).
- For a gate: choose one-button or separate open/close/stop wiring and wire the relay's dry contact in parallel with the gate board's push-button input.
- For a gate: prefer the device's own timed pulse (Shelly timer=1 / toggle_after=1, Tasmota PulseTime) over the hub-timed press, and set the relay's power-on state to off.
- For open/closed display: fit a reed sensor at the closed position and enter its status address and the 'closed' reading (e.g. state=true).
- Set the gate travel time in seconds if it is far from 30.
- For the SIM path: confirm the SIM has a public address and forward a port to the device.

### What the app asks for

| Field | What to enter |
|---|---|
| Address that switches it on (optional) | Written from the first slash, for example /relay/1/on. The hub puts the device’s own address in front, so the same setting works on every connection. |
| Address that switches it off (optional) | For example /relay/1/off. |
| Address that flips it (optional) (optional) | Only if the device has one, for example /relay/1/toggle. Without it, Toggle reads the status first and then switches on or off. |
| Status address (optional) (optional) | An address that only reports whether the relay is on, for example /relay/1/status. The hub reads it often, so it must never switch anything. Without it the hub can only check that the device is on the network. |
| Reads as on when (optional) | What the status answer contains when the relay is on. Three ways to write it: plain text such as ON; a named value in a structured (JSON) answer such as POWER=ON or relays.0.ison=true; or a pattern between slashes such as /"output":\s*true/. |
| How commands are sent (optional) | Most relay boards use a plain link. Status addresses are read as a plain link either way, unless the address itself starts with POST. Choices: Plain link (GET) — the usual way / Posted form (POST). Starts as: GET. |
| Text sent with each command (optional) | Only if the device expects something inside the request, for example {"state":"on"}. Leave empty otherwise. |
| Username (optional) (optional) | Only if the device asks for a login. If you fill in a password and leave this empty, the hub logs in as admin, which is what Shelly and Tasmota devices expect. |
| Password (optional) (optional) | Stored encrypted on the hub. |
| Use HTTPS (optional) | Switch on if the device’s own page opens with https. The hub then uses port 443 unless you set a different port on the connection. The device’s own certificate is accepted as it is. |
| Gate: how the relay is wired (optional) | Only for gates and garage doors. Choices: One button — each press steps open, stop, close / Separate open, close and stop. Starts as: button. |
| Gate: address that presses the button briefly (optional) (optional) | An address that makes the device switch the relay on and off again by itself, for example /relay/0?turn=on&timer=1. If left empty, the hub uses the on address, waits for the press length, then uses the off address. |
| Gate: address that opens it (optional) | For example /relay/1/pulse. If the relay stays on until told otherwise, write both addresses with the word then between them: /relay/1/on then /relay/1/off. |
| Gate: address that closes it (optional) | Written the same way as the open address. |
| Gate: address that stops it (optional) (optional) | Without it the Stop button is refused. |
| Gate: press length (milliseconds) (optional) | How long the hub holds the relay on when it times the press itself. 800 suits most gate boards; allowed range 100 to 5000. Starts as: 800. |
| Gate: sensor address (optional) (optional) | An address that reports the gate’s position sensor, for example /input/1. It is only read, never switched. |
| Gate: sensor reads as closed when (optional) | Written the same way as “Reads as on when”, for example state=true. With the sensor address and this filled in, the app shows whether the gate is open or closed. |
| Gate: seconds to open or close fully (optional) | A rough figure is enough. The hub uses it to tell when a move it started should have finished. Starts as: 30. |
| Restart address (optional) (optional) | Only if the device has one, for example /reboot. Adds a Restart button. |

### Good to know

- For a light or switch, fill in the on and off addresses. For a gate or garage door, choose how the relay is wired and fill in the gate addresses. You will find the addresses in the board’s manual or on its own web page.
- Shelly and Tasmota devices have their own entries in the list of device types. Prefer those: they already know the device’s addresses and can also move it to another WiFi. Use this entry for other relay boards.
- If the device listens on a port other than 80, set that port on each connection (Sonoff devices in DIY mode use 8081). An address can also be written out in full with {host} where the device’s address goes, for example http://{host}:8081/zeroconf/switch. {port}, {user} and {pass} are filled in the same way, so a password never has to be typed into an address.
- One address can be sent differently from the rest by starting it with GET or POST and, after a space, the text to send. For a Sonoff in DIY mode: POST /zeroconf/switch {"deviceid":"1000xxxxxx","data":{"switch":"on"}}, with the device’s own ID in place of 1000xxxxxx. In such an address, write any space as %20.
- A command counts as done when the device answers without an error. The hub also reads the usual error replies inside an answer (for example an error number from a Sonoff, or “Command Unknown” from Tasmota) and reports them. It cannot see whether the lamp or the gate really reacted unless a status or sensor address is set.
- Without a status address the hub can only check that the device is on the network. It cannot show whether the relay is on, and Toggle then needs a toggle address.
- A gate relay only presses the button. Without a gate sensor the hub cannot see whether the gate really moved, and with one button it cannot know which way it will go.
- With one button, Stop only presses while a move the hub itself started can still be under way, because a press on a gate at rest would start it moving.
- When the hub times the press itself and the device drops off the network at the wrong moment, the relay can stay on. Where the device can pulse by itself, use its pulse address instead.
- If the answer to a toggle or to a press of a one-button gate is lost, the hub does not send it again, so the gate is never pressed twice by mistake. Check the device and try again.
- If the device answers with a redirect to https, switch on “Use HTTPS”. Newer Shelly firmware does this.
- The SIM connection only works when the SIM has a public address and the port is opened to the device. Plain http is not private, so prefer the house WiFi connections.
- These devices cannot be moved to another WiFi from here; use the device’s own setup page for that.

## GSM gate box (SMS)

A gate opener or relay box with its own SIM, worked by text message or a free phone call.

**Can be:** gate or garage door, switch.  
**Connections:** SMS.  
**Can do, at best:** open, stop and close; on and off; text commands.

### Before you add it

- Put a working SIM in the box with its PIN lock switched off; most of these boxes are 2G only, so use Airtel, Vi or BSNL rather than Jio.
- Enter the phone number of the SIM inside the box on the device's SMS connection.
- Pick the box type by matching the example texts in the box's leaflet (boxes sold as 'RTU5024' come in two different dialects).
- If the box password was ever changed, enter it (otherwise the factory one is used: 1234, 5678 on *71* boxes, 123456 on WAFER; *71* boxes also have a programming password, factory 1234).
- Store your own mobile number in the box once by text from your phone: RTU5024 1234TEL00919XXXXXXXXX# (box's own number) then 1234A001#919XXXXXXXXX#; 1234#ON# boxes 1234#TEL00919XXXXXXXXX#001# (64-number box 1234#TEL919XXXXXXXXX#01#); *71* boxes *12*1234#74919XXXXXXXXX# then *12*1234#7191#7219XXXXXXXXX#; WAFER #PWD123456#WHL001=<number>.
- Say how the box is wired to the gate: pressing the gate's button (default) or holding the gate open while switched on.
- RTU5024: set the press length once (1234GOT000# for a gate button, 1234GOT999# to stay on for a switch).
- Decide whether to open with a free phone call (switch on 'Open with a free phone call'); the calling phone's number must be stored in the box.
- For a Custom box, type each text from the leaflet with {pwd} where the password goes.

### What the app asks for

| Field | What to enter |
|---|---|
| Which texts the box understands | Pick the one that matches the examples in the leaflet that came with the box. Boxes sold as “RTU5024” come with either of the first two kinds, so go by the examples, not by the name on the lid. Choices: RTU5024 type (texts like 1234CC) / Texts like 1234#ON# (boxes for 200 or 999 numbers) / Texts like 1234#TEL…#01# (64-number box, opens by phone call only) / Texts like *71*5678# (Gainwise / First Fence type) / WAFER GSM-KEY (opens by phone call only) / Another box — I will type its texts. Starts as: king-pigeon. |
| Box password (optional) | Leave empty if you never changed it: the factory one is used (1234 on RTU5024 and 1234#… boxes, 5678 on *71* boxes, 123456 on WAFER). Stored encrypted on the hub. |
| Programming password (optional) | The second password of this kind of box, used for changing its settings and asking how it is. Leave empty for the factory one (1234). |
| How the box works the gate (optional) | For a gate or garage door. Most are wired the first way, so Open and Close send the same press. Not used when you type your own texts. Choices: It presses the gate’s button (each press: open, stop, close) / The gate stays open while the box is switched on. Starts as: step. |
| Open with a free phone call (optional) | Open then brings up your phone’s dialler with the box’s number. The box hangs up on the first ring and works the gate, so the call costs nothing. Your number must be stored in the box first. Boxes that open by phone call only always work this way. |
| Text that opens (optional) | Exactly as the leaflet shows it, with {pwd} where the password goes. Most boxes want capital letters and no spaces. |
| Text that closes (optional) | Exactly as the leaflet shows it, with {pwd} where the password goes. Most boxes want capital letters and no spaces. |
| Text that stops (optional) (optional) | Exactly as the leaflet shows it, with {pwd} where the password goes. Most boxes want capital letters and no spaces. |
| Text for one button press (optional) (optional) | Exactly as the leaflet shows it, with {pwd} where the password goes. Most boxes want capital letters and no spaces. |
| Text that asks the box how it is (optional) (optional) | The reply comes back as a text message to the SIM that sent it. |
| Text that switches on (for a switch) (optional) | Exactly as the leaflet shows it, with {pwd} where the password goes. Most boxes want capital letters and no spaces. |
| Text that switches off (for a switch) (optional) | Exactly as the leaflet shows it, with {pwd} where the password goes. Most boxes want capital letters and no spaces. |

### Good to know

- Commands go as a text message to the SIM inside the box; put that SIM’s number on the SMS connection. With a GSM modem on the hub the text is sent for you. Without one, the app opens your phone’s messages with the text ready: you press send, then confirm.
- The box cannot report back, so the app never knows whether the gate is open or closed; it only shows that the command went out. Any reply from the box arrives as a text on the SIM that sent the command.
- Before first use, store your mobile number in the box with one text from your phone (below, 9XXXXXXXXX stands for a mobile number; capital letters, no spaces). The box only opens for calls from numbers it has stored.
- RTU5024 type: first tell the box its own number with 1234TEL00919XXXXXXXXX#, then store yours with 1234A001#919XXXXXXXXX# (001 is the first of 200 places, and the one the box sends its replies to). It is worked with 1234CC (on), 1234DD (off) and 1234EE (status). 1234GOT000# sets a half-second press, right for a gate button; 1234GOT999# keeps it on until it is switched off or the box is called again, needed for a switch. A mistyped text gets no reply at all.
- Boxes with texts like 1234#ON#: store your number with 1234#TEL00919XXXXXXXXX#001#. They are worked with 1234#ON# and 1234#OFF#, and 1234#CSQ? asks for the signal strength. We could not confirm that the relay lets go by itself after 1234#ON#, so try it once while watching the gate. 1234#GOT02# sets a one-second press; 1234#GOT00# keeps the relay on until the next command, for a switch (the leaflets say only the first three stored numbers can work the box in that setting). The 64-number box stores numbers with 1234#TEL919XXXXXXXXX#01# and has no on or off text: it opens by phone call only.
- Boxes with texts like *71*5678#: store callers with *12*1234#7191#7219XXXXXXXXX# (7191 sets the country code to India; 721 goes in front of each 10-digit number). They are worked with *71*5678# (one press), *72*5678# (hold) and *73*5678# (release), which get no reply; *24*1234# asks for the state. A text to this kind of box can be 140 characters at most.
- The same *71* boxes can make one phone the only one allowed to change their settings. For India our best information is *12*1234#74919XXXXXXXXX#, but we could not confirm how the number must be written there, and a wrong one shuts you out of the settings until the reset button inside the box is used. Leave this step until everything else works, and keep the leaflet at hand.
- WAFER GSM-KEY: store your number with #PWD123456#WHL001=9XXXXXXXXX. We have no confirmed text for switching this box, so it opens by phone call only; #PWD123456#STATUS? asks for the state.
- Cost: each command is one ordinary SMS on the plan of the SIM that sends it. India has no legal daily cap on personal texts, only your plan’s own allowance, so keep commands occasional. Opening by phone call is free because the box hangs up on the first ring. Calls are always made from your phone; the hub cannot place them.
- With one button input on the gate, Open and Close send the same press and the gate takes its next step (open, stop, close), so look at the gate or a camera to be sure. Leave a few seconds between taps: a second press inside the press time can make the box let go early.
- The SIM in the box must have its PIN lock switched off. Most of these boxes are 2G only, so a Jio SIM will not work in them; use Airtel, Vi or BSNL.

## Illustrative device

Behaves like a real camera, gate or light with no hardware. Good for trying the app.

**Can be:** camera, gate or garage door, light, switch.  
**Connections:** WiFi / wired, SIM (4G), SMS, Cloud (usual port 80).  
**Can do, at best:** on and off; brightness; open, stop and close; tells you whether it is open or closed; turn and zoom; saved positions; still pictures; can be moved to another WiFi from the app; can list the WiFi networks it sees; reports its SIM and signal; restart; text commands.

### What the app asks for

| Field | What to enter |
|---|---|
| Behaves like | Choices: PTZ camera with its own SIM / Sliding gate with GSM box / On / off light / Dimmable light. Starts as: light. |
| Starts on WiFi (optional) | Leave blank to start on the first path’s network. |
| SIM has a public IP (optional) | Off = the carrier blocks inbound connections, like a normal consumer SIM. |
| Flakiness (%) (optional) | Chance that any check fails, to try the failover. Starts as: 0. |
| Gate is jammed (optional) | The gate takes commands but does not move, to see how a gate that fails is reported. |
| Fails to join a new WiFi (optional) | When moved to another network it restarts and comes back on the old one, like a device given a wrong password. |

### Good to know

- Illustrative only. Replace with your real devices when you add them.

## If the test says no

- **"refused the connection" or "did not answer"**: the address or port is wrong, the device is off, or the hub is not on that network.
- **"Wrong username or password"**: fix it before trying again. Several cameras lock the account for a while after a few wrong tries.
- **"The carrier gives this SIM a private address"**: expected for a normal SIM. Use one of the other routes in [REMOTE-ACCESS.md](REMOTE-ACCESS.md).
- Still stuck: start the hub with `HC_LOG_LEVEL=debug` and read what it prints for that device. Passwords are never printed.
