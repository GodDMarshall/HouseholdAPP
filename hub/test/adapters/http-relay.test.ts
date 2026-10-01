/**
 * http-relay adapter against mock devices that answer with the payload shapes
 * recorded in docs/protocols (Shelly 1 Gen1 REST, Shelly Gen2 RPC with its
 * SHA-256 digest challenge, Tasmota /cm, Sonoff DIY-mode POST) — the kinds of
 * "plain URL" relays this generic adapter is for.
 */
import crypto from 'node:crypto'
import type http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { DeviceKind } from '@house/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import adapter, { addressFor, matchesRule, resetHttpRelayRuntime } from '../../src/adapters/http-relay.ts'
import { basicGuard, makeAction, makeCtx, mockServer, send, type CtxOptions, type MockHandler, type MockServer, type RecordedRequest } from '../helpers.ts'

let server: MockServer | null = null
let extra: Array<() => Promise<void>> = []

beforeEach(() => resetHttpRelayRuntime())
afterEach(async () => {
  vi.restoreAllMocks()
  await server?.close()
  server = null
  for (const close of extra) await close()
  extra = []
})

/**
 * A device that is on the network but does not answer with proper HTTP. Every
 * request that arrives is recorded (so the "relay" has acted on it) and
 * `answer` decides what goes back.
 */
function rawDevice(answer: (socket: net.Socket) => void): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = []
  const sockets = new Set<net.Socket>()
  const srv = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    socket.once('data', (chunk) => {
      hits.push(chunk.toString('latin1').split('\r\n')[0] ?? '')
      answer(socket)
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      extra.push(
        () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy()
            srv.close(() => done())
          }),
      )
      resolve({ port: (srv.address() as net.AddressInfo).port, hits })
    })
  })
}

/** A throwaway self-signed certificate (CN relay-board.test), like the one a relay board serves on https. Used only by the mock below. */
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg9J8Z5YMTa79Mq4+T
HqxjKnC3oOXMZ2OxHLD4QnBFcDWhRANCAAQxx5TDhCbDFeHtCA3UOmXv0kKEi7Ol
91mshVeUBq+tOa4PDNxQ98nlY3UZWd1d8DEUT3XWaP4X40iBq87YwcIS
-----END PRIVATE KEY-----`
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIBnzCCAUSgAwIBAgIUbsD0ygr3aLVtd0uCI9/JpF17yYMwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQcmVsYXktYm9hcmQudGVzdDAgFw0yNjEwMDExMjQ0MDNaGA8y
MTI2MDkwNzEyNDQwM1owGzEZMBcGA1UEAwwQcmVsYXktYm9hcmQudGVzdDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABDHHlMOEJsMV4e0IDdQ6Ze/SQoSLs6X3WayF
V5QGr605rg8M3FD3yeVjdRlZ3V3wMRRPddZo/hfjSIGrztjBwhKjZDBiMB0GA1Ud
DgQWBBRZeJpoJ9hLUWlCXsxRID1qMdssPDAfBgNVHSMEGDAWgBRZeJpoJ9hLUWlC
XsxRID1qMdssPDAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwCgYI
KoZIzj0EAwIDSQAwRgIhANjYZMJqsxSVPedgkZlh4kDuVaCwiOgdo/SNXUhf9qOw
AiEA8Iu9k7GsRKsiI0EW+YuOfdWwzXXNfUOTbQdh+kP+xgw=
-----END CERTIFICATE-----`

/** A mock device behind https with a self-signed certificate. */
function httpsDevice(handler: MockHandler): Promise<{ port: number; urls: string[] }> {
  const urls: string[] = []
  const srv = https.createServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (raw, res) => {
    const u = new URL(raw.url ?? '/', 'https://mock')
    urls.push(`${raw.method} ${raw.url}`)
    const req: RecordedRequest = { method: raw.method ?? 'GET', url: raw.url ?? '/', path: u.pathname, query: u.searchParams, headers: raw.headers, body: '' }
    void handler(req, res, raw)
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      extra.push(
        () =>
          new Promise<void>((done) => {
            srv.closeAllConnections?.()
            srv.close(() => done())
          }),
      )
      resolve({ port: (srv.address() as net.AddressInfo).port, urls })
    })
  })
}

function ctxFor(s: MockServer, config: Record<string, unknown>, kind: DeviceKind = 'switch', extra: Partial<CtxOptions> = {}) {
  return makeCtx({ family: 'http-relay', kind, config, path: { port: s.port }, ...extra })
}

/** Requests the mock saw, as "METHOD /path?query". */
function wire(s: MockServer): string[] {
  return s.requests.map((r) => `${r.method} ${r.url}`)
}

async function closedPort(): Promise<number> {
  const s = await mockServer((_req, res) => send(res, 200, 'ok'))
  const port = s.port
  await s.close()
  return port
}

// ---------------------------------------------------------------------------
// Mock devices (payloads from docs/protocols/lights-tasmota-shelly-tuya.md and gate-control.md)
// ---------------------------------------------------------------------------

/** Shelly 1 (Gen1): /relay/0?turn=on|off|toggle[&timer=s], /status, /reboot. HTTP Basic when a login is set. */
function shelly1(opts: { login?: [string, string] } = {}) {
  const dev = { ison: false, input: 0, turns: [] as Array<{ turn: string; at: number }> }
  const guard = opts.login ? basicGuard(opts.login[0], opts.login[1]) : null
  const handler: MockHandler = (req, res) => {
    if (guard && !guard(req, res)) return
    if (req.path === '/relay/0') {
      const turn = req.query.get('turn')
      if (turn === 'on') dev.ison = true
      else if (turn === 'off') dev.ison = false
      else if (turn === 'toggle') dev.ison = !dev.ison
      if (turn) dev.turns.push({ turn, at: performance.now() })
      const timer = Number(req.query.get('timer') ?? 0)
      // Shelly 1 attribute list per the reviewed notes: there is no "power", and "overpower" exists only on the 1PM.
      return send(res, 200, { ison: dev.ison, has_timer: timer > 0, timer_started: 0, timer_duration: timer, timer_remaining: timer, source: 'http' })
    }
    if (req.path === '/status') {
      return send(res, 200, {
        wifi_sta: { connected: true, ssid: 'HomeWiFi', ip: '192.168.1.60', rssi: -61 },
        cloud: { enabled: false, connected: false },
        mqtt: { connected: false },
        relays: [{ ison: dev.ison, has_timer: false, timer_started: 0, timer_duration: 0, timer_remaining: 0, source: 'http' }],
        inputs: [{ input: dev.input, event: '', event_cnt: 0 }],
        uptime: 4021,
      })
    }
    if (req.path === '/reboot') return send(res, 200, {})
    send(res, 404, 'Not Found')
  }
  return { dev, handler }
}

/** Tasmota: GET /cm?cmnd=… ; with a web password: Basic auth or user=/password= in the query, else 401 + WARNING body and no challenge header. */
function tasmota(webPassword?: string) {
  const dev = { power: false, switch1: 'ON' }
  const handler: MockHandler = (req, res) => {
    if (req.path !== '/cm') return send(res, 404, 'Not Found')
    if (webPassword) {
      const basicOk = req.headers.authorization === 'Basic ' + Buffer.from(`admin:${webPassword}`).toString('base64')
      const queryOk = req.query.get('user') === 'admin' && req.query.get('password') === webPassword
      if (!basicOk && !queryOk) return send(res, 401, { WARNING: 'Need user=<username>&password=<password>' })
    }
    const cmnd = (req.query.get('cmnd') ?? '').trim()
    if (!cmnd) return send(res, 200, { WARNING: 'Enter command cmnd=' })
    const power = /^power(1?)(?:\s+(\S+))?$/i.exec(cmnd)
    if (power) {
      const v = (power[2] ?? '').toUpperCase()
      if (v === 'ON' || v === '1') dev.power = true
      else if (v === 'OFF' || v === '0') dev.power = false
      else if (v === 'TOGGLE' || v === '2') dev.power = !dev.power
      return send(res, 200, { [`POWER${power[1]}`]: dev.power ? 'ON' : 'OFF' })
    }
    if (/^status\s+10$/i.test(cmnd)) return send(res, 200, { StatusSNS: { Time: '2026-10-01T09:15:00', Switch1: dev.switch1 } })
    send(res, 200, { Command: 'Unknown' })
  }
  return { dev, handler }
}

/** The Shelly Gen2 challenge: RFC 7616 digest, SHA-256, user admin, realm = device id. */
function shellyDigestGuard(password: string, realm = 'shellyplus1-a8032abe54dc') {
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
  return (req: RecordedRequest, res: http.ServerResponse): boolean => {
    const header = req.headers.authorization ?? ''
    if (/^digest/i.test(header)) {
      const p: Record<string, string> = {}
      const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g
      let m: RegExpExecArray | null
      while ((m = re.exec(header))) p[m[1]!] = (m[2] ?? m[3] ?? '').trim()
      const ha1 = sha(`admin:${realm}:${password}`)
      const ha2 = sha(`${req.method}:${p.uri}`)
      const expected = sha(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`)
      if (p.username === 'admin' && p.algorithm === 'SHA-256' && p.uri === req.url && p.response === expected) return true
    }
    res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth", realm="${realm}", nonce="1625038762", algorithm=SHA-256` })
    res.end()
    return false
  }
}

