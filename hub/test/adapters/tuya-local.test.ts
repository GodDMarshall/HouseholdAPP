/**
 * tuya-local adapter, tested two ways.
 *
 * 1. Against a fake "tuyapi" (most tests): it records every call and behaves
 *    the way node_modules/tuyapi/index.js does, as far as the adapter can tell:
 *    - the constructor rejects a key that is not 16 characters;
 *    - connect() creates the socket at once and settles later; socket trouble
 *      is emitted as an 'error' event AND rejects connect();
 *    - a 3.4 / 3.5 sign-in that fails never settles connect(): the device stays
 *      silent, or hangs up (socket 'close', no 'disconnected' event), or answers
 *      with something that fails the key check ('error' event "HMAC mismatch:
 *      ..." on 3.4; an exception inside the packet dispatcher on 3.5);
 *    - a device only sends a status when a value really changes, and the
 *      status lists only the changed values plus a timestamp; otherwise set()
 *      fails with "Timeout waiting for status response from device id: ...";
 *    - get() has no timeout of its own;
 *    - a device accepts a single connection.
 * 2. Against the real tuyapi library talking to a small Tuya device on
 *    127.0.0.1 (the "on the wire" tests at the end), for protocol 3.3, 3.4 and
 *    3.5. That device does its own framing and encryption, so these tests also
 *    show what the library really puts on the wire.
 *
 * Data points are the ones in docs/protocols/lights-tasmota-shelly-tuya.md:
 * switches answer {"dps":{"1":true,"9":0}} (channels 1..6), bulbs use
 * 20 switch_led, 21 work_mode, 22 bright_value_v2 (10-1000), 23 temp_value_v2,
 * and the documented calls are get({schema:true}), set({dps:1,set:true}) and
 * set({multiple:true,data:{'20':true,'22':500}}).
 */
import crypto from 'node:crypto'
import net from 'node:net'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceKind } from '@house/shared'

interface SimDevice {
  ip: string
  port: number
  id: string
  key: string
  version: string
  dps: Record<string, unknown>
  /** up = answers; refused / unreachable = socket errors; dropped = packets vanish (tuyapi: "connection timed out"). */
  net: 'up' | 'refused' | 'unreachable' | 'dropped'
  /** handshake = 3.4/3.5 session-key exchange never completes; requests = connects, then never answers. */
  mute: null | 'handshake' | 'requests'
  /** What the device does with a client whose key or version does not fit. */
  badKey: 'silent' | 'hangsUp' | 'answers'
  /** Closes the connection as soon as it is asked something. */
  hangsUpWhenAsked: boolean
  /** Answers questions, but closes the connection when given a command. */
  hangsUpOnCommand: boolean
  /** Changes the value but sends no status packet. */
  quiet: boolean
  /** Ignores every command. */
  ignoreSets: boolean
  /** A relay that will not switch off again. */
  stuckOn: boolean
  /** A relay with its own timer ("inching"): switches itself off after this long. */
  selfReleaseMs: number
  /** Status packets carry every value instead of only the changed ones (some older devices). */
  fullStatus: boolean
  /** Lowest level the device accepts per data point: anything below is raised to it. */
  floor: Record<string, number>
  /** A status the device happens to push first (a socket reporting its power reading): set() resolves with it. */
  chatter: Record<string, unknown> | null
  /** A plain-text answer instead of data points (tuyapi hands such strings through). */
  textReply: string | null
  /** A "device22" model: cannot list its values, tuyapi falls back to asking for the one named in get({dps}). */
  oneValueOnly: boolean
  /** Needs this long after a connection closes before it takes the next one. */
  slowToFreeMs: number
  busyUntil: number
  live: number
  maxLive: number
}

interface LogEntry {
  n: number
  op: 'new' | 'connect' | 'get' | 'set' | 'disconnect'
  args?: unknown
  at: number
}

const world = vi.hoisted(() => ({
  devices: new Map<string, SimDevice>(),
  log: [] as LogEntry[],
  made: 0,
  /** true = hand out the real tuyapi class (the "on the wire" tests). */
  real: false,
}))

vi.mock('tuyapi', async (importOriginal) => {
  const { EventEmitter } = await import('node:events')
  const original = (await importOriginal()) as { default: new (opts: Record<string, unknown>) => object }

  type FakeSocket = InstanceType<typeof EventEmitter> & { connecting: boolean; destroyed: boolean; destroy: () => void }

  class FakeTuya extends EventEmitter {
    n: number
    opts: Record<string, unknown>
    connected = false
    client: FakeSocket | undefined
    private pending: Promise<boolean> | null = null
    /** The device this client's socket reached. */
    private at: SimDevice | null = null

    constructor(opts: Record<string, unknown>) {
      super()
      if (typeof opts.key !== 'string' || opts.key.length !== 16) throw new TypeError('Key is missing or incorrect.')
      this.n = ++world.made
      this.opts = { ...opts }
      world.log.push({ n: this.n, op: 'new', args: { ...opts }, at: Date.now() })
    }

    private readable(sim: SimDevice): boolean {
      return this.opts.key === sim.key && String(this.opts.version) === sim.version
    }

    /** What tuyapi does when no status packet arrives for a set(). */
    private statusTimeout(): Promise<never> {
      const text = 'Timeout waiting for status response from device id: ' + String(this.opts.id)
      return new Promise((_, reject) => {
        setTimeout(() => {
          this.emit('error', text)
          reject(new Error(text))
        }, 5)
      })
    }

    /** tuyapi's packet dispatcher: it reads the sign-in reply as a Buffer, and throws when decryption left a string. */
    _packetHandler(packet: { payload: unknown }): void {
      ;(packet.payload as Buffer).subarray(0, 16)
    }

    /** What tuyapi does when its socket reports 'close'. */
    private socketClosed(): void {
      if (!this.connected) return
      this.connected = false
      this.emit('disconnected')
    }

    connect(): Promise<boolean> {
      world.log.push({ n: this.n, op: 'connect', at: Date.now() })
      if (this.connected) return Promise.resolve(true)
      if (this.pending) return this.pending
      const client: FakeSocket = Object.assign(new EventEmitter(), {
        connecting: true,
        destroyed: false,
        destroy: () => {
          if (client.destroyed) return
          client.destroyed = true
          client.connecting = false
          if (this.at) {
            this.at.live -= 1
            this.at.busyUntil = Date.now() + this.at.slowToFreeMs
            this.at = null
          }
          // net.Socket reports 'close' a moment later.
          queueMicrotask(() => {
            client.emit('close')
            this.socketClosed()
          })
        },
      })
      this.client = client
      const pending = new Promise<boolean>((resolve, reject) => {
        const socketError = (code: string) => {
          const err = Object.assign(new Error(`connect ${code} ${String(this.opts.ip)}:${String(this.opts.port)}`), { code })
          this.pending = null
          this.emit('error', new Error('Error from socket: ' + err.message))
          reject(err)
          client.destroy()
        }
        queueMicrotask(() => {
          if (client.destroyed) return
          const sim = world.devices.get(String(this.opts.ip))
          if (!sim || sim.net === 'unreachable') return socketError('EHOSTUNREACH')
          if (sim.net === 'refused' || this.opts.port !== sim.port || Date.now() < sim.busyUntil) return socketError('ECONNREFUSED')
          if (sim.net === 'dropped') {
            setTimeout(() => {
              if (client.destroyed) return
              client.destroy()
              this.pending = null
              this.emit('error', new Error('connection timed out'))
              reject(new Error('connection timed out'))
            }, 5)
            return
          }
          if (sim.live >= 1) return socketError('ECONNRESET') // the device's one connection is taken
          sim.live += 1
          sim.maxLive = Math.max(sim.maxLive, sim.live)
          this.at = sim
          client.connecting = false
          client.emit('connect')
          if (this.opts.version === '3.4' || this.opts.version === '3.5') {
            // Session-key exchange. When it fails, tuyapi leaves connect() pending for ever.
            if (sim.mute === 'handshake') return
            if (!this.readable(sim)) {
              if (sim.badKey === 'hangsUp') client.destroy()
              else if (sim.badKey === 'answers') {
                if (this.opts.version === '3.4') {
                  this.emit('error', new Error(`HMAC mismatch: expected ${'ab'.repeat(32)}, was ${'cd'.repeat(32)}. ${'ef'.repeat(48)}`))
                } else {
                  // index.js: this._packetHandler.bind(this)(packet), outside any try / catch.
                  this._packetHandler.bind(this)({ payload: '\u0013��q\u0002' })
                }
              }
              return
            }
          }
          this.connected = true
          this.pending = null
          this.emit('connected')
          resolve(true)
        })
      })
      this.pending = pending
      return pending
    }

    async get(options: Record<string, unknown>): Promise<unknown> {
      world.log.push({ n: this.n, op: 'get', args: { ...options }, at: Date.now() })
      await this.connect()
      const sim = this.at
      if (!sim) return new Promise(() => undefined)
      if (sim.hangsUpWhenAsked) {
        this.client?.destroy()
        return new Promise(() => undefined)
      }
      if (sim.mute === 'requests') return new Promise(() => undefined)
      if (!this.readable(sim)) {
        // 3.1 / 3.3 with a wrong key: the reply, if any, cannot be decrypted and tuyapi hands it back as text.
        if (sim.badKey === 'answers') return '\u0013��q\u0002'
        if (sim.badKey === 'hangsUp') this.client?.destroy()
        return new Promise(() => undefined)
      }
      // After "data format error" tuyapi asks again by set(), which such a device does not answer either.
      if (sim.textReply === 'data format error') return this.statusTimeout()
      if (sim.textReply !== null) return sim.textReply
      const t = Math.round(Date.now() / 1000)
      if (sim.oneValueOnly) {
        // "json obj data unvalid": tuyapi falls back to set({dps: options.dps || 1, set: null}) and returns that reply.
        const dp = String(options.dps ?? 1)
        return { dps: { [dp]: sim.dps[dp] }, t }
      }
      // lib/cipher.js unwraps 3.4 / 3.5 replies to the same {dps} object, with the timestamp copied in.
      const newProtocol = sim.version === '3.4' || sim.version === '3.5'
      return newProtocol ? { dps: { ...sim.dps }, t } : { dps: { ...sim.dps } }
    }

    async set(options: Record<string, unknown>): Promise<unknown> {
      world.log.push({ n: this.n, op: 'set', args: structuredClone(options), at: Date.now() })
      await this.connect()
      const sim = this.at
      if (!sim) return this.statusTimeout()
      if (sim.hangsUpWhenAsked || sim.hangsUpOnCommand) {
        this.client?.destroy()
        return this.statusTimeout()
      }
      if (sim.mute === 'requests' || !this.readable(sim)) return this.statusTimeout()
      const data = (options.multiple === true ? options.data : { [String(options.dps ?? 1)]: options.set }) as Record<string, unknown>
      const changed: Record<string, unknown> = {}
      for (const [k, asked] of Object.entries(data)) {
        if (asked === null || sim.ignoreSets) continue
        if (sim.stuckOn && asked === false) continue
        const floor = sim.floor[k]
        const v = typeof asked === 'number' && floor !== undefined ? Math.max(asked, floor) : asked
        if (sim.dps[k] === v) continue
        sim.dps[k] = v
        changed[k] = v
        if (v === true && sim.selfReleaseMs > 0) setTimeout(() => (sim.dps[k] = false), sim.selfReleaseMs)
      }
      // tuyapi resolves set() with the first status packet of any kind.
      if (sim.chatter) return { dps: { ...sim.chatter }, t: Math.round(Date.now() / 1000) }
      if (Object.keys(changed).length === 0 || sim.quiet) return this.statusTimeout()
      return { dps: sim.fullStatus ? { ...sim.dps } : changed, t: Math.round(Date.now() / 1000) }
    }

    disconnect(): void {
      world.log.push({ n: this.n, op: 'disconnect', at: Date.now() })
      if (!this.connected) return
      this.connected = false
      this.client?.destroy()
      this.emit('disconnected')
    }

    isConnected(): boolean {
      return this.connected
    }
  }

  function Tuya(opts: Record<string, unknown>): object {
    return world.real ? new original.default(opts) : new FakeTuya(opts)
  }

  return { default: Tuya }
})

