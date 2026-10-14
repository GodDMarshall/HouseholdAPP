import { useEffect, useState } from 'react'
import { api, ApiError, setToken } from '../api.ts'
import { Icon } from '../components/icons.tsx'
import { Sheet, TopBar } from '../components/ui.tsx'
import { disablePush, enablePush, isSubscribed, pushSupport, pushSupportText } from '../push.ts'
import { navigate } from '../router.ts'
import { useStore } from '../store.ts'
import { disconnectLive } from '../ws.ts'

/** The sign-in keypad has digits only; never let a PIN be set that it cannot type. */
function digits(s: string): string {
  return s.replace(/[^0-9]/g, '').slice(0, 8)
}

function uptime(sec: number): string {
  if (sec < 90) return `${sec} s`
  const m = Math.round(sec / 60)
  if (m < 90) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} days`
}

export function SettingsScreen() {
  // Inside the Android app the start screen (at the app's own address) picks the hub; it is reached again from here.
  const inShell = /HouseControlShell/.test(navigator.userAgent)
  const status = useStore((s) => s.status)
  const connected = useStore((s) => s.connected)
  const toast = useStore((s) => s.toast)
  const [subscribed, setSubscribed] = useState(false)
  const [pinSheet, setPinSheet] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const support = pushSupport()
  const openPinSheet = () => {
    setCurrent('')
    setNext('')
    setPinError(null)
    setPinSheet(true)
  }

  useEffect(() => {
    void isSubscribed().then(setSubscribed)
    void api
      .get<NonNullable<typeof status>>('/api/hub/status')
      .then((s) => useStore.getState().apply({ type: 'hub.status', status: s }))
      .catch(() => undefined)
  }, [])

  const togglePush = async () => {
    try {
      if (subscribed) {
        await disablePush()
        setSubscribed(false)
      } else {
        setSubscribed(await enablePush())
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change notifications', 'error')
    }
  }

  const changePin = async () => {
    if (changing) return
    setChanging(true)
    setPinError(null)
    try {
      await api.post('/api/auth/pin', { current, next })
      toast('PIN changed. Other phones were signed out.', 'ok')
      setPinSheet(false)
      setCurrent('')
      setNext('')
    } catch (err) {
      setPinError(err instanceof ApiError ? err.message : 'Could not change the PIN')
    } finally {
      setChanging(false)
    }
  }

  const signOut = async () => {
    await api.post('/api/auth/logout').catch(() => undefined)
    setToken(null)
    disconnectLive()
    useStore.getState().setAuth('login')
    navigate('/', true)
  }

  const video = status?.video
  const sms = status?.sms
  return (
    <>
      <TopBar title="Settings" sub={connected ? 'Connected to the hub' : 'Not connected'} />
      <main className="content">
        <div className="card">
          <h2>Notifications on this phone</h2>
          <div className="row" style={{ borderTop: 0 }}>
            <Icon name="bell" className="picon" />
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>
                {subscribed ? 'On' : 'Off'}
              </span>
              <span className="desc">Gate opened, a device moved to another connection, something unreachable, a command that failed.</span>
            </span>
            <button className={`btn sm ${subscribed ? '' : 'primary'}`} onClick={() => void togglePush()}>
              {subscribed ? 'Turn off' : 'Turn on'}
            </button>
          </div>
          {support !== 'ok' ? <p className="note warn">{pushSupportText(support)}</p> : null}
          {subscribed ? (
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => void api.post('/api/push/test').then(() => toast('Test sent', 'info'))}>
              Send a test notification
            </button>
          ) : null}
        </div>

        <div className="card">
          <h2>The hub</h2>
          {status ? (
            <dl className="kv">
              <dt>Version</dt>
              <dd>{status.version}</dd>
              <dt>Running on</dt>
              <dd>{status.hostname}</dd>
              <dt>Address</dt>
              <dd>{status.addresses.join(', ') || 'unknown'}</dd>
              <dt>Up for</dt>
              <dd>{uptime(status.uptimeSec)}</dd>
              <dt>Devices</dt>
              <dd>{status.devices}</dd>
              <dt>Phones with notifications</dt>
              <dd>{status.push.subscriptions}</dd>
              <dt>Live video</dt>
              <dd>{video?.go2rtc === 'running' ? `Running${video.version ? ' (go2rtc ' + video.version + ')' : ''}` : video?.go2rtc === 'missing' ? 'Not installed' : video?.go2rtc ?? ''}</dd>
              <dt>SMS</dt>
              <dd>{sms?.modem === 'connected' ? `GSM modem on ${sms.port}` : 'Sent from your phone'}</dd>
            </dl>
          ) : (
            <div className="spinner" />
          )}
          {video && video.go2rtc !== 'running' && video.detail ? <p className="note">{video.detail}</p> : null}
          {sms && sms.modem !== 'connected' && sms.detail ? <p className="note">{sms.detail}</p> : null}
          {inShell ? (
            <button className="row" onClick={() => location.assign('http://localhost/?choose')}>
              <Icon name="wifi" className="picon" />
              <span className="grow title">Change hub address</span>
              <Icon name="more" className="picon" />
            </button>
          ) : null}
        </div>

        <div className="card">
          <h2>Security</h2>
          <button className="row" style={{ borderTop: 0 }} onClick={openPinSheet}>
            <Icon name="lock" className="picon" />
            <span className="grow title">Change the house PIN</span>
            <Icon name="more" className="picon" />
          </button>
          <button className="row" onClick={() => void signOut()}>
            <Icon name="x" className="picon" />
            <span className="grow title">Sign out on this phone</span>
          </button>
        </div>

        <div className="card">
          <h2>Put it on the home screen</h2>
          <p className="desc" style={{ color: 'var(--muted)', fontSize: 14 }}>
            Android: browser menu {'→'} Install app. iPhone: Share {'→'} Add to Home Screen. It then opens full screen like any other app.
          </p>
        </div>

        {pinSheet ? (
          <Sheet title="Change the house PIN" subtitle="This phone stays signed in. Every other phone is signed out and asks for the new PIN." onClose={() => setPinSheet(false)}>
            <div className="field">
              <label htmlFor="p-cur">Current PIN</label>
              <input id="p-cur" className="input" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={current} onChange={(e) => setCurrent(digits(e.target.value))} />
            </div>
            <div className="field">
              <label htmlFor="p-new">New PIN (4 to 8 digits)</label>
              <input id="p-new" className="input" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={next} onChange={(e) => setNext(digits(e.target.value))} />
              <div className="help">Digits only, so the sign-in keypad can type it.</div>
            </div>
            {pinError ? <p className="note err">{pinError}</p> : null}
            <button className="btn primary block" disabled={changing || current.length < 4 || next.length < 4 || next.length > 8} onClick={() => void changePin()}>
              {changing ? <span className="spinner sm" /> : null}
              Change PIN
            </button>
          </Sheet>
        ) : null}
      </main>
    </>
  )
}
