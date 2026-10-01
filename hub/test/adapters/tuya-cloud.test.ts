/**
 * Tuya cloud adapter against a mock of the Tuya IoT Platform OpenAPI.
 *
 * The mock is built from docs/protocols/lights-tasmota-shelly-tuya.md:
 *  - token:    {"result":{"access_token","expire_time":7200,"refresh_token","uid"},"success":true,"t":...}
 *  - detail:   id, uuid, category, name, product_id, product_name, local_key, sub, asset_id, ip, lon, lat,
 *              model, time_zone, active_time, update_time, create_time, online
 *  - status:   {"result":[{"code":"switch_led","value":true},{"code":"work_mode","value":"scene_2"}],"t":...,"success":true}
 *  - commands: {"result":true,"t":1551851043862,"success":true}
 *  - spec:     {category, functions:[{code,type,values}], status:[...]}
 *  - DP codes and ranges: switch_led, work_mode, bright_value_v2 10-1000, bright_value 25-255,
 *              temp_value_v2 0-1000, colour_data_v2 {h,s,v}, switch / switch_1..6, and for garage door
 *              openers (docs/protocols/gate-control.md) switch_1, doorcontact_state, tr_timecon.
 * It checks every request's signature with its own statement of the documented string-to-sign and
 * answers the way Tuya does: HTTP 200 with {"code","msg","success":false} ("sign invalid",
 * "token invalid", "permission deny", "device is offline").
 */
import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceKind } from '@house/shared'
import adapter, { resetTuyaCloud, tuyaApiBase, tuyaCanonicalUrl, tuyaSign, TUYA_REGIONS } from '../../src/adapters/tuya-cloud.ts'
import { makeAction, makeCtx, mockServer, send, type MockServer, type RecordedRequest } from '../helpers.ts'

// Client id (and its secret) of the worked signing example on Tuya's signature page.
const ACCESS_ID = '1KAD46OrT9HafiKdsXeg'
const ACCESS_SECRET = '4OHBOnWOqaEC1mWXOpVL3yV50s0qGSRC'
const DEVICE_ID = 'bf8a1c3d5e7f9a1b2c3dxy'
const LOCAL_KEY = 'a1b2c3d4e5f6a7b8'
const DEVICE = `/v1.0/iot-03/devices/${DEVICE_ID}`
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

interface DataPoint {
  code: string
  value: unknown
}

interface Cloud {
  server: MockServer
  status: DataPoint[]
  detail: Record<string, unknown>
  /** null = the project may not read the specification. */
  spec: Record<string, unknown> | null
  expireTime: number
  /** The only token the cloud accepts right now. */
  validToken: string | null
  /** Refuse every token, however new. */
  rejectAllTokens: boolean
  /** Answer commands with "device is offline". */
  offline: boolean
  /** Refuse this many "switch off" commands (value false) before accepting them again. */
  failOff: number
  /** Never answer (for timeouts). */
  silent: boolean
  /** Something between the hub and Tuya answers instead of Tuya: a web page, a gateway error, a login wall, or a dropped line. */
  broken: null | 'html' | 'bad-gateway' | 'unauthorized' | 'hang-up'
  /** Every call except the token call is refused the way Tuya refuses a project whose IoT Core trial has run out. */
  planExpired: boolean
  calls(): string[]
  count(method: string, path: string): number
  posts(): string[]
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** The documented signature, stated independently of the adapter. */
function documentedSign(req: RecordedRequest, secret: string, withToken: boolean): string {
  const keys = [...req.query.keys()].sort()
  const url = req.path + (keys.length ? '?' + keys.map((k) => `${k}=${req.query.get(k)}`).join('&') : '')
  const stringToSign = [req.method, sha256(req.body), '', url].join('\n')
  const h = req.headers
  const str = String(h.client_id) + (withToken ? String(h.access_token) : '') + String(h.t) + String(h.nonce ?? '') + stringToSign
  return crypto.createHmac('sha256', secret).update(str).digest('hex').toUpperCase()
}

const BULB_V2: DataPoint[] = [
  { code: 'switch_led', value: true },
  { code: 'work_mode', value: 'white' },
  { code: 'bright_value_v2', value: 500 },
  { code: 'temp_value_v2', value: 0 },
  { code: 'colour_data_v2', value: { h: 201, s: 511, v: 899 } },
  { code: 'countdown_1', value: 0 },
]

const BULB_V2_SPEC = {
  category: 'dj',
  functions: [
    { code: 'switch_led', type: 'Boolean', values: '{}' },
    { code: 'work_mode', type: 'Enum', values: '{"range":["white","colour","scene","music"]}' },
    { code: 'bright_value_v2', type: 'Integer', values: '{"min":10,"max":1000,"scale":0,"step":1}' },
    { code: 'temp_value_v2', type: 'Integer', values: '{"min":0,"max":1000,"scale":0,"step":1}' },
    { code: 'colour_data_v2', type: 'Json', values: '{"h":{"min":0,"scale":0,"unit":"","max":360,"step":1},"s":{"min":0,"scale":0,"unit":"","max":1000,"step":1},"v":{"min":0,"scale":0,"unit":"","max":1000,"step":1}}' },
    { code: 'countdown_1', type: 'Integer', values: '{"unit":"s","min":0,"max":86400,"scale":0,"step":1}' },
  ],
  status: [
    { code: 'switch_led', type: 'Boolean', values: '{}' },
    { code: 'bright_value_v2', type: 'Integer', values: '{"min":10,"max":1000,"scale":0,"step":1}' },
  ],
}

const OLD_BULB: DataPoint[] = [
  { code: 'switch_led', value: true },
  { code: 'work_mode', value: 'white' },
  { code: 'bright_value', value: 255 },
  { code: 'temp_value', value: 0 },
]

const GARAGE: DataPoint[] = [
  { code: 'switch_1', value: false },
  { code: 'countdown_1', value: 0 },
  { code: 'doorcontact_state', value: false },
  { code: 'tr_timecon', value: 20 },
]

let cloud: Cloud | null = null
let skew = 0

async function tuyaCloud(status: DataPoint[], spec: Record<string, unknown> | null = null): Promise<Cloud> {
  let issued = 0
  const c: Cloud = {
    server: undefined as unknown as MockServer,
    status: status.map((d) => ({ ...d })),
    detail: {
      id: DEVICE_ID,
      uuid: '5ecf7f1632e8a1b2',
      category: 'dj',
      name: 'Porch light',
      product_id: 'keyjup78v54myhan',
      product_name: 'Smart Bulb RGBCW',
      local_key: LOCAL_KEY,
      sub: false,
      asset_id: '',
      ip: '49.36.12.7',
      lon: '77.59',
      lat: '12.97',
      model: 'SB-9W',
      time_zone: '+05:30',
      active_time: 1588925778,
      update_time: 1588925790,
      create_time: 1588925778,
      online: true,
    },
    spec,
    expireTime: 7200,
    validToken: null,
    rejectAllTokens: false,
    offline: false,
    failOff: 0,
    silent: false,
    broken: null,
    planExpired: false,
    calls: () => c.server.requests.map((r) => `${r.method} ${r.path}`),
    count: (method, path) => c.server.requests.filter((r) => r.method === method && r.path === path).length,
    posts: () => c.server.requests.filter((r) => r.method === 'POST').map((r) => r.body),
  }
  c.server = await mockServer((req, res, raw) => {
    if (c.silent) return
    if (c.broken === 'html') return send(res, 200, '<!DOCTYPE html><html><head><title>Sign in to WiFi</title></head><body>Please log in</body></html>', 'text/html')
    if (c.broken === 'bad-gateway') return send(res, 502, '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>', 'text/html')
    if (c.broken === 'unauthorized') return send(res, 401, 'Unauthorized')
    if (c.broken === 'hang-up') {
      raw.socket.destroy()
      return
    }
    const t = 1591872112140
    const fail = (code: number, msg: string) => send(res, 200, { code, msg, success: false, t, tid: '3b6f8a2c1d9e4f70a5b1c2d3e4f5a6b7' })
    const ok = (result: unknown) => send(res, 200, { result, success: true, t })
    const isToken = req.path === '/v1.0/token'
    if (req.headers.sign_method !== 'HMAC-SHA256' || req.headers.client_id !== ACCESS_ID) return fail(1004, 'sign invalid')
    if (req.headers.sign !== documentedSign(req, ACCESS_SECRET, !isToken)) return fail(1004, 'sign invalid')
    if (isToken) {
      if (req.method !== 'GET' || req.query.get('grant_type') !== '1') return send(res, 404, 'not found')
      issued += 1
      c.validToken = `a1f0c3e5d7b9${issued}`
      return ok({ access_token: c.validToken, expire_time: c.expireTime, refresh_token: `9e8d7c6b5a4f${issued}`, uid: 'bay1588925778000aBcD' })
    }
    if (c.rejectAllTokens || !c.validToken || req.headers.access_token !== c.validToken) return fail(1010, 'token invalid')
    // Code and wording as Tuya sends them once the monthly trial has lapsed (seen in tinytuya's issue reports).
    if (c.planExpired) return fail(28841002, 'No permissions. Your subscription to cloud development plan has expired.')
    const m = /^\/v1\.0\/iot-03\/devices\/([^/]+)(\/status|\/commands|\/specification)?$/.exec(req.path)
    if (!m || m[1] !== DEVICE_ID) return fail(1106, 'permission deny')
    const what = m[2] ?? ''
    if (req.method === 'GET' && what === '') return ok(c.detail)
    if (req.method === 'GET' && what === '/status') return ok(c.status)
    if (req.method === 'GET' && what === '/specification') return c.spec ? ok(c.spec) : fail(1106, 'permission deny')
    if (req.method === 'POST' && what === '/commands') {
      if (req.headers['content-type'] !== 'application/json') return fail(1109, 'param is illegal')
      if (c.offline) return fail(2001, 'device is offline')
      const commands = (JSON.parse(req.body) as { commands: DataPoint[] }).commands
      if (c.failOff > 0 && commands.some((cmd) => cmd.value === false)) {
        c.failOff -= 1
        return fail(2001, 'device is offline')
      }
      for (const cmd of commands) {
        const dp = c.status.find((d) => d.code === cmd.code)
        if (!dp) return fail(2008, 'command or value not support')
        dp.value = cmd.value
      }
      return ok(true)
    }
    return send(res, 404, 'not found')
  })
  cloud = c
  return c
}

function ctxFor(c: Cloud, o: { kind?: DeviceKind; config?: Record<string, unknown>; timeoutMs?: number } = {}) {
  return makeCtx({
    family: 'tuya-cloud',
    kind: o.kind ?? 'light',
    config: { accessId: ACCESS_ID, accessSecret: ACCESS_SECRET, deviceId: DEVICE_ID, region: 'in', ...o.config },
    path: { kind: 'cloud', label: 'Tuya cloud', host: c.server.url },
    timeoutMs: o.timeoutMs,
  })
}

/** Move the hub's clock forward without waiting. */
function advance(ms: number): void {
  if (!vi.isMockFunction(Date.now)) {
    const real = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => real() + skew)
  }
  skew += ms
}

