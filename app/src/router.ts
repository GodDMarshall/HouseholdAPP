import { useEffect, useState } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'device'; id: string }
  | { name: 'edit'; id: string }
  | { name: 'add' }
  | { name: 'wifi' }
  | { name: 'activity' }
  | { name: 'settings' }

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 0) return { name: 'home' }
  if (parts[0] === 'device' && parts[1]) {
    if (parts[2] === 'edit') return { name: 'edit', id: parts[1] }
    return { name: 'device', id: parts[1] }
  }
  if (parts[0] === 'add') return { name: 'add' }
  if (parts[0] === 'wifi') return { name: 'wifi' }
  if (parts[0] === 'activity') return { name: 'activity' }
  if (parts[0] === 'settings') return { name: 'settings' }
  return { name: 'home' }
}

const listeners = new Set<() => void>()
/** How many entries this app has pushed in this page's life: only those are safe to go back through. */
let depth = 0

export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState({ hc: depth }, '', path)
  else {
    depth += 1
    history.pushState({ hc: depth }, '', path)
  }
  for (const l of listeners) l()
}

/**
 * The app's Back button: really go back when we came from inside the app (so
 * the phone's own Back and ours agree and no duplicate entries pile up);
 * otherwise (opened on a deep link, or from a notification) go to the fallback.
 */
export function back(fallback = '/'): void {
  if (depth > 0) history.back()
  else navigate(fallback, true)
}

/** A step inside one screen (the add-device wizard): the phone's Back button then steps back instead of leaving. */
export function pushStep(step: number): void {
  depth += 1
  history.pushState({ hc: depth, hcStep: step }, '', location.pathname)
}

/** Leave a stepped screen cleanly: drop its step entries before moving on. */
export function popSteps(n: number): Promise<void> {
  if (n <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('popstate', done)
      resolve()
    }
    window.addEventListener('popstate', done)
    history.go(-n)
  })
}

window.addEventListener('popstate', (e) => {
  const d = (e.state as { hc?: number } | null)?.hc
  depth = typeof d === 'number' ? d : 0
})

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname))
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.pathname))
    listeners.add(update)
    window.addEventListener('popstate', update)
    return () => {
      listeners.delete(update)
      window.removeEventListener('popstate', update)
    }
  }, [])
  return route
}
