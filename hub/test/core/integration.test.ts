/**
 * A real adapter through the whole hub: a relay board with plain web addresses
 * (the "http-relay" family) is added over the API, checked, switched, and
 * followed from one address to another when the first stops answering.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Action, Device, DeviceState } from '@house/shared'
import { mockServer, send, type MockServer } from '../helpers.ts'
import { makeHub, type TestHub } from './harness.ts'

interface Relay {
  server: MockServer
  on: boolean
  hits: string[]
}

async function relayBoard(): Promise<Relay> {
  const relay = { on: false, hits: [] as string[] } as Relay
  relay.server = await mockServer((req, res) => {
    relay.hits.push(`${req.method} ${req.path}`)
    if (req.path === '/relay/on') relay.on = true
    else if (req.path === '/relay/off') relay.on = false
    else if (req.path !== '/relay/state') return send(res, 404, 'no such address')
    send(res, 200, { relay: relay.on ? 'on' : 'off' })
  })
  return relay
}

let t: TestHub | null = null
const boards: Relay[] = []
afterEach(async () => {
  await t?.close()
  t = null
  for (const b of boards.splice(0)) await b.server.close()
})

describe('a relay board, end to end', () => {
  it('is added, tested, switched and followed to its second address', async () => {
    t = await makeHub()
    const hub = t.hub
    const headers = { authorization: `Bearer ${t.token()}` }
    const main = await relayBoard()
    const spare = await relayBoard()
    boards.push(main, spare)

    const input = {
      name: 'Pump',
      kind: 'switch',
      family: 'http-relay',
      room: 'Garden',
      config: { onPath: '/relay/on', offPath: '/relay/off', statePath: '/relay/state', stateOnMatch: 'relay=on' },
      paths: [
        { kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '127.0.0.1', port: main.server.port },
        { kind: 'lan', label: 'Backup WiFi', wifiNetworkId: t.backup, host: '127.0.0.1', port: spare.server.port },
      ],
    }

    // "Test the connections" before saving, exactly as the wizard does.
    const test = await hub.app.inject({ method: 'POST', url: '/api/devices/test', headers, payload: input })
    expect(test.statusCode).toBe(200)
    const tested = test.json() as { capabilities: string[]; results: Array<{ label: string; ok: boolean }> }
    expect(tested.results.map((r) => r.ok)).toEqual([true, true])
    expect(tested.capabilities).toContain('power')
    expect(main.on).toBe(false) // a test never switches anything

    const created = await hub.app.inject({ method: 'POST', url: '/api/devices', headers, payload: input })
    expect(created.statusCode).toBe(201)
    const device = created.json() as Device

    const first = await hub.devices.check(device.id, { force: true })
    expect(first.online).toBe(true)
    expect(first.activePathId).toBe(device.paths[0]!.id)
    expect(first.state.power).toBe(false)

    // Switch it on through the API.
    const posted = await hub.app.inject({ method: 'POST', url: `/api/devices/${device.id}/actions`, headers, payload: { type: 'power.on' } })
    expect(posted.statusCode).toBe(202)
    const done = await t.settle(posted.json() as Action)
    expect(done.status).toBe('done')
    expect(main.on).toBe(true)
    expect(main.hits).toContain('GET /relay/on')
    expect(spare.hits.filter((h) => h.includes('/relay/on'))).toHaveLength(0)
    expect((await hub.app.inject({ method: 'GET', url: `/api/devices/${device.id}/state`, headers })).json().state.power).toBe(true)

    // The first address goes quiet (router reset). The next command still arrives, on the second.
    await main.server.close()
    const off = await t.settle(hub.actions.request(device.id, { type: 'power.on' }))
    expect(off.status).toBe('done')
    expect(off.pathId).toBe(device.paths[1]!.id)
    expect(spare.on).toBe(true)
    const state = (await hub.app.inject({ method: 'GET', url: `/api/devices/${device.id}/state`, headers })).json() as DeviceState
    expect(state.activePathId).toBe(device.paths[1]!.id)
    expect(state.summary).toMatch(/^On Backup WiFi/)
    expect(t.events.some((e) => e.type === 'path.switched' && /Pump switched from Home WiFi to Backup WiFi/.test(e.message))).toBe(true)

    // Both gone: the command fails with a reason, and the phone is told.
    await spare.server.close()
    const failed = await t.settle(hub.actions.request(device.id, { type: 'power.off' }))
    expect(failed.status).toBe('failed')
    expect(failed.error).toBeTruthy()
    expect(failed.error).not.toMatch(/undefined|\[object/)
    expect(t.pushes.some((p) => p.title === 'Pump: Turn off failed')).toBe(true)
    expect((await hub.devices.check(device.id, { force: true })).online).toBe(false)
  }, 30000)
})
