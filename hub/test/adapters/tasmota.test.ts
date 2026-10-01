import type http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import adapter, { resetTasmotaMemory } from '../../src/adapters/tasmota.ts'
import { makeAction, makeCtx, mockServer, send, type CtxOptions, type MockServer, type RecordedRequest } from '../helpers.ts'

// ---------------------------------------------------------------------------
// A mock Tasmota device. Replies use the shapes from docs/protocols:
// {"POWER":"ON"} / {"POWER1":"OFF"}, {"PulseTime1":{"Set":10,"Remaining":0}},
// Status 0 / 10 / 11 blocks, {"WifiScan":"Scanning"} and {"WiFiScan":{"NET1":…}},
// and HTTP 401 {"WARNING":"Need user=<username>&password=<password>"}.
// ---------------------------------------------------------------------------

interface Sim {
  /** WebPassword; undefined = the web page opens without a login. */
  password?: string
  /** Which login the firmware honours: current firmware takes either, old firmware only the query arguments. */
  accept: 'either' | 'query' | 'basic'
  /** 1 = answers "POWER"; more = "POWER1", "POWER2" … */
  relays: number
  power: boolean[]
  light: { dimmer: number; color: string; ct: number } | null
  pulseTime: number[]
  /** MAX_PULSETIMERS: PulseTime<n> is accepted up to this number whether or not relay n exists (32 today, 8 on old firmware). */
  pulseTimers: number
  /** Firmware before the 401 change answers a wrong login with HTTP 200 and the same WARNING body. */
  warns200: boolean
  /** SetOption17 1: colours are reported as "255,136,0" instead of "FF8800". */
  decimalColor: boolean
  /** False = the relay ignores its PulseTime and stays on. */
  honourPulse: boolean
  /** True = the relay cannot be switched off at all. */
  welded: boolean
  switches: Record<number, 'ON' | 'OFF'>
  wifi: { ap: 1 | 2; ssid: string; rssi: number; signal: number }
  oldFirmware: boolean
  scanPollsBeforeResult: number
  /** Commands that never get an answer. */
  hang: RegExp | null
  /** Decoded command text, in order. */
  commands: string[]
  /** The two saved WiFi networks, as SSId<n> / Password<n> left them. */
  slots: Array<{ ssid: string; password: string }>
  restarts: number
}

function sim(over: Partial<Sim> = {}): Sim {
  return {
    accept: 'either',
    relays: 1,
    power: [false, false, false, false],
    light: null,
    pulseTime: [0, 0, 0, 0],
    pulseTimers: 32,
    warns200: false,
    decimalColor: false,
    honourPulse: true,
    welded: false,
    switches: {},
    wifi: { ap: 1, ssid: 'HomeWiFi', rssi: 74, signal: -63 },
    oldFirmware: false,
    scanPollsBeforeResult: 1,
    hang: null,
    commands: [],
    slots: [
      { ssid: 'HomeWiFi', password: 'old-home-pass' },
      { ssid: '', password: '' },
    ],
    restarts: 0,
    ...over,
  }
}

const timers = new Set<NodeJS.Timeout>()

function powerKeys(s: Sim): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < s.relays; i++) out[s.relays === 1 ? 'POWER' : `POWER${i + 1}`] = s.power[i] ? 'ON' : 'OFF'
  return out
}

function lightKeys(s: Sim): Record<string, unknown> {
  if (!s.light) return {}
  return { Dimmer: s.light.dimmer, Color: s.light.color, HSBColor: '32,100,100', White: 0, CT: s.light.ct, Channel: [100, 53, 0, 0, 0], Scheme: 0, Fade: 'OFF', Speed: 1, LedTable: 'ON' }
}

function statusSts(s: Sim): Record<string, unknown> {
  return {
    Time: '2026-10-01T18:02:11',
    Uptime: '1T02:33:26',
    UptimeSec: 95606,
    Heap: 25,
    SleepMode: 'Dynamic',
    Sleep: 50,
    LoadAvg: 19,
    MqttCount: 0,
    ...powerKeys(s),
    ...lightKeys(s),
    Wifi: { AP: s.wifi.ap, SSId: s.wifi.ssid, BSSId: '34:31:C4:AA:BB:CC', Channel: 6, Mode: '11n', RSSI: s.wifi.rssi, Signal: s.wifi.signal, LinkCount: 1, Downtime: '0T00:00:03' },
  }
}

function statusSns(s: Sim): Record<string, unknown> {
  const out: Record<string, unknown> = { Time: '2026-10-01T18:02:11' }
  for (const [n, v] of Object.entries(s.switches)) out[`Switch${n}`] = v
  return out
}

function status0(s: Sim): Record<string, unknown> {
  return {
    Status: { Module: 1, DeviceName: 'Porch light', FriendlyName: ['Porch light'], Topic: 'tasmota_3D5E26', ButtonTopic: '0', Power: 0, PowerOnState: 3, LedState: 1, LedMask: 'FFFF', SaveData: 1, SaveState: 1, SwitchTopic: '0', SwitchMode: [0, 0, 0, 0, 0, 0, 0, 0], ButtonRetain: 0, SwitchRetain: 0, SensorRetain: 0, PowerRetain: 0 },
    StatusPRM: { Baudrate: 115200, SerialConfig: '8N1', GroupTopic: 'tasmotas', OtaUrl: 'http://ota.tasmota.com/tasmota/release/tasmota.bin.gz', RestartReason: 'Power On', Uptime: '1T02:33:26', StartupUTC: '2026-09-30T10:00:00', Sleep: 50, CfgHolder: 4617, BootCount: 32, SaveCount: 72, SaveAddress: 'F9000' },
    StatusFWR: { Version: '14.2.0(release-tasmota)', BuildDateTime: '2024-08-14T12:36:53', Boot: 31, Core: '2_7_7', SDK: '2.2.2-dev(38a443e)', CpuFrequency: 80, Hardware: 'ESP8266EX', CR: '378/699' },
    StatusLOG: { SerialLog: 2, WebLog: 2, MqttLog: 0, SysLog: 0, LogHost: '', LogPort: 514, SSId: ['HomeWiFi', 'Backup4G'], TelePeriod: 300, Resolution: '558180C0' },
    StatusMEM: { ProgramSize: 640, Free: 360, Heap: 25, ProgramFlashSize: 1024, FlashSize: 1024, FlashMode: 3 },
    StatusNET: { Hostname: 'tasmota-3D5E26-7718', IPAddress: '192.168.1.60', Gateway: '192.168.1.1', Subnetmask: '255.255.255.0', DNSServer1: '192.168.1.1', DNSServer2: '0.0.0.0', Mac: '2C:3A:E8:3D:5E:26', Webserver: 2, HTTP_API: 1, WifiConfig: 4, WifiPower: 17.0 },
    StatusTIM: { UTC: '2026-10-01T12:32:11', Local: '2026-10-01T18:02:11', StartDST: '1970-01-01T00:00:00', EndDST: '1970-01-01T00:00:00', Timezone: '+05:30' },
    StatusSNS: statusSns(s),
    StatusSTS: statusSts(s),
  }
}

