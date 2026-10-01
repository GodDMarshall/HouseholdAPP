import crypto from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import { config } from '../config.ts'

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message)
  }
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number
  /** Basic auth. */
  basic?: { username: string; password: string }
  /**
   * Digest auth (Hikvision, Dahua, ONVIF over HTTP, Shelly Gen2). The password
   * is only ever sent as a nonce-bound hash. If the device answers with a Basic
   * challenge instead, the password is sent in clear ONLY over https or when the
   * caller sets allowBasic (a trusted house network, an old device).
   */
  digest?: { username: string; password: string; allowBasic?: boolean }
  /** Accept self-signed certificates (Tapo, Hikvision HTTPS). */
  insecure?: boolean
}

export interface Response {
  status: number
  headers: Record<string, string>
  body: Buffer
  text(): string
  json<T = unknown>(): T
}

/**
 * Minimal HTTP client on node:http so we control timeouts, self-signed TLS and
 * digest auth without extra dependencies.
 */
export function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const u = new URL(url)
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.basic) headers.Authorization = basicHeader(opts.basic.username, opts.basic.password)
  return rawRequest(u, opts, headers).then(async (res) => {
    if (res.status === 401 && opts.digest) {
      const challenge = res.headers['www-authenticate'] ?? ''
      // Devices may offer several schemes in one header; pick the Digest one wherever it sits.
      const digest = /(?:^|,\s*)(digest\s[\s\S]*?)(?=,\s*(?:basic|bearer|negotiate|ntlm)\b|$)/i.exec(challenge)
      if (digest) {
        headers.Authorization = digestHeader(digest[1]!, opts.method ?? 'GET', u.pathname + u.search, opts.digest.username, opts.digest.password)
        return rawRequest(u, opts, headers)
      }
      if (/(?:^|,\s*)basic\b/i.test(challenge) && (u.protocol === 'https:' || opts.digest.allowBasic)) {
        headers.Authorization = basicHeader(opts.digest.username, opts.digest.password)
        return rawRequest(u, opts, headers)
      }
    }
    return res
  })
}

/** request() that throws on non-2xx. */
export async function requestOk(url: string, opts: RequestOptions = {}): Promise<Response> {
  const res = await request(url, opts)
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(`HTTP ${res.status} from ${redact(url)}`, res.status, res.text().slice(0, 500))
  }
  return res
}

function rawRequest(u: URL, opts: RequestOptions, headers: Record<string, string>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http
    const timeoutMs = opts.timeoutMs ?? config.deviceTimeoutMs
    const req = lib.request(
      u,
      {
        method: opts.method ?? 'GET',
        headers,
        timeout: timeoutMs,
        rejectUnauthorized: opts.insecure ? false : undefined,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          const hdrs: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') hdrs[k.toLowerCase()] = v
            else if (Array.isArray(v)) hdrs[k.toLowerCase()] = v.join(', ')
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: hdrs,
            body,
            text: () => body.toString('utf8'),
            json: <T,>() => JSON.parse(body.toString('utf8')) as T,
          })
        })
        res.on('error', reject)
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(`Timed out after ${timeoutMs} ms talking to ${u.host}`))
    })
    req.on('error', (err) => reject(describeNetError(err, u)))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

function describeNetError(err: Error & { code?: string }, u: URL): Error {
  switch (err.code) {
    case 'ECONNREFUSED':
      return new Error(`${u.host} refused the connection (wrong port, or the service is off)`)
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new Error(`${u.hostname} is not reachable from this network`)
    case 'ENOTFOUND':
      return new Error(`${u.hostname} could not be resolved`)
    case 'ETIMEDOUT':
      return new Error(`${u.host} did not answer (timed out)`)
    case 'ECONNRESET':
      return new Error(`${u.host} closed the connection`)
    default:
      return err
  }
}

export function basicHeader(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
}

/** RFC 7616 digest with MD5 / MD5-sess, qop=auth, as IP cameras implement it. */
export function digestHeader(challenge: string, method: string, uri: string, username: string, password: string): string {
  const params = parseChallenge(challenge)
  const realm = params.realm ?? ''
  const nonce = params.nonce ?? ''
  const opaque = params.opaque
  const algorithm = (params.algorithm ?? 'MD5').toUpperCase()
  const qopList = (params.qop ?? '').split(',').map((s) => s.trim())
  const qop = qopList.includes('auth') ? 'auth' : undefined
  const nc = '00000001'
  const cnonce = crypto.randomBytes(8).toString('hex')
  const hash = (s: string) => (algorithm.startsWith('SHA-256') ? crypto.createHash('sha256') : crypto.createHash('md5')).update(s).digest('hex')
  let ha1 = hash(`${username}:${realm}:${password}`)
  if (algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:${nonce}:${cnonce}`)
  const ha2 = hash(`${method}:${uri}`)
  const response = qop ? hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : hash(`${ha1}:${nonce}:${ha2}`)
  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ]
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  if (opaque) parts.push(`opaque="${opaque}"`)
  return 'Digest ' + parts.join(', ')
}

function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  const body = header.replace(/^digest\s+/i, '')
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out[m[1]!] = (m[2] ?? m[3] ?? '').trim()
  return out
}

/** Hide credentials in URLs before logging. */
export function redact(url: string): string {
  return url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@')
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
