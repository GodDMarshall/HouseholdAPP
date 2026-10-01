import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { HubStatus } from '@house/shared'
import type { Snapshot } from './adapters/types.ts'
import type { Config } from './config.ts'
import type { DeviceManager } from './devices.ts'
import type { Bus } from './events.ts'
import { request, sleep } from './lib/http.ts'
import type { Logger } from './lib/log.ts'
import type { Registry } from './registry.ts'

export interface VideoDeps {
  config: Config
  registry: Registry
  devices: DeviceManager
  bus: Bus
  log: Logger
}

/**
 * Runs go2rtc as a sidecar and keeps its stream list in step with the registry:
 * one stream per camera, sourced from whichever connection path is live. The
 * app never sees camera credentials — it asks the hub for stream "dev_xxx".
 */
export class VideoManager {
  status: HubStatus['video'] = { go2rtc: 'missing', version: null, detail: null }
  readonly port: number
  private child: ChildProcess | null = null
  private restarts = 0
  private stopping = false
  private syncTimer: NodeJS.Timeout | null = null
  private known = new Map<string, string[]>()
  private readonly log: Logger

  constructor(private readonly deps: VideoDeps) {
    this.port = deps.config.go2rtcPort
    this.log = deps.log.child('video')
  }

  /** go2rtc's HTTP API: an existing instance (HC_GO2RTC_URL) or the sidecar this hub runs. */
  get base(): string {
    return this.deps.config.go2rtcUrl ?? `http://127.0.0.1:${this.port}`
  }

  get wsBase(): string {
    return this.base.replace(/^http/, 'ws')
  }

  private watch(): void {
    this.deps.bus.on('device.state', () => this.scheduleSync())
    this.deps.bus.on('device.upsert', () => this.scheduleSync())
    this.deps.bus.on('device.remove', () => this.scheduleSync())
  }

