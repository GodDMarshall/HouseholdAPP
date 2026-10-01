import { useEffect, useMemo, useRef, useState } from 'react'
import type { Action, ConnectionPath, Device, DeviceState, GateState } from '@house/shared'
import { api } from '../api.ts'
import { Icon, pathIcon } from '../components/icons.tsx'
import { ConnChip, Sheet, TopBar, pathSubtitle } from '../components/ui.tsx'
import { Viewer } from '../components/Viewer.tsx'
import { act, clock, smsHref, stateLine, timeAgo, useAuthBlob, useBusy, usePending, waitForAction } from '../lib.ts'
import { back, navigate } from '../router.ts'
import { useStore } from '../store.ts'

export function DeviceScreen({ id }: { id: string }) {
  const device = useStore((s) => s.devices.find((d) => d.id === id))
  const state = useStore((s) => s.states[id])
  const connected = useStore((s) => s.connected)

  if (!device) {
    return (
      <>
        <TopBar title="Device" onBack={() => back('/')} />
        <main className="content">
          <div className="empty">{connected ? <h2>This device is not in the house any more</h2> : <div className="spinner" style={{ margin: '0 auto' }} />}</div>
        </main>
      </>
    )
  }
  const illustrative = device.family === 'virtual'
  return (
    <>
      <TopBar
        title={device.name}
        sub={[device.room, illustrative ? 'Illustrative' : null].filter(Boolean).join(' · ')}
        onBack={() => back('/')}
        right={
          <button className="iconbtn" onClick={() => navigate(`/device/${device.id}/edit`)} aria-label="Edit device">
            <Icon name="edit" />
          </button>
        }
      />
      <main className="content" style={{ paddingBottom: 40 }}>
        <PendingCards deviceId={device.id} />
        {device.kind === 'camera' ? (
          <CameraPanel device={device} state={state} />
        ) : device.capabilities.includes('gate') ? (
          <GatePanel device={device} state={state} />
        ) : device.capabilities.includes('power') ? (
          <LightPanel device={device} state={state} />
        ) : (
          <div className="hero">
            <div className="bigstate">{stateLine(device, state)}</div>
          </div>
        )}
        <ConnectionCard device={device} state={state} />
        <RecentCard device={device} />
        <DetailsCard device={device} state={state} />
        <MoreCard device={device} state={state} />
      </main>
    </>
  )
}

// --------------------------------------------------------------- pending

