// node --test: the launcher's address handling, without a WebView.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_HUBS, forget, hint, isHub, label, loadKnown, loadLast, normalise, order, pick, remember, subnetsOf, sweep } from '../www/launcher.js'

const memory = () => {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
const HELLO = { app: 'house-control', name: 'DESKTOP', version: '0.1.0', port: 8080, addresses: ['192.168.1.5', '100.124.59.5'] }
const jsonResponse = (body, ok = true) => ({ ok, json: async () => body })

describe('normalise', () => {
  it('fills in the scheme and the hub port', () => {
    assert.equal(normalise('192.168.1.7'), 'http://192.168.1.7:8080')
    assert.equal(normalise('  192.168.1.7:8080 '), 'http://192.168.1.7:8080')
    assert.equal(normalise('http://192.168.1.7:8080/'), 'http://192.168.1.7:8080')
    assert.equal(normalise('192.168.1.7:9000'), 'http://192.168.1.7:9000')
  })
  it('keeps an https Tailscale address as typed', () => {
    assert.equal(normalise('https://house.tail1234.ts.net'), 'https://house.tail1234.ts.net')
    assert.equal(normalise('https://house.tail1234.ts.net/settings'), 'https://house.tail1234.ts.net')
  })
  it('refuses what is not an address', () => {
    assert.equal(normalise(''), null)
    assert.equal(normalise('   '), null)
    assert.equal(normalise('not an address!'), null)
    assert.equal(normalise('nope!'), null)
    assert.equal(normalise('ftp://x'), null)
    assert.equal(normalise(undefined), null)
  })
})

describe('order', () => {
  it('tries the last one that worked first, then known ones, then the defaults, with no repeats', () => {
    assert.deepEqual(order(['http://10.0.0.5:8080', '192.168.1.7'], '100.124.59.5'), ['http://100.124.59.5:8080', 'http://10.0.0.5:8080', 'http://192.168.1.7:8080', 'http://192.168.1.5:8080'])
    assert.deepEqual(order([], null), DEFAULT_HUBS)
  })
  it('drops rubbish from storage', () => {
    assert.deepEqual(order(['??', ''], 'nope!'), DEFAULT_HUBS)
  })
})

describe('isHub', () => {
  it('counts only a House Control answer as a hub', async () => {
    assert.deepEqual(await isHub('http://h:8080', { fetchImpl: async () => jsonResponse(HELLO) }), HELLO)
    assert.equal(await isHub('http://h:8080', { fetchImpl: async () => jsonResponse({ app: 'recorder-web-ui' }) }), null)
    assert.equal(await isHub('http://h:8080', { fetchImpl: async () => jsonResponse({}, false) }), null)
    assert.equal(await isHub('http://h:8080', { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('not json') } }) }), null)
    assert.equal(
      await isHub('http://h:8080', {
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch')
        },
      }),
      null,
    )
  })
  it('asks /api/hello across origins and gives up after the timeout', async () => {
    let asked = null
    await isHub('http://h:8080', { fetchImpl: async (url, init) => ((asked = { url, mode: init.mode }), jsonResponse(HELLO)) })
    assert.deepEqual(asked, { url: 'http://h:8080/api/hello', mode: 'cors' })
    const t = Date.now()
    const never = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    assert.equal(await isHub('http://h:8080', { timeoutMs: 60, fetchImpl: never }), null)
    assert.ok(Date.now() - t < 1000)
  })
})

describe('pick', () => {
  it('returns the first candidate in preference order that is a hub, probing all at once', async () => {
    const asked = []
    const probe = async (c) => {
      asked.push(c)
      return c.includes('100.') ? HELLO : null
    }
    assert.deepEqual(await pick(['http://192.168.1.7:8080', 'http://100.124.59.5:8080'], probe), { base: 'http://100.124.59.5:8080', hello: HELLO })
    assert.deepEqual(asked, ['http://192.168.1.7:8080', 'http://100.124.59.5:8080'])
    assert.equal(await pick(['http://192.168.1.7:8080'], async () => null), null)
    assert.equal(await pick([], probe), null)
  })
})