/** The Status 0 sample from the Tasmota "JSON Status Responses" page (firmware 5.12), blanks filled in. */
const DOCS_STATUS_0 = {
  Status: { Module: 1, FriendlyName: 'Verandah', Topic: 'sonoff', ButtonTopic: '0', Power: 0, PowerOnState: 0, LedState: 1, SaveData: 0, SaveState: 1, ButtonRetain: 0, PowerRetain: 0 },
  StatusPRM: { Baudrate: 115200, GroupTopic: 'sonoffs', OtaUrl: 'http://domus1/api/arduino/sonoff.ino.bin', Uptime: '1 02:33:26', Sleep: 150, BootCount: 32, SaveCount: 72, SaveAddress: 'FB000' },
  StatusFWR: { Version: '5.12.0a', BuildDateTime: '2018.02.11 16:15:40', Boot: 31, Core: '2_4_0', SDK: '2.1.0(deb1901)' },
  StatusLOG: { SerialLog: 0, WebLog: 4, SysLog: 0, LogHost: 'domus1', LogPort: 514, SSId1: 'HomeWiFi', SSId2: 'Backup4G', TelePeriod: 300, SetOption: '00000001' },
  StatusMEM: { ProgramSize: 457, Free: 544, Heap: 23, ProgramFlashSize: 1024, FlashSize: 1024, FlashMode: 3 },
  StatusNET: { Hostname: 'verandah', IPAddress: '192.168.178.40', Gateway: '192.168.178.1', Subnetmask: '255.255.255.0', DNSServer: '192.168.178.1', Mac: '2C:3A:E8:11:22:33', Webserver: 2, WifiConfig: 4 },
  StatusTIM: { UTC: 'Thu Feb 15 00:00:50 2018', Local: 'Thu Feb 15 01:00:50 2018', StartDST: 'Sun Mar 25 02:00:00 2018', EndDST: 'Sun Oct 28 03:00:00 2018', Timezone: 1 },
  StatusSNS: { Time: '2018.02.15 01:00:50', Switch1: 'OFF' },
  StatusSTS: { Time: '2018.02.15 01:00:50', Uptime: '1 02:33:26', Vcc: 3.504, POWER: 'OFF', Wifi: { AP: 1, SSId: 'HomeWiFi', RSSI: 100, APMac: '34:31:C4:44:55:66' } },
}

const SCAN_RESULT = {
  WiFiScan: {
    NET1: { SSId: 'HomeWiFi', BSSId: '34:31:C4:AA:BB:CC', Channel: '6', Signal: '-31', RSSI: '100', Encryption: 'WPA2/PSK' },
    NET2: { SSId: 'Backup4G', BSSId: '50:C7:BF:11:22:33', Channel: '11', Signal: '-67', RSSI: '66', Encryption: 'WPA2/PSK' },
    NET3: { SSId: 'HomeWiFi', BSSId: '34:31:C4:AA:BB:CD', Channel: '1', Signal: '-80', RSSI: '40', Encryption: 'WPA2/PSK' },
    NET4: { SSId: 'JioFiber-3F2A', BSSId: 'A8:DA:0C:44:55:66', Channel: '3', Signal: '-85', RSSI: '30', Encryption: 'OPEN' },
  },
}

function run(s: Sim, cmnd: string): Record<string, unknown> {
  const m = /^([A-Za-z]+)(\d*)\s*(.*)$/.exec(cmnd.trim())
  if (!m) return { Command: 'Unknown' }
  const name = m[1]!.toLowerCase()
  const index = m[2] ? Number(m[2]) : 1
  const arg = m[3] ?? ''
  const powerKey = s.relays === 1 ? 'POWER' : `POWER${index}`
  switch (name) {
    case 'status':
      if (arg === '0') return status0(s)
      if (arg === '10') return { StatusSNS: statusSns(s) }
      if (arg === '11') return { StatusSTS: statusSts(s) }
      return { Command: 'Unknown' }
    case 'power': {
      if (index < 1 || index > s.relays) return { Command: 'Error' }
      const word = arg.toUpperCase()
      const was = s.power[index - 1]!
      if (word === 'ON') s.power[index - 1] = true
      else if (word === 'OFF') s.power[index - 1] = s.welded ? was : false
      else if (word === 'TOGGLE') s.power[index - 1] = !was
      const pulse = s.pulseTime[index - 1] ?? 0
      if (s.power[index - 1] && word !== '' && pulse > 0 && s.honourPulse) {
        const t = setTimeout(() => {
          s.power[index - 1] = false
        }, pulse <= 111 ? pulse * 100 : (pulse - 100) * 1000)
        timers.add(t)
      }
      return { [powerKey]: s.power[index - 1] ? 'ON' : 'OFF' }
    }
    case 'pulsetime': {
      // The firmware checks the number against MAX_PULSETIMERS, not against the relays fitted.
      if (index < 1 || index > s.pulseTimers) return { Command: 'Error' }
      if (arg !== '') s.pulseTime[index - 1] = Number(arg)
      const set = s.pulseTime[index - 1] ?? 0
      return { [`PulseTime${index}`]: { Set: set, Remaining: arg !== '' ? set : 0 } }
    }
    case 'dimmer': {
      if (!s.light) return { Command: 'Unknown' }
      s.light.dimmer = Number(arg)
      s.power[0] = s.light.dimmer > 0
      return { POWER: s.power[0] ? 'ON' : 'OFF', Dimmer: s.light.dimmer, Color: s.light.color, HSBColor: '32,100,40', Channel: [40, 21, 0] }
    }
    case 'color': {
      if (!s.light) return { Command: 'Unknown' }
      s.light.color = arg.replace('#', '')
      s.power[0] = true
      const shown = s.decimalColor ? (s.light.color.match(/../g) ?? []).map((h) => parseInt(h, 16)).join(',') : s.light.color
      return { POWER: 'ON', Dimmer: 100, Color: shown, HSBColor: '32,100,100', Channel: [100, 53, 0] }
    }
    case 'ct': {
      if (!s.light) return { Command: 'Unknown' }
      s.light.ct = Number(arg)
      s.power[0] = true
      return { POWER: 'ON', Dimmer: 100, Color: '0000008C73', HSBColor: '0,0,0', White: 100, CT: s.light.ct, Channel: [0, 0, 0, 55, 45] }
    }
    case 'restart':
      s.restarts += 1
      return { Restart: 'Restarting' }
    case 'ssid': {
      if (index < 1 || index > 2) return { Command: 'Error' }
      if (arg !== '') {
        s.slots[index - 1]!.ssid = arg
        s.wifi.ap = index as 1 | 2
      }
      return { [`SSId${index}`]: s.slots[index - 1]!.ssid }
    }
    case 'password': {
      if (index < 1 || index > 2) return { Command: 'Error' }
      // CmndPassword only stores a value longer than 4 characters.
      if (arg.length > 4) {
        s.slots[index - 1]!.password = arg
        s.wifi.ap = index as 1 | 2
      }
      return { [`Password${index}`]: s.slots[index - 1]!.password }
    }
    case 'wifiscan': {
      if (s.oldFirmware) return { Command: 'Unknown' }
      if (arg === '1') return { WifiScan: 'Scanning' }
      if (s.scanPollsBeforeResult > 0) {
        s.scanPollsBeforeResult -= 1
        return { WifiScan: 'Scanning' }
      }
      return SCAN_RESULT
    }
    case 'backlog': {
      // CmndBacklog: split on ";", except that a ";" stays inside its command while that command has
      // more "{" than "}" (or the reverse). Each command is trimmed. The reply is just {}.
      const count = (t: string, ch: string) => t.split(ch).length - 1
      const parts = arg.split(';')
      for (let i = 0; i < parts.length; i++) {
        let one = parts[i]!
        while (count(one, '{') !== count(one, '}') && i + 1 < parts.length) one += ';' + parts[++i]!
        if (one.trim()) run(s, one.trim())
      }
      return {}
    }
    default:
      return { Command: 'Unknown' }
  }
}

