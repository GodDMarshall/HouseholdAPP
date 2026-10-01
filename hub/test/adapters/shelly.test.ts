/**
 * Shelly adapter against mock devices that answer with the payloads from
 * docs/protocols/lights-tasmota-shelly-tuya.md and docs/protocols/gate-control.md:
 * a first-generation Shelly (REST paths, HTTP Basic) and a Plus / Pro one
 * (/rpc/<Method>, SHA-256 digest with user "admin" and the device id as realm).
 */
import crypto from 'node:crypto'
import type http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { DeviceKind } from '@house/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import adapter, { resetShellyState } from '../../src/adapters/shelly.ts'
import { basicGuard, makeAction, makeCtx, mockServer, send, type MockHandler, type MockServer, type RecordedRequest } from '../helpers.ts'

// The hub's own mDNS scanner, which the adapter's discover() narrows down. No multicast in tests.
const mdnsScanMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/discovery.ts', () => ({ mdnsScan: mdnsScanMock }))

let server: MockServer | null = null
let tls: { port: number; requests: RecordedRequest[]; close(): Promise<void> } | null = null

beforeEach(() => resetShellyState())
afterEach(async () => {
  vi.restoreAllMocks()
  await server?.close()
  server = null
  await tls?.close()
  tls = null
})

function ctxFor(kind: DeviceKind, config: Record<string, unknown> = {}, extra: Partial<Parameters<typeof makeCtx>[0]> = {}) {
  return makeCtx({ family: 'shelly', kind, config, path: { port: server!.port, ...(extra.path ?? {}) }, wifi: extra.wifi, timeoutMs: extra.timeoutMs })
}

/** Requests other than the identification call. */
function calls(): RecordedRequest[] {
  return server!.requests.filter((r) => r.path !== '/shelly')
}

/** Move the clock without touching real timers (sockets keep working). */
function advanceClock(ms: number): void {
  const real = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => real + ms)
}

// ---------------------------------------------------------------------------
// Mock: first-generation Shelly (Shelly 1 / Dimmer)
// ---------------------------------------------------------------------------

interface Gen1Sim {
  ison: boolean
  brightness: number
  input: number
  handler: MockHandler
}

function gen1Device(opts: { auth?: { username: string; password: string }; type?: string } = {}): Gen1Sim {
  const guard = opts.auth ? basicGuard(opts.auth.username, opts.auth.password) : null
  const sim: Gen1Sim = {
    ison: false,
    brightness: 50,
    input: 0,
    handler: (req, res) => {
      // /shelly is the only resource that never asks for a login.
      if (req.path === '/shelly') {
        return send(res, 200, { type: opts.type ?? 'SHSW-1', mac: '5ECF7F1632E8', auth: !!opts.auth, fw: '20230913-112003/v1.14.0-gcb84623', longid: 1, discoverable: true })
      }
      if (guard && !guard(req, res)) return
      const params = req.method === 'POST' ? new URLSearchParams(req.body) : req.query
      const applyTurn = () => {
        const turn = params.get('turn')
        if (turn === 'on') sim.ison = true
        if (turn === 'off') sim.ison = false
        if (turn === 'toggle') sim.ison = !sim.ison
      }
      if (req.path === '/relay/0' || req.path === '/relay/1') {
        applyTurn()
        const timer = Number(params.get('timer') ?? 0)
        return send(res, 200, { ison: sim.ison, has_timer: timer > 0, timer_started: 0, timer_duration: timer, timer_remaining: timer, source: 'http' })
      }
      if (req.path === '/light/0') {
        applyTurn()
        if (params.get('brightness')) sim.brightness = Number(params.get('brightness'))
        return send(res, 200, { ison: sim.ison, source: 'http', has_timer: false, timer_started: 0, timer_duration: 0, timer_remaining: 0, mode: 'white', brightness: sim.brightness })
      }
      if (req.path === '/status') {
        return send(res, 200, {
          wifi_sta: { connected: true, ssid: 'Home WiFi', ip: '192.168.1.20', rssi: -60 },
          cloud: { enabled: false, connected: false },
          mqtt: { connected: false },
          time: '14:21',
          relays: [{ ison: sim.ison, has_timer: false, timer_started: 0, timer_duration: 0, timer_remaining: 0, source: 'http' }],
          lights: [{ ison: sim.ison, brightness: sim.brightness }],
          inputs: [{ input: sim.input, event: '', event_cnt: 0 }],
          update: { status: 'idle', has_update: false },
          ram_total: 50592,
          ram_free: 38376,
          fs_size: 233681,
          fs_free: 162648,
          uptime: 3600,
        })
      }
      if (req.path === '/settings/sta' || req.path === '/settings/sta1') {
        // Echo of the station settings; the key is never returned.
        return send(res, 200, { enabled: true, ssid: params.get('ssid'), ipv4_method: 'dhcp', ip: null, gw: null, mask: null, dns: null })
      }
      if (req.path === '/reboot') return send(res, 200, {})
      send(res, 404, 'Not Found')
    },
  }
  return sim
}

// ---------------------------------------------------------------------------
// Mock: Plus / Pro / Gen3 Shelly
// ---------------------------------------------------------------------------

const DEVICE_ID = 'shellypro4pm-f008d1d8b8b8'

/**
 * The digest handshake from the protocol notes: 401 with
 * WWW-Authenticate: Digest realm="<device id>", nonce="..", algorithm=SHA-256, qop="auth"
 * (the 401 body carries auth_type "digest", nonce, realm, algorithm and an optional stale);
 * HA1 = SHA256(admin:realm:password), HA2 = SHA256(METHOD:uri),
 * response = SHA256(HA1:nonce:nc:cnonce:auth:HA2).
 *
 * Two firmware families, as the notes describe them:
 *  - 2.0.0 and later: a table of 32 nonces; a nonce may be reused, but nc must strictly rise.
 *    A good login on a nonce that is no longer in the table (or with a counter that did not
 *    rise) is answered 401 with stale=true.
 *  - before 2.0.0: numeric nonce, nc not tracked, full 401 round-trip per request. The mock is
 *    strict about it: every nonce is good for exactly one request.
 */
function shellyDigestGuard(password: string, opts: { legacy?: boolean; realm?: string } = {}) {
  const realm = opts.realm ?? DEVICE_ID
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
  /** nonce -> highest counter seen on it. */
  const table = new Map<string, number>()
  let seq = 1625038762
  const stats = {
    /** 401s sent. */
    challenges: 0,
    /** nc of every accepted request, in order. */
    accepted: [] as string[],
    /** Requests that carried a login and were turned away. */
    rejected: 0,
    /** Requests that carried the wrong password. */
    wrongPassword: 0,
    /** What a restart of the device does to the nonce table. */
    forgetNonces: () => table.clear(),
  }
  const challenge = (res: http.ServerResponse, stale: boolean): false => {
    seq += 1
    const nonce = opts.legacy ? String(seq) : seq.toString(16)
    table.set(nonce, 0)
    if (table.size > 32) table.delete(table.keys().next().value!)
    stats.challenges += 1
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Digest qop="auth", realm="${realm}", nonce="${nonce}", algorithm=SHA-256${stale ? ', stale=true' : ''}`,
    })
    res.end(JSON.stringify({ auth_type: 'digest', nonce: opts.legacy ? Number(nonce) : nonce, realm, algorithm: 'SHA-256', ...(stale ? { stale: true } : {}) }))
    return false
  }
  const guard = (req: RecordedRequest, res: http.ServerResponse): boolean => {
    const header = req.headers.authorization ?? ''
    if (!/^digest/i.test(header)) return challenge(res, false)
    const p: Record<string, string> = {}
    const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g
    let m: RegExpExecArray | null
    while ((m = re.exec(header))) p[m[1]!] = (m[2] ?? m[3] ?? '').trim()
    const ha1 = sha(`admin:${realm}:${password}`)
    const ha2 = sha(`${req.method}:${p.uri}`)
    const expected = sha(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`)
    const wellFormed = p.username === 'admin' && p.realm === realm && p.algorithm === 'SHA-256' && p.qop === 'auth' && p.uri === req.url && /^[0-9a-f]{8}$/.test(p.nc ?? '')
    if (!wellFormed || p.response !== expected) {
      stats.rejected += 1
      stats.wrongPassword += 1
      return challenge(res, false)
    }
    const nc = parseInt(p.nc!, 16)
    const last = table.get(p.nonce!)
    if (opts.legacy) {
      // One request per nonce.
      if (last === undefined) {
        stats.rejected += 1
        return challenge(res, false)
      }
      table.delete(p.nonce!)
    } else {
      if (last === undefined || nc <= last) {
        stats.rejected += 1
        return challenge(res, true)
      }
      table.set(p.nonce!, nc)
    }
    stats.accepted.push(p.nc!)
    return true
  }
  return { guard, stats }
}

