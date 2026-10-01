import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionType, DeviceKind } from '@house/shared'
import adapter, { GSM_BOXES, resetGsmSmsMemory } from '../../src/adapters/gsm-sms.ts'
import type { SmsOutcome } from '../../src/adapters/types.ts'
import { makeAction, makeCtx } from '../helpers.ts'

/** The SIM inside the box. */
const BOX = '+919876543210'

/** The hub has a GSM modem and it accepted the message. */
const modem = async (): Promise<SmsOutcome> => ({ sent: true })

function ctxFor(config: Record<string, unknown> = {}, opts: { kind?: DeviceKind; host?: string | null; sms?: (to: string, text: string) => Promise<SmsOutcome> } = {}) {
  return makeCtx({
    family: 'gsm-sms',
    kind: opts.kind ?? 'gate',
    config,
    path: { kind: 'sms', label: 'SMS', host: opts.host === undefined ? BOX : opts.host },
    sms: opts.sms,
  })
}

beforeEach(() => resetGsmSmsMemory())
afterEach(() => vi.restoreAllMocks())

describe('gsm-sms adapter: add-device form', () => {
  const d = adapter.describe()

  it('describes an SMS-only gate or switch', () => {
    expect(adapter.family).toBe('gsm-sms')
    expect(d.id).toBe('gsm-sms')
    expect(d.kinds).toEqual(['gate', 'switch'])
    expect(d.pathKinds).toEqual(['sms'])
    expect(d.defaultPort).toBeNull()
    expect(d.capabilities).toEqual(expect.arrayContaining(['gate', 'power', 'sms']))
  })

  it('offers every box family from the notes plus Custom', () => {
    const boxType = d.fields.find((f) => f.name === 'boxType')!
    expect(boxType.type).toBe('select')
    expect(boxType.default).toBe('king-pigeon')
    expect(boxType.options?.map((o) => o.value)).toEqual(['king-pigeon', 'pwd-hash', 'pwd-hash-64', 'gainwise', 'wafer', 'custom'])
  })

  it('keeps both passwords secret', () => {
    expect(d.fields.find((f) => f.name === 'password')).toMatchObject({ type: 'password', secret: true })
    expect(d.fields.find((f) => f.name === 'adminPassword')).toMatchObject({ secret: true, showWhen: { field: 'boxType', equals: 'gainwise' } })
  })

  it('asks for the owner’s own texts only for a Custom box', () => {
    for (const name of ['openText', 'closeText', 'stopText', 'pulseText', 'statusText', 'onText', 'offText']) {
      expect(d.fields.find((f) => f.name === name), name).toMatchObject({ type: 'text', showWhen: { field: 'boxType', equals: 'custom' } })
    }
    expect(d.fields.find((f) => f.name === 'callToOpen')).toMatchObject({ type: 'toggle', default: false })
  })

  it('uses the factory password each family ships with', () => {
    expect(GSM_BOXES['king-pigeon'].password).toBe('1234')
    expect(GSM_BOXES['pwd-hash'].password).toBe('1234')
    expect(GSM_BOXES['pwd-hash-64'].password).toBe('1234')
    expect(GSM_BOXES.gainwise.password).toBe('5678')
    expect(GSM_BOXES.gainwise.adminPassword).toBe('1234')
    expect(GSM_BOXES.wafer.password).toBe('123456')
    expect(GSM_BOXES.custom.password).toBe('')
  })

  it('gives the exact text that stores the owner’s number, per family', () => {
    const notes = d.notes.join('\n')
    expect(notes).toContain('1234TEL00919XXXXXXXXX#')
    expect(notes).toContain('1234A001#919XXXXXXXXX#')
    expect(notes).toContain('1234#TEL00919XXXXXXXXX#001#')
    expect(notes).toContain('1234#TEL919XXXXXXXXX#01#')
    expect(notes).toContain('*12*1234#74919XXXXXXXXX#')
    expect(notes).toContain('*12*1234#7191#7219XXXXXXXXX#')
    expect(notes).toContain('#PWD123456#WHL001=')
  })

  it('does not tell the owner to lock the *71* box to one phone as a first step', () => {
    // The maker's leaflet writes the administrator number the local way (*12*1234#7407595062810#);
    // the form for an Indian number is unconfirmed, and a wrong one shuts the owner out of the settings.
    const admin = d.notes.find((n) => n.includes('#74919XXXXXXXXX#'))!
    expect(admin).toMatch(/could not confirm/)
    expect(admin).toMatch(/reset button/)
    expect(admin).not.toMatch(/\bfirst make\b/i)
    // 721 is the whole "store a caller" code in the leaflet (*12*1234#7144#72107595062810#).
    expect(d.notes.join('\n')).toMatch(/721 goes in front of each 10-digit number/)
  })

  it('is honest about cost and about not knowing the gate position', () => {
    const notes = d.notes.join('\n')
    expect(notes).toMatch(/one ordinary SMS/)
    expect(notes).toMatch(/plan’s own allowance/)
    expect(notes).toMatch(/never knows whether the gate is open or closed/)
    expect(notes).toMatch(/Jio SIM will not work/)
  })

  it('never uses internal wording in what the owner reads', () => {
    const visible = JSON.stringify([d.label, d.tagline, d.notes, d.fields.map((f) => [f.label, f.help, f.options?.map((o) => o.label)])])
    expect(visible).not.toMatch(/\b(demo|prototype|placeholder|stub|todo)\b/i)
  })

  it('gives a gate the gate buttons and a switch the on/off button', () => {
    expect(adapter.capabilities({}, 'gate')).toEqual(['gate', 'sms'])
    expect(adapter.capabilities({}, 'switch')).toEqual(['power', 'sms'])
    expect(adapter.capabilities({ boxType: 'wafer' }, 'gate')).not.toContain('gate-state')
  })

  it('does not offer on/off for a box that has no on/off text', async () => {
    for (const boxType of ['wafer', 'pwd-hash-64']) {
      resetGsmSmsMemory()
      // power.on / power.off cannot work on these, so the tile must not promise them ...
      expect(adapter.capabilities({ boxType }, 'switch'), boxType).toEqual(['gate', 'sms'])
      const refused = await adapter.execute(ctxFor({ boxType }, { kind: 'switch', sms: modem }), makeAction('power.on'))
      expect(refused.ok).toBe(false)
      // ... and what it does offer (one press, by phone call) works.
      const press = await adapter.execute(ctxFor({ boxType }, { kind: 'switch', sms: modem }), makeAction('gate.pulse'))
      expect(press).toMatchObject({ ok: true, needsConfirmation: true, result: { handoff: 'tel:+919876543210' } })
    }
    for (const boxType of ['king-pigeon', 'pwd-hash', 'gainwise', 'custom']) {
      expect(adapter.capabilities({ boxType }, 'switch'), boxType).toEqual(['power', 'sms'])
    }
  })

  it('has no way to read the box back', () => {
    expect(adapter.readState).toBeUndefined()
    expect(adapter.snapshot).toBeUndefined()
    expect(adapter.streamSources).toBeUndefined()
    expect(adapter.setWifi).toBeUndefined()
  })
})

