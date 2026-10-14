# The Android app

House Control on the phone is the same app the hub serves at `http://<hub>:8080`.
The Android app in `phone-app/` is a thin shell around it: an app icon, a dark
start screen that finds the hub, and a full-screen browser view that opens the
hub's own screens inside the app. Because the shell carries no copy of the
app, it never needs updating when the hub's app changes.

## Get it on the phone

1. On the phone, in Chrome, open the **android-latest** release of the
   repository (Releases on the GitHub page). Under **Assets** tap
   `House-Control.apk`, not "Source code". If the repository is private, sign
   in to GitHub in Chrome first, or the release will not show. Chrome warns
   that this kind of file can harm the phone: tap **Download anyway**.
2. Open the download (Chrome's download bar, or the Downloads app). The first
   time, the phone says it is not allowed to install unknown apps from this
   source: tap **Settings**, switch on **Allow from this source**, then go
   back. A Xiaomi / Redmi phone may add its own "Install anyway" or a short
   security scan; tap through. If the phone says "App not installed" over an
   older copy, uninstall the old one first and install again.
3. Open **House Control**. The hub must be running on the house PC (the PC on
   and signed in; see the README, Start with Windows). The app looks for the
   hub on the house WiFi (`192.168.1.7:8080`) and through Tailscale
   (`100.124.59.5:8080`, with the Tailscale app switched on) and opens whichever
   answers. If neither does, it shows both and a box to type another address.
   The hub's address is shown on the house PC at http://localhost:8080 under
   Settings → The hub → Address. Give the PC a fixed address in the router (a
   DHCP reservation) so it stays 192.168.1.7 after a router reset; with
   Tailscale on the phone the app finds the hub even if the WiFi address moves.

The first time through each address (house WiFi, Tailscale, or one typed in)
the app asks the house PIN, as a browser would. If no PIN has been chosen yet,
it asks you to choose one.

## Where the APK comes from

GitHub builds it (`.github/workflows/android.yml`) whenever `phone-app/`
changes on `main`, and also from the **Actions** tab with "Run workflow". The
build machine already has Java and the Android SDK, so nothing has to be
installed on the house PC. The signed APK is attached to the `android-latest`
release and kept as a workflow artifact.

## The signing key

Android lets a newer APK install over the old one only when both are signed
with the same key. The key for this app lives on the house PC in
`phone-app/signing/` (ignored by git, never in the repository) with a
README that has its details. It unlocks nothing on the hub; the hub trusts the
PIN, not the app.

GitHub signs with that key once two repository secrets exist (GitHub →
Settings → Secrets and variables → Actions → New repository secret):

- `ANDROID_KEYSTORE_B64`: the key file as base64. In PowerShell on the house PC
  this copies it to the clipboard:
  `[Convert]::ToBase64String([IO.File]::ReadAllBytes("D:\Home Control Room\phone-app\signing\house-control.keystore")) | Set-Clipboard`
- `ANDROID_KEYSTORE_PASSWORD`: the password from the README in that folder.

Until the secrets are there, GitHub signs with a throwaway debug key. The APK
installs all the same; only installing a newer one needs the old app
uninstalled first (the hub address is then asked for once more).

## Changing the hub address

In the app: **Settings → The hub → Change hub address** brings the start screen
back with the known addresses and a box for a new one. The address is the
only thing the shell stores.

## What works, and what does not

- Everything the app does in a browser works here: tiles, gate, cameras,
  lights, adding devices, the radar scan, changing WiFi, SMS hand-offs.
- Notifications arrive only while the app is open (as messages in the app).
  Push notifications to a closed app need the secure (https) Tailscale address,
  as in [REMOTE-ACCESS.md](REMOTE-ACCESS.md), and the app installed from Chrome
  through that address. The shell cannot receive them.
- Live video needs go2rtc on the hub (see the README); until then cameras show
  still pictures, here as everywhere.
- The Back button steps back inside the app; from the house screen it leaves
  the app.
- Inside the app, Settings hides the browser-only advice (installing from
  Chrome, turning notifications on).

## What the shell trusts

The shell lets its screen open any address you type, so that a hub that has
moved to another address still opens inside the app. That also means any page
you open in it is treated like the hub. Only type the hub's address.

## Building it on this PC instead

Not needed, but possible: install a Java 21 JDK and the Android SDK (platform
36, build-tools), then

```
npm install
npx cap sync android     # from phone-app/
cd phone-app/android && gradlew assembleRelease
```

The APK lands in `phone-app/android/app/build/outputs/apk/release/`.
