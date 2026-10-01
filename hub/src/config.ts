import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** hub/ */
export const HUB_ROOT = path.resolve(here, '..')
/** repository root */
export const REPO_ROOT = path.resolve(HUB_ROOT, '..')
export const VERSION = '0.1.0'

function int(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const config = {
  /** HTTP port the app and API are served on. */
  port: int(process.env.HC_PORT, 8080),
  host: process.env.HC_HOST ?? '0.0.0.0',
  /** Where the registry, keys and snapshots live. Back this folder up. */
  dataDir: process.env.HC_DATA_DIR ?? path.join(REPO_ROOT, 'data'),
  /** Built phone app (npm run build). */
  appDist: process.env.HC_APP_DIST ?? path.join(REPO_ROOT, 'app', 'dist'),
  /** go2rtc binary for live video. scripts/get-go2rtc.ps1 puts it here. */
  go2rtcBin:
    process.env.HC_GO2RTC_BIN ??
    path.join(HUB_ROOT, 'bin', process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc'),
  go2rtcPort: int(process.env.HC_GO2RTC_PORT, 1984),
  /** Serial port of a USB GSM modem, e.g. COM3 or /dev/ttyUSB0. Empty = hand SMS to the phone. */
  smsPort: process.env.HC_SMS_PORT?.trim() || null,
  /** How often each device's active path is checked. */
  probeIntervalSec: int(process.env.HC_PROBE_INTERVAL_SEC, 15),
  /** While on a lower path, re-try better paths every N checks. */
  failbackEveryTicks: int(process.env.HC_FAILBACK_EVERY, 4),
  /** Per-request timeout when talking to a device. */
  deviceTimeoutMs: int(process.env.HC_DEVICE_TIMEOUT_MS, 6000),
  logLevel: (process.env.HC_LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  /** Add the illustrative virtual devices when the registry is empty. */
  seedVirtual: process.env.HC_SEED_VIRTUAL !== '0',
}

export type Config = typeof config