describe('gsm-sms adapter: probe', () => {
  it('counts a path with a number as available but unverified, without sending anything', async () => {
    const ctx = ctxFor()
    expect(await adapter.probe(ctx)).toEqual({ ok: true, latencyMs: null, unverifiable: true })
    expect(ctx.smsSent).toEqual([])
  })

  it('says so when no number is set', async () => {
    for (const host of [null, '', '   ']) {
      const res = await adapter.probe(ctxFor({}, { host }))
      expect(res.ok).toBe(false)
      expect(res.latencyMs).toBeNull()
      expect(res.error).toMatch(/No phone number set on the "SMS" connection/)
    }
  })

  it('rejects something that is not a phone number', async () => {
    const res = await adapter.probe(ctxFor({}, { host: 'gate-box' }))
    expect(res).toMatchObject({ ok: false, latencyMs: null })
    expect(res.error).toMatch(/does not look like a phone number/)
  })

  it('refuses a connection that is not SMS', async () => {
    const ctx = makeCtx({ family: 'gsm-sms', kind: 'gate', path: { kind: 'lan', host: '192.168.1.40' } })
    const res = await adapter.probe(ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Add an SMS connection/)
  })
})

describe('gsm-sms adapter: exact text per box type and action (hub modem)', () => {
  // [box type, wiring, action, text on the wire] — texts as given in docs/protocols/gate-control.md
  const cases: Array<[string, 'step' | 'hold', ActionType, string]> = [
    // King Pigeon RTU5024: 1234CC relay on (for the set time), 1234DD relay off
    ['king-pigeon', 'step', 'gate.open', '1234CC'],
    ['king-pigeon', 'step', 'gate.close', '1234CC'],
    ['king-pigeon', 'step', 'gate.pulse', '1234CC'],
    ['king-pigeon', 'hold', 'gate.open', '1234CC'],
    ['king-pigeon', 'hold', 'gate.close', '1234DD'],
    ['king-pigeon', 'hold', 'gate.pulse', '1234CC'],
    ['king-pigeon', 'step', 'power.on', '1234CC'],
    ['king-pigeon', 'step', 'power.off', '1234DD'],
    // "pwd#CMD#" family (200 / 999 numbers): 1234#ON# / 1234#OFF#
    ['pwd-hash', 'step', 'gate.open', '1234#ON#'],
    ['pwd-hash', 'step', 'gate.close', '1234#ON#'],
    ['pwd-hash', 'step', 'gate.pulse', '1234#ON#'],
    ['pwd-hash', 'hold', 'gate.open', '1234#ON#'],
    ['pwd-hash', 'hold', 'gate.close', '1234#OFF#'],
    ['pwd-hash', 'step', 'power.on', '1234#ON#'],
    ['pwd-hash', 'step', 'power.off', '1234#OFF#'],
    // Gainwise / First Fence: *71* press, *72* hold, *73* release, access password 5678
    ['gainwise', 'step', 'gate.open', '*71*5678#'],
    ['gainwise', 'step', 'gate.close', '*71*5678#'],
    ['gainwise', 'step', 'gate.pulse', '*71*5678#'],
    ['gainwise', 'hold', 'gate.open', '*72*5678#'],
    ['gainwise', 'hold', 'gate.close', '*73*5678#'],
    ['gainwise', 'hold', 'gate.pulse', '*71*5678#'],
    ['gainwise', 'step', 'power.on', '*72*5678#'],
    ['gainwise', 'step', 'power.off', '*73*5678#'],
  ]

  it.each(cases)('%s (%s wiring) %s sends %s', async (boxType, gateWiring, type, text) => {
    const ctx = ctxFor({ boxType, gateWiring }, { sms: modem, kind: type.startsWith('power') ? 'switch' : 'gate' })
    const res = await adapter.execute(ctx, makeAction(type))
    expect(ctx.smsSent).toEqual([{ to: BOX, text }])
    expect(res.ok).toBe(true)
    expect(res.needsConfirmation).toBeUndefined()
    expect(res.result).toMatchObject({ via: 'sms' })
    // The box cannot be read back: never claim a gate position.
    expect(res.state?.gate).toBeUndefined()
    expect(res.result?.gate).toBeUndefined()
  })

  it('returns exactly { via: "sms" } for a gate command the modem sent', async () => {
    const res = await adapter.execute(ctxFor({ boxType: 'king-pigeon' }, { sms: modem }), makeAction('gate.open'))
    expect(res).toEqual({ ok: true, result: { via: 'sms' } })
  })

  it('falls back to the RTU5024 texts when no box type is saved', async () => {
    const ctx = ctxFor({}, { sms: modem })
    await adapter.execute(ctx, makeAction('gate.open'))
    expect(ctx.smsSent).toEqual([{ to: BOX, text: '1234CC' }])
  })

  it('uses the stored password instead of the factory one', async () => {
    const king = ctxFor({ boxType: 'king-pigeon', password: '6666' }, { sms: modem })
    await adapter.execute(king, makeAction('gate.open'))
    expect(king.smsSent[0]!.text).toBe('6666CC')

    const hash = ctxFor({ boxType: 'pwd-hash', password: '4321', gateWiring: 'hold' }, { sms: modem })
    await adapter.execute(hash, makeAction('gate.close'))
    expect(hash.smsSent[0]!.text).toBe('4321#OFF#')

    const gain = ctxFor({ boxType: 'gainwise', password: '2468' }, { sms: modem })
    await adapter.execute(gain, makeAction('gate.pulse'))
    expect(gain.smsSent[0]!.text).toBe('*71*2468#')
  })

  it('never puts the password or the text into the result when the modem sent it', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon', password: '86420' }, { sms: modem })
    const res = await adapter.execute(ctx, makeAction('gate.open'))
    expect(JSON.stringify(res)).not.toContain('86420')
  })

  it('has no stop text on the built-in boxes and says what to do instead', async () => {
    for (const boxType of ['king-pigeon', 'pwd-hash', 'gainwise']) {
      const ctx = ctxFor({ boxType }, { sms: modem })
      const res = await adapter.execute(ctx, makeAction('gate.stop'))
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/no text for stopping/)
      expect(ctx.smsSent).toEqual([])
    }
  })

  it('tidies the box number the way the hub does (10 digits -> +91)', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon' }, { sms: modem, host: '98765 43210' })
    await adapter.execute(ctx, makeAction('gate.open'))
    expect(ctx.smsSent).toEqual([{ to: '+919876543210', text: '1234CC' }])
  })

  it('adds the + when the number was typed with 91 or 0091 in front', async () => {
    // Without the + a modem or a phone dials the twelve digits as a local number.
    for (const host of ['91 98765 43210', '919876543210', '0091 98765-43210', '+91 98765 43210', '(+91) 98765.43210']) {
      resetGsmSmsMemory()
      const ctx = ctxFor({ boxType: 'king-pigeon' }, { sms: modem, host })
      await adapter.execute(ctx, makeAction('gate.open'))
      expect(ctx.smsSent, host).toEqual([{ to: '+919876543210', text: '1234CC' }])
      const call = await adapter.execute(ctxFor({ callToOpen: true }, { host }), makeAction('gate.pulse'))
      expect(call.result?.handoff, host).toBe('tel:+919876543210')
    }
  })
})

