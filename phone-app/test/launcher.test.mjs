// node --test: the launcher's address handling, without a WebView.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_HUBS, forget, hint, label, loadKnown, loadLast, normalise, order, pick, reachable, remember } from '../www/launcher.js'

const memory = () => {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

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
    assert.equal(normalise('ftp://x'), null)
    assert.equal(normalise(undefined), null)
  })
})

describe('order', () => {
  it('tries the last one that worked first, then known ones, then the defaults, with no repeats', () => {
    assert.deepEqual(order(['http://10.0.0.5:8080', '192.168.1.7'], '100.124.59.5'), ['http://100.124.59.5:8080', 'http://10.0.0.5:8080', 'http://192.168.1.7:8080'])
    assert.deepEqual(order([], null), DEFAULT_HUBS)
  })
  it('drops rubbish from storage', () => {
    assert.deepEqual(order(['??', ''], 'nope!'), DEFAULT_HUBS)
  })
})

describe('pick', () => {
  it('returns the first candidate in preference order that answered, probing all at once', async () => {
    const asked = []
    const probe = async (c) => {
      asked.push(c)
      return c.includes('100.')
    }
    assert.equal(await pick(['http://192.168.1.7:8080', 'http://100.124.59.5:8080'], probe), 'http://100.124.59.5:8080')
    assert.deepEqual(asked, ['http://192.168.1.7:8080', 'http://100.124.59.5:8080'])
    assert.equal(await pick(['http://192.168.1.7:8080'], async () => false), null)
    assert.equal(await pick([], probe), null)
  })
})

describe('reachable', () => {
  it('counts any HTTP answer as a hub, and nothing as not', async () => {
    assert.equal(await reachable('http://h:8080', { fetchImpl: async () => ({ ok: false, type: 'opaque' }) }), true)
    assert.equal(
      await reachable('http://h:8080', {
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch')
        },
      }),
      false,
    )
  })
  it('gives up after the timeout', async () => {
    const t = Date.now()
    const never = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    assert.equal(await reachable('http://h:8080', { timeoutMs: 60, fetchImpl: never }), false)
    assert.ok(Date.now() - t < 1000)
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
  it('survives storage that is switched off', () => {
    const broken = { getItem: () => { throw new Error('off') }, setItem: () => { throw new Error('off') }, removeItem: () => { throw new Error('off') } }
    assert.doesNotThrow(() => remember(broken, 'http://h:8080'))
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