interface Gen2Sim {
  outputs: boolean[]
  brightness: number
  input: boolean
  auth: ReturnType<typeof shellyDigestGuard> | null
  handler: MockHandler
}

/** Firmware as in the notes' sample ("ver":"0.6.7") unless a test asks for a 2.0.0+ device. */
function gen2Device(opts: { password?: string; dropWifiReply?: boolean; ver?: string } = {}): Gen2Sim {
  const ver = opts.ver ?? '0.6.7'
  const auth = opts.password ? shellyDigestGuard(opts.password, { legacy: Number.parseInt(ver, 10) < 2 }) : null
  const sim: Gen2Sim = {
    outputs: [false, false, false],
    brightness: 60,
    input: true,
    auth,
    handler: (req, res, raw) => {
      // Identification is open even when a password is set.
      if (req.path === '/shelly' || req.path === '/rpc/Shelly.GetDeviceInfo') {
        return send(res, 200, {
          id: DEVICE_ID,
          mac: 'F008D1D8B8B8',
          model: 'SPSW-004PE16EU',
          gen: 2,
          fw_id: `20210720-153353/${ver}-gc36674b`,
          ver,
          app: 'FourPro',
          auth_en: !!opts.password,
          auth_domain: opts.password ? DEVICE_ID : null,
        })
      }
      if (auth && !auth.guard(req, res)) return
      const body = req.method === 'POST' && req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {}
      const id = Number(req.query.get('id') ?? body.id ?? 0)
      const method = req.path.replace('/rpc/', '')
      const badId = () => send(res, 500, { code: -105, message: `Bad id=${id}` })
      switch (method) {
        case 'Switch.Set': {
          if (id > 2) return badId()
          const was = sim.outputs[id]!
          sim.outputs[id] = req.query.get('on') === 'true'
          return send(res, 200, { was_on: was })
        }
        case 'Switch.Toggle': {
          if (id > 2) return badId()
          const was = sim.outputs[id]!
          sim.outputs[id] = !was
          return send(res, 200, { was_on: was })
        }
        case 'Light.Set':
          if (req.query.get('on')) sim.outputs[0] = req.query.get('on') === 'true'
          if (req.query.get('brightness')) sim.brightness = Number(req.query.get('brightness'))
          return send(res, 200, {})
        case 'Light.Toggle':
          sim.outputs[0] = !sim.outputs[0]
          return send(res, 200, {})
        case 'Light.GetStatus':
          return send(res, 200, { id: 0, source: 'http', output: sim.outputs[0], brightness: sim.brightness, temperature: { tC: 40.1, tF: 104.2 } })
        case 'Input.GetStatus':
          return send(res, 200, { id, state: sim.input })
        case 'Shelly.GetStatus':
          return send(res, 200, {
            'switch:0': { id: 0, source: 'http', output: sim.outputs[0], apower: 0, voltage: 231.2, current: 0, aenergy: { total: 12.5 }, temperature: { tC: 40.1, tF: 104.2 } },
            'light:0': { id: 0, source: 'http', output: sim.outputs[0], brightness: sim.brightness, temperature: { tC: 40.1, tF: 104.2 } },
            'input:0': { id: 0, state: sim.input },
            wifi: { sta_ip: '192.168.206.97', status: 'got ip', ssid: 'Home WiFi', rssi: -56 },
            sys: { uptime: 3600 },
          })
        case 'WiFi.GetStatus':
          return send(res, 200, { sta_ip: '192.168.206.97', status: 'got ip', ssid: 'Home WiFi', rssi: -56 })
        case 'WiFi.Scan':
          return send(res, 200, {
            results: [
              { ssid: 'Backup 4G', bssid: 'f0:08:d1:00:00:02', auth: 3, channel: 11, rssi: -75 },
              { ssid: 'Home WiFi', bssid: 'f0:08:d1:00:00:01', auth: 3, channel: 6, rssi: -60 },
              { ssid: 'Home WiFi', bssid: 'f0:08:d1:00:00:03', auth: 3, channel: 1, rssi: -82 },
              { ssid: '', bssid: 'f0:08:d1:00:00:04', auth: 0, channel: 1, rssi: -50 },
            ],
          })
        case 'WiFi.SetConfig':
          // The station change drops the link about a second later; the reply may never arrive.
          if (opts.dropWifiReply) return void raw.socket.destroy()
          return send(res, 200, { restart_required: false })
        case 'Shelly.Reboot':
          return send(res, 200, 'null', 'application/json')
        default:
          return send(res, 404, { code: 404, message: `No handler for ${method}` })
      }
    },
  }
  return sim
}

// A throwaway self-signed certificate for the mock of a firmware-1.8 device (HTTPS only).
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkQxnzC0befXzrQ2R
pi4w5hqYzhVCO4oRRY5h6Kv1Pz6hRANCAASXuX6mgdAMvwJMBGFjriHbSxLUL40q
rcuwVTh+GHkZ2ylZgcBOe06kroOOrtn5af87bKgJ2zEPcuHoLnWMmtng
-----END PRIVATE KEY-----`
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBjDCCATOgAwIBAgIUHqXy7TiPEva8thTjXr+UORROcK0wCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQc2hlbGx5LW1vY2sudGVzdDAgFw0yNjEwMDExMjI5MTVaGA8y
MTI2MDkwNzEyMjkxNVowGzEZMBcGA1UEAwwQc2hlbGx5LW1vY2sudGVzdDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABJe5fqaB0Ay/AkwEYWOuIdtLEtQvjSqty7BV
OH4YeRnbKVmBwE57TqSug46u2flp/ztsqAnbMQ9y4egudYya2eCjUzBRMB0GA1Ud
DgQWBBQAyCmoMapydn4Q55FrsuQOWQ1xwjAfBgNVHSMEGDAWgBQAyCmoMapydn4Q
55FrsuQOWQ1xwjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIHYI
kBGkt/fbQ8Y2wxNRZzuHOKPcQ0tJ7ACO1zragQo9AiADzjYLmxjRe6XeOtwlX+en
nZU8rLhIDIggPKKACHHOgg==
-----END CERTIFICATE-----`

function tlsServer(handler: MockHandler): Promise<NonNullable<typeof tls>> {
  const requests: RecordedRequest[] = []
  const srv = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (raw, res) => {
    const chunks: Buffer[] = []
    raw.on('data', (c: Buffer) => chunks.push(c))
    raw.on('end', () => {
      const u = new URL(raw.url ?? '/', 'https://mock')
      const req: RecordedRequest = { method: raw.method ?? 'GET', url: raw.url ?? '/', path: u.pathname, query: u.searchParams, headers: raw.headers, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(req)
      void handler(req, res, raw)
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: (srv.address() as AddressInfo).port,
        requests,
        close: () =>
          new Promise<void>((done) => {
            srv.closeAllConnections?.()
            srv.close(() => done())
          }),
      })
    })
  })
}

// ---------------------------------------------------------------------------

describe('shelly adapter: add-device form and capabilities', () => {
  it('describes itself in plain words', () => {
    const d = adapter.describe()
    expect(d.id).toBe('shelly')
    expect(adapter.family).toBe('shelly')
    expect(d.kinds).toEqual(['light', 'switch', 'gate'])
    expect(d.pathKinds).toEqual(['lan'])
    expect(d.defaultPort).toBe(80)
    expect(d.fields.find((f) => f.name === 'password')).toMatchObject({ secret: true, type: 'password' })
    expect(d.fields.find((f) => f.name === 'password')?.required).toBeFalsy()
    expect(d.fields.find((f) => f.name === 'generation')?.options?.map((o) => o.value)).toEqual(['auto', 'gen1', 'gen2'])
    expect(d.fields.find((f) => f.name === 'gateMode')?.options?.map((o) => o.value)).toEqual(['one-button', 'separate-relays'])
    expect(d.fields.find((f) => f.name === 'inputClosedMeans')?.options?.map((o) => o.value)).toEqual(['on', 'off'])
    expect(d.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['channel', 'dimmer', 'pulseMs', 'inputId', 'closeChannel', 'stopChannel']))
    expect(d.notes.length).toBeGreaterThan(3)
    const visible = JSON.stringify(d)
    expect(visible).not.toMatch(/\b(demo|prototype|placeholder|stub|todo)\b/i)
    // A sensor on the switch input must not be allowed to drive the relay (it would press the gate's button).
    expect(d.fields.find((f) => f.name === 'inputId')?.help).toMatch(/Detached/)
    expect(d.notes.join(' ')).toMatch(/Detached/)
    // Honest limits: house network only, no colour, no scan on first generation.
    expect(d.notes.join(' ')).toMatch(/no SIM/)
    expect(d.notes.join(' ')).toMatch(/not on first-generation/)
  })

  it('offers only what the configured device can do', () => {
    expect(adapter.capabilities({}, 'switch')).toEqual(['power', 'wifi', 'wifi-scan', 'reboot', 'state'])
    expect(adapter.capabilities({ dimmer: true }, 'light')).toEqual(['power', 'dim', 'wifi', 'wifi-scan', 'reboot', 'state'])
    // First-generation Shellys cannot list WiFi networks.
    expect(adapter.capabilities({ generation: 'gen1' }, 'switch')).toEqual(['power', 'wifi', 'reboot', 'state'])
    // A gate is pulsed, never latched on; it knows its position only with a sensor.
    expect(adapter.capabilities({}, 'gate')).toEqual(['gate', 'wifi', 'wifi-scan', 'reboot', 'state'])
    expect(adapter.capabilities({ inputId: '' }, 'gate')).not.toContain('gate-state')
    expect(adapter.capabilities({ inputId: 0 }, 'gate')).toContain('gate-state')
    expect(adapter.capabilities({ inputId: '100' }, 'gate')).toContain('gate-state')
  })

  it('has no camera functions', () => {
    expect(adapter.snapshot).toBeUndefined()
    expect(adapter.streamSources).toBeUndefined()
  })
})

