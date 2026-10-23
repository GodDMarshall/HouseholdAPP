import crypto from 'node:crypto'
import dgram from 'node:dgram'
import net from 'node:net'
import os from 'node:os'
import mdns from 'multicast-dns'
import type { DiscoveredDevice, HubStatus } from '@house/shared'
import { allAdapters } from './adapters/index.ts'
import { request } from './lib/http.ts'
import type { Logger } from './lib/log.ts'

export interface ScanProgress {
  /** Short machine name of the step. */
  phase: 'listening' | 'sweeping' | 'identifying' | 'done'
  /** One plain sentence for the screen. */
  message: string
  /** Everything found so far. */
  found: DiscoveredDevice[]
  done: boolean
}

/**
 * Finds devices on the networks the hub is on, the way a phone app does when a
 * new device joins the WiFi:
 *  - Tuya / Smart Life devices announce themselves by broadcast;
 *  - cameras answer ONVIF discovery;
 *  - Shelly and Tasmota boxes answer mDNS;
 *  - everything else is found by knocking on every address and recognising
 *    what answers (Hikvision, Dahua / CP Plus, ONVIF, Tapo, Tasmota, Shelly,
 *    plain video cameras).
 */
export class Discovery {
  status: HubStatus['discovery'] = { onvif: true, mdns: true }
  private running: Promise<DiscoveredDevice[]> | null = null

  constructor(private readonly log: Logger) {}

