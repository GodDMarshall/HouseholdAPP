// Writes docs/ADD-YOUR-DEVICES.md from what the app itself shows: each family's
// own description, fields and notes, plus the "before you add it" steps in
// scripts/device-steps.json. Run after changing an adapter:
//
//   npm run guide
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { kindLabel, pathKindLabel, type Capability, type FamilyDescriptor } from '../shared/src/index.ts'
import { familyDescriptors } from '../hub/src/adapters/index.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const steps = JSON.parse(fs.readFileSync(path.join(here, 'device-steps.json'), 'utf8')) as Record<string, string[]>

const CAP: Record<Capability, string> = {
  power: 'on and off',
  dim: 'brightness',
  color: 'colour',
  gate: 'open, stop and close',
  'gate-state': 'tells you whether it is open or closed',
  ptz: 'turn and zoom',
  presets: 'saved positions',
  snapshot: 'still pictures',
  stream: 'live video',
  wifi: 'can be moved to another WiFi from the app',
  'wifi-scan': 'can list the WiFi networks it sees',
  cellular: 'reports its SIM and signal',
  reboot: 'restart',
  sms: 'text commands',
  state: 'reports its state',
}

const ORDER = ['onvif', 'hikvision', 'dahua', 'tapo', 'rtsp', 'tasmota', 'shelly', 'tuya-cloud', 'tuya-local', 'mqtt', 'http-relay', 'gsm-sms', 'virtual']

const WHICH: Array<[string, string]> = [
  ['A Hikvision camera (also sold as Hik-Connect, HiLook, some Prama)', 'Hikvision camera'],
  ['A CP Plus or Dahua camera', 'Dahua / CP Plus camera'],
  ['A TP-Link Tapo camera', 'TP-Link Tapo camera'],
  ['Any other IP camera that mentions ONVIF', 'ONVIF camera'],
  ['A camera that only gives a video address (RTSP), such as EZVIZ or ICSee / XMEye', 'Camera by stream address'],
  ['A Sonoff or other switch flashed with Tasmota', 'Tasmota'],
  ['A Shelly relay or dimmer', 'Shelly'],
  ['Smart Life / Tuya bulbs, switches or garage openers', 'Tuya (cloud) if it must work from anywhere, including when the house WiFi is down for the hub. Tuya (local) for speed when the hub is on the same network.'],
  ['A gate box with a SIM card that you text or call', 'GSM gate box (SMS)'],
  ['A relay board with web addresses for on and off', 'HTTP relay'],
  ['Anything that talks to an MQTT broker (ESPHome, Zigbee2MQTT, a relay on its own SIM)', 'MQTT device'],
]

function section(f: FamilyDescriptor): string[] {
  const out: string[] = []
  out.push(`## ${f.label}`, '', f.tagline, '')
  out.push(`**Can be:** ${f.kinds.map((k) => kindLabel(k).toLowerCase()).join(', ')}.  `)
  out.push(`**Connections:** ${f.pathKinds.map((k) => pathKindLabel(k)).join(', ')}${f.defaultPort ? ` (usual port ${f.defaultPort})` : ''}.  `)
  const caps = f.capabilities.filter((c) => c !== 'state').map((c) => CAP[c])
  if (caps.length) out.push(`**Can do, at best:** ${caps.join('; ')}.`)
  out.push('')
  const before = steps[f.id] ?? []
  if (before.length) {
    out.push('### Before you add it', '')
    for (const s of before) out.push(`- ${s}`)
    out.push('')
  }
  if (f.fields.length) {
    out.push('### What the app asks for', '')
    out.push('| Field | What to enter |', '|---|---|')
    for (const field of f.fields) {
      const help = [field.help ?? '', field.type === 'select' && field.options ? `Choices: ${field.options.map((o) => o.label).join(' / ')}.` : '', field.default !== undefined && field.default !== '' && field.type !== 'toggle' ? `Starts as: ${String(field.default)}.` : '']
        .filter(Boolean)
        .join(' ')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')
      out.push(`| ${field.label}${field.required ? '' : ' (optional)'} | ${help || (field.type === 'toggle' ? 'Switch on if it applies.' : '')} |`)
    }
    out.push('')
  }
  if (f.notes.length) {
    out.push('### Good to know', '')
    for (const n of f.notes) out.push(`- ${n}`)
    out.push('')
  }
  return out
}

const families = familyDescriptors().filter((f) => f.kinds.length > 0)
families.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))

const md: string[] = []
md.push(
  '# Adding your devices',
  '',
  'Everything is added from the app: the **+** button on the House screen. It takes five steps: what the thing is, how it connects, its details, the ways to reach it, then a test and save. You can change any of it later from the device’s page (the pencil), or remove the device there.',
  '',
  'Do these two things first; they save trouble later:',
  '',
  '1. **Store your WiFi networks** under the WiFi tab, with their passwords: the main router, and any backup router.',
  '2. **Give each device a fixed address** in the router (often called a DHCP reservation or static lease), so the address you type stays right after a restart.',
  '',
  'Nothing in this build has been tried on real hardware yet. Every family was written from the makers’ documents and checked against a stand-in device, so the first real device of each kind is the real test. If the test in step 5 says no, the message tells you why in plain words.',
  '',
  '## Which family is my device?',
  '',
  '| You have | Choose |',
  '|---|---|',
  ...WHICH.map(([a, b]) => `| ${a} | ${b} |`),
  '',
  'Not sure which camera family? Try **Find devices on the network** in step 2. Cameras with ONVIF switched on answer it.',
  '',
  '## The ways to reach a device',
  '',
  'In step 4 you list the connections, best first. The hub uses the first one that answers and moves down the list by itself when it stops.',
  '',
  '| Connection | What to enter | When it works |',
  '|---|---|---|',
  '| WiFi / wired | The device’s address on that network, and which stored WiFi it is | Whenever the hub is on that network |',
  '| SIM (4G) | The public address of the SIM | Only with a SIM that has a public address. Ordinary Indian consumer SIMs do not, and the test says so. See [REMOTE-ACCESS.md](REMOTE-ACCESS.md). |',
  '| Cloud | Nothing; the account details are in step 3 | Anywhere the device has internet |',
  '| SMS | The phone number of the SIM in the device | Wherever there is mobile signal. The device cannot report back. |',
  '',
)
for (const f of families) md.push(...section(f))
md.push(
  '## If the test says no',
  '',
  '- **"refused the connection" or "did not answer"**: the address or port is wrong, the device is off, or the hub is not on that network.',
  '- **"Wrong username or password"**: fix it before trying again. Several cameras lock the account for a while after a few wrong tries.',
  '- **"The carrier gives this SIM a private address"**: expected for a normal SIM. Use one of the other routes in [REMOTE-ACCESS.md](REMOTE-ACCESS.md).',
  '- Still stuck: start the hub with `HC_LOG_LEVEL=debug` and read what it prints for that device. Passwords are never printed.',
  '',
)

const file = path.resolve(here, '..', 'docs', 'ADD-YOUR-DEVICES.md')
fs.writeFileSync(file, md.join('\n'))
console.log(`wrote ${file}: ${families.length} families`)
