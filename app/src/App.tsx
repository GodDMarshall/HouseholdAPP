import { Component, useCallback, useEffect, useState, type ReactNode } from 'react'
import type { FamilyDescriptor } from '@house/shared'
import { api, ApiError, getToken, setToken, setUnauthorizedHandler } from './api.ts'
import { Icon } from './components/icons.tsx'
import { Toasts } from './components/ui.tsx'
import { usePending } from './lib.ts'
import { navigate, useRoute, type Route } from './router.ts'
import { ActivityScreen } from './screens/Activity.tsx'
import { DeviceScreen } from './screens/Device.tsx'
import { DeviceForm } from './screens/DeviceForm.tsx'
import { EasyAdd } from './screens/EasyAdd.tsx'
import { HomeScreen } from './screens/Home.tsx'
import { LoginScreen } from './screens/Login.tsx'
import { SettingsScreen } from './screens/Settings.tsx'
import { WifiScreen } from './screens/Wifi.tsx'
import { useStore } from './store.ts'
import { connectLive, disconnectLive } from './ws.ts'

export default function App() {
  const auth = useStore((s) => s.auth)
  const setAuth = useStore((s) => s.setAuth)
  const [unreachable, setUnreachable] = useState(false)

  const boot = useCallback(async () => {
    setUnreachable(false)
    try {
      const s = await api.get<{ configured: boolean; authenticated: boolean }>('/api/auth/status')
      if (!s.configured) setAuth('setup')
      else if (!s.authenticated) setAuth('login')
      else await enter()
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) setUnreachable(true)
      else setAuth(getToken() ? 'login' : 'setup')
    }
  }, [setAuth])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null)
      disconnectLive()
      useStore.getState().setAuth('login')
    })
    void boot()
  }, [boot])

  if (unreachable) {
    return (
      <div className="login">
        <Logo />
        <h1>Cannot reach the hub</h1>
        <p>The hub is the small server that runs the house. Check that it is switched on and that this phone is on the house network or on Tailscale.</p>
        <button className="btn primary" onClick={() => void boot()}>
          Try again
        </button>
      </div>
    )
  }
  if (auth === 'unknown') {
    return (
      <div className="login">
        <Logo />
        <div className="spinner" />
      </div>
    )
  }
  if (auth === 'setup' || auth === 'login') return <LoginScreen mode={auth} onDone={() => void enter()} />
  return <Shell />
}

/** After sign-in: open the live channel and load what the forms need. */
async function enter(): Promise<void> {
  const store = useStore.getState()
  store.setAuth('ready')
  connectLive()
  try {
    store.setFamilies(await api.get<FamilyDescriptor[]>('/api/families'))
  } catch {
    /* the form reloads them */
  }
}

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="22" fill="#1b1f2a" />
      <polygon points="50,26 84,50 16,50" fill="#5eead4" />
      <rect x="26" y="50" width="48" height="26" fill="#5eead4" />
      <rect x="44" y="58" width="12" height="18" fill="#1b1f2a" />
    </svg>
  )
}

function Shell() {
  const route = useRoute()
  const showTabs = route.name === 'home' || route.name === 'activity' || route.name === 'settings' || route.name === 'wifi'
  return (
    <div className="shell">
      <ErrorBoundary key={JSON.stringify(route)}>
        <Screen route={route} />
      </ErrorBoundary>
      {showTabs ? <TabBar route={route} /> : null}
      <Toasts />
    </div>
  )
}

/** A fault on one screen must never leave a blank app. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="content">
        <div className="empty">
          <h2>This screen hit a problem</h2>
          <p>{this.state.error.message}</p>
          <div className="btnrow" style={{ marginTop: 16, justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => navigate('/')}>
              Back to the house
            </button>
            <button className="btn" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </main>
    )
  }
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'home': return <HomeScreen />
    case 'device': return <DeviceScreen key={route.id} id={route.id} />
    case 'edit': return <DeviceForm key={route.id} id={route.id} />
    case 'add': return <EasyAdd />
    case 'manual': return <DeviceForm />
    case 'wifi': return <WifiScreen />
    case 'activity': return <ActivityScreen />
    case 'settings': return <SettingsScreen />
  }
}

function TabBar({ route }: { route: Route }) {
  const pending = usePending()
  const tab = (name: Route['name'], path: string, icon: string, label: string, dot = false) => (
    <button className={`tab ${route.name === name ? 'active' : ''}`} onClick={() => navigate(path)} aria-label={label}>
      <Icon name={icon} />
      {label}
      {dot ? <span className="dot" /> : null}
    </button>
  )
  return (
    <nav className="tabbar">
      <div className="tabbar-inner">
        {tab('home', '/', 'home', 'House')}
        {tab('activity', '/activity', 'list', 'Activity', pending.length > 0)}
        {tab('wifi', '/wifi', 'wifi', 'WiFi')}
        {tab('settings', '/settings', 'gear', 'Settings')}
      </div>
    </nav>
  )
}
