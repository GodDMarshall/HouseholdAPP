/**
 * GSM gate opener / GSM relay box — a small box with its own SIM and one relay,
 * commanded by text message and (where the box supports it) opened by a phone
 * call from a number it knows, which it rejects on the first ring.
 *
 * The same-looking boxes ship with different text dialects, so the owner picks
 * the one whose leaflet examples match:
 *   king-pigeon  RTU5024 (King Pigeon):      1234CC / 1234DD / 1234EE
 *   pwd-hash     "pwd#CMD#", 200/999 users:  1234#ON# / 1234#OFF# / 1234#CSQ?
 *   pwd-hash-64  "pwd#CMD#", 64 users:       no relay text at all, call only
 *   gainwise     Gainwise / First Fence:     *71*5678# / *72*5678# / *73*5678# / *24*1234#
 *   wafer        WAFER GSM-KEY:              no confirmed relay text, call only; #PWD123456#STATUS?
 *   custom       the owner types every text
 *
 * Everything leaves through ctx.sms(): the hub's modem sends it, or the phone
 * is handed an sms: link. The box cannot be read back, so no gate state is ever
 * reported from here.
 */
import type { Action, Capability, DeviceKind, FamilyDescriptor, FieldSpec } from '@house/shared'
import { normaliseNumber } from '../sms.ts'
import { unsupported, type ActionResult, type Adapter, type AdapterContext, type ProbeResult } from './types.ts'

export type GsmBoxType = 'king-pigeon' | 'pwd-hash' | 'pwd-hash-64' | 'gainwise' | 'wafer' | 'custom'

interface AuthoriseInput {
  /** 10-digit Indian mobile number, or null when the number given is not one. */
  india: string | null
  /** The digits exactly as given. */
  digits: string
  slot: number
}

export interface GsmBox {
  label: string
  /** Factory password, used as {pwd} until the owner stores another. */
  password: string
  /** Factory programming password ({admin}); only the Gainwise type has a second one. */
  adminPassword: string
  /** One timed press of the relay. */
  press: string
  /** Relay on / held. */
  on: string
  /** Relay off / released. */
  off: string
  status: string
  /** True when the box has no text for its relay and is worked by phone call only. */
  callOnly: boolean
  /** How many numbers the box stores (0 = no helper for storing a number). */
  slots: number
  /** True when each stored number goes into a numbered place, so storing one can overwrite another. */
  numberedPlaces: boolean
  /** Longest text the box takes (the *71* leaflet says 140; the others take a full 160-character SMS). */
  maxChars: number
  authorise(n: AuthoriseInput): string | null
}

const pad = (n: number, width: number) => String(n).padStart(width, '0')

