import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { TINY_JPEG } from '../helpers.ts'
import { makeHub, sleep, type TestHub } from './harness.ts'

interface FakeGo2rtc {
  url: string
  port: number
  calls: Array<{ method: string; path: string; query: URLSearchParams }>
  streams: Map<string, string[]>
  wsClients: Array<{ src: string | null; origin: string | undefined }>
  close(): Promise<void>
}

/** Stands in for go2rtc: the same HTTP API and WebSocket endpoint the hub talks to. */
function fakeGo2rtc(): Promise<FakeGo2rtc> {
  const calls: FakeGo2rtc['calls'] = []
  const streams = new Map<string, string[]>()
  const wsClients: FakeGo2rtc['wsClients'] = []
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    calls.push({ method: req.method ?? 'GET', path: u.pathname, query: u.searchParams })
    if (u.pathname === '/api') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ version: '1.9.14' }))
    }
    if (u.pathname === '/api/streams' && req.method === 'PUT') {
      streams.set(u.searchParams.get('name')!, u.searchParams.getAll('src'))
      res.writeHead(200)
      return res.end()
    }
    if (u.pathname === '/api/streams' && req.method === 'DELETE') {
      streams.delete(u.searchParams.get('src')!)
      res.writeHead(200)
      return res.end()
    }
    if (u.pathname === '/api/frame.jpeg') {
      if (!streams.has(u.searchParams.get('src') ?? '')) {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'image/jpeg' })
      return res.end(TINY_JPEG)
    }
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ server, path: '/api/ws' })
  wss.on('connection', (socket, req) => {
    const u = new URL(req.url ?? '/', 'http://x')
    wsClients.push({ src: u.searchParams.get('src'), origin: req.headers.origin })
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      const msg = JSON.parse(String(data)) as { type: string; value: string }
      if (msg.type === 'mse') {
        socket.send(JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' }))
        socket.send(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), { binary: true })
      }
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        calls,
        streams,
        wsClients,
        close: () =>
          new Promise<void>((done) => {
            for (const c of wss.clients) c.terminate()
            wss.close()
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      })
    }),
  )
}

let t: TestHub | null = null
let go: FakeGo2rtc | null = null
afterEach(async () => {
  await t?.hub.video.stop()
  await t?.close()
  await go?.close()
  t = null
  go = null
})

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await sleep(50)
  }
}

describe('live video', () => {
  it('keeps one go2rtc stream per camera, sourced from the live connection, and never shows the app the camera login', async () => {
    go = await fakeGo2rtc()
    t = await makeHub({ go2rtcUrl: go.url })
    await t.hub.video.start()
    expect(t.hub.video.status).toMatchObject({ go2rtc: 'running', version: '1.9.14' })

    // The camera "answers" on the fake server's port, so the path probes as up.
    const cam = t.hub.registry.createDevice({
      name: 'Yard',
      kind: 'camera',
      family: 'rtsp',
      room: '',
      config: { username: 'admin', password: 'p@ss', streamUrl: 'rtsp://{user}:{pass}@{host}:{port}/Streaming/Channels/101' },
      paths: [{ priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: t.home, host: '127.0.0.1', port: go.port }],
    })
    await t.hub.devices.check(cam.id, { force: true })
    await until(() => go!.streams.has(cam.id))
    expect(go.streams.get(cam.id)).toEqual([`rtsp://admin:p%40ss@127.0.0.1:${go.port}/Streaming/Channels/101`])
    expect(t.hub.video.hasStream(cam.id)).toBe(true)

    const info = await t.hub.app.inject({ method: 'GET', url: `/api/devices/${cam.id}/stream`, headers: { authorization: `Bearer ${t.token()}` } })
    expect(info.json()).toMatchObject({ available: true, name: cam.id, canSnapshot: true })
    expect(info.body).not.toContain('p@ss')
    expect(info.body).not.toContain('rtsp://')

    // No still-picture address on this camera: the picture is cut from the video.
    const pic = await t.hub.app.inject({ method: 'GET', url: `/api/devices/${cam.id}/snapshot`, headers: { authorization: `Bearer ${t.token()}` } })
    expect(pic.statusCode).toBe(200)
    expect(pic.headers['content-type']).toBe('image/jpeg')
    expect(pic.rawPayload.equals(TINY_JPEG)).toBe(true)

    // Editing the camera re-points the stream; removing it removes the stream.
    t.hub.registry.updateDevice(cam.id, { config: { username: 'admin', password: 'p@ss', streamUrl: 'rtsp://{user}:{pass}@{host}:{port}/Streaming/Channels/102' } })
    await until(() => go!.streams.get(cam.id)?.[0]?.endsWith('/102') === true)
    t.hub.registry.deleteDevice(cam.id)
    await until(() => !go!.streams.has(cam.id))
    expect(go.calls.some((c) => c.method === 'DELETE' && c.query.get('src') === cam.id)).toBe(true)
  })

  it('relays the video socket to signed-in phones only, without an Origin go2rtc could reject', async () => {
    go = await fakeGo2rtc()
    t = await makeHub({ go2rtcUrl: go.url })
    await t.hub.video.start()
    const cam = t.hub.registry.createDevice({
      name: 'Yard',
      kind: 'camera',
      family: 'rtsp',
      room: '',
      config: {},
      paths: [{ priority: 0, kind: 'lan', label: 'Home WiFi', wifiNetworkId: null, host: '127.0.0.1', port: go.port }],
    })
    await t.hub.devices.check(cam.id, { force: true })
    await until(() => go!.streams.has(cam.id))
    await t.hub.app.listen({ port: 0, host: '127.0.0.1' })
    const port = (t.hub.app.server.address() as AddressInfo).port

    const refused = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/video/api/ws?src=${cam.id}`)
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('open', () => resolve(101))
      ws.on('error', () => undefined)
    })
    expect(refused).toBe(401)

    const got: Array<string | Buffer> = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/video/api/ws?src=${cam.id}&token=${t.token()}`, { origin: `http://127.0.0.1:${port}` })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'mse', value: 'avc1.640029' })))
      ws.on('message', (data, isBinary) => {
        got.push(isBinary ? (data as Buffer) : String(data))
        if (got.length === 2) resolve()
      })
      ws.on('error', reject)
      setTimeout(() => reject(new Error('no video frames relayed')), 4000)
    })
    ws.close()
    expect(JSON.parse(got[0] as string)).toEqual({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' })
    expect(Buffer.isBuffer(got[1])).toBe(true)
    expect((got[1] as Buffer).subarray(4, 8).toString()).toBe('ftyp')
    expect(go.wsClients[0]).toMatchObject({ src: cam.id, origin: undefined })

    const unknown = await new Promise<number>((resolve) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}/video/api/ws?src=rtsp://evil/x&token=${t!.token()}`)
      w.on('close', (code) => resolve(code))
      w.on('error', () => undefined)
    })
    expect(unknown).toBe(4404)
  })

  it('says so plainly when the video service is down, and stills still work', async () => {
    t = await makeHub({ go2rtcUrl: 'http://127.0.0.1:9' })
    await t.hub.video.start()
    expect(t.hub.video.status.go2rtc).toBe('error')
    expect(t.hub.video.status.detail).toMatch(/not answering/)
    const cam = t.add({ name: 'Cam', simulate: 'camera' })
    await t.hub.devices.check(cam.id, { force: true })
    const pic = await t.hub.app.inject({ method: 'GET', url: `/api/devices/${cam.id}/snapshot`, headers: { authorization: `Bearer ${t.token()}` } })
    expect(pic.statusCode).toBe(200)
  })
})