function tasmota(s: Sim) {
  return (req: RecordedRequest, res: http.ServerResponse): void => {
    if (req.path !== '/cm') return send(res, 404, 'Not Found')
    if (s.password) {
      const basic = req.headers.authorization === 'Basic ' + Buffer.from(`admin:${s.password}`).toString('base64')
      const query = req.query.get('user') === 'admin' && req.query.get('password') === s.password
      const ok = s.accept === 'query' ? query : s.accept === 'basic' ? basic : basic || query
      if (!ok) return send(res, s.warns200 ? 200 : 401, { WARNING: 'Need user=<username>&password=<password>' })
    }
    const cmnd = req.query.get('cmnd') ?? ''
    if (!cmnd) return send(res, 200, { WARNING: 'Enter command cmnd=' })
    s.commands.push(cmnd)
    if (s.hang?.test(cmnd)) return
    send(res, 200, run(s, cmnd))
  }
}

let server: MockServer | null = null

async function device(s: Sim): Promise<MockServer> {
  server = await mockServer(tasmota(s))
  return server
}

function ctxFor(srv: MockServer, opts: Partial<CtxOptions> = {}) {
  return makeCtx({ family: 'tasmota', kind: 'switch', ...opts, path: { port: srv.port, ...(opts.path ?? {}) } })
}

beforeEach(() => resetTasmotaMemory())

afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of timers) clearTimeout(t)
  timers.clear()
  await server?.close()
  server = null
})

// ---------------------------------------------------------------------------

describe('tasmota adapter: the add-device form', () => {
  it('describes itself in plain words', () => {
    const d = adapter.describe()
    expect(adapter.family).toBe('tasmota')
    expect(d.id).toBe('tasmota')
    expect(d.kinds).toEqual(['light', 'switch', 'gate'])
    expect(d.pathKinds).toEqual(['lan'])
    expect(d.defaultPort).toBe(80)
    const field = (name: string) => d.fields.find((f) => f.name === name)
    expect(field('password')?.secret).toBe(true)
    expect(field('password')?.required).toBeFalsy()
    expect(field('username')?.required).toBeFalsy()
    expect(field('relay')?.default).toBe(1)
    expect(field('pulseMs')?.default).toBe(800)
    expect(field('use')?.options?.map((o) => o.value)).toEqual(['switch', 'gate'])
    expect(field('gateMode')?.options?.map((o) => o.label)).toEqual(['One button (each press steps open → stop → close)', 'Separate open / close / stop relays'])
    // Gate settings appear only for a gate, light settings only for a light or switch.
    for (const name of ['gateMode', 'pulseMs', 'stateInput', 'stateOnMeans', 'travelSeconds']) expect(field(name)?.showWhen).toEqual({ field: 'use', equals: 'gate' })
    for (const name of ['openRelay', 'closeRelay', 'stopRelay']) expect(field(name)?.showWhen).toEqual({ field: 'gateMode', equals: 'separate' })
    for (const name of ['dimmer', 'color']) expect(field(name)?.showWhen).toEqual({ field: 'use', equals: 'switch' })
    expect(d.notes.length).toBeGreaterThan(3)
    const shown = [d.label, d.tagline, ...d.notes, ...d.fields.flatMap((f) => [f.label, f.help ?? '', ...(f.options ?? []).map((o) => o.label)])].join('\n')
    expect(shown).not.toMatch(/\b(demo|prototype|placeholder|stub|todo)\b/i)
  })

  it('works out what the device can do from its settings', () => {
    expect(adapter.capabilities({}, 'switch')).toEqual(['power', 'wifi', 'wifi-scan', 'reboot', 'state'])
    expect(adapter.capabilities({ dimmer: true }, 'light')).toEqual(['power', 'dim', 'wifi', 'wifi-scan', 'reboot', 'state'])
    expect(adapter.capabilities({ dimmer: 'true', color: true }, 'light')).toEqual(['power', 'dim', 'color', 'wifi', 'wifi-scan', 'reboot', 'state'])
    // A gate never gets on / off, and knows open / closed only with a door sensor.
    expect(adapter.capabilities({}, 'gate')).toEqual(['gate', 'wifi', 'wifi-scan', 'reboot', 'state'])
    expect(adapter.capabilities({ use: 'gate', dimmer: true }, 'switch')).toEqual(['gate', 'wifi', 'wifi-scan', 'reboot', 'state'])
    expect(adapter.capabilities({ use: 'gate', stateInput: 1 }, 'gate')).toEqual(['gate', 'gate-state', 'wifi', 'wifi-scan', 'reboot', 'state'])
    expect(adapter.capabilities({ use: 'gate', stateInput: '0' }, 'gate')).not.toContain('gate-state')
    for (const c of adapter.capabilities({ use: 'gate', stateInput: 1 }, 'gate')) expect(adapter.describe().capabilities).toContain(c)
  })
})

