// End-to-end walk through House Control in headless Chrome at phone size.
//
//   npm run test:e2e
//
// Starts its own hub on a throwaway data folder and port (never the real one),
// walks the app the way an owner would with the illustrative devices, saves
// screenshots to e2e/shots/, and stops the hub. Needs Chrome or Edge installed
// (set CHROME_PATH if it is somewhere unusual) and a built app (npm run build).
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const PORT = Number(process.env.HC_E2E_PORT ?? 8099)
const BASE = process.argv[2] ?? `http://127.0.0.1:${PORT}`
const PIN = process.env.HC_TEST_PIN ?? '2468'
const shots = path.join(here, 'shots')
fs.mkdirSync(shots, { recursive: true })
for (const f of fs.readdirSync(shots)) if (f.endsWith('.png')) fs.rmSync(path.join(shots, f))
const results = []
const errors = []
let n = 0

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) throw new Error('No Chrome or Edge found. Set CHROME_PATH to the browser executable.')
  return found
}

// ---- a private hub for this run (unless a base URL was given)
let hub = null
let dataDir = null
if (!process.argv[2]) {
  if (!fs.existsSync(path.join(root, 'app', 'dist', 'index.html'))) throw new Error('Build the app first: npm run build')
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-e2e-'))
  hub = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(root, 'hub'),
    env: { ...process.env, HC_DATA_DIR: dataDir, HC_PORT: String(PORT), HC_PROBE_INTERVAL_SEC: '5', HC_LOG_LEVEL: 'warn', HC_GO2RTC_BIN: path.join(dataDir, 'none') },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const deadline = Date.now() + 20000
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/auth/status`)
      if (r.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      hub.kill()
      throw new Error('The test hub did not start')
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

// A stand-in Tasmota switch on this machine, for the "I know its address" check.
const tasmota = { on: false, commands: [] }
const tasmotaServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const cmnd = u.searchParams.get('cmnd') ?? ''
  tasmota.commands.push(cmnd)
  const sts = () => ({ POWER: tasmota.on ? 'ON' : 'OFF', Wifi: { AP: 1, SSId: 'Home WiFi', RSSI: 74, Signal: -63 } })
  let body
  if (u.pathname !== '/cm') {
    res.writeHead(404)
    return res.end('no')
  }
  if (/^status 0$/i.test(cmnd)) body = { Status: { DeviceName: 'Veranda switch', FriendlyName: ['Veranda'], Power: tasmota.on ? 1 : 0 }, StatusFWR: { Version: '14.2.0(tasmota)' }, StatusNET: { Hostname: 'tasmota-1', IPAddress: '127.0.0.1', Mac: 'AA:BB:CC:11:22:33' }, StatusSTS: sts() }
  else if (/^status/i.test(cmnd)) body = { StatusSTS: sts() }
  else if (/^power/i.test(cmnd)) {
    const arg = cmnd.split(' ')[1]?.toUpperCase()
    if (arg === 'ON' || arg === '1') tasmota.on = true
    else if (arg === 'OFF' || arg === '0') tasmota.on = false
    else if (arg === 'TOGGLE' || arg === '2') tasmota.on = !tasmota.on
    body = { POWER: tasmota.on ? 'ON' : 'OFF' }
  } else body = { Command: 'Unknown' }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
})
await new Promise((r) => tasmotaServer.listen(0, '127.0.0.1', r))
const TASMOTA_PORT = tasmotaServer.address().port

const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: 'new',
  args: ['--no-first-run', '--disable-extensions'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  n += 1
  await page.screenshot({ path: path.join(shots, `${String(n).padStart(2, '0')}-${name}.png`) })
}
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const text = () => page.evaluate(() => document.body.innerText)
const clickText = async (sel, txt) => {
  const ok = await page.evaluate(
    (sel, txt) => {
      const el = [...document.querySelectorAll(sel)].find((e) => (e.getAttribute('aria-label') ?? e.innerText ?? '').trim().toLowerCase().includes(txt.toLowerCase()))
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.click()
      return true
    },
    sel,
    txt,
  )
  if (!ok) throw new Error(`no ${sel} with "${txt}"`)
}
const waitText = async (txt, ms = 15000) => {
  try {
    await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), { timeout: ms }, txt)
    return true
  } catch {
    return false
  }
}
const pin = async () => {
  for (const d of PIN) await clickText('.keypad button', d)
  await clickText('.keypad button', 'OK')
  await sleep(250)
}
const goHome = async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await sleep(600)
}
const openDevice = async (name) => {
  await goHome()
  const href = await page.evaluate(async (name) => {
    const t = localStorage.getItem('hc.token')
    const list = await (await fetch('/api/devices', { headers: { Authorization: 'Bearer ' + t } })).json()
    const d = list.find((x) => x.name === name)
    return d ? '/device/' + d.id : null
  }, name)
  if (!href) throw new Error('device not found: ' + name)
  await page.goto(BASE + href, { waitUntil: 'networkidle2' })
  await sleep(700)
  return href
}

try {
  // ---- 1. first run: set the PIN
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await sleep(500)
  let t = await text()
  if (t.includes('Choose a PIN')) {
    await shot('pin-setup')
    await pin()
    check('PIN setup asks to repeat', (await text()).includes('Type it again'))
    await pin()
  } else if (t.includes('Enter the house PIN')) {
    await pin()
  }
  check('Home shows after sign-in', await waitText('all reachable', 12000), (await text()).split('\n').slice(0, 3).join(' | '))
  await sleep(1500)
  await shot('home')

  // ---- 2. toggle a light from its tile
  await clickText('.tile', 'Veranda light')
  check('Light turns on from the tile', await waitText('Veranda light: Toggle — now on', 6000))
  await sleep(300)
  await shot('home-light-on')
  check('"All lights off" appears', (await text()).includes('All lights off'))
  await clickText('button', 'All lights off')
  check('All lights off works', await waitText('now off', 6000))

  // ---- 2b. lock up: opens the garage door first, then one tap closes it and the lights
  await openDevice('Garage door')
  await clickText('.gatebtns button', 'Open')
  await waitText('gate is open', 15000)
  await goHome()
  await clickText('.tile', 'Veranda light')
  await waitText('now on', 6000)
  await clickText('button', 'Lock up')
  await sleep(300)
  check('Lock up says what it will do', (await text()).includes('Closes Garage door') && (await text()).includes('Turns off 1 light'))
  await shot('lock-up')
  await clickText('.sheet button.primary', 'Lock up')
  check('Lock up closes the garage door', await waitText('gate is closed', 15000))
  check('Lock up turned the light off', await page.evaluate(() => [...document.querySelectorAll('.tile')].find((t) => t.innerText.includes('Veranda light'))?.innerText.includes('Off')))

  // ---- 3. dimmer
  await openDevice('Hall lights')
  await clickText('button', 'Turn on')
  check('Dimmer page: turns on', await waitText('now on', 6000))
  await shot('light-detail')

  // ---- 4. gate: open and wait for "open"
  await openDevice('Main gate')
  await shot('gate-closed')
  await clickText('.gatebtns button', 'Open')
  check('Gate reports opening', await waitText('Opening', 5000))
  await sleep(1500)
  await shot('gate-opening')
  check('Gate finishes open + toast', await waitText('gate is open', 15000))
  await shot('gate-open')
  await clickText('.gatebtns button', 'Close')
  check('Gate closes', await waitText('gate is closed', 15000))
  await sleep(4000) // let the toasts clear
  await clickText('.gatebtns button', 'Open')
  await sleep(1800)
  const tStop = Date.now()
  await clickText('.gatebtns button', 'Stop')
  check('Stop halts a gate that is still opening, at once', (await waitText('gate stopped', 4000)) && Date.now() - tStop < 4000, `${Date.now() - tStop} ms`)
  check('The overtaken Open is not reported as failed', !(await text()).includes('failed'))
  await shot('gate-stopped')
  await clickText('.gatebtns button', 'Close')
  await waitText('gate is closed', 15000)
  await sleep(4000)
  await clickText('button', 'Check now')
  check('Check now answers when all is well', await waitText('Main gate: On Home WiFi', 6000))

  // ---- 5. camera: picture, PTZ, snapshot
  await openDevice('Gate camera')
  await sleep(1500)
  check('Camera shows a picture', await page.evaluate(() => Boolean(document.querySelector('.viewer img'))))
  await shot('camera')
  const ptzBefore = await page.evaluate(() => document.querySelector('.viewer img')?.getAttribute('src'))
  // hold "pan right" for 1.5 s
  const right = await page.$('button[aria-label="Pan right"]')
  const box = await right.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await sleep(1500)
  await page.mouse.up()
  await sleep(1200)
  const pan = await page.evaluate(async () => {
    const t = localStorage.getItem('hc.token')
    const id = location.pathname.split('/')[2]
    const s = await (await fetch(`/api/devices/${id}/state`, { headers: { Authorization: 'Bearer ' + t } })).json()
    return s.state.ptz?.pan
  })
  check('Holding the pad pans the camera, releasing stops it', typeof pan === 'number' && pan > 0.3, `pan=${pan}`)
  await sleep(800)
  await shot('camera-panned')
  await clickText('button', 'Take a picture')
  check('Snapshot saved', await waitText('picture saved', 8000))
  await sleep(600)

  // ---- 6. move the camera to the backup WiFi
  await clickText('button', 'Move to WiFi')
  await sleep(400)
  await shot('move-wifi-sheet')
  await clickText('.sheet button', 'What does the device see')
  check('Device WiFi scan lists what it sees', await waitText('The device sees it', 10000))
  await clickText('.sheet button.row', 'Backup WiFi')
  check('Camera moves to Backup WiFi', await waitText('now on Backup WiFi', 60000))
  await sleep(1500)
  check('Tile/connection now shows Backup WiFi in use', await page.evaluate(() => document.querySelector('.pathrow.active')?.innerText.includes('Backup WiFi')))
  await shot('camera-on-backup')

  // ---- 7. pin the SIM path (carrier NAT -> must fail with a clear reason)
  await clickText('.pathrow', 'SIM connection')
  await sleep(300)
  await shot('path-sheet')
  await clickText('.sheet button', 'Use this connection')
  check('Pinning an unreachable SIM path fails with a reason', await waitText('is not answering', 12000))
  await sleep(500)
  check('SIM path shows the carrier explanation', (await text()).includes('private address'))
  check('No pin is left on the dead connection', await page.evaluate(() => !document.querySelector('.pathrow .chip.blue') && document.querySelector('.pathrow.active')?.innerText.includes('Backup WiFi')))
  await sleep(1500)
  await shot('camera-paths')

  // ---- 8. gate over SMS: pin SMS, open -> needs confirmation -> confirm
  await openDevice('Main gate')
  await clickText('.pathrow', 'SMS connection')
  await sleep(300)
  await clickText('.sheet button', 'Use this connection')
  check('Gate pinned to SMS', await waitText('SMS only', 8000) || (await text()).includes('Pinned'))
  await sleep(500)
  await clickText('.gatebtns button', 'Open')
  check('SMS command asks the owner to send it', await waitText('needs you', 8000))
  await sleep(500)
  const href = await page.evaluate(() => document.querySelector('a.btn.primary')?.getAttribute('href'))
  check('Hand-off link is a pre-filled sms: link', typeof href === 'string' && href.startsWith('sms:+91') && href.includes('body='), String(href))
  await shot('gate-sms-handoff')
  await clickText('button', 'It worked')
  await sleep(800)
  check('Confirmation clears the pending card', await page.evaluate(() => ![...document.querySelectorAll('.card h2')].some((h) => h.innerText.includes('needs you'))))
  await clickText('button', 'Automatic')
  await sleep(1500)

  // ---- 8b. easy add: the scan screen, then a device found by its address
  await page.goto(BASE + '/add', { waitUntil: 'networkidle2' })
  await sleep(1200)
  check('Easy add opens on a live network scan', await page.evaluate(() => Boolean(document.querySelector('.radar.live')) && document.body.innerText.includes('Looking at your network')))
  await shot('easy-add-scanning')
  check('The scan finishes and says what it found', await waitText('Scan finished', 40000))
  await shot('easy-add-done')
  await clickText('button.row', 'Smart Life / Tuya account')
  check('Smart Life link explains the one-time step', await waitText('How to get the two codes', 5000))
  await page.keyboard.press('Escape')
  await sleep(300)
  await clickText('button.row', 'I know its address')
  await sleep(300)
  await page.type('#a-host', 'not an address!')
  await clickText('.sheet button.primary', 'Find out what it is')
  check('A mistyped address gets a plain answer', await waitText('That does not look like an address', 5000))
  await page.evaluate(() => {
    const el = document.querySelector('#a-host')
    el.select()
  })
  await page.keyboard.type(`127.0.0.1:${TASMOTA_PORT}`)
  await clickText('.sheet button.primary', 'Find out what it is')
  check('The hub recognises what is at a typed address', (await waitText('Add Tasmota', 10000)) && (await page.evaluate(() => document.querySelector('#q-name')?.value)) === 'Veranda switch')
  await shot('easy-add-recognised')
  await clickText('.sheet button', 'Light')
  await clickText('.sheet button.primary', 'Add to my house')
  check('One tap adds it and opens it', (await waitText('Veranda switch added', 10000)) && page.url().includes('/device/'))
  await sleep(1500)
  await clickText('button', 'Turn on')
  check('The newly added real-family device obeys', (await waitText('now on', 8000)) && tasmota.on === true, tasmota.commands.slice(-3).join(' , '))
  await shot('easy-add-device')
  await clickText('button', 'Edit device')
  await sleep(500)
  await clickText('button', 'Remove this device')
  await sleep(300)
  await clickText('.sheet button.danger', 'Remove')
  await sleep(800)

  // ---- 9. add a device through the wizard
  await page.goto(BASE + '/add', { waitUntil: 'networkidle2' })
  await sleep(600)
  await clickText('button.row', 'Set it up by hand')
  check('Setting up by hand is one tap from the scan', await waitText('Step 1 of 5', 5000))
  await sleep(500)
  await shot('add-1-kind')
  await clickText('.choice', 'Light')
  await clickText('button.primary', 'Next')
  await sleep(300)
  await shot('add-2-family')
  await clickText('.choice', 'Illustrative device')
  await clickText('button.primary', 'Next')
  await sleep(300)
  await page.type('#f-name', 'Kitchen light')
  await page.type('#f-room', 'Kitchen')
  await shot('add-3-details')
  await clickText('button.primary', 'Next')
  await sleep(300)
  await page.goBack() // the phone's own Back button
  await sleep(400)
  check('Phone Back steps back in the wizard and keeps what was typed', (await text()).includes('Step 3 of 5') && (await page.evaluate(() => document.querySelector('#f-name')?.value)) === 'Kitchen light')
  await clickText('button.primary', 'Next')
  await sleep(300)
  await page.evaluate(() => {
    const el = document.querySelector('.pathcard input.input')
    el.focus()
  })
  await page.keyboard.type('192.168.1.80')
  await shot('add-4-paths')
  await clickText('button.primary', 'Next')
  await sleep(300)
  await clickText('button', 'Test the connections')
  check('Wizard test reports the path answering', await waitText('Answering', 8000))
  await shot('add-5-test')
  await clickText('button.primary', 'Save device')
  check('New device saved and opened', await waitText('Kitchen light', 6000) && page.url().includes('/device/'))
  await sleep(1200)
  await shot('new-device')
  await clickText('button', 'Back')
  await sleep(500)
  check('Back from the new device goes to the house', await page.evaluate(() => location.pathname === '/'))
  await openDevice('Kitchen light')

  // ---- 10. edit + delete it
  await clickText('button', 'Edit device')
  await sleep(500)
  await shot('edit')
  await clickText('button', 'Remove this device')
  await sleep(300)
  await clickText('.sheet button.danger', 'Remove')
  await sleep(1000)
  check('Device removed and back at the house', await page.evaluate(() => location.pathname === '/' && ![...document.querySelectorAll('.tile')].some((t) => t.innerText.includes('Kitchen light'))))

  // ---- 11. WiFi screen: add, edit, remove a network
  await page.goto(BASE + '/wifi', { waitUntil: 'networkidle2' })
  await sleep(500)
  await clickText('button', 'Add WiFi network')
  await sleep(300)
  await page.type('#w-ssid', 'Guest WiFi')
  await page.type('#w-pass', 'guest-pass-1')
  await clickText('.sheet button.primary', 'Save')
  check('WiFi network added', await waitText('Guest WiFi saved', 5000))
  await sleep(500)
  await shot('wifi')
  await clickText('button.row', 'Guest WiFi')
  await sleep(300)
  check('Stored password is masked, never sent back', await page.evaluate(() => document.querySelector('#w-pass').value === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'))
  await page.click('#w-pass') // just looking at the field
  await page.click('#w-notes')
  await page.type('#w-notes', 'for visitors')
  await clickText('.sheet button.primary', 'Save')
  await waitText('Guest WiFi saved', 5000)
  const kept = await page.evaluate(async () => {
    const t = localStorage.getItem('hc.token')
    const list = await (await fetch('/api/wifi', { headers: { Authorization: 'Bearer ' + t } })).json()
    const w = list.find((x) => x.ssid === 'Guest WiFi')
    return w ? { hasPassword: w.hasPassword, notes: w.notes } : null
  })
  check('Looking at a saved password does not erase it', kept && kept.hasPassword === true && kept.notes === 'for visitors', JSON.stringify(kept))
  await sleep(4000)
  await clickText('button.row', 'Guest WiFi')
  await sleep(300)
  await clickText('.sheet button', 'Remove this network')
  await sleep(200)
  check('Removing a network asks first', (await text()).includes('Remove Guest WiFi and its stored password?'))
  await clickText('.sheet button.danger', 'Yes, remove it')
  check('WiFi network removed', await waitText('Guest WiFi removed', 5000))

  // ---- 12. activity + settings
  await page.goto(BASE + '/activity', { waitUntil: 'networkidle2' })
  await sleep(800)
  check('Activity lists what happened', (await text()).includes('Main gate') && (await text()).includes('Gate camera'))
  await shot('activity')
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle2' })
  await sleep(800)
  check('Settings shows hub status', (await text()).includes('Version') && (await text()).includes('Live video'))
  await shot('settings')

  // ---- 13. sign out and back in
  await clickText('button.row', 'Sign out')
  check('Sign out returns to the PIN pad', await waitText('Enter the house PIN', 5000))
  for (const d of '0000') await clickText('.keypad button', d)
  await clickText('.keypad button', 'OK')
  check('Wrong PIN is refused', await waitText('Wrong PIN', 5000))
  await sleep(500)
  await pin()
  check('Right PIN signs in again', await waitText('devices', 8000))

  // ---- 14. clear the illustrative devices: the house is ready for the real ones
  await sleep(800)
  check('First-run note explains the illustrative devices', (await text()).includes('illustrative devices so you can try everything'))
  await shot('home-with-note')
  await clickText('button', 'Remove the illustrative ones')
  await sleep(300)
  await clickText('.sheet button.danger', 'Remove them')
  check('House is empty and offers to add a device', await waitText('Nothing here yet', 8000))
  const wifiLeft = await page.evaluate(async () => {
    const t = localStorage.getItem('hc.token')
    return (await (await fetch('/api/wifi', { headers: { Authorization: 'Bearer ' + t } })).json()).length
  })
  check('The pretend WiFi networks went with them', wifiLeft === 0, `${wifiLeft} left`)
  await sleep(500)
  await shot('home-empty')
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration()
    const m = await (await fetch('/manifest.webmanifest')).json()
    return { sw: Boolean(r?.active), name: m.name, icons: m.icons.length, display: m.display }
  })
  check('Installable: service worker active and manifest valid', reg.sw && reg.name === 'House Control' && reg.icons >= 2 && reg.display === 'standalone', JSON.stringify(reg))
} catch (err) {
  check('RUN COMPLETED', false, err.message)
  await shot('failure')
}

const real = errors.filter((e) => !/401|Failed to load resource/.test(e))
console.log('\nconsole errors:', real.length ? real.slice(0, 8) : 'none')
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${shots}`)
await browser.close()
tasmotaServer.close()
if (hub) {
  hub.kill()
  await new Promise((r) => setTimeout(r, 500))
  try {
    fs.rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* Windows may still hold the database for a moment; the temp folder is harmless */
  }
}
process.exit(failed.length || real.length ? 1 : 0)