/** Shelly Gen2+: /rpc/Switch.Set, Switch.Toggle, Switch.GetStatus, Input.GetStatus (reed on the SW input: true = closed). */
function shellyGen2(opts: { password?: string } = {}) {
  const dev = { output: false, reedClosed: true, sets: [] as string[] }
  const guard = opts.password ? shellyDigestGuard(opts.password) : null
  const handler: MockHandler = (req, res) => {
    if (guard && !guard(req, res)) return
    switch (req.path) {
      case '/rpc/Switch.Set': {
        const was = dev.output
        dev.sets.push(req.query.toString())
        if (!req.query.get('toggle_after')) dev.output = req.query.get('on') === 'true'
        return send(res, 200, { was_on: was })
      }
      case '/rpc/Switch.Toggle': {
        const was = dev.output
        dev.output = !dev.output
        return send(res, 200, { was_on: was })
      }
      case '/rpc/Switch.GetStatus':
        return send(res, 200, { id: 0, source: 'HTTP', output: dev.output, timer_started_at: 1626935739.79, timer_duration: 1 })
      case '/rpc/Input.GetStatus':
        return send(res, 200, { id: 0, state: dev.reedClosed })
      case '/rpc': {
        // POST form from the notes: {"id":1,"src":"housecontrol","method":"Switch.Set","params":{"id":0,"on":true}}
        const frame = JSON.parse(req.body) as { id: number; src?: string; method?: string; params?: { id?: number; on?: boolean } }
        const head = { id: frame.id, src: 'shellyplus1-a8032abe54dc', dst: frame.src }
        if (frame.method !== 'Switch.Set' || typeof frame.params?.on !== 'boolean') {
          return send(res, 200, { ...head, error: { code: -105, message: "Argument 'on', value not found!" } })
        }
        const was = dev.output
        dev.output = frame.params.on
        return send(res, 200, { ...head, result: { was_on: was } })
      }
      default:
        return send(res, 404, 'Not Found')
    }
  }
  return { dev, handler }
}

/** Sonoff DIY mode: POST /zeroconf/switch and /zeroconf/info with {deviceid, data}. */
function sonoffDiy() {
  const dev = { switch: 'off', seq: 0 }
  const handler: MockHandler = (req, res) => {
    if (req.method !== 'POST') return send(res, 404, 'Not Found')
    let frame: { deviceid?: string; data?: { switch?: string } }
    try {
      frame = JSON.parse(req.body) as typeof frame
    } catch {
      return send(res, 200, { seq: ++dev.seq, error: 400 })
    }
    if (req.path === '/zeroconf/switch') {
      if (frame.data?.switch !== 'on' && frame.data?.switch !== 'off') return send(res, 200, { seq: ++dev.seq, error: 422 })
      dev.switch = frame.data.switch
      return send(res, 200, { seq: ++dev.seq, error: 0, data: {} })
    }
    if (req.path === '/zeroconf/info') {
      return send(res, 200, { seq: ++dev.seq, error: 0, data: { switch: dev.switch, startup: 'stay', pulse: 'on', pulseWidth: 1000, ssid: 'HomeWiFi', otaUnlock: true } })
    }
    send(res, 404, 'Not Found')
  }
  return { dev, handler }
}

const SHELLY1 = {
  onPath: '/relay/0?turn=on',
  offPath: '/relay/0?turn=off',
  togglePath: '/relay/0?turn=toggle',
  statePath: '/status',
  stateOnMatch: 'relays.0.ison=true',
}

// ---------------------------------------------------------------------------

describe('http-relay: add-device form and capabilities', () => {
  it('describes itself in plain words', () => {
    const d = adapter.describe()
    expect(adapter.family).toBe('http-relay')
    expect(d.id).toBe('http-relay')
    expect(d.kinds).toEqual(['light', 'switch', 'gate'])
    expect(d.pathKinds).toEqual(['lan', 'cellular'])
    expect(d.defaultPort).toBe(80)
    const names = d.fields.map((f) => f.name)
    for (const name of [
      'onPath', 'offPath', 'togglePath', 'pulsePath', 'statePath', 'stateOnMatch', 'method', 'body', 'username', 'password', 'https',
      'pulseMs', 'gateMode', 'openPath', 'closePath', 'stopPath', 'gateStatePath', 'gateClosedMatch', 'rebootPath',
    ]) {
      expect(names).toContain(name)
    }
    expect(new Set(names).size).toBe(names.length)
    const field = (name: string) => d.fields.find((f) => f.name === name)!
    expect(field('password').secret).toBe(true)
    expect(field('password').type).toBe('password')
    expect(field('method').options?.map((o) => o.value)).toEqual(['GET', 'POST'])
    expect(field('method').default).toBe('GET')
    expect(field('gateMode').options?.map((o) => o.value)).toEqual(['button', 'separate'])
    expect(field('pulseMs').default).toBe(800)
    expect(field('https').default).toBe(false)
    expect(field('body').showWhen).toEqual({ field: 'method', equals: 'POST' })
    expect(field('openPath').showWhen).toEqual({ field: 'gateMode', equals: 'separate' })
    expect(d.notes.length).toBeGreaterThan(3)
    const visible = [d.label, d.tagline, ...d.notes, ...d.fields.flatMap((f) => [f.label, f.help ?? '', ...(f.options ?? []).map((o) => o.label)])].join('\n')
    expect(visible).not.toMatch(/\b(demo|prototype|placeholder|stub|todo)\b/i)
  })

  it('offers only what the settings can back up', () => {
    expect(adapter.capabilities({}, 'switch')).toEqual(['power'])
    expect(adapter.capabilities({ statePath: '/status' }, 'light')).toEqual(['power'])
    expect(adapter.capabilities({ statePath: '/status', stateOnMatch: 'relays.0.ison=true' }, 'light')).toEqual(['power', 'state'])
    expect(adapter.capabilities({ rebootPath: '/reboot' }, 'switch')).toEqual(['power', 'reboot'])
    expect(adapter.capabilities({ pulsePath: '/relay/0?turn=on&timer=1' }, 'gate')).toEqual(['gate'])
    expect(adapter.capabilities({ gateStatePath: '/rpc/Input.GetStatus?id=0' }, 'gate')).toEqual(['gate'])
    expect(adapter.capabilities({ gateStatePath: '/rpc/Input.GetStatus?id=0', gateClosedMatch: 'state=true' }, 'gate')).toEqual(['gate', 'gate-state', 'state'])
    // A relay status address does not tell where the gate is.
    expect(adapter.capabilities({ statePath: '/status', stateOnMatch: 'ison' }, 'gate')).toEqual(['gate'])
  })

  it('has no camera, WiFi-move or scan functions', () => {
    expect(adapter.snapshot).toBeUndefined()
    expect(adapter.streamSources).toBeUndefined()
    expect(adapter.setWifi).toBeUndefined()
    expect(adapter.scanWifi).toBeUndefined()
  })
})

describe('http-relay: reading status answers', () => {
  const shellyRelay = '{"ison":true,"has_timer":false,"timer_started":0,"timer_duration":0,"timer_remaining":0,"source":"http"}'
  const shellyStatus = '{"relays":[{"ison":false,"has_timer":false}],"inputs":[{"input":1,"event":"","event_cnt":0}]}'

  it('matches a named value in a JSON answer', () => {
    expect(matchesRule('{"POWER":"ON"}', 'POWER=ON')).toBe(true)
    expect(matchesRule('{"POWER":"OFF"}', 'POWER=ON')).toBe(false)
    expect(matchesRule('{"POWER":"ON"}', 'power=on')).toBe(false) // key names are exact, values are not case-sensitive
    expect(matchesRule('{"POWER":"ON"}', 'POWER=on')).toBe(true)
    expect(matchesRule('{"POWER1":"ON"}', 'POWER=ON')).toBe(false)
    expect(matchesRule(shellyRelay, 'ison=true')).toBe(true)
    expect(matchesRule(shellyStatus, 'relays.0.ison=true')).toBe(false)
    expect(matchesRule(shellyStatus, 'relays[0].ison=false')).toBe(true)
    expect(matchesRule(shellyStatus, 'inputs.0.input=1')).toBe(true)
    expect(matchesRule('{"id":0,"state":true}', 'state=true')).toBe(true)
    expect(matchesRule('{"id":0,"source":"HTTP","output":true,"timer_duration":1}', 'output = true')).toBe(true)
    expect(matchesRule('{"seq":2,"error":0,"data":{"switch":"on","startup":"stay"}}', 'data.switch="on"')).toBe(true)
    expect(matchesRule('{"StatusSNS":{"Time":"2026-10-01T09:15:00","Switch1":"OFF"}}', 'StatusSNS.Switch1=ON')).toBe(false)
    expect(matchesRule('{"id":0,"state":true}', 'missing.key=true')).toBe(false)
  })

  it('matches plain text and patterns', () => {
    expect(matchesRule('{"POWER":"ON"}', '"POWER":"ON"')).toBe(true)
    expect(matchesRule('{"POWER":"OFF"}', '"power":"on"')).toBe(false)
    expect(matchesRule('relay=on;uptime=12', 'relay=on')).toBe(true) // not JSON: falls back to plain text
    expect(matchesRule('relay=off;uptime=12', 'relay=on')).toBe(false)
    expect(matchesRule(shellyRelay, '/"ison":\\s*true/')).toBe(true)
    expect(matchesRule('{"POWER":"on"}', '/"POWER":"ON"/')).toBe(false)
    expect(matchesRule('{"POWER":"on"}', '/"POWER":"ON"/i')).toBe(true)
    expect(matchesRule('anything', '')).toBe(false)
    expect(() => matchesRule('x', '/([a-z/')).toThrow(/not a valid pattern/)
  })
})