afterEach(async () => {
  vi.restoreAllMocks()
  skew = 0
  resetTuyaCloud()
  await cloud?.server.close()
  cloud = null
})

describe('tuya-cloud adapter: add-device form', () => {
  it('describes itself in plain words, with India as the default region', () => {
    const d = adapter.describe()
    expect(adapter.family).toBe('tuya-cloud')
    expect(d.id).toBe('tuya-cloud')
    expect(d.kinds).toEqual(['light', 'switch', 'gate'])
    expect(d.pathKinds).toEqual(['cloud'])
    expect(d.defaultPort).toBeNull()
    const names = d.fields.map((f) => f.name)
    expect(names).toEqual(expect.arrayContaining(['accessId', 'accessSecret', 'deviceId', 'region', 'switchCode', 'dimCode', 'apiBase']))
    expect(d.fields.find((f) => f.name === 'accessSecret')?.secret).toBe(true)
    expect(d.fields.filter((f) => f.secret).map((f) => f.name)).toEqual(['accessSecret'])
    for (const required of ['accessId', 'accessSecret', 'deviceId']) expect(d.fields.find((f) => f.name === required)?.required).toBe(true)
    for (const optional of ['switchCode', 'dimCode', 'apiBase']) expect(d.fields.find((f) => f.name === optional)?.required).toBeFalsy()
    const region = d.fields.find((f) => f.name === 'region')!
    expect(region.default).toBe('in')
    expect(region.options?.map((o) => o.value)).toEqual(expect.arrayContaining(['in', 'sg', 'eu', 'eu-w', 'us', 'us-e', 'cn']))
    expect(region.options?.find((o) => o.value === 'in')?.label).toBe('India')
    expect(d.notes.join(' ')).toMatch(/Link Tuya App Account/)
    expect(d.notes.join(' ')).toMatch(/runs out after one month/)

    const visible = [d.label, d.tagline, ...d.notes, ...d.fields.flatMap((f) => [f.label, f.help ?? '', ...(f.options ?? []).map((o) => o.label)])]
    for (const textShown of visible) expect(textShown).not.toMatch(/\b(demo|prototype|placeholder|stub|todo)\b/i)
  })

  it('lists the real regional endpoints', () => {
    expect(TUYA_REGIONS.in!.url).toBe('https://openapi.tuyain.com')
    expect(TUYA_REGIONS.cn!.url).toBe('https://openapi.tuyacn.com')
    expect(TUYA_REGIONS.us!.url).toBe('https://openapi.tuyaus.com')
    expect(TUYA_REGIONS['us-e']!.url).toBe('https://openapi-ueaz.tuyaus.com')
    expect(TUYA_REGIONS.eu!.url).toBe('https://openapi.tuyaeu.com')
    expect(TUYA_REGIONS['eu-w']!.url).toBe('https://openapi-weaz.tuyaeu.com')
    expect(TUYA_REGIONS.sg!.url).toBe('https://openapi-sg.iotbing.com')
  })

  it('works out what each kind of device can do from its settings', () => {
    expect(adapter.capabilities({}, 'light')).toEqual(['power', 'state', 'dim'])
    expect(adapter.capabilities({ dimmable: false }, 'light')).toEqual(['power', 'state'])
    expect(adapter.capabilities({ colour: true }, 'light')).toEqual(['power', 'state', 'dim', 'color'])
    expect(adapter.capabilities({}, 'switch')).toEqual(['power', 'state'])
    expect(adapter.capabilities({ dimCode: 'bright_value_1' }, 'switch')).toEqual(['power', 'state', 'dim'])
    expect(adapter.capabilities({}, 'gate')).toEqual(['gate', 'gate-state', 'state'])
    expect(adapter.capabilities({ gateMode: 'pulse' }, 'gate')).toEqual(['gate'])
  })

  it('has no video, pictures or WiFi move, because Tuya offers none of them here', () => {
    expect(adapter.snapshot).toBeUndefined()
    expect(adapter.streamSources).toBeUndefined()
    expect(adapter.setWifi).toBeUndefined()
    expect(adapter.scanWifi).toBeUndefined()
  })
})

