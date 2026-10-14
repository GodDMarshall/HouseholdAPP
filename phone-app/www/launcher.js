// The Android shell's launcher: find the hub and open the phone app inside the shell.
//
// The shell carries no copy of the app. It opens the hub's own address in its
// WebView, so the phone always runs whatever the hub serves, and an update to
// the app never needs a new APK. This file is plain JavaScript with no
// dependencies so it can be unit-tested with "node --test" and run in the
// WebView as a module.

/** Where the hub usually is: on the house WiFi, and through Tailscale when away. */
export const DEFAULT_HUBS = ['http://192.168.1.7:8080', 'http://100.124.59.5:8080']

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
  if (!url.port && url.protocol === 'http:') url.port = '8080'
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
 * Does a hub answer at this address? A no-cors fetch resolves on any HTTP
 * answer (the hub sets no CORS headers, and it need not) and rejects only when
 * nothing is there, so it is a reachability test, not a login.
 */
export async function reachable(base, { timeoutMs = 2500, fetchImpl = globalThis.fetch } = {}) {
  try {
    await fetchImpl(base + '/api/auth/status', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

/** Probe every candidate at once; return the first in preference order that answered, or null. */
export async function pick(candidates, probe = reachable) {
  const answers = await Promise.all(candidates.map((c) => probe(c)))
  return candidates.find((_, i) => answers[i]) ?? null
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

/** Remember an address that worked: it becomes the first choice next time. */
export function remember(storage, base) {
  try {
    storage.setItem(LAST_KEY, base)
    const known = [base, ...loadKnown(storage).filter((x) => x !== base)].slice(0, MAX_KNOWN)
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
    const port = u.port && !(u.protocol === 'http:' && u.port === '8080') ? ':' + u.port : ''
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
