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

export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  for (const l of listeners) l()
}

export function back(fallback = '/'): void {
  if (history.length > 1 && document.referrer !== '') history.back()
  else if (history.length > 1) history.back()
  else navigate(fallback, true)
}

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