describe('shelly adapter: first generation (REST paths, HTTP Basic)', () => {
  it('probes with the open /shelly call and reports who answered', async () => {
    server = await mockServer(gen1Device().handler)
    const res = await adapter.probe(ctxFor('switch'))
    expect(res.ok).toBe(true)
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)
    expect(res.info).toMatchObject({ model: 'SHSW-1', firmware: '20230913-112003/v1.14.0-gcb84623', mac: '5ECF7F1632E8', generation: 'gen1' })
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /shelly'])
  })

  it('checks the password when the Shelly has one, and says so when it is wrong or missing', async () => {
    server = await mockServer(gen1Device({ auth: { username: 'owner', password: 's3cret' } }).handler)

    const good = await adapter.probe(ctxFor('switch', { username: 'owner', password: 's3cret' }))
    expect(good.ok).toBe(true)
    expect(good.info).toMatchObject({ wifi: 'Home WiFi', signal: 80, mac: '5ECF7F1632E8' })
    const status = server.requests.find((r) => r.path === '/status')!
    expect(status.headers.authorization).toBe('Basic ' + Buffer.from('owner:s3cret').toString('base64'))

    const wrong = await adapter.probe(ctxFor('switch', { username: 'owner', password: 'nope' }))
    expect(wrong).toMatchObject({ ok: false, error: 'Wrong username or password' })

    const missing = await adapter.probe(ctxFor('switch', {}))
    expect(missing.ok).toBe(false)
    expect(missing.error).toMatch(/asks for a password/)
    expect(JSON.stringify([good, wrong, missing])).not.toMatch(/s3cret|nope/)
  })

  it('reports an unreachable device in a plain sentence', async () => {
    server = await mockServer(gen1Device().handler)
    const port = server.port
    await server.close()
    server = null
    const res = await adapter.probe(makeCtx({ family: 'shelly', kind: 'switch', path: { port } }))
    expect(res.ok).toBe(false)
    expect(res.latencyMs).toBeNull()
    expect(res.error).toMatch(/refused the connection|did not answer/)
  })

  it('says so when something else answers at the address', async () => {
    server = await mockServer((_req, res) => send(res, 200, '<html>router</html>', 'text/html'))
    const res = await adapter.probe(ctxFor('switch'))
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/not a Shelly/) })
  })

  it('turns a relay on, off and over with /relay/0?turn=', async () => {
    const sim = gen1Device()
    server = await mockServer(sim.handler)
    const ctx = ctxFor('switch')

    const on = await adapter.execute(ctx, makeAction('power.on'))
    expect(on).toMatchObject({ ok: true, state: { power: true } })
    const toggled = await adapter.execute(ctx, makeAction('power.toggle'))
    expect(toggled).toMatchObject({ ok: true, state: { power: false } })
    await adapter.execute(ctx, makeAction('power.on'))
    const off = await adapter.execute(ctx, makeAction('power.off'))
    expect(off).toMatchObject({ ok: true, state: { power: false } })
    expect(sim.ison).toBe(false)

    // The generation is looked up once and remembered for this address.
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /shelly',
      'GET /relay/0?turn=on',
      'GET /relay/0?turn=toggle',
      'GET /relay/0?turn=on',
      'GET /relay/0?turn=off',
    ])
  })

  it('dims through /light/0 and treats 0 as off', async () => {
    const sim = gen1Device({ type: 'SHDM-2' })
    server = await mockServer(sim.handler)
    const ctx = ctxFor('light', { dimmer: true, generation: 'gen1' })

    const dim = await adapter.execute(ctx, makeAction('dim.set', { brightness: 40 }))
    expect(dim).toMatchObject({ ok: true, state: { power: true, brightness: 40 } })
    const off = await adapter.execute(ctx, makeAction('dim.set', { brightness: 0 }))
    expect(off).toMatchObject({ ok: true, state: { power: false } })
    const on = await adapter.execute(ctx, makeAction('power.on'))
    expect(on).toMatchObject({ ok: true, state: { power: true, brightness: 40 } })
    const over = await adapter.execute(ctx, makeAction('dim.set', { brightness: 250 }))
    expect(over).toMatchObject({ ok: true, state: { brightness: 100 } })

    // With the generation set by hand there is no /shelly lookup at all.
    expect(server.requests.map((r) => r.url)).toEqual(['/light/0?turn=on&brightness=40', '/light/0?turn=off', '/light/0?turn=on', '/light/0?turn=on&brightness=100'])

    const plainRelay = await adapter.execute(ctxFor('switch', { generation: 'gen1' }), makeAction('dim.set', { brightness: 40 }))
    expect(plainRelay.ok).toBe(false)
  })

  it('reads power, brightness, WiFi and the input from /status', async () => {
    const sim = gen1Device()
    sim.ison = true
    sim.brightness = 35
    sim.input = 1
    server = await mockServer(sim.handler)

    expect(await adapter.readState!(ctxFor('switch'))).toEqual({ power: true, wifi: 'Home WiFi', signal: 80, input: true })
    expect(await adapter.readState!(ctxFor('light', { dimmer: true }))).toEqual({ power: true, brightness: 35, wifi: 'Home WiFi', signal: 80, input: true })
    expect(calls().every((r) => r.url === '/status')).toBe(true)
  })

  it('presses a gate button with a timed pulse: /relay/0?turn=on&timer=1', async () => {
    server = await mockServer(gen1Device().handler)
    const ctx = ctxFor('gate')
    for (const type of ['gate.open', 'gate.close', 'gate.stop', 'gate.pulse'] as const) {
      const res = await adapter.execute(ctx, makeAction(type))
      expect(res).toMatchObject({ ok: true, result: { relay: 0, pulseSeconds: 1 }, state: { gate: 'unknown' } })
      expect(res.needsConfirmation).toBeUndefined()
    }
    expect(calls().map((r) => r.url)).toEqual(Array(4).fill('/relay/0?turn=on&timer=1'))
    // A gate relay is never latched on.
    expect((await adapter.execute(ctx, makeAction('power.on'))).ok).toBe(false)
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'unknown' })
  })

  it('reads a reed switch on the SW input as the gate position', async () => {
    const sim = gen1Device()
    server = await mockServer(sim.handler)
    const ctx = ctxFor('gate', { inputId: 0 })

    sim.input = 1
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'closed', input: true })
    sim.input = 0
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'open', input: false })
    // Sensor wired the other way round.
    expect(await adapter.readState!(ctxFor('gate', { inputId: 0, inputClosedMeans: 'off' }))).toMatchObject({ gate: 'closed' })
    // No pulse for a gate that is already open: on a step input it would stop or close it.
    const open = await adapter.execute(ctx, makeAction('gate.open'))
    expect(open).toMatchObject({ ok: true, result: { alreadyThere: true }, state: { gate: 'open' } })
    expect(server.requests.some((r) => r.path === '/relay/0')).toBe(false)
    // Closing it does press the button.
    const close = await adapter.execute(ctx, makeAction('gate.close'))
    expect(close).toMatchObject({ ok: true, state: { gate: 'closing' } })
    expect(server.requests.at(-1)!.url).toBe('/relay/0?turn=on&timer=1')
  })

  it('does not guess when a configured sensor gives no reading', async () => {
    server = await mockServer(gen1Device().handler)
    // The mock has one input (index 0); input 3 does not exist.
    const ctx = ctxFor('gate', { inputId: 3 })
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'unknown' })
    const open = await adapter.execute(ctx, makeAction('gate.open'))
    expect(open.ok).toBe(false)
    expect(open.error).toMatch(/gave no reading/)
    expect(server.requests.some((r) => r.path === '/relay/0')).toBe(false)
    // The owner can still press the button knowingly.
    expect(await adapter.execute(ctx, makeAction('gate.pulse'))).toMatchObject({ ok: true, state: { gate: 'unknown' } })
    expect(server.requests.at(-1)!.url).toBe('/relay/0?turn=on&timer=1')
  })

  it('restarts through /reboot', async () => {
    server = await mockServer(gen1Device().handler)
    const res = await adapter.execute(ctxFor('switch'), makeAction('reboot'))
    expect(res.ok).toBe(true)
    expect(calls().map((r) => `${r.method} ${r.url}`)).toEqual(['GET /reboot'])
  })

  it('moves to another WiFi: old network saved as fallback (sta1), new one as primary (sta)', async () => {
    server = await mockServer(gen1Device({ auth: { username: 'admin', password: 'devpass' } }).handler)
    const ctx = ctxFor(
      'switch',
      { password: 'devpass' },
      { path: { wifiNetworkId: 'wifi_home' }, wifi: { wifi_home: { ssid: 'Home WiFi', password: 'home pass&1' }, wifi_4g: { ssid: 'Backup 4G', password: 'backup+pw' } } },
    )
    const res = await adapter.setWifi!(ctx, { ssid: 'Backup 4G', password: 'backup+pw' })
    expect(res).toEqual({ ok: true, result: { ssid: 'Backup 4G', fallback: 'Home WiFi', replied: true }, state: { wifi: 'Backup 4G' } })

    const [sta1, sta] = calls()
    expect(`${sta1!.method} ${sta1!.url}`).toBe('POST /settings/sta1')
    expect(sta1!.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(sta1!.body).toBe('enabled=1&ssid=Home%20WiFi&key=home%20pass%261&ipv4_method=dhcp')
    expect(`${sta!.method} ${sta!.url}`).toBe('POST /settings/sta')
    expect(sta!.body).toBe('enabled=1&ssid=Backup%204G&key=backup%2Bpw&ipv4_method=dhcp')
    expect(sta!.headers['content-length']).toBe(String(sta!.body.length))
    // WiFi passwords never travel in a URL and never come back in the result.
    expect(server.requests.map((r) => r.url).join(' ')).not.toMatch(/pass|pw/)
    expect(JSON.stringify(res)).not.toMatch(/home pass|backup\+pw|devpass/)
  })

  it('refuses a WiFi move without a name or password, and cannot scan', async () => {
    server = await mockServer(gen1Device().handler)
    const ctx = ctxFor('switch')
    expect((await adapter.setWifi!(ctx, { ssid: '', password: 'x' })).ok).toBe(false)
    expect((await adapter.setWifi!(ctx, { ssid: 'Home WiFi', password: '' })).ok).toBe(false)
    expect(server.requests).toHaveLength(0)
    await expect(adapter.scanWifi!(ctx)).rejects.toThrow(/First-generation/)
  })
})