  async start(): Promise<void> {
    if (this.deps.config.go2rtcUrl) {
      // Someone else runs go2rtc (a service, Docker, another box): just use it.
      this.watch()
      try {
        const res = await request(`${this.base}/api`, { timeoutMs: 3000 })
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
        let version: string | null = null
        try {
          version = String((res.json() as { version?: string }).version ?? '') || null
        } catch {
          version = null
        }
        this.status = { go2rtc: 'running', version, detail: null }
        await this.syncStreams()
      } catch (err) {
        this.status = { go2rtc: 'error', version: null, detail: 'The live video service is not answering. Cameras show still pictures until it is back.' }
        this.log.warn(`go2rtc at ${this.base} is not answering: ${err instanceof Error ? err.message : err}`)
      }
      return
    }
    const bin = this.deps.config.go2rtcBin
    if (!fs.existsSync(bin)) {
      const how = process.platform === 'win32' ? 'Run scripts\\get-go2rtc.ps1 once' : 'Run scripts/pi/setup.sh once'
      this.status = {
        go2rtc: 'missing',
        version: null,
        detail: `Live video is not installed yet. ${how}, then restart the hub. Until then cameras show still pictures.`,
      }
      this.log.warn(`go2rtc not found at ${bin}. ${this.status.detail}`)
      return
    }
    this.writeConfig()
    this.watch()
    await this.launch()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.syncTimer) clearTimeout(this.syncTimer)
    if (this.child && !this.child.killed) {
      this.child.kill()
      await sleep(200)
    }
    this.child = null
  }

  private configFile(): string {
    return path.join(this.deps.config.dataDir, 'go2rtc.yaml')
  }

  private writeConfig(): void {
    const yaml = [
      '# Written by House Control. Streams are added at runtime through the go2rtc API.',
      'api:',
      `  listen: "127.0.0.1:${this.port}"`,
      'rtsp:',
      '  listen: "127.0.0.1:8554"',
      'webrtc:',
      '  listen: ":8555"',
      'log:',
      '  level: "warn"',
      'streams: {}',
      '',
    ].join('\n')
    fs.mkdirSync(this.deps.config.dataDir, { recursive: true })
    fs.writeFileSync(this.configFile(), yaml)
  }

  private async launch(): Promise<void> {
    const bin = this.deps.config.go2rtcBin
    this.log.info(`Starting go2rtc (${bin}) on 127.0.0.1:${this.port}`)
    const child = spawn(bin, ['-config', this.configFile()], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    child.stdout?.on('data', (d: Buffer) => this.log.debug(d.toString().trim()))
    child.stderr?.on('data', (d: Buffer) => this.log.debug(d.toString().trim()))
    child.on('exit', (code, signal) => {
      if (this.stopping) {
        this.status = { ...this.status, go2rtc: 'stopped' }
        return
      }
      this.status = { go2rtc: 'error', version: this.status.version, detail: `go2rtc exited (${code ?? signal}). Restarting…` }
      this.log.warn(this.status.detail!)
      this.restarts += 1
      if (this.restarts <= 5) setTimeout(() => void this.launch(), 2000 * this.restarts).unref?.()
      else this.status = { go2rtc: 'error', version: this.status.version, detail: 'go2rtc keeps crashing; check hub/bin and the log' }
    })
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      try {
        const res = await request(`${this.base}/api`, { timeoutMs: 1000 })
        if (res.status === 200) {
          let version: string | null = null
          try {
            version = String((res.json() as { version?: string }).version ?? '') || null
          } catch {
            version = null
          }
          this.status = { go2rtc: 'running', version, detail: null }
          this.restarts = 0
          this.known.clear()
          this.log.info(`go2rtc ready${version ? ' v' + version : ''}`)
          await this.syncStreams()
          return
        }
      } catch {
        /* not up yet */
      }
    }
    this.status = { go2rtc: 'error', version: null, detail: 'go2rtc started but its API did not answer' }
    this.log.warn(this.status.detail!)
  }

  private scheduleSync(): void {
    if (this.status.go2rtc !== 'running') return
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => void this.syncStreams().catch((err) => this.log.warn('stream sync failed', err instanceof Error ? err.message : err)), 500)
    this.syncTimer.unref?.()
  }

  /** One go2rtc stream per camera, sourced from its live path. */
  async syncStreams(): Promise<void> {
    if (this.status.go2rtc !== 'running') return
    const desired = new Map<string, string[]>()
    for (const device of this.deps.registry.listDevices()) {
      if (!device.capabilities.includes('stream')) continue
      const adapter = this.deps.devices.adapterFor(device)
      if (!adapter.streamSources) continue
      const live = this.deps.devices.activePath(device.id)
      if (!live || live.kind === 'sms') continue
      try {
        const sources = adapter.streamSources(this.deps.devices.context(this.deps.devices.unmasked(device.id), live))
        if (sources.length) desired.set(device.id, sources)
      } catch (err) {
        this.log.debug(`${device.name}: no stream sources`, err instanceof Error ? err.message : err)
      }
    }
    for (const [name, sources] of desired) {
      const prev = this.known.get(name)
      if (prev && prev.join('|') === sources.join('|')) continue
      const qs = sources.map((s) => `src=${encodeURIComponent(s)}`).join('&')
      const res = await request(`${this.base}/api/streams?name=${encodeURIComponent(name)}&${qs}`, { method: 'PUT', timeoutMs: 3000 })
      if (res.status >= 200 && res.status < 300) this.known.set(name, sources)
      else this.log.warn(`go2rtc refused stream ${name}: HTTP ${res.status} ${res.text().slice(0, 200)}`)
    }
    for (const name of [...this.known.keys()]) {
      if (desired.has(name)) continue
      await request(`${this.base}/api/streams?src=${encodeURIComponent(name)}`, { method: 'DELETE', timeoutMs: 3000 }).catch(() => undefined)
      this.known.delete(name)
    }
  }

  hasStream(deviceId: string): boolean {
    return this.status.go2rtc === 'running' && this.known.has(deviceId)
  }

  async snapshot(deviceId: string): Promise<Snapshot | null> {
    if (!this.hasStream(deviceId)) return null
    try {
      const res = await request(`${this.base}/api/frame.jpeg?src=${encodeURIComponent(deviceId)}`, { timeoutMs: 8000 })
      if (res.status !== 200 || res.body.length === 0) return null
      return { contentType: res.headers['content-type'] ?? 'image/jpeg', body: res.body }
    } catch {
      return null
    }
  }
}
