import { useMemo, useState } from 'react'
import type { Device, DeviceState } from '@house/shared'
import { Icon, kindIcon } from '../components/icons.tsx'
import { ConnChip, Sheet, TopBar } from '../components/ui.tsx'
import { Stills } from '../components/Viewer.tsx'
import { api } from '../api.ts'
import { act, activePathOf, isOn, stateLine, useBusy, usePending } from '../lib.ts'
import { navigate } from '../router.ts'
import { useStore } from '../store.ts'

export function HomeScreen() {
  const devices = useStore((s) => s.devices)
  const states = useStore((s) => s.states)
  const connected = useStore((s) => s.connected)
  const pending = usePending()
  const [lockUp, setLockUp] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const illustrative = devices.filter((d) => d.family === 'virtual')
  const removeIllustrative = async () => {
    if (removing) return
    setRemoving(true)
    try {
      for (const d of illustrative) await api.del(`/api/devices/${d.id}`).catch(() => undefined)
      useStore.getState().toast('Illustrative devices and their pretend WiFi networks removed', 'info')
    } finally {
      setRemoving(false)
      setClearing(false)
    }
  }

  const rooms = useMemo(() => {
    const map = new Map<string, Device[]>()
    for (const d of devices) {
      const key = d.room || 'House'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(d)
    }
    return [...map.entries()]
  }, [devices])

  const offline = devices.filter((d) => states[d.id] && !states[d.id]!.online).length
  // Lights only: a socket or a pump is not something "all lights off" should touch.
  const lightsOn = devices.filter((d) => d.kind === 'light' && d.capabilities.includes('power') && isOn(states[d.id]))
  const gates = devices.filter((d) => d.capabilities.includes('gate') && states[d.id]?.online)
  // Only gates that report their position are closed here. Pressing the button of
  // a gate whose position is unknown could OPEN it (one-button gates step open / stop / close).
  const knownGates = gates.filter((d) => d.capabilities.includes('gate-state') && activePathOf(d, states[d.id])?.kind !== 'sms')
  const gatesToClose = knownGates.filter((d) => ['open', 'opening', 'stopped'].includes(String(states[d.id]?.state.gate)))
  const gatesUnknown = gates.filter((d) => !knownGates.includes(d) || !['open', 'opening', 'stopped', 'closed', 'closing'].includes(String(states[d.id]?.state.gate)))
  const sub = devices.length === 0 ? 'No devices yet' : offline > 0 ? `${devices.length} devices · ${offline} unreachable` : `${devices.length} devices · all reachable`

  return (
    <>
      <TopBar
        title="House"
        sub={sub}
        right={
          <>
            <span className={`linkdot ${connected ? 'on' : ''}`} title={connected ? 'Connected to the hub' : 'Not connected to the hub'} />
            <button className="iconbtn" onClick={() => navigate('/add')} aria-label="Add device">
              <Icon name="plus" />
            </button>
          </>
        }
      />
      <main className="content">
        {!connected ? <div className="banner err">Not connected to the hub. Retrying{'…'}</div> : null}
        {pending.map((a) => (
          <button key={a.id} className="banner" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(`/device/${a.deviceId}`)}>
            <strong>{devices.find((d) => d.id === a.deviceId)?.name ?? 'Device'}:</strong> {a.label} needs you. Tap to finish it.
          </button>
        ))}
        {illustrative.length > 0 ? (
          <div className="card" style={{ margin: '8px 0 4px' }}>
            <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 10 }}>
              {illustrative.length === devices.length
                ? 'These are illustrative devices so you can try everything. Add your own camera, gate or lights with the + button.'
                : `${illustrative.length} illustrative device${illustrative.length === 1 ? ' is' : 's are'} still here. Remove them when your own are in.`}
            </p>
            <div className="btnrow">
              <button className="btn sm primary" onClick={() => navigate('/add')}>
                <Icon name="plus" />
                Add my device
              </button>
              <button className="btn sm" onClick={() => setClearing(true)}>
                Remove the illustrative ones
              </button>
            </div>
          </div>
        ) : null}
        {clearing ? (
          <Sheet title="Remove the illustrative devices?" subtitle={`${illustrative.map((d) => d.name).join(', ')}. Your own devices are not touched.`} onClose={() => setClearing(false)}>
            <div className="btnrow">
              <button className="btn danger" disabled={removing} onClick={() => void removeIllustrative()}>
                {removing ? <span className="spinner sm" /> : null}
                Remove them
              </button>
              <button className="btn ghost" onClick={() => setClearing(false)}>
                Keep them
              </button>
            </div>
          </Sheet>
        ) : null}
        {lightsOn.length > 0 || gates.length > 0 ? (
          <div className="btnrow" style={{ margin: '8px 0 0' }}>
            {lightsOn.length > 0 ? (
              <button className="btn sm" onClick={() => lightsOn.forEach((d) => void act(d.id, 'power.off'))}>
                <Icon name="moon" />
                All lights off ({lightsOn.length})
              </button>
            ) : null}
            {gates.length > 0 ? (
              <button className="btn sm" onClick={() => setLockUp(true)}>
                <Icon name="lock" />
                Lock up
              </button>
            ) : null}
          </div>
        ) : null}
        {lockUp ? (
          <Sheet title="Lock up the house?" subtitle="One tap for the end of the day." onClose={() => setLockUp(false)}>
            <p className="note">
              {gatesToClose.length > 0 ? `Closes ${gatesToClose.map((d) => d.name).join(', ')}.` : knownGates.length > 0 ? 'Every gate that reports its position is closed.' : ''}{' '}
              {lightsOn.length > 0 ? `Turns off ${lightsOn.length} light${lightsOn.length === 1 ? '' : 's'}.` : 'No lights are on.'}
            </p>
            {gatesUnknown.length > 0 ? (
              <p className="note warn">
                {gatesUnknown.map((d) => d.name).join(', ')} cannot tell the hub whether {gatesUnknown.length === 1 ? 'it is' : 'they are'} open or closed, so Lock up leaves {gatesUnknown.length === 1 ? 'it' : 'them'} alone. Check by eye or
                camera and close {gatesUnknown.length === 1 ? 'it' : 'them'} from {gatesUnknown.length === 1 ? 'its' : 'their'} own page.
              </p>
            ) : null}
            <div className="btnrow">
              <button
                className="btn primary"
                disabled={gatesToClose.length === 0 && lightsOn.length === 0}
                onClick={() => {
                  gatesToClose.forEach((d) => void act(d.id, 'gate.close'))
                  lightsOn.forEach((d) => void act(d.id, 'power.off'))
                  setLockUp(false)
                }}
              >
                <Icon name="lock" />
                Lock up
              </button>
              <button className="btn ghost" onClick={() => setLockUp(false)}>
                Not now
              </button>
            </div>
          </Sheet>
        ) : null}
        {devices.length === 0 ? (
          <div className="empty">
            <h2>Nothing here yet</h2>
            <p>Add your first camera, gate or light.</p>
            <button className="btn primary" style={{ marginTop: 16 }} onClick={() => navigate('/add')}>
              <Icon name="plus" />
              Add a device
            </button>
          </div>
        ) : (
          rooms.map(([room, list]) => (
            <section key={room}>
              <h2 className="room">{room}</h2>
              <div className="grid">
                {list.map((d) => (
                  <Tile key={d.id} device={d} state={states[d.id]} />
                ))}
              </div>
            </section>
          ))
        )}
      </main>
    </>
  )
}