import adapter, { closeTuyaLinks } from '../../src/adapters/tuya-local.ts'
import { makeAction, makeCtx, type TestCtx } from '../helpers.ts'

const IP = '192.168.1.60'
const ID = 'bf3a9c41d07e52ab68xyzq'
const KEY = 'a1B2c3D4e5F6g7H8'
const OTHER_KEY = 'ZZZZZZZZZZZZZZZZ'

function addDevice(over: Partial<SimDevice> = {}): SimDevice {
  const sim: SimDevice = {
    ip: IP,
    port: 6668,
    id: ID,
    key: KEY,
    version: '3.3',
    dps: { '1': true, '9': 0 },
    net: 'up',
    mute: null,
    badKey: 'silent',
    hangsUpWhenAsked: false,
    hangsUpOnCommand: false,
    quiet: false,
    ignoreSets: false,
    stuckOn: false,
    selfReleaseMs: 0,
    fullStatus: false,
    floor: {},
    chatter: null,
    textReply: null,
    oneValueOnly: false,
    slowToFreeMs: 0,
    busyUntil: 0,
    live: 0,
    maxLive: 0,
    ...over,
  }
  world.devices.set(sim.ip, sim)
  return sim
}

/** A bulb as the notes describe it: 20 switch_led, 21 work_mode, 22 bright_value_v2, 23 temp_value_v2. */
function addBulb(dps: Record<string, unknown> = {}, over: Partial<SimDevice> = {}): SimDevice {
  return addDevice({ dps: { '20': true, '21': 'white', '22': 500, '23': 500, ...dps }, ...over })
}

function ctxFor(kind: DeviceKind, config: Record<string, unknown> = {}, opts: { host?: string | null; port?: number | null; timeoutMs?: number } = {}): TestCtx {
  return makeCtx({
    family: 'tuya-local',
    kind,
    config: { deviceId: ID, localKey: KEY, version: '3.3', ...config },
    path: { host: opts.host === undefined ? IP : opts.host, port: opts.port ?? null },
    timeoutMs: opts.timeoutMs,
  })
}

const ops = (op: LogEntry['op']) => world.log.filter((e) => e.op === op)
const sets = () => ops('set').map((e) => e.args)
const gets = () => ops('get').map((e) => e.args)
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  world.devices.clear()
  world.log.length = 0
  world.made = 0
  world.real = false
})

afterEach(() => {
  closeTuyaLinks()
  vi.useRealTimers()
})

describe('tuya-local: add-device form', () => {
  it('describes itself in plain words', () => {
    const d = adapter.describe()
    expect(adapter.family).toBe('tuya-local')
    expect(d.id).toBe('tuya-local')
    expect(d.kinds).toEqual(['light', 'switch', 'gate'])
    expect(d.pathKinds).toEqual(['lan'])
    expect(d.defaultPort).toBe(6668)
    const field = (name: string) => d.fields.find((f) => f.name === name)
    expect(field('deviceId')?.required).toBe(true)
    expect(field('localKey')).toMatchObject({ secret: true, required: true, type: 'password' })
    expect(field('version')?.default).toBe('3.3')
    expect(field('version')?.options?.map((o) => o.value).sort()).toEqual(['3.1', '3.3', '3.4', '3.5'])
    expect(field('switchDp')?.type).toBe('number')
    expect(field('dimmer')).toMatchObject({ type: 'toggle', default: false })
    for (const name of ['dimDp', 'dimMin', 'dimMax']) expect(field(name)?.showWhen).toEqual({ field: 'dimmer', equals: true })
    expect(field('dimMin')?.default).toBe(10)
    expect(field('dimMax')?.default).toBe(1000)
    expect(field('pulseMs')?.showWhen).toEqual({ field: 'gateMode', equals: 'pulse' })
    expect(field('pulseMs')?.help).toMatch(/longest press is 5000/)
    // Only the local key is secret.
    expect(d.fields.filter((f) => f.secret).map((f) => f.name)).toEqual(['localKey'])
  })

  it('tells the owner how to get the key, that it changes on re-pairing, and about the single connection', () => {
    const notes = adapter.describe().notes.join('\n')
    expect(notes).toMatch(/iot\.tuya\.com/)
    expect(notes).toMatch(/Link Tuya App Account/)
    expect(notes).toMatch(/tuya-cli wizard/)
    expect(notes).toMatch(/tinytuya wizard/)
    expect(notes).toMatch(/linked to two such projects at most/)
    expect(notes).toMatch(/key changes every time the device is removed and paired again/)
    expect(notes).toMatch(/only one local connection at a time/)
    expect(notes).toMatch(/Smart Life app is open/)
    expect(notes).toMatch(/cannot move a Tuya device to another WiFi/)
    expect(notes).toMatch(/puts it back on white light/)
  })

  it('uses no builder jargon in anything the owner reads', () => {
    const d = adapter.describe()
    const text = [
      d.label,
      d.tagline,
      ...d.notes,
      ...d.fields.flatMap((f) => [f.label, f.help ?? '', f.placeholder ?? '', ...(f.options ?? []).map((o) => o.label)]),
    ].join('\n')
    expect(text).not.toMatch(/\b(demo|prototype|placeholder|stub|todo)\b/i)
  })

  it('works out capabilities from the kind and settings', () => {
    expect(adapter.capabilities({}, 'switch')).toEqual(['power', 'state'])
    expect(adapter.capabilities({}, 'light')).toEqual(['power', 'state'])
    expect(adapter.capabilities({ dimmer: true }, 'light')).toEqual(['power', 'dim', 'state'])
    expect(adapter.capabilities({ dimmer: 'true' }, 'light')).toContain('dim')
    expect(adapter.capabilities({}, 'gate')).toEqual(['gate'])
    expect(adapter.capabilities({ dimmer: true }, 'gate')).toEqual(['gate'])
    expect(adapter.capabilities({ gateMode: 'hold' }, 'gate')).toEqual(['gate', 'gate-state', 'state'])
    for (const c of adapter.capabilities({ dimmer: true }, 'light')) expect(adapter.describe().capabilities).toContain(c)
  })

  it('offers no camera or WiFi-move features', () => {
    expect(adapter.snapshot).toBeUndefined()
    expect(adapter.streamSources).toBeUndefined()
    expect(adapter.setWifi).toBeUndefined()
    expect(adapter.scanWifi).toBeUndefined()
  })
})