describe('shelly adapter: Plus / Pro / Gen3 (RPC, SHA-256 digest)', () => {
  it('probes an open device with one call and returns its identity', async () => {
    server = await mockServer(gen2Device().handler)
    const res = await adapter.probe(ctxFor('switch'))
    expect(res.ok).toBe(true)
    expect(res.info).toEqual({ model: 'SPSW-004PE16EU', firmware: '0.6.7', serial: DEVICE_ID, mac: 'F008D1D8B8B8', generation: 'gen2' })
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /shelly'])
  })

  it('firmware 2.0.0+: logs in with SHA-256 digest as "admin" and reuses the nonce with a rising counter', async () => {
    const sim = gen2Device({ password: 'gate-pass', ver: '2.0.1' })
    server = await mockServer(sim.handler)
    const ctx = ctxFor('switch', { password: 'gate-pass' })

    const probe = await adapter.probe(ctx)
    expect(probe.ok).toBe(true)
    expect(probe.info).toMatchObject({ wifi: 'Home WiFi', signal: 88, mac: 'F008D1D8B8B8' })
    // One challenge, then the answer.
    expect(server.requests.map((r) => r.url)).toEqual(['/shelly', '/rpc/WiFi.GetStatus', '/rpc/WiFi.GetStatus'])
    const authed = server.requests[2]!.headers.authorization!
    expect(authed).toMatch(/^Digest username="admin", realm="shellypro4pm-f008d1d8b8b8", nonce="[0-9a-f]+", uri="\/rpc\/WiFi\.GetStatus", cnonce="[0-9a-f]+", nc=00000001, qop=auth, algorithm=SHA-256, response="[0-9a-f]{64}"$/)

    // Later calls go straight through on the same nonce: no new challenge, nc counts up.
    expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
    expect(await adapter.readState!(ctx)).toMatchObject({ power: true })
    expect((await adapter.probe(ctx)).ok).toBe(true)
    expect(sim.auth!.stats.challenges).toBe(1)
    expect(sim.auth!.stats.accepted).toEqual(['00000001', '00000002', '00000003', '00000004'])
    expect(sim.auth!.stats.rejected).toBe(0)
    expect(server.requests.map((r) => r.url).join(' ')).not.toContain('gate-pass')
  })

  it('firmware before 2.0.0: does the full challenge round-trip for every request and never sends a used nonce', async () => {
    // The notes' sample device ("ver":"0.6.7"): numeric nonce, good for one request.
    const sim = gen2Device({ password: 'gate-pass' })
    server = await mockServer(sim.handler)
    const ctx = ctxFor('switch', { password: 'gate-pass' })

    expect((await adapter.probe(ctx)).ok).toBe(true)
    expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
    expect(await adapter.readState!(ctx)).toMatchObject({ power: true })
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toMatchObject({ ok: true, state: { power: false } })
    expect((await adapter.probe(ctx)).ok).toBe(true)

    // Each call: one request without a login (the challenge), then one with it. Never a stale login.
    expect(sim.auth!.stats.rejected).toBe(0)
    expect(sim.auth!.stats.accepted).toEqual(Array(5).fill('00000001'))
    expect(sim.auth!.stats.challenges).toBe(5)
    const rpcCalls = calls().map((r) => `${r.url} ${r.headers.authorization ? 'login' : 'open'}`)
    expect(rpcCalls).toEqual([
      '/rpc/WiFi.GetStatus open',
      '/rpc/WiFi.GetStatus login',
      '/rpc/Switch.Set?id=0&on=true open',
      '/rpc/Switch.Set?id=0&on=true login',
      '/rpc/Shelly.GetStatus open',
      '/rpc/Shelly.GetStatus login',
      '/rpc/Switch.Toggle?id=0 open',
      '/rpc/Switch.Toggle?id=0 login',
      '/rpc/WiFi.GetStatus open',
      '/rpc/WiFi.GetStatus login',
    ])
    // The relay was toggled exactly once: the challenge request does not act.
    expect(sim.outputs[0]).toBe(false)
  })

  it('takes a new nonce after the device restarted, without calling the password wrong', async () => {
    const sim = gen2Device({ password: 'gate-pass', ver: '2.0.1' })
    server = await mockServer(sim.handler)
    const ctx = ctxFor('switch', { password: 'gate-pass' })
    expect((await adapter.probe(ctx)).ok).toBe(true)

    sim.auth!.stats.forgetNonces()
    // The remembered nonce is answered 401 stale=true; the new one is taken and the command goes through.
    expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
    expect(sim.auth!.stats.challenges).toBe(2)
    expect(sim.auth!.stats.wrongPassword).toBe(0)
    expect(sim.outputs[0]).toBe(true)
    // And the new nonce is reused from then on.
    expect(await adapter.readState!(ctx)).toMatchObject({ power: true })
    expect(sim.auth!.stats.challenges).toBe(2)
  })

  it('does not mistake "nonce is stale" for a wrong password, and does not lock the device out for it', async () => {
    const sim = gen2Device({ password: 'gate-pass', ver: '2.0.1' })
    let alwaysStale = true
    server = await mockServer((req, res, raw) => {
      if (alwaysStale && req.path.startsWith('/rpc/')) {
        res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth", realm="${DEVICE_ID}", nonce="${Date.now().toString(16)}", algorithm=SHA-256, stale=true` })
        return void res.end()
      }
      return sim.handler(req, res, raw)
    })
    const ctx = ctxFor('switch', { password: 'gate-pass' })
    const res = await adapter.execute(ctx, makeAction('power.on'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/busy with another request/)
    expect(res.error).not.toMatch(/password/i)
    // The first request, then two fresh nonces: three in all, never an endless loop.
    expect(calls()).toHaveLength(3)
    // A stale nonce says nothing about reachability.
    expect((await adapter.probe(ctx)).ok).toBe(true)

    // No one-minute wait as after a wrong password: the next command is sent at once.
    alwaysStale = false
    expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
  })

  it('reads the challenge from the 401 body when the header is missing', async () => {
    const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
    server = await mockServer((req, res) => {
      if (req.path === '/shelly') return send(res, 200, { id: DEVICE_ID, mac: 'F008D1D8B8B8', model: 'SPSW-004PE16EU', gen: 2, ver: '0.6.7', auth_en: true, auth_domain: DEVICE_ID })
      const p: Record<string, string> = {}
      const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g
      let m: RegExpExecArray | null
      while ((m = re.exec(req.headers.authorization ?? ''))) p[m[1]!] = (m[2] ?? m[3] ?? '').trim()
      const expected = sha(`${sha(`admin:${DEVICE_ID}:gate-pass`)}:1625038762:${p.nc}:${p.cnonce}:auth:${sha(`GET:${req.url}`)}`)
      if (p.response === expected && p.algorithm === 'SHA-256') return send(res, 200, { was_on: false })
      send(res, 401, { auth_type: 'digest', nonce: 1625038762, realm: DEVICE_ID, algorithm: 'SHA-256' })
    })
    const res = await adapter.execute(ctxFor('switch', { password: 'gate-pass' }), makeAction('power.on'))
    expect(res).toMatchObject({ ok: true, state: { power: true } })
    expect(calls().at(-1)!.headers.authorization).toMatch(/nonce="1625038762"/)
  })

  it('reports a wrong password and does not hammer the device with it', async () => {
    const sim = gen2Device({ password: 'gate-pass' })
    server = await mockServer(sim.handler)
    const wrong = ctxFor('switch', { password: 'guess' })

    const first = await adapter.probe(wrong)
    expect(first).toMatchObject({ ok: false, error: 'Wrong username or password' })
    const loginAttempts = () => server!.requests.filter((r) => r.headers.authorization).length
    expect(loginAttempts()).toBe(1)

    // Probes and commands in the next minute answer from memory instead of trying again.
    expect(await adapter.probe(wrong)).toMatchObject({ ok: false, error: 'Wrong username or password' })
    expect(await adapter.execute(wrong, makeAction('power.on'))).toEqual({ ok: false, error: 'Wrong username or password' })
    await expect(adapter.readState!(wrong)).rejects.toThrow('Wrong username or password')
    expect(loginAttempts()).toBe(1)
    expect(calls()).toHaveLength(2)

    // A corrected password is tried at once.
    expect((await adapter.probe(ctxFor('switch', { password: 'gate-pass' }))).ok).toBe(true)

    // And the wrong one again only after the wait.
    advanceClock(61_000)
    expect((await adapter.probe(wrong)).ok).toBe(false)
    expect(loginAttempts()).toBeGreaterThan(2)

    const none = await adapter.probe(ctxFor('switch', {}))
    expect(none.ok).toBe(false)
    expect(none.error).toMatch(/asks for a password/)
  })

  it('backs off when the device answers 429 (login throttle)', async () => {
    const sim = gen2Device()
    let throttled = true
    server = await mockServer((req, res, raw) => {
      if (throttled && req.path.startsWith('/rpc/')) {
        res.writeHead(429)
        return void res.end()
      }
      return sim.handler(req, res, raw)
    })
    const ctx = ctxFor('switch', { password: 'gate-pass' })
    const first = await adapter.execute(ctx, makeAction('power.on'))
    expect(first.ok).toBe(false)
    expect(first.error).toMatch(/refusing logins/)
    const seen = server.requests.length
    // Nothing is sent while backing off.
    expect((await adapter.execute(ctx, makeAction('power.on'))).ok).toBe(false)
    expect(server.requests.length).toBe(seen)

    throttled = false
    advanceClock(11_000)
    expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
  })

  it('still counts a throttled device as reachable when probing', async () => {
    const sim = gen2Device({ password: 'gate-pass' })
    server = await mockServer((req, res, raw) => {
      if (req.path === '/rpc/WiFi.GetStatus') {
        res.writeHead(429)
        return void res.end()
      }
      return sim.handler(req, res, raw)
    })
    const res = await adapter.probe(ctxFor('switch', { password: 'gate-pass' }))
    expect(res.ok).toBe(true)
    expect(res.info).toMatchObject({ mac: 'F008D1D8B8B8', serial: DEVICE_ID })
  })

  it('switches with Switch.Set and Switch.Toggle', async () => {
    const sim = gen2Device()
    server = await mockServer(sim.handler)
    const ctx = ctxFor('switch')

    expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toMatchObject({ ok: true, state: { power: false } })
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toMatchObject({ ok: true, state: { power: true } })
    expect(await adapter.execute(ctx, makeAction('power.off'))).toMatchObject({ ok: true, state: { power: false } })
    expect(sim.outputs[0]).toBe(false)
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /shelly',
      'GET /rpc/Switch.Set?id=0&on=true',
      'GET /rpc/Switch.Toggle?id=0',
      'GET /rpc/Switch.Toggle?id=0',
      'GET /rpc/Switch.Set?id=0&on=false',
    ])

    // Second relay of a multi-relay model.
    await adapter.execute(ctxFor('switch', { channel: 1 }), makeAction('power.on'))
    expect(server.requests.at(-1)!.url).toBe('/rpc/Switch.Set?id=1&on=true')
    expect(sim.outputs[1]).toBe(true)
  })

  it('drives a dimmer with Light.Set', async () => {
    const sim = gen2Device()
    server = await mockServer(sim.handler)
    const ctx = ctxFor('light', { dimmer: true, generation: 'gen2' })

    expect(await adapter.execute(ctx, makeAction('dim.set', { brightness: 60 }))).toMatchObject({ ok: true, state: { power: true, brightness: 60 } })
    expect(await adapter.execute(ctx, makeAction('dim.set', { brightness: 0 }))).toMatchObject({ ok: true, state: { power: false } })
    expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toMatchObject({ ok: true, state: { power: false, brightness: 60 } })
    expect(await adapter.execute(ctx, makeAction('power.off'))).toMatchObject({ ok: true, state: { power: false } })
    expect((await adapter.execute(ctx, makeAction('dim.set', {}))).ok).toBe(false)
    expect(server.requests.map((r) => r.url)).toEqual([
      '/rpc/Light.Set?id=0&on=true&brightness=60',
      '/rpc/Light.Set?id=0&on=false',
      '/rpc/Light.Set?id=0&on=true',
      '/rpc/Light.Toggle?id=0',
      '/rpc/Light.GetStatus?id=0',
      '/rpc/Light.Set?id=0&on=false',
    ])
    expect(await adapter.readState!(ctx)).toEqual({ power: false, brightness: 60, wifi: 'Home WiFi', signal: 88, input: true })
  })

  it('reads power, WiFi and the input from Shelly.GetStatus', async () => {
    const sim = gen2Device()
    sim.outputs[0] = true
    sim.input = false
    server = await mockServer(sim.handler)
    const state = await adapter.readState!(ctxFor('switch'))
    expect(state).toEqual({ power: true, wifi: 'Home WiFi', signal: 88, input: false })
    expect(calls().map((r) => r.url)).toEqual(['/rpc/Shelly.GetStatus'])
  })

  it('passes on the device’s own refusal and names a command the model does not have', async () => {
    server = await mockServer(gen2Device().handler)
    const badChannel = await adapter.execute(ctxFor('switch', { channel: 12 }), makeAction('power.on'))
    expect(badChannel).toEqual({ ok: false, error: 'The Shelly refused the command: Bad id=12' })

    // A device with no Light component answers "No handler".
    await server.close()
    server = await mockServer((req, res) => (req.path === '/shelly' ? send(res, 200, { id: DEVICE_ID, mac: 'F008D1D8B8B8', model: 'SPSW-004PE16EU', gen: 2, ver: '0.6.7', auth_en: false }) : send(res, 404, { code: 404, message: 'No handler for Light.Set' })))
    resetShellyState()
    const noLight = await adapter.execute(ctxFor('light', { dimmer: true }), makeAction('power.on'))
    expect(noLight.ok).toBe(false)
    expect(noLight.error).toMatch(/does not know the command Light\.Set/)
  })

  it('refuses what a relay cannot do', async () => {
    server = await mockServer(gen2Device().handler)
    const ctx = ctxFor('switch')
    for (const type of ['ptz.move', 'color.set', 'sms.send', 'custom', 'gate.open', 'dim.set'] as const) {
      expect((await adapter.execute(ctx, makeAction(type))).ok).toBe(false)
    }
    expect(server.requests).toHaveLength(0)
  })

  it('throws on a transport failure so the hub can try another connection', async () => {
    server = await mockServer(gen2Device().handler)
    const ctx = ctxFor('switch', { generation: 'gen2' })
    await server.close()
    server = null
    await expect(adapter.execute(ctx, makeAction('power.on'))).rejects.toThrow(/refused the connection/)
    await expect(adapter.readState!(ctx)).rejects.toThrow(/refused the connection/)
  })

  it('tells the owner when the generation was set wrong by hand', async () => {
    server = await mockServer(gen2Device().handler)
    const res = await adapter.probe(ctxFor('switch', { generation: 'gen1' }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/newer Shelly/)
  })

  it('restarts with Shelly.Reboot', async () => {
    server = await mockServer(gen2Device().handler)
    const res = await adapter.execute(ctxFor('switch'), makeAction('reboot'))
    expect(res.ok).toBe(true)
    expect(calls().map((r) => `${r.method} ${r.url}`)).toEqual(['GET /rpc/Shelly.Reboot'])
  })

  it('lists the networks the device sees, strongest first, one line per name', async () => {
    server = await mockServer(gen2Device().handler)
    const nets = await adapter.scanWifi!(ctxFor('switch'))
    expect(nets).toEqual([
      { ssid: 'Home WiFi', signal: 80, security: 'WPA2' },
      { ssid: 'Backup 4G', signal: 50, security: 'WPA2' },
    ])
    expect(calls().map((r) => `${r.method} ${r.url}`)).toEqual(['GET /rpc/WiFi.Scan'])
  })

  it('moves to another WiFi with one WiFi.SetConfig: new network as sta, old one as sta1', async () => {
    server = await mockServer(gen2Device({ password: 'gate-pass' }).handler)
    const ctx = ctxFor(
      'switch',
      { password: 'gate-pass' },
      { path: { wifiNetworkId: 'wifi_home' }, wifi: { wifi_home: { ssid: 'Home WiFi', password: 'home-secret-1' } } },
    )
    const res = await adapter.setWifi!(ctx, { ssid: 'Backup 4G', password: 'backup-secret-2' })
    expect(res).toEqual({ ok: true, result: { ssid: 'Backup 4G', fallback: 'Home WiFi', replied: true }, state: { wifi: 'Backup 4G' } })

    const posts = calls().filter((r) => r.headers.authorization)
    expect(posts).toHaveLength(1)
    expect(`${posts[0]!.method} ${posts[0]!.url}`).toBe('POST /rpc/WiFi.SetConfig')
    expect(posts[0]!.headers['content-type']).toBe('application/json')
    expect(JSON.parse(posts[0]!.body)).toEqual({
      config: {
        sta: { ssid: 'Backup 4G', pass: 'backup-secret-2', enable: true, ipv4mode: 'dhcp' },
        sta1: { ssid: 'Home WiFi', pass: 'home-secret-1', enable: true },
      },
    })
    expect(server.requests.map((r) => r.url).join(' ')).not.toMatch(/secret/)
    expect(JSON.stringify(res)).not.toMatch(/secret|gate-pass/)
  })

  it('leaves the fallback alone when the hub does not know the network being left', async () => {
    server = await mockServer(gen2Device().handler)
    const res = await adapter.setWifi!(ctxFor('switch'), { ssid: 'Backup 4G', password: 'backup-secret-2' })
    expect(res).toMatchObject({ ok: true, result: { ssid: 'Backup 4G', fallback: null } })
    expect(JSON.parse(server.requests.at(-1)!.body)).toEqual({ config: { sta: { ssid: 'Backup 4G', pass: 'backup-secret-2', enable: true, ipv4mode: 'dhcp' } } })
  })

  it('treats a lost reply after WiFi.SetConfig as sent: the device has already left', async () => {
    server = await mockServer(gen2Device({ dropWifiReply: true }).handler)
    const res = await adapter.setWifi!(ctxFor('switch'), { ssid: 'Backup 4G', password: 'backup-secret-2' })
    expect(res).toEqual({ ok: true, result: { ssid: 'Backup 4G', fallback: null, replied: false }, state: { wifi: 'Backup 4G' } })
    expect(res.needsConfirmation).toBeUndefined()
  })

  it('follows the firmware 1.8 redirect to HTTPS once and stays there', async () => {
    const sim = gen2Device()
    tls = await tlsServer(sim.handler)
    const tlsPort = tls.port
    server = await mockServer((req, res) => {
      res.writeHead(301, { Location: `https://127.0.0.1:${tlsPort}${req.url}` })
      res.end()
    })
    const ctx = ctxFor('switch')
    const probe = await adapter.probe(ctx)
    expect(probe.ok).toBe(true)
    expect(probe.info).toMatchObject({ firmware: '0.6.7', mac: 'F008D1D8B8B8' })
    expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
    expect(sim.outputs[0]).toBe(true)
    // Plain HTTP was tried exactly once.
    expect(server.requests.map((r) => r.url)).toEqual(['/shelly'])
    expect(tls.requests.map((r) => r.url)).toEqual(['/shelly', '/rpc/Switch.Set?id=0&on=true'])
  })

  it('goes straight to HTTPS when told to', async () => {
    const sim = gen2Device()
    tls = await tlsServer(sim.handler)
    const ctx = makeCtx({ family: 'shelly', kind: 'switch', config: { https: true }, path: { port: tls.port } })
    expect((await adapter.probe(ctx)).ok).toBe(true)
    expect(tls.requests.map((r) => r.url)).toEqual(['/shelly'])
  })
})