describe('tasmota adapter: checking the connection', () => {
  it('probes with Status 0 and reports who the device is', async () => {
    const s = sim({ power: [true] })
    const srv = await device(s)
    const res = await adapter.probe(ctxFor(srv))
    expect(res.ok).toBe(true)
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)
    expect(res.info).toMatchObject({
      name: 'Porch light',
      model: 'Tasmota (ESP8266EX)',
      firmware: '14.2.0(release-tasmota)',
      mac: '2C:3A:E8:3D:5E:26',
      hostname: 'tasmota-3D5E26-7718',
      ip: '192.168.1.60',
      wifi: 'HomeWiFi',
      signal: 74,
      power: true,
    })
    expect(srv.requests).toHaveLength(1)
    const req = srv.requests[0]!
    expect(req.method).toBe('GET')
    expect(req.url).toBe('/cm?cmnd=Status%200')
    // Tasmota's referer check wants API calls to come "from" its own address.
    expect(req.headers.referer).toBe(`http://127.0.0.1:${srv.port}/`)
    expect(req.headers.authorization).toBeUndefined()
  })

  it('reads the Status 0 shape of old firmware too', async () => {
    server = await mockServer((_req, res) => send(res, 200, DOCS_STATUS_0))
    const res = await adapter.probe(ctxFor(server))
    expect(res.ok).toBe(true)
    expect(res.info).toMatchObject({ name: 'Verandah', model: 'Tasmota', firmware: '5.12.0a', mac: '2C:3A:E8:11:22:33', wifi: 'HomeWiFi', signal: 100, power: false })
  })

  it('says so when the password is wrong, without repeating it', async () => {
    const srv = await device(sim({ password: 'gate-s3cret' }))
    const res = await adapter.probe(ctxFor(srv, { config: { password: 'not-the-one' } }))
    expect(res).toEqual({ ok: false, latencyMs: null, error: 'Wrong username or password' })
    expect(JSON.stringify(res)).not.toContain('not-the-one')
    const none = await adapter.probe(ctxFor(srv))
    expect(none.ok).toBe(false)
    expect(none.error).toMatch(/asks for a password/)
  })

  it('recognises a wrong password on older firmware, which answers HTTP 200 with the same warning', async () => {
    const srv = await device(sim({ password: 'gate-s3cret', warns200: true }))
    const res = await adapter.probe(ctxFor(srv, { config: { password: 'not-the-one' } }))
    expect(res).toEqual({ ok: false, latencyMs: null, error: 'Wrong username or password' })
    const act = await adapter.execute(ctxFor(srv, { config: { password: 'not-the-one' } }), makeAction('power.on'))
    expect(act).toEqual({ ok: false, error: 'Wrong username or password' })
    await srv.close()
    // {"WARNING":"Enter command cmnd="} is a refusal too, never a success.
    server = await mockServer((_req, res2) => send(res2, 200, { WARNING: 'Enter command cmnd=' }))
    const empty = await adapter.execute(ctxFor(server), makeAction('power.on'))
    expect(empty).toEqual({ ok: false, error: 'The device did not accept the command' })
  })

  it('logs in both ways Tasmota accepts: Basic header and user / password arguments', async () => {
    const config = { password: 'p@ss w+rd&1' }
    for (const accept of ['query', 'basic'] as const) {
      const srv = await device(sim({ password: 'p@ss w+rd&1', accept }))
      const res = await adapter.probe(ctxFor(srv, { config }))
      expect(res.ok).toBe(true)
      const req = srv.requests[0]!
      expect(req.url).toBe('/cm?user=admin&password=p%40ss%20w%2Brd%261&cmnd=Status%200')
      expect(req.headers.authorization).toBe('Basic ' + Buffer.from('admin:p@ss w+rd&1').toString('base64'))
      await srv.close()
      server = null
    }
  })

  it('reports an unreachable device in a plain sentence', async () => {
    const srv = await device(sim())
    const port = srv.port
    await srv.close()
    server = null
    const down = await adapter.probe(makeCtx({ family: 'tasmota', kind: 'switch', path: { port } }))
    expect(down.ok).toBe(false)
    expect(down.latencyMs).toBeNull()
    expect(down.error).toMatch(/refused the connection/)

    const silent = await device(sim({ password: 'gate-s3cret', hang: /^Status/ }))
    const slow = await adapter.probe(ctxFor(silent, { config: { password: 'gate-s3cret' }, timeoutMs: 300 }))
    expect(slow.ok).toBe(false)
    expect(slow.error).toBe('127.0.0.1 did not answer in time. It may be switched off or on another WiFi network.')
    expect(JSON.stringify(slow)).not.toContain('gate-s3cret')

    const noHost = await adapter.probe(makeCtx({ family: 'tasmota', kind: 'switch', path: { host: '' } }))
    expect(noHost.ok).toBe(false)
    expect(noHost.error).toMatch(/No address set/)

    // A mistyped address: a plain sentence, and an error object that does not carry the URL (it holds the password).
    const typo = makeCtx({ family: 'tasmota', kind: 'switch', config: { password: 'gate-s3cret' }, path: { host: 'porch light' } })
    const bad = await adapter.probe(typo)
    expect(bad).toEqual({ ok: false, latencyMs: null, error: 'The address on the "Home WiFi" connection is not usable. Enter just the device\'s IP address, for example 192.168.1.60.' })
    const thrown = await adapter.execute(typo, makeAction('power.on')).then(
      () => null,
      (err: Error) => err,
    )
    expect(thrown).toBeInstanceOf(Error)
    expect(JSON.stringify({ ...thrown, message: thrown!.message })).not.toContain('gate-s3cret')
  })

  it('does not mistake another web server for a Tasmota device', async () => {
    server = await mockServer((_req, res) => send(res, 200, '<html><body>Router login</body></html>', 'text/html'))
    const html = await adapter.probe(ctxFor(server))
    expect(html.ok).toBe(false)
    expect(html.error).toMatch(/not the way a Tasmota device does/)
    await server.close()
    server = await mockServer((_req, res) => send(res, 200, { hello: 'world' }))
    const json = await adapter.probe(ctxFor(server))
    expect(json.ok).toBe(false)
    expect(json.error).toMatch(/not a Tasmota device/)
  })
})