describe('tuya-local: checking the connection', () => {
  it('connects with id, key, address and version, reads the schema and reports state', async () => {
    const sim = addDevice()
    const res = await adapter.probe(ctxFor('switch'))
    expect(res.ok).toBe(true)
    expect(res.latencyMs).toBeTypeOf('number')
    expect(res.info).toEqual({ power: true, serial: ID })
    expect(ops('new').map((e) => e.args)).toEqual([{ id: ID, key: KEY, ip: IP, port: 6668, version: '3.3', issueGetOnConnect: false }])
    expect(gets()).toEqual([{ schema: true, dps: 1 }])
    expect(sets()).toEqual([])
    expect(sim.live).toBe(1)
  })

  it('takes the address and port from the connection path in use', async () => {
    addDevice({ ip: '10.0.0.7', port: 6669, version: '3.4' })
    const res = await adapter.probe(ctxFor('switch', { version: '3.4' }, { host: '10.0.0.7', port: 6669 }))
    expect(res.ok).toBe(true)
    expect(ops('new')[0]?.args).toMatchObject({ ip: '10.0.0.7', port: 6669, version: '3.4' })
  })

  it('falls back to 3.3 when the version is not one tuyapi speaks', async () => {
    addDevice()
    expect((await adapter.probe(ctxFor('switch', { version: '9.9' }))).ok).toBe(true)
    expect(ops('new')[0]?.args).toMatchObject({ version: '3.3' })
  })

  it('says so when the path has no address', async () => {
    const res = await adapter.probe(ctxFor('switch', {}, { host: null }))
    expect(res).toMatchObject({ ok: false, latencyMs: null })
    expect(res.error).toMatch(/No address set on the "Home WiFi" connection/)
    expect(world.made).toBe(0)
  })

  it('rejects a key that is not 16 characters without contacting the device', async () => {
    addDevice()
    const res = await adapter.probe(ctxFor('switch', { localKey: 'tooshort' }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/exactly 16 characters/)
    expect(res.error).not.toContain('tooshort')
    expect(world.made).toBe(0)
    const none = await adapter.probe(ctxFor('switch', { localKey: '' }))
    expect(none.error).toMatch(/No local key/)
    const noId = await adapter.probe(ctxFor('switch', { deviceId: ' ' }))
    expect(noId.error).toMatch(/No Device ID/)
  })

  it('reports a wrong key on a 3.3 device that stays silent, and frees the connection', async () => {
    const sim = addDevice({ key: OTHER_KEY })
    const res = await adapter.probe(ctxFor('switch', {}, { timeoutMs: 120 }))
    expect(res.ok).toBe(false)
    expect(res.latencyMs).toBeNull()
    expect(res.error).toMatch(/took the connection but did not answer/)
    expect(res.error).toMatch(/local key or protocol version may be wrong/)
    expect(res.error).not.toContain(KEY)
    expect(sim.live).toBe(0)
  })

  it('reports a wrong key on a 3.3 device whose reply cannot be decrypted', async () => {
    const sim = addDevice({ key: OTHER_KEY, badKey: 'answers' })
    const res = await adapter.probe(ctxFor('switch'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/could not read the reply. The local key or the protocol version is not right/)
    expect(sim.live).toBe(0)
  })

  it('reports a wrong key on a 3.4 device at once when its sign-in reply fails the key check', async () => {
    const sim = addDevice({ key: OTHER_KEY, version: '3.4', badKey: 'answers' })
    const started = Date.now()
    const res = await adapter.probe(ctxFor('switch', { version: '3.4' }))
    // tuyapi leaves connect() pending in this case; the adapter must not wait out the whole timeout.
    expect(Date.now() - started).toBeLessThan(1000)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not accept the local key/)
    expect(res.error).toMatch(/paired again in Smart Life/)
    expect(res.error).not.toMatch(/HMAC|abab|cdcd/)
    expect(res.error).not.toContain(KEY)
    await tick()
    expect(sim.live).toBe(0)
  })

  it('survives the exception tuyapi throws on a 3.5 sign-in reply it cannot decrypt, and reports the key', async () => {
    const sim = addDevice({ key: OTHER_KEY, version: '3.5', badKey: 'answers' })
    const res = await adapter.probe(ctxFor('switch', { version: '3.5' }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not accept the local key/)
    await tick()
    expect(sim.live).toBe(0)
  })

  it('says so at once when a 3.4 / 3.5 device hangs up during the sign-in', async () => {
    for (const version of ['3.4', '3.5']) {
      const sim = addDevice({ key: OTHER_KEY, version, badKey: 'hangsUp' })
      const started = Date.now()
      const res = await adapter.probe(ctxFor('switch', { version }))
      expect(Date.now() - started).toBeLessThan(1000)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/took the connection but closed it during the secure sign-in/)
      expect(res.error).toMatch(/local key or protocol version may be wrong/)
      expect(sim.live).toBe(0)
      closeTuyaLinks()
    }
  })

  it('gives up on a 3.5 sign-in that never completes', async () => {
    const sim = addDevice({ version: '3.5', mute: 'handshake' })
    const res = await adapter.probe(ctxFor('switch', { version: '3.5' }, { timeoutMs: 120 }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not finish the secure sign-in/)
    await tick()
    expect(sim.live).toBe(0)
  })

  it('gives up on a device that connects but never answers', async () => {
    const sim = addDevice({ mute: 'requests' })
    const started = Date.now()
    const res = await adapter.probe(ctxFor('switch', {}, { timeoutMs: 120 }))
    expect(Date.now() - started).toBeLessThan(1500)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/took the connection but did not answer/)
    expect(res.error).toMatch(/Smart Life/)
    expect(sim.live).toBe(0)
  })

  it('does not wait for the timeout when the device closes the connection instead of answering', async () => {
    const sim = addDevice({ hangsUpWhenAsked: true })
    const started = Date.now()
    const res = await adapter.probe(ctxFor('switch'))
    expect(Date.now() - started).toBeLessThan(1000)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/closed the connection without answering/)
    expect(sim.live).toBe(0)
    await expect(adapter.readState!(ctxFor('switch'))).rejects.toThrow(/closed the connection without answering/)
  })

  it('explains an unreachable device in plain words', async () => {
    addDevice({ net: 'refused' })
    const refused = await adapter.probe(ctxFor('switch'))
    expect(refused).toMatchObject({ ok: false, latencyMs: null })
    expect(refused.error).toMatch(/192\.168\.1\.60:6668 refused the connection/)

    addDevice({ net: 'unreachable' })
    expect((await adapter.probe(ctxFor('switch'))).error).toMatch(/192\.168\.1\.60 is not reachable from this network/)

    addDevice({ net: 'dropped' })
    expect((await adapter.probe(ctxFor('switch'))).error).toMatch(/192\.168\.1\.60:6668 did not answer/)

    world.devices.clear()
    expect((await adapter.probe(ctxFor('switch'))).ok).toBe(false)
  })

  it('reports when another app holds the device’s only connection', async () => {
    const sim = addDevice()
    sim.live = 1 // Smart Life on the same WiFi
    const res = await adapter.probe(ctxFor('switch'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/closed the connection\. Another app may be using the device's only local connection/)
  })

  it('reports a reply it cannot read as a key / version problem', async () => {
    // "devid not found" is a plain-text device answer that tuyapi passes through (index.js, get()).
    addDevice({ textReply: 'devid not found' })
    expect((await adapter.probe(ctxFor('switch'))).error).toMatch(/Device ID is not its own/)
    closeTuyaLinks()
    addDevice({ textReply: '\u0013��q\u0002' })
    const res = await adapter.probe(ctxFor('switch'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/could not read the reply/)
    closeTuyaLinks()
    // "data format error": tuyapi retries by set(), which fails with its own "Timeout waiting for status response".
    addDevice({ textReply: 'data format error' })
    const formatError = await adapter.probe(ctxFor('switch'))
    expect(formatError.ok).toBe(false)
    expect(formatError.error).toMatch(/did not answer. The local key or protocol version may be wrong/)
    expect(formatError.error).not.toContain(ID)
  })
})

describe('tuya-local: reading state', () => {
  it('reads a switch: {"dps":{"1":true,"9":0}} -> power on', async () => {
    addDevice()
    expect(await adapter.readState!(ctxFor('switch'))).toEqual({ power: true })
    world.devices.get(IP)!.dps['1'] = false
    closeTuyaLinks()
    expect(await adapter.readState!(ctxFor('switch'))).toEqual({ power: false })
  })

  it('reads a bulb on data point 20 and scales brightness 10-1000 to 0-100', async () => {
    addBulb()
    const ctx = ctxFor('light', { dimmer: true })
    expect(await adapter.readState!(ctx)).toEqual({ power: true, brightness: 50 })
    expect(gets()).toEqual([{ schema: true, dps: 20 }])
    closeTuyaLinks()
    world.devices.get(IP)!.dps['22'] = 1000
    expect(await adapter.readState!(ctx)).toMatchObject({ brightness: 100 })
    closeTuyaLinks()
    world.devices.get(IP)!.dps['22'] = 10
    expect(await adapter.readState!(ctx)).toMatchObject({ brightness: 1 })
  })

  it('leaves brightness out when the device is not marked dimmable', async () => {
    addBulb()
    expect(await adapter.readState!(ctxFor('light'))).toEqual({ power: true })
  })

  it('works out the on/off data point: a wall switch added as a light answers on 1', async () => {
    addDevice({ dps: { '1': false, '9': 0 } })
    expect(await adapter.readState!(ctxFor('light'))).toEqual({ power: false })
  })

  it('reads one button of a multi-button switch (channels 1..6)', async () => {
    addDevice({ dps: { '1': false, '2': true, '3': false } })
    expect(await adapter.readState!(ctxFor('switch', { switchDp: 2 }))).toEqual({ power: true })
    expect(gets()).toEqual([{ schema: true, dps: 2 }])
  })

  it('reads a model that cannot list its values, by naming the on/off value it wants', async () => {
    addBulb({}, { oneValueOnly: true })
    expect(await adapter.readState!(ctxFor('light'))).toEqual({ power: true })
    expect(gets()).toEqual([{ schema: true, dps: 20 }])
  })

  it('honours a hand-set brightness channel and the older 25-255 range', async () => {
    addDevice({ dps: { '1': true, '2': 'white', '3': 255 } })
    const ctx = ctxFor('light', { dimmer: true, switchDp: 1, dimDp: 3, dimMin: 25, dimMax: 255 })
    expect(await adapter.readState!(ctx)).toEqual({ power: true, brightness: 100 })
  })

  it('reads 3.4 and 3.5 devices the same way', async () => {
    addDevice({ version: '3.4', dps: { '1': true, '9': 0 } })
    expect(await adapter.readState!(ctxFor('switch', { version: '3.4' }))).toEqual({ power: true })
    closeTuyaLinks()
    addBulb({}, { version: '3.5' })
    expect(await adapter.readState!(ctxFor('light', { version: '3.5', dimmer: true }))).toEqual({ power: true, brightness: 50 })
    expect(ops('new').map((e) => (e.args as { version: string }).version)).toEqual(['3.4', '3.5'])
  })

  it('uses one request for the check and the state read that follows it', async () => {
    addDevice()
    const ctx = ctxFor('switch')
    expect((await adapter.probe(ctx)).ok).toBe(true)
    expect(await adapter.readState!(ctx)).toEqual({ power: true })
    expect(gets()).toHaveLength(1)
    expect(world.made).toBe(1)
  })

  it('throws a plain sentence when the device cannot be reached', async () => {
    addDevice({ net: 'refused' })
    await expect(adapter.readState!(ctxFor('switch'))).rejects.toThrow(/refused the connection/)
  })

  it('says a gate in button-press mode has no known position; a holding relay does', async () => {
    addDevice({ dps: { '1': false, '9': 0 } })
    expect(await adapter.readState!(ctxFor('gate'))).toEqual({ gate: 'unknown' })
    expect(await adapter.readState!(ctxFor('gate', { gateMode: 'hold' }))).toEqual({ gate: 'closed' })
    closeTuyaLinks()
    world.devices.get(IP)!.dps['1'] = true
    expect(await adapter.readState!(ctxFor('gate', { gateMode: 'hold' }))).toEqual({ gate: 'open' })
  })
})

describe('tuya-local: on / off', () => {
  it('turns a switch on with set({dps:1,set:true})', async () => {
    const sim = addDevice({ dps: { '1': false, '9': 0 } })
    const res = await adapter.execute(ctxFor('switch'), makeAction('power.on'))
    expect(res).toEqual({ ok: true, state: { power: true } })
    expect(sets()).toEqual([{ dps: 1, set: true }])
    expect(sim.dps['1']).toBe(true)
  })

  it('turns a switch off', async () => {
    const sim = addDevice()
    const res = await adapter.execute(ctxFor('switch'), makeAction('power.off'))
    expect(res).toEqual({ ok: true, state: { power: false } })
    expect(sets()).toEqual([{ dps: 1, set: false }])
    expect(sim.dps['1']).toBe(false)
  })

  it('toggles from what the device reports right now', async () => {
    const sim = addDevice()
    const ctx = ctxFor('switch')
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toMatchObject({ ok: true, state: { power: false } })
    sim.dps['1'] = true // someone pressed the wall button meanwhile
    expect(await adapter.execute(ctx, makeAction('power.toggle'))).toMatchObject({ ok: true, state: { power: false } })
    expect(sets()).toEqual([
      { dps: 1, set: false },
      { dps: 1, set: false },
    ])
  })

  it('sends nothing when the device is already there (it would not answer)', async () => {
    addDevice()
    const res = await adapter.execute(ctxFor('switch'), makeAction('power.on'))
    expect(res).toEqual({ ok: true, state: { power: true }, result: { unchanged: true } })
    expect(sets()).toEqual([])
  })

  it('switches a bulb on data point 20 and reports its brightness with it', async () => {
    addBulb({ '20': false })
    const res = await adapter.execute(ctxFor('light', { dimmer: true }), makeAction('power.on'))
    expect(res).toEqual({ ok: true, state: { power: true, brightness: 50 } })
    expect(sets()).toEqual([{ dps: 20, set: true }])
  })

  it('switches the chosen button of a multi-button switch', async () => {
    const sim = addDevice({ dps: { '1': false, '2': false, '3': true } })
    await adapter.execute(ctxFor('switch', { switchDp: 2 }), makeAction('power.on'))
    expect(sets()).toEqual([{ dps: 2, set: true }])
    expect(sim.dps).toEqual({ '1': false, '2': true, '3': true })
  })

  it('also accepts a status packet that carries every value', async () => {
    addDevice({ fullStatus: true })
    expect(await adapter.execute(ctxFor('switch'), makeAction('power.off'))).toEqual({ ok: true, state: { power: false } })
  })

  it('checks the device itself when no confirmation arrives', async () => {
    const sim = addDevice({ quiet: true })
    const res = await adapter.execute(ctxFor('switch'), makeAction('power.off'))
    expect(res).toEqual({ ok: true, state: { power: false } })
    expect(sets()).toEqual([{ dps: 1, set: false }])
    // read, set (no status), new connection, read again
    expect(gets()).toHaveLength(2)
    expect(world.made).toBe(2)
    expect(sim.maxLive).toBe(1)
  })

  it('is not fooled by an unrelated status packet arriving first', async () => {
    // A metering socket pushes its readings (18 current, 19 power, 20 voltage) whenever they move.
    const sim = addDevice({ dps: { '1': true, '9': 0, '18': 120, '19': 264, '20': 2301 }, chatter: { '19': 0 } })
    expect(await adapter.execute(ctxFor('switch'), makeAction('power.off'))).toEqual({ ok: true, state: { power: false } })
    expect(sim.dps['1']).toBe(false)
    expect(gets()).toHaveLength(2) // looked again instead of trusting the stray packet
    sim.ignoreSets = true
    const stuck = await adapter.execute(ctxFor('switch'), makeAction('power.on'))
    expect(stuck.ok).toBe(false)
    expect(stuck.error).toMatch(/answered but did not change/)
  })

  it('tries once more when the device is slow to take a new connection after the hub closed its own', async () => {
    const sim = addDevice({ quiet: true, slowToFreeMs: 400 })
    const res = await adapter.execute(ctxFor('switch'), makeAction('power.off'))
    expect(res).toEqual({ ok: true, state: { power: false } })
    // read + set, a refused reconnect, then the one that works.
    expect(world.made).toBe(3)
    expect(sim.maxLive).toBe(1)
  })

  it('does not retry a refused connection when the hub had no connection of its own just before', async () => {
    addDevice({ net: 'refused' })
    const started = Date.now()
    await expect(adapter.execute(ctxFor('switch'), makeAction('power.on'))).rejects.toThrow(/refused the connection/)
    expect(Date.now() - started).toBeLessThan(400)
    expect(world.made).toBe(1)
  })

  it('reports (does not throw) a device that was reached, asked, and stayed as it was', async () => {
    addDevice({ ignoreSets: true })
    const res = await adapter.execute(ctxFor('switch'), makeAction('power.off'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not confirm the command and has not changed/)
    expect(res.state).toBeUndefined()
  })

  it('throws transport failures and returns device refusals', async () => {
    addDevice({ net: 'unreachable' })
    await expect(adapter.execute(ctxFor('switch'), makeAction('power.on'))).rejects.toThrow(/not reachable from this network/)
    await expect(adapter.execute(ctxFor('switch', {}, { host: '' }), makeAction('power.on'))).rejects.toThrow(/No address set/)

    addDevice({ mute: 'requests' })
    await expect(adapter.execute(ctxFor('switch', {}, { timeoutMs: 120 }), makeAction('power.on'))).rejects.toThrow(/took the connection but did not answer/)

    addDevice({ key: OTHER_KEY, version: '3.4', badKey: 'answers' })
    const wrongKey = await adapter.execute(ctxFor('switch', { version: '3.4' }), makeAction('power.on'))
    expect(wrongKey.ok).toBe(false)
    expect(wrongKey.error).toMatch(/did not accept the local key/)

    const badKey = await adapter.execute(ctxFor('switch', { localKey: 'short' }), makeAction('power.on'))
    expect(badKey).toMatchObject({ ok: false })
    expect(badKey.error).toMatch(/exactly 16 characters/)
  })

  it('names the data points the device does have when the chosen one is not an on/off value', async () => {
    addDevice()
    const res = await adapter.execute(ctxFor('switch', { switchDp: 7 }), makeAction('power.on'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no on\/off value at channel number 7/)
    expect(res.error).toMatch(/on\/off values at: 1\b/)
    expect(sets()).toEqual([])
  })
})

describe('tuya-local: brightness', () => {
  it('turns an off bulb on at 50% with set({multiple:true,data:{20:true,22:500}})', async () => {
    const sim = addBulb({ '20': false, '22': 10 })
    const res = await adapter.execute(ctxFor('light', { dimmer: true }), makeAction('dim.set', { brightness: 50 }))
    expect(res).toEqual({ ok: true, state: { power: true, brightness: 50 } })
    expect(sets()).toEqual([{ multiple: true, data: { '20': true, '22': 500 } }])
    expect(sim.dps).toMatchObject({ '20': true, '22': 500, '21': 'white' })
  })

  it('sends only the brightness when the bulb is already on', async () => {
    addBulb()
    await adapter.execute(ctxFor('light', { dimmer: true }), makeAction('dim.set', { brightness: 30 }))
    expect(sets()).toEqual([{ dps: 22, set: 300 }])
  })

  it('keeps inside the device range: 100% -> 1000, 1% -> 10, out-of-range input is clamped', async () => {
    const ctx = ctxFor('light', { dimmer: true })
    addBulb()
    await adapter.execute(ctx, makeAction('dim.set', { brightness: 100 }))
    await adapter.execute(ctx, makeAction('dim.set', { brightness: 1 }))
    const res = await adapter.execute(ctx, makeAction('dim.set', { brightness: 250 }))
    expect(res.state).toEqual({ power: true, brightness: 100 })
    expect(sets()).toEqual([
      { dps: 22, set: 1000 },
      { dps: 22, set: 10 },
      { dps: 22, set: 1000 },
    ])
  })

  it('treats 0% as off and does not push the brightness below the device minimum', async () => {
    const sim = addBulb()
    const res = await adapter.execute(ctxFor('light', { dimmer: true }), makeAction('dim.set', { brightness: 0 }))
    expect(res).toEqual({ ok: true, state: { power: false, brightness: 0 } })
    expect(sets()).toEqual([{ dps: 20, set: false }])
    expect(sim.dps['22']).toBe(500)
  })

  it('sends nothing when the bulb is already at that level', async () => {
    addBulb()
    const res = await adapter.execute(ctxFor('light', { dimmer: true }), makeAction('dim.set', { brightness: 50 }))
    expect(res).toEqual({ ok: true, state: { power: true, brightness: 50 }, result: { unchanged: true } })
    expect(sets()).toEqual([])
  })

  it('puts a bulb that is showing a colour back on white light, where its brightness value applies', async () => {
    // 21 work_mode: white | colour | scene | music (bright_value_v2 is the white-light brightness).
    const sim = addBulb({ '21': 'colour', '24': '00c803e803e8' })
    const res = await adapter.execute(ctxFor('light', { dimmer: true }), makeAction('dim.set', { brightness: 30 }))
    expect(res).toEqual({ ok: true, state: { power: true, brightness: 30 } })
    expect(sets()).toEqual([{ multiple: true, data: { '21': 'white', '22': 300 } }])
    expect(sim.dps).toMatchObject({ '20': true, '21': 'white', '22': 300 })
  })

  it('leaves the mode value alone on a dimmer switch, where 2 is the brightness itself', async () => {
    addDevice({ dps: { '1': true, '2': 500, '3': 10 } })
    await adapter.execute(ctxFor('switch', { dimmer: true }), makeAction('dim.set', { brightness: 80 }))
    expect(sets()).toEqual([{ dps: 2, set: 800 }])
  })

  it('reports the level the device settled on when it will not go as low as asked', async () => {
    // A dimmer whose own lowest level is 100: asked for 50 it goes to 100 and says so.
    const sim = addDevice({ dps: { '1': true, '2': 500 }, floor: { '2': 100 } })
    const res = await adapter.execute(ctxFor('switch', { dimmer: true }), makeAction('dim.set', { brightness: 5 }))
    expect(sets()).toEqual([{ dps: 2, set: 50 }])
    expect(sim.dps['2']).toBe(100)
    expect(res).toEqual({ ok: true, state: { power: true, brightness: 10 } })
  })

  it('uses a hand-set channel and range (older bulbs: 25-255)', async () => {
    addDevice({ dps: { '1': true, '2': 'white', '3': 25 } })
    const ctx = ctxFor('light', { dimmer: true, switchDp: 1, dimDp: 3, dimMin: 25, dimMax: 255 })
    await adapter.execute(ctx, makeAction('dim.set', { brightness: 100 }))
    await adapter.execute(ctx, makeAction('dim.set', { brightness: 2 }))
    expect(sets()).toEqual([
      { dps: 3, set: 255 },
      { dps: 3, set: 25 },
    ])
  })

  it('refuses without contacting the device when it is not dimmable or no level is given', async () => {
    addBulb()
    const plain = await adapter.execute(ctxFor('light'), makeAction('dim.set', { brightness: 40 }))
    expect(plain.ok).toBe(false)
    expect(plain.error).toMatch(/not set up as dimmable/)
    expect(world.made).toBe(0)
    const empty = await adapter.execute(ctxFor('light', { dimmer: true }), makeAction('dim.set', {}))
    expect(empty).toEqual({ ok: false, error: 'No brightness was given' })
    expect(sets()).toEqual([])
  })
})

describe('tuya-local: gate and garage door', () => {
  const gate = (config: Record<string, unknown> = {}, timeoutMs?: number) => ctxFor('gate', { pulseMs: 150, ...config }, { timeoutMs })

  it('presses the gate button: relay on, wait, relay off', async () => {
    const sim = addDevice({ dps: { '1': false, '9': 0 } })
    const res = await adapter.execute(gate(), makeAction('gate.pulse'))
    expect(res).toEqual({ ok: true, result: { pressedMs: 150 }, state: { gate: 'unknown' } })
    expect(sets()).toEqual([
      { dps: 1, set: true },
      { dps: 1, set: false },
    ])
    const [press, letGo] = ops('set')
    expect(letGo!.at - press!.at).toBeGreaterThanOrEqual(140)
    expect(sim.dps['1']).toBe(false)
    expect(res.needsConfirmation).toBeUndefined()
  })

  it('uses the same single press for open, close and stop, like the remote', async () => {
    addDevice({ dps: { '1': false, '9': 0 } })
    const ctx = gate({ pulseMs: 100 })
    for (const type of ['gate.open', 'gate.close', 'gate.stop'] as const) {
      const res = await adapter.execute(ctx, makeAction(type))
      expect(res.ok).toBe(true)
    }
    expect(sets()).toEqual([
      { dps: 1, set: true },
      { dps: 1, set: false },
      { dps: 1, set: true },
      { dps: 1, set: false },
      { dps: 1, set: true },
      { dps: 1, set: false },
    ])
  })

  it('never holds the button longer than five seconds, whatever the setting says', async () => {
    vi.useFakeTimers()
    const sim = addDevice({ dps: { '1': false, '9': 0 } })
    const pressing = adapter.execute(gate({ pulseMs: 60000 }), makeAction('gate.pulse'))
    await vi.advanceTimersByTimeAsync(4900)
    expect(sim.dps['1']).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(await pressing).toEqual({ ok: true, result: { pressedMs: 5000 }, state: { gate: 'unknown' } })
    expect(sim.dps['1']).toBe(false)
  })

  it('does not send a second "off" to a relay that lets go by itself', async () => {
    const sim = addDevice({ dps: { '1': false, '9': 0 }, selfReleaseMs: 30 })
    const res = await adapter.execute(gate(), makeAction('gate.open'))
    expect(res.ok).toBe(true)
    expect(sets()).toEqual([{ dps: 1, set: true }])
    expect(sim.dps['1']).toBe(false)
  })

  it('lets go of a relay that was left on before pressing', async () => {
    addDevice({ dps: { '1': true, '9': 0 } })
    const res = await adapter.execute(gate({ pulseMs: 100 }), makeAction('gate.pulse'))
    expect(res.ok).toBe(true)
    expect(sets()).toEqual([
      { dps: 1, set: false },
      { dps: 1, set: true },
      { dps: 1, set: false },
    ])
  })

  it('reports (and does not throw) when the press was not confirmed, after making sure the relay is off', async () => {
    const sim = addDevice({ dps: { '1': false, '9': 0 }, ignoreSets: true })
    const res = await adapter.execute(gate(), makeAction('gate.open'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not confirm the press/)
    expect(res.error).toMatch(/look at the gate before trying again/)
    expect(sim.dps['1']).toBe(false)
  })

  it('does not throw when the relay hangs up on the press either: a retry elsewhere would press twice', async () => {
    const sim = addDevice({ dps: { '1': false, '9': 0 }, hangsUpOnCommand: true })
    const res = await adapter.execute(gate(), makeAction('gate.open'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not confirm the press/)
    expect(sim.dps['1']).toBe(false)
    expect(sets()).toEqual([{ dps: 1, set: true }])
  })

  it('warns when the relay will not let go again', async () => {
    const sim = addDevice({ dps: { '1': false, '9': 0 }, stuckOn: true })
    const res = await adapter.execute(gate({ pulseMs: 100 }), makeAction('gate.pulse'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/could not confirm that it let go again/)
    expect(sim.dps['1']).toBe(true)
    // It kept trying to switch the relay off.
    expect(sets().filter((s) => (s as { set?: unknown }).set === false).length).toBeGreaterThanOrEqual(2)
  })

  it('throws before anything was pressed when the gate relay is unreachable', async () => {
    addDevice({ net: 'refused' })
    await expect(adapter.execute(gate(), makeAction('gate.open'))).rejects.toThrow(/refused the connection/)
    expect(sets()).toEqual([])
  })

  it('holds the relay for gates wired as "on = open, off = closed"', async () => {
    const sim = addDevice({ dps: { '1': false, '9': 0 } })
    const ctx = gate({ gateMode: 'hold' })
    expect(await adapter.execute(ctx, makeAction('gate.open'))).toEqual({ ok: true, state: { gate: 'open' } })
    expect(sim.dps['1']).toBe(true)
    expect(await adapter.execute(ctx, makeAction('gate.open'))).toEqual({ ok: true, state: { gate: 'open' }, result: { alreadyThere: true } })
    expect(await adapter.execute(ctx, makeAction('gate.close'))).toEqual({ ok: true, state: { gate: 'closed' } })
    expect(sets()).toEqual([
      { dps: 1, set: true },
      { dps: 1, set: false },
    ])
    const stop = await adapter.execute(ctx, makeAction('gate.stop'))
    expect(stop.ok).toBe(false)
    expect(stop.error).toMatch(/only has Open and Close/)
    expect((await adapter.execute(ctx, makeAction('gate.pulse'))).ok).toBe(false)
  })
})

describe('tuya-local: everything else', () => {
  it('sets raw data points through a custom command', async () => {
    const sim = addBulb({ '20': false, '22': 10 })
    const res = await adapter.execute(ctxFor('light', { dimmer: true }), makeAction('custom', { dps: { '20': true, '22': 500 } }))
    expect(res).toEqual({ ok: true, result: { dps: { '20': true, '22': 500 } }, state: { power: true, brightness: 50 } })
    expect(sets()).toEqual([{ multiple: true, data: { '20': true, '22': 500 } }])
    expect(sim.dps).toMatchObject({ '20': true, '22': 500 })
    const bad = await adapter.execute(ctxFor('light'), makeAction('custom', { dps: { power: true } }))
    expect(bad.ok).toBe(false)
    expect((await adapter.execute(ctxFor('light'), makeAction('custom', {}))).ok).toBe(false)
  })

  it('refuses what it cannot do without contacting the device', async () => {
    addDevice()
    const light = ctxFor('light')
    for (const [type, params] of [
      ['color.set', { hex: '#ff8800' }],
      ['reboot', {}],
      ['ptz.move', { pan: 1 }],
      ['ptz.stop', {}],
      ['ptz.preset', { preset: 1 }],
      ['sms.send', { text: 'hi' }],
      ['gate.open', {}],
      ['gate.pulse', {}],
    ] as const) {
      const res = await adapter.execute(light, makeAction(type, params))
      expect(res.ok, type).toBe(false)
      expect(res.error, type).toBeTruthy()
    }
    const gateCtx = ctxFor('gate')
    for (const type of ['power.on', 'power.off', 'power.toggle', 'dim.set'] as const) {
      expect((await adapter.execute(gateCtx, makeAction(type, { brightness: 10 }))).ok, type).toBe(false)
    }
    expect(world.made).toBe(0)
  })

  it('never opens a second connection: calls arriving together share one, in turn', async () => {
    const sim = addDevice()
    const ctx = ctxFor('switch')
    const [probe, state, off] = await Promise.all([adapter.probe(ctx), adapter.readState!(ctx), adapter.execute(ctx, makeAction('power.off'))])
    expect(probe.ok).toBe(true)
    expect(state).toEqual({ power: true })
    expect(off).toEqual({ ok: true, state: { power: false } })
    expect(world.made).toBe(1)
    expect(sim.maxLive).toBe(1)
  })

  it('lets go of the connection after a few idle seconds, and reconnects on the next call', async () => {
    vi.useFakeTimers()
    const sim = addDevice()
    const ctx = ctxFor('switch')
    expect((await adapter.probe(ctx)).ok).toBe(true)
    expect(sim.live).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(sim.live).toBe(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(sim.live).toBe(0)
    expect(ops('disconnect')).toHaveLength(1)
    expect((await adapter.probe(ctx)).ok).toBe(true)
    expect(world.made).toBe(2)
    expect(sim.maxLive).toBe(1)
  })

  it('gives the device a moment between its own connections, also after the idle close', async () => {
    vi.useFakeTimers()
    addDevice()
    const ctx = ctxFor('switch')
    expect((await adapter.probe(ctx)).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(3000) // idle close happens now
    const again = adapter.probe(ctx)
    await vi.advanceTimersByTimeAsync(100)
    expect(world.made).toBe(1) // still waiting out the pause
    await vi.advanceTimersByTimeAsync(100)
    expect((await again).ok).toBe(true)
    expect(world.made).toBe(2)
  })

  it('uses a separate connection per address, so a second path is really tried on its own address', async () => {
    addDevice()
    addDevice({ ip: '192.168.2.60' })
    expect((await adapter.probe(ctxFor('switch'))).ok).toBe(true)
    expect((await adapter.probe(ctxFor('switch', {}, { host: '192.168.2.60' }))).ok).toBe(true)
    expect(ops('new').map((e) => (e.args as { ip: string }).ip)).toEqual([IP, '192.168.2.60'])
  })

  it('never lets the local key into an error, a result or a state value', async () => {
    const seen: unknown[] = []
    addDevice()
    seen.push(await adapter.probe(ctxFor('switch')), await adapter.readState!(ctxFor('switch')), await adapter.execute(ctxFor('switch'), makeAction('power.off')))
    closeTuyaLinks()
    const fast = { timeoutMs: 100 }
    for (const over of [
      { net: 'refused' },
      { net: 'unreachable' },
      { net: 'dropped' },
      { version: '3.4' },
      { key: OTHER_KEY, badKey: 'answers' },
      { key: OTHER_KEY, badKey: 'hangsUp' },
      { textReply: 'devid not found' },
      { ignoreSets: true },
    ] as Partial<SimDevice>[]) {
      addDevice(over)
      seen.push(await adapter.probe(ctxFor('switch', {}, fast)))
      seen.push(await adapter.execute(ctxFor('switch', {}, fast), makeAction('power.toggle')).catch((err: Error) => err.message))
      seen.push(await adapter.readState!(ctxFor('switch', {}, fast)).catch((err: Error) => err.message))
      closeTuyaLinks()
    }
    for (const version of ['3.4', '3.5']) {
      addDevice({ version, key: OTHER_KEY, badKey: 'answers' })
      seen.push(await adapter.probe(ctxFor('switch', { version }, fast)))
      seen.push(await adapter.execute(ctxFor('switch', { version }, fast), makeAction('power.on')).catch((err: Error) => err.message))
      closeTuyaLinks()
    }
    const text = JSON.stringify(seen)
    expect(text).not.toContain(KEY)
    expect(text).not.toMatch(/HMAC|abab|cdcd|efef/)
  })
})

// ---------------------------------------------------------------------------
// On the wire: the real tuyapi library against a Tuya device on 127.0.0.1
// ---------------------------------------------------------------------------

interface WireDevice {
  port: number
  key: string
  version: '3.3' | '3.4' | '3.5'
  dps: Record<string, unknown>
  /** What the device does with a packet it cannot read (the client has the wrong key). */
  onBadKey: 'ignore' | 'hangup' | 'answer'
  /** Never answer a request (after the sign-in). */
  mute: boolean
  /** Send no status packet after a command. */
  quiet: boolean
  /** Close the socket as soon as a request arrives. */
  hangUpOnRequest: boolean
  /** Raw bytes sent instead of an answer to a query. */
  garbage: Buffer | null
  /** A "device22" model: answers a query with the text "json obj data unvalid" and gives values only when asked for them by name. */
  listsNothing: boolean
  live: number
  maxLive: number
  /** Every readable request: command number and decoded JSON body. */
  seen: Array<{ cmd: number; body: Record<string, unknown> }>
  close(): Promise<void>
}

const ecb = (key: Buffer | string, data: Buffer, encrypt: boolean, pad: boolean): Buffer => {
  const c = encrypt ? crypto.createCipheriv('aes-128-ecb', key, null) : crypto.createDecipheriv('aes-128-ecb', key, null)
  c.setAutoPadding(pad)
  return Buffer.concat([c.update(data), c.final()])
}
const hmac = (key: Buffer | string, data: Buffer): Buffer => crypto.createHmac('sha256', key).update(data).digest()
const versionHeader = (v: string): Buffer => Buffer.concat([Buffer.from(v), Buffer.alloc(12)])

/**
 * A Tuya device speaking the LAN protocol. Frames are laid out the way a
 * device sends them: 55AA frames carry a 4-byte return code and a CRC (3.3) or
 * an HMAC-SHA256 (3.4); 6699 frames are AES-GCM (3.5). 3.4 / 3.5 start with
 * the three-step session-key exchange.
 */
async function wireDevice(over: Partial<WireDevice> = {}): Promise<WireDevice> {
  const dev: WireDevice = {
    port: 0,
    key: KEY,
    version: '3.3',
    dps: { '1': true, '9': 0 },
    onBadKey: 'ignore',
    mute: false,
    quiet: false,
    hangUpOnRequest: false,
    garbage: null,
    listsNothing: false,
    live: 0,
    maxLive: 0,
    seen: [],
    close: async () => undefined,
    ...over,
  }
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    // One slot: a second client is turned away.
    if (dev.live >= 1) {
      socket.destroy()
      return
    }
    dev.live += 1
    dev.maxLive = Math.max(dev.maxLive, dev.live)
    sockets.add(socket)
    let session: Buffer | null = null
    let clientNonce = Buffer.alloc(16)
    const deviceNonce = crypto.randomBytes(16)
    const keyNow = (): Buffer => session ?? Buffer.from(dev.key)
    socket.on('error', () => undefined)
    socket.on('close', () => {
      sockets.delete(socket)
      dev.live -= 1
    })

    const send = (cmd: number, seq: number, body: Buffer, withVersionHeader: boolean, clearText = false): void => {
      if (dev.version === '3.3') {
        const payload = body.length === 0 || clearText ? body : withVersionHeader ? Buffer.concat([versionHeader('3.3'), ecb(keyNow(), body, true, true)]) : ecb(keyNow(), body, true, true)
        const buf = Buffer.alloc(payload.length + 28)
        buf.writeUInt32BE(0x000055aa, 0)
        buf.writeUInt32BE(seq, 4)
        buf.writeUInt32BE(cmd, 8)
        buf.writeUInt32BE(payload.length + 12, 12)
        buf.writeUInt32BE(0, 16) // return code
        payload.copy(buf, 20)
        buf.writeUInt32BE(zlib.crc32(buf.subarray(0, payload.length + 20)), payload.length + 20)
        buf.writeUInt32BE(0x0000aa55, payload.length + 24)
        socket.write(buf)
        return
      }
      const plain = body.length && withVersionHeader ? Buffer.concat([versionHeader(dev.version), body]) : body
      if (dev.version === '3.4') {
        const pad = 16 - (plain.length & 15)
        const enc = plain.length === 0 ? plain : ecb(keyNow(), Buffer.concat([plain, Buffer.alloc(pad, pad)]), true, false)
        const buf = Buffer.alloc(enc.length + 56)
        buf.writeUInt32BE(0x000055aa, 0)
        buf.writeUInt32BE(seq, 4)
        buf.writeUInt32BE(cmd, 8)
        buf.writeUInt32BE(enc.length + 40, 12)
        buf.writeUInt32BE(0, 16)
        enc.copy(buf, 20)
        hmac(keyNow(), buf.subarray(0, enc.length + 20)).copy(buf, enc.length + 20)
        buf.writeUInt32BE(0x0000aa55, enc.length + 52)
        socket.write(buf)
        return
      }
      const pt = Buffer.concat([Buffer.alloc(4), plain])
      const head = Buffer.alloc(18)
      head.writeUInt32BE(0x00006699, 0)
      head.writeUInt32BE(seq, 6)
      head.writeUInt32BE(cmd, 10)
      head.writeUInt32BE(pt.length + 28, 14)
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv('aes-128-gcm', keyNow(), iv)
      c.setAAD(head.subarray(4))
      const ct = Buffer.concat([c.update(pt), c.final()])
      socket.write(Buffer.concat([head, iv, ct, c.getAuthTag(), Buffer.from([0, 0, 0x99, 0x66])]))
    }

    /** Decode one frame from the client, or null when it does not check out with this device's key. */
    const open = (frame: Buffer): { cmd: number; seq: number; body: Buffer } | null => {
      try {
        if (dev.version === '3.5') {
          const d = crypto.createDecipheriv('aes-128-gcm', keyNow(), frame.subarray(18, 30))
          d.setAAD(frame.subarray(4, 18))
          d.setAuthTag(frame.subarray(frame.length - 20, frame.length - 4))
          let body = Buffer.concat([d.update(frame.subarray(30, frame.length - 20)), d.final()])
          if (body.subarray(0, 3).toString() === '3.5') body = body.subarray(15)
          return { cmd: frame.readUInt32BE(10), seq: frame.readUInt32BE(6), body }
        }
        const seq = frame.readUInt32BE(4)
        const cmd = frame.readUInt32BE(8)
        const len = frame.readUInt32BE(12)
        if (dev.version === '3.4') {
          const end = 16 + len - 36
          if (!hmac(keyNow(), frame.subarray(0, end)).equals(frame.subarray(end, end + 32))) return null
          let body = ecb(keyNow(), frame.subarray(16, end), false, false)
          body = body.subarray(0, body.length - (body[body.length - 1] ?? 0))
          if (body.subarray(0, 3).toString() === '3.4') body = body.subarray(15)
          return { cmd, seq, body }
        }
        let enc = frame.subarray(16, 16 + len - 8)
        if (enc.subarray(0, 3).toString() === '3.3') enc = enc.subarray(15)
        return { cmd, seq, body: ecb(keyNow(), enc, false, true) }
      } catch {
        return null
      }
    }

    const handle = (frame: Buffer): void => {
      const msg = open(frame)
      if (!msg) {
        if (dev.onBadKey === 'hangup') socket.destroy()
        // Answer with this device's own key: the client cannot read or verify it.
        else if (dev.onBadKey === 'answer') send(dev.version === '3.3' ? 10 : 4, frame.readUInt32BE(dev.version === '3.5' ? 6 : 4), Buffer.concat([deviceNonce, crypto.randomBytes(32)]), false)
        return
      }
      const { cmd, seq, body } = msg
      if (cmd === 3) {
        // Session key, step 1 -> 2: our nonce plus an HMAC of the client's.
        clientNonce = Buffer.from(body.subarray(0, 16))
        send(4, seq, Buffer.concat([deviceNonce, hmac(dev.key, clientNonce)]), false)
        return
      }
      if (cmd === 5) {
        const mixed = Buffer.alloc(16)
        for (let i = 0; i < 16; i++) mixed[i] = (clientNonce[i] ?? 0) ^ (deviceNonce[i] ?? 0)
        if (dev.version === '3.4') session = ecb(dev.key, mixed, true, false)
        else {
          const c = crypto.createCipheriv('aes-128-gcm', dev.key, clientNonce.subarray(0, 12))
          session = Buffer.concat([c.update(mixed), c.final()])
        }
        return
      }
      if (cmd === 9) {
        send(9, seq, Buffer.alloc(0), false)
        return
      }
      let json: Record<string, unknown> = {}
      try {
        json = JSON.parse(body.toString()) as Record<string, unknown>
      } catch {
        /* not JSON */
      }
      dev.seen.push({ cmd, body: json })
      if (dev.hangUpOnRequest) {
        socket.destroy()
        return
      }
      if (dev.mute) return
      if (cmd === 10 || cmd === 16) {
        // DP_QUERY (3.3) / DP_QUERY_NEW (3.4, 3.5)
        if (dev.garbage) socket.write(dev.garbage)
        else if (dev.listsNothing) send(cmd, seq, Buffer.from('json obj data unvalid'), false, true)
        else send(cmd, seq, Buffer.from(JSON.stringify({ dps: dev.dps })), false)
        return
      }
      if (cmd === 7 || cmd === 13) {
        // CONTROL (3.3) / CONTROL_NEW (3.4, 3.5)
        const wanted = ((dev.version === '3.3' ? json.dps : (json.data as { dps?: unknown } | undefined)?.dps) ?? {}) as Record<string, unknown>
        const changed: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(wanted)) {
          // A value asked for with null is reported back as it is.
          if (v === null) changed[k] = dev.dps[k]
          if (v === null || dev.dps[k] === v) continue
          dev.dps[k] = v
          changed[k] = v
        }
        send(cmd, seq, Buffer.alloc(0), false)
        // A device reports only what really changed; no change, no status packet.
        if (Object.keys(changed).length > 0 && !dev.quiet) {
          const t = Math.round(Date.now() / 1000)
          send(8, 0, Buffer.from(JSON.stringify(dev.version === '3.3' ? { dps: changed, t } : { protocol: 4, t, data: { dps: changed } })), true)
        }
      }
    }

    let pending = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        const a = pending.indexOf(Buffer.from([0, 0, 0xaa, 0x55]))
        const b = pending.indexOf(Buffer.from([0, 0, 0x99, 0x66]))
        const end = a === -1 ? b : b === -1 ? a : Math.min(a, b)
        if (end === -1) return
        const frame = pending.subarray(0, end + 4)
        pending = pending.subarray(end + 4)
        handle(frame)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  dev.port = (server.address() as net.AddressInfo).port
  dev.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    })
  return dev
}

describe('tuya-local: on the wire, through the real tuyapi library', () => {
  const made: WireDevice[] = []
  const uncaught: unknown[] = []
  const onUncaught = (err: unknown) => uncaught.push(err)

  async function device(over: Partial<WireDevice> = {}): Promise<WireDevice> {
    const dev = await wireDevice(over)
    made.push(dev)
    return dev
  }

  const wireCtx = (dev: WireDevice, kind: DeviceKind, config: Record<string, unknown> = {}, timeoutMs = 3000): TestCtx =>
    makeCtx({ family: 'tuya-local', kind, config: { deviceId: ID, localKey: KEY, version: dev.version, ...config }, path: { host: '127.0.0.1', port: dev.port }, timeoutMs })

  /** The data points of every command the device received. */
  const commands = (dev: WireDevice) =>
    dev.seen.filter((m) => m.cmd === 7 || m.cmd === 13).map((m) => (dev.version === '3.3' ? m.body.dps : (m.body.data as { dps?: unknown }).dps))

  beforeEach(() => {
    world.real = true
    uncaught.length = 0
    process.on('uncaughtException', onUncaught)
  })

  afterEach(async () => {
    closeTuyaLinks()
    await Promise.all(made.splice(0).map((d) => d.close()))
    process.off('uncaughtException', onUncaught)
    expect(uncaught).toEqual([])
  })

  for (const version of ['3.3', '3.4', '3.5'] as const) {
    const query = version === '3.3' ? 10 : 16
    const control = version === '3.3' ? 7 : 13

    it(`${version}: checks, reads and switches a switch`, async () => {
      const dev = await device({ version })
      const ctx = wireCtx(dev, 'switch')
      expect(await adapter.probe(ctx)).toMatchObject({ ok: true, info: { power: true, serial: ID } })
      expect(await adapter.readState!(ctx)).toEqual({ power: true })
      expect(await adapter.execute(ctx, makeAction('power.off'))).toEqual({ ok: true, state: { power: false } })
      expect(dev.dps['1']).toBe(false)
      // Already off: nothing is sent, because the device would not answer.
      expect(await adapter.execute(ctx, makeAction('power.off'))).toEqual({ ok: true, state: { power: false }, result: { unchanged: true } })
      expect(await adapter.execute(ctx, makeAction('power.toggle'))).toEqual({ ok: true, state: { power: true } })
      expect(dev.dps['1']).toBe(true)
      // One query for check + state, then query-and-command per change; all on one connection.
      expect(dev.seen.map((m) => m.cmd)).toEqual([query, query, control, query, query, control])
      expect(commands(dev)).toEqual([{ '1': false }, { '1': true }])
      expect(dev.seen[0]?.body).toMatchObject({ gwId: ID, devId: ID })
      expect(dev.maxLive).toBe(1)
    })

    it(`${version}: dims a bulb with one command for on + brightness`, async () => {
      const dev = await device({ version, dps: { '20': false, '21': 'white', '22': 10, '23': 500 } })
      const ctx = wireCtx(dev, 'light', { dimmer: true })
      expect(await adapter.execute(ctx, makeAction('dim.set', { brightness: 50 }))).toEqual({ ok: true, state: { power: true, brightness: 50 } })
      expect(await adapter.execute(ctx, makeAction('dim.set', { brightness: 30 }))).toEqual({ ok: true, state: { power: true, brightness: 30 } })
      expect(await adapter.readState!(ctx)).toEqual({ power: true, brightness: 30 })
      expect(commands(dev)).toEqual([{ '20': true, '22': 500 }, { '22': 300 }])
      expect(dev.dps).toEqual({ '20': true, '21': 'white', '22': 300, '23': 500 })
    })

    it(`${version}: presses a gate button`, async () => {
      const dev = await device({ version, dps: { '1': false, '9': 0 } })
      const res = await adapter.execute(wireCtx(dev, 'gate', { pulseMs: 120 }), makeAction('gate.open'))
      expect(res).toEqual({ ok: true, result: { pressedMs: 120 }, state: { gate: 'unknown' } })
      expect(commands(dev)).toEqual([{ '1': true }, { '1': false }])
      expect(dev.dps['1']).toBe(false)
    })

    it(`${version}: wrong key, device stays silent`, async () => {
      const dev = await device({ version, key: OTHER_KEY, onBadKey: 'ignore' })
      const res = await adapter.probe(wireCtx(dev, 'switch', {}, 300))
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(version === '3.3' ? /took the connection but did not answer/ : /did not finish the secure sign-in/)
      expect(res.error).toMatch(/local key or protocol version may be wrong/)
      await tick(50)
      expect(dev.live).toBe(0)
    })

    it(`${version}: wrong key, device hangs up`, async () => {
      const dev = await device({ version, key: OTHER_KEY, onBadKey: 'hangup' })
      const started = Date.now()
      const res = await adapter.probe(wireCtx(dev, 'switch'))
      expect(Date.now() - started).toBeLessThan(1500)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(version === '3.3' ? /closed the connection without answering/ : /closed it during the secure sign-in/)
    })

    it(`${version}: wrong key, device answers with something the hub cannot read`, async () => {
      const dev = await device({ version, key: OTHER_KEY, onBadKey: 'answer' })
      const ctx = wireCtx(dev, 'switch')
      const started = Date.now()
      const res = await adapter.probe(ctx)
      expect(Date.now() - started).toBeLessThan(1500)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(version === '3.3' ? /could not read the reply. The local key or the protocol version is not right/ : /did not accept the local key/)
      // A refusal, not a transport failure: returned, so the hub does not go looking for another connection.
      const acted = await adapter.execute(ctx, makeAction('power.on'))
      expect(acted.ok).toBe(false)
      expect(JSON.stringify([res, acted])).not.toContain(KEY)
      await tick(50)
      expect(dev.live).toBe(0)
    })

    it(`${version}: a device that never answers a request`, async () => {
      const dev = await device({ version, mute: true })
      const res = await adapter.probe(wireCtx(dev, 'switch', {}, 300))
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/took the connection but did not answer/)
      await tick(50)
      expect(dev.live).toBe(0)
    })

    it(`${version}: a device that closes the connection when asked`, async () => {
      const dev = await device({ version, hangUpOnRequest: true })
      const ctx = wireCtx(dev, 'switch')
      const started = Date.now()
      expect((await adapter.probe(ctx)).error).toMatch(/closed the connection without answering/)
      await expect(adapter.execute(ctx, makeAction('power.on'))).rejects.toThrow(/closed the connection without answering/)
      expect(Date.now() - started).toBeLessThan(1500)
    })
  }

  it('3.3: checks the device itself when it changes without sending a status', async () => {
    const dev = await device({ quiet: true })
    const res = await adapter.execute(wireCtx(dev, 'switch'), makeAction('power.off'))
    expect(res).toEqual({ ok: true, state: { power: false } })
    expect(dev.seen.map((m) => m.cmd)).toEqual([10, 7, 10])
    expect(dev.maxLive).toBe(1)
  })

  it('3.3: a model that cannot list its values is read and switched by naming the on/off value', async () => {
    const dev = await device({ listsNothing: true, dps: { '20': true, '21': 'white', '22': 500 } })
    const ctx = wireCtx(dev, 'light')
    expect(await adapter.readState!(ctx)).toEqual({ power: true })
    // tuyapi's fallback: a command naming data point 20 with no value.
    expect(dev.seen.map((m) => m.cmd)).toEqual([10, 7])
    expect(commands(dev)).toEqual([{ '20': null }])
    expect(await adapter.execute(ctx, makeAction('power.off'))).toEqual({ ok: true, state: { power: false } })
    expect(dev.dps['20']).toBe(false)
  })

  it('3.3: a web page (or any other garbage) instead of an answer is reported as unreadable', async () => {
    const dev = await device({ garbage: Buffer.from('HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\n\r\n<html><body>Bad Request</body></html>') })
    const res = await adapter.probe(wireCtx(dev, 'switch', {}, 300))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/answered, but the hub could not read the reply/)
    expect(res.error).not.toMatch(/html|HTTP/i)
  })

  it('3.3: another app holding the only connection', async () => {
    const dev = await device()
    dev.live = 1 // Smart Life on the same WiFi
    const started = Date.now()
    const res = await adapter.probe(wireCtx(dev, 'switch'))
    dev.live = 0
    expect(Date.now() - started).toBeLessThan(1500)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/closed the connection/)
    expect(res.error).toMatch(/another app/i)
  })

  it('nothing listening at the address', async () => {
    const dev = await device()
    await dev.close()
    const ctx = wireCtx(dev, 'switch')
    const res = await adapter.probe(ctx)
    expect(res).toMatchObject({ ok: false, latencyMs: null })
    expect(res.error).toMatch(/127\.0\.0\.1:\d+ refused the connection/)
    await expect(adapter.execute(ctx, makeAction('power.on'))).rejects.toThrow(/refused the connection/)
  })
})