describe('tuya-cloud adapter: where requests go', () => {
  const base = (config: Record<string, unknown>, path: Record<string, unknown> = {}) =>
    tuyaApiBase(makeCtx({ family: 'tuya-cloud', kind: 'light', config, path: { kind: 'cloud', host: null, ...path } }))

  it('uses India unless told otherwise', () => {
    expect(base({})).toBe('https://openapi.tuyain.com')
    expect(base({ region: 'in' })).toBe('https://openapi.tuyain.com')
    expect(base({ region: 'eu' })).toBe('https://openapi.tuyaeu.com')
    expect(base({ region: 'nowhere' })).toBe('https://openapi.tuyain.com')
    expect(base({ region: 'in' }, { host: '' })).toBe('https://openapi.tuyain.com')
    expect(base({ region: 'in' }, { host: 'my-smart-life-account' })).toBe('https://openapi.tuyain.com')
  })

  it('prefers a custom address, and an http address typed on the connection most of all', () => {
    expect(base({ region: 'in', apiBase: 'https://openapi.tuyaus.com/' })).toBe('https://openapi.tuyaus.com')
    expect(base({ apiBase: 'openapi-sg.iotbing.com' })).toBe('https://openapi-sg.iotbing.com')
    expect(base({ apiBase: 'https://openapi.tuyaus.com' }, { host: 'http://127.0.0.1:8123/' })).toBe('http://127.0.0.1:8123')
    expect(base({}, { host: 'http://127.0.0.1', port: 8123 })).toBe('http://127.0.0.1:8123')
    expect(base({ region: 'in' }, { extra: { region: 'sg' } })).toBe('https://openapi-sg.iotbing.com')
  })
})

describe('tuya-cloud adapter: request signing', () => {
  it('reproduces the worked example from Tuya’s signature page', () => {
    // GET /v1.0/token?grant_type=1, t 1588925778000, nonce 5138cc3a9033d69856923fd07b491173.
    // The page's example also signs two extra headers (area_id, call_id).
    const sign = tuyaSign({
      clientId: '1KAD46OrT9HafiKdsXeg',
      secret: '4OHBOnWOqaEC1mWXOpVL3yV50s0qGSRC',
      t: 1588925778000,
      nonce: '5138cc3a9033d69856923fd07b491173',
      method: 'GET',
      url: '/v1.0/token?grant_type=1',
      signatureHeaders: { area_id: '29a33e8796834b1efa6', call_id: '8afdb70ab2ed11eb85290242ac130003' },
    })
    expect(sign).toBe('9E48A3E93B302EEECC803C7241985D0A34EB944F40FB573C7B5C2A82158AF13E')
  })

  it('signs client_id + access_token + t + nonce + METHOD, body hash, empty header line and url', () => {
    const body = '{"commands":[{"code":"switch_led","value":true}]}'
    const str = `id1tok11588925778000n1POST\n${sha256(body)}\n\n/v1.0/iot-03/devices/d1/commands`
    const expected = crypto.createHmac('sha256', 's3cret').update(str).digest('hex').toUpperCase()
    expect(tuyaSign({ clientId: 'id1', secret: 's3cret', accessToken: 'tok1', t: '1588925778000', nonce: 'n1', method: 'post', url: '/v1.0/iot-03/devices/d1/commands', body })).toBe(expected)
    // A GET has an empty body, whose SHA-256 is the documented constant.
    const getStr = `id11588925778000n1GET\n${EMPTY_BODY_SHA256}\n\n/v1.0/token?grant_type=1`
    expect(tuyaSign({ clientId: 'id1', secret: 's3cret', t: 1588925778000, nonce: 'n1', method: 'GET', url: '/v1.0/token?grant_type=1' })).toBe(
      crypto.createHmac('sha256', 's3cret').update(getStr).digest('hex').toUpperCase(),
    )
  })

  it('puts the query in alphabetical order in the signed url', () => {
    expect(tuyaCanonicalUrl('/v1.0/token', { grant_type: 1 })).toBe('/v1.0/token?grant_type=1')
    expect(tuyaCanonicalUrl('/v1.0/users/u1/devices', { page_size: 100, page_no: 1 })).toBe('/v1.0/users/u1/devices?page_no=1&page_size=100')
    expect(tuyaCanonicalUrl(DEVICE)).toBe(DEVICE)
  })
})