  /** One scan at a time; a second caller joins the scan already running. */
  scan(seconds = 8, onProgress: (p: ScanProgress) => void = () => undefined): Promise<DiscoveredDevice[]> {
    if (this.running) return this.running
    this.running = this.run(seconds, onProgress).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(seconds: number, onProgress: (p: ScanProgress) => void): Promise<DiscoveredDevice[]> {
    const found = new Map<string, DiscoveredDevice>()
    const add = (list: DiscoveredDevice[]) => {
      let changed = false
      for (const d of list) {
        const prev = found.get(d.host)
        const next = better(prev, d)
        if (next !== prev) {
          found.set(d.host, next)
          changed = true
        }
      }
      return changed
    }
    const report = (phase: ScanProgress['phase'], message: string, done = false) => onProgress({ phase, message, found: [...found.values()], done })
    const quiet = <T>(p: Promise<T[]>, what: string, flag?: 'onvif' | 'mdns'): Promise<T[]> =>
      p.catch((err) => {
        if (flag) this.status[flag] = false
        this.log.warn(`${what} failed`, err instanceof Error ? err.message : err)
        return []
      })

    report('listening', 'Listening for devices announcing themselves…')
    // The listeners run for the whole scan; the sweep runs alongside them.
    const listen = [
      quiet(tuyaScan(seconds, this.log, (d) => add([d]) && report('listening', `Heard a Smart Life device at ${d.host}`)), 'Tuya discovery'),
      quiet(onvifProbe(Math.min(seconds, 5), this.log), 'ONVIF discovery', 'onvif').then((l) => {
        if (add(l)) report('listening', `${l.length} camera${l.length === 1 ? '' : 's'} answered`)
        return l
      }),
      quiet(mdnsScan(Math.min(seconds, 5), this.log), 'mDNS discovery', 'mdns').then((l) => {
        if (add(l)) report('listening', `${l.length} switch${l.length === 1 ? '' : 'es'} answered`)
        return l
      }),
      ...allAdapters()
        .filter((a) => a.discover && a.family !== 'onvif')
        .map((a) => quiet(a.discover!(Math.min(seconds, 5), this.log), `${a.family} discovery`).then((l) => (add(l), l))),
    ]

    const subnets = localSubnets()
    report('sweeping', `Checking every address on ${subnets.map((s) => s.base + '.x').join(' and ') || 'the network'}…`)
    const answering = await sweep(subnets).catch(() => [] as Array<{ host: string; ports: number[] }>)
    report('identifying', `${answering.length} address${answering.length === 1 ? '' : 'es'} answered. Working out what they are…`)
    await Promise.all(
      answering.map(async ({ host, ports }) => {
        const candidates = await identify(host, ports, this.log).catch(() => [] as DiscoveredDevice[])
        if (candidates[0] && add([candidates[0]])) report('identifying', `${candidates[0].name} at ${host}`)
      }),
    )
    await Promise.all(listen)
    const all = [...found.values()].sort((a, b) => ipNum(a.host) - ipNum(b.host))
    onProgress({ phase: 'done', message: all.length ? `Found ${all.length} device${all.length === 1 ? '' : 's'}` : 'Nothing new answered', found: all, done: true })
    return all
  }

  /** What is at this address? Used when the owner types an address themselves. */
  async detect(host: string, port?: number): Promise<DiscoveredDevice[]> {
    const h = host.trim()
    if (!h) return []
    const ports = await openPorts(h, port ? [...new Set([...SWEEP_PORTS, port])] : SWEEP_PORTS, 1200)
    // A port the owner typed is where the device's web page is.
    const list = await identify(h, ports, this.log, port && ports.includes(port) ? port : undefined)
    return list.map((d) => ({ ...d, via: 'address' as const }))
  }
}

/**
 * The entry to keep for one address when two methods found it. A maker's own
 * family (Dahua, Hikvision ...) beats the generic ONVIF answer, which beats bare
 * video; a device announcing itself beats the sweep's guess. The loser still
 * lends its model name, so the owner reads "CP-UVR-0801E1-CV4" rather than
 * only "Dahua or CP Plus".
 */
export function better(prev: DiscoveredDevice | undefined, d: DiscoveredDevice): DiscoveredDevice {
  if (!prev) return d
  const [win, lose] = rank(d) > rank(prev) ? [d, prev] : [prev, d]
  if (win.family === lose.family) {
    const config = { ...lose.config, ...win.config }
    return win === prev && shallowEqual(config, prev.config) ? prev : { ...win, config }
  }
  const model = modelOf(lose)
  if (!model || modelOf(win)) return win
  return { ...win, detail: win.detail ? `${model} · ${win.detail}` : model }
}

function rank(d: DiscoveredDevice): number {
  if (d.family === 'rtsp') return 1
  if (d.family === 'onvif') return 2
  if (d.via === 'scan') return 3
  return 4
}

/** The model name an ONVIF answer carries in its detail ("CP-UVR-0801E1-CV4 · /onvif/device_service"). */
function modelOf(d: DiscoveredDevice): string | null {
  if (d.family !== 'onvif') return null
  const first = (d.detail ?? '').split(' · ')[0]?.trim() ?? ''
  return first && !first.startsWith('/') ? first : null
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

function ipNum(host: string): number {
  const p = host.split('.').map(Number)
  return p.length === 4 && p.every((n) => Number.isFinite(n)) ? ((p[0]! * 256 + p[1]!) * 256 + p[2]!) * 256 + p[3]! : Number.MAX_SAFE_INTEGER
}

// ---------------------------------------------------------------------------
// Tuya / Smart Life: devices broadcast who they are every few seconds
// ---------------------------------------------------------------------------

/** The fixed, published key every Tuya device encrypts its announcement with, so apps can find it. */
const TUYA_UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest()

export interface TuyaAnnouncement {
  ip: string
  gwId: string
  version: string
  productKey?: string
}

/** Decode one announcement packet. Returns null when it is not one. */
export function decodeTuyaBroadcast(msg: Buffer): TuyaAnnouncement | null {
  if (msg.length < 28) return null
  const prefix = msg.readUInt32BE(0)
  try {
    let json: string
    if (prefix === 0x000055aa) {
      // 3.1 is plain JSON; 3.3 and 3.4 are AES-128-ECB
      const body = msg.subarray(20, msg.length - 8)
      const text = body.toString('utf8')
      if (text.trimStart().startsWith('{')) json = text
      else {
        const d = crypto.createDecipheriv('aes-128-ecb', TUYA_UDP_KEY, null)
        json = Buffer.concat([d.update(body), d.final()]).toString('utf8')
      }
    } else if (prefix === 0x00006699) {
      // 3.5: AES-128-GCM with a 12-byte IV, a 16-byte tag and the header as extra data
      const len = msg.readUInt32BE(14)
      if (msg.length < 18 + len || len < 28) return null
      const d = crypto.createDecipheriv('aes-128-gcm', TUYA_UDP_KEY, msg.subarray(18, 30))
      d.setAAD(msg.subarray(4, 18))
      d.setAuthTag(msg.subarray(18 + len - 16, 18 + len))
      const out = Buffer.concat([d.update(msg.subarray(30, 18 + len - 16)), d.final()]).toString('utf8')
      json = out.slice(out.indexOf('{'))
    } else {
      return null
    }
    const o = JSON.parse(json) as Record<string, unknown>
    if (typeof o.gwId !== 'string' || typeof o.ip !== 'string') return null
    return { ip: o.ip, gwId: o.gwId, version: typeof o.version === 'string' ? o.version : '3.3', productKey: typeof o.productKey === 'string' ? o.productKey : undefined }
  } catch {
    return null
  }
}

/** Listen for Smart Life devices on the house network. */
export function tuyaScan(seconds: number, log: Logger, onFound: (d: DiscoveredDevice) => void = () => undefined, ports: number[] = [6666, 6667, 7000]): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredDevice>()
    const sockets: dgram.Socket[] = []
    for (const port of ports) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      s.on('error', (err) => log.debug(`tuya listener on ${port}: ${err.message}`))
      s.on('message', (msg, rinfo) => {
        const a = decodeTuyaBroadcast(msg)
        if (!a || found.has(a.gwId)) return
        const host = a.ip || rinfo.address
        const d: DiscoveredDevice = {
          family: 'tuya-local',
          kind: 'switch',
          name: 'Smart Life device',
          host,
          port: 6668,
          detail: `Tuya protocol ${a.version}`,
          config: { deviceId: a.gwId, version: ['3.1', '3.3', '3.4', '3.5'].includes(a.version) ? a.version : '3.3' },
          via: 'tuya',
          needs: ['localKey'],
          hint: 'Smart Life devices need their key from your Smart Life account. Link the account once and the hub fetches it.',
        }
        found.set(a.gwId, d)
        onFound(d)
      })
      try {
        s.bind(port)
        sockets.push(s)
      } catch (err) {
        log.debug(`cannot listen on udp ${port}: ${err instanceof Error ? err.message : err}`)
      }
    }
    setTimeout(() => {
      for (const s of sockets) {
        try {
          s.close()
        } catch {
          /* already closed */
        }
      }
      resolve([...found.values()])
    }, seconds * 1000).unref?.()
  })
}

