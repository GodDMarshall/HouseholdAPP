import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAdapter } from '../../src/adapters/index.ts'
import { makeHub, sleep, type TestHub } from './harness.ts'

let t: TestHub
beforeEach(async () => {
  t = await makeHub()
})
afterEach(async () => {
  await t.close()
})

/** Move the illustrative device to another network behind the hub's back, like a router change would. */
async function moveBehindTheHub(deviceId: string, ssid: string): Promise<void> {
  const device = t.hub.devices.unmasked(deviceId)
  const live = t.hub.devices.activePath(deviceId)!
  await getAdapter('virtual').setWifi!(t.hub.devices.context(device, live), { ssid, password: 'x' })
  await sleep(4100) // the device is away while it joins
}

describe('connection paths', () => {
  it('uses the first path that answers and says so', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    const s = await t.hub.devices.check(d.id, { force: true })
    expect(s.online).toBe(true)
    expect(s.activePathId).toBe(d.paths[0]!.id)
    expect(s.summary).toMatch(/^On Home WiFi/)
    expect(s.paths.find((p) => p.pathId === d.paths[0]!.id)!.status).toBe('up')
    expect(s.paths.find((p) => p.pathId === d.paths[1]!.id)!.status).toBe('down')
    expect(s.paths.find((p) => p.pathId === d.paths[1]!.id)!.error).toMatch(/Device is on "Home WiFi"/)
  })

  it('fails over when the device leaves the first network, then back again', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    await t.hub.devices.check(d.id, { force: true })
    await moveBehindTheHub(d.id, 'Backup WiFi')
    const over = await t.hub.devices.check(d.id)
    expect(over.online).toBe(true)
    expect(over.activePathId).toBe(d.paths[1]!.id)
    expect(t.events.some((e) => e.type === 'path.switched' && /switched from Home WiFi to Backup WiFi/.test(e.message))).toBe(true)
    expect(t.pushes.some((p) => /now on Backup WiFi/.test(p.title))).toBe(true)

    await moveBehindTheHub(d.id, 'Home WiFi')
    // fail-back happens on a sweep tick, not necessarily the next check
    let back = await t.hub.devices.check(d.id)
    if (back.activePathId !== d.paths[0]!.id) back = await t.hub.devices.check(d.id)
    expect(back.activePathId).toBe(d.paths[0]!.id)
    expect(t.events.some((e) => e.type === 'path.restored')).toBe(true)
  }, 20000)

  it('reports unreachable once every path is down and announces the return', async () => {
    const d = t.add({ name: 'Cam', simulate: 'camera', paths: [{ priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: null, host: '192.168.1.10', port: 80 }] })
    await t.hub.devices.check(d.id, { force: true })
    t.hub.actions.request(d.id, { type: 'reboot' })
    await sleep(300)
    const down = await t.hub.devices.check(d.id, { force: true })
    expect(down.online).toBe(false)
    expect(down.summary).toBe('Unreachable on all connections')
    expect(t.events.some((e) => e.type === 'device.offline')).toBe(true)
    await sleep(5200)
    const up = await t.hub.devices.check(d.id, { force: true })
    expect(up.online).toBe(true)
    expect(t.events.some((e) => e.type === 'device.online')).toBe(true)
  }, 15000)

  it('explains a SIM behind carrier NAT and never treats it as reachable', async () => {
    const d = t.add({
      name: 'Cam',
      simulate: 'camera',
      paths: [
        { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '192.168.1.10', port: 80 },
        { priority: 1, kind: 'cellular', label: 'SIM', host: '100.72.1.9', port: 80 },
      ],
    })
    const s = await t.hub.devices.check(d.id, { force: true })
    const sim = s.paths.find((p) => p.pathId === d.paths[1]!.id)!
    expect(sim.status).toBe('down')
    expect(sim.error).toMatch(/private address/)
  })

  it('pins a working path by hand, and refuses to leave a pin on a dead one', async () => {
    const d = t.add({
      name: 'Gate',
      simulate: 'gate',
      paths: [
        { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '192.168.1.10', port: 80 },
        { priority: 1, kind: 'lan', label: 'Backup WiFi', wifiNetworkId: t.backup, host: '192.168.8.10', port: 80 },
        { priority: 2, kind: 'sms', label: 'SMS', host: '+919900000002' },
      ],
    })
    await t.hub.devices.check(d.id, { force: true })
    const sms = d.paths[2]!
    const pinned = await t.hub.devices.pinPath(d.id, sms.id)
    expect(pinned.activePathId).toBe(sms.id)
    expect(pinned.pinnedPathId).toBe(sms.id)
    expect(pinned.summary).toMatch(/SMS only/)

    const dead = await t.hub.devices.pinPath(d.id, d.paths[1]!.id)
    expect(dead.pinnedPathId).toBeNull()
    expect(dead.activePathId).toBe(d.paths[0]!.id)
    expect(t.events.some((e) => e.type === 'path.pin-failed')).toBe(true)

    const auto = await t.hub.devices.pinPath(d.id, null)
    expect(auto.pinnedPathId).toBeNull()
    expect(auto.activePathId).toBe(d.paths[0]!.id)
  })

  it('skips paths the owner turned off', async () => {
    const d = t.add({
      name: 'Lamp',
      simulate: 'light',
      paths: [
        { priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '192.168.1.10', port: 80, enabled: false },
        { priority: 1, kind: 'sms', label: 'SMS', host: '+919900000002' },
      ],
    })
    const s = await t.hub.devices.check(d.id, { force: true })
    expect(s.activePathId).toBe(d.paths[1]!.id)
    expect(s.paths.find((p) => p.pathId === d.paths[0]!.id)!.status).toBe('disabled')
  })

  it('keeps the active path and state across a hub restart', async () => {
    const d = t.add({ name: 'Lamp', simulate: 'light' })
    await t.hub.devices.check(d.id, { force: true })
    await t.settle(t.hub.actions.request(d.id, { type: 'power.on' }))
    const row = t.hub.db.prepare('SELECT active_path_id, state FROM device_runtime WHERE device_id = ?').get(d.id) as { active_path_id: string; state: string }
    expect(row.active_path_id).toBe(d.paths[0]!.id)
    expect(JSON.parse(row.state).power).toBe(true)
  })
})