describe('tasmota adapter: lights and switches', () => {
  it('turns a single switch on, off and over', async () => {
    const s = sim()
    const srv = await device(s)
    const ctx = ctxFor(srv)
    expect(await adapter.execute(ctx, makeAction('power.on'))).toEqual({ ok: true, state: { power: true } })
    expect(await adapter.execute(ctx, makeAction('power.off'))).toEqual({ ok: true, state: { power: false } })
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toEqual({ ok: true, state: { power: true } })
    expect(srv.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /cm?cmnd=Power1%20ON', 'GET /cm?cmnd=Power1%20OFF', 'GET /cm?cmnd=Power1%20TOGGLE'])
    expect(s.power[0]).toBe(true)
  })

  it('uses the configured relay on a multi-relay board', async () => {
    const s = sim({ relays: 4, power: [true, false, false, false] })
    const srv = await device(s)
    const ctx = ctxFor(srv, { config: { relay: 3 } })
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toEqual({ ok: true, state: { power: true } })
    expect(srv.requests[0]!.url).toBe('/cm?cmnd=Power3%20TOGGLE')
    expect(s.power).toEqual([true, false, true, false])
    expect(await adapter.readState!(ctx)).toMatchObject({ power: true })
    // A relay the board does not have: {"Command":"Error"}.
    const missing = await adapter.execute(ctxFor(srv, { config: { relay: 7 } }), makeAction('power.on'))
    expect(missing).toEqual({ ok: false, error: 'The device has no relay number 7' })
  })

  it('reads power, brightness, WiFi and signal with Status 11', async () => {
    const s = sim({ power: [true], light: { dimmer: 55, color: 'FF8800', ct: 300 } })
    const srv = await device(s)
    const plain = await adapter.readState!(ctxFor(srv))
    expect(plain).toEqual({ power: true, wifi: 'HomeWiFi', signal: 74 })
    const dimmer = await adapter.readState!(ctxFor(srv, { kind: 'light', config: { dimmer: true, color: true } }))
    expect(dimmer).toEqual({ power: true, brightness: 55, color: '#FF8800', temperature: 3333, wifi: 'HomeWiFi', signal: 74 })
    expect(srv.requests.map((r) => r.url)).toEqual(['/cm?cmnd=Status%2011', '/cm?cmnd=Status%2011'])
  })

  it('sets the brightness with Dimmer', async () => {
    const s = sim({ light: { dimmer: 100, color: 'FF8800', ct: 300 } })
    const srv = await device(s)
    const ctx = ctxFor(srv, { kind: 'light', config: { dimmer: true } })
    expect(await adapter.execute(ctx, makeAction('dim.set', { brightness: 40 }))).toEqual({ ok: true, state: { brightness: 40, power: true } })
    expect(await adapter.execute(ctx, makeAction('dim.set', { brightness: 250 }))).toEqual({ ok: true, state: { brightness: 100, power: true } })
    expect(await adapter.execute(ctx, makeAction('dim.set', { brightness: 0 }))).toEqual({ ok: true, state: { brightness: 0, power: false } })
    expect(srv.requests.map((r) => r.url)).toEqual(['/cm?cmnd=Dimmer%2040', '/cm?cmnd=Dimmer%20100', '/cm?cmnd=Dimmer%200'])
    const none = await adapter.execute(ctx, makeAction('dim.set', {}))
    expect(none.ok).toBe(false)
  })

  it('refuses dimming when the toggle is off, and explains a device that cannot dim', async () => {
    const srv = await device(sim())
    const off = await adapter.execute(ctxFor(srv), makeAction('dim.set', { brightness: 40 }))
    expect(off.ok).toBe(false)
    expect(srv.requests).toHaveLength(0)
    const plainRelay = await adapter.execute(ctxFor(srv, { config: { dimmer: true } }), makeAction('dim.set', { brightness: 40 }))
    expect(plainRelay.ok).toBe(false)
    expect(plainRelay.error).toMatch(/does not dim/)
  })

  it('sets colour by hex and by temperature', async () => {
    const s = sim({ light: { dimmer: 100, color: '000000', ct: 300 } })
    const srv = await device(s)
    const ctx = ctxFor(srv, { kind: 'light', config: { dimmer: true, color: true } })
    expect(await adapter.execute(ctx, makeAction('color.set', { hex: '#ff8800' }))).toEqual({ ok: true, state: { color: '#FF8800', power: true, brightness: 100 } })
    // 4000 K = 250 mired; 10000 K is cooler than the lamp goes, so it is held at 153.
    expect(await adapter.execute(ctx, makeAction('color.set', { temperature: 4000 }))).toEqual({ ok: true, state: { temperature: 4000, power: true, brightness: 100 } })
    await adapter.execute(ctx, makeAction('color.set', { temperature: 10000 }))
    expect(srv.requests.map((r) => r.url)).toEqual(['/cm?cmnd=Color%20%23FF8800', '/cm?cmnd=CT%20250', '/cm?cmnd=CT%20153'])
    expect((await adapter.execute(ctx, makeAction('color.set', { hex: 'reddish' }))).ok).toBe(false)
    expect((await adapter.execute(ctx, makeAction('color.set', {}))).ok).toBe(false)
    expect(srv.requests).toHaveLength(3)
    // Colour toggle off: not offered at all.
    expect((await adapter.execute(ctxFor(srv, { config: { dimmer: true } }), makeAction('color.set', { hex: '#ff8800' }))).ok).toBe(false)
    expect(srv.requests).toHaveLength(3)
  })

  it('restarts with Restart 1', async () => {
    const srv = await device(sim())
    expect(await adapter.execute(ctxFor(srv), makeAction('reboot'))).toEqual({ ok: true, result: { restarting: true } })
    expect(srv.requests[0]!.url).toBe('/cm?cmnd=Restart%201')
  })

  it('returns a refusal for a wrong password and throws when the device is gone', async () => {
    const srv = await device(sim({ password: 'gate-s3cret' }))
    const refused = await adapter.execute(ctxFor(srv, { config: { password: 'wrong-one' } }), makeAction('power.on'))
    expect(refused).toEqual({ ok: false, error: 'Wrong username or password' })
    const port = srv.port
    await srv.close()
    server = null
    const gone = makeCtx({ family: 'tasmota', kind: 'switch', config: { password: 'gate-s3cret' }, path: { port } })
    const failure = await adapter.execute(gone, makeAction('power.on')).then(
      () => null,
      (err: Error) => err,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure!.message).toMatch(/refused the connection/)
    expect(failure!.message).not.toContain('gate-s3cret')
    await expect(adapter.readState!(gone)).rejects.toThrow(/refused the connection/)
  })

  it('fails in plain words when the device answers rubbish, hangs up, or is too slow', async () => {
    const config = { password: 'gate-s3cret' }
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (err: Error) => err,
      )

    server = await mockServer((_req, res) => send(res, 200, '<html><body>Router login</body></html>', 'text/html'))
    const html = await failure(adapter.execute(ctxFor(server, { config }), makeAction('power.on')))
    expect(html?.message).toMatch(/not the way a Tasmota device does/)
    await expect(adapter.readState!(ctxFor(server, { config }))).rejects.toThrow(/not the way a Tasmota device does/)
    await server.close()

    server = await mockServer((_req, res) => send(res, 500, 'Internal Server Error'))
    const broken = await failure(adapter.execute(ctxFor(server, { config }), makeAction('power.on')))
    expect(broken?.message).toMatch(/answered with an error \(HTTP 500\)/)
    await server.close()

    server = await mockServer((_req, _res, raw) => {
      raw.socket.destroy()
    })
    const hungUp = await failure(adapter.execute(ctxFor(server, { config }), makeAction('power.on')))
    expect(hungUp?.message).toMatch(/closed the connection/)
    await server.close()

    const silent = await device(sim({ password: 'gate-s3cret', hang: /^Power/ }))
    const started = Date.now()
    const slow = await failure(adapter.execute(ctxFor(silent, { config, timeoutMs: 300 }), makeAction('power.on')))
    expect(slow?.message).toBe('127.0.0.1 did not answer in time. It may be switched off or on another WiFi network.')
    expect(Date.now() - started).toBeLessThan(1500)
    for (const err of [html, broken, hungUp, slow]) expect(err?.message).not.toContain('gate-s3cret')
  })

  it('reads a colour the device reports as decimal numbers', async () => {
    const s = sim({ light: { dimmer: 100, color: '000000', ct: 300 }, decimalColor: true })
    const srv = await device(s)
    const ctx = ctxFor(srv, { kind: 'light', config: { color: true } })
    expect(await adapter.execute(ctx, makeAction('color.set', { hex: '#ff8800' }))).toEqual({ ok: true, state: { color: '#FF8800', power: true } })
  })

  it('refuses what a switch cannot do', async () => {
    const srv = await device(sim())
    const ctx = ctxFor(srv)
    for (const type of ['gate.open', 'gate.pulse', 'ptz.move', 'ptz.preset', 'sms.send', 'custom'] as const) {
      const res = await adapter.execute(ctx, makeAction(type))
      expect(res.ok).toBe(false)
      expect(res.error).toContain(type)
    }
    expect(srv.requests).toHaveLength(0)
    expect(adapter.snapshot).toBeUndefined()
    expect(adapter.streamSources).toBeUndefined()
  })
})