describe('tuya-cloud adapter: checking the connection', () => {
  it('gets a token, then reads the device details, with the documented headers', async () => {
    const c = await tuyaCloud(BULB_V2)
    const res = await adapter.probe(ctxFor(c))
    expect(res.ok).toBe(true)
    expect(typeof res.latencyMs).toBe('number')
    expect(res.info).toEqual({ model: 'SB-9W', name: 'Porch light', product: 'Smart Bulb RGBCW', category: 'dj', ip: '49.36.12.7', serial: '5ecf7f1632e8a1b2' })
    expect(c.calls()).toEqual(['GET /v1.0/token', `GET ${DEVICE}`])

    const [token, detail] = c.server.requests
    expect(token!.url).toBe('/v1.0/token?grant_type=1')
    expect(token!.headers.client_id).toBe(ACCESS_ID)
    expect(token!.headers.sign_method).toBe('HMAC-SHA256')
    expect(token!.headers.t).toMatch(/^\d{13}$/)
    expect(token!.headers.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(token!.headers.sign).toMatch(/^[0-9A-F]{64}$/)
    expect(token!.headers.sign).toBe(documentedSign(token!, ACCESS_SECRET, false))
    expect(token!.headers.access_token).toBeUndefined()
    expect(token!.body).toBe('')

    expect(detail!.url).toBe(DEVICE)
    expect(detail!.headers.client_id).toBe(ACCESS_ID)
    expect(detail!.headers.access_token).toBe(c.validToken)
    expect(detail!.headers.sign_method).toBe('HMAC-SHA256')
    expect(detail!.headers.sign).toBe(documentedSign(detail!, ACCESS_SECRET, true))
    expect(detail!.headers.sign).not.toBe(documentedSign(detail!, ACCESS_SECRET, false))
  })

  it('only reads: checking and reading the state never send a command', async () => {
    const c = await tuyaCloud(BULB_V2, BULB_V2_SPEC)
    const before = JSON.stringify(c.status)
    for (const kind of ['light', 'switch', 'gate'] as const) {
      const ctx = ctxFor(c, { kind, config: { refreshSeconds: 0, colour: true } })
      await adapter.probe(ctx)
      await adapter.readState!(ctx)
    }
    expect(c.server.requests.length).toBeGreaterThan(6)
    expect(c.server.requests.every((r) => r.method === 'GET')).toBe(true)
    expect(JSON.stringify(c.status)).toBe(before)
  })

  it('never lets the device’s local key or the access secret out', async () => {
    const c = await tuyaCloud(BULB_V2)
    const ctx = ctxFor(c)
    const out = JSON.stringify([await adapter.probe(ctx), await adapter.readState!(ctx), await adapter.execute(ctx, makeAction('power.on'))])
    expect(out).not.toContain(LOCAL_KEY)
    expect(out).not.toContain(ACCESS_SECRET)
    for (const r of c.server.requests) expect(r.url + r.body + JSON.stringify(r.headers)).not.toContain(ACCESS_SECRET)
  })

  it('says so when the access secret is wrong', async () => {
    const c = await tuyaCloud(BULB_V2)
    const res = await adapter.probe(ctxFor(c, { config: { accessSecret: 'not-the-secret' } }))
    expect(res.ok).toBe(false)
    expect(res.latencyMs).toBeNull()
    expect(res.error).toMatch(/Wrong Access ID or Access Secret/)
    expect(res.error).toMatch(/sign invalid/)
    expect(res.error).not.toContain('not-the-secret')
    expect(c.calls()).toEqual(['GET /v1.0/token'])
  })

  it('asks for the missing settings instead of calling Tuya', async () => {
    const c = await tuyaCloud(BULB_V2)
    const res = await adapter.probe(ctxFor(c, { config: { accessSecret: '', deviceId: ' ' } }))
    expect(res).toEqual({ ok: false, latencyMs: null, error: 'Fill in the Access Secret, Device ID for this device first' })
    const act = await adapter.execute(ctxFor(c, { config: { accessId: '' } }), makeAction('power.on'))
    expect(act).toEqual({ ok: false, error: 'Fill in the Access ID for this device first' })
    expect(c.server.requests).toHaveLength(0)
  })

  it('reports a device Tuya says is offline', async () => {
    const c = await tuyaCloud(BULB_V2)
    c.detail.online = false
    const res = await adapter.probe(ctxFor(c))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/offline/)
  })

  it('reports a device that is not linked to the cloud project, in Tuya’s words', async () => {
    const c = await tuyaCloud(BULB_V2)
    const res = await adapter.probe(ctxFor(c, { config: { deviceId: 'someoneelsesdevice00xyz' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not linked to your cloud project/)
    expect(res.error).toMatch(/permission deny/)
  })

  it('reports an unreachable cloud in a plain sentence', async () => {
    const c = await tuyaCloud(BULB_V2)
    const ctx = ctxFor(c)
    await c.server.close()
    const res = await adapter.probe(ctx)
    expect(res.ok).toBe(false)
    expect(res.latencyMs).toBeNull()
    expect(res.error).toMatch(/^Could not reach Tuya's cloud: .*refused the connection/)
  })

  it('reports a cloud that does not answer in time', async () => {
    const c = await tuyaCloud(BULB_V2)
    c.silent = true
    const res = await adapter.probe(ctxFor(c, { timeoutMs: 250 }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/^Could not reach Tuya's cloud: timed out after 250 ms/)
  })

  it('does not spend a request on every check: the answer is kept for the refresh time', async () => {
    const c = await tuyaCloud(BULB_V2)
    const ctx = ctxFor(c)
    expect((await adapter.probe(ctx)).ok).toBe(true)
    expect((await adapter.probe(ctx)).ok).toBe(true)
    expect(c.count('GET', DEVICE)).toBe(1)
    advance(301_000)
    expect((await adapter.probe(ctx)).ok).toBe(true)
    expect(c.count('GET', DEVICE)).toBe(2)

    const always = ctxFor(c, { config: { refreshSeconds: 0 } })
    await adapter.probe(always)
    await adapter.probe(always)
    expect(c.count('GET', DEVICE)).toBe(4)
  })

  it('checks again straight away after a failure to reach the cloud', async () => {
    const c = await tuyaCloud(BULB_V2)
    const ctx = ctxFor(c, { timeoutMs: 250 })
    expect((await adapter.probe(ctx)).ok).toBe(true)
    c.silent = true
    await expect(adapter.execute(ctx, makeAction('power.off'))).rejects.toThrow(/Could not reach Tuya's cloud/)
    const res = await adapter.probe(ctx)
    expect(res.ok).toBe(false)
  })
})

describe('tuya-cloud adapter: answers that are not Tuya’s', () => {
  const cases = [
    { broken: 'html', says: /Tuya's cloud sent an answer the hub could not read/ },
    { broken: 'bad-gateway', says: /Tuya's cloud answered with an error \(HTTP 502\)/ },
    { broken: 'unauthorized', says: /Tuya's cloud answered with an error \(HTTP 401\)/ },
    { broken: 'hang-up', says: /Could not reach Tuya's cloud: .*closed the connection/ },
  ] as const

  for (const { broken, says } of cases) {
    it(`gives a clear error, and no crash, on "${broken}"`, async () => {
      const c = await tuyaCloud(BULB_V2)
      c.broken = broken
      const ctx = ctxFor(c)
      const res = await adapter.probe(ctx)
      expect(res.ok).toBe(false)
      expect(res.latencyMs).toBeNull()
      expect(res.error).toMatch(says)
      expect(res.error).not.toMatch(/<html|DOCTYPE/i)
      // Nothing was learned, so reading and commands throw: the hub may then try another connection.
      await expect(adapter.readState!(ctx)).rejects.toThrow(says)
      await expect(adapter.execute(ctx, makeAction('power.on'))).rejects.toThrow(says)
    })

    it(`tells the truth at the next check after "${broken}", and recovers by itself`, async () => {
      const c = await tuyaCloud(BULB_V2)
      const ctx = ctxFor(c, { config: { dimmable: false } })
      expect((await adapter.probe(ctx)).ok).toBe(true)
      c.broken = broken
      await expect(adapter.execute(ctx, makeAction('power.off'))).rejects.toThrow(says)
      // The remembered "reachable" answer is dropped, so the very next check is a real one.
      expect((await adapter.probe(ctx)).ok).toBe(false)
      c.broken = null
      expect((await adapter.probe(ctx)).ok).toBe(true)
      expect(await adapter.execute(ctx, makeAction('power.off'))).toEqual({ ok: true, state: { power: false } })
    })
  }

  it('gives up on a status read that takes too long', async () => {
    const c = await tuyaCloud(BULB_V2)
    const ctx = ctxFor(c, { timeoutMs: 250 })
    c.silent = true
    const started = Date.now()
    await expect(adapter.readState!(ctx)).rejects.toThrow(/Could not reach Tuya's cloud: timed out after 250 ms/)
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('tells the owner to renew when the Tuya trial has run out, without throwing', async () => {
    const c = await tuyaCloud(BULB_V2)
    c.planExpired = true
    const ctx = ctxFor(c)
    const res = await adapter.probe(ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/plan has run out/)
    expect(res.error).toMatch(/renew it on the Tuya developer website/)
    expect(res.error).toMatch(/Tuya said: No permissions\. Your subscription to cloud development plan has expired\./)
    // The refusal is remembered for a minute, so a lapsed plan is not asked about every few seconds.
    await adapter.probe(ctx)
    await adapter.probe(ctx)
    expect(c.count('GET', DEVICE)).toBe(1)
    // A refusal by Tuya is an answer, not a dead connection: it is returned, and no new token is asked for.
    const act = await adapter.execute(ctxFor(c, { config: { switchCode: 'switch_led' } }), makeAction('power.on'))
    expect(act.ok).toBe(false)
    expect(act.error).toMatch(/plan has run out/)
    expect(c.count('GET', '/v1.0/token')).toBe(1)
    c.planExpired = false
    expect((await adapter.probe(ctx)).ok).toBe(true)
  })
})

describe('tuya-cloud adapter: access token', () => {
  it('uses one token for every call, even when two start together', async () => {
    const c = await tuyaCloud(BULB_V2, BULB_V2_SPEC)
    const ctx = ctxFor(c)
    await Promise.all([adapter.probe(ctx), adapter.readState!(ctx)])
    await adapter.execute(ctx, makeAction('power.off'))
    expect(c.count('GET', '/v1.0/token')).toBe(1)
    const used = new Set(c.server.requests.filter((r) => r.path !== '/v1.0/token').map((r) => r.headers.access_token))
    expect([...used]).toEqual([c.validToken])
  })

  it('asks for a new token shortly before the old one expires', async () => {
    const c = await tuyaCloud(BULB_V2)
    const ctx = ctxFor(c, { config: { refreshSeconds: 0, dimmable: false } })
    await adapter.readState!(ctx)
    advance((7200 - 61) * 1000)
    await adapter.readState!(ctx)
    expect(c.count('GET', '/v1.0/token')).toBe(1)
    advance(2000)
    await adapter.readState!(ctx)
    expect(c.count('GET', '/v1.0/token')).toBe(2)
    expect(c.server.requests.at(-1)!.headers.access_token).toBe(c.validToken)
  })

  it('gets a new token and retries once when Tuya says "token invalid"', async () => {
    const c = await tuyaCloud(BULB_V2)
    const ctx = ctxFor(c, { config: { refreshSeconds: 0, dimmable: false } })
    await adapter.readState!(ctx)
    c.validToken = null // e.g. the same project signed in somewhere else
    const state = await adapter.readState!(ctx)
    expect(state.power).toBe(true)
    expect(c.calls()).toEqual(['GET /v1.0/token', `GET ${DEVICE}/status`, `GET ${DEVICE}/status`, 'GET /v1.0/token', `GET ${DEVICE}/status`])
  })

  it('gives up after that one retry', async () => {
    const c = await tuyaCloud(BULB_V2)
    c.rejectAllTokens = true
    const res = await adapter.execute(ctxFor(c, { config: { switchCode: 'switch_led' } }), makeAction('power.on'))
    expect(res).toEqual({ ok: false, error: 'Tuya said: token invalid' })
    expect(c.calls()).toEqual(['GET /v1.0/token', `POST ${DEVICE}/commands`, 'GET /v1.0/token', `POST ${DEVICE}/commands`])
  })
})

describe('tuya-cloud adapter: reading state', () => {
  it('reads power and brightness from a bulb (bright_value_v2 10-1000)', async () => {
    const c = await tuyaCloud(BULB_V2, BULB_V2_SPEC)
    expect(await adapter.readState!(ctxFor(c))).toEqual({ power: true, brightness: 50 })
    expect(c.calls()).toEqual(['GET /v1.0/token', `GET ${DEVICE}/status`, `GET ${DEVICE}/specification`])
    c.status.find((d) => d.code === 'bright_value_v2')!.value = 1000
    c.status.find((d) => d.code === 'switch_led')!.value = false
    expect(await adapter.readState!(ctxFor(c, { config: { refreshSeconds: 0 } }))).toEqual({ power: false, brightness: 100 })
    c.status.find((d) => d.code === 'bright_value_v2')!.value = 10
    expect(await adapter.readState!(ctxFor(c, { config: { refreshSeconds: 0 } }))).toEqual({ power: false, brightness: 1 })
    // The specification is read once per device, not on every status read.
    expect(c.count('GET', `${DEVICE}/specification`)).toBe(1)
  })

  it('falls back to the documented range of older bulbs (bright_value 25-255) when the specification cannot be read', async () => {
    const c = await tuyaCloud(OLD_BULB, null)
    const ctx = ctxFor(c, { config: { refreshSeconds: 0 } })
    expect(await adapter.readState!(ctx)).toEqual({ power: true, brightness: 100 })
    c.status.find((d) => d.code === 'bright_value')!.value = 25
    expect(await adapter.readState!(ctx)).toEqual({ power: true, brightness: 1 })
    c.status.find((d) => d.code === 'bright_value')!.value = 140 // exactly half way up 25-255
    expect(await adapter.readState!(ctx)).toEqual({ power: true, brightness: 51 })
    expect(c.count('GET', `${DEVICE}/specification`)).toBe(1)
  })

  it('reads a plain switch and a socket, and a chosen button of a multi-button switch', async () => {
    const sw = await tuyaCloud([{ code: 'switch_1', value: false }, { code: 'switch_2', value: true }, { code: 'countdown_1', value: 0 }])
    expect(await adapter.readState!(ctxFor(sw, { kind: 'switch' }))).toEqual({ power: false })
    expect(await adapter.readState!(ctxFor(sw, { kind: 'switch', config: { switchCode: 'switch_2' } }))).toEqual({ power: true })
    await sw.server.close()
    const socket = await tuyaCloud([{ code: 'switch', value: true }, { code: 'countdown_1', value: 0 }])
    expect(await adapter.readState!(ctxFor(socket, { kind: 'switch' }))).toEqual({ power: true })
  })

  it('reads the colour of a colour bulb, also when Tuya sends it as text', async () => {
    const c = await tuyaCloud(BULB_V2, BULB_V2_SPEC)
    const ctx = ctxFor(c, { config: { colour: true, refreshSeconds: 0 } })
    expect(await adapter.readState!(ctx)).toEqual({ power: true, colorMode: 'white', brightness: 50 })
    c.status.find((d) => d.code === 'work_mode')!.value = 'colour'
    expect(await adapter.readState!(ctx)).toEqual({ power: true, colorMode: 'colour', color: '#7dd1ff', brightness: 90 })
    c.status.find((d) => d.code === 'colour_data_v2')!.value = '{"h":0,"s":1000,"v":1000}'
    expect(await adapter.readState!(ctx)).toEqual({ power: true, colorMode: 'colour', color: '#ff0000', brightness: 100 })
  })

  it('keeps the status for the refresh time, then asks again', async () => {
    const c = await tuyaCloud(BULB_V2, BULB_V2_SPEC)
    const ctx = ctxFor(c)
    await adapter.readState!(ctx)
    c.status.find((d) => d.code === 'switch_led')!.value = false // switched off at the wall
    expect((await adapter.readState!(ctx)).power).toBe(true)
    expect(c.count('GET', `${DEVICE}/status`)).toBe(1)
    advance(301_000)
    expect((await adapter.readState!(ctx)).power).toBe(false)
    expect(c.count('GET', `${DEVICE}/status`)).toBe(2)
  })

  it('passes on Tuya’s refusal and a dead connection as errors', async () => {
    const c = await tuyaCloud(BULB_V2)
    await expect(adapter.readState!(ctxFor(c, { config: { deviceId: 'someoneelsesdevice00xyz' } }))).rejects.toThrow(/permission deny/)
    const ctx = ctxFor(c)
    await c.server.close()
    await expect(adapter.readState!(ctx)).rejects.toThrow(/Could not reach Tuya's cloud/)
  })
})

describe('tuya-cloud adapter: on and off', () => {
  it('sends the documented command body, signed with the hash of that body', async () => {
    const c = await tuyaCloud(BULB_V2)
    const res = await adapter.execute(ctxFor(c), makeAction('power.off'))
    expect(res).toEqual({ ok: true, state: { power: false } })
    // The on/off code is found from the status first (switch_led on a bulb).
    expect(c.calls()).toEqual(['GET /v1.0/token', `GET ${DEVICE}/status`, `POST ${DEVICE}/commands`])
    const post = c.server.requests.at(-1)!
    expect(post.method).toBe('POST')
    expect(post.url).toBe(`${DEVICE}/commands`)
    expect(post.body).toBe('{"commands":[{"code":"switch_led","value":false}]}')
    expect(post.headers['content-type']).toBe('application/json')
    // Sent in one piece with its length, never in chunks.
    expect(post.headers['content-length']).toBe(String(Buffer.byteLength(post.body)))
    expect(post.headers['transfer-encoding']).toBeUndefined()
    expect(post.headers.client_id).toBe(ACCESS_ID)
    expect(post.headers.access_token).toBe(c.validToken)
    expect(post.headers.sign_method).toBe('HMAC-SHA256')
    expect(post.headers.t).toMatch(/^\d{13}$/)
    expect(post.headers.sign).toBe(documentedSign(post, ACCESS_SECRET, true))
    expect(c.status.find((d) => d.code === 'switch_led')!.value).toBe(false)

    const on = await adapter.execute(ctxFor(c), makeAction('power.on'))
    expect(on).toEqual({ ok: true, state: { power: true } })
    expect(c.posts().at(-1)).toBe('{"commands":[{"code":"switch_led","value":true}]}')
    // No second status read was needed to send it.
    expect(c.count('GET', `${DEVICE}/status`)).toBe(1)
  })

  it('finds switch_1 on a switch and switch on a socket', async () => {
    const sw = await tuyaCloud([{ code: 'switch_1', value: false }, { code: 'countdown_1', value: 0 }])
    expect(await adapter.execute(ctxFor(sw, { kind: 'switch' }), makeAction('power.on'))).toEqual({ ok: true, state: { power: true } })
    expect(sw.posts()).toEqual(['{"commands":[{"code":"switch_1","value":true}]}'])
    await sw.server.close()
    const socket = await tuyaCloud([{ code: 'switch', value: true }])
    expect(await adapter.execute(ctxFor(socket, { kind: 'switch' }), makeAction('power.off'))).toEqual({ ok: true, state: { power: false } })
    expect(socket.posts()).toEqual(['{"commands":[{"code":"switch","value":false}]}'])
  })

  it('uses the on/off code from the settings without asking for the status', async () => {
    const c = await tuyaCloud([{ code: 'switch_1', value: false }, { code: 'switch_2', value: false }])
    const res = await adapter.execute(ctxFor(c, { kind: 'switch', config: { switchCode: 'switch_2' } }), makeAction('power.on'))
    expect(res.ok).toBe(true)
    expect(c.calls()).toEqual(['GET /v1.0/token', `POST ${DEVICE}/commands`])
    expect(c.posts()).toEqual(['{"commands":[{"code":"switch_2","value":true}]}'])
  })

  it('toggles from the present state, read fresh', async () => {
    const c = await tuyaCloud(BULB_V2)
    const ctx = ctxFor(c, { config: { dimmable: false } })
    await adapter.readState!(ctx)
    c.status.find((d) => d.code === 'switch_led')!.value = false // changed elsewhere since the last read
    const res = await adapter.execute(ctx, makeAction('power.toggle'))
    expect(res).toEqual({ ok: true, state: { power: true } })
    expect(c.posts()).toEqual(['{"commands":[{"code":"switch_led","value":true}]}'])
    const again = await adapter.execute(ctx, makeAction('power.toggle'))
    expect(again.state).toEqual({ power: false })
    expect(c.posts().at(-1)).toBe('{"commands":[{"code":"switch_led","value":false}]}')
  })

  it('shows the new state at once after a command, then confirms it with Tuya a few seconds later', async () => {
    const c = await tuyaCloud(BULB_V2)
    const ctx = ctxFor(c, { config: { dimmable: false } })
    expect(await adapter.readState!(ctx)).toEqual({ power: true })
    await adapter.execute(ctx, makeAction('power.off'))
    expect(await adapter.readState!(ctx)).toEqual({ power: false })
    expect(c.count('GET', `${DEVICE}/status`)).toBe(1)
    advance(5100)
    expect(await adapter.readState!(ctx)).toEqual({ power: false })
    expect(c.count('GET', `${DEVICE}/status`)).toBe(2)
  })

  it('says so when the device has no on/off code it knows', async () => {
    const c = await tuyaCloud([{ code: 'va_temperature', value: 245 }])
    const res = await adapter.execute(ctxFor(c, { kind: 'switch' }), makeAction('power.on'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/does not report an on\/off switch/)
    expect(c.count('POST', `${DEVICE}/commands`)).toBe(0)
  })

  it('returns Tuya’s own message when the command is refused', async () => {
    const c = await tuyaCloud(BULB_V2)
    c.offline = true
    const res = await adapter.execute(ctxFor(c), makeAction('power.on'))
    expect(res.ok).toBe(false)
    expect(res.error).toBe('The device is offline: check its power and its WiFi (Tuya said: device is offline)')
    expect(res.needsConfirmation).toBeUndefined()

    c.offline = false
    const bad = await adapter.execute(ctxFor(c, { config: { switchCode: 'switch_9' } }), makeAction('power.on'))
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/does not accept this command \(Tuya said: command or value not support\)/)
  })

  it('throws when the cloud cannot be reached, so the hub can try another connection', async () => {
    const c = await tuyaCloud(BULB_V2)
    const ctx = ctxFor(c)
    await c.server.close()
    await expect(adapter.execute(ctx, makeAction('power.on'))).rejects.toThrow(/Could not reach Tuya's cloud/)
  })
})

describe('tuya-cloud adapter: brightness', () => {
  it('maps 0-100 onto bright_value_v2 and switches the light on with it', async () => {
    const c = await tuyaCloud(BULB_V2, BULB_V2_SPEC)
    const ctx = ctxFor(c)
    const res = await adapter.execute(ctx, makeAction('dim.set', { brightness: 50 }))
    expect(res).toEqual({ ok: true, state: { power: true, brightness: 50 } })
    expect(c.calls()).toEqual(['GET /v1.0/token', `GET ${DEVICE}/status`, `GET ${DEVICE}/specification`, `POST ${DEVICE}/commands`])
    expect(c.posts()).toEqual(['{"commands":[{"code":"switch_led","value":true},{"code":"bright_value_v2","value":500}]}'])
    await adapter.execute(ctx, makeAction('dim.set', { brightness: 100 }))
    await adapter.execute(ctx, makeAction('dim.set', { brightness: 1 }))
    await adapter.execute(ctx, makeAction('dim.set', { brightness: 250 }))
    expect(c.posts().slice(1)).toEqual([
      '{"commands":[{"code":"switch_led","value":true},{"code":"bright_value_v2","value":1000}]}',
      '{"commands":[{"code":"switch_led","value":true},{"code":"bright_value_v2","value":10}]}',
      '{"commands":[{"code":"switch_led","value":true},{"code":"bright_value_v2","value":1000}]}',
    ])
    expect(c.count('GET', `${DEVICE}/status`)).toBe(1)
    expect(c.count('GET', `${DEVICE}/specification`)).toBe(1)
  })

  it('maps 0-100 onto bright_value 25-255 on older bulbs', async () => {
    const c = await tuyaCloud(OLD_BULB, null)
    const ctx = ctxFor(c)
    await adapter.execute(ctx, makeAction('dim.set', { brightness: 100 }))
    await adapter.execute(ctx, makeAction('dim.set', { brightness: 1 }))
    expect(c.posts()).toEqual([
      '{"commands":[{"code":"switch_led","value":true},{"code":"bright_value","value":255}]}',
      '{"commands":[{"code":"switch_led","value":true},{"code":"bright_value","value":25}]}',
    ])
  })

  it('follows what the bulb is showing: in colour mode the slider reads and changes v, even with the colour controls off', async () => {
    const c = await tuyaCloud(BULB_V2, BULB_V2_SPEC)
    c.status.find((d) => d.code === 'work_mode')!.value = 'colour' // put in colour mode from the Smart Life app
    const ctx = ctxFor(c, { config: { refreshSeconds: 0 } })
    // colour_data_v2 v 899 of 1000, not bright_value_v2 500 of 1000.
    expect(await adapter.readState!(ctx)).toEqual({ power: true, brightness: 90 })
    const res = await adapter.execute(ctx, makeAction('dim.set', { brightness: 40 }))
    expect(res).toEqual({ ok: true, state: { power: true, brightness: 40 } })
    expect(c.posts()).toEqual(['{"commands":[{"code":"switch_led","value":true},{"code":"colour_data_v2","value":{"h":201,"s":511,"v":400}}]}'])
    expect(await adapter.readState!(ctx)).toEqual({ power: true, brightness: 40 })

    // A scene keeps its own look; the white brightness is what the slider moves there.
    c.status.find((d) => d.code === 'work_mode')!.value = 'scene_2'
    expect(await adapter.readState!(ctx)).toEqual({ power: true, brightness: 50 })
  })

  it('switches off at brightness 0 instead of sending a value below the range', async () => {
    const c = await tuyaCloud(BULB_V2, BULB_V2_SPEC)
    const res = await adapter.execute(ctxFor(c), makeAction('dim.set', { brightness: 0 }))
    expect(res).toEqual({ ok: true, state: { power: false } })
    expect(c.posts()).toEqual(['{"commands":[{"code":"switch_led","value":false}]}'])
  })

  it('refuses when there is nothing to dim', async () => {
    const sw = await tuyaCloud([{ code: 'switch_1', value: true }])
    const asSwitch = await adapter.execute(ctxFor(sw, { kind: 'switch' }), makeAction('dim.set', { brightness: 40 }))
    expect(asSwitch).toEqual({ ok: false, error: 'This device cannot do "dim.set"' })
    const asLight = await adapter.execute(ctxFor(sw, { kind: 'light' }), makeAction('dim.set', { brightness: 40 }))
    expect(asLight.ok).toBe(false)
    expect(asLight.error).toMatch(/does not report a brightness setting/)
    const noValue = await adapter.execute(ctxFor(sw, { kind: 'light' }), makeAction('dim.set', {}))
    expect(noValue).toEqual({ ok: false, error: 'No brightness given' })
    expect(sw.count('POST', `${DEVICE}/commands`)).toBe(0)
  })
})

describe('tuya-cloud adapter: colour', () => {
  it('sets a colour as colour_data_v2 {h,s,v} and puts the bulb in colour mode', async () => {
    const c = await tuyaCloud(BULB_V2, BULB_V2_SPEC)
    const ctx = ctxFor(c, { config: { colour: true } })
    const res = await adapter.execute(ctx, makeAction('color.set', { hex: '#ff0000' }))
    expect(res).toEqual({ ok: true, state: { power: true, colorMode: 'colour', color: '#ff0000', brightness: 100 } })
    expect(c.posts()).toEqual(['{"commands":[{"code":"switch_led","value":true},{"code":"work_mode","value":"colour"},{"code":"colour_data_v2","value":{"h":0,"s":1000,"v":1000}}]}'])

    // In colour mode the brightness slider changes v and keeps the colour.
    await adapter.execute(ctx, makeAction('dim.set', { brightness: 40 }))
    expect(c.posts().at(-1)).toBe('{"commands":[{"code":"switch_led","value":true},{"code":"colour_data_v2","value":{"h":0,"s":1000,"v":400}}]}')
  })

  it('sets warm / cool white as temp_value_v2 0-1000 in white mode', async () => {
    const c = await tuyaCloud(BULB_V2, BULB_V2_SPEC)
    const ctx = ctxFor(c, { config: { colour: true } })
    const cool = await adapter.execute(ctx, makeAction('color.set', { temperature: 6500 }))
    expect(cool.ok).toBe(true)
    await adapter.execute(ctx, makeAction('color.set', { temperature: 2700 }))
    expect(c.posts()).toEqual([
      '{"commands":[{"code":"switch_led","value":true},{"code":"work_mode","value":"white"},{"code":"temp_value_v2","value":1000}]}',
      '{"commands":[{"code":"switch_led","value":true},{"code":"work_mode","value":"white"},{"code":"temp_value_v2","value":0}]}',
    ])
  })

  it('refuses colour on a light that is not set up as a colour light, and nonsense colours', async () => {
    const c = await tuyaCloud(BULB_V2, BULB_V2_SPEC)
    expect(await adapter.execute(ctxFor(c), makeAction('color.set', { hex: '#00ff00' }))).toEqual({ ok: false, error: 'This device cannot do "color.set"' })
    const bad = await adapter.execute(ctxFor(c, { config: { colour: true } }), makeAction('color.set', { hex: 'greenish' }))
    expect(bad.ok).toBe(false)
    const none = await adapter.execute(ctxFor(c, { config: { colour: true } }), makeAction('color.set', {}))
    expect(none).toEqual({ ok: false, error: 'No colour given' })
    expect(c.count('POST', `${DEVICE}/commands`)).toBe(0)
  })
})

describe('tuya-cloud adapter: garage door opener', () => {
  it('reads open / closed from the door sensor', async () => {
    const c = await tuyaCloud(GARAGE)
    const ctx = ctxFor(c, { kind: 'gate', config: { refreshSeconds: 0 } })
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'closed' })
    c.status.find((d) => d.code === 'doorcontact_state')!.value = true
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'open' })
    c.status = [{ code: 'switch_1', value: false }]
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'unknown' })
  })

  it('opens with switch_1 true and reports opening until the sensor says open', async () => {
    const c = await tuyaCloud(GARAGE)
    const ctx = ctxFor(c, { kind: 'gate' })
    const res = await adapter.execute(ctx, makeAction('gate.open'))
    expect(res).toEqual({ ok: true, state: { gate: 'opening' } })
    expect(c.calls()).toEqual(['GET /v1.0/token', `GET ${DEVICE}/status`, `POST ${DEVICE}/commands`])
    expect(c.posts()).toEqual(['{"commands":[{"code":"switch_1","value":true}]}'])

    // The hub asks every second while the door moves; Tuya is asked only every few seconds.
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'opening' })
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'opening' })
    expect(c.count('GET', `${DEVICE}/status`)).toBe(1)
    advance(3100)
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'opening' })
    expect(c.count('GET', `${DEVICE}/status`)).toBe(2)
    c.status.find((d) => d.code === 'doorcontact_state')!.value = true
    advance(3100)
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'open' })
    expect(c.count('GET', `${DEVICE}/status`)).toBe(3)
  })

  it('closes with switch_1 false and tells the truth when the door never closes', async () => {
    const c = await tuyaCloud(GARAGE)
    c.status.find((d) => d.code === 'doorcontact_state')!.value = true
    c.status.find((d) => d.code === 'switch_1')!.value = true
    const ctx = ctxFor(c, { kind: 'gate' })
    const res = await adapter.execute(ctx, makeAction('gate.close'))
    expect(res).toEqual({ ok: true, state: { gate: 'closing' } })
    expect(c.posts()).toEqual(['{"commands":[{"code":"switch_1","value":false}]}'])
    advance(10_000)
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'closing' })
    // tr_timecon says the door travels for 20 s; after that the sensor is believed.
    advance(16_000)
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'open' })
  })

  it('looks again when the travel time is over, so a door that arrived late is not shown in its old place', async () => {
    const c = await tuyaCloud(GARAGE)
    const ctx = ctxFor(c, { kind: 'gate' })
    await adapter.execute(ctx, makeAction('gate.open'))
    advance(23_000)
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'opening' }) // sensor still says closed
    const reads = c.count('GET', `${DEVICE}/status`)
    c.status.find((d) => d.code === 'doorcontact_state')!.value = true // arrives just after that reading
    advance(2_500) // tr_timecon 20 s + 5 s are over; the last reading is only 2.5 s old
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'open' })
    expect(c.count('GET', `${DEVICE}/status`)).toBe(reads + 1)
    // Arrived: back to the slow rhythm.
    advance(60_000)
    await adapter.readState!(ctx)
    expect(c.count('GET', `${DEVICE}/status`)).toBe(reads + 1)
  })

  it('checks a door that had not arrived once more half a minute later', async () => {
    const c = await tuyaCloud(GARAGE)
    const ctx = ctxFor(c, { kind: 'gate' })
    await adapter.execute(ctx, makeAction('gate.open'))
    advance(26_000)
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'closed' }) // never left, or is very slow
    const reads = c.count('GET', `${DEVICE}/status`)
    c.status.find((d) => d.code === 'doorcontact_state')!.value = true
    advance(15_000)
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'closed' })
    expect(c.count('GET', `${DEVICE}/status`)).toBe(reads)
    advance(16_000)
    expect(await adapter.readState!(ctx)).toEqual({ gate: 'open' })
    expect(c.count('GET', `${DEVICE}/status`)).toBe(reads + 1)
  })

  it('still sends the command when the door is already there, and says so', async () => {
    const c = await tuyaCloud(GARAGE)
    const res = await adapter.execute(ctxFor(c, { kind: 'gate' }), makeAction('gate.close'))
    expect(res).toEqual({ ok: true, state: { gate: 'closed' }, result: { alreadyThere: true } })
    expect(c.posts()).toEqual(['{"commands":[{"code":"switch_1","value":false}]}'])
  })

  it('a pulse moves the door the other way', async () => {
    const c = await tuyaCloud(GARAGE)
    const ctx = ctxFor(c, { kind: 'gate' })
    expect((await adapter.execute(ctx, makeAction('gate.pulse'))).state).toEqual({ gate: 'opening' })
    c.status.find((d) => d.code === 'doorcontact_state')!.value = true
    expect((await adapter.execute(ctx, makeAction('gate.pulse'))).state).toEqual({ gate: 'closing' })
    expect(c.posts()).toEqual(['{"commands":[{"code":"switch_1","value":true}]}', '{"commands":[{"code":"switch_1","value":false}]}'])
  })

  it('has no stop, and no plain on / off', async () => {
    const c = await tuyaCloud(GARAGE)
    const ctx = ctxFor(c, { kind: 'gate' })
    const stop = await adapter.execute(ctx, makeAction('gate.stop'))
    expect(stop.ok).toBe(false)
    expect(stop.error).toMatch(/no stop command/)
    expect(await adapter.execute(ctx, makeAction('power.on'))).toEqual({ ok: false, error: 'This device cannot do "power.on"' })
    expect(c.server.requests).toHaveLength(0)
  })

  it('refuses gate commands on a light', async () => {
    const c = await tuyaCloud(BULB_V2)
    expect(await adapter.execute(ctxFor(c), makeAction('gate.open'))).toEqual({ ok: false, error: 'This device cannot do "gate.open"' })
    expect(c.server.requests).toHaveLength(0)
  })
})

