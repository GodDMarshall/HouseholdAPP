#!/usr/bin/env bash
# House Control on a Raspberry Pi (or any Debian/Ubuntu box): install, build,
# fetch go2rtc and run as a service that starts at boot.
#
#   cd "Home Control Room" && bash scripts/pi/setup.sh
#
# Needs Node.js 22.13 or newer already installed (https://nodejs.org or NodeSource).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GO2RTC_VERSION="${GO2RTC_VERSION:-v1.9.14}"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<13)) { console.error("Node 22.13 or newer is needed, found "+process.version); process.exit(1) }'

cd "$ROOT"
npm install --no-audit --no-fund
npm run build

mkdir -p hub/bin
case "$(uname -m)" in
  aarch64|arm64) ASSET=go2rtc_linux_arm64 ;;
  armv7l)        ASSET=go2rtc_linux_arm ;;
  x86_64)        ASSET=go2rtc_linux_amd64 ;;
  *) echo "Unknown machine type $(uname -m); skipping go2rtc"; ASSET="" ;;
esac
if [ -n "$ASSET" ]; then
  curl -fL "https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/${ASSET}" -o hub/bin/go2rtc
  chmod +x hub/bin/go2rtc
fi

SERVICE=/etc/systemd/system/house-control.service
sudo tee "$SERVICE" >/dev/null <<UNIT
[Unit]
Description=House Control hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$ROOT/hub
ExecStart=$(command -v node) --no-warnings=ExperimentalWarning --import tsx src/index.ts
Restart=always
RestartSec=5
Environment=HC_PORT=8080

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now house-control
echo
echo "House Control is running and will start at every boot."
echo "Open http://$(hostname -I | awk '{print $1}'):8080"
echo "Logs: journalctl -u house-control -f"