describe('http-relay: probe', () => {
  it('reads the status address and nothing else', async () => {
    const { dev, handler } = shelly1()
    dev.ison = true
    server = await mockServer(handler)
    const res = await adapter.probe(ctxFor(server, SHELLY1))
    expect(res.ok).toBe(true)
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)
    expect(res.info).toEqual({ power: true })
    expect(wire(server)).toEqual(['GET /status'])
    expect(dev.turns).toEqual([])
  })

  it('reads the status address as a plain link even when commands are posted', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    const res = await adapter.probe(ctxFor(server, { ...SHELLY1, method: 'POST', body: 'turn=on' }))
    expect(res.ok).toBe(true)
    expect(server.requests[0]!.method).toBe('GET')
    expect(server.requests[0]!.body).toBe('')
  })

  it('only checks the port when there is no status address — no request reaches the relay', async () => {
    const { dev, handler } = shelly1()
    server = await mockServer(handler)
    const res = await adapter.probe(ctxFor(server, { onPath: SHELLY1.onPath, offPath: SHELLY1.offPath, togglePath: SHELLY1.togglePath }))
    expect(res.ok).toBe(true)
    expect(typeof res.latencyMs).toBe('number')
    expect(server.requests).toEqual([])
    expect(dev.turns).toEqual([])
  })

  it('checks the port the commands really use when the address is written out in full', async () => {
    const { handler } = sonoffDiy()
    server = await mockServer(handler)
    const dead = await closedPort()
    const config = { onPath: `POST http://{host}:${server.port}/zeroconf/switch {"deviceid":"1000a1b2c3","data":{"switch":"on"}}` }
    // The connection's own port is closed; the command port is the one that matters.
    const res = await adapter.probe(makeCtx({ family: 'http-relay', kind: 'switch', config, path: { port: dead } }))
    expect(res.ok).toBe(true)
    expect(server.requests).toEqual([])
  })

  it('says so when the login is wrong', async () => {
    const { handler } = shelly1({ login: ['admin', 'relay-pass'] })
    server = await mockServer(handler)
    const good = await adapter.probe(ctxFor(server, { ...SHELLY1, username: 'admin', password: 'relay-pass' }))
    expect(good.ok).toBe(true)
    const bad = await adapter.probe(ctxFor(server, { ...SHELLY1, username: 'admin', password: 'not-it' }))
    expect(bad).toEqual({ ok: false, latencyMs: null, error: 'Wrong username or password' })
    const none = await adapter.probe(ctxFor(server, SHELLY1))
    expect(none.error).toBe('Wrong username or password')
    expect(server.requests.every((r) => r.path === '/status')).toBe(true)
  })

  it('reports an unreachable device plainly', async () => {
    const port = await closedPort()
    const withStatus = await adapter.probe(makeCtx({ family: 'http-relay', kind: 'switch', config: SHELLY1, path: { port } }))
    expect(withStatus.ok).toBe(false)
    expect(withStatus.latencyMs).toBeNull()
    expect(withStatus.error).toMatch(/refused the connection/)
    const withoutStatus = await adapter.probe(makeCtx({ family: 'http-relay', kind: 'switch', config: { onPath: '/relay/0?turn=on' }, path: { port } }))
    expect(withoutStatus.ok).toBe(false)
    expect(withoutStatus.error).toMatch(/refused|did not answer/)
  })

  it('reports a device that never answers as a plain sentence', async () => {
    server = await mockServer(() => {
      /* accepts the connection and stays silent */
    })
    const res = await adapter.probe(ctxFor(server, SHELLY1, 'switch', { timeoutMs: 300 }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/^127\.0\.0\.1:\d+ did not answer within 0\.3 seconds$/)
  })

  it('points at the status address when the device does not know it', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    const res = await adapter.probe(ctxFor(server, { ...SHELLY1, statePath: '/state' }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/nothing at the status address \(HTTP 404\)/)
  })

  it('suggests HTTPS when the device redirects', async () => {
    server = await mockServer((_req, res) => {
      res.writeHead(301, { Location: 'https://127.0.0.1/status' })
      res.end()
    })
    const res = await adapter.probe(ctxFor(server, SHELLY1))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/HTTP 301/)
    expect(res.error).toMatch(/Use HTTPS/)
  })

  it('needs an address on the connection', async () => {
    const res = await adapter.probe(makeCtx({ family: 'http-relay', kind: 'switch', config: SHELLY1, path: { host: '', label: 'Backup WiFi' } }))
    expect(res).toEqual({ ok: false, latencyMs: null, error: 'No address set on the "Backup WiFi" connection' })
  })

  it('reads the gate sensor for a gate', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(handler)
    const config = { pulsePath: '/rpc/Switch.Set?id=0&on=true&toggle_after=1', gateStatePath: '/rpc/Input.GetStatus?id=0', gateClosedMatch: 'state=true' }
    expect((await adapter.probe(ctxFor(server, config, 'gate'))).info).toEqual({ gate: 'closed' })
    dev.reedClosed = false
    expect((await adapter.probe(ctxFor(server, config, 'gate'))).info).toEqual({ gate: 'open' })
    expect(wire(server)).toEqual(['GET /rpc/Input.GetStatus?id=0', 'GET /rpc/Input.GetStatus?id=0'])
    expect(dev.sets).toEqual([])
  })
})

describe('http-relay: state', () => {
  it('reads power without switching anything', async () => {
    const { dev, handler } = shelly1()
    server = await mockServer(handler)
    const ctx = ctxFor(server, SHELLY1, 'light')
    expect(await adapter.readState!(ctx)).toEqual({ power: false })
    dev.ison = true
    expect(await adapter.readState!(ctx)).toEqual({ power: true })
    expect(wire(server)).toEqual(['GET /status', 'GET /status'])
    expect(dev.turns).toEqual([])
  })

  it('reads a Tasmota relay with the password filled into the address', async () => {
    const { dev, handler } = tasmota('s3cr&t pw')
    dev.power = true
    server = await mockServer(handler)
    const ctx = ctxFor(server, {
      statePath: '/cm?user={user}&password={pass}&cmnd=Power',
      stateOnMatch: 'POWER=ON',
      username: 'admin',
      password: 's3cr&t pw',
    })
    expect(await adapter.readState!(ctx)).toEqual({ power: true })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]!.url).toBe('/cm?user=admin&password=s3cr%26t%20pw&cmnd=Power')
  })

  it('returns nothing when there is no status address, and asks the device nothing', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    expect(await adapter.readState!(ctxFor(server, { onPath: SHELLY1.onPath, offPath: SHELLY1.offPath }))).toEqual({})
    expect(await adapter.readState!(ctxFor(server, { pulsePath: '/relay/0?turn=on&timer=1' }, 'gate'))).toEqual({})
    expect(server.requests).toEqual([])
  })

  it('fails with a plain message when the status cannot be read', async () => {
    const { handler } = shelly1({ login: ['admin', 'relay-pass'] })
    server = await mockServer(handler)
    await expect(adapter.readState!(ctxFor(server, { ...SHELLY1, username: 'admin', password: 'wrong-one' }))).rejects.toThrow('Wrong username or password')
    const port = await closedPort()
    await expect(adapter.readState!(makeCtx({ family: 'http-relay', kind: 'switch', config: SHELLY1, path: { port } }))).rejects.toThrow(/refused the connection/)
  })
})