describe('shelly adapter: gate or garage door on a Plus / Pro relay', () => {
  it('one button, no sensor: every gate command is the same one-second press', async () => {
    const sim = gen2Device()
    server = await mockServer(sim.handler)
    const ctx = ctxFor('gate')
    for (const type of ['gate.open', 'gate.close', 'gate.stop', 'gate.pulse'] as const) {
      const res = await adapter.execute(ctx, makeAction(type))
      expect(res).toEqual({ ok: true, result: { relay: 0, pulseSeconds: 1 }, state: { gate: 'unknown' } })
    }
    expect(calls().map((r) => `${r.method} ${r.url}`)).toEqual(Array(4).fill('GET /rpc/Switch.Set?id=0&on=true&toggle_after=1'))
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'unknown' })
    expect(await adapter.readState!(ctx)).not.toHaveProperty('power')
  })

  it('rounds the press length up to whole seconds', async () => {
    server = await mockServer(gen2Device().handler)
    await adapter.execute(ctxFor('gate', { pulseMs: 2500 }), makeAction('gate.pulse'))
    expect(server.requests.at(-1)!.url).toBe('/rpc/Switch.Set?id=0&on=true&toggle_after=3')
    await adapter.execute(ctxFor('gate', { pulseMs: 300 }), makeAction('gate.pulse'))
    expect(server.requests.at(-1)!.url).toBe('/rpc/Switch.Set?id=0&on=true&toggle_after=1')
  })

  it('with a reed switch: shows opening, then what the sensor says once the travel time has passed', async () => {
    const sim = gen2Device()
    sim.input = true // magnet at the sensor: closed
    server = await mockServer(sim.handler)
    const ctx = ctxFor('gate', { inputId: 0, travelSeconds: 20 })
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'closed', input: true })

    const open = await adapter.execute(ctx, makeAction('gate.open'))
    expect(open).toEqual({ ok: true, result: { relay: 0, pulseSeconds: 1 }, state: { gate: 'opening' } })
    expect(calls().slice(-2).map((r) => r.url)).toEqual(['/rpc/Input.GetStatus?id=0', '/rpc/Switch.Set?id=0&on=true&toggle_after=1'])

    sim.input = false // the leaf has left the sensor
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'opening' })
    advanceClock(21_000)
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'open', input: false })
  })

  it('with a reed switch: closing is confirmed the moment the sensor closes', async () => {
    const sim = gen2Device()
    sim.input = false
    server = await mockServer(sim.handler)
    const ctx = ctxFor('gate', { inputId: 0 })

    const close = await adapter.execute(ctx, makeAction('gate.close'))
    expect(close).toMatchObject({ ok: true, state: { gate: 'closing' } })
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'closing' })
    sim.input = true
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'closed' })

    // Already closed: no press, because on a step input it would open the gate again.
    const before = server.requests.length
    const again = await adapter.execute(ctx, makeAction('gate.close'))
    expect(again).toMatchObject({ ok: true, result: { alreadyThere: true }, state: { gate: 'closed' } })
    const stop = await adapter.execute(ctx, makeAction('gate.stop'))
    expect(stop).toMatchObject({ ok: true, result: { alreadyThere: true }, state: { gate: 'closed' } })
    expect(server.requests.slice(before).map((r) => r.url)).toEqual(['/rpc/Input.GetStatus?id=0', '/rpc/Input.GetStatus?id=0'])
  })

  it('with a reed switch: a gate that never moved is reported as it is, and stop is remembered', async () => {
    const sim = gen2Device()
    sim.input = true
    server = await mockServer(sim.handler)
    const ctx = ctxFor('gate', { inputId: 0, travelSeconds: 5 })

    await adapter.execute(ctx, makeAction('gate.open'))
    advanceClock(6_000)
    // Sensor still closed after the travel time: the gate did not open.
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'closed' })

    vi.restoreAllMocks()
    sim.input = false
    const stop = await adapter.execute(ctx, makeAction('gate.stop'))
    expect(stop).toMatchObject({ ok: true, state: { gate: 'stopped' } })
    expect(await adapter.readState!(ctx)).toMatchObject({ gate: 'stopped' })
    // Pulse from "not closed" heads for closed.
    expect(await adapter.execute(ctx, makeAction('gate.pulse'))).toMatchObject({ ok: true, state: { gate: 'closing' } })
  })

  it('never presses or toggles twice: a lost answer is reported, not retried on another connection', async () => {
    const sim = gen2Device()
    let presses = 0
    server = await mockServer((req, res, raw) => {
      if (req.path === '/rpc/Switch.Set' || req.path === '/rpc/Switch.Toggle') {
        // The relay acts, but the answer never makes it back.
        presses += 1
        return void raw.socket.destroy()
      }
      return sim.handler(req, res, raw)
    })

    const press = await adapter.execute(ctxFor('gate'), makeAction('gate.open'))
    expect(press.ok).toBe(false)
    expect(press.error).toMatch(/cannot tell whether it arrived.*not sent again/)
    expect(presses).toBe(1)

    const toggle = await adapter.execute(ctxFor('switch'), makeAction('power.toggle'))
    expect(toggle.ok).toBe(false)
    expect(toggle.error).toMatch(/not sent again/)
    expect(presses).toBe(2)

    // Plain on / off and separate OPEN / CLOSE relays can be repeated without harm,
    // so there the failure is thrown and the hub may try another connection.
    await expect(adapter.execute(ctxFor('switch'), makeAction('power.on'))).rejects.toThrow(/closed the connection/)
    await expect(adapter.execute(ctxFor('gate', { gateMode: 'separate-relays' }), makeAction('gate.open'))).rejects.toThrow(/closed the connection/)
  })

  it('first generation: a lost answer to a press or a toggle is not retried either', async () => {
    const sim = gen1Device()
    let presses = 0
    server = await mockServer((req, res, raw) => {
      if (req.path === '/relay/0') {
        presses += 1
        return void raw.socket.destroy()
      }
      return sim.handler(req, res, raw)
    })
    const press = await adapter.execute(ctxFor('gate'), makeAction('gate.pulse'))
    expect(press).toMatchObject({ ok: false, error: expect.stringMatching(/not sent again/) })
    const toggle = await adapter.execute(ctxFor('switch'), makeAction('power.toggle'))
    expect(toggle).toMatchObject({ ok: false, error: expect.stringMatching(/not sent again/) })
    expect(presses).toBe(2)
  })

  it('finishes inside the hub’s limit for one action even when the Shelly is slow, so the hub never repeats a press', async () => {
    const sim = gen2Device()
    server = await mockServer(async (req, res, raw) => {
      await new Promise((r) => setTimeout(r, 600))
      return sim.handler(req, res, raw)
    })
    // The hub gives an action twice the device timeout, then tries again on another connection.
    const timeoutMs = 1000
    const ctx = ctxFor('gate', { generation: 'gen2', inputId: 0 }, { timeoutMs })
    sim.input = true
    const started = Date.now()
    const res = await adapter.execute(ctx, makeAction('gate.open'))
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(timeoutMs * 2)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cannot tell whether it arrived|too slowly/)
    expect(server.requests.filter((r) => r.path === '/rpc/Switch.Set').length).toBeLessThanOrEqual(1)
  })

  it('lets the hub fail over when the Shelly is not on this network at all', async () => {
    server = await mockServer(gen2Device().handler)
    const ctx = ctxFor('gate', { generation: 'gen2' })
    await server.close()
    server = null
    // Nothing can have arrived, so trying the next connection is safe.
    await expect(adapter.execute(ctx, makeAction('gate.open'))).rejects.toThrow(/refused the connection/)
  })

  it('separate relays: open, close and stop each press their own relay', async () => {
    const sim = gen2Device()
    server = await mockServer(sim.handler)
    const ctx = ctxFor('gate', { gateMode: 'separate-relays', channel: 0, closeChannel: 1, stopChannel: 2 })

    expect(await adapter.execute(ctx, makeAction('gate.open'))).toMatchObject({ ok: true, result: { relay: 0 } })
    expect(await adapter.execute(ctx, makeAction('gate.close'))).toMatchObject({ ok: true, result: { relay: 1 } })
    expect(await adapter.execute(ctx, makeAction('gate.stop'))).toMatchObject({ ok: true, result: { relay: 2 } })
    expect(calls().map((r) => r.url)).toEqual([
      '/rpc/Switch.Set?id=0&on=true&toggle_after=1',
      '/rpc/Switch.Set?id=1&on=true&toggle_after=1',
      '/rpc/Switch.Set?id=2&on=true&toggle_after=1',
    ])

    // Without a sensor "pulse" has no meaning here, and without a STOP relay stop is refused, not guessed.
    const before = server.requests.length
    expect((await adapter.execute(ctx, makeAction('gate.pulse'))).ok).toBe(false)
    const noStop = await adapter.execute(ctxFor('gate', { gateMode: 'separate-relays' }), makeAction('gate.stop'))
    expect(noStop.ok).toBe(false)
    expect(noStop.error).toMatch(/STOP/)
    expect(server.requests.length).toBe(before)

    // With a sensor, pulse picks the relay for the other end.
    sim.input = true
    const sensed = ctxFor('gate', { gateMode: 'separate-relays', inputId: 0 })
    expect(await adapter.execute(sensed, makeAction('gate.pulse'))).toMatchObject({ ok: true, result: { relay: 0 }, state: { gate: 'opening' } })
    sim.input = false
    expect(await adapter.execute(sensed, makeAction('gate.pulse'))).toMatchObject({ ok: true, result: { relay: 1 }, state: { gate: 'closing' } })
  })
})