// ---------------------------------------------------------------------------
// Sweep: knock on every address of the hub's networks
// ---------------------------------------------------------------------------

/** Ports that tell device families apart. */
const SWEEP_PORTS = [80, 554, 2020, 8000, 8080, 8899, 34567, 37777, 6668]

export interface Subnet {
  /** First three numbers, e.g. 192.168.1 */
  base: string
  own: string
}

export function localSubnets(): Subnet[] {
  const out: Subnet[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      // Only ordinary home-sized networks; never sweep a carrier or VPN range.
      if (!/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) continue
      if (i.netmask !== '255.255.255.0') continue
      const base = i.address.split('.').slice(0, 3).join('.')
      if (!out.some((s) => s.base === base)) out.push({ base, own: i.address })
    }
  }
  return out
}

function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (ok: boolean) => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(timeoutMs)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
  })
}

async function openPorts(host: string, ports: number[], timeoutMs: number): Promise<number[]> {
  const open: number[] = []
  await Promise.all(ports.map(async (p) => (await tcpOpen(host, p, timeoutMs)) && open.push(p)))
  return open.sort((a, b) => a - b)
}

export async function sweep(subnets: Subnet[], timeoutMs = 450): Promise<Array<{ host: string; ports: number[] }>> {
  const own = new Set(localAddresses())
  const out: Array<{ host: string; ports: number[] }> = []
  await Promise.all(
    subnets.flatMap((s) =>
      Array.from({ length: 254 }, (_, i) => `${s.base}.${i + 1}`)
        .filter((h) => !own.has(h))
        .map(async (host) => {
          const ports = await openPorts(host, SWEEP_PORTS, timeoutMs)
          if (ports.length) out.push({ host, ports })
        }),
    ),
  )
  return out
}

function localAddresses(): string[] {
  const out: string[] = []
  // Real adapters only: a virtual switch (WSL, Hyper-V, VirtualBox, VMware, Docker) is not an address a phone can reach.
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback/i.test(name)) continue
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address)
  }
  return out
}