describe('http-relay: lights and switches', () => {
  it('switches on and off with the exact addresses', async () => {
    const { dev, handler } = shelly1()
    server = await mockServer(handler)
    const ctx = ctxFor(server, SHELLY1, 'light')
    const on = await adapter.execute(ctx, makeAction('power.on'))
    expect(on).toEqual({ ok: true, state: { power: true } })
    expect(dev.ison).toBe(true)
    const off = await adapter.execute(ctx, makeAction('power.off'))
    expect(off).toEqual({ ok: true, state: { power: false } })
    expect(dev.ison).toBe(false)
    expect(wire(server)).toEqual(['GET /relay/0?turn=on', 'GET /relay/0?turn=off'])
    const first = server.requests[0]!
    expect(first.method).toBe('GET')
    expect(first.path).toBe('/relay/0')
    expect(first.query.get('turn')).toBe('on')
    expect(first.body).toBe('')
    expect(first.headers.host).toBe(`127.0.0.1:${server.port}`)
    expect(first.headers.authorization).toBeUndefined()
  })

  it('uses the address of the connection in use, including a SIM port-forward', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    const ctx = makeCtx({
      family: 'http-relay',
      kind: 'switch',
      config: { onPath: 'http://{host}:{port}/relay/0?turn=on', offPath: 'relay/0?turn=off' },
      path: { kind: 'cellular', label: 'SIM', host: '127.0.0.1', port: server.port },
    })
    expect((await adapter.execute(ctx, makeAction('power.on'))).ok).toBe(true)
    expect((await adapter.execute(ctx, makeAction('power.off'))).ok).toBe(true)
    expect(wire(server)).toEqual(['GET /relay/0?turn=on', 'GET /relay/0?turn=off'])
  })

  it('refuses an address written out in full without {host}', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    const res = await adapter.execute(ctxFor(server, { onPath: `http://127.0.0.1:${server.port}/relay/0?turn=on` }), makeAction('power.on'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/\{host\}/)
    expect(server.requests).toEqual([])
  })

  it('logs in with HTTP Basic when the device asks for it', async () => {
    const { dev, handler } = shelly1({ login: ['admin', 'relay-pass'] })
    server = await mockServer(handler)
    const res = await adapter.execute(ctxFor(server, { ...SHELLY1, username: 'admin', password: 'relay-pass' }), makeAction('power.on'))
    expect(res).toEqual({ ok: true, state: { power: true } })
    expect(dev.turns.map((t) => t.turn)).toEqual(['on'])
    expect(server.requests.at(-1)!.headers.authorization).toBe('Basic ' + Buffer.from('admin:relay-pass').toString('base64'))
  })

  it('reports a wrong password without repeating it', async () => {
    const { dev, handler } = shelly1({ login: ['admin', 'relay-pass'] })
    server = await mockServer(handler)
    const res = await adapter.execute(ctxFor(server, { ...SHELLY1, username: 'admin', password: 'hunter2-wrong' }), makeAction('power.on'))
    expect(res).toEqual({ ok: false, error: 'Wrong username or password' })
    expect(JSON.stringify(res)).not.toContain('hunter2')
    expect(dev.turns).toEqual([])
  })

  it('logs in to a Tasmota that answers 401 without naming a login scheme', async () => {
    const { dev, handler } = tasmota('webpw')
    server = await mockServer(handler)
    const config = { onPath: '/cm?cmnd=Power ON', offPath: '/cm?cmnd=Power OFF', statePath: '/cm?cmnd=Power', stateOnMatch: 'POWER=ON', username: 'admin', password: 'webpw' }
    const res = await adapter.execute(ctxFor(server, config), makeAction('power.on'))
    expect(res).toEqual({ ok: true, state: { power: true } })
    expect(dev.power).toBe(true)
    // A space typed into the address goes out as %20, as Tasmota wants it.
    expect(wire(server)).toEqual(['GET /cm?cmnd=Power%20ON', 'GET /cm?cmnd=Power%20ON'])
    expect(server.requests[0]!.headers.authorization).toBeUndefined()
    expect(server.requests[1]!.headers.authorization).toBe('Basic ' + Buffer.from('admin:webpw').toString('base64'))

    const wrong = await adapter.execute(ctxFor(server, { ...config, password: 'nope-nope' }), makeAction('power.off'))
    expect(wrong).toEqual({ ok: false, error: 'Wrong username or password' })
    expect(dev.power).toBe(true)
  })

  it('toggles with the toggle address and then reads what it became', async () => {
    const { dev, handler } = shelly1()
    server = await mockServer(handler)
    const ctx = ctxFor(server, SHELLY1)
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toEqual({ ok: true, state: { power: true } })
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toEqual({ ok: true, state: { power: false } })
    expect(wire(server)).toEqual(['GET /relay/0?turn=toggle', 'GET /status', 'GET /relay/0?turn=toggle', 'GET /status'])
    expect(dev.turns.map((t) => t.turn)).toEqual(['toggle', 'toggle'])
  })

  it('toggles with a toggle address and no status: claims a state only when it knows one', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    const ctx = ctxFor(server, { onPath: SHELLY1.onPath, offPath: SHELLY1.offPath, togglePath: SHELLY1.togglePath })
    const blind = await adapter.execute(ctx, makeAction('power.toggle'))
    expect(blind.ok).toBe(true)
    expect(blind.state).toBeUndefined()
    expect(String(blind.result?.note)).toMatch(/cannot tell/)
    await adapter.execute(ctx, makeAction('power.on'))
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toEqual({ ok: true, state: { power: false } })
  })

  it('without a toggle address, reads the state and sends the opposite', async () => {
    const { dev, handler } = shelly1()
    dev.ison = true
    server = await mockServer(handler)
    const ctx = ctxFor(server, { ...SHELLY1, togglePath: '' })
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toEqual({ ok: true, state: { power: false } })
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toEqual({ ok: true, state: { power: true } })
    expect(wire(server)).toEqual(['GET /status', 'GET /relay/0?turn=off', 'GET /status', 'GET /relay/0?turn=on'])
  })

  it('fails plainly when it can neither toggle nor read the state', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    const res = await adapter.execute(ctxFor(server, { onPath: SHELLY1.onPath, offPath: SHELLY1.offPath }), makeAction('power.toggle'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no toggle address and no status address/)
    expect(server.requests).toEqual([])
  })

  it('fails plainly when an address is missing or unknown to the device', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    const missing = await adapter.execute(ctxFor(server, { onPath: SHELLY1.onPath }), makeAction('power.off'))
    expect(missing).toEqual({ ok: false, error: 'No switch-off address is set for this device' })
    const unknown = await adapter.execute(ctxFor(server, { onPath: '/relay/9/on' }), makeAction('power.on'))
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toMatch(/nothing at the switch-on address \(HTTP 404\)/)
  })

  it('posts the configured text with a length header (Sonoff DIY mode)', async () => {
    const { dev, handler } = sonoffDiy()
    server = await mockServer(handler)
    const ctx = ctxFor(server, {
      method: 'POST',
      onPath: 'POST /zeroconf/switch {"deviceid":"1000a1b2c3","data":{"switch":"on"}}',
      offPath: 'POST /zeroconf/switch {"deviceid":"1000a1b2c3","data":{"switch":"off"}}',
      statePath: 'POST /zeroconf/info {"deviceid":"1000a1b2c3","data":{}}',
      stateOnMatch: 'data.switch=on',
    })
    expect(await adapter.execute(ctx, makeAction('power.on'))).toEqual({ ok: true, state: { power: true } })
    expect(dev.switch).toBe('on')
    const req = server.requests[0]!
    expect(req.method).toBe('POST')
    expect(req.path).toBe('/zeroconf/switch')
    expect(req.body).toBe('{"deviceid":"1000a1b2c3","data":{"switch":"on"}}')
    expect(req.headers['content-type']).toBe('application/json')
    expect(req.headers['content-length']).toBe(String(Buffer.byteLength(req.body)))
    expect(req.headers['transfer-encoding']).toBeUndefined()

    expect(await adapter.readState!(ctx)).toEqual({ power: true })
    expect(server.requests[1]!.method).toBe('POST')
    expect(server.requests[1]!.path).toBe('/zeroconf/info')
    expect(server.requests[1]!.body).toBe('{"deviceid":"1000a1b2c3","data":{}}')

    expect(await adapter.execute(ctx, makeAction('power.off'))).toEqual({ ok: true, state: { power: false } })
    expect(dev.switch).toBe('off')
  })

  it('sends the shared text with every posted command (Shelly Gen1 ignores the method)', async () => {
    const { dev, handler } = shelly1()
    server = await mockServer(handler)
    const ctx = ctxFor(server, { ...SHELLY1, method: 'POST', body: 'source=housecontrol' })
    expect((await adapter.execute(ctx, makeAction('power.on'))).ok).toBe(true)
    expect(dev.ison).toBe(true)
    const req = server.requests[0]!
    expect(`${req.method} ${req.url}`).toBe('POST /relay/0?turn=on')
    expect(req.body).toBe('source=housecontrol')
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(req.headers['content-length']).toBe('19')
  })

  it('posts without any text when none is configured, and lets one address stay a plain link', async () => {
    const { dev, handler } = tasmota()
    server = await mockServer(handler)
    // Tasmota takes its commands in the address either way; the off address is pinned to a plain link.
    const ctx = ctxFor(server, { method: 'POST', onPath: '/cm?cmnd=Power%20ON', offPath: 'GET /cm?cmnd=Power OFF' })
    expect((await adapter.execute(ctx, makeAction('power.on'))).ok).toBe(true)
    expect(dev.power).toBe(true)
    expect((await adapter.execute(ctx, makeAction('power.off'))).ok).toBe(true)
    expect(dev.power).toBe(false)
    expect(wire(server)).toEqual(['POST /cm?cmnd=Power%20ON', 'GET /cm?cmnd=Power%20OFF'])
    const post = server.requests[0]!
    expect(post.body).toBe('')
    expect(post.headers['content-type']).toBeUndefined()
    expect(post.headers['transfer-encoding']).toBeUndefined()
  })

  it('throws on a transport failure so the hub can try another connection', async () => {
    const port = await closedPort()
    const ctx = makeCtx({ family: 'http-relay', kind: 'switch', config: SHELLY1, path: { port } })
    await expect(adapter.execute(ctx, makeAction('power.on'))).rejects.toThrow(/refused the connection/)
    await expect(adapter.execute(ctx, makeAction('power.toggle'))).rejects.toThrow(/refused the connection/)
  })

  it('does not send a toggle twice when the answer is lost', async () => {
    server = await mockServer(() => {
      /* the relay is there but never answers */
    })
    const res = await adapter.execute(ctxFor(server, SHELLY1, 'switch', { timeoutMs: 300 }), makeAction('power.toggle'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cannot tell whether it arrived/)
    expect(wire(server)).toEqual(['GET /relay/0?turn=toggle'])
  })

  it('restarts only when a restart address is set', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    const without = await adapter.execute(ctxFor(server, SHELLY1), makeAction('reboot'))
    expect(without.ok).toBe(false)
    expect(server.requests).toEqual([])
    const res = await adapter.execute(ctxFor(server, { ...SHELLY1, rebootPath: '/reboot' }), makeAction('reboot'))
    expect(res.ok).toBe(true)
    expect(wire(server)).toEqual(['GET /reboot'])
  })

  it('counts a restart as done when the device drops the connection instead of answering', async () => {
    server = await mockServer((_req, _res, incoming) => {
      incoming.socket.destroy()
    })
    const res = await adapter.execute(ctxFor(server, { ...SHELLY1, rebootPath: '/reboot' }), makeAction('reboot'))
    expect(res.ok).toBe(true)
  })

  it('refuses what it cannot do', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    const light = ctxFor(server, SHELLY1, 'light')
    for (const action of [makeAction('dim.set', { brightness: 40 }), makeAction('color.set', { hex: '#ff8800' }), makeAction('ptz.move', { pan: 1 }), makeAction('gate.open'), makeAction('sms.send', { text: 'hi' }), makeAction('custom', {})]) {
      const res = await adapter.execute(light, action)
      expect(res.ok).toBe(false)
      expect(res.error).toContain(action.type)
    }
    const gate = ctxFor(server, { pulsePath: '/relay/0?turn=on&timer=1' }, 'gate')
    expect((await adapter.execute(gate, makeAction('power.on'))).ok).toBe(false)
    expect(server.requests).toEqual([])
  })
})