describe('shelly adapter: awkward devices, answers and addresses', () => {
  it('first generation: an answer no Shelly sends is reported as such, never passed off as a lost connection', async () => {
    let toggles = 0
    server = await mockServer((req, res) => {
      if (req.path === '/shelly') return send(res, 200, { type: 'SHSW-1', mac: '5ECF7F1632E8', auth: false, fw: '20230913-112003/v1.14.0-gcb84623', longid: 1, discoverable: true })
      if (req.path === '/relay/0') {
        toggles += 1
        return send(res, 200, 'null', 'application/json')
      }
      if (req.path === '/status') return send(res, 200, '<html><body>Please log in</body></html>', 'text/html')
      return send(res, 200, '[]', 'application/json')
    })
    const ctx = ctxFor('switch')
    // Returned, not thrown: a thrown error would make the hub toggle again on another connection.
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toEqual({ ok: false, error: 'The Shelly sent an answer the hub could not read' })
    expect(toggles).toBe(1)
    expect(await adapter.execute(ctx, makeAction('reboot'))).toEqual({ ok: false, error: 'The Shelly sent an answer the hub could not read' })
    await expect(adapter.readState!(ctx)).rejects.toThrow('The Shelly sent an answer the hub could not read')
  })

  it('newer models: a web page instead of an RPC answer is a clear refusal', async () => {
    server = await mockServer((req, res) => {
      if (req.path === '/shelly') return send(res, 200, { id: DEVICE_ID, mac: 'F008D1D8B8B8', model: 'SPSW-004PE16EU', gen: 2, ver: '0.6.7', auth_en: false })
      return send(res, 200, '<html><body>Captive portal</body></html>', 'text/html')
    })
    const ctx = ctxFor('switch')
    expect(await adapter.execute(ctx, makeAction('power.on'))).toEqual({ ok: false, error: 'The Shelly sent an answer the hub could not read' })
    await expect(adapter.readState!(ctx)).rejects.toThrow(/could not read/)
    await expect(adapter.scanWifi!(ctx)).rejects.toThrow(/could not read/)
  })

  it('a device that never answers gives a plain sentence within the time allowed for one check', async () => {
    server = await mockServer(() => {
      /* accepts the connection and stays silent */
    })
    const timeoutMs = 300
    const started = Date.now()
    const res = await adapter.probe(ctxFor('switch', {}, { timeoutMs }))
    expect(Date.now() - started).toBeLessThan(timeoutMs + 500)
    expect(res).toEqual({ ok: false, latencyMs: null, error: 'The Shelly did not answer in time' })
  })

  it('a slow device with a password: the check, login included, still ends inside the time allowed', async () => {
    const sim = gen2Device({ password: 'gate-pass' })
    server = await mockServer(async (req, res, raw) => {
      await new Promise((r) => setTimeout(r, 220))
      return sim.handler(req, res, raw)
    })
    const timeoutMs = 500
    const started = Date.now()
    const res = await adapter.probe(ctxFor('switch', { password: 'gate-pass' }, { timeoutMs }))
    expect(Date.now() - started).toBeLessThan(timeoutMs + 500)
    expect(res).toMatchObject({ ok: false, error: 'The Shelly did not answer in time' })
    // The login that could not be finished in time was not sent, so nothing is left half-done on the device.
    expect(sim.auth!.stats.rejected).toBe(0)
  })

  it('goes back to the plain connection when the address stops answering over HTTPS (another device took it)', async () => {
    const newer = gen2Device()
    const older = gen1Device()
    tls = await tlsServer(newer.handler)
    const tlsPort = tls.port
    let redirect = true
    server = await mockServer((req, res, raw) => {
      if (redirect) {
        res.writeHead(301, { Location: `https://127.0.0.1:${tlsPort}${req.url}` })
        return void res.end()
      }
      return older.handler(req, res, raw)
    })
    const ctx = ctxFor('switch')
    expect((await adapter.probe(ctx)).info).toMatchObject({ generation: 'gen2' })

    // The firmware-1.8 Shelly is gone; a first-generation one now has this address and speaks plain HTTP.
    await tls.close()
    tls = null
    redirect = false
    const probe = await adapter.probe(ctx)
    expect(probe.ok).toBe(true)
    expect(probe.info).toMatchObject({ generation: 'gen1', model: 'SHSW-1' })
    expect(await adapter.execute(ctx, makeAction('power.on'))).toMatchObject({ ok: true, state: { power: true } })
    expect(server.requests.at(-1)!.url).toBe('/relay/0?turn=on')
    expect(older.ison).toBe(true)
  })

  it('first generation, separate relays: open and close each press their own relay with a timed pulse', async () => {
    server = await mockServer(gen1Device({ type: 'SHSW-25' }).handler)
    const ctx = ctxFor('gate', { gateMode: 'separate-relays', channel: 0, closeChannel: 1, pulseMs: 2000 })
    expect(await adapter.execute(ctx, makeAction('gate.open'))).toMatchObject({ ok: true, result: { relay: 0, pulseSeconds: 2 } })
    expect(await adapter.execute(ctx, makeAction('gate.close'))).toMatchObject({ ok: true, result: { relay: 1, pulseSeconds: 2 } })
    expect(calls().map((r) => `${r.method} ${r.url}`)).toEqual(['GET /relay/0?turn=on&timer=2', 'GET /relay/1?turn=on&timer=2'])
  })

  it('first generation: a gate behind a password is pressed with HTTP Basic, and a wrong password presses nothing', async () => {
    const sim = gen1Device({ auth: { username: 'owner', password: 's3cret' } })
    server = await mockServer(sim.handler)
    const good = await adapter.execute(ctxFor('gate', { username: 'owner', password: 's3cret' }), makeAction('gate.pulse'))
    expect(good).toMatchObject({ ok: true, result: { relay: 0, pulseSeconds: 1 } })
    expect(sim.ison).toBe(true)

    sim.ison = false
    resetShellyState()
    const bad = await adapter.execute(ctxFor('gate', { username: 'owner', password: 'nope' }), makeAction('gate.pulse'))
    expect(bad).toEqual({ ok: false, error: 'Wrong username or password' })
    expect(sim.ison).toBe(false)
  })

  it('WiFi move: a wrong device password is reported, and no WiFi password ends up in any message', async () => {
    server = await mockServer(gen1Device({ auth: { username: 'admin', password: 'devpass' } }).handler)
    const wifi = { wifi_home: { ssid: 'Home WiFi', password: 'home-secret-1' } }
    const ctx = ctxFor('switch', { password: 'not-it' }, { path: { wifiNetworkId: 'wifi_home' }, wifi })
    const res = await adapter.setWifi!(ctx, { ssid: 'Backup 4G', password: 'backup-secret-2' })
    expect(res).toEqual({ ok: false, error: 'Wrong username or password' })
    // The new network was never written.
    expect(server.requests.some((r) => r.path === '/settings/sta')).toBe(false)

    // Unreachable: thrown (the hub reports it), still without any password in the text. A Shelly
    // that was never reached must not come back as "told to move, reply lost".
    const port = server.port
    await server.close()
    server = null
    resetShellyState()
    const gone = makeCtx({ family: 'shelly', kind: 'switch', config: { generation: 'gen2', password: 'devpass' }, path: { port, wifiNetworkId: 'wifi_home' }, wifi })
    const err = await adapter.setWifi!(gone, { ssid: 'Backup 4G', password: 'backup-secret-2' }).then(
      () => null,
      (e: Error) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/refused the connection|closed the connection/)
    expect(err!.message).not.toMatch(/secret|devpass/)
  })

  it('WiFi move: a Shelly that does not answer is never reported as moved', async () => {
    // Accepts the connection, then drops it: from the outside the same as a reply lost on the way.
    server = await mockServer((_req, _res, raw) => void raw.socket.destroy())
    const ctx = ctxFor('switch', { generation: 'gen2' })
    await expect(adapter.setWifi!(ctx, { ssid: 'Backup 4G', password: 'backup-secret-2' })).rejects.toThrow(/closed the connection/)
    // Only the open identification call went out; the WiFi password was not sent into the void.
    expect(server.requests.map((r) => `${r.method} ${r.url} ${r.body}`)).toEqual(['GET /shelly '])
  })

  it('WiFi move: no WiFi password is sent to something that is not a Shelly', async () => {
    server = await mockServer((_req, res) => send(res, 200, '<html>router</html>', 'text/html'))
    for (const generation of ['auto', 'gen1', 'gen2']) {
      const ctx = ctxFor('switch', { generation }, { path: { wifiNetworkId: 'wifi_home' }, wifi: { wifi_home: { ssid: 'Home WiFi', password: 'home-secret-1' } } })
      const res = await adapter.setWifi!(ctx, { ssid: 'Backup 4G', password: 'backup-secret-2' })
      expect(res).toEqual({ ok: false, error: 'Something answers at this address, but it is not a Shelly' })
    }
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /shelly', 'GET /shelly', 'GET /shelly'])
    expect(server.requests.every((r) => r.body === '')).toBe(true)
  })

  it('first generation WiFi move: a lost reply after /settings/sta went out counts as sent', async () => {
    const sim = gen1Device()
    server = await mockServer((req, res, raw) => {
      // The Shelly drops off the old network before its answer gets out.
      if (req.path === '/settings/sta') return void raw.socket.destroy()
      return sim.handler(req, res, raw)
    })
    const ctx = ctxFor('switch', {}, { path: { wifiNetworkId: 'wifi_home' }, wifi: { wifi_home: { ssid: 'Home WiFi', password: 'home-secret-1' } } })
    const res = await adapter.setWifi!(ctx, { ssid: 'Backup 4G', password: 'backup-secret-2' })
    expect(res).toEqual({ ok: true, result: { ssid: 'Backup 4G', fallback: 'Home WiFi', replied: false }, state: { wifi: 'Backup 4G' } })
    expect(calls().map((r) => `${r.method} ${r.url}`)).toEqual(['POST /settings/sta1', 'POST /settings/sta'])
  })

  it('discover() keeps only the Shellys from the hub’s network scan', async () => {
    mdnsScanMock.mockResolvedValueOnce([
      { family: 'shelly', kind: 'switch', name: 'shellypro4pm-f008d1d8b8b8', host: '192.168.1.40', port: 80, detail: 'gen=2 app=FourPro ver=0.6.7', config: { generation: 'gen2' } },
      { family: 'tasmota', kind: 'switch', name: 'tasmota-3D5E26', host: '192.168.1.41', port: 80, detail: '', config: {} },
    ])
    const found = await adapter.discover!(2, makeCtx({ family: 'shelly', kind: 'switch' }).log)
    expect(mdnsScanMock).toHaveBeenCalledWith(2, expect.anything())
    expect(found).toEqual([
      { family: 'shelly', kind: 'switch', name: 'shellypro4pm-f008d1d8b8b8', host: '192.168.1.40', port: 80, detail: 'gen=2 app=FourPro ver=0.6.7', config: { generation: 'gen2' } },
    ])
  })
})
