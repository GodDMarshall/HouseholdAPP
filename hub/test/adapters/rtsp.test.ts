import { afterEach, describe, expect, it } from 'vitest'
import adapter from '../../src/adapters/rtsp.ts'
import { digestGuard, makeAction, makeCtx, mockServer, send, TINY_JPEG, type MockServer } from '../helpers.ts'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

describe('rtsp adapter', () => {
  it('describes itself for the add-device form', () => {
    const d = adapter.describe()
    expect(d.id).toBe('rtsp')
    expect(d.kinds).toContain('camera')
    expect(d.fields.find((f) => f.name === 'password')?.secret).toBe(true)
    expect(adapter.capabilities({}, 'camera')).toEqual(expect.arrayContaining(['stream', 'snapshot']))
  })

  it('probes the camera port', async () => {
    server = await mockServer((_req, res) => send(res, 200, 'ok'))
    const up = await adapter.probe(makeCtx({ family: 'rtsp', path: { port: server.port } }))
    expect(up.ok).toBe(true)
    const port = server.port
    await server.close()
    server = null
    const down = await adapter.probe(makeCtx({ family: 'rtsp', path: { port } }))
    expect(down.ok).toBe(false)
    expect(down.error).toMatch(/refused|did not answer/)
  })

  it('builds the go2rtc source from the template, encoding the login', () => {
    const ctx = makeCtx({
      family: 'rtsp',
      config: { streamUrl: 'rtsp://{user}:{pass}@{host}:{port}/Streaming/Channels/101', username: 'admin', password: 'p@ss/word' },
      path: { host: '192.168.1.50', port: 554 },
    })
    expect(adapter.streamSources!(ctx)).toEqual(['rtsp://admin:p%40ss%2Fword@192.168.1.50:554/Streaming/Channels/101'])
  })

  it('drops the login part when the camera has none', () => {
    const ctx = makeCtx({ family: 'rtsp', config: {}, path: { host: '10.0.0.9', port: 8554 } })
    expect(adapter.streamSources!(ctx)).toEqual(['rtsp://10.0.0.9:8554/stream1'])
  })

  it('fetches a still through digest auth', async () => {
    const guard = digestGuard('admin', 'secret')
    server = await mockServer((req, res) => {
      if (!guard(req, res)) return
      if (req.path === '/snapshot.jpg') return send(res, 200, TINY_JPEG, 'image/jpeg')
      send(res, 404, 'no')
    })
    const ctx = makeCtx({
      family: 'rtsp',
      config: { username: 'admin', password: 'secret', snapshotUrl: `http://{host}:${server.port}/snapshot.jpg` },
    })
    const snap = await adapter.snapshot!(ctx)
    expect(snap.contentType).toBe('image/jpeg')
    expect(snap.body.equals(TINY_JPEG)).toBe(true)
    const wrong = makeCtx({ family: 'rtsp', config: { username: 'admin', password: 'nope', snapshotUrl: `http://{host}:${server.port}/snapshot.jpg` } })
    await expect(adapter.snapshot!(wrong)).rejects.toThrow(/refused the username or password/)
  })

  it('refuses commands it cannot do', async () => {
    const res = await adapter.execute(makeCtx({ family: 'rtsp' }), makeAction('ptz.move', { pan: 1 }))
    expect(res.ok).toBe(false)
  })
})