describe('http-relay: gate with one button', () => {
  const SHELLY2_GATE = {
    gateMode: 'button',
    pulsePath: '/rpc/Switch.Set?id=0&on=true&toggle_after=1',
    gateStatePath: '/rpc/Input.GetStatus?id=0',
    gateClosedMatch: 'state=true',
    gateTravelSec: 20,
  }

  it('presses with the device-timed pulse through the Shelly Gen2 SHA-256 digest login', async () => {
    const { dev, handler } = shellyGen2({ password: 'gate-pass' })
    server = await mockServer(handler)
    const ctx = ctxFor(server, { pulsePath: SHELLY2_GATE.pulsePath, username: 'admin', password: 'gate-pass' }, 'gate')
    const res = await adapter.execute(ctx, makeAction('gate.pulse'))
    expect(res.ok).toBe(true)
    expect(res.state).toEqual({ gate: 'unknown' })
    expect(res.needsConfirmation).toBeUndefined()
    expect(String(res.result?.note)).toMatch(/Without a gate sensor/)
    expect(dev.sets).toEqual(['id=0&on=true&toggle_after=1'])
    expect(wire(server)).toEqual(['GET /rpc/Switch.Set?id=0&on=true&toggle_after=1', 'GET /rpc/Switch.Set?id=0&on=true&toggle_after=1'])
    expect(server.requests[0]!.headers.authorization).toBeUndefined()
    expect(server.requests[1]!.headers.authorization).toMatch(/^Digest username="admin", realm="shellyplus1-a8032abe54dc".*algorithm=SHA-256/)

    const wrong = await adapter.execute(ctxFor(server, { pulsePath: SHELLY2_GATE.pulsePath, username: 'admin', password: 'guess' }, 'gate'), makeAction('gate.pulse'))
    expect(wrong).toEqual({ ok: false, error: 'Wrong username or password' })
    expect(dev.sets).toHaveLength(1)
  })

  it('times the press itself when there is no pulse address: on, wait, off', async () => {
    const { dev, handler } = shelly1()
    server = await mockServer(handler)
    const ctx = ctxFor(server, { onPath: SHELLY1.onPath, offPath: SHELLY1.offPath, pulseMs: 150 }, 'gate')
    const res = await adapter.execute(ctx, makeAction('gate.pulse'))
    expect(res.ok).toBe(true)
    expect(wire(server)).toEqual(['GET /relay/0?turn=on', 'GET /relay/0?turn=off'])
    expect(dev.ison).toBe(false)
    const held = dev.turns[1]!.at - dev.turns[0]!.at
    expect(held).toBeGreaterThanOrEqual(140)
    expect(held).toBeLessThan(1500)
  })

  it('opens, closes and steps with the same single press when there is no sensor', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, { pulsePath: SHELLY2_GATE.pulsePath }, 'gate')
    for (const type of ['gate.open', 'gate.close', 'gate.pulse'] as const) {
      const res = await adapter.execute(ctx, makeAction(type))
      expect(res.ok).toBe(true)
      expect(res.state).toEqual({ gate: 'unknown' })
    }
    expect(dev.sets).toHaveLength(3)
    expect(await adapter.readState!(ctx)).toEqual({})
  })

  it('needs either a pulse address or both on and off', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    const res = await adapter.execute(ctxFor(server, { onPath: SHELLY1.onPath }, 'gate'), makeAction('gate.pulse'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/either a pulse address, or both an on and an off address/)
    expect(server.requests).toEqual([])
  })

  it('opens a closed gate and follows the sensor until it has left the closed position', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, SHELLY2_GATE, 'gate')
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'closed' })

    const res = await adapter.execute(ctx, makeAction('gate.open'))
    expect(res).toEqual({ ok: true, state: { gate: 'opening' } })
    expect(wire(server)).toEqual(['GET /rpc/Input.GetStatus?id=0', 'GET /rpc/Input.GetStatus?id=0', 'GET /rpc/Switch.Set?id=0&on=true&toggle_after=1'])

    expect(await adapter.readState!(ctx)).toEqual({ gate: 'opening' }) // reed still closed
    dev.reedClosed = false
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'open' })
    expect(dev.sets).toHaveLength(1)
  })

  it('says closed again when the gate never left the closed position', async () => {
    const { handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, SHELLY2_GATE, 'gate')
    await adapter.execute(ctx, makeAction('gate.open'))
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'opening' })
    const later = Date.now() + 21_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'closed' })
  })

  it('closes an open gate and reports closed only when the sensor says so', async () => {
    const { dev, handler } = shellyGen2()
    dev.reedClosed = false
    server = await mockServer(handler)
    const ctx = ctxFor(server, SHELLY2_GATE, 'gate')
    expect(await adapter.execute(ctx, makeAction('gate.close'))).toEqual({ ok: true, state: { gate: 'closing' } })
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'closing' })
    dev.reedClosed = true
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'closed' })
    expect(dev.sets).toHaveLength(1)
  })

  it('does not press when the gate is already where it was asked to go', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, SHELLY2_GATE, 'gate')
    const close = await adapter.execute(ctx, makeAction('gate.close'))
    expect(close.ok).toBe(true)
    expect(close.state).toEqual({ gate: 'closed' })
    expect(close.result?.alreadyThere).toBe(true)
    dev.reedClosed = false
    const open = await adapter.execute(ctx, makeAction('gate.open'))
    expect(open.ok).toBe(true)
    expect(open.state).toEqual({ gate: 'open' })
    expect(open.result?.alreadyThere).toBe(true)
    expect(dev.sets).toEqual([])
  })

  it('a single press on a gate with a sensor predicts the direction from the sensor', async () => {
    const { dev, handler } = tasmota()
    server = await mockServer(handler)
    const ctx = ctxFor(
      server,
      { onPath: '/cm?cmnd=Power1 ON', offPath: '/cm?cmnd=Power1 OFF', pulseMs: 100, gateStatePath: '/cm?cmnd=Status 10', gateClosedMatch: 'StatusSNS.Switch1=ON' },
      'gate',
    )
    expect(await adapter.execute(ctx, makeAction('gate.pulse'))).toEqual({ ok: true, state: { gate: 'opening' } })
    expect(wire(server)).toEqual(['GET /cm?cmnd=Status%2010', 'GET /cm?cmnd=Power1%20ON', 'GET /cm?cmnd=Power1%20OFF'])
    expect(dev.power).toBe(false)
    dev.switch1 = 'OFF'
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'open' })
    expect(await adapter.execute(ctx, makeAction('gate.pulse'))).toEqual({ ok: true, state: { gate: 'closing' } })
  })

  it('does not press for Open or Close when the sensor cannot be read, but still allows a single press', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, { ...SHELLY2_GATE, gateStatePath: '/rpc/Input.GetStatus2?id=0' }, 'gate')
    const open = await adapter.execute(ctx, makeAction('gate.open'))
    expect(open.ok).toBe(false)
    expect(open.error).toMatch(/button was not pressed because the gate sensor could not be read/)
    expect(dev.sets).toEqual([])
    const pulse = await adapter.execute(ctx, makeAction('gate.pulse'))
    expect(pulse.ok).toBe(true)
    expect(pulse.state).toEqual({ gate: 'unknown' })
    expect(dev.sets).toHaveLength(1)
  })

  it('stops only while a move the hub started can still be under way', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, SHELLY2_GATE, 'gate')

    const atRest = await adapter.execute(ctx, makeAction('gate.stop'))
    expect(atRest.ok).toBe(false)
    expect(atRest.error).toMatch(/button was not pressed/)
    expect(server.requests).toEqual([])

    await adapter.execute(ctx, makeAction('gate.open'))
    dev.reedClosed = false
    const stop = await adapter.execute(ctx, makeAction('gate.stop'))
    expect(stop).toEqual({ ok: true, state: { gate: 'stopped' } })
    expect(dev.sets).toHaveLength(2)
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'stopped' })

    // Already stopped: a second Stop would start the gate again, so it is refused.
    expect((await adapter.execute(ctx, makeAction('gate.stop'))).ok).toBe(false)
    expect(dev.sets).toHaveLength(2)
  })

  it('refuses Stop once the travel time has passed', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, SHELLY2_GATE, 'gate')
    await adapter.execute(ctx, makeAction('gate.open'))
    const later = Date.now() + 21_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    expect((await adapter.execute(ctx, makeAction('gate.stop'))).ok).toBe(false)
    expect(dev.sets).toHaveLength(1)
  })

  it('does not press twice when the answer to a device-timed pulse is lost', async () => {
    server = await mockServer(() => {
      /* the relay is there but never answers */
    })
    const res = await adapter.execute(ctxFor(server, { pulsePath: '/relay/0?turn=on&timer=1' }, 'gate', { timeoutMs: 300 }), makeAction('gate.pulse'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cannot tell whether it arrived/)
    expect(res.error).toMatch(/not sent again/)
    expect(wire(server)).toEqual(['GET /relay/0?turn=on&timer=1'])
  })

  it('still allows Stop after a press whose answer was lost, because the gate may be moving', async () => {
    const { dev, handler } = shellyGen2()
    let silent = true
    server = await mockServer((req, res, incoming) => {
      if (silent && req.path === '/rpc/Switch.Set') return
      return handler(req, res, incoming)
    })
    const ctx = ctxFor(server, { pulsePath: '/rpc/Switch.Set?id=0&on=true&toggle_after=1' }, 'gate', { timeoutMs: 300 })
    expect((await adapter.execute(ctx, makeAction('gate.pulse'))).ok).toBe(false)
    silent = false
    expect(await adapter.execute(ctx, makeAction('gate.stop'))).toEqual({ ok: true, state: { gate: 'stopped' } })
    expect(dev.sets).toHaveLength(1)
  })

  it('throws when the gate relay is not on this connection at all', async () => {
    const port = await closedPort()
    const ctx = makeCtx({ family: 'http-relay', kind: 'gate', config: { pulsePath: '/relay/0?turn=on&timer=1' }, path: { port } })
    await expect(adapter.execute(ctx, makeAction('gate.pulse'))).rejects.toThrow(/refused the connection/)
  })

  it('keeps trying to release a hub-timed press and says so when the relay may be stuck on', async () => {
    const { handler } = shelly1()
    server = await mockServer((req, res, incoming) => {
      if (req.query.get('turn') === 'off') {
        incoming.socket.destroy()
        return
      }
      return handler(req, res, incoming)
    })
    const ctx = ctxFor(server, { onPath: SHELLY1.onPath, offPath: SHELLY1.offPath, pulseMs: 100 }, 'gate')
    await expect(adapter.execute(ctx, makeAction('gate.pulse'))).rejects.toThrow(/may still be held on/)
    expect(wire(server)).toEqual(['GET /relay/0?turn=on', 'GET /relay/0?turn=off', 'GET /relay/0?turn=off', 'GET /relay/0?turn=off'])
  })

  it('reports a relay that refuses to switch off again', async () => {
    const { handler } = shelly1()
    server = await mockServer((req, res, incoming) => {
      if (req.query.get('turn') === 'off') return send(res, 500, 'Internal Server Error')
      return handler(req, res, incoming)
    })
    const ctx = ctxFor(server, { onPath: SHELLY1.onPath, offPath: SHELLY1.offPath, pulseMs: 100 }, 'gate')
    const res = await adapter.execute(ctx, makeAction('gate.pulse'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/would not switch it off again \(HTTP 500\)/)
    expect(res.error).toMatch(/may still be held on/)
  })

  it('still sends the release when the answer to "on" was lost', async () => {
    const { handler } = shelly1()
    server = await mockServer((req, res, incoming) => {
      if (req.query.get('turn') === 'on') return
      return handler(req, res, incoming)
    })
    const ctx = ctxFor(server, { onPath: SHELLY1.onPath, offPath: SHELLY1.offPath, pulseMs: 100 }, 'gate', { timeoutMs: 300 })
    // One button: the press may have happened, so this must come back as a plain failure. If it were thrown,
    // the hub would run the whole press again on another connection and stop the gate half-way.
    const res = await adapter.execute(ctx, makeAction('gate.pulse'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not answer the pulse request in time/)
    expect(res.error).toMatch(/not sent again/)
    expect(res.error).toMatch(/told to switch off again/)
    expect(wire(server)).toEqual(['GET /relay/0?turn=on', 'GET /relay/0?turn=off'])
  })

  it('says the relay may be held on when neither "on" nor the release is answered', async () => {
    server = await mockServer(() => {
      /* on the network, never answers */
    })
    const ctx = ctxFor(server, { onPath: SHELLY1.onPath, offPath: SHELLY1.offPath, pulseMs: 100 }, 'gate', { timeoutMs: 300 })
    const res = await adapter.execute(ctx, makeAction('gate.pulse'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not sent again/)
    expect(res.error).toMatch(/may still be held on/)
    expect(wire(server)).toEqual(['GET /relay/0?turn=on', 'GET /relay/0?turn=off'])
  })
})

describe('http-relay: gate with separate open, close and stop', () => {
  const SEPARATE = {
    gateMode: 'separate',
    openPath: '/rpc/Switch.Set?id=0&on=true&toggle_after=1',
    closePath: '/rpc/Switch.Set?id=1&on=true&toggle_after=1',
    stopPath: '/rpc/Switch.Set?id=2&on=true&toggle_after=1',
    gateTravelSec: 20,
  }

  it('calls the matching address for each button', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, SEPARATE, 'gate')
    const open = await adapter.execute(ctx, makeAction('gate.open'))
    expect(open.ok).toBe(true)
    expect(open.state).toEqual({ gate: 'opening' })
    expect(String(open.result?.note)).toMatch(/no gate sensor/)
    const stop = await adapter.execute(ctx, makeAction('gate.stop'))
    expect(stop).toEqual({ ok: true, state: { gate: 'stopped' } })
    const close = await adapter.execute(ctx, makeAction('gate.close'))
    expect(close.state).toEqual({ gate: 'closing' })
    expect(dev.sets).toEqual(['id=0&on=true&toggle_after=1', 'id=2&on=true&toggle_after=1', 'id=1&on=true&toggle_after=1'])
    expect(server.requests.every((r) => r.method === 'GET' && r.path === '/rpc/Switch.Set')).toBe(true)
  })

  it('without a sensor, reports the commanded position only as an assumption after the travel time', async () => {
    const { handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, SEPARATE, 'gate')
    await adapter.execute(ctx, makeAction('gate.open'))
    const sent = server.requests.length
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'opening', gateAssumed: false })
    const later = Date.now() + 21_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'open', gateAssumed: true })
    expect(server.requests).toHaveLength(sent)
    // A later Stop clears the "assumed" mark again.
    await adapter.execute(ctx, makeAction('gate.stop'))
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'stopped', gateAssumed: false })
  })

  it('lets the hub try again when a hub-timed Open loses its answer, because pressing Open twice is harmless', async () => {
    const { handler } = tasmota()
    server = await mockServer((req, res, incoming) => {
      if (req.query.get('cmnd') === 'Power1 ON') return
      return handler(req, res, incoming)
    })
    const ctx = ctxFor(
      server,
      { gateMode: 'separate', openPath: '/cm?cmnd=Power1 ON then /cm?cmnd=Power1 OFF', closePath: '/cm?cmnd=Power2 ON then /cm?cmnd=Power2 OFF', pulseMs: 100 },
      'gate',
      { timeoutMs: 300 },
    )
    await expect(adapter.execute(ctx, makeAction('gate.open'))).rejects.toThrow(/did not answer within 0\.3 seconds/)
    expect(wire(server)).toEqual(['GET /cm?cmnd=Power1%20ON', 'GET /cm?cmnd=Power1%20OFF'])
  })

  it('times each press itself when the address is written as "on then off"', async () => {
    const { dev, handler } = tasmota()
    server = await mockServer(handler)
    const ctx = ctxFor(
      server,
      { gateMode: 'separate', openPath: '/cm?cmnd=Power1 ON then /cm?cmnd=Power1 OFF', closePath: '/cm?cmnd=Power2 ON then /cm?cmnd=Power2 OFF', pulseMs: 100 },
      'gate',
    )
    expect((await adapter.execute(ctx, makeAction('gate.open'))).ok).toBe(true)
    expect(wire(server)).toEqual(['GET /cm?cmnd=Power1%20ON', 'GET /cm?cmnd=Power1%20OFF'])
    expect(dev.power).toBe(false)
  })

  it('refuses Stop without a stop address and a single press without a sensor', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, { ...SEPARATE, stopPath: '' }, 'gate')
    expect(await adapter.execute(ctx, makeAction('gate.stop'))).toEqual({ ok: false, error: 'No stop address is set for this gate' })
    const pulse = await adapter.execute(ctx, makeAction('gate.pulse'))
    expect(pulse.ok).toBe(false)
    expect(pulse.error).toMatch(/Use Open or Close/)
    const noClose = await adapter.execute(ctxFor(server, { gateMode: 'separate', openPath: SEPARATE.openPath }, 'gate'), makeAction('gate.close'))
    expect(noClose).toEqual({ ok: false, error: 'No close address is set for this gate' })
    expect(dev.sets).toEqual([])
  })

  it('with a sensor, a single press opens a closed gate and closes an open one', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, { ...SEPARATE, gateStatePath: '/rpc/Input.GetStatus?id=0', gateClosedMatch: 'state=true' }, 'gate')
    expect(await adapter.execute(ctx, makeAction('gate.pulse'))).toEqual({ ok: true, state: { gate: 'opening' } })
    dev.reedClosed = false
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'open' })
    expect(await adapter.execute(ctx, makeAction('gate.pulse'))).toEqual({ ok: true, state: { gate: 'closing' } })
    expect(dev.sets).toEqual(['id=0&on=true&toggle_after=1', 'id=1&on=true&toggle_after=1'])
  })
})

