/**
 * Test helpers shared by every adapter test: build an AdapterContext without a
 * running hub, stand up a mock device on 127.0.0.1, and guard it with the same
 * HTTP digest challenge real cameras use.
 */
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Action, ActionType, ConnectionPath, Device, DeviceKind, Family } from '@house/shared'
import { getAdapter } from '../src/adapters/index.ts'
import type { AdapterContext, SmsOutcome } from '../src/adapters/types.ts'
import { logger } from '../src/lib/log.ts'

export interface CtxOptions {
  family: Family
  kind?: DeviceKind
  name?: string
  config?: Record<string, unknown>
  path?: Partial<ConnectionPath>
  /** House WiFi networks by id. */
  wifi?: Record<string, { ssid: string; password: string }>
  /** What the hub's SMS transport answers. Default: no modem, hand off to the phone. */
  sms?: (to: string, text: string) => Promise<SmsOutcome>
  timeoutMs?: number
}

export type TestCtx = AdapterContext & { smsSent: Array<{ to: string; text: string }> }

export function makeCtx(opts: CtxOptions): TestCtx {
  const config = opts.config ?? {}
  const kind = opts.kind ?? 'camera'
  const path: ConnectionPath = {
    id: 'pth_test',
    deviceId: 'dev_test',
    priority: 0,
    kind: 'lan',
    label: 'Home WiFi',
    wifiNetworkId: null,
    host: '127.0.0.1',
    port: null,
    extra: {},
    enabled: true,
    ...opts.path,
  }
  let capabilities: Device['capabilities'] = []
  try {
    capabilities = getAdapter(opts.family).capabilities(config, kind)
  } catch {
    capabilities = []
  }
  const device: Device = {
    id: 'dev_test',
    name: opts.name ?? 'Test device',
    kind,
    family: opts.family,
    room: 'Lab',
    notify: 'important',
    config,
    capabilities,
    paths: [path],
    sort: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
  const smsSent: Array<{ to: string; text: string }> = []
  return {
    device,
    path,
    secret: (name) => {
      const v = config[name]
      return typeof v === 'string' && v.length > 0 ? v : undefined
    },
    str: (name, fallback = '') => {
      const v = config[name]
      return v === undefined || v === null ? fallback : String(v)
    },
    num: (name, fallback = 0) => {
      const v = config[name]
      const n = Number(v)
      return Number.isFinite(n) && v !== '' && v !== null && v !== undefined ? n : fallback
    },
    bool: (name, fallback = false) => {
      const v = config[name]
      if (v === undefined || v === null || v === '') return fallback
      return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
    },
    wifi: (id) => {
      const w = opts.wifi?.[id]
      return w ? { id, ...w } : undefined
    },
    sms: async (to, text) => {
      smsSent.push({ to, text })
      return opts.sms ? opts.sms(to, text) : { sent: false, handoff: `sms:${to}?body=${encodeURIComponent(text)}` }
    },
    timeoutMs: opts.timeoutMs ?? 2000,
    log: logger('test'),
    smsSent,
  }
}

export function makeAction(type: ActionType, params: Record<string, unknown> = {}): Action {
  return {
    id: 'act_test',
    deviceId: 'dev_test',
    type,
    params,
    status: 'running',
    pathId: 'pth_test',
    label: type,
    source: 'app',
    requestedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  }
}

export interface RecordedRequest {
  method: string
  url: string
  path: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  body: string
}

export interface MockServer {
  port: number
  url: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

export type MockHandler = (req: RecordedRequest, res: http.ServerResponse, raw: http.IncomingMessage) => void | Promise<void>

/** A mock device on 127.0.0.1:<random port>. Every request is recorded. */
export function mockServer(handler: MockHandler): Promise<MockServer> {
  const requests: RecordedRequest[] = []
  const server = http.createServer((raw, res) => {
    const chunks: Buffer[] = []
    raw.on('data', (c: Buffer) => chunks.push(c))
    raw.on('end', () => {
      const u = new URL(raw.url ?? '/', 'http://mock')
      const req: RecordedRequest = {
        method: raw.method ?? 'GET',
        url: raw.url ?? '/',
        path: u.pathname,
        query: u.searchParams,
        headers: raw.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(req)
      Promise.resolve(handler(req, res, raw)).catch((err) => {
        if (!res.headersSent) res.writeHead(500)
        res.end(String(err))
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      })
    })
  })
}

/**
 * HTTP Digest (RFC 2617, MD5, qop=auth) the way IP cameras do it. Returns true
 * when the request carries a valid Authorization header; otherwise answers 401
 * with a challenge and returns false.
 */
export function digestGuard(username: string, password: string, realm = 'IP Camera') {
  const nonce = crypto.randomBytes(8).toString('hex')
  const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')
  return (req: RecordedRequest, res: http.ServerResponse): boolean => {
    const header = req.headers.authorization ?? ''
    if (/^digest/i.test(header)) {
      const p: Record<string, string> = {}
      const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g
      let m: RegExpExecArray | null
      while ((m = re.exec(header))) p[m[1]!] = (m[2] ?? m[3] ?? '').trim()
      const ha1 = md5(`${p.username}:${realm}:${password}`)
      const ha2 = md5(`${req.method}:${p.uri}`)
      const expected = p.qop ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`)
      if (p.username === username && p.response === expected && p.uri === req.url) return true
    }
    res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="${md5(nonce)}"` })
    res.end()
    return false
  }
}

/** HTTP Basic guard, same contract as digestGuard. */
export function basicGuard(username: string, password: string, realm = 'device') {
  const expected = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
  return (req: RecordedRequest, res: http.ServerResponse): boolean => {
    if (req.headers.authorization === expected) return true
    res.writeHead(401, { 'WWW-Authenticate': `Basic realm="${realm}"` })
    res.end()
    return false
  }
}

export function send(res: http.ServerResponse, status: number, body: string | Buffer | object, contentType?: string): void {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body)
  const payload = isObj ? JSON.stringify(body) : (body as string | Buffer)
  res.writeHead(status, { 'Content-Type': contentType ?? (isObj ? 'application/json' : 'text/plain') })
  res.end(payload)
}

/** A tiny valid JPEG, for snapshot endpoints. */
export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
  'base64',
)
