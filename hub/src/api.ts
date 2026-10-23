import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import WebSocket from 'ws'
import { z } from 'zod'
import { DEVICE_KINDS, NOTIFY_LEVELS, PATH_KINDS, SECRET_MASK, type Device, type DiscoveredDevice, type HubStatus } from '@house/shared'
import { familyDescriptors, getAdapter } from './adapters/index.ts'
import type { ActionQueue } from './actions.ts'
import { ActionError } from './actions.ts'
import { Auth, AuthError } from './auth.ts'
import type { Config } from './config.ts'
import type { DeviceManager } from './devices.ts'
import type { Discovery } from './discovery.ts'
import type { Bus, EventLog } from './events.ts'
import type { TuyaAccount } from './tuya-account.ts'
import { withTimeout } from './lib/http.ts'
import type { Logger } from './lib/log.ts'
import type { Notifier } from './notify.ts'
import { NotFoundError, Registry, ValidationError } from './registry.ts'
import type { WifiMover } from './wifi.ts'
import { trackSocket, wsToken } from './ws.ts'
import { SEED_WIFI_PASSWORD_PREFIX } from './seed.ts'
import { grabSnapshot } from './snapshot.ts'
import type { VideoManager } from './video.ts'

export interface ApiDeps {
  config: Config
  registry: Registry
  devices: DeviceManager
  actions: ActionQueue
  events: EventLog
  notifier: Notifier
  auth: Auth
  video: VideoManager
  discovery: Discovery
  tuya: TuyaAccount
  wifi: WifiMover
  bus: Bus
  status: () => HubStatus
  log: Logger
}

const PUBLIC = new Set(['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/hello'])

/** Pictures come from devices; whatever they contain must never run as a page of the hub. */
const SNAPSHOT_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'"

const pathInput = z.object({
  id: z.string().optional(),
  priority: z.number().int().optional().default(0),
  kind: z.enum(PATH_KINDS as [string, ...string[]]),
  label: z.string().optional().default(''),
  wifiNetworkId: z.string().nullable().optional(),
  host: z.string().nullable().optional(),
  port: z.number().int().nullable().optional(),
  extra: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
})

const deviceInput = z.object({
  name: z.string(),
  kind: z.enum(DEVICE_KINDS as [string, ...string[]]),
  family: z.string(),
  room: z.string().optional().default(''),
  config: z.record(z.unknown()).optional().default({}),
  paths: z.array(pathInput).optional().default([]),
  sort: z.number().int().optional(),
  notify: z.enum(NOTIFY_LEVELS as [string, ...string[]]).optional(),
})

const actionInput = z.object({ type: z.string(), params: z.record(z.unknown()).optional() })
const LIMIT = z.coerce.number().int().min(1).max(500).optional()

/** A validation message an owner can act on, instead of the validator's own wording. */
function plainIssue(issue: z.ZodIssue): string {
  const field = issue.path.filter((p) => typeof p === 'string').join(' ')
  const name = (field || 'the request').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  const kind = (t: string) => ({ string: 'text', number: 'a number', boolean: 'on or off', object: 'a set of settings', array: 'a list', integer: 'a whole number' })[t] ?? t
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined' ? `${name} is missing` : `${name} must be ${kind(issue.expected)}`
    case 'too_big':
      return issue.type === 'string' ? `${name} is too long (${issue.maximum} characters at most)` : `${name} is too large (${issue.maximum} at most)`
    case 'too_small':
      return issue.type === 'string' ? (issue.minimum === 1 ? `${name} is required` : `${name} is too short`) : `${name} is too small (${issue.minimum} at least)`
    case 'invalid_enum_value':
      return `${name} is not one of the choices`
    case 'invalid_string':
      return `${name} is not in the right form`
    default:
      return issue.message === 'Expected integer, received float' ? `${name} must be a whole number` : `${name}: ${issue.message}`
  }
}