describe('gsm-sms adapter: no modem, the phone sends the text', () => {
  it('hands the exact text to the phone and asks the owner to confirm', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon' })
    const res = await adapter.execute(ctx, makeAction('gate.open'))
    expect(ctx.smsSent).toEqual([{ to: BOX, text: '1234CC' }])
    expect(res).toEqual({
      ok: true,
      needsConfirmation: true,
      result: { handoff: 'sms:+919876543210?body=1234CC', text: '1234CC', handoffLabel: 'Send the text' },
    })
  })

  it('percent-encodes texts with # and * in the hand-off link', async () => {
    const hash = await adapter.execute(ctxFor({ boxType: 'pwd-hash', gateWiring: 'hold' }), makeAction('gate.close'))
    expect(hash.needsConfirmation).toBe(true)
    expect(hash.result).toMatchObject({ handoff: 'sms:+919876543210?body=1234%23OFF%23', text: '1234#OFF#', handoffLabel: 'Send the text' })

    const gain = await adapter.execute(ctxFor({ boxType: 'gainwise' }), makeAction('gate.open'))
    expect(gain.result).toMatchObject({ handoff: `sms:+919876543210?body=${encodeURIComponent('*71*5678#')}`, text: '*71*5678#' })
  })

  it('falls back to the phone when the modem fails, without leaking what the modem said', async () => {
    const failing = async (to: string, text: string): Promise<SmsOutcome> => ({
      sent: false,
      error: `Modem did not answer "${text}" within 60000 ms`,
      handoff: `sms:${to}?body=${encodeURIComponent(text)}`,
    })
    const res = await adapter.execute(ctxFor({ boxType: 'king-pigeon', password: '7788' }, { sms: failing }), makeAction('gate.open'))
    expect(res.ok).toBe(true)
    expect(res.needsConfirmation).toBe(true)
    expect(res.result).toMatchObject({ handoff: 'sms:+919876543210?body=7788CC', text: '7788CC', handoffLabel: 'Send the text' })
    // A modem that went quiet may still have sent the text: the owner is told to look before sending a second copy.
    expect(String(res.result?.note)).toMatch(/modem did not confirm/)
    expect(String(res.result?.note)).toMatch(/Check first whether the box acted/)
    expect(String(res.result?.note)).not.toContain('7788')
  })

  it('fails plainly, with the password scrubbed, when nothing can send the text', async () => {
    const dead = async (_to: string, text: string): Promise<SmsOutcome> => ({ sent: false, error: `Modem rejected "${text}"` })
    const res = await adapter.execute(ctxFor({ boxType: 'king-pigeon', password: '7788' }, { sms: dead }), makeAction('gate.open'))
    expect(res.ok).toBe(false)
    expect(res.needsConfirmation).toBeUndefined()
    expect(res.error).toMatch(/Modem rejected/)
    expect(res.error).not.toContain('7788')
  })
})