// ---------------------------------------------------------------------------
// Identify: recognise what answers at an address, without any login
// ---------------------------------------------------------------------------

const ONVIF_CLOCK =
  '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>'

async function tryGet(url: string, timeoutMs = 2000) {
  try {
    return await request(url, { timeoutMs, headers: { Connection: 'close' }, insecure: true })
  } catch {
    return null
  }
}

/**
 * What kind of device is this? Looks only at what the device shows before any
 * login: its challenge, its public info pages, its open ports. Best guess first.
 */
export async function identify(host: string, ports: number[], log: Logger, httpPortOverride?: number): Promise<DiscoveredDevice[]> {
  const out: DiscoveredDevice[] = []
  const has = (p: number) => ports.includes(p)
  const webPorts = httpPortOverride ? [httpPortOverride] : [80, 8080].filter(has)
  const base = (p: number) => `http://${host}${p === 80 ? '' : ':' + p}`
  const push = (d: Omit<DiscoveredDevice, 'host' | 'via'>) => out.push({ host, via: 'scan', ...d })

  for (const p of webPorts) {
    // Shelly says who it is on /shelly, with no login
    const shelly = await tryGet(`${base(p)}/shelly`)
    if (shelly?.status === 200 && !/<html|<!doctype/i.test(shelly.text())) {
      try {
        const j = shelly.json<Record<string, unknown>>()
        if (j.type || j.gen || j.app || j.mac) {
          const gen = Number(j.gen ?? 1)
          push({
            family: 'shelly',
            kind: 'switch',
            name: String(j.name || j.app || j.type || 'Shelly'),
            port: p,
            detail: `Shelly ${String(j.model ?? j.type ?? '')}`.trim(),
            config: { generation: gen >= 2 ? 'gen2' : 'gen1' },
            needs: j.auth === true || j.auth_en === true ? ['password'] : [],
          })
          continue
        }
      } catch {
        /* not a Shelly */
      }
    }
    // Tasmota answers its status command (or says it wants the web password)
    const tas = await tryGet(`${base(p)}/cm?cmnd=Status%200`)
    if (tas && !/<html|<!doctype/i.test(tas.text()) && /"Status"\s*:|"WARNING"\s*:/.test(tas.text())) {
      let name = 'Tasmota switch'
      try {
        const j = tas.json<{ Status?: { DeviceName?: string; FriendlyName?: string[] } }>()
        name = j.Status?.DeviceName || j.Status?.FriendlyName?.[0] || name
      } catch {
        /* locked: keep the generic name */
      }
      push({ family: 'tasmota', kind: 'switch', name, port: p, detail: 'Tasmota', config: {}, needs: /WARNING/.test(tas.text()) ? ['password'] : [] })
      continue
    }
    // Cameras: each maker's own address answers with a login challenge
    const hik = await tryGet(`${base(p)}/ISAPI/System/deviceInfo`)
    const dah = await tryGet(`${base(p)}/cgi-bin/magicBox.cgi?action=getDeviceType`)
    const hikAuth = hik?.headers['www-authenticate'] ?? ''
    const dahAuth = dah?.headers['www-authenticate'] ?? ''
    // A 200 only counts when the body is the maker's own answer, never a web page that happens to contain the word.
    const isPage = (text: string) => /<html|<!doctype/i.test(text)
    const hikYes = hik ? (hik.status === 200 && /<DeviceInfo[ >]/.test(hik.text()) && !isPage(hik.text())) || (hik.status === 401 && /digest/i.test(hikAuth)) : false
    const dahYes = dah ? (dah.status === 200 && /^type=/m.test(dah.text().trim()) && !isPage(dah.text())) || (dah.status === 401 && /digest/i.test(dahAuth)) : false
    const looksDahua = /Login to /i.test(dahAuth) || has(37777)
    if (dahYes && (looksDahua || !hikYes)) {
      push({ family: 'dahua', kind: 'camera', name: 'Dahua / CP Plus camera', port: p, detail: 'Dahua or CP Plus', config: { username: 'admin' }, needs: ['password'] })
      continue
    }
    if (hikYes) {
      push({ family: 'hikvision', kind: 'camera', name: 'Hikvision camera', port: p, detail: 'Hikvision', config: { username: 'admin' }, needs: ['password'] })
      continue
    }
  }

  if (!out.some((d) => d.kind === 'camera')) {
    // ONVIF: the clock call needs no login on any conformant camera
    for (const p of [...new Set([...(httpPortOverride ? [httpPortOverride] : []), 80, 2020, 8000, 8080, 8899])].filter(has)) {
      try {
        const res = await request(`http://${host}:${p}/onvif/device_service`, {
          method: 'POST',
          timeoutMs: 2000,
          headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': String(Buffer.byteLength(ONVIF_CLOCK)), Connection: 'close' },
          body: ONVIF_CLOCK,
        })
        if (/GetSystemDateAndTimeResponse/i.test(res.text())) {
          if (p === 2020 && has(554)) {
            push({ family: 'tapo', kind: 'camera', name: 'TP-Link Tapo camera', port: null, detail: 'Tapo (ONVIF on 2020)', config: { onvifPort: 2020 }, needs: ['username', 'password'], hint: 'Use the camera account made in the Tapo app under Advanced Settings.' })
          } else {
            push({ family: 'onvif', kind: 'camera', name: 'Camera', port: p, detail: `ONVIF on port ${p}`, config: {}, needs: ['username', 'password'] })
          }
          break
        }
      } catch (err) {
        log.debug(`onvif check ${host}:${p}: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  if (!out.length && has(34567)) {
    push({
      family: 'rtsp',
      kind: 'camera',
      name: 'ICSee / XMEye camera',
      port: 34567,
      detail: 'Xiongmai camera (ICSee, XMEye)',
      config: { streamUrl: 'dvrip://{user}:{pass}@{host}:{port}?channel=0', username: 'admin' },
      needs: ['password'],
    })
  }
  if (!out.length && has(554)) {
    push({ family: 'rtsp', kind: 'camera', name: 'Camera with video address', port: 554, detail: 'Video (RTSP) on port 554', config: {}, needs: ['streamUrl', 'username', 'password'] })
  }
  if (!out.length && has(6668)) {
    push({
      family: 'tuya-local',
      kind: 'switch',
      name: 'Smart Life device',
      port: 6668,
      detail: 'Tuya',
      config: {},
      needs: ['deviceId', 'localKey'],
      hint: 'Smart Life devices need their key from your Smart Life account. Link the account once and the hub fetches it.',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// ONVIF WS-Discovery (UDP multicast 239.255.255.250:3702)
// ---------------------------------------------------------------------------

function probeMessage(): string {
  const id = crypto.randomUUID()
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
    'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    `<e:Header><w:MessageID>uuid:${id}</w:MessageID>` +
    '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>' +
    '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>'
  )
}

function localIPv4(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address)
  }
  return out.length ? out : ['0.0.0.0']
}

export function onvifProbe(seconds: number, log: Logger): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredDevice>()
    const sockets: dgram.Socket[] = []
    const message = Buffer.from(probeMessage())
    let closed = 0
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      for (const s of sockets) {
        try {
          s.close()
        } catch {
          /* already closed */
        }
      }
      resolve([...found.values()])
    }
    const addresses = localIPv4()
    for (const address of addresses) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      sockets.push(socket)
      socket.on('error', (err) => {
        log.debug(`discovery socket ${address}: ${err.message}`)
        closed += 1
        if (closed === addresses.length) finish()
      })
      socket.on('message', (msg, rinfo) => {
        const d = parseProbeMatch(msg.toString('utf8'), rinfo.address)
        if (d && !found.has(d.host)) found.set(d.host, d)
      })
      socket.bind({ address, port: 0 }, () => {
        try {
          socket.setMulticastTTL(2)
          socket.setBroadcast(true)
          socket.send(message, 3702, '239.255.255.250')
        } catch (err) {
          log.debug(`discovery send ${address}: ${err instanceof Error ? err.message : err}`)
        }
      })
    }
    setTimeout(finish, seconds * 1000).unref?.()
  })
}

function parseProbeMatch(xml: string, from: string): DiscoveredDevice | null {
  const xaddrs = /<[^>]*XAddrs[^>]*>([^<]+)<\/[^>]*XAddrs>/i.exec(xml)?.[1]?.trim()
  if (!xaddrs) return null
  const urls = xaddrs.split(/\s+/).filter(Boolean)
  let url: URL | null = null
  for (const u of urls) {
    try {
      const parsed = new URL(u)
      if (parsed.hostname === from || !url) url = parsed
    } catch {
      /* skip */
    }
  }
  if (!url) return null
  const scopes = /<[^>]*Scopes[^>]*>([^<]+)<\/[^>]*Scopes>/i.exec(xml)?.[1] ?? ''
  const scope = (key: string) => {
    const m = new RegExp(`onvif://www\\.onvif\\.org/${key}/([^\\s]+)`, 'i').exec(scopes)?.[1]
    return m ? safeDecode(m) : ''
  }
  const name = scope('name')
  const hardware = scope('hardware')
  return {
    family: 'onvif',
    kind: 'camera',
    name: name || hardware || `Camera at ${url.hostname}`,
    host: url.hostname,
    port: url.port ? Number(url.port) : 80,
    detail: [hardware, url.pathname].filter(Boolean).join(' · '),
    config: { username: '', password: '', onvifPath: url.pathname },
    via: 'onvif',
    needs: ['username', 'password'],
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// ---------------------------------------------------------------------------
// mDNS: Shelly (_shelly._tcp) and Tasmota / anything named like it (_http._tcp)
// ---------------------------------------------------------------------------

export function mdnsScan(seconds: number, log: Logger): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const m = mdns()
    const services = new Map<string, { target?: string; port?: number; txt: Record<string, string> }>()
    const addresses = new Map<string, string>()
    m.on('response', (res) => {
      const records = [...res.answers, ...(res.additionals ?? [])]
      for (const r of records) {
        if (r.type === 'PTR' && /_shelly\._tcp|_http\._tcp/i.test(r.name)) {
          const inst = String(r.data)
          if (!services.has(inst)) services.set(inst, { txt: {} })
        } else if (r.type === 'SRV') {
          const s = services.get(r.name) ?? { txt: {} }
          const data = r.data as { target: string; port: number }
          s.target = data.target
          s.port = data.port
          services.set(r.name, s)
        } else if (r.type === 'A') {
          addresses.set(r.name, String(r.data))
        } else if (r.type === 'TXT') {
          const s = services.get(r.name) ?? { txt: {} }
          const list = r.data as Buffer[] | Buffer
          for (const b of Array.isArray(list) ? list : [list]) {
            const [k, ...v] = b.toString().split('=')
            if (k) s.txt[k] = v.join('=')
          }
          services.set(r.name, s)
        }
      }
    })
    m.on('error', (err) => log.debug('mdns', err.message))
    const query = () =>
      m.query({
        questions: [
          { name: '_shelly._tcp.local', type: 'PTR' },
          { name: '_http._tcp.local', type: 'PTR' },
        ],
      })
    query()
    const again = setTimeout(query, 1000)
    again.unref?.()
    setTimeout(() => {
      clearTimeout(again)
      const out: DiscoveredDevice[] = []
      for (const [inst, s] of services) {
        const label = inst.replace(/\._(shelly|http)\._tcp\.local$/i, '')
        const isShelly = /shelly/i.test(inst) || /shelly/i.test(s.target ?? '') || s.txt.gen !== undefined || s.txt.app !== undefined
        const isTasmota = /tasmota/i.test(inst) || /tasmota/i.test(s.target ?? '')
        if (!isShelly && !isTasmota) continue
        const host = (s.target && addresses.get(s.target)) ?? addresses.get(inst) ?? (s.target ? s.target.replace(/\.$/, '') : null)
        if (!host) continue
        out.push({
          family: isShelly ? 'shelly' : 'tasmota',
          kind: 'switch',
          name: label,
          host,
          port: s.port ?? 80,
          detail: isShelly ? 'Shelly' : 'Tasmota',
          config: isShelly ? { generation: s.txt.gen ? (Number(s.txt.gen) >= 2 ? 'gen2' : 'gen1') : 'auto' } : {},
          via: 'mdns',
          needs: [],
        })
      }
      m.destroy()
      resolve(out)
    }, seconds * 1000).unref?.()
  })
}
