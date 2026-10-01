import crypto from 'node:crypto'
import dgram from 'node:dgram'
import os from 'node:os'
import mdns from 'multicast-dns'
import type { DiscoveredDevice, HubStatus } from '@house/shared'
import { allAdapters } from './adapters/index.ts'
import type { Logger } from './lib/log.ts'

/** Finds cameras (ONVIF WS-Discovery) and Shelly / Tasmota boxes (mDNS) on the networks the hub is on. */
export class Discovery {
  status: HubStatus['discovery'] = { onvif: true, mdns: true }

  constructor(private readonly log: Logger) {}

  async scan(seconds = 4): Promise<DiscoveredDevice[]> {
    const jobs: Promise<DiscoveredDevice[]>[] = [
      onvifProbe(seconds, this.log).catch((err) => {
        this.status.onvif = false
        this.log.warn('ONVIF discovery failed', err instanceof Error ? err.message : err)
        return []
      }),
      mdnsScan(seconds, this.log).catch((err) => {
        this.status.mdns = false
        this.log.warn('mDNS discovery failed', err instanceof Error ? err.message : err)
        return []
      }),
      ...allAdapters()
        .filter((a) => a.discover && a.family !== 'onvif')
        .map((a) => a.discover!(seconds, this.log).catch(() => [] as DiscoveredDevice[])),
    ]
    const all = (await Promise.all(jobs)).flat()
    const seen = new Set<string>()
    return all.filter((d) => {
      const key = `${d.family}@${d.host}:${d.port ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
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
    const finish = () => {
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
          detail: Object.entries(s.txt)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')
            .slice(0, 120),
          config: isShelly ? { generation: s.txt.gen ? Number(s.txt.gen) >= 2 ? 'gen2' : 'gen1' : 'auto' } : {},
        })
      }
      m.destroy()
      resolve(out)
    }, seconds * 1000).unref?.()
  })
}
