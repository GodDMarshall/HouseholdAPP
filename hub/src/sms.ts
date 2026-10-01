import type { HubStatus } from '@house/shared'
import type { SmsOutcome } from './adapters/types.ts'
import type { Logger } from './lib/log.ts'

/**
 * SMS out of the hub. Two transports:
 *  - a USB GSM modem on a serial port (AT commands, text mode) — fully automatic;
 *  - no modem: the hub hands the phone an sms: link with the text pre-filled and
 *    the action waits for the owner to confirm it was sent.
 */
export class SmsTransport {
  status: HubStatus['sms'] = { modem: 'disabled', port: null, detail: null }
  private modem: Modem | null = null

  constructor(
    private readonly portName: string | null,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    if (!this.portName) {
      this.status = { modem: 'disabled', port: null, detail: 'The hub has no GSM modem, so text commands are handed to your phone to send with one tap.' }
      return
    }
    try {
      this.modem = await Modem.open(this.portName, this.log.child('modem'))
      this.status = { modem: 'connected', port: this.portName, detail: this.modem.identity }
      this.log.info(`GSM modem ready on ${this.portName}`, { identity: this.modem.identity })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.status = {
        modem: /Cannot find module|serialport/i.test(detail) ? 'missing' : 'error',
        port: this.portName,
        detail: `The GSM modem on ${this.portName} is not answering, so text commands are handed to your phone instead.`,
      }
      this.log.warn(`GSM modem unavailable on ${this.portName}: ${detail}`)
    }
  }

  async stop(): Promise<void> {
    await this.modem?.close()
    this.modem = null
  }

  async send(to: string, text: string): Promise<SmsOutcome> {
    const number = normaliseNumber(to)
    if (!number) return { sent: false, error: 'No phone number on this path' }
    if (!text.trim()) return { sent: false, error: 'Empty message' }
    if (this.modem) {
      try {
        await this.modem.sendText(number, text)
        return { sent: true }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        this.log.warn(`SMS to ${number} failed: ${error}`)
        return { sent: false, error, handoff: handoffLink(number, text) }
      }
    }
    return { sent: false, handoff: handoffLink(number, text) }
  }
}

/** sms: link for the phone. Android wants "?body=", iOS wants "&body=" — the app fixes that up. */
export function handoffLink(number: string, text: string): string {
  return `sms:${number}?body=${encodeURIComponent(text)}`
}

export function normaliseNumber(raw: string): string {
  const s = raw.replace(/[\s()-]/g, '')
  if (!s) return ''
  if (s.startsWith('+')) return s
  if (/^\d{10}$/.test(s)) return '+91' + s
  if (/^0\d{10}$/.test(s)) return '+91' + s.slice(1)
  return s
}

// ---------------------------------------------------------------------------
// AT-command modem over serialport (optional dependency)
// ---------------------------------------------------------------------------

interface SerialLike {
  write(data: string, cb?: (err?: Error | null) => void): void
  on(event: 'data', cb: (chunk: Buffer) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  close(cb?: (err?: Error | null) => void): void
}

interface Waiter {
  expectPrompt: boolean
  lines: string[]
  done: (lines: string[]) => void
  fail: (err: Error) => void
}

class Modem {
  identity = ''
  private buffer = ''
  private waiters: Waiter[] = []
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly port: SerialLike,
    private readonly log: Logger,
  ) {
    port.on('data', (chunk) => this.onData(chunk.toString('latin1')))
    port.on('error', (err) => log.error('serial error', err))
  }

  static async open(path: string, log: Logger): Promise<Modem> {
    const mod = (await import('serialport')) as { SerialPort: new (opts: { path: string; baudRate: number }) => SerialLike & { on(e: 'open', cb: () => void): void } }
    const port = new mod.SerialPort({ path, baudRate: 115200 })
    await new Promise<void>((resolve, reject) => {
      port.on('open', () => resolve())
      port.on('error', reject)
    })
    const modem = new Modem(port, log)
    await modem.command('AT')
    await modem.command('ATE0')
    await modem.command('AT+CMGF=1') // text mode
    const id = await modem.command('ATI').catch(() => [] as string[])
    modem.identity = id.filter((l) => l && l !== 'OK').join(' / ').slice(0, 120)
    return modem
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.port.close(() => resolve()))
  }

  /** Serialised: one AT exchange at a time. */
  command(cmd: string, timeoutMs = 10000, expectPrompt = false): Promise<string[]> {
    const run = () =>
      new Promise<string[]>((resolve, reject) => {
        const waiter: Waiter = { expectPrompt, lines: [], done: () => undefined, fail: () => undefined }
        const t = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter)
          reject(new Error(`Modem did not answer "${cmd.slice(0, 20)}" within ${timeoutMs} ms`))
        }, timeoutMs)
        waiter.done = (lines) => {
          clearTimeout(t)
          resolve(lines)
        }
        waiter.fail = (err) => {
          clearTimeout(t)
          reject(err)
        }
        this.waiters.push(waiter)
        this.port.write(cmd + '\r', (err) => {
          if (err) waiter.fail(err)
        })
      })
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  async sendText(number: string, text: string): Promise<void> {
    await this.command(`AT+CMGS="${number}"`, 10000, true)
    const body = text.replace(/\x1a/g, '') + '\x1a'
    const lines = await this.command(body, 60000)
    if (!lines.some((l) => l.startsWith('+CMGS'))) throw new Error('Modem did not confirm the message (+CMGS missing)')
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    const waiter = this.waiters[0]
    if (!waiter) {
      this.buffer = ''
      return
    }
    if (waiter.expectPrompt && this.buffer.includes('>')) {
      this.buffer = ''
      this.waiters.shift()
      waiter.done([])
      return
    }
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r/g, '').trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      waiter.lines.push(line)
      if (line === 'OK') {
        this.waiters.shift()
        waiter.done(waiter.lines)
        return
      }
      if (line === 'ERROR' || line.startsWith('+CMS ERROR') || line.startsWith('+CME ERROR')) {
        this.waiters.shift()
        waiter.fail(new Error(`Modem answered ${line}`))
        return
      }
    }
  }
}