describe('gsm-sms adapter: missing number', () => {
  it('refuses to send and says where to put the number', async () => {
    for (const type of ['gate.open', 'gate.close', 'power.on', 'sms.send', 'custom'] as ActionType[]) {
      const ctx = ctxFor({ boxType: 'king-pigeon' }, { host: '', sms: modem })
      const res = await adapter.execute(ctx, makeAction(type, { text: 'HELLO', command: 'status' }))
      expect(res.ok, type).toBe(false)
      expect(res.error).toMatch(/No phone number set on the "SMS" connection/)
      expect(ctx.smsSent).toEqual([])
    }
  })

  it('does not offer a call without a number either', async () => {
    const res = await adapter.execute(ctxFor({ boxType: 'king-pigeon', callToOpen: true }, { host: null }), makeAction('gate.open'))
    expect(res.ok).toBe(false)
    expect(res.result).toBeUndefined()
    expect(res.error).toMatch(/No phone number set/)
  })
})

describe('gsm-sms adapter: call to open', () => {
  it('hands the phone a tel: link instead of sending a text', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon', callToOpen: true }, { sms: modem })
    const res = await adapter.execute(ctx, makeAction('gate.open'))
    expect(ctx.smsSent).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.needsConfirmation).toBe(true)
    expect(res.result).toMatchObject({ handoff: 'tel:+919876543210', handoffLabel: 'Call the gate', via: 'call' })
    expect(res.result?.text).toBeUndefined()
    expect(res.state).toBeUndefined()
  })

  it('builds the tel: link from the tidied number', async () => {
    const res = await adapter.execute(ctxFor({ callToOpen: true }, { host: '098765-43210' }), makeAction('gate.open'))
    expect(res.result?.handoff).toBe('tel:+919876543210')
  })

  it('also calls for the same press when the gate has one button input', async () => {
    for (const type of ['gate.pulse', 'gate.close'] as ActionType[]) {
      resetGsmSmsMemory()
      const ctx = ctxFor({ boxType: 'pwd-hash', callToOpen: true, gateWiring: 'step' }, { sms: modem })
      const res = await adapter.execute(ctx, makeAction(type))
      expect(res.result, type).toMatchObject({ handoff: 'tel:+919876543210', handoffLabel: 'Call the gate' })
      expect(ctx.smsSent).toEqual([])
    }
  })

  it('still closes by text when the gate is held open by the relay', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon', callToOpen: true, gateWiring: 'hold' }, { sms: modem })
    const res = await adapter.execute(ctx, makeAction('gate.close'))
    expect(ctx.smsSent).toEqual([{ to: BOX, text: '1234DD' }])
    expect(res).toEqual({ ok: true, result: { via: 'sms' } })
  })

  it('always calls on boxes that have no text for their relay', async () => {
    for (const boxType of ['pwd-hash-64', 'wafer']) {
      for (const gateWiring of ['step', 'hold']) {
        for (const type of ['gate.open', 'gate.close', 'gate.pulse'] as ActionType[]) {
          resetGsmSmsMemory()
          const ctx = ctxFor({ boxType, gateWiring }, { sms: modem })
          const res = await adapter.execute(ctx, makeAction(type))
          expect(res.needsConfirmation, `${boxType} ${type}`).toBe(true)
          expect(res.result).toMatchObject({ handoff: 'tel:+919876543210', handoffLabel: 'Call the gate' })
          expect(ctx.smsSent).toEqual([])
        }
      }
    }
  })

  it('cannot switch a call-only box on or off by text', async () => {
    const ctx = ctxFor({ boxType: 'wafer' }, { kind: 'switch', sms: modem })
    const res = await adapter.execute(ctx, makeAction('power.on'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/worked by phone call only/)
    expect(ctx.smsSent).toEqual([])
  })

  it('can be asked for by name through a custom command', async () => {
    const res = await adapter.execute(ctxFor({ boxType: 'gainwise' }), makeAction('custom', { command: 'call' }))
    expect(res).toMatchObject({ ok: true, needsConfirmation: true, result: { handoff: 'tel:+919876543210', handoffLabel: 'Call the gate' } })
  })
})