function PendingCards({ deviceId }: { deviceId: string }) {
  const pending = usePending(deviceId)
  const confirm = (a: Action, ok: boolean) => void api.post(`/api/actions/${a.id}/confirm`, { ok }).catch(() => useStore.getState().toast('Could not save that', 'error'))
  return (
    <>
      {pending.map((a) => {
        const handoff = typeof a.result?.handoff === 'string' ? a.result.handoff : null
        const note = typeof a.result?.note === 'string' ? a.result.note : null
        const isCall = handoff?.startsWith('tel:') ?? false
        const handoffLabel = typeof a.result?.handoffLabel === 'string' ? a.result.handoffLabel : isCall ? 'Call the device' : 'Send the text'
        const text = typeof a.result?.text === 'string' ? a.result.text : null
        return (
          <div key={a.id} className="card" style={{ border: '1px solid rgba(251,191,36,0.5)' }}>
            <h2 style={{ color: 'var(--warn)' }}>{a.label} needs you</h2>
            <p style={{ marginBottom: 12 }}>
              {note ??
                (isCall
                  ? 'This device opens when it gets a call from your number. Tap Call; it hangs up by itself. Then come back and confirm.'
                  : handoff
                    ? 'The hub has no GSM modem, so this text goes from your phone. Tap Send, press send in your messages app, then come back and confirm.'
                    : 'The hub could not confirm this by itself.')}
            </p>
            {text && !isCall ? <p className="note">Message: {text}</p> : null}
            {handoff ? (
              <a className="btn primary block" href={isCall ? handoff : smsHref(handoff)} style={{ textDecoration: 'none', marginBottom: 10 }}>
                <Icon name="sms" />
                {handoffLabel}
              </a>
            ) : null}
            <div className="btnrow">
              <button className="btn" onClick={() => confirm(a, true)}>
                <Icon name="check" />
                It worked
              </button>
              <button className="btn ghost" onClick={() => confirm(a, false)}>
                It did not
              </button>
            </div>
          </div>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------- camera

function CameraPanel({ device, state }: { device: Device; state: DeviceState | undefined }) {
  const online = state?.online === true
  const hasPtz = device.capabilities.includes('ptz')
  const presets = Array.isArray(state?.state.presets) ? (state!.state.presets as Array<string | number>) : []
  const actions = useStore((s) => s.actions)
  const shots = useMemo(
    () =>
      Object.values(actions)
        .filter((a) => a.deviceId === device.id && a.type === 'snapshot' && a.status === 'done' && typeof a.result?.url === 'string')
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
        .slice(0, 6),
    [actions, device.id],
  )
  return (
    <>
      <Viewer device={device} state={state} stillsMs={hasPtz ? 500 : 1000} />
      {hasPtz ? (
        <div className="card">
          <h2>Move the camera</h2>
          <div className="ptzrow">
            <DPad deviceId={device.id} disabled={!online} />
            <div className="zoomcol">
              <HoldButton deviceId={device.id} disabled={!online} move={{ zoom: 1 }} label="Zoom in">
                +
              </HoldButton>
              <HoldButton deviceId={device.id} disabled={!online} move={{ zoom: -1 }} label="Zoom out">
                {'−'}
              </HoldButton>
            </div>
          </div>
          {device.capabilities.includes('presets') && presets.length > 0 ? (
            <div className="btnrow" style={{ marginTop: 12 }}>
              {presets.slice(0, 6).map((p) => (
                <button key={String(p)} className="btn sm" disabled={!online} onClick={() => void act(device.id, 'ptz.preset', { preset: p })}>
                  Preset {String(p)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="btnrow" style={{ margin: '12px 0' }}>
        <button className="btn" disabled={!online} onClick={() => void act(device.id, 'snapshot')}>
          <Icon name="shot" />
          Take a picture
        </button>
      </div>
      {shots.length > 0 ? (
        <div className="card">
          <h2>Pictures taken</h2>
          <div className="snapgrid">
            {shots.map((a) => (
              <Shot key={a.id} url={String(a.result!.url)} label={`Picture from ${clock(a.requestedAt)}`} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

/** A stored picture, loaded with the sign-in header so the house token never appears in an address. */
function Shot({ url, label }: { url: string; label: string }) {
  const src = useAuthBlob(url)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="shot" onClick={() => src && setOpen(true)} aria-label={label}>
        {src ? <img src={src} alt={label} /> : <span className="spinner sm" />}
      </button>
      {open && src ? (
        <Sheet title={label} onClose={() => setOpen(false)}>
          <img src={src} alt={label} style={{ width: '100%', borderRadius: 12, display: 'block' }} />
        </Sheet>
      ) : null}
    </>
  )
}

interface Move {
  pan?: number
  tilt?: number
  zoom?: number
}

/** Hold to move, release to stop — the way a joystick works. */
function HoldButton({ deviceId, move, label, disabled, children, className }: { deviceId: string; move: Move; label: string; disabled?: boolean; children: React.ReactNode; className?: string }) {
  const held = useRef(false)
  const [down, setDown] = useState(false)
  const start = (e: React.PointerEvent) => {
    if (disabled || held.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    held.current = true
    setDown(true)
    void act(deviceId, 'ptz.move', { pan: 0, tilt: 0, zoom: 0, ...move })
  }
  const stop = () => {
    if (!held.current) return
    held.current = false
    setDown(false)
    void act(deviceId, 'ptz.stop')
  }
  return (
    <button className={`${className ?? ''} ${down ? 'held' : ''}`} aria-label={label} disabled={disabled} onPointerDown={start} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </button>
  )
}

function DPad({ deviceId, disabled }: { deviceId: string; disabled: boolean }) {
  const b = (move: Move, icon: string, label: string) => (
    <HoldButton deviceId={deviceId} move={move} label={label} disabled={disabled}>
      <Icon name={icon} />
    </HoldButton>
  )
  return (
    <div className="dpad">
      <span />
      {b({ tilt: 1 }, 'up', 'Tilt up')}
      <span />
      {b({ pan: -1 }, 'left', 'Pan left')}
      <button className="center" disabled={disabled} onClick={() => void act(deviceId, 'ptz.stop')} aria-label="Stop moving">
        STOP
      </button>
      {b({ pan: 1 }, 'right', 'Pan right')}
      <span />
      {b({ tilt: -1 }, 'down', 'Tilt down')}
      <span />
    </div>
  )
}

// ------------------------------------------------------------------ gate

function GatePanel({ device, state }: { device: Device; state: DeviceState | undefined }) {
  const online = state?.online === true
  const busy = useBusy(device.id)
  const knows = device.capabilities.includes('gate-state')
  const gate = (knows ? (state?.state.gate as GateState | undefined) : undefined) ?? 'unknown'
  const open = gate === 'open' ? 1 : gate === 'closed' ? 0 : gate === 'opening' ? 0.75 : gate === 'closing' ? 0.25 : 0.5
  const moving = gate === 'opening' || gate === 'closing'
  const viaSms = device.paths.find((p) => p.id === state?.activePathId)?.kind === 'sms'
  const label = !online ? 'Unreachable' : !knows ? (busy ? 'Sending…' : 'Ready') : gate === 'unknown' ? 'Position unknown' : viaSms ? `Last seen ${gate}` : gate.charAt(0).toUpperCase() + gate.slice(1)
  return (
    <div className="hero">
      <svg className="gatevis" viewBox="0 0 360 150" role="img" aria-label={`Gate ${label}`}>
        <rect x="0" y="126" width="360" height="6" rx="3" fill="#2c3243" />
        <rect x="20" y="20" width="16" height="110" rx="4" fill="#4b5469" />
        <rect x="324" y="20" width="16" height="110" rx="4" fill="#4b5469" />
        <g style={{ transform: `translateX(${open * 250}px)`, transition: `transform ${moving ? 6 : 0.6}s linear` }}>
          <rect x="38" y="34" width="284" height="8" rx="3" fill={gate === 'open' ? '#5eead4' : '#98a0b3'} />
          <rect x="38" y="108" width="284" height="8" rx="3" fill={gate === 'open' ? '#5eead4' : '#98a0b3'} />
          {Array.from({ length: 12 }, (_, i) => (
            <rect key={i} x={46 + i * 24} y="34" width="5" height="82" rx="2" fill={gate === 'open' ? '#5eead4' : '#98a0b3'} />
          ))}
        </g>
      </svg>
      <div className="bigstate" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {busy || moving ? <span className="spinner sm" /> : null}
        {label}
      </div>
      {viaSms ? <div className="note warn" style={{ width: '100%' }}>On the SMS connection: commands go as text messages and the gate cannot report back.</div> : null}
      <div className="gatebtns">
        <button className="btn primary" disabled={!online} onClick={() => void act(device.id, 'gate.open')}>
          <Icon name="open" />
          Open
        </button>
        <button className="btn" disabled={!online} onClick={() => void act(device.id, 'gate.stop')}>
          <Icon name="stop" />
          Stop
        </button>
        <button className="btn" disabled={!online} onClick={() => void act(device.id, 'gate.close')}>
          <Icon name="close" />
          Close
        </button>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- light

function LightPanel({ device, state }: { device: Device; state: DeviceState | undefined }) {
  const online = state?.online === true
  const on = online && state?.state.power === true
  const busy = useBusy(device.id)
  const dim = device.capabilities.includes('dim')
  const remote = typeof state?.state.brightness === 'number' ? (state.state.brightness as number) : 0
  const [local, setLocal] = useState<number | null>(null)
  useEffect(() => setLocal(null), [remote])
  const value = local ?? remote
  return (
    <div className="hero">
      <button className={`bigtoggle ${on ? 'on' : ''}`} disabled={!online} onClick={() => void act(device.id, 'power.toggle')} aria-label={on ? 'Turn off' : 'Turn on'} aria-pressed={on}>
        {busy ? <div className="spinner" /> : <Icon name="power" />}
      </button>
      <div className="bigstate">{!online ? 'Unreachable' : on ? 'On' : 'Off'}</div>
      {dim ? (
        <div className="slider">
          <div className="lbl">
            <span>Brightness</span>
            <span>{value}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={value}
            disabled={!online}
            aria-label="Brightness"
            onChange={(e) => setLocal(Number(e.target.value))}
            onPointerUp={() => local !== null && void act(device.id, 'dim.set', { brightness: local })}
            onKeyUp={() => local !== null && void act(device.id, 'dim.set', { brightness: local })}
          />
        </div>
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------- connections

function ConnectionCard({ device, state }: { device: Device; state: DeviceState | undefined }) {
  const [picked, setPicked] = useState<ConnectionPath | null>(null)
  const [moving, setMoving] = useState(false)
  const busy = useBusy(device.id)
  const pinned = state?.pinnedPathId ?? null
  const paths = [...device.paths].sort((a, b) => a.priority - b.priority)
  return (
    <div className="card">
      <h2>
        Connection
        <span className="right">
          <ConnChip device={device} state={state} />
        </span>
      </h2>
      {paths.length === 0 ? <p className="note warn">No way to reach this device has been set up. Edit it and add a connection.</p> : null}
      {paths.map((p) => {
        const h = state?.paths.find((x) => x.pathId === p.id)
        const active = state?.activePathId === p.id
        return (
          <button key={p.id} className={`row pathrow ${active ? 'active' : ''}`} onClick={() => setPicked(p)} aria-label={`${p.label} connection`}>
            <span className={`pdot ${h?.status ?? ''}`} />
            <Icon name={pathIcon(p.kind)} className="picon" />
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>
                {p.label}
              </span>
              <span className="desc">{pathSubtitle(p, h)}</span>
            </span>
            {pinned === p.id ? <span className="chip blue">Pinned</span> : null}
          </button>
        )
      })}
      <div className="btnrow" style={{ marginTop: 12 }}>
        <button className="btn sm" disabled={busy} onClick={() => void act(device.id, 'probe')}>
          <Icon name="refresh" />
          Check now
        </button>
        {pinned ? (
          <button className="btn sm" onClick={() => void act(device.id, 'path.switch', { pathId: null })}>
            Automatic
          </button>
        ) : null}
        {device.capabilities.includes('wifi') ? (
          <button className="btn sm" disabled={!state?.online} onClick={() => setMoving(true)}>
            <Icon name="wifi" />
            Move to WiFi
          </button>
        ) : null}
      </div>
      {picked ? (
        <Sheet title={picked.label} subtitle={pathSubtitle(picked, state?.paths.find((x) => x.pathId === picked.id))} onClose={() => setPicked(null)}>
          <p className="note">{pathExplain(picked)}</p>
          <div className="btnrow" style={{ flexDirection: 'column' }}>
            <button
              className="btn primary block"
              disabled={!picked.enabled}
              onClick={() => {
                void act(device.id, 'path.switch', { pathId: picked.id })
                setPicked(null)
              }}
            >
              <Icon name="pin" />
              Use this connection
            </button>
            <button
              className="btn block"
              onClick={() => {
                void act(device.id, 'probe', { pathId: picked.id })
                setPicked(null)
              }}
            >
              <Icon name="refresh" />
              Check it now
            </button>
          </div>
        </Sheet>
      ) : null}
      {moving ? <MoveWifiSheet device={device} state={state} onClose={() => setMoving(false)} /> : null}
    </div>
  )
}

function pathExplain(p: ConnectionPath): string {
  switch (p.kind) {
    case 'lan': return 'The device’s address on a house network. The hub must be on that network too.'
    case 'cellular': return 'The device’s own SIM. It answers only when the carrier gives the SIM a public address; most consumer SIMs do not, and the check will say so.'
    case 'cloud': return 'Reached through the maker’s cloud, from anywhere with internet.'
    case 'sms': return 'Commands go as text messages to the SIM in the device. Texts cannot be checked in advance, and the device cannot report back.'
  }
}

function MoveWifiSheet({ device, state, onClose }: { device: Device; state: DeviceState | undefined; onClose: () => void }) {
  const wifi = useStore((s) => s.wifi)
  const current = typeof state?.state.wifi === 'string' ? state.state.wifi : null
  const [scan, setScan] = useState<Array<{ ssid: string; signal: number | null }> | null>(null)
  const [scanning, setScanning] = useState(false)
  const doScan = async () => {
    setScanning(true)
    const a = await act(device.id, 'wifi.scan')
    const done = a ? await waitForAction(a.id, 30_000) : null
    setScanning(false)
    if (done?.status === 'done' && Array.isArray(done.result?.networks)) setScan(done.result.networks as Array<{ ssid: string; signal: number | null }>)
  }
  return (
    <Sheet title="Move to another WiFi" subtitle={`${device.name} will drop off for up to a minute while it joins the new network. The hub finds it there and switches over.`} onClose={onClose}>
      {wifi.length === 0 ? <p className="note warn">No WiFi networks stored yet. Add them under the WiFi tab first.</p> : null}
      {wifi.map((w) => {
        const seen = scan?.find((s) => s.ssid === w.ssid)
        const isCurrent = current === w.ssid
        return (
          <button
            key={w.id}
            className="row"
            disabled={isCurrent || !w.hasPassword}
            onClick={() => {
              void act(device.id, 'wifi.set', { wifiNetworkId: w.id })
              onClose()
            }}
          >
            <Icon name="wifi" className="picon" />
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>
                {w.ssid}
              </span>
              <span className="desc">
                {isCurrent ? 'The device is on this network now' : !w.hasPassword ? 'No password stored — add it under WiFi' : scan ? (seen ? `The device sees it${seen.signal != null ? ` (signal ${seen.signal}%)` : ''}` : 'The device does not see this network') : w.notes || 'Tap to move the device here'}
              </span>
            </span>
            {isCurrent ? <span className="chip ok">Current</span> : null}
          </button>
        )
      })}
      <div className="btnrow stack" style={{ marginTop: 14 }}>
        {device.capabilities.includes('wifi-scan') ? (
          <button className="btn" disabled={scanning} onClick={() => void doScan()}>
            {scanning ? <span className="spinner sm" /> : <Icon name="search" />}
            What does the device see?
          </button>
        ) : null}
        <button className="btn ghost" onClick={() => navigate('/wifi')}>
          Manage WiFi
        </button>
      </div>
    </Sheet>
  )
}

// ------------------------------------------------------- recent / details

function RecentCard({ device }: { device: Device }) {
  const actions = useStore((s) => s.actions)
  const recent = useMemo(
    () =>
      Object.values(actions)
        .filter((a) => a.deviceId === device.id && a.type !== 'ptz.move' && a.type !== 'ptz.stop' && a.type !== 'probe')
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
        .slice(0, 6),
    [actions, device.id],
  )
  if (recent.length === 0) return null
  return (
    <div className="card">
      <h2>Recent</h2>
      {recent.map((a) => (
        <div key={a.id} className="row">
          <span className="grow">
            <span className="title" style={{ display: 'block' }}>
              {a.label}
            </span>
            <span className="desc">
              {clock(a.requestedAt)}
              {a.error ? ` · ${a.error}` : typeof a.result?.note === 'string' && a.result.note ? ` · ${a.result.note}` : ''}
            </span>
          </span>
          <StatusChip action={a} />
        </div>
      ))}
    </div>
  )
}

export function StatusChip({ action }: { action: Action }) {
  switch (action.status) {
    case 'done': return <span className="chip ok">Done</span>
    case 'failed': return <span className="chip err">Failed</span>
    case 'needs-confirmation': return <span className="chip warn">Needs you</span>
    default: return (
      <span className="chip">
        <span className="spinner sm" />
        Working
      </span>
    )
  }
}

function DetailsCard({ device, state }: { device: Device; state: DeviceState | undefined }) {
  const families = useStore((s) => s.families)
  const s = state?.state ?? {}
  const rows: Array<[string, string]> = []
  rows.push(['Type', families.find((f) => f.id === device.family)?.label ?? device.family])
  if (typeof s.model === 'string') rows.push(['Model', s.model])
  if (typeof s.firmware === 'string') rows.push(['Firmware', s.firmware])
  if (typeof s.wifi === 'string' && s.wifi) rows.push(['On WiFi', s.wifi])
  if (typeof s.signal === 'number') rows.push(['Signal', `${s.signal}%`])
  if (typeof s.sim === 'string') rows.push(['SIM', s.sim])
  if (typeof s.serial === 'string') rows.push(['Serial', s.serial])
  rows.push(['Last answered', timeAgo(state?.lastSeenAt)])
  return (
    <div className="card">
      <h2>Details</h2>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function MoreCard({ device, state }: { device: Device; state: DeviceState | undefined }) {
  const [confirmReboot, setConfirmReboot] = useState(false)
  const [text, setText] = useState('')
  const canReboot = device.capabilities.includes('reboot')
  const canSms = device.capabilities.includes('sms') && device.paths.some((p) => p.kind === 'sms')
  if (!canReboot && !canSms) return null
  return (
    <div className="card">
      <h2>More</h2>
      {canSms ? (
        <div className="field" style={{ marginTop: 0 }}>
          <label htmlFor="smscmd">Send a text command to the device</label>
          <div style={{ display: 'flex', gap: 10 }}>
            <input id="smscmd" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. 1234#STATUS#" autoCapitalize="off" autoComplete="off" />
            <button
              className="btn"
              disabled={!text.trim()}
              onClick={() => {
                void act(device.id, 'sms.send', { text: text.trim() })
                setText('')
              }}
            >
              Send
            </button>
          </div>
        </div>
      ) : null}
      {canReboot ? (
        <button className="btn danger block" disabled={!state?.online} onClick={() => setConfirmReboot(true)}>
          <Icon name="refresh" />
          Restart the device
        </button>
      ) : null}
      {confirmReboot ? (
        <Sheet title={`Restart ${device.name}?`} subtitle="It will be unreachable for a short while and come back by itself." onClose={() => setConfirmReboot(false)}>
          <div className="btnrow">
            <button
              className="btn danger"
              onClick={() => {
                void act(device.id, 'reboot')
                setConfirmReboot(false)
              }}
            >
              Restart
            </button>
            <button className="btn ghost" onClick={() => setConfirmReboot(false)}>
              Cancel
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}