describe('http-relay: secure (https) devices and ports', () => {
  const at = (config: Record<string, unknown>, port: number | null, host = '192.168.1.60') =>
    addressFor(makeCtx({ family: 'http-relay', kind: 'switch', config, path: { host, port } }), String(config.onPath))

  it('builds every address from the connection in use', () => {
    expect(at({ onPath: '/relay/0?turn=on' }, 80)).toBe('http://192.168.1.60/relay/0?turn=on')
    expect(at({ onPath: '/relay/0?turn=on' }, null)).toBe('http://192.168.1.60/relay/0?turn=on')
    expect(at({ onPath: 'relay/0?turn=on' }, 8081)).toBe('http://192.168.1.60:8081/relay/0?turn=on')
    expect(at({ onPath: '/on' }, 80, 'fd00::12')).toBe('http://[fd00::12]/on')
    expect(at({ onPath: 'POST http://{host}:8081/zeroconf/switch {"deviceid":"1000a1b2c3","data":{"switch":"on"}}' }, 80, '10.0.0.7')).toBe('http://10.0.0.7:8081/zeroconf/switch')
  })

  it('uses port 443 for https when the connection still carries the usual port 80', () => {
    const shelly = '/rpc/Switch.Set?id=0&on=true'
    // The hub fills in 80 on every new connection. With "Use HTTPS" on, that must not become https://…:80.
    expect(at({ onPath: shelly, https: true }, 80)).toBe(`https://192.168.1.60${shelly}`)
    expect(at({ onPath: shelly, https: true }, null)).toBe(`https://192.168.1.60${shelly}`)
    // A port the owner chose (for example a forward on the SIM router) is kept.
    expect(at({ onPath: shelly, https: true }, 8443)).toBe(`https://192.168.1.60:8443${shelly}`)
    // An address written out in full says itself whether it is secure.
    expect(at({ onPath: `https://{host}:{port}${shelly}` }, 80)).toBe(`https://192.168.1.60${shelly}`)
    expect(at({ onPath: `http://{host}:{port}${shelly}`, https: true }, 80)).toBe(`http://192.168.1.60${shelly}`)
  })

  it('talks https to a device that serves its own certificate', async () => {
    const { dev, handler } = shellyGen2()
    const secure = await httpsDevice(handler)
    const ctx = makeCtx({
      family: 'http-relay',
      kind: 'switch',
      config: { https: true, onPath: '/rpc/Switch.Set?id=0&on=true', offPath: '/rpc/Switch.Set?id=0&on=false', statePath: '/rpc/Switch.GetStatus?id=0', stateOnMatch: 'output=true' },
      path: { port: secure.port },
    })
    expect(await adapter.probe(ctx)).toMatchObject({ ok: true, info: { power: false } })
    expect(await adapter.execute(ctx, makeAction('power.on'))).toEqual({ ok: true, state: { power: true } })
    expect(dev.output).toBe(true)
    expect(await adapter.readState!(ctx)).toEqual({ power: true })
    expect(secure.urls).toEqual(['GET /rpc/Switch.GetStatus?id=0', 'GET /rpc/Switch.Set?id=0&on=true', 'GET /rpc/Switch.GetStatus?id=0'])
  })

  it('says to switch on HTTPS when the device redirects there (newer Shelly firmware)', async () => {
    server = await mockServer((req, res) => {
      res.writeHead(301, { Location: `https://127.0.0.1${req.url}` })
      res.end()
    })
    const res = await adapter.execute(ctxFor(server, { onPath: '/rpc/Switch.Set?id=0&on=true' }), makeAction('power.on'))
    expect(res).toEqual({ ok: false, error: 'The device only accepts a secure connection (HTTP 301). Switch on "Use HTTPS" in the device settings.' })
    expect(server.requests).toHaveLength(1) // not followed
  })

  it('says so plainly when HTTPS is switched on for a device that only speaks http', async () => {
    const { dev, handler } = shelly1()
    server = await mockServer(handler)
    const ctx = ctxFor(server, { ...SHELLY1, https: true })
    const probe = await adapter.probe(ctx)
    expect(probe.ok).toBe(false)
    expect(probe.error).toMatch(/did not accept a secure \(HTTPS\) connection/)
    expect(probe.error).not.toMatch(/EPROTO|SSL routines|openssl/i)
    // Nothing reached the relay, so even a toggle is a plain transport failure the hub may retry elsewhere.
    await expect(adapter.execute(ctx, makeAction('power.toggle'))).rejects.toThrow(/did not accept a secure \(HTTPS\) connection/)
    expect(dev.turns).toEqual([])
  })
})