/** Text dialects, exactly as the protocol notes give them (docs/protocols/gate-control.md). */
export const GSM_BOXES: Record<GsmBoxType, GsmBox> = {
  'king-pigeon': {
    label: 'RTU5024 type (texts like 1234CC)',
    password: '1234',
    adminPassword: '',
    press: '{pwd}CC',
    on: '{pwd}CC',
    off: '{pwd}DD',
    status: '{pwd}EE',
    callOnly: false,
    slots: 200,
    numberedPlaces: true,
    maxChars: 160,
    authorise: (n) => (n.india ? `{pwd}A${pad(n.slot, 3)}#91${n.india}#` : null),
  },
  'pwd-hash': {
    label: 'Texts like 1234#ON# (boxes for 200 or 999 numbers)',
    password: '1234',
    adminPassword: '',
    press: '{pwd}#ON#',
    on: '{pwd}#ON#',
    off: '{pwd}#OFF#',
    status: '{pwd}#CSQ?',
    callOnly: false,
    slots: 999,
    numberedPlaces: true,
    maxChars: 160,
    authorise: (n) => (n.india ? `{pwd}#TEL0091${n.india}#${pad(n.slot, 3)}#` : null),
  },
  'pwd-hash-64': {
    label: 'Texts like 1234#TEL…#01# (64-number box, opens by phone call only)',
    password: '1234',
    adminPassword: '',
    press: '',
    on: '',
    off: '',
    status: '{pwd}#CSQ?',
    callOnly: true,
    slots: 64,
    numberedPlaces: true,
    maxChars: 160,
    authorise: (n) => (n.india ? `{pwd}#TEL91${n.india}#${pad(n.slot, 2)}#` : null),
  },
  gainwise: {
    label: 'Texts like *71*5678# (Gainwise / First Fence type)',
    password: '5678',
    adminPassword: '1234',
    press: '*71*{pwd}#',
    on: '*72*{pwd}#',
    off: '*73*{pwd}#',
    status: '*24*{admin}#',
    callOnly: false,
    slots: 100,
    numberedPlaces: false,
    maxChars: 140,
    // Leaflet: "71[country code]#" then "721[phone number]#": 721 is the whole command code, the number follows it.
    authorise: (n) => (n.india ? `*12*{admin}#7191#721${n.india}#` : null),
  },
  wafer: {
    label: 'WAFER GSM-KEY (opens by phone call only)',
    password: '123456',
    adminPassword: '',
    press: '',
    on: '',
    off: '',
    status: '#PWD{pwd}#STATUS?',
    callOnly: true,
    slots: 200,
    numberedPlaces: true,
    maxChars: 160,
    authorise: (n) => (n.digits ? `#PWD{pwd}#WHL${pad(n.slot, 3)}=${n.digits}` : null),
  },
  custom: {
    label: 'Another box — I will type its texts',
    password: '',
    adminPassword: '',
    press: '',
    on: '',
    off: '',
    status: '',
    callOnly: false,
    slots: 0,
    numberedPlaces: false,
    maxChars: 160,
    authorise: () => null,
  },
}

const BOX_TYPES = Object.keys(GSM_BOXES) as GsmBoxType[]
const DEFAULT_BOX: GsmBoxType = 'king-pigeon'

/** A second identical command this soon is almost always a double tap, and can make the relay let go early. */
const REPEAT_GUARD_MS = 5000
/** A text still with the modem counts as "on its way" for at most this long (the modem itself gives up after about 70 s). */
const PENDING_MAX_MS = 90_000

/** Guard key for a phone call; it has a line break in it, so no text command can ever equal it. */
const CALL_KEY = '\ncall'

const SEND_LABEL = 'Send the text'
const CALL_LABEL = 'Call the gate'

// The box cannot be read back, so these two are only "what was recently asked for".
interface Sent {
  key: string
  at: number
  /** Handed to the hub's SMS transport, which has not answered yet. */
  pending: boolean
}
/** Per box: the commands still on their way to the modem, and the last one that went out, by exact text. */
const recent = new Map<string, Map<string, Sent>>()
const lastPower = new Map<string, boolean>()

/** Test hook: forget the recent commands and the last on/off asked of every box. */
export function resetGsmSmsMemory(): void {
  recent.clear()
  lastPower.clear()
}

const live = (m: Sent, now: number) => now - m.at < (m.pending ? PENDING_MAX_MS : REPEAT_GUARD_MS)

function remember(deviceId: string, mark: Sent): void {
  const now = Date.now()
  let marks = recent.get(deviceId)
  if (!marks) recent.set(deviceId, (marks = new Map()))
  // A different command in between (on, off, on) ends the double-tap guard for the finished ones;
  // a text the modem still holds stays guarded until the modem has answered.
  for (const [key, m] of marks) if (!m.pending || !live(m, now)) marks.delete(key)
  marks.set(mark.key, mark)
}