const wifiInput = z.object({ ssid: z.string(), password: z.string().optional(), notes: z.string().optional() })

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { registry, devices, actions, events, notifier, auth, video, discovery, tuya, wifi, bus, config, log } = deps

  /** Mark scan results that are already in the house, by address or by Tuya device id. */
  const annotate = (list: DiscoveredDevice[]): DiscoveredDevice[] => {
    const all = registry.listDevices()
    return list.map((d) => {
      const tuyaId = typeof d.config.deviceId === 'string' ? d.config.deviceId : null
      const match = all.find((x) => (tuyaId && x.config.deviceId === tuyaId) || x.paths.some((p) => p.host === d.host && p.kind !== 'sms'))
      return { ...d, existingDeviceId: match?.id ?? null }
    })
  }
  /** The last scan, kept so an import knows where each Smart Life device lives on the network. */
  let lastScan: DiscoveredDevice[] = []
  const runScan = async (seconds: number): Promise<DiscoveredDevice[]> => {
    const found = await discovery.scan(seconds, (p) => bus.emit('discover', { ...p, found: annotate(p.found) }))
    lastScan = found
    return annotate(found)
  }

  // ------------------------------------------------------------ plumbing

  // The guard decides on the ROUTE THAT MATCHED, never on the raw text of the
  // URL: the router decodes percent-escapes before matching, so "/%61pi/devices"
  // reaches /api/devices. The raw test stays as a second trigger so unknown
  // /api paths answer 401 instead of falling through to the app shell.
  // The two WebSocket routes check the token themselves, so a bad token closes the socket with a code the app understands.
  const guarded = (s: string) => (s.startsWith('/api') || s.startsWith('/video')) && s !== '/video/api/ws'
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions?.url ?? ''
    const raw = req.url.split('?')[0] ?? ''
    if (!guarded(route) && !guarded(raw)) return
    if (PUBLIC.has(route)) return
    if (!auth.verify(tokenOf(req))) {
      return reply.code(401).send({ error: auth.isConfigured() ? 'Not signed in' : 'Set a PIN first', setup: !auth.isConfigured() })
    }
  })

  app.setErrorHandler((err: Error & { status?: number; statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof z.ZodError) {
      reply.code(400).send({ error: err.issues[0] ? plainIssue(err.issues[0]) : 'Something in the request was not understood' })
      return
    }
    if (err instanceof NotFoundError) {
      reply.code(404).send({ error: err.message })
      return
    }
    if (err instanceof ValidationError || err instanceof ActionError || err instanceof AuthError) {
      reply.code((err as { status?: number }).status ?? 400).send({ error: err.message })
      return
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500
    // A token given in the address must not end up in the log.
    if (status >= 500) log.error(`${req.method} ${req.url.replace(/([?&]token=)[^&]*/g, '$1***')} failed`, err)
    reply.code(status).send({ error: status >= 500 ? 'Something went wrong on the hub' : err.message })
  })

  // ---------------------------------------------------------------- auth

  app.get('/api/auth/status', async (req) => ({ configured: auth.isConfigured(), authenticated: auth.verify(tokenOf(req)) }))
  /**
   * Who is here. Lets the phone app's start screen find the hub on the house network
   * after the router has handed the PC a new address: it asks every address, and only
   * this answer counts as a hub. No sign-in, no secrets: the hub's name, version and addresses.
   */
  app.get('/api/hello', async (_req, reply) => {
    const s = deps.status()
    reply.header('Access-Control-Allow-Origin', '*')
    return { app: 'house-control', name: s.hostname, version: s.version, port: config.port, addresses: s.addresses }
  })
  app.post('/api/auth/setup', async (req) => {
    const body = z.object({ pin: z.string(), label: z.string().optional() }).parse(req.body)
    return { token: auth.setup(body.pin, body.label ?? describeClient(req)) }
  })
  app.post('/api/auth/login', async (req) => {
    const body = z.object({ pin: z.string(), label: z.string().optional() }).parse(req.body)
    return { token: auth.login(body.pin, body.label ?? describeClient(req)) }
  })
  app.post('/api/auth/logout', async (req) => {
    const t = tokenOf(req)
    if (t) auth.revoke(t)
    return { ok: true }
  })
  app.post('/api/auth/pin', async (req) => {
    const body = z.object({ current: z.string(), next: z.string() }).parse(req.body)
    // Every other phone is signed out; this one stays in.
    auth.changePin(body.current, body.next, tokenOf(req))
    return { ok: true }
  })
  app.get('/api/auth/sessions', async () => auth.sessions())

  // ----------------------------------------------------------------- hub

  app.get('/api/hub/status', async () => deps.status())
  app.get('/api/families', async () => familyDescriptors())
  app.get('/api/discover', async (req) => {
    const q = z.object({ seconds: z.coerce.number().int().min(1).max(15).optional() }).parse(req.query)
    return runScan(q.seconds ?? 8)
  })
  /** "I know its address": what is there? */
  app.post('/api/detect', async (req) => {
    const body = z.object({ host: z.string().min(1).max(253) }).parse(req.body)
    // Accept "192.168.1.50", "192.168.1.50:8080" or a pasted "http://192.168.1.50/": keep the address and any port.
    let text = body.host.trim()
    const scheme = text.indexOf('://')
    if (scheme >= 0) text = text.slice(scheme + 3)
    text = text.split('/')[0] ?? ''
    const [host = '', portText] = text.split(':')
    const port = portText ? Number(portText) : undefined
    if (!/^[A-Za-z0-9.-]+$/.test(host) || (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))) {
      throw new ValidationError('That does not look like an address. Use something like 192.168.1.50')
    }
    const found = annotate(await discovery.detect(host, port))
    if (found.length === 0) throw new ActionError(`Nothing the hub recognises answered at ${host}. Check the address, and that the device is switched on and on this network.`, 404)
    return found
  })

  // ---------------------------------------------------- Smart Life account

  app.get('/api/tuya/account', async () => tuya.status())
  app.post('/api/tuya/account', async (req) => {
    const body = z.object({ accessId: z.string(), accessSecret: z.string(), region: z.string().optional(), apiBase: z.string().optional() }).parse(req.body)
    return tuya.link(body)
  })
  app.delete('/api/tuya/account', async () => {
    tuya.unlink()
    return tuya.status()
  })
  app.get('/api/tuya/devices', async (req) => {
    const q = z.object({ deviceId: z.string().optional() }).parse(req.query)
    // The account list needs one device the hub has heard itself; listen briefly if no scan has run yet.
    if (!lastScan.some((d) => d.via === 'tuya')) {
      const { tuyaScan } = await import('./discovery.ts')
      const heard = await tuyaScan(7, log)
      lastScan = [...lastScan.filter((d) => d.via !== 'tuya'), ...heard]
    }
    return tuya.devices(lastScan, q.deviceId)
  })
  app.post('/api/tuya/import', async (req, reply) => {
    const body = z
      .object({ devices: z.array(z.object({ id: z.string(), kind: z.enum(DEVICE_KINDS as [string, ...string[]]).optional(), name: z.string().optional(), room: z.string().optional() })).min(1) })
      .parse(req.body)
    const seen = new Set<string>()
    const wanted = body.devices.filter((d) => !seen.has(d.id) && seen.add(d.id))
    const added = tuya.importDevices(wanted as Parameters<TuyaAccount['importDevices']>[0], lastScan)
    reply.code(201)
    return added
  })

  // ------------------------------------------------------------- devices

  app.get('/api/devices', async () => registry.listDevices())
  app.get('/api/devices/states', async () => devices.listStates())
  app.post('/api/devices', async (req, reply) => {
    const body = deviceInput.parse(req.body)
    const device = registry.createDevice(body as Parameters<Registry['createDevice']>[0])
    reply.code(201)
    return device
  })
  app.post('/api/devices/reorder', async (req) => {
    const body = z.object({ ids: z.array(z.string()) }).parse(req.body)
    registry.reorder(body.ids)
    return { ok: true }
  })
  /** A device exactly as the form would save it, without saving: what Test and the recorder lookup work on. */
  const asTyped = (raw: unknown): { adapter: ReturnType<typeof getAdapter>; temp: Device } => {
    const body = deviceInput.extend({ id: z.string().optional() }).parse(raw)
    // The same checks as Save, so a test cannot pass on something Save would refuse.
    registry.validate(body as Parameters<Registry['validate']>[0])
    const adapter = getAdapter(body.family)
    const config: Record<string, unknown> = { ...body.config }
    if (body.id) {
      const existing = registry.getDeviceUnmasked(body.id)
      if (existing) for (const [k, v] of Object.entries(config)) if (v === SECRET_MASK) config[k] = existing.config[k]
    }
    const temp: Device = {
      id: body.id ?? 'dev_test',
      name: body.name || 'New device',
      kind: body.kind as Device['kind'],
      family: body.family as Device['family'],
      room: body.room,
      notify: 'important',
      config,
      capabilities: adapter.capabilities(config, body.kind as Device['kind']),
      paths: body.paths.map((p, i) => ({
        id: p.id ?? `pth_test_${i}`,
        deviceId: body.id ?? 'dev_test',
        priority: i,
        kind: p.kind as Device['paths'][number]['kind'],
        label: p.label || p.kind,
        wifiNetworkId: p.wifiNetworkId ?? null,
        host: p.host ?? null,
        port: p.port ?? adapter.describe().defaultPort,
        extra: p.extra ?? {},
        enabled: p.enabled !== false,
      })),
      sort: 0,
      createdAt: '',
      updatedAt: '',
    }
    return { adapter, temp }
  }
  /** Try every path of a device as typed in the form, before saving it. */
  app.post('/api/devices/test', async (req) => {
    const { adapter, temp } = asTyped(req.body)
    const results = await Promise.all(
      temp.paths.map(async (p) => {
        const started = Date.now()
        try {
          const r = await withTimeout(adapter.probe(devices.context(temp, p)), deps.config.deviceTimeoutMs + 500, `Checking ${p.label}`)
          return { pathId: p.id, label: p.label, ok: r.ok, latencyMs: r.ok ? r.latencyMs ?? Date.now() - started : null, error: r.error ?? null, info: r.info ?? null, unverifiable: r.unverifiable ?? false }
        } catch (err) {
          return { pathId: p.id, label: p.label, ok: false, latencyMs: null, error: err instanceof Error ? err.message : String(err), info: null, unverifiable: false }
        }
      }),
    )
    return { capabilities: temp.capabilities, results }
  })
  /** The cameras behind a recorder, as typed in the form, so they can all be added at once. */
  app.post('/api/devices/channels', async (req) => {
    const { adapter, temp } = asTyped(req.body)
    const path = temp.paths.find((p) => p.enabled && p.kind !== 'sms') ?? temp.paths[0]
    if (!adapter.listChannels || !path) return { channels: [] }
    try {
      const channels = await withTimeout(adapter.listChannels(devices.context(temp, path)), deps.config.deviceTimeoutMs + 500, 'Reading the recorder')
      return { channels }
    } catch (err) {
      return { channels: [], error: err instanceof Error ? err.message : String(err) }
    }
  })
  app.get('/api/devices/:id', async (req) => {
    const { id } = req.params as { id: string }
    const d = registry.getDevice(id)
    if (!d) throw new ActionError('Device not found', 404)
    return d
  })
  app.put('/api/devices/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = deviceInput.partial().parse(req.body)
    if (wifi.isMoving(id)) throw new ActionError(`${registry.getDevice(id)?.name ?? 'This device'} is moving to another WiFi. Try again in a minute.`, 409)
    return registry.updateDevice(id, body as Parameters<Registry['updateDevice']>[1])
  })
  app.delete('/api/devices/:id', async (req) => {
    const { id } = req.params as { id: string }
    const name = registry.getDevice(id)?.name
    if (!registry.deleteDevice(id)) throw new ActionError('Device not found', 404)
    events.record({ type: 'device.removed', message: `${name ?? 'A device'} was removed` })
    // Once the last illustrative device is gone, the pretend WiFi networks that
    // came with them go too, unless the owner has made one real by giving it a
    // real password.
    const remaining = registry.listDevices()
    if (!remaining.some((d) => d.family === 'virtual')) {
      for (const w of registry.listWifi()) {
        const stillUsed = remaining.some((d) => d.paths.some((p) => p.wifiNetworkId === w.id))
        if (!stillUsed && registry.getWifiSecret(w.id)?.password.startsWith(SEED_WIFI_PASSWORD_PREFIX)) registry.deleteWifi(w.id)
      }
    }
    return { ok: true }
  })
  app.get('/api/devices/:id/state', async (req) => {
    const { id } = req.params as { id: string }
    const s = devices.getState(id)
    if (!s) throw new ActionError('Device not found', 404)
    return s
  })
  app.post('/api/devices/:id/actions', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = actionInput.parse(req.body)
    reply.code(202)
    return actions.request(id, { type: body.type as Parameters<ActionQueue['request']>[1]['type'], params: body.params })
  })
  app.get('/api/devices/:id/actions', async (req) => {
    const { id } = req.params as { id: string }
    const q = z.object({ limit: LIMIT }).parse(req.query)
    return actions.list({ deviceId: id, limit: q.limit })
  })
  app.get('/api/devices/:id/snapshot', async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = registry.getDevice(id)
    if (!device) throw new ActionError('Device not found', 404)
    if (!devices.activePath(id) && !video.hasStream(id)) throw new ActionError(`${device.name} is unreachable`, 503)
    // A camera that is restarting or has just changed network is "unavailable", not a hub fault.
    const got = await grabSnapshot(devices, video, device, deps.config.deviceTimeoutMs * 2).catch((err: unknown) => {
      throw new ActionError(err instanceof Error ? err.message : 'No picture available', 503)
    })
    const snap = got?.snapshot ?? null
    if (!snap) throw new ActionError('No picture available', 503)
    reply.header('Cache-Control', 'no-store').header('Content-Security-Policy', SNAPSHOT_CSP).header('X-Content-Type-Options', 'nosniff').type(snap.contentType)
    return snap.body
  })
  app.get('/api/devices/:id/stream', async (req) => {
    const { id } = req.params as { id: string }
    const device = registry.getDevice(id)
    if (!device) throw new ActionError('Device not found', 404)
    return { available: video.hasStream(id), name: id, go2rtc: video.status.go2rtc, canSnapshot: device.capabilities.includes('snapshot') && (Boolean(devices.adapterFor(device).snapshot) || video.hasStream(id)) }
  })

  // ------------------------------------------------------------- actions

  app.get('/api/actions', async (req) => {
    const q = z.object({ limit: LIMIT, deviceId: z.string().optional() }).parse(req.query)
    return actions.list({ deviceId: q.deviceId, limit: q.limit })
  })
  app.get('/api/actions/:id', async (req) => {
    const { id } = req.params as { id: string }
    const a = actions.get(id)
    if (!a) throw new ActionError('Action not found', 404)
    return a
  })
  app.post('/api/actions/:id/confirm', async (req) => {
    const { id } = req.params as { id: string }
    const body = z.object({ ok: z.boolean() }).parse(req.body)
    return actions.confirm(id, body.ok)
  })
  app.get('/api/snapshots/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const f = actions.snapshotFile(id)
    if (!f) throw new ActionError('Snapshot not found', 404)
    reply.header('Cache-Control', 'private, max-age=86400').header('Content-Security-Policy', SNAPSHOT_CSP).header('X-Content-Type-Options', 'nosniff').type(f.contentType)
    return fs.createReadStream(f.file)
  })

  // -------------------------------------------------------------- events

  app.get('/api/events', async (req) => {
    const q = z.object({ limit: LIMIT, deviceId: z.string().optional(), before: z.string().optional() }).parse(req.query)
    return events.list({ limit: q.limit, deviceId: q.deviceId, before: q.before })
  })

  // ---------------------------------------------------------------- wifi

  app.get('/api/wifi', async () => registry.listWifi())
  app.post('/api/wifi', async (req, reply) => {
    const body = wifiInput.parse(req.body)
    reply.code(201)
    return registry.createWifi(body)
  })
  app.put('/api/wifi/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = wifiInput.partial().parse(req.body)
    return registry.updateWifi(id, body as Parameters<Registry['updateWifi']>[1])
  })
  app.delete('/api/wifi/:id', async (req) => {
    const { id } = req.params as { id: string }
    if (!registry.deleteWifi(id)) throw new ActionError('WiFi network not found', 404)
    return { ok: true }
  })

  // ---------------------------------------------------------------- push

  app.post('/api/push/subscribe', async (req) => {
    const body = z
      .object({
        subscription: z.object({ endpoint: z.string().max(2048), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).passthrough(), expirationTime: z.number().nullable().optional() }),
        label: z.string().max(80).optional(),
      })
      .parse(req.body)
    notifier.subscribe(body.subscription as Parameters<Notifier['subscribe']>[0], body.label ?? describeClient(req))
    return { ok: true, subscriptions: notifier.count() }
  })
  app.post('/api/push/unsubscribe', async (req) => {
    const body = z.object({ endpoint: z.string() }).parse(req.body)
    notifier.unsubscribe(body.endpoint)
    return { ok: true }
  })
  app.post('/api/push/test', async () => notifier.send({ title: 'House Control', body: 'Notifications are working on this phone.', tag: 'test' }))

  // --------------------------------------------------------------- video

  const allowedSrc = (src: string | null): string | null => {
    if (!src) return null
    const d = registry.getDevice(src)
    return d && d.capabilities.includes('stream') ? src : null
  }

  app.get('/video/api/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, 'http://hub')
    const token = wsToken(req)
    if (!token || !auth.verify(token)) {
      socket.close(4401, 'Not signed in')
      return
    }
    const src = allowedSrc(url.searchParams.get('src'))
    if (!src || video.status.go2rtc !== 'running') {
      socket.close(4404, 'No such stream')
      return
    }
    const untrack = trackSocket(token, socket)
    const upstream = new WebSocket(`${video.wsBase}/api/ws?src=${encodeURIComponent(src)}`)
    const pending: Array<string | Buffer> = []
    upstream.on('open', () => {
      for (const m of pending) upstream.send(m)
      pending.length = 0
    })
    upstream.on('message', (data, isBinary) => {
      if (socket.readyState === socket.OPEN) socket.send(data as Buffer, { binary: isBinary })
    })
    upstream.on('close', () => socket.close())
    upstream.on('error', (err) => {
      log.debug('go2rtc ws error', err.message)
      socket.close(4502, 'Video service error')
    })
    socket.on('message', (data, isBinary) => {
      const m = isBinary ? (data as Buffer) : String(data)
      if (upstream.readyState === WebSocket.OPEN) upstream.send(m)
      else pending.push(m)
    })
    socket.on('close', () => {
      untrack()
      upstream.close()
    })
  })

  for (const endpoint of ['frame.jpeg', 'stream.mp4', 'stream.mjpeg', 'stream.m3u8', 'webrtc']) {
    app.route({
      method: endpoint === 'webrtc' ? ['GET', 'POST'] : 'GET',
      url: `/video/api/${endpoint}`,
      handler: (req, reply) => {
        const url = new URL(req.url, 'http://hub')
        const src = allowedSrc(url.searchParams.get('src'))
        if (!src) {
          reply.code(404).send({ error: 'No such stream' })
          return
        }
        if (video.status.go2rtc !== 'running') {
          reply.code(503).send({ error: 'Live video is not running on the hub' })
          return
        }
        url.searchParams.delete('token')
        proxyStream(req, reply, `${video.base}/api/${endpoint}${url.search}`)
      },
    })
  }

  // -------------------------------------------------------------- static

  const dist = config.appDist
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.register(fastifyStatic, {
      root: dist,
      prefix: '/',
      cacheControl: false,
      setHeaders: (res, file) => {
        // Hashed bundles never change; the page, service worker and manifest must always revalidate.
        const hashed = /[\\/]assets[\\/]/.test(file)
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    })
    app.setNotFoundHandler((req, reply) => {
      const url = req.url.split('?')[0] ?? ''
      if (url.startsWith('/api') || url.startsWith('/video')) {
        reply.code(404).send({ error: 'Not found' })
        return
      }
      reply.header('Cache-Control', 'no-cache').sendFile('index.html')
    })
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html').send(
        '<!doctype html><meta charset="utf-8"><title>House Control hub</title><body style="font-family:system-ui;background:#0f1115;color:#e6e8ee;padding:2rem">' +
          '<h1>House Control hub is running</h1><p>The phone app has not been built yet. Run <code>npm run build</code> in the project folder and refresh, ' +
          'or during development open the Vite dev server on port 5173.</p></body>',
      )
    })
  }
}

function tokenOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization
  if (h && /^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, '').trim()
  const q = (req.query as Record<string, unknown> | undefined)?.token
  return typeof q === 'string' && q ? q : null
}

function describeClient(req: FastifyRequest): string {
  const ua = req.headers['user-agent'] ?? ''
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Windows/.test(ua) ? 'Windows PC' : /Mac/.test(ua) ? 'Mac' : 'Device'
  return `${device} · ${req.ip}`
}

/** Pipe a (possibly endless) go2rtc HTTP response straight through. */
function proxyStream(req: FastifyRequest, reply: FastifyReply, target: string): void {
  reply.hijack()
  const u = new URL(target)
  const headers: Record<string, string> = {}
  if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type'])
  const up = http.request(u, { method: req.method, headers }, (res) => {
    const out: Record<string, string> = { 'cache-control': 'no-store' }
    for (const k of ['content-type', 'content-length'] as const) if (res.headers[k]) out[k] = String(res.headers[k])
    reply.raw.writeHead(res.statusCode ?? 502, out)
    res.pipe(reply.raw)
    res.on('error', () => reply.raw.end())
  })
  up.on('error', () => {
    if (!reply.raw.headersSent) reply.raw.writeHead(502, { 'content-type': 'application/json' })
    reply.raw.end(JSON.stringify({ error: 'Video service did not answer' }))
  })
  // When the phone goes away the response closes; the request stream closes as soon as its body was read.
  reply.raw.on('close', () => up.destroy())
  if (req.method === 'POST') {
    const body = req.body
    up.end(typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined)
  } else {
    up.end()
  }
}