describe('gsm-sms adapter: switch (on / off)', () => {
  it('remembers what it last asked for, and marks it as assumed', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon' }, { kind: 'switch', sms: modem })
    const on = await adapter.execute(ctx, makeAction('power.on'))
    expect(on).toEqual({ ok: true, result: { via: 'sms', assumed: true }, state: { power: true } })
    const off = await adapter.execute(ctx, makeAction('power.off'))
    expect(off).toEqual({ ok: true, result: { via: 'sms', assumed: true }, state: { power: false } })
    expect(ctx.smsSent.map((m) => m.text)).toEqual(['1234CC', '1234DD'])
  })

  it('toggles between the on and off texts', async () => {
    const ctx = ctxFor({ boxType: 'gainwise' }, { kind: 'switch', sms: modem })
    const first = await adapter.execute(ctx, makeAction('power.toggle'))
    const second = await adapter.execute(ctx, makeAction('power.toggle'))
    const third = await adapter.execute(ctx, makeAction('power.toggle'))
    expect(ctx.smsSent.map((m) => m.text)).toEqual(['*72*5678#', '*73*5678#', '*72*5678#'])
    expect([first.state, second.state, third.state]).toEqual([{ power: true }, { power: false }, { power: true }])
  })

  it('hands on/off texts to the phone when there is no modem', async () => {
    const res = await adapter.execute(ctxFor({ boxType: 'pwd-hash' }, { kind: 'switch' }), makeAction('power.on'))
    expect(res.ok).toBe(true)
    expect(res.needsConfirmation).toBe(true)
    expect(res.result).toMatchObject({ handoff: 'sms:+919876543210?body=1234%23ON%23', text: '1234#ON#', handoffLabel: 'Send the text' })
  })
})

