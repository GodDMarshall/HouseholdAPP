import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAdapter } from '../../src/adapters/index.ts'
import { ActionError } from '../../src/actions.ts'
import { makeHub, sleep, type TestHub } from './harness.ts'

let t: TestHub
beforeEach(async () => {
  t = await makeHub()
})
afterEach(async () => {
  await t.close()
})

describe('actions', () => {
  it('runs a command, records the outcome and updates the state', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    const done = await t.settle(t.hub.actions.request(d.id, { type: 'power.toggle' }))
    expect(done.status).toBe('done')
    expect(done.result).toMatchObject({ power: true })
    expect(done.pathId).toBe(d.paths[0]!.id)
    expect(done.startedAt).toBeTruthy()
    expect(done.finishedAt).toBeTruthy()
    expect(t.hub.devices.getState(d.id)!.state.power).toBe(true)
    expect(t.events.some((e) => e.type === 'action.done' && /Lamp: Toggle — Now on/.test(e.message))).toBe(true)
    expect(t.hub.actions.list({ deviceId: d.id })[0]!.id).toBe(done.id)
  })

  it('refuses what the device cannot do, before queueing anything', () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    expect(() => t.hub.actions.request(d.id, { type: 'gate.open' })).toThrow(ActionError)
    expect(() => t.hub.actions.request(d.id, { type: 'dim.set', params: { brightness: 50 } })).toThrow(/cannot set brightness/)
    expect(() => t.hub.actions.request('dev_missing', { type: 'power.on' })).toThrow(/not found/)
    expect(() => t.hub.actions.request(d.id, { type: 'fly' as never })).toThrow(/Unknown action/)
    expect(t.hub.actions.list()).toHaveLength(0)
  })

  it('runs commands for one device in the order they were asked', async () => {
    const d = t.add({ name: 'Dimmer', simulate: 'dimmer' })
    const a = t.hub.actions.request(d.id, { type: 'power.on' })
    const b = t.hub.actions.request(d.id, { type: 'dim.set', params: { brightness: 35 } })
    const c = t.hub.actions.request(d.id, { type: 'power.off' })
    const [ra, rb, rc] = await Promise.all([t.settle(a), t.settle(b), t.settle(c)])
    expect([ra.status, rb.status, rc.status]).toEqual(['done', 'done', 'done'])
    expect(ra.finishedAt! <= rb.startedAt!).toBe(true)
    expect(rb.finishedAt! <= rc.startedAt!).toBe(true)
    expect(t.hub.devices.getState(d.id)!.state).toMatchObject({ power: false, brightness: 35 })
  })

  it('waits for the gate to finish moving before saying done, then notifies', async () => {
    const d = t.add({ name: 'Main gate', simulate: 'gate' })
    const action = t.hub.actions.request(d.id, { type: 'gate.open' })
    await sleep(1500)
    expect(t.hub.actions.get(action.id)!.status).toBe('running')
    expect(t.hub.devices.getState(d.id)!.state.gate).toBe('opening')
    const done = await t.settle(action, 15000)
    expect(done.status).toBe('done')
    expect(done.result).toMatchObject({ gate: 'open' })
    expect(t.pushes.some((p) => p.title === 'Main gate: Open gate' && p.body === 'Gate is open')).toBe(true)
  }, 20000)

  it('fails over to another connection and retries when the first one has gone quiet', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    await t.hub.devices.check(d.id, { force: true })
    const live = t.hub.devices.activePath(d.id)!
    await getAdapter('virtual').setWifi!(t.hub.devices.context(t.hub.devices.unmasked(d.id), live), { ssid: 'Backup WiFi', password: 'x' })
    await sleep(4100)
    // The hub still believes the lamp is on Home WiFi.
    expect(t.hub.devices.activePath(d.id)!.id).toBe(d.paths[0]!.id)
    const done = await t.settle(t.hub.actions.request(d.id, { type: 'power.on' }))
    expect(done.status).toBe('done')
    expect(done.pathId).toBe(d.paths[1]!.id)
    expect(t.hub.devices.getState(d.id)!.state.power).toBe(true)
  }, 15000)

  it('fails with the reason when nothing answers', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light', paths: [{ priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: null, host: '192.168.1.10', port: 80 }] })
    await t.hub.devices.check(d.id, { force: true })
    await t.settle(t.hub.actions.request(d.id, { type: 'reboot' }))
    const failed = await t.settle(t.hub.actions.request(d.id, { type: 'power.on' }))
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/restarting|unreachable/i)
    expect(t.pushes.some((p) => /Turn on failed/.test(p.title))).toBe(true)
  })

  it('hands an SMS command to the phone and waits for the owner to confirm', async () => {
    const d = t.add({
      name: 'Main gate',
      simulate: 'gate',
      paths: [{ priority: 0, kind: 'sms', label: 'SMS', host: '9900000002' }],
    })
    const pending = await t.settle(t.hub.actions.request(d.id, { type: 'gate.open' }))
    expect(pending.status).toBe('needs-confirmation')
    expect(pending.finishedAt).toBeNull()
    expect(String(pending.result!.handoff)).toMatch(/^sms:\+919900000002\?body=/)
    expect(t.pushes.some((p) => /needs you/.test(p.title))).toBe(true)
    const confirmed = t.hub.actions.confirm(pending.id, true)
    expect(confirmed.status).toBe('done')
    expect(() => t.hub.actions.confirm(pending.id, true)).toThrow(/not waiting/)
  })

  it('takes a picture and keeps it', async () => {
    const d = t.add({ name: 'Cam', simulate: 'camera' })
    const done = await t.settle(t.hub.actions.request(d.id, { type: 'snapshot' }))
    expect(done.status).toBe('done')
    expect(done.result!.url).toBe(`/api/snapshots/${done.id}`)
    const file = t.hub.actions.snapshotFile(done.id)!
    expect(file.contentType).toBe('image/svg+xml')
    expect(fs.readFileSync(file.file, 'utf8')).toContain('<svg')
    expect(t.hub.actions.snapshotFile('../../etc/passwd')).toBeNull()
  })

  it('moves a camera to another WiFi, finds it there and switches over', async () => {
    const d = t.add({ name: 'Cam', simulate: 'camera' })
    await t.hub.devices.check(d.id, { force: true })
    const done = await t.settle(t.hub.actions.request(d.id, { type: 'wifi.set', params: { wifiNetworkId: t.backup } }), 30000)
    expect(done.status).toBe('done')
    expect(done.result).toMatchObject({ ssid: 'Backup WiFi', onTarget: true })
    expect(done.label).toBe('Move to Backup WiFi')
    const s = t.hub.devices.getState(d.id)!
    expect(s.activePathId).toBe(d.paths[1]!.id)
    expect(s.state.wifi).toBe('Backup WiFi')
    expect(t.events.some((e) => e.type === 'wifi.moving')).toBe(true)
    expect(t.events.some((e) => e.type === 'wifi.moved')).toBe(true)
    expect(t.pushes.some((p) => p.title === 'Cam: Move to Backup WiFi' && p.body === 'Now on Backup WiFi')).toBe(true)
  }, 40000)

  it('will not move a device to a network it has no password for', async () => {
    const d = t.add({ name: 'Cam', simulate: 'camera' })
    const open = t.hub.registry.createWifi({ ssid: 'Guest' })
    const failed = await t.settle(t.hub.actions.request(d.id, { type: 'wifi.set', params: { wifiNetworkId: open.id } }))
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/No password stored for "Guest"/)
  })

  it('lists the WiFi networks the device can see', async () => {
    const d = t.add({ name: 'Cam', simulate: 'camera' })
    const done = await t.settle(t.hub.actions.request(d.id, { type: 'wifi.scan' }))
    expect(done.status).toBe('done')
    const ssids = (done.result!.networks as Array<{ ssid: string }>).map((n) => n.ssid)
    expect(ssids).toEqual(expect.arrayContaining(['Home WiFi', 'Backup WiFi']))
  })

  it('pings the phone only as much as each device is set to', async () => {
    const quietLamp = t.add({ name: 'Quiet lamp', simulate: 'light' }) // default: important
    const chattyLamp = t.add({ name: 'Chatty lamp', simulate: 'light', notify: 'everything' })
    const silent = t.add({ name: 'Silent lamp', simulate: 'light', notify: 'none', paths: [{ priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: null, host: '192.168.1.10', port: 80 }] })
    expect(t.hub.registry.getDevice(quietLamp.id)!.notify).toBe('important')

    await t.settle(t.hub.actions.request(quietLamp.id, { type: 'power.on' }))
    expect(t.pushes.filter((p) => p.title.startsWith('Quiet lamp'))).toHaveLength(0)

    await t.settle(t.hub.actions.request(chattyLamp.id, { type: 'power.on' }))
    expect(t.pushes.some((p) => p.title === 'Chatty lamp: Turn on' && p.body === 'Now on')).toBe(true)

    await t.hub.devices.check(silent.id, { force: true })
    await t.settle(t.hub.actions.request(silent.id, { type: 'reboot' }))
    const failed = await t.settle(t.hub.actions.request(silent.id, { type: 'power.on' }))
    expect(failed.status).toBe('failed')
    await t.hub.devices.check(silent.id, { force: true })
    expect(t.pushes.filter((p) => p.title.startsWith('Silent lamp'))).toHaveLength(0)
    // the activity feed still has it
    expect(t.events.some((e) => e.type === 'action.failed' && e.message.startsWith('Silent lamp'))).toBe(true)

    expect(() => t.hub.registry.updateDevice(quietLamp.id, { notify: 'loud' as never })).toThrow(/notification level/)
    expect(t.hub.registry.updateDevice(quietLamp.id, { notify: 'problems' }).notify).toBe('problems')
  })

  it('pins and unpins a connection through actions', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    const failed = await t.settle(t.hub.actions.request(d.id, { type: 'path.switch', params: { pathId: d.paths[1]!.id } }))
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('Backup WiFi is not answering')
    const ok = await t.settle(t.hub.actions.request(d.id, { type: 'path.switch', params: { pathId: d.paths[0]!.id } }))
    expect(ok.status).toBe('done')
    expect(t.hub.devices.getState(d.id)!.pinnedPathId).toBe(d.paths[0]!.id)
    await t.settle(t.hub.actions.request(d.id, { type: 'path.switch', params: { pathId: null } }))
    expect(t.hub.devices.getState(d.id)!.pinnedPathId).toBeNull()
  })
})