function Tile({ device, state }: { device: Device; state: DeviceState | undefined }) {
  const busy = useBusy(device.id)
  const online = state?.online === true
  const open = () => navigate(`/device/${device.id}`)

  if (device.kind === 'camera') {
    return (
      <button className={`tile wide ${state && !online ? 'off-line' : ''}`} onClick={open} aria-label={`${device.name} camera`}>
        {online && device.capabilities.includes('snapshot') ? (
          <Stills deviceId={device.id} intervalMs={8000} className="thumb" />
        ) : (
          <div className="thumb-fallback">{online ? 'Tap for live view' : state?.summary ?? 'Checking…'}</div>
        )}
        <div className="cap">
          <span className="tname">{device.name}</span>
          <ConnChip device={device} state={state} />
        </div>
      </button>
    )
  }

  const togglable = device.capabilities.includes('power')
  const on = isOn(state)
  const onTap = () => {
    // A second tap while the first is still on its way would switch it straight back.
    if (togglable && online) {
      if (!busy) void act(device.id, 'power.toggle')
    } else open()
  }
  return (
    <div className={`tile ${on ? 'on' : ''} ${state && !online ? 'off-line' : ''}`} role="button" tabIndex={0} onClick={onTap} onKeyDown={(e) => e.key === 'Enter' && onTap()} aria-label={`${device.name}, ${stateLine(device, state)}`}>
      <div className="ticon">
        <Icon name={kindIcon(device.kind)} />
      </div>
      <div className="tconn">
        <ConnChip device={device} state={state} />
      </div>
      <div className="tname">{device.name}</div>
      <div className="tstate" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1 }}>{stateLine(device, state)}</span>
        {togglable ? (
          <button
            className="iconbtn"
            style={{ width: 36, height: 36, background: 'transparent' }}
            aria-label={`${device.name} details`}
            onClick={(e) => {
              e.stopPropagation()
              open()
            }}
          >
            <Icon name="more" />
          </button>
        ) : null}
      </div>
      {busy ? (
        <div className="busy">
          <div className="spinner" />
        </div>
      ) : null}
    </div>
  )
}