function forget(deviceId: string, mark: Sent): void {
  const marks = recent.get(deviceId)
  if (marks?.get(mark.key) === mark) marks.delete(mark.key)
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Setup {
  type: GsmBoxType
  box: GsmBox
  pwd: string
  admin: string
  hold: boolean
  call: boolean
  texts: { open: string; close: string; stop: string; pulse: string; status: string; on: string; off: string }
}

function boxTypeOf(value: unknown): GsmBoxType {
  const s = String(value ?? '').trim()
  return (BOX_TYPES as string[]).includes(s) ? (s as GsmBoxType) : DEFAULT_BOX
}

function setupOf(ctx: AdapterContext): Setup {
  const type = boxTypeOf(ctx.device.config.boxType)
  const box = GSM_BOXES[type]
  const typed = (name: string) => ctx.str(name, '').trim()
  const hold = ctx.str('gateWiring', 'step').trim() === 'hold'
  return {
    type,
    box,
    pwd: (ctx.secret('password') ?? '').trim() || box.password,
    admin: (ctx.secret('adminPassword') ?? '').trim() || box.adminPassword,
    hold,
    call: ctx.bool('callToOpen', false) || box.callOnly,
    texts:
      type === 'custom'
        ? {
            open: typed('openText'),
            close: typed('closeText'),
            stop: typed('stopText'),
            pulse: typed('pulseText'),
            status: typed('statusText'),
            on: typed('onText'),
            off: typed('offText'),
          }
        : {
            open: hold ? box.on : box.press,
            close: hold ? box.off : box.press,
            stop: '',
            pulse: box.press,
            status: box.status,
            on: box.on,
            off: box.off,
          },
  }
}

/** The number of the SIM inside the box, from the path in use. */
function boxNumber(ctx: AdapterContext): { number: string } | { error: string } {
  if (ctx.path.kind !== 'sms') {
    return { error: 'This box is worked by text message. Add an SMS connection with the phone number of the SIM inside it.' }
  }
  const raw = (ctx.path.host ?? '').trim()
  if (!raw) return { error: `No phone number set on the "${ctx.path.label}" connection. Enter the number of the SIM inside the box.` }
  const number = tidyNumber(raw)
  if (!/^\+?\d{5,15}$/.test(number)) return { error: `"${raw}" on the "${ctx.path.label}" connection does not look like a phone number` }
  return { number }
}

/**
 * The hub's own tidy-up (10 digits -> +91...), plus the two other ways an Indian
 * mobile gets typed: "91 98765 43210" and "0091 98765 43210". Without the + a
 * modem or a phone dials those twelve digits as a local number and nothing arrives.
 */
function tidyNumber(raw: string): string {
  const n = normaliseNumber(raw.replace(/\./g, ''))
  if (/^00\d{7,15}$/.test(n)) return '+' + n.slice(2)
  if (/^91[6-9]\d{9}$/.test(n)) return '+' + n
  return n
}

/** Put the passwords into a template. */
function fill(template: string, setup: Setup): { text: string } | { error: string } {
  let text = template.trim()
  if (!text) return { error: 'There is nothing to send' }
  // A mistyped {password} or a stray bracket would reach the box as it stands, and most boxes say nothing back.
  if (/[{}]/.test(text.replace(/\{(pwd|admin)\}/gi, ''))) {
    return { error: 'Only {pwd} and {admin} can go in curly brackets. Check the brackets in this text.' }
  }
  if (/\{pwd\}/i.test(text)) {
    if (!setup.pwd) return { error: 'This text needs the box password, but none is saved for this box' }
    const pwd = setup.pwd
    // A function, so a "$" in a password is not read as a replacement pattern.
    text = text.replace(/\{pwd\}/gi, () => pwd)
  }
  if (/\{admin\}/i.test(text)) {
    if (!setup.admin) return { error: 'This text needs the programming password, but none is saved for this box' }
    const admin = setup.admin
    text = text.replace(/\{admin\}/gi, () => admin)
  }
  // The modem sends in plain text mode: a line break, an Esc or a non-English letter would be cut, cancelled or garbled.
  if (!/^[\x20-\x7e]+$/.test(text)) {
    return { error: 'These boxes only read plain English letters, digits and symbols on one line. Take out the line break or special character.' }
  }
  const max = setup.box.maxChars
  if (text.length > max) return { error: `That text is ${text.length} characters long; this box takes ${max} in one text message` }
  return { text }
}

/** Keep passwords and the command itself out of anything that is shown or logged. */
function scrub(message: string, secrets: string[]): string {
  let out = message
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join('***')
  return out
}

const TOO_SOON = 'The same command went out a moment ago. Wait a few seconds before sending it again.'
const STILL_SENDING = 'The same command is still on its way to the box. Wait for it to finish before sending it again.'

/** Why this command must not go out right now, or null when it may. */
function blocked(deviceId: string, key: string): string | null {
  const last = recent.get(deviceId)?.get(key)
  if (!last || !live(last, Date.now())) return null
  return last.pending ? STILL_SENDING : TOO_SOON
}

function noText(what: string, setup: Setup): ActionResult {
  if (setup.type === 'custom') return { ok: false, error: `No text is saved for ${what}. Type it in this device’s settings.` }
  if (what === 'stopping') {
    return {
      ok: false,
      error: 'This kind of box has no text for stopping. On a gate with one button input, sending Open again while it moves usually stops it.',
    }
  }
  if (setup.box.callOnly) return { ok: false, error: `This kind of box has no text for ${what}; it is worked by phone call only.` }
  return { ok: false, error: `This kind of box has no text for ${what}.` }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function sendText(ctx: AdapterContext, setup: Setup, template: string): Promise<ActionResult> {
  const to = boxNumber(ctx)
  if ('error' in to) return { ok: false, error: to.error }
  const filled = fill(template, setup)
  if ('error' in filled) return { ok: false, error: filled.error }
  const text = filled.text
  const id = ctx.device.id
  const wait = blocked(id, text)
  if (wait) return { ok: false, error: wait }

  // Marked before the modem answers: a slow modem can outlast the hub's own
  // time limit, and a second tap then must not put the same text out twice.
  const mark: Sent = { key: text, at: Date.now(), pending: true }
  remember(id, mark)
  const secrets = [text, setup.pwd, setup.admin]

  let out: Awaited<ReturnType<AdapterContext['sms']>>
  try {
    out = await ctx.sms(to.number, text)
  } catch (err) {
    forget(id, mark)
    // Thrown on, so the hub can try another connection, but never with the command or a password in it.
    throw new Error(scrub(err instanceof Error ? err.message : String(err), secrets) || 'The text could not be sent')
  }
  if (out.sent) {
    mark.pending = false
    mark.at = Date.now()
    return { ok: true, result: { via: 'sms' } }
  }
  if (out.handoff) {
    mark.pending = false
    mark.at = Date.now()
    const result: Record<string, unknown> = { handoff: out.handoff, text, handoffLabel: SEND_LABEL }
    if (out.error) {
      ctx.log.warn('The modem did not confirm a text command; handing it to the phone')
      // A modem that went quiet may still have sent the text, and a second copy is a second press.
      result.note =
        'The hub’s modem did not confirm that this text went out. Check first whether the box acted; if it did not, send the text from your phone, then come back and confirm.'
    }
    return { ok: true, needsConfirmation: true, result }
  }
  forget(id, mark)
  return { ok: false, error: scrub(out.error ?? 'The text could not be sent', secrets) }
}

/** Hand the phone a tel: link. The hub cannot place calls, and cannot see whether the box answered. */
function callBox(ctx: AdapterContext): ActionResult {
  const to = boxNumber(ctx)
  if ('error' in to) return { ok: false, error: to.error }
  const wait = blocked(ctx.device.id, CALL_KEY)
  if (wait) return { ok: false, error: wait }
  remember(ctx.device.id, { key: CALL_KEY, at: Date.now(), pending: false })
  return {
    ok: true,
    needsConfirmation: true,
    result: {
      via: 'call',
      handoff: `tel:${to.number}`,
      handoffLabel: CALL_LABEL,
      note: 'Call the box from a phone whose number is stored in it. It hangs up on the first ring and works the gate, so the call costs nothing. Then come back and confirm.',
    },
  }
}

async function gate(ctx: AdapterContext, setup: Setup, type: 'gate.open' | 'gate.close' | 'gate.stop' | 'gate.pulse'): Promise<ActionResult> {
  const custom = setup.type === 'custom'
  if (setup.call) {
    // A call is one press of the relay. Where "close" is that same press (one
    // button input), or the box knows nothing but calls, close goes by call too.
    const byCall =
      type === 'gate.open' ||
      (!custom && type === 'gate.pulse') ||
      (!custom && type === 'gate.close' && (!setup.hold || setup.box.callOnly))
    if (byCall) return callBox(ctx)
  }
  switch (type) {
    case 'gate.open':
      return setup.texts.open ? sendText(ctx, setup, setup.texts.open) : noText('opening', setup)
    case 'gate.close':
      return setup.texts.close ? sendText(ctx, setup, setup.texts.close) : noText('closing', setup)
    case 'gate.stop':
      return setup.texts.stop ? sendText(ctx, setup, setup.texts.stop) : noText('stopping', setup)
    case 'gate.pulse':
      return setup.texts.pulse ? sendText(ctx, setup, setup.texts.pulse) : noText('one press', setup)
  }
}

async function power(ctx: AdapterContext, setup: Setup, on: boolean): Promise<ActionResult> {
  const template = on ? setup.texts.on : setup.texts.off
  if (!template) return noText(on ? 'switching on' : 'switching off', setup)
  const res = await sendText(ctx, setup, template)
  if (!res.ok) return res
  // Not read from the box: this is only the last thing it was asked to do.
  lastPower.set(ctx.device.id, on)
  return { ...res, result: { ...(res.result ?? {}), assumed: true }, state: { power: on } }
}

function indianMobile(digits: string): string | null {
  if (/^\d{10}$/.test(digits)) return digits
  if (/^91\d{10}$/.test(digits)) return digits.slice(2)
  if (/^0\d{10}$/.test(digits)) return digits.slice(1)
  if (/^0091\d{10}$/.test(digits)) return digits.slice(4)
  return null
}

const CUSTOM_COMMANDS = ['status', 'open', 'close', 'stop', 'pulse', 'on', 'off', 'call', 'authorise'] as const

async function custom(ctx: AdapterContext, setup: Setup, p: Record<string, unknown>): Promise<ActionResult> {
  const command = typeof p.command === 'string' ? p.command.trim().toLowerCase() : ''
  if (typeof p.text === 'string' && (p.text.trim() || !command)) return sendText(ctx, setup, p.text)
  switch (command) {
    case 'status':
      return setup.texts.status ? sendText(ctx, setup, setup.texts.status) : noText('asking how it is', setup)
    case 'open':
      return setup.texts.open ? sendText(ctx, setup, setup.texts.open) : noText('opening', setup)
    case 'close':
      return setup.texts.close ? sendText(ctx, setup, setup.texts.close) : noText('closing', setup)
    case 'stop':
      return setup.texts.stop ? sendText(ctx, setup, setup.texts.stop) : noText('stopping', setup)
    case 'pulse':
      return setup.texts.pulse ? sendText(ctx, setup, setup.texts.pulse) : noText('one press', setup)
    case 'on':
      return power(ctx, setup, true)
    case 'off':
      return power(ctx, setup, false)
    case 'call':
      return callBox(ctx)
    case 'authorise':
    case 'authorize': {
      if (setup.box.slots === 0) return { ok: false, error: 'For this kind of box, type the text from its leaflet in the box for sending a text command.' }
      const digits = String(p.number ?? '').replace(/\D/g, '')
      if (!digits) return { ok: false, error: 'Give the mobile number to store in the box' }
      const given = !(p.slot === undefined || p.slot === null || p.slot === '')
      // Storing into a place replaces whatever number was there, so the place is never guessed.
      if (setup.box.numberedPlaces && !given) {
        return { ok: false, error: `Say which place to store the number in (1 to ${setup.box.slots}). A number already in that place is replaced.` }
      }
      const slot = setup.box.numberedPlaces ? Number(p.slot) : 1
      if (!Number.isInteger(slot) || slot < 1 || slot > setup.box.slots) {
        return { ok: false, error: `This box stores numbers in places 1 to ${setup.box.slots}` }
      }
      const template = setup.box.authorise({ india: indianMobile(digits), digits, slot })
      if (!template) return { ok: false, error: 'Give a 10-digit Indian mobile number' }
      return sendText(ctx, setup, template)
    }
    default:
      return { ok: false, error: `Unknown command. Use one of: ${CUSTOM_COMMANDS.join(', ')}; or give the text to send.` }
  }
}

// ---------------------------------------------------------------------------
// Add-device form
// ---------------------------------------------------------------------------

const OWN_TEXT_HELP = 'Exactly as the leaflet shows it, with {pwd} where the password goes. Most boxes want capital letters and no spaces.'

function ownText(name: string, label: string, example: string, help = OWN_TEXT_HELP): FieldSpec {
  return { name, label, type: 'text', help, placeholder: example, showWhen: { field: 'boxType', equals: 'custom' } }
}

const adapter: Adapter = {
  family: 'gsm-sms',

  describe(): FamilyDescriptor {
    return {
      id: 'gsm-sms',
      label: 'GSM gate box (SMS)',
      tagline: 'A gate opener or relay box with its own SIM, worked by text message or a free phone call.',
      kinds: ['gate', 'switch'],
      fields: [
        {
          name: 'boxType',
          label: 'Which texts the box understands',
          type: 'select',
          required: true,
          default: DEFAULT_BOX,
          options: BOX_TYPES.map((value) => ({ value, label: GSM_BOXES[value].label })),
          help: 'Pick the one that matches the examples in the leaflet that came with the box. Boxes sold as “RTU5024” come with either of the first two kinds, so go by the examples, not by the name on the lid.',
        },
        {
          name: 'password',
          label: 'Box password',
          type: 'password',
          secret: true,
          help: 'Leave empty if you never changed it: the factory one is used (1234 on RTU5024 and 1234#… boxes, 5678 on *71* boxes, 123456 on WAFER). Stored encrypted on the hub.',
        },
        {
          name: 'adminPassword',
          label: 'Programming password',
          type: 'password',
          secret: true,
          showWhen: { field: 'boxType', equals: 'gainwise' },
          help: 'The second password of this kind of box, used for changing its settings and asking how it is. Leave empty for the factory one (1234).',
        },
        {
          name: 'gateWiring',
          label: 'How the box works the gate',
          type: 'select',
          default: 'step',
          options: [
            { value: 'step', label: 'It presses the gate’s button (each press: open, stop, close)' },
            { value: 'hold', label: 'The gate stays open while the box is switched on' },
          ],
          help: 'For a gate or garage door. Most are wired the first way, so Open and Close send the same press. Not used when you type your own texts.',
        },
        {
          name: 'callToOpen',
          label: 'Open with a free phone call',
          type: 'toggle',
          default: false,
          help: 'Open then brings up your phone’s dialler with the box’s number. The box hangs up on the first ring and works the gate, so the call costs nothing. Your number must be stored in the box first. Boxes that open by phone call only always work this way.',
        },
        ownText('openText', 'Text that opens', '{pwd}CC'),
        ownText('closeText', 'Text that closes', '{pwd}DD'),
        ownText('stopText', 'Text that stops (optional)', ''),
        ownText('pulseText', 'Text for one button press (optional)', '{pwd}CC'),
        ownText('statusText', 'Text that asks the box how it is (optional)', '{pwd}EE', 'The reply comes back as a text message to the SIM that sent it.'),
        ownText('onText', 'Text that switches on (for a switch)', '{pwd}CC'),
        ownText('offText', 'Text that switches off (for a switch)', '{pwd}DD'),
      ],
      pathKinds: ['sms'],
      defaultPort: null,
      capabilities: ['gate', 'power', 'sms'],
      notes: [
        'Commands go as a text message to the SIM inside the box; put that SIM’s number on the SMS connection. With a GSM modem on the hub the text is sent for you. Without one, the app opens your phone’s messages with the text ready: you press send, then confirm.',
        'The box cannot report back, so the app never knows whether the gate is open or closed; it only shows that the command went out. Any reply from the box arrives as a text on the SIM that sent the command.',
        'Before first use, store your mobile number in the box with one text from your phone (below, 9XXXXXXXXX stands for a mobile number; capital letters, no spaces). The box only opens for calls from numbers it has stored.',
        'RTU5024 type: first tell the box its own number with 1234TEL00919XXXXXXXXX#, then store yours with 1234A001#919XXXXXXXXX# (001 is the first of 200 places, and the one the box sends its replies to). It is worked with 1234CC (on), 1234DD (off) and 1234EE (status). 1234GOT000# sets a half-second press, right for a gate button; 1234GOT999# keeps it on until it is switched off or the box is called again, needed for a switch. A mistyped text gets no reply at all.',
        'Boxes with texts like 1234#ON#: store your number with 1234#TEL00919XXXXXXXXX#001#. They are worked with 1234#ON# and 1234#OFF#, and 1234#CSQ? asks for the signal strength. We could not confirm that the relay lets go by itself after 1234#ON#, so try it once while watching the gate. 1234#GOT02# sets a one-second press; 1234#GOT00# keeps the relay on until the next command, for a switch (the leaflets say only the first three stored numbers can work the box in that setting). The 64-number box stores numbers with 1234#TEL919XXXXXXXXX#01# and has no on or off text: it opens by phone call only.',
        'Boxes with texts like *71*5678#: store callers with *12*1234#7191#7219XXXXXXXXX# (7191 sets the country code to India; 721 goes in front of each 10-digit number). They are worked with *71*5678# (one press), *72*5678# (hold) and *73*5678# (release), which get no reply; *24*1234# asks for the state. A text to this kind of box can be 140 characters at most.',
        'The same *71* boxes can make one phone the only one allowed to change their settings. For India our best information is *12*1234#74919XXXXXXXXX#, but we could not confirm how the number must be written there, and a wrong one shuts you out of the settings until the reset button inside the box is used. Leave this step until everything else works, and keep the leaflet at hand.',
        'WAFER GSM-KEY: store your number with #PWD123456#WHL001=9XXXXXXXXX. We have no confirmed text for switching this box, so it opens by phone call only; #PWD123456#STATUS? asks for the state.',
        'Cost: each command is one ordinary SMS on the plan of the SIM that sends it. India has no legal daily cap on personal texts, only your plan’s own allowance, so keep commands occasional. Opening by phone call is free because the box hangs up on the first ring. Calls are always made from your phone; the hub cannot place them.',
        'With one button input on the gate, Open and Close send the same press and the gate takes its next step (open, stop, close), so look at the gate or a camera to be sure. Leave a few seconds between taps: a second press inside the press time can make the box let go early.',
        'The SIM in the box must have its PIN lock switched off. Most of these boxes are 2G only, so a Jio SIM will not work in them; use Airtel, Vi or BSNL.',
      ],
    }
  },

  capabilities(config: Record<string, unknown>, kind: DeviceKind): Capability[] {
    // A box with no text for its relay cannot be switched on or off from here:
    // all it offers is one press by phone call, which is what the gate buttons do.
    if (kind === 'switch' && !GSM_BOXES[boxTypeOf(config?.boxType)].callOnly) return ['power', 'sms']
    return ['gate', 'sms']
  },

  async probe(ctx): Promise<ProbeResult> {
    const to = boxNumber(ctx)
    if ('error' in to) return { ok: false, latencyMs: null, error: to.error }
    // A text is the only way to reach the box, and sending one just to check would cost money and could move the gate.
    return { ok: true, latencyMs: null, unverifiable: true }
  },

  async execute(ctx, action: Action): Promise<ActionResult> {
    const setup = setupOf(ctx)
    const params = action.params ?? {}
    switch (action.type) {
      case 'gate.open':
      case 'gate.close':
      case 'gate.stop':
      case 'gate.pulse':
        return gate(ctx, setup, action.type)
      case 'power.on':
        return power(ctx, setup, true)
      case 'power.off':
        return power(ctx, setup, false)
      case 'power.toggle':
        return power(ctx, setup, !(lastPower.get(ctx.device.id) ?? false))
      case 'sms.send':
        return typeof params.text === 'string' ? sendText(ctx, setup, params.text) : { ok: false, error: 'There is nothing to send' }
      case 'custom':
        return custom(ctx, setup, params)
      default:
        return unsupported(action)
    }
  },
}

export default adapter