describe('tasmota adapter: gate and garage door', () => {
  const gate = (srv: MockServer, config: Record<string, unknown> = {}, extra: Partial<CtxOptions> = {}) =>
    ctxFor(srv, { kind: 'gate', config: { use: 'gate', pulseMs: 100, ...config }, ...extra })

  it('presses the one button: PulseTime, Power ON, then checks the relay let go', async () => {
    const s = sim()
    const srv = await device(s)
    const res = await adapter.execute(gate(srv), makeAction('gate.open'))
    expect(res).toEqual({ ok: true, result: { relay: 1, pressMs: 100, released: true } })
    expect(srv.requests.map((r) => r.url)).toEqual(['/cm?cmnd=PulseTime1%201', '/cm?cmnd=Power1%20ON', '/cm?cmnd=Power1'])
    expect(s.pulseTime[0]).toBe(1)
    expect(s.power[0]).toBe(false)
    // No door sensor: every tap is one press, and the hub claims no position.
    for (const type of ['gate.close', 'gate.stop', 'gate.pulse'] as const) {
      const again = await adapter.execute(gate(srv), makeAction(type))
      expect(again.ok).toBe(true)
      expect(again.state).toBeUndefined()
    }
    expect(s.commands.filter((c) => c === 'Power1 ON')).toHaveLength(4)
    expect(await adapter.readState!(gate(srv))).toEqual({ gate: 'unknown', wifi: 'HomeWiFi', signal: 74 })
  })

  it('uses the default 0.8 s press and the seconds form of PulseTime for long presses', async () => {
    const s = sim()
    const srv = await device(s)
    const res = await adapter.execute(ctxFor(srv, { kind: 'gate', config: {} }), makeAction('gate.pulse'))
    expect(res).toEqual({ ok: true, result: { relay: 1, pressMs: 800, released: true } })
    expect(srv.requests[0]!.url).toBe('/cm?cmnd=PulseTime1%208')
    // 15 s is beyond the 0.1 s range (1..111), so it is sent as seconds + 100. Too long to wait for here.
    const long = await adapter.execute(gate(srv, { pulseMs: 15000 }), makeAction('gate.pulse'))
    expect(long.ok).toBe(true)
    expect(long.result).toMatchObject({ relay: 1, pressMs: 15000, released: false })
    expect(s.commands).toContain('PulseTime1 115')
  })

  it('never leaves a gate relay switched on or off like a light', async () => {
    const srv = await device(sim())
    for (const type of ['power.on', 'power.off', 'power.toggle', 'dim.set', 'color.set'] as const) {
      const res = await adapter.execute(gate(srv, { dimmer: true, color: true }), makeAction(type, { brightness: 50, hex: '#ffffff' }))
      expect(res.ok).toBe(false)
    }
    // Added as a gate, it is a gate even if the "use" select was left alone.
    const kindOnly = await adapter.execute(ctxFor(srv, { kind: 'gate', config: { use: 'switch' } }), makeAction('power.on'))
    expect(kindOnly.ok).toBe(false)
    expect(srv.requests).toHaveLength(0)
  })

  it('maps open / close / stop to separate relays', async () => {
    const s = sim({ relays: 4 })
    const srv = await device(s)
    const config = { gateMode: 'separate', openRelay: 2, closeRelay: 3, stopRelay: 4 }
    expect(await adapter.execute(gate(srv, config), makeAction('gate.open'))).toEqual({ ok: true, result: { relay: 2, pressMs: 100, released: true } })
    expect(await adapter.execute(gate(srv, config), makeAction('gate.close'))).toMatchObject({ ok: true, result: { relay: 3 } })
    expect(await adapter.execute(gate(srv, config), makeAction('gate.stop'))).toMatchObject({ ok: true, result: { relay: 4 } })
    expect(srv.requests.map((r) => r.url)).toEqual([
      '/cm?cmnd=PulseTime2%201',
      '/cm?cmnd=Power2%20ON',
      '/cm?cmnd=Power2',
      '/cm?cmnd=PulseTime3%201',
      '/cm?cmnd=Power3%20ON',
      '/cm?cmnd=Power3',
      '/cm?cmnd=PulseTime4%201',
      '/cm?cmnd=Power4%20ON',
      '/cm?cmnd=Power4',
    ])
    expect(s.power).toEqual([false, false, false, false])
    const before = srv.requests.length
    const step = await adapter.execute(gate(srv, config), makeAction('gate.pulse'))
    expect(step.ok).toBe(false)
    expect(step.error).toMatch(/separate open, close and stop buttons/)
    const noStop = await adapter.execute(gate(srv, { gateMode: 'separate' }), makeAction('gate.stop'))
    expect(noStop).toEqual({ ok: false, error: 'No stop relay is set for this gate' })
    expect(srv.requests).toHaveLength(before)
  })

  it('reads open / closed from the door sensor and follows the gate while it moves', async () => {
    const s = sim({ switches: { 1: 'ON' } })
    const srv = await device(s)
    const ctx = gate(srv, { stateInput: 1, travelSeconds: 20 })
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'closed', wifi: 'HomeWiFi', signal: 74 })
    expect(srv.requests[0]!.url).toBe('/cm?cmnd=Status%200')
    expect((await adapter.probe(ctx)).info).toMatchObject({ gate: 'closed', mac: '2C:3A:E8:3D:5E:26' })

    // Open from closed: one press, and the tile says "opening" until the travel time has passed.
    const opened = await adapter.execute(ctx, makeAction('gate.open'))
    expect(opened).toEqual({ ok: true, result: { relay: 1, pressMs: 100, released: true }, state: { gate: 'opening' } })
    expect(s.commands.slice(-4)).toEqual(['Status 10', 'PulseTime1 1', 'Power1 ON', 'Power1'])
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'opening' })
    s.switches[1] = 'OFF'
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'opening' })
    const real = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 60_000)
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'open' })

    // Close from open: "closing" until the sensor says closed.
    const closed = await adapter.execute(ctx, makeAction('gate.close'))
    expect(closed).toMatchObject({ ok: true, state: { gate: 'closing' } })
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'closing' })
    s.switches[1] = 'ON'
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'closed' })
  })

  it('with one button and a sensor, never presses when that would do the opposite', async () => {
    const s = sim({ switches: { 1: 'ON' } })
    const srv = await device(s)
    const ctx = gate(srv, { stateInput: 1 })
    const presses = () => s.commands.filter((c) => c === 'Power1 ON').length

    // Closed: Close and Stop must not open it.
    const close = await adapter.execute(ctx, makeAction('gate.close'))
    expect(close).toMatchObject({ ok: true, result: { alreadyThere: true }, state: { gate: 'closed' } })
    const stop = await adapter.execute(ctx, makeAction('gate.stop'))
    expect(stop).toMatchObject({ ok: true, result: { alreadyThere: true }, state: { gate: 'closed' } })
    expect(srv.requests.map((r) => r.url)).toEqual(['/cm?cmnd=Status%2010', '/cm?cmnd=Status%2010'])
    expect(presses()).toBe(0)

    // Open (sensor not closed): Open must not close it; Close presses.
    s.switches[1] = 'OFF'
    const open = await adapter.execute(ctx, makeAction('gate.open'))
    expect(open).toMatchObject({ ok: true, result: { alreadyThere: true }, state: { gate: 'open' } })
    expect(presses()).toBe(0)
    expect(await adapter.execute(ctx, makeAction('gate.close'))).toMatchObject({ ok: true, state: { gate: 'closing' } })
    expect(presses()).toBe(1)

    // While it is closing, Close again is ignored, and Open is one press that stops it.
    expect(await adapter.execute(ctx, makeAction('gate.close'))).toMatchObject({ ok: true, result: { alreadyThere: true }, state: { gate: 'closing' } })
    expect(presses()).toBe(1)
    const reverse = await adapter.execute(ctx, makeAction('gate.open'))
    expect(reverse).toMatchObject({ ok: true, state: { gate: 'stopped' } })
    expect(String(reverse.result?.note)).toMatch(/one press stops it/)
    expect(presses()).toBe(2)
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'stopped' })
    // Stopped part-way: Open presses again.
    expect(await adapter.execute(ctx, makeAction('gate.open'))).toMatchObject({ ok: true, state: { gate: 'opening' } })
    expect(presses()).toBe(3)
  })

  it('steps with gate.pulse and honours a sensor that reads ON when open', async () => {
    const s = sim({ switches: { 2: 'OFF' } })
    const srv = await device(s)
    const ctx = gate(srv, { stateInput: 2, stateOnMeans: 'open' })
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'closed' })
    expect(await adapter.execute(ctx, makeAction('gate.pulse'))).toMatchObject({ ok: true, state: { gate: 'opening' } })
    s.switches[2] = 'ON'
    const real = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 60_000)
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'open' })
    expect(await adapter.execute(ctx, makeAction('gate.pulse'))).toMatchObject({ ok: true, state: { gate: 'closing' } })
    // A sensor number the device does not report: position unknown, never guessed.
    expect(await adapter.readState!(gate(srv, { stateInput: 5 }))).toMatchObject({ gate: 'unknown' })
  })

  it('does not press when the device will not time the press', async () => {
    // Old firmware has 8 press timers; relay 9 cannot be timed, so it must not be switched on at all.
    const s = sim({ relays: 16, pulseTimers: 8, power: new Array<boolean>(16).fill(false) })
    const srv = await device(s)
    const res = await adapter.execute(gate(srv, { relay: 9 }), makeAction('gate.open'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not accept the press length for relay 9/)
    expect(srv.requests.map((r) => r.url)).toEqual(['/cm?cmnd=PulseTime9%201'])
    expect(s.commands).not.toContain('Power9 ON')
    expect(s.power.some(Boolean)).toBe(false)
  })

  it('says so when the board has no such relay (PulseTime is accepted, the relay is not)', async () => {
    const s = sim({ relays: 1 })
    const srv = await device(s)
    const res = await adapter.execute(gate(srv, { relay: 3 }), makeAction('gate.open'))
    expect(res).toEqual({ ok: false, error: 'The device has no relay number 3' })
    expect(srv.requests.map((r) => r.url)).toEqual(['/cm?cmnd=PulseTime3%201', '/cm?cmnd=Power3%20ON'])
    expect(s.power.some(Boolean)).toBe(false)
  })

  it('treats Stop on a one-button gate with care: no second press, and an honest note', async () => {
    const s = sim({ switches: { 1: 'OFF' } })
    const srv = await device(s)
    const ctx = gate(srv, { stateInput: 1, travelSeconds: 20 })
    const presses = () => s.commands.filter((c) => c === 'Power1 ON').length

    // Standing open as far as the hub knows. It may be moving by remote, so Stop presses, and says what that may mean.
    const first = await adapter.execute(ctx, makeAction('gate.stop'))
    expect(first).toMatchObject({ ok: true, state: { gate: 'stopped' } })
    expect(String(first.result?.note)).toMatch(/If it was standing still, this press has set it moving/)
    expect(presses()).toBe(1)

    // A double tap must not press again: that would set the gate moving.
    const second = await adapter.execute(ctx, makeAction('gate.stop'))
    expect(second).toMatchObject({ ok: true, result: { alreadyThere: true }, state: { gate: 'stopped' } })
    expect(String(second.result?.note)).toMatch(/not pressed again/)
    expect(presses()).toBe(1)

    // Close, stop it on the way, then Close again: the hub warns that the gate may turn round.
    expect(await adapter.execute(ctx, makeAction('gate.close'))).toMatchObject({ ok: true, state: { gate: 'closing' } })
    expect(await adapter.execute(ctx, makeAction('gate.stop'))).toMatchObject({ ok: true, state: { gate: 'stopped' } })
    expect(presses()).toBe(3)
    const carryOn = await adapter.execute(ctx, makeAction('gate.close'))
    expect(carryOn).toMatchObject({ ok: true, state: { gate: 'closing' } })
    expect(String(carryOn.result?.note)).toMatch(/stopped while closing.*turns it round/)
    expect(presses()).toBe(4)

    // Long after a stop the hub no longer trusts its memory, so Stop presses again.
    await adapter.execute(ctx, makeAction('gate.stop'))
    expect(presses()).toBe(5)
    const real = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 60_000)
    const later = await adapter.execute(ctx, makeAction('gate.stop'))
    expect(later.result?.alreadyThere).toBeUndefined()
    expect(presses()).toBe(6)
  })

  it('switches the relay off itself if it did not let go, and says so when it cannot', async () => {
    const s = sim({ honourPulse: false })
    const srv = await device(s)
    const res = await adapter.execute(gate(srv), makeAction('gate.pulse'))
    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ relay: 1, released: true })
    expect(String(res.result?.note)).toMatch(/hub switched it off/)
    expect(srv.requests.map((r) => r.url)).toEqual(['/cm?cmnd=PulseTime1%201', '/cm?cmnd=Power1%20ON', '/cm?cmnd=Power1', '/cm?cmnd=Power1%20OFF'])
    expect(s.power[0]).toBe(false)

    s.welded = true
    const stuck = await adapter.execute(gate(srv), makeAction('gate.pulse'))
    expect(stuck.ok).toBe(false)
    expect(stuck.error).toMatch(/relay 1 is still on/)
  })

  it('asks the owner to confirm, instead of pressing twice, when the press got no answer', async () => {
    const s = sim({ hang: /^Power1 ON$/ })
    const srv = await device(s)
    const res = await adapter.execute(gate(srv, {}, { timeoutMs: 700 }), makeAction('gate.open'))
    expect(res.ok).toBe(true)
    expect(res.needsConfirmation).toBe(true)
    expect(String(res.result?.note)).toMatch(/cannot tell whether the gate button was pressed/)
    expect(s.commands).toEqual(['PulseTime1 1', 'Power1 ON'])
  })

  it('throws before anything is pressed when the device is gone, so the hub can try another connection', async () => {
    const srv = await device(sim())
    const port = srv.port
    await srv.close()
    server = null
    const ctx = makeCtx({ family: 'tasmota', kind: 'gate', config: { use: 'gate' }, path: { port } })
    await expect(adapter.execute(ctx, makeAction('gate.open'))).rejects.toThrow(/refused the connection/)
  })
})