describe('gsm-sms adapter: Custom box', () => {
  const config = {
    boxType: 'custom',
    password: '9090',
    openText: '{pwd}#OPEN#',
    closeText: '{pwd}#SHUT#',
    stopText: '{pwd}#HALT#',
    pulseText: '{pwd}#STEP#',
    statusText: '{pwd}#HOW?',
    onText: 'ON {pwd}',
    offText: 'OFF {pwd}',
  }

  it('sends the owner’s own texts with the password filled in', async () => {
    const expected: Array<[ActionType, string]> = [
      ['gate.open', '9090#OPEN#'],
      ['gate.close', '9090#SHUT#'],
      ['gate.stop', '9090#HALT#'],
      ['gate.pulse', '9090#STEP#'],
      ['power.on', 'ON 9090'],
      ['power.off', 'OFF 9090'],
    ]
    for (const [type, text] of expected) {
      const ctx = ctxFor(config, { sms: modem })
      const res = await adapter.execute(ctx, makeAction(type))
      expect(res.ok, type).toBe(true)
      expect(ctx.smsSent).toEqual([{ to: BOX, text }])
    }
  })

  it('ignores the wiring choice and the built-in texts', async () => {
    const ctx = ctxFor({ ...config, gateWiring: 'hold' }, { sms: modem })
    await adapter.execute(ctx, makeAction('gate.close'))
    expect(ctx.smsSent[0]!.text).toBe('9090#SHUT#')
  })

  it('says which text is missing', async () => {
    const ctx = ctxFor({ boxType: 'custom', openText: 'OPEN' }, { sms: modem })
    const res = await adapter.execute(ctx, makeAction('gate.close'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/No text is saved for closing/)
    expect(ctx.smsSent).toEqual([])
  })

  it('needs a password when a text uses {pwd}', async () => {
    const ctx = ctxFor({ boxType: 'custom', openText: '{pwd}GO' }, { sms: modem })
    const res = await adapter.execute(ctx, makeAction('gate.open'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/needs the box password/)
    expect(ctx.smsSent).toEqual([])
  })

  it('calls to open when asked, and texts for everything else', async () => {
    const ctx = ctxFor({ ...config, callToOpen: true }, { sms: modem })
    const open = await adapter.execute(ctx, makeAction('gate.open'))
    expect(open.result).toMatchObject({ handoff: 'tel:+919876543210', handoffLabel: 'Call the gate' })
    await adapter.execute(ctx, makeAction('gate.close'))
    expect(ctx.smsSent).toEqual([{ to: BOX, text: '9090#SHUT#' }])
  })
})

describe('gsm-sms adapter: free text and custom commands', () => {
  it('sends a free text with {pwd} filled in', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon' }, { sms: modem })
    // King Pigeon: set a half-second press, from the notes
    const res = await adapter.execute(ctx, makeAction('sms.send', { text: ' {pwd}GOT000# ' }))
    expect(res).toEqual({ ok: true, result: { via: 'sms' } })
    expect(ctx.smsSent).toEqual([{ to: BOX, text: '1234GOT000#' }])
  })

  it('hands a free text to the phone when there is no modem', async () => {
    const res = await adapter.execute(ctxFor({ boxType: 'pwd-hash' }), makeAction('sms.send', { text: '1234#R#' }))
    expect(res).toEqual({
      ok: true,
      needsConfirmation: true,
      result: { handoff: 'sms:+919876543210?body=1234%23R%23', text: '1234#R#', handoffLabel: 'Send the text' },
    })
  })

  it('refuses an empty or over-long text', async () => {
    const ctx = ctxFor({}, { sms: modem })
    const empty = await adapter.execute(ctx, makeAction('sms.send', { text: '   ' }))
    expect(empty).toMatchObject({ ok: false, error: 'There is nothing to send' })
    const none = await adapter.execute(ctx, makeAction('sms.send'))
    expect(none.ok).toBe(false)
    const long = await adapter.execute(ctx, makeAction('sms.send', { text: 'A'.repeat(161) }))
    expect(long.ok).toBe(false)
    expect(long.error).toMatch(/161 characters/)
    expect(ctx.smsSent).toEqual([])
  })

  it('asks each family for its status with the right text', async () => {
    const expected: Array<[Record<string, unknown>, string]> = [
      [{ boxType: 'king-pigeon' }, '1234EE'],
      [{ boxType: 'pwd-hash' }, '1234#CSQ?'],
      [{ boxType: 'pwd-hash-64' }, '1234#CSQ?'],
      [{ boxType: 'gainwise' }, '*24*1234#'],
      [{ boxType: 'gainwise', adminPassword: '4455' }, '*24*4455#'],
      [{ boxType: 'wafer' }, '#PWD123456#STATUS?'],
      [{ boxType: 'wafer', password: '333444' }, '#PWD333444#STATUS?'],
      [{ boxType: 'custom', statusText: 'STATUS' }, 'STATUS'],
    ]
    for (const [config, text] of expected) {
      resetGsmSmsMemory() // each row stands for a different box
      const ctx = ctxFor(config, { sms: modem })
      const res = await adapter.execute(ctx, makeAction('custom', { command: 'status' }))
      expect(res, text).toEqual({ ok: true, result: { via: 'sms' } })
      expect(ctx.smsSent).toEqual([{ to: BOX, text }])
    }
  })

  it('builds the text that stores a number in the box, per family', async () => {
    const number = '98123 45678'
    const expected: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
      // 1234A003#919XXXXXXXXX#
      [{ boxType: 'king-pigeon' }, { number, slot: 3 }, '1234A003#919812345678#'],
      [{ boxType: 'king-pigeon' }, { number, slot: 1 }, '1234A001#919812345678#'],
      [{ boxType: 'king-pigeon', password: '6666' }, { number, slot: '200' }, '6666A200#919812345678#'],
      // 1234#TEL00919XXXXXXXXX#001#
      [{ boxType: 'pwd-hash' }, { number: '+919812345678', slot: 1 }, '1234#TEL00919812345678#001#'],
      [{ boxType: 'pwd-hash' }, { number: '00919812345678', slot: 12 }, '1234#TEL00919812345678#012#'],
      // 1234#TEL919XXXXXXXXX#01#
      [{ boxType: 'pwd-hash-64' }, { number: '09812345678', slot: 1 }, '1234#TEL919812345678#01#'],
      [{ boxType: 'pwd-hash-64' }, { number: '919812345678', slot: 64 }, '1234#TEL919812345678#64#'],
      // *12*1234#7191#7219XXXXXXXXX#  (leaflet: 71[country code]# then 721[phone number]#; no numbered places)
      [{ boxType: 'gainwise' }, { number }, '*12*1234#7191#7219812345678#'],
      [{ boxType: 'gainwise', adminPassword: '4455' }, { number, slot: 7 }, '*12*4455#7191#7219812345678#'],
      // #PWD123456#WHL001=<number>
      [{ boxType: 'wafer' }, { number, slot: 1 }, '#PWD123456#WHL001=9812345678'],
      [{ boxType: 'wafer', password: '333444' }, { number, slot: 85 }, '#PWD333444#WHL085=9812345678'],
    ]
    for (const [config, params, text] of expected) {
      resetGsmSmsMemory()
      const ctx = ctxFor(config, { sms: modem })
      const res = await adapter.execute(ctx, makeAction('custom', { command: 'authorise', ...params }))
      expect(res.ok, text).toBe(true)
      expect(ctx.smsSent).toEqual([{ to: BOX, text }])
    }
  })

  it('checks the number and the place before building that text', async () => {
    const ctx = ctxFor({ boxType: 'pwd-hash-64' }, { sms: modem })
    const noNumber = await adapter.execute(ctx, makeAction('custom', { command: 'authorise' }))
    expect(noNumber).toMatchObject({ ok: false, error: 'Give the mobile number to store in the box' })
    const badNumber = await adapter.execute(ctx, makeAction('custom', { command: 'authorise', number: '12345', slot: 2 }))
    expect(badNumber).toMatchObject({ ok: false, error: 'Give a 10-digit Indian mobile number' })
    // Storing into a place replaces the number already there, so the place is never guessed.
    const noSlot = await adapter.execute(ctx, makeAction('custom', { command: 'authorise', number: '9812345678' }))
    expect(noSlot.ok).toBe(false)
    expect(noSlot.error).toMatch(/Say which place .*1 to 64/)
    const halfSlot = await adapter.execute(ctx, makeAction('custom', { command: 'authorise', number: '9812345678', slot: 1.5 }))
    expect(halfSlot.ok).toBe(false)
    const badSlot = await adapter.execute(ctx, makeAction('custom', { command: 'authorise', number: '9812345678', slot: 65 }))
    expect(badSlot.ok).toBe(false)
    expect(badSlot.error).toMatch(/places 1 to 64/)
    const customBox = await adapter.execute(ctxFor({ boxType: 'custom' }, { sms: modem }), makeAction('custom', { command: 'authorise', number: '9812345678' }))
    expect(customBox.ok).toBe(false)
    expect(ctx.smsSent).toEqual([])
  })

  it('sends a named gate text even when call-to-open is on', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon', callToOpen: true }, { sms: modem })
    const res = await adapter.execute(ctx, makeAction('custom', { command: 'open' }))
    expect(res).toEqual({ ok: true, result: { via: 'sms' } })
    expect(ctx.smsSent).toEqual([{ to: BOX, text: '1234CC' }])
  })

  it('treats custom { text } like a free text', async () => {
    const ctx = ctxFor({ boxType: 'gainwise' }, { sms: modem })
    // *21*1234# = signal level, from the notes
    await adapter.execute(ctx, makeAction('custom', { text: '*21*{admin}#' }))
    expect(ctx.smsSent).toEqual([{ to: BOX, text: '*21*1234#' }])
  })

  it('explains an unknown custom command', async () => {
    const res = await adapter.execute(ctxFor(), makeAction('custom', { command: 'dance' }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Unknown command/)
  })
})