describe('tuya-cloud adapter: plain switch wired to the gate’s push-button', () => {
  const PULSE = { gateMode: 'pulse', pulseSeconds: 0.2 }

  it('presses the button: on, a short wait, off', async () => {
    const c = await tuyaCloud([{ code: 'switch_1', value: false }, { code: 'countdown_1', value: 0 }])
    const ctx = ctxFor(c, { kind: 'gate', config: PULSE })
    const started = Date.now()
    const res = await adapter.execute(ctx, makeAction('gate.open'))
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    expect(res).toEqual({ ok: true, result: { pressed: 'switch_1', seconds: 0.2 } })
    expect(res.needsConfirmation).toBeUndefined()
    expect(c.posts()).toEqual(['{"commands":[{"code":"switch_1","value":true}]}', '{"commands":[{"code":"switch_1","value":false}]}'])
    expect(c.status.find((d) => d.code === 'switch_1')!.value).toBe(false)

    for (const type of ['gate.close', 'gate.pulse', 'gate.stop'] as const) {
      expect((await adapter.execute(ctx, makeAction(type))).ok).toBe(true)
    }
    expect(c.posts()).toHaveLength(8)
  })

  it('reads no state, and spends no request trying', async () => {
    const c = await tuyaCloud([{ code: 'switch_1', value: false }])
    expect(await adapter.readState!(ctxFor(c, { kind: 'gate', config: PULSE }))).toEqual({})
    expect(c.server.requests).toHaveLength(0)
  })

  it('tries again to switch off, and warns the owner when the switch may still be on', async () => {
    const c = await tuyaCloud([{ code: 'switch_1', value: false }])
    c.failOff = 1
    const ctx = ctxFor(c, { kind: 'gate', config: PULSE })
    expect((await adapter.execute(ctx, makeAction('gate.pulse'))).ok).toBe(true)
    expect(c.posts()).toHaveLength(3)
    expect(c.status.find((d) => d.code === 'switch_1')!.value).toBe(false)

    c.failOff = 5
    const res = await adapter.execute(ctx, makeAction('gate.pulse'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/turned on but could not be turned off again/)
    expect(res.error).toMatch(/device is offline/)
    expect(c.posts()).toHaveLength(6)
  })
})

describe('tuya-cloud adapter: other commands', () => {
  it('sends a custom code / value pair as given', async () => {
    const c = await tuyaCloud([{ code: 'switch_1', value: false }, { code: 'countdown_1', value: 0 }])
    const ctx = ctxFor(c, { kind: 'switch' })
    expect(await adapter.execute(ctx, makeAction('custom', { code: 'countdown_1', value: 60 }))).toEqual({ ok: true, result: { sent: ['countdown_1'] } })
    await adapter.execute(ctx, makeAction('custom', { commands: [{ code: 'switch_1', value: true }, { code: 'countdown_1', value: 0 }] }))
    expect(c.posts()).toEqual([
      '{"commands":[{"code":"countdown_1","value":60}]}',
      '{"commands":[{"code":"switch_1","value":true},{"code":"countdown_1","value":0}]}',
    ])
    const empty = await adapter.execute(ctx, makeAction('custom', {}))
    expect(empty.ok).toBe(false)
    const broken = await adapter.execute(ctx, makeAction('custom', { commands: [{ code: 'switch_1' }] }))
    expect(broken.ok).toBe(false)
    expect(c.posts()).toHaveLength(2)
  })

  it('refuses what a Tuya light or switch cannot do', async () => {
    const c = await tuyaCloud(BULB_V2)
    const ctx = ctxFor(c)
    for (const type of ['ptz.move', 'ptz.stop', 'ptz.preset', 'reboot', 'sms.send'] as const) {
      const res = await adapter.execute(ctx, makeAction(type))
      expect(res).toEqual({ ok: false, error: `This device cannot do "${type}"` })
    }
    expect(c.server.requests).toHaveLength(0)
    expect(ctx.smsSent).toHaveLength(0)
  })
})