describe('tasmota adapter: WiFi', () => {
  it('saves the new network in the spare slot with one Backlog and restarts', async () => {
    const s = sim({ wifi: { ap: 1, ssid: 'HomeWiFi', rssi: 74, signal: -63 } })
    const srv = await device(s)
    const res = await adapter.setWifi!(ctxFor(srv), { ssid: 'Backup4G', password: 'route66pass' })
    expect(res).toEqual({ ok: true, result: { ssid: 'Backup4G', slot: 2, restarting: true, fallback: 'HomeWiFi' } })
    expect(srv.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /cm?cmnd=Status%2011',
      'GET /cm?cmnd=Backlog%20SSID2%20Backup4G%3B%20Password2%20route66pass%3B%20Restart%201',
    ])
    // What the device ends up with: the new network in slot 2 and tried first, the old one untouched.
    expect(s.slots).toEqual([
      { ssid: 'HomeWiFi', password: 'old-home-pass' },
      { ssid: 'Backup4G', password: 'route66pass' },
    ])
    expect(s.wifi.ap).toBe(2)
    expect(s.restarts).toBe(1)
    expect(JSON.stringify(res)).not.toContain('route66pass')
  })

  it('writes slot 1 when the device is running from slot 2', async () => {
    const s = sim({ wifi: { ap: 2, ssid: 'Backup4G', rssi: 60, signal: -70 } })
    const srv = await device(s)
    const res = await adapter.setWifi!(ctxFor(srv), { ssid: 'HomeWiFi', password: 'welcome-home-1' })
    expect(res.result).toMatchObject({ slot: 1, fallback: 'Backup4G' })
    expect(s.commands[1]).toBe('Backlog SSID1 HomeWiFi; Password1 welcome-home-1; Restart 1')
  })

  it('percent-encodes names and passwords, including the login', async () => {
    const s = sim({ password: 'adm&in pw' })
    const srv = await device(s)
    const res = await adapter.setWifi!(ctxFor(srv, { config: { password: 'adm&in pw' } }), { ssid: 'Jio Fiber 4G', password: 'p@ss+w&rd#1%' })
    expect(res.ok).toBe(true)
    expect(String(res.result?.note)).toMatch(/advises against spaces and special characters/)
    expect(srv.requests[1]!.url).toBe('/cm?user=admin&password=adm%26in%20pw&cmnd=Backlog%20SSID2%20Jio%20Fiber%204G%3B%20Password2%20p%40ss%2Bw%26rd%231%25%3B%20Restart%201')
    // What the device decodes is the exact Backlog line.
    expect(s.commands[1]).toBe('Backlog SSID2 Jio Fiber 4G; Password2 p@ss+w&rd#1%; Restart 1')
    expect(s.slots[1]).toEqual({ ssid: 'Jio Fiber 4G', password: 'p@ss+w&rd#1%' })
    expect(JSON.stringify(res)).not.toContain('p@ss+w&rd#1%')
  })

  it('does nothing when the device is already on that network', async () => {
    const srv = await device(sim())
    const res = await adapter.setWifi!(ctxFor(srv), { ssid: 'HomeWiFi', password: 'welcome-home-1' })
    expect(res).toEqual({ ok: true, result: { ssid: 'HomeWiFi', alreadyThere: true }, state: { wifi: 'HomeWiFi' } })
    expect(srv.requests.map((r) => r.url)).toEqual(['/cm?cmnd=Status%2011'])
  })

  it('refuses what a Backlog cannot carry, before touching the device', async () => {
    const srv = await device(sim())
    const ctx = ctxFor(srv)
    const cases: Array<[string, string, RegExp]> = [
      ['', 'whatever-123', /No network name/],
      ['Backup4G', '', /No password stored for "Backup4G"/],
      ['Back;up', 'route66pass', /semicolon/],
      ['Backup4G', 'route;66pass', /semicolon/],
      ['Backup4G', ' route66pass', /starts or ends with a space/],
      ['Backup4G\n', 'route66pass', /cannot be sent/],
      ['A'.repeat(33), 'route66pass', /longer than the 32 characters/],
      ['Backup4G', 'x'.repeat(65), /longer than the 64 characters/],
      ['Backup4G', 'pw12', /shorter than 8 characters/],
      ['1', 'route66pass', /reads "1" as an instruction/],
      // Backlog keeps a ";" between { and } inside one command, so an unmatched bracket swallows what follows.
      ['Backup4G', 'route{66pass', /unmatched curly bracket/],
      ['Back}up4G', 'route66pass', /unmatched curly bracket/],
      ['Back{up4G', 'route}66pass', /unmatched curly bracket/],
    ]
    for (const [ssid, password, why] of cases) {
      const res = await adapter.setWifi!(ctx, { ssid, password })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(why)
      if (password) expect(res.error).not.toContain(password)
    }
    expect(srv.requests).toHaveLength(0)
  })

  it('sends matched curly brackets, which Backlog carries intact', async () => {
    const s = sim()
    const srv = await device(s)
    const res = await adapter.setWifi!(ctxFor(srv), { ssid: 'Guest{2}', password: 'pa{ss}word1' })
    expect(res.ok).toBe(true)
    expect(s.slots[1]).toEqual({ ssid: 'Guest{2}', password: 'pa{ss}word1' })
    expect(s.restarts).toBe(1)
  })

  it('reports a wrong password as a refusal and a dead device as a failure', async () => {
    const srv = await device(sim({ password: 'gate-s3cret' }))
    const refused = await adapter.setWifi!(ctxFor(srv, { config: { password: 'nope' } }), { ssid: 'Backup4G', password: 'route66pass' })
    expect(refused).toEqual({ ok: false, error: 'Wrong username or password' })
    const port = srv.port
    await srv.close()
    server = null
    const gone = makeCtx({ family: 'tasmota', kind: 'switch', path: { port } })
    await expect(adapter.setWifi!(gone, { ssid: 'Backup4G', password: 'route66pass' })).rejects.toThrow(/refused the connection/)
  })

  it('scans with WifiScan 1, then reads the list', async () => {
    const s = sim({ scanPollsBeforeResult: 1 })
    const srv = await device(s)
    const networks = await adapter.scanWifi!(ctxFor(srv))
    expect(networks).toEqual([
      { ssid: 'HomeWiFi', signal: 100, security: 'WPA2/PSK' },
      { ssid: 'Backup4G', signal: 66, security: 'WPA2/PSK' },
      { ssid: 'JioFiber-3F2A', signal: 30, security: 'OPEN' },
    ])
    expect(srv.requests.map((r) => r.url)).toEqual(['/cm?cmnd=WifiScan%201', '/cm?cmnd=WifiScan', '/cm?cmnd=WifiScan'])
  })

  it('explains firmware that is too old to scan', async () => {
    const srv = await device(sim({ oldFirmware: true }))
    await expect(adapter.scanWifi!(ctxFor(srv))).rejects.toThrow(/cannot list WiFi networks/)
    expect(srv.requests).toHaveLength(1)
  })
})