describe('gsm-sms adapter: what may go into a text', () => {
  it('keeps a "$" in a password exactly as typed', async () => {
    const ctx = ctxFor({ boxType: 'custom', password: 'a$&b$1', openText: '{pwd}#OPEN#', statusText: '{PWD}?' }, { sms: modem })
    await adapter.execute(ctx, makeAction('gate.open'))
    await adapter.execute(ctx, makeAction('custom', { command: 'status' }))
    expect(ctx.smsSent.map((m) => m.text)).toEqual(['a$&b$1#OPEN#', 'a$&b$1?'])
  })

  it('refuses a text with a mistyped or stray curly bracket instead of sending it as it stands', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon' }, { sms: modem })
    for (const text of ['{password}CC', '{ pwd }CC', '{pwd}CC}', '{pwdCC']) {
      const res = await adapter.execute(ctx, makeAction('sms.send', { text }))
      expect(res.ok, text).toBe(false)
      expect(res.error).toMatch(/Only \{pwd\} and \{admin\}/)
    }
    const custom = ctxFor({ boxType: 'custom', password: '9090', openText: '{pass}#OPEN#' }, { sms: modem })
    expect((await adapter.execute(custom, makeAction('gate.open'))).ok).toBe(false)
    expect(ctx.smsSent).toEqual([])
    expect(custom.smsSent).toEqual([])
  })

  it('refuses line breaks, control characters and non-English letters (the modem sends plain text only)', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon' }, { sms: modem })
    for (const text of ['1234CC\n1234DD', '1234\x1bCC', '1234CC\x1a', 'ಗೇಟ್', '1234’CC', '1234\tCC']) {
      const res = await adapter.execute(ctx, makeAction('sms.send', { text }))
      expect(res.ok, JSON.stringify(text)).toBe(false)
      expect(res.error).toMatch(/plain English letters, digits and symbols on one line/)
    }
    expect(ctx.smsSent).toEqual([])
  })

  it('refuses a text that is not a string rather than sending "[object Object]"', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon' }, { sms: modem })
    for (const text of [{ a: 1 }, 1234, ['1234CC'], null]) {
      const res = await adapter.execute(ctx, makeAction('sms.send', { text }))
      expect(res).toEqual({ ok: false, error: 'There is nothing to send' })
    }
    expect(ctx.smsSent).toEqual([])
  })

  it('holds a *71* box to the 140 characters its leaflet allows, the others to 160', async () => {
    const gain = ctxFor({ boxType: 'gainwise' }, { sms: modem })
    const over = await adapter.execute(gain, makeAction('sms.send', { text: '*31*{admin}#' + 'A'.repeat(131) + '#' }))
    expect(over.ok).toBe(false)
    expect(over.error).toMatch(/141 characters long; this box takes 140/)
    const fits = await adapter.execute(gain, makeAction('sms.send', { text: '*31*{admin}#' + 'A'.repeat(130) + '#' }))
    expect(fits.ok).toBe(true)
    expect(gain.smsSent).toHaveLength(1)
    expect(gain.smsSent[0]!.text).toHaveLength(140)

    const king = ctxFor({ boxType: 'king-pigeon' }, { sms: modem })
    expect((await adapter.execute(king, makeAction('sms.send', { text: 'B'.repeat(160) }))).ok).toBe(true)
    expect((await adapter.execute(king, makeAction('sms.send', { text: 'C'.repeat(161) }))).error).toMatch(/this box takes 160/)
  })

  it('runs a named command when the text beside it is empty', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon' }, { sms: modem })
    const res = await adapter.execute(ctx, makeAction('custom', { command: 'status', text: '' }))
    expect(res.ok).toBe(true)
    expect(ctx.smsSent).toEqual([{ to: BOX, text: '1234EE' }])
  })
})