describe('subnetsOf and sweep', () => {
  it('finds the house networks behind the addresses, leaving Tailscale and names out', () => {
    assert.deepEqual(subnetsOf(['http://192.168.1.7:8080', 'http://192.168.1.5:8080', 'http://100.124.59.5:8080', 'https://house.tail1234.ts.net', 'http://10.0.0.9:8080', 'rubbish']), ['192.168.1', '10.0.0'])
  })
  it('asks every address on the network a few dozen at a time and stops at the first hub', async () => {
    const asked = []
    let inFlight = 0
    let peak = 0
    const probe = async (base) => {
      asked.push(base)
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return base === 'http://192.168.1.37:8080' ? HELLO : null
    }
    const found = await sweep(['192.168.1', '192.168.0'], { probe, skip: ['http://192.168.1.7:8080'] })
    assert.deepEqual(found, { base: 'http://192.168.1.37:8080', hello: HELLO })
    assert.ok(asked.includes('http://192.168.1.1:8080') && asked.includes('http://192.168.1.37:8080'))
    assert.ok(!asked.includes('http://192.168.1.7:8080'), 'a known address is not asked twice')
    assert.ok(!asked.includes('http://192.168.0.200:8080'), 'stops before the second network once a hub answered')
    assert.ok(peak <= 40 && peak > 1, `probes ran ${peak} at a time`)
  })
  it('returns null when no address is a hub', async () => {
    assert.equal(await sweep(['192.168.0'], { probe: async () => null }), null)
    assert.equal(await sweep([], { probe: async () => HELLO }), null)
  })
})

describe('remember and forget', () => {
  it('keeps the last one first and at most eight', () => {
    const s = memory()
    for (let i = 1; i <= 10; i++) remember(s, `http://10.0.0.${i}:8080`)
    assert.equal(loadLast(s), 'http://10.0.0.10:8080')
    assert.equal(loadKnown(s).length, 8)
    assert.equal(loadKnown(s)[0], 'http://10.0.0.10:8080')
    remember(s, 'http://10.0.0.3:8080')
    assert.equal(loadKnown(s)[0], 'http://10.0.0.3:8080')
    assert.equal(loadKnown(s).filter((x) => x === 'http://10.0.0.3:8080').length, 1)
    forget(s, 'http://10.0.0.3:8080')
    assert.equal(loadLast(s), null)
    assert.ok(!loadKnown(s).includes('http://10.0.0.3:8080'))
  })
  it('also remembers every address the hub says it has, so a move is found without a sweep next time', () => {
    const s = memory()
    remember(s, 'http://192.168.1.5:8080', HELLO)
    assert.deepEqual(loadKnown(s), ['http://192.168.1.5:8080', 'http://100.124.59.5:8080'])
    remember(s, 'http://100.124.59.5:8080', { ...HELLO, port: 9000, addresses: ['192.168.1.9', 'bad address!'] })
    assert.deepEqual(loadKnown(s), ['http://100.124.59.5:8080', 'http://192.168.1.9:9000', 'http://192.168.1.5:8080'])
  })
  it('survives storage that is switched off', () => {
    const broken = { getItem: () => { throw new Error('off') }, setItem: () => { throw new Error('off') }, removeItem: () => { throw new Error('off') } }
    assert.doesNotThrow(() => remember(broken, 'http://h:8080', HELLO))
    assert.doesNotThrow(() => forget(broken, 'http://h:8080'))
    assert.deepEqual(loadKnown(broken), [])
    assert.equal(loadLast(broken), null)
  })
})

describe('label and hint', () => {
  it('shows the short form and says where the phone has to be', () => {
    assert.equal(label('http://192.168.1.7:8080'), '192.168.1.7')
    assert.equal(label('http://192.168.1.7:9000'), '192.168.1.7:9000')
    assert.equal(hint('http://192.168.1.7:8080'), 'On the house WiFi')
    assert.equal(hint('http://100.124.59.5:8080'), 'Through Tailscale, from anywhere')
    assert.equal(hint('https://house.tail1234.ts.net'), 'Through Tailscale, from anywhere (secure)')
    assert.equal(hint('https://example.org'), '')
  })
})
