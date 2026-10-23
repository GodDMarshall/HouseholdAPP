// The Android shell's launcher: find the hub and open the phone app inside the shell.
//
// The shell carries no copy of the app. It opens the hub's own address in its
// WebView, so the phone always runs whatever the hub serves, and an update to
// the app never needs a new APK. This file is plain JavaScript with no
// dependencies so it can be unit-tested with "node --test" and run in the
// WebView as a module.

/** Where the hub has been seen: on the house WiFi, and through Tailscale when away. Only hints; the sweep finds a hub that moved. */
export const DEFAULT_HUBS = ['http://192.168.1.5:8080', 'http://192.168.1.7:8080', 'http://100.124.59.5:8080']
/** House networks to look around when no known address answers (the router hands out addresses here). */
export const DEFAULT_SUBNETS = ['192.168.1', '192.168.0']
export const HUB_PORT = 8080

const LAST_KEY = 'hc.shell.hub'
const KNOWN_KEY = 'hc.shell.hubs'
const MAX_KNOWN = 8

/** "192.168.1.7" -> "http://192.168.1.7:8080"; "https://house.tail1234.ts.net" stays as typed. Null when it is not an address. */
export function normalise(input) {
  let s = String(input ?? '').trim()
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s
  let url
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) return null
  // An address is numbers with dots or a plain name with dots: "nope!" parses as a URL but is not one.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(url.hostname)) return null
  if (!url.port && url.protocol === 'http:') url.port = String(HUB_PORT)
  return url.origin
}

/** The addresses to try, the last one that worked first, with no repeats. */
export function order(known, last) {
  const out = []
  for (const c of [last, ...known, ...DEFAULT_HUBS]) {
    const n = normalise(c)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

/**
 * Is a House Control hub at this address? The hub answers /api/hello to any
 * origin, with no sign-in, saying who it is and every address it has. Only that
 * answer counts: a router, a recorder or any other web page at the address is
 * not a hub. Returns the hub's answer, or null.
 */
export async function isHub(base, { timeoutMs = 2500, fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(base + '/api/hello', { mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const data = await res.json()
    return data && data.app === 'house-control' ? data : null
  } catch {
    return null
  }
}

/** Probe every candidate at once; return the first in preference order that is a hub, as { base, hello }, or null. */
export async function pick(candidates, probe = isHub) {
  const answers = await Promise.all(candidates.map((c) => probe(c)))
  const i = answers.findIndex(Boolean)
  return i >= 0 ? { base: candidates[i], hello: answers[i] } : null
}

/** The house networks behind a list of addresses: "http://192.168.1.7:8080" -> "192.168.1". Tailscale addresses are not networks to look around. */
export function subnetsOf(bases) {
  const out = []
  for (const b of bases) {
    let host
    try {
      host = new URL(b).hostname
    } catch {
      continue
    }
    const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(host)
    if (!m || m[1].startsWith('100.') || out.includes(m[1])) continue
    out.push(m[1])
  }
  return out
}

/**
 * Look around the house network for a hub that moved: ask every address on each
 * subnet, a few dozen at a time, and stop at the first that answers as a hub.
 * A WebView cannot know the phone's own address, so the networks come from the
 * addresses that worked before plus the usual home ranges.
 */
export async function sweep(subnets, { probe = isHub, port = HUB_PORT, skip = [], concurrency = 40, timeoutMs = 1200 } = {}) {
  const todo = []
  for (const s of subnets) for (let n = 1; n <= 254; n++) {
    const base = `http://${s}.${n}:${port}`
    if (!skip.includes(base)) todo.push(base)
  }
  let found = null
  let next = 0
  const worker = async () => {
    while (!found && next < todo.length) {
      const base = todo[next++]
      const hello = await probe(base, { timeoutMs })
      if (hello && !found) found = { base, hello }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker))
  return found
}

export function loadKnown(storage) {
  try {
    const raw = storage.getItem(KNOWN_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function loadLast(storage) {
  try {
    return storage.getItem(LAST_KEY) || null
  } catch {
    return null
  }
}

/**
 * Remember an address that worked: it becomes the first choice next time. The
 * hub's own answer lists every address it has (house WiFi and Tailscale), so
 * those are remembered too and the next start tries them without a sweep.
 */
export function remember(storage, base, hello = null) {
  try {
    storage.setItem(LAST_KEY, base)
    const port = hello && Number.isInteger(hello.port) ? hello.port : HUB_PORT
    const others = Array.isArray(hello?.addresses) ? hello.addresses.map((a) => normalise(`${a}:${port}`)).filter(Boolean) : []
    const known = [base, ...others, ...loadKnown(storage)].filter((x, i, all) => x !== null && all.indexOf(x) === i).slice(0, MAX_KNOWN)
    storage.setItem(KNOWN_KEY, JSON.stringify(known))
  } catch {
    /* storage can be off; the shell still opens the hub */
  }
}

export function forget(storage, base) {
  try {
    if (storage.getItem(LAST_KEY) === base) storage.removeItem(LAST_KEY)
    storage.setItem(KNOWN_KEY, JSON.stringify(loadKnown(storage).filter((x) => x !== base)))
  } catch {
    /* nothing to forget */
  }
}

/** A short name for an address, for the chips: "192.168.1.7" or "house.tail1234.ts.net". */
export function label(base) {
  try {
    const u = new URL(base)
    const port = u.port && !(u.protocol === 'http:' && u.port === String(HUB_PORT)) ? ':' + u.port : ''
    return u.hostname + port
  } catch {
    return base
  }
}

/** A plain-words hint for an address: where the phone has to be for it to work. */
export function hint(base) {
  const h = label(base)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return 'Through Tailscale, from anywhere'
  if (/\.ts\.net$/.test(h)) return 'Through Tailscale, from anywhere (secure)'
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return 'On the house WiFi'
  return ''
}