describe('gsm-sms adapter: guard rails', () => {
  it('does not send the same text twice while the modem is still busy with the first', async () => {
    // The modem may take up to a minute; the hub gives up on the action after a few seconds and the owner taps again.
    const waiting: Array<(out: SmsOutcome) => void> = []
    const slow = () => new Promise<SmsOutcome>((resolve) => waiting.push(resolve))
    const ctx = ctxFor({ boxType: 'king-pigeon' }, { sms: slow })
    const first = adapter.execute(ctx, makeAction('gate.open'))
    const second = await adapter.execute(ctx, makeAction('gate.open'))
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/still on its way/)
    expect(ctx.smsSent).toHaveLength(1)
    // A different command is not held up.
    const other = adapter.execute(ctx, makeAction('custom', { command: 'status' }))
    await Promise.resolve()
    expect(ctx.smsSent.map((m) => m.text)).toEqual(['1234CC', '1234EE'])
    for (const done of waiting) done({ sent: true })
    expect(await first).toEqual({ ok: true, result: { via: 'sms' } })
    expect(await other).toEqual({ ok: true, result: { via: 'sms' } })
    // Once it has gone, the usual few-second guard takes over.
    const third = await adapter.execute(ctx, makeAction('gate.open'))
    expect(third.error).toMatch(/went out a moment ago/)
  })

  it('lets the command be tried again straight away when the transport failed', async () => {
    let calls = 0
    const flaky = async (): Promise<SmsOutcome> => {
      calls += 1
      if (calls === 1) throw new Error('The modem cable was unplugged')
      return { sent: true }
    }
    const ctx = ctxFor({ boxType: 'king-pigeon' }, { sms: flaky })
    await expect(adapter.execute(ctx, makeAction('gate.open'))).rejects.toThrow(/unplugged/)
    // This is the hub's retry on the next connection: it must not be refused as a repeat.
    expect(await adapter.execute(ctx, makeAction('gate.open'))).toEqual({ ok: true, result: { via: 'sms' } })
  })

  it('throws transport failures on without the command or the password in the message', async () => {
    const leaky = async (_to: string, text: string): Promise<SmsOutcome> => {
      throw new Error(`Serial port closed while writing "${text}"`)
    }
    const ctx = ctxFor({ boxType: 'gainwise', password: '2468' }, { sms: leaky })
    const err = await adapter.execute(ctx, makeAction('gate.open')).then(
      () => null,
      (e: Error) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/Serial port closed/)
    expect(err!.message).not.toContain('2468')
  })

  it('refuses the same command twice in a row, then allows it again after a few seconds', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    const ctx = ctxFor({ boxType: 'king-pigeon' }, { sms: modem })
    expect((await adapter.execute(ctx, makeAction('gate.open'))).ok).toBe(true)
    now.mockReturnValue(1_002_000)
    const again = await adapter.execute(ctx, makeAction('gate.open'))
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/went out a moment ago/)
    expect(ctx.smsSent).toHaveLength(1)
    now.mockReturnValue(1_006_000)
    expect((await adapter.execute(ctx, makeAction('gate.open'))).ok).toBe(true)
    expect(ctx.smsSent).toHaveLength(2)
  })

  it('does not block a different command straight after', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon', gateWiring: 'hold' }, { sms: modem })
    await adapter.execute(ctx, makeAction('gate.open'))
    const close = await adapter.execute(ctx, makeAction('gate.close'))
    expect(close.ok).toBe(true)
    expect(ctx.smsSent.map((m) => m.text)).toEqual(['1234CC', '1234DD'])
  })

  it('guards repeated calls too', async () => {
    const ctx = ctxFor({ boxType: 'king-pigeon', callToOpen: true })
    expect((await adapter.execute(ctx, makeAction('gate.open'))).ok).toBe(true)
    const again = await adapter.execute(ctx, makeAction('gate.open'))
    expect(again).toMatchObject({ ok: false })
    expect(again.error).toMatch(/went out a moment ago/)
  })

  it('does not count a command that failed to go out', async () => {
    const dead = async (): Promise<SmsOutcome> => ({ sent: false, error: 'No signal' })
    const ctx = ctxFor({ boxType: 'king-pigeon' }, { sms: dead })
    const first = await adapter.execute(ctx, makeAction('gate.open'))
    const second = await adapter.execute(ctx, makeAction('gate.open'))
    expect(first).toEqual({ ok: false, error: 'No signal' })
    expect(second).toEqual({ ok: false, error: 'No signal' })
  })

  it('lets a transport failure propagate so the hub can fail over', async () => {
    const broken = async (): Promise<SmsOutcome> => {
      throw new Error('The modem cable was unplugged')
    }
    await expect(adapter.execute(ctxFor({}, { sms: broken }), makeAction('gate.open'))).rejects.toThrow(/unplugged/)
  })

  it('refuses a connection that is not SMS', async () => {
    const ctx = makeCtx({ family: 'gsm-sms', kind: 'gate', path: { kind: 'lan', host: '192.168.1.40' }, sms: modem })
    const res = await adapter.execute(ctx, makeAction('gate.open'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Add an SMS connection/)
    expect(ctx.smsSent).toEqual([])
  })

  it('refuses commands a relay box cannot do', async () => {
    for (const type of ['ptz.move', 'dim.set', 'reboot', 'color.set', 'ptz.preset'] as ActionType[]) {
      const ctx = ctxFor({}, { sms: modem })
      const res = await adapter.execute(ctx, makeAction(type))
      expect(res.ok, type).toBe(false)
      expect(res.error).toContain(type)
      expect(ctx.smsSent).toEqual([])
    }
  })
})