describe('http-relay: a "no" inside an answer that looks fine from outside', () => {
  const SONOFF = {
    onPath: 'POST /zeroconf/switch {"deviceid":"1000a1b2c3","data":{"switch":"on"}}',
    offPath: 'POST /zeroconf/switch {"deviceid":"1000a1b2c3","data":{"switch":"off"}}',
  }

  it('reports a Sonoff DIY error number instead of claiming success', async () => {
    const { dev, handler } = sonoffDiy()
    server = await mockServer(handler)
    // "ON" in capitals is not a value the device knows: HTTP 200 with {"seq":1,"error":422}.
    const wrongValue = await adapter.execute(ctxFor(server, { ...SONOFF, onPath: 'POST /zeroconf/switch {"deviceid":"1000a1b2c3","data":{"switch":"ON"}}' }), makeAction('power.on'))
    expect(wrongValue.ok).toBe(false)
    expect(wrongValue.error).toMatch(/said it could not do it \(error 422\)/)
    expect(wrongValue.state).toBeUndefined()
    expect(dev.switch).toBe('off')
    // Text the device cannot read at all: error 400.
    const broken = await adapter.execute(ctxFor(server, { ...SONOFF, onPath: 'POST /zeroconf/switch {"deviceid":"1000a1b2c3","data":{"switch":"on"}' }), makeAction('power.on'))
    expect(broken.ok).toBe(false)
    expect(broken.error).toMatch(/\(error 400\)/)
    // {"seq":n,"error":0,"data":{}} is a yes.
    expect(await adapter.execute(ctxFor(server, SONOFF), makeAction('power.on'))).toEqual({ ok: true, state: { power: true } })
    expect(dev.switch).toBe('on')
  })

  it('does not read a state out of an error answer, and does not switch blindly on a toggle', async () => {
    const { dev, handler } = sonoffDiy()
    server = await mockServer(handler)
    const ctx = ctxFor(server, { ...SONOFF, statePath: 'POST /zeroconf/info not-json', stateOnMatch: 'data.switch=on' })
    await expect(adapter.readState!(ctx)).rejects.toThrow(/said it could not do it \(error 400\)/)
    const toggle = await adapter.execute(ctx, makeAction('power.toggle'))
    expect(toggle.ok).toBe(false)
    expect(toggle.error).toMatch(/status request/)
    expect(dev.switch).toBe('off')
    expect(server.requests.every((r) => r.path === '/zeroconf/info')).toBe(true)
    // The device did answer, so the connection itself is fine: no state, but not "unreachable".
    const probe = await adapter.probe(ctx)
    expect(probe.ok).toBe(true)
    expect(probe.info).toEqual({})
  })

  it('reports a Tasmota that did not take the command', async () => {
    const { dev, handler } = tasmota()
    server = await mockServer(handler)
    // An empty command: {"WARNING":"Enter command cmnd="}
    const empty = await adapter.execute(ctxFor(server, { onPath: '/cm?cmnd=', offPath: '/cm?cmnd=Power OFF' }), makeAction('power.on'))
    expect(empty.ok).toBe(false)
    expect(empty.error).toMatch(/said it could not do it \(Enter command cmnd=\)/)
    // A mistyped command: {"Command":"Unknown"}
    const typo = await adapter.execute(ctxFor(server, { onPath: '/cm?cmnd=Pwer ON', offPath: '/cm?cmnd=Power OFF' }), makeAction('power.on'))
    expect(typo.ok).toBe(false)
    expect(typo.error).toMatch(/\(command unknown\)/)
    expect(dev.power).toBe(false)
  })

  it('reads the error out of a Shelly RPC frame', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(handler)
    const ctx = ctxFor(server, {
      onPath: 'POST /rpc {"id":1,"src":"housecontrol","method":"Switch.Set","params":{"id":0,"on":true}}',
      offPath: 'POST /rpc {"id":1,"src":"housecontrol","method":"Switch.Set","params":{"id":0}}',
    })
    expect(await adapter.execute(ctx, makeAction('power.on'))).toEqual({ ok: true, state: { power: true } })
    expect(dev.output).toBe(true)
    expect(server.requests[0]!.body).toBe('{"id":1,"src":"housecontrol","method":"Switch.Set","params":{"id":0,"on":true}}')
    const off = await adapter.execute(ctx, makeAction('power.off'))
    expect(off.ok).toBe(false)
    expect(off.error).toMatch(/said it could not do it \(Argument 'on', value not found!\)/)
    expect(dev.output).toBe(true)
  })

  it('reports a hub-timed press whose release the device turned down', async () => {
    const { handler } = sonoffDiy()
    server = await mockServer(handler)
    const ctx = ctxFor(server, { onPath: SONOFF.onPath, offPath: 'POST /zeroconf/switch {"deviceid":"1000a1b2c3","data":{"switch":"OFF"}}', pulseMs: 100 }, 'gate')
    const res = await adapter.execute(ctx, makeAction('gate.pulse'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/would not switch it off again/)
    expect(res.error).toMatch(/may still be held on/)
  })

  it('never repeats the password when a device echoes the request in its error', async () => {
    server = await mockServer((req, res) => send(res, 200, { error: `bad request ${req.url}` }))
    const ctx = ctxFor(server, { onPath: '/cm?user={user}&password={pass}&cmnd=Power ON', username: 'admin', password: 'tOp&secret pw' })
    const res = await adapter.execute(ctx, makeAction('power.on'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/said it could not do it/)
    expect(JSON.stringify(res)).not.toContain('tOp&secret pw')
    expect(JSON.stringify(res)).not.toContain(encodeURIComponent('tOp&secret pw'))
  })

  it('takes ordinary answers that merely mention an error field as a yes', async () => {
    for (const body of [{ seq: 4, error: 0, data: {} }, { error: '' }, { error: 'none' }, { error: null, ok: true }, { POWER: 'ON' }, { was_on: false }, {}]) {
      const s = await mockServer((_req, res) => send(res, 200, body))
      const res = await adapter.execute(ctxFor(s, { onPath: '/on' }), makeAction('power.on'))
      await s.close()
      expect(res).toEqual({ ok: true, state: { power: true } })
    }
  })
})

describe('http-relay: devices that answer badly', () => {
  it('does not let the hub toggle again when the device acted but answered with something that is not HTTP', async () => {
    const dev = await rawDevice((socket) => socket.end('OK relay toggled\r\n'))
    const ctx = makeCtx({ family: 'http-relay', kind: 'switch', config: { togglePath: '/toggle' }, path: { port: dev.port } })
    const res = await adapter.execute(ctx, makeAction('power.toggle'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cannot tell whether it arrived/)
    expect(res.error).toMatch(/not sent again/)
    expect(dev.hits).toEqual(['GET /toggle HTTP/1.1'])
  })

  it('does not let the hub press the gate again when the answer was cut short', async () => {
    const dev = await rawDevice((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 120\r\n\r\n{"ison":true,')
      socket.destroy()
    })
    const ctx = makeCtx({ family: 'http-relay', kind: 'gate', config: { pulsePath: '/relay/0?turn=on&timer=1' }, path: { port: dev.port } })
    const res = await adapter.execute(ctx, makeAction('gate.pulse'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cut the connection while answering the pulse request/)
    expect(res.error).toMatch(/not sent again/)
    expect(dev.hits).toEqual(['GET /relay/0?turn=on&timer=1 HTTP/1.1'])
  })

  it('throws the same faults in plain words for commands that are safe to repeat', async () => {
    const dev = await rawDevice((socket) => socket.end('<html><body>It works</body></html>'))
    const ctx = makeCtx({ family: 'http-relay', kind: 'switch', config: { onPath: '/on', offPath: '/off', statePath: '/state', stateOnMatch: 'on' }, path: { port: dev.port } })
    await expect(adapter.execute(ctx, makeAction('power.on'))).rejects.toThrow(/not a web reply/)
    const probe = await adapter.probe(ctx)
    expect(probe.ok).toBe(false)
    expect(probe.error).toMatch(/answered with something that is not a web reply/)
    expect(probe.error).not.toMatch(/Parse Error|HPE_/)
    await expect(adapter.readState!(ctx)).rejects.toThrow(/not a web reply/)
  })

  it('reads an HTML page as "not on" rather than failing', async () => {
    server = await mockServer((_req, res) => send(res, 200, '<html><body><h1>Relay board</h1><p>Relay 1: OFF</p></body></html>', 'text/html'))
    const ctx = ctxFor(server, { onPath: '/on', offPath: '/off', statePath: '/', stateOnMatch: 'Relay 1: ON' })
    expect(await adapter.readState!(ctx)).toEqual({ power: false })
    expect(await adapter.probe(ctx)).toMatchObject({ ok: true, info: { power: false } })
  })

  it('keeps the device reachable when the "reads as on" rule cannot be understood', async () => {
    const { handler } = shelly1()
    server = await mockServer(handler)
    const ctx = ctxFor(server, { ...SHELLY1, stateOnMatch: '/([a-z/' })
    const probe = await adapter.probe(ctx)
    expect(probe.ok).toBe(true)
    expect(probe.info).toEqual({})
    await expect(adapter.readState!(ctx)).rejects.toThrow(/not a valid pattern/)
    expect((await adapter.execute(ctx, makeAction('power.on'))).ok).toBe(true)
  })

  it('explains a Shelly that asks for a pause after too many wrong logins (HTTP 429)', async () => {
    server = await mockServer((_req, res) => {
      res.writeHead(429)
      res.end()
    })
    const config = { pulsePath: '/rpc/Switch.Set?id=0&on=true&toggle_after=1', username: 'admin', password: 'guess' }
    const res = await adapter.execute(ctxFor(server, config, 'gate'), makeAction('gate.pulse'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/asking the hub to wait \(HTTP 429\)/)
    expect(server.requests).toHaveLength(1) // no hammering
    expect(JSON.stringify(res)).not.toContain('guess')
  })
})

describe('http-relay: what goes out with every request', () => {
  it('names the device itself as Referer and never keeps a connection open', async () => {
    const { handler } = tasmota()
    server = await mockServer(handler)
    await adapter.execute(ctxFor(server, { onPath: '/cm?cmnd=Power ON' }), makeAction('power.on'))
    const req = server.requests[0]!
    expect(req.headers.referer).toBe(`http://127.0.0.1:${server.port}/`)
    expect(req.headers.connection).toBe('close')
  })

  it('logs in as admin when only a password is filled in (Tasmota, Shelly Gen2)', async () => {
    const t = tasmota('webpw')
    server = await mockServer(t.handler)
    expect(await adapter.execute(ctxFor(server, { onPath: '/cm?cmnd=Power ON', password: 'webpw' }), makeAction('power.on'))).toEqual({ ok: true, state: { power: true } })
    expect(server.requests.at(-1)!.headers.authorization).toBe('Basic ' + Buffer.from('admin:webpw').toString('base64'))
    // The same default fills {user} in an address.
    const viaQuery = ctxFor(server, { statePath: '/cm?user={user}&password={pass}&cmnd=Power', stateOnMatch: 'POWER=ON', password: 'webpw' })
    expect(await adapter.readState!(viaQuery)).toEqual({ power: true })
    expect(server.requests.at(-1)!.url).toBe('/cm?user=admin&password=webpw&cmnd=Power')
    await server.close()

    const s = shellyGen2({ password: 'gate-pass' })
    server = await mockServer(s.handler)
    const res = await adapter.execute(ctxFor(server, { pulsePath: '/rpc/Switch.Set?id=0&on=true&toggle_after=1', password: 'gate-pass' }, 'gate'), makeAction('gate.pulse'))
    expect(res.ok).toBe(true)
    expect(s.dev.sets).toEqual(['id=0&on=true&toggle_after=1'])
  })
})

describe('http-relay: finishing inside the time the hub allows for an action (twice the device timeout)', () => {
  it('does not hold up a finished toggle for a status that never comes', async () => {
    const { dev, handler } = shelly1()
    server = await mockServer((req, res, incoming) => {
      if (req.path === '/status') return
      return handler(req, res, incoming)
    })
    const ctx = ctxFor(server, SHELLY1, 'switch', { timeoutMs: 500 })
    const started = performance.now()
    const res = await adapter.execute(ctx, makeAction('power.toggle'))
    expect(performance.now() - started).toBeLessThan(1000)
    expect(res.ok).toBe(true)
    expect(dev.turns.map((t) => t.turn)).toEqual(['toggle'])
  })

  it('shares the time that is left between the tries to release a hub-timed press', async () => {
    const { handler } = shelly1()
    server = await mockServer((req, res, incoming) => {
      if (req.query.get('turn') === 'off') return
      return handler(req, res, incoming)
    })
    const ctx = ctxFor(server, { gateMode: 'separate', openPath: '/relay/0?turn=on then /relay/0?turn=off', closePath: '/relay/1?turn=on then /relay/1?turn=off', pulseMs: 100 }, 'gate', { timeoutMs: 1500 })
    const started = performance.now()
    await expect(adapter.execute(ctx, makeAction('gate.open'))).rejects.toThrow(/may still be held on/)
    // Three full-length tries would take 4.5 s; the hub gives up after 3 s and would start a second press meanwhile.
    expect(performance.now() - started).toBeLessThan(3000)
    expect(wire(server)).toEqual(['GET /relay/0?turn=on', 'GET /relay/0?turn=off', 'GET /relay/0?turn=off', 'GET /relay/0?turn=off'])
  })

  it('does not press a one-button gate when its sensor answers too slowly to leave time for the press', async () => {
    const { dev, handler } = shellyGen2()
    server = await mockServer(async (req, res, incoming) => {
      if (req.path === '/rpc/Input.GetStatus') await new Promise((r) => setTimeout(r, 600))
      return handler(req, res, incoming)
    })
    const config = { pulsePath: '/rpc/Switch.Set?id=0&on=true&toggle_after=1', gateStatePath: '/rpc/Input.GetStatus?id=0', gateClosedMatch: 'state=true' }
    const ctx = ctxFor(server, config, 'gate', { timeoutMs: 900 })
    await expect(adapter.execute(ctx, makeAction('gate.open'))).rejects.toThrow(/did not answer within 0\.3 seconds/)
    expect(dev.sets).toEqual([])
    // Outside an action the sensor gets the full time.
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'closed' })
  })
})
