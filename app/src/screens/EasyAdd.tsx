import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  kindLabel,
  type Device,
  type DeviceInput,
  type DeviceKind,
  type DiscoveredDevice,
  type FieldSpec,
  type PathInput,
  type TuyaAccountDevice,
  type TuyaAccountStatus,
} from '@house/shared'
import { api, ApiError } from '../api.ts'
import { Icon, kindIcon } from '../components/icons.tsx'
import { FieldInput, Sheet, TopBar } from '../components/ui.tsx'
import { back, navigate } from '../router.ts'
import { useStore } from '../store.ts'

type SheetName = 'address' | 'smartlife' | null

const GSM_PRESET: DiscoveredDevice = { family: 'gsm-sms', kind: 'gate', name: 'Main gate', host: '', port: null, detail: 'Gate box with a SIM card', config: {}, via: 'address', needs: ['boxType'] }

/**
 * Add a device the easy way: the hub looks at the house network and shows what
 * it finds, live. Tap one and it is in. The other routes (a typed address, the
 * Smart Life account, a gate box with a SIM, or everything by hand) sit below.
 */
export function EasyAdd() {
  const scan = useStore((s) => s.scan)
  const setScan = useStore((s) => s.setScan)
  const status = useStore((s) => s.status)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<DiscoveredDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<DiscoveredDevice | null>(null)
  const [sheet, setSheet] = useState<SheetName>(null)
  const [log, setLog] = useState<string[]>([])
  const started = useRef(false)

  const start = useCallback(async () => {
    setScanning(true)
    setError(null)
    setResult(null)
    setScan(null)
    setLog([])
    try {
      setResult(await api.get<DiscoveredDevice[]>('/api/discover?seconds=9'))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The scan could not run')
    } finally {
      setScanning(false)
    }
  }, [setScan])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void start()
  }, [start])

  // A short running commentary of what the hub is doing, newest last.
  useEffect(() => {
    if (!scan?.message) return
    setLog((l) => (l[l.length - 1] === scan.message ? l : [...l, scan.message].slice(-4)))
  }, [scan?.message])

  const found = result ?? scan?.found ?? []
  const fresh = found.filter((d) => !d.existingDeviceId)

  const pick = (d: DiscoveredDevice) => {
    if (d.existingDeviceId) navigate(`/device/${d.existingDeviceId}`)
    else if (d.family === 'tuya-local' || d.family === 'tuya-cloud') setSheet('smartlife')
    else setPicked(d)
  }

  return (
    <>
      <TopBar title="Add a device" sub={scanning ? 'Looking at your network' : found.length ? `${found.length} found on your network` : 'Nothing found yet'} onBack={() => back('/')} />
      <main className="content" style={{ paddingBottom: 40 }}>
        <Radar devices={found} scanning={scanning} hub={status?.addresses[0] ?? null} phase={scanning ? scan?.phase ?? 'listening' : 'done'} onPick={pick} />

        <div className="scanlog" aria-live="polite">
          {scanning ? (
            (log.length ? log : ['Starting the scan…']).map((line, i, all) => (
              <div key={i} className={i === all.length - 1 ? 'now' : ''}>
                {line}
              </div>
            ))
          ) : error ? (
            <div className="now" style={{ color: 'var(--err)' }}>
              {error}
            </div>
          ) : (
            <div className="now">{found.length ? `Scan finished. ${fresh.length ? `${fresh.length} new device${fresh.length === 1 ? '' : 's'} to add.` : 'Everything found is already in your house.'}` : 'Scan finished. Nothing answered on this network.'}</div>
          )}
        </div>

        {found.length > 0 ? (
          <div className="card">
            <h2>On your network</h2>
            {found.map((d) => (
              <button key={`${d.family}-${d.host}`} className="row" onClick={() => pick(d)} aria-label={`${d.name} at ${d.host}`}>
                <span className="foundicon">
                  <Icon name={kindIcon(d.kind)} />
                </span>
                <span className="grow">
                  <span className="title" style={{ display: 'block' }}>
                    {d.name}
                  </span>
                  <span className="desc">
                    {d.host}
                    {d.detail ? ` · ${d.detail}` : ''}
                  </span>
                </span>
                {d.existingDeviceId ? <span className="chip ok">In your house</span> : d.family.startsWith('tuya') ? <span className="chip blue">Smart Life</span> : <span className="chip">Tap to add</span>}
              </button>
            ))}
          </div>
        ) : !scanning ? (
          <p className="note">
            Devices are found when they are switched on and on the same WiFi as the hub. Cameras that only use their own SIM card are not on the WiFi, so they will not appear here; add them through their maker{'’'}s account or by hand.
          </p>
        ) : null}

        <button className="btn block" disabled={scanning} onClick={() => void start()}>
          {scanning ? <span className="spinner sm" /> : <Icon name="refresh" />}
          {scanning ? 'Scanning…' : 'Scan again'}
        </button>

        <div className="card">
          <h2>Other ways to add</h2>
          <button className="row" onClick={() => setSheet('smartlife')}>
            <span className="foundicon">
              <Icon name="cloud" />
            </span>
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>
                Smart Life / Tuya account
              </span>
              <span className="desc">Link it once. Every Smart Life device then adds with one tap.</span>
            </span>
            <Icon name="more" className="picon" />
          </button>
          <button className="row" onClick={() => setSheet('address')}>
            <span className="foundicon">
              <Icon name="search" />
            </span>
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>
                I know its address
              </span>
              <span className="desc">Type the address; the hub works out what the device is.</span>
            </span>
            <Icon name="more" className="picon" />
          </button>
          <button className="row" onClick={() => setPicked(GSM_PRESET)}>
            <span className="foundicon">
              <Icon name="sms" />
            </span>
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>
                Gate box with a SIM card
              </span>
              <span className="desc">A gate opener you text or call. Only its phone number is needed.</span>
            </span>
            <Icon name="more" className="picon" />
          </button>
          <button className="row" onClick={() => navigate('/add/manual')}>
            <span className="foundicon">
              <Icon name="edit" />
            </span>
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>
                Set it up by hand
              </span>
              <span className="desc">Every option, step by step. For anything the scan does not find.</span>
            </span>
            <Icon name="more" className="picon" />
          </button>
        </div>

        {picked ? <QuickAdd preset={picked} onClose={() => setPicked(null)} /> : null}
        {sheet === 'address' ? (
          <AddressSheet
            onClose={() => setSheet(null)}
            onFound={(d) => {
              setSheet(null)
              pick(d)
            }}
          />
        ) : null}
        {sheet === 'smartlife' ? <SmartLifeSheet heard={found.filter((d) => d.via === 'tuya').length} onClose={() => setSheet(null)} /> : null}
      </main>
    </>
  )
}

// ----------------------------------------------------------------- radar

/** Where a device sits on the radar: spread by its address so the picture is stable between scans. */
function place(host: string, index: number): { x: number; y: number } {
  const last = Number(host.split('.').pop()) || index * 37 + 11
  const angle = ((last * 137.508) % 360) * (Math.PI / 180)
  const radius = [0.34, 0.25, 0.42][index % 3]!
  return { x: 50 + Math.cos(angle) * radius * 100, y: 50 + Math.sin(angle) * radius * 100 }
}

function Radar({ devices, scanning, hub, phase, onPick }: { devices: DiscoveredDevice[]; scanning: boolean; hub: string | null; phase: string; onPick: (d: DiscoveredDevice) => void }) {
  const spots = useMemo(() => devices.map((d, i) => ({ d, ...place(d.host, i) })), [devices])
  const label = phase === 'listening' ? 'LISTENING' : phase === 'sweeping' ? 'SWEEPING' : phase === 'identifying' ? 'IDENTIFYING' : 'COMPLETE'
  return (
    <div className={`radar ${scanning ? 'live' : ''}`} role="img" aria-label={`Network scan, ${devices.length} device${devices.length === 1 ? '' : 's'} found`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <radialGradient id="radar-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(94,234,212,0.16)" />
            <stop offset="100%" stopColor="rgba(94,234,212,0)" />
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="48" fill="url(#radar-glow)" />
        {[12, 24, 36, 48].map((r) => (
          <circle key={r} cx="50" cy="50" r={r} className="ring" />
        ))}
        <line x1="2" y1="50" x2="98" y2="50" className="axis" />
        <line x1="50" y1="2" x2="50" y2="98" className="axis" />
        {Array.from({ length: 24 }, (_, i) => {
          const a = (i * 15 * Math.PI) / 180
          return <line key={i} x1={50 + Math.cos(a) * 46.5} y1={50 + Math.sin(a) * 46.5} x2={50 + Math.cos(a) * 48} y2={50 + Math.sin(a) * 48} className="tick" />
        })}
        {spots.map(({ d, x, y }) => (
          <line key={d.host} x1="50" y1="50" x2={x} y2={y} className={`link ${d.existingDeviceId ? 'known' : ''}`} />
        ))}
      </svg>
      {scanning ? (
        <div className="sweepbox">
          <div className="sweep" />
        </div>
      ) : null}
      <div className="core">
        <span />
        <Icon name="home" />
      </div>
      {spots.map(({ d, x, y }) => (
        <button key={d.host} className={`blip ${d.existingDeviceId ? 'known' : ''}`} style={{ left: `${x}%`, top: `${y}%` }} onClick={() => onPick(d)} aria-label={`${d.name} at ${d.host}`}>
          <span className="dot">
            <Icon name={kindIcon(d.kind)} />
          </span>
          <span className="tag">
            {d.name.length > 18 ? d.name.slice(0, 17) + '…' : d.name}
            <em>{d.host}</em>
          </span>
        </button>
      ))}
      <span className="hud tl">{hub ? `HUB ${hub}` : 'HUB'}</span>
      <span className="hud tr">{label}</span>
      <span className="hud bl">{devices.length} FOUND</span>
      <span className="hud br">{scanning ? 'LIVE' : 'IDLE'}</span>
    </div>
  )
}

// ------------------------------------------------------------- quick add

interface TestOutcome {
  results: Array<{ label: string; ok: boolean; error: string | null }>
}

/** One sheet: name it, give what it still needs, add. The hub tests the connection first. */
function QuickAdd({ preset, onClose }: { preset: DiscoveredDevice; onClose: () => void }) {
  const families = useStore((s) => s.families)
  const wifi = useStore((s) => s.wifi)
  const devices = useStore((s) => s.devices)
  const toast = useStore((s) => s.toast)
  const fam = families.find((f) => f.id === preset.family)
  const kinds = fam?.kinds ?? [preset.kind]
  const [name, setName] = useState(preset.name)
  const [room, setRoom] = useState('')
  const [kind, setKind] = useState<DeviceKind>(kinds.includes(preset.kind) ? preset.kind : kinds[0] ?? 'other')
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [number, setNumber] = useState('')
  const [wifiId, setWifiId] = useState<string>(wifi.length === 1 ? wifi[0]!.id : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const rooms = useMemo(() => [...new Set(devices.map((d) => d.room).filter(Boolean))], [devices])

  if (!fam) {
    return (
      <Sheet title="Add a device" onClose={onClose}>
        <p className="note err">This kind of device is not available in this version of the app.</p>
      </Sheet>
    )
  }
  const pathKind = fam.pathKinds.includes('lan') && preset.host ? 'lan' : fam.pathKinds[0] ?? 'lan'
  const defaults: Record<string, unknown> = {}
  for (const f of fam.fields) if (f.default !== undefined) defaults[f.name] = f.default
  const config = { ...defaults, ...preset.config, ...values }
  const shown = (f: FieldSpec) => !f.showWhen || config[f.showWhen.field] === f.showWhen.equals
  // Ask only for what is still missing: what the scan said it needs, and anything required with no value yet.
  const asked = fam.fields.filter((f) => shown(f) && ((preset.needs ?? []).includes(f.name) || (f.required && (config[f.name] === undefined || config[f.name] === ''))))
  const missing = asked.filter((f) => f.required && (config[f.name] === undefined || config[f.name] === '')).map((f) => f.label)
  if (pathKind === 'sms' && !number.trim()) missing.push('Phone number')

  const build = (): DeviceInput => {
    const net = wifi.find((w) => w.id === wifiId)
    const path: PathInput =
      pathKind === 'sms'
        ? { priority: 0, kind: 'sms', label: 'SMS', host: number.trim() }
        : pathKind === 'cloud'
          ? { priority: 0, kind: 'cloud', label: 'Cloud' }
          : { priority: 0, kind: pathKind, label: net?.ssid ?? 'House WiFi', wifiNetworkId: net?.id ?? null, host: preset.host, port: preset.port ?? fam.defaultPort }
    return { name: name.trim(), kind, family: fam.id, room: room.trim(), config, paths: [path] }
  }

  const add = async (anyway: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const input = build()
      if (!anyway) {
        const test = await api.post<TestOutcome>('/api/devices/test', input)
        if (!test.results.some((r) => r.ok)) {
          setFailed(test.results[0]?.error ?? 'It did not answer')
          return
        }
      }
      const saved = await api.post<Device>('/api/devices', input)
      toast(`${saved.name} added`, 'ok')
      navigate(`/device/${saved.id}`, true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add it')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title={`Add ${fam.label}`} subtitle={preset.host ? `${preset.host}${preset.detail ? ' · ' + preset.detail : ''}` : preset.detail} onClose={onClose}>
      <div className="field">
        <label htmlFor="q-name">Name</label>
        <input id="q-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {kinds.length > 1 ? (
        <div className="field">
          <label>What is it?</label>
          <div className="btnrow">
            {kinds.map((k) => (
              <button key={k} className={`btn sm ${kind === k ? 'primary' : ''}`} onClick={() => setKind(k)}>
                <Icon name={kindIcon(k)} />
                {kindLabel(k)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="q-room">Where it is (optional)</label>
        <input id="q-room" className="input" list="q-rooms" value={room} placeholder="Main gate, Hall, Porch" onChange={(e) => setRoom(e.target.value)} />
        <datalist id="q-rooms">
          {rooms.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </div>
      {pathKind === 'sms' ? (
        <div className="field">
          <label htmlFor="q-number">Phone number of the SIM in the device</label>
          <input id="q-number" className="input" inputMode="tel" value={number} placeholder="+91 98xxx xxxxx" onChange={(e) => setNumber(e.target.value)} />
        </div>
      ) : null}
      {asked.map((f) => (
        <FieldInput key={f.name} spec={f} value={config[f.name]} onChange={(v) => (setValues((x) => ({ ...x, [f.name]: v })), setFailed(null))} />
      ))}
      {pathKind === 'lan' && wifi.length > 1 ? (
        <div className="field">
          <label htmlFor="q-wifi">Which WiFi is it on?</label>
          <select id="q-wifi" className="select" value={wifiId} onChange={(e) => setWifiId(e.target.value)}>
            <option value="">Not sure, or wired</option>
            {wifi.map((w) => (
              <option key={w.id} value={w.id}>
                {w.ssid}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {preset.hint ? <p className="note">{preset.hint}</p> : null}
      {error ? <p className="note err">{error}</p> : null}
      {failed ? (
        <>
          <p className="note warn">The hub could not reach it: {failed}. Check what you entered, or add it anyway and fix it later.</p>
          <div className="btnrow">
            <button className="btn primary" disabled={busy} onClick={() => void add(false)}>
              Try again
            </button>
            <button className="btn" disabled={busy} onClick={() => void add(true)}>
              Add anyway
            </button>
          </div>
        </>
      ) : (
        <button className="btn primary block" disabled={busy || !name.trim() || missing.length > 0} onClick={() => void add(false)}>
          {busy ? <span className="spinner sm" /> : <Icon name="plus" />}
          {busy ? 'Checking it answers…' : missing.length ? `Still needed: ${missing[0]}` : 'Add to my house'}
        </button>
      )}
      <button className="btn ghost block" style={{ marginTop: 10 }} onClick={() => navigate('/add/manual')}>
        More options
      </button>
    </Sheet>
  )
}

// --------------------------------------------------------------- address

function AddressSheet({ onClose, onFound }: { onClose: () => void; onFound: (d: DiscoveredDevice) => void }) {
  const [host, setHost] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [options, setOptions] = useState<DiscoveredDevice[] | null>(null)
  const look = async () => {
    setBusy(true)
    setError(null)
    setOptions(null)
    try {
      const list = await api.post<DiscoveredDevice[]>('/api/detect', { host: host.trim() })
      if (list.length === 1) onFound(list[0]!)
      else setOptions(list)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check that address')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title="I know its address" subtitle="The address is in your router's device list, or in the device's own app under network settings." onClose={onClose}>
      <div className="field">
        <label htmlFor="a-host">Address</label>
        <input
          id="a-host"
          className="input"
          value={host}
          inputMode="url"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          placeholder="192.168.1.50"
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && host.trim() && void look()}
        />
      </div>
      {error ? <p className="note err">{error}</p> : null}
      {options?.map((d) => (
        <button key={d.family} className="row" onClick={() => onFound(d)}>
          <span className="foundicon">
            <Icon name={kindIcon(d.kind)} />
          </span>
          <span className="grow">
            <span className="title" style={{ display: 'block' }}>
              {d.name}
            </span>
            <span className="desc">{d.detail}</span>
          </span>
        </button>
      ))}
      <button className="btn primary block" disabled={busy || !host.trim()} onClick={() => void look()}>
        {busy ? <span className="spinner sm" /> : <Icon name="search" />}
        {busy ? 'Looking…' : 'Find out what it is'}
      </button>
    </Sheet>
  )
}

// ------------------------------------------------------------ smart life

const REGIONS: Array<[string, string]> = [
  ['in', 'India'],
  ['sg', 'Singapore'],
  ['eu', 'Central Europe'],
  ['eu-w', 'Western Europe'],
  ['us', 'Western America'],
  ['us-e', 'Eastern America'],
  ['cn', 'China'],
]

function SmartLifeSheet({ heard, onClose }: { heard: number; onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const [account, setAccount] = useState<TuyaAccountStatus | null>(null)
  const [list, setList] = useState<TuyaAccountDevice[] | null>(null)
  const [kinds, setKinds] = useState<Record<string, DeviceKind>>({})
  const [accessId, setAccessId] = useState('')
  const [accessSecret, setAccessSecret] = useState('')
  const [region, setRegion] = useState('in')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setList(await api.get<TuyaAccountDevice[]>('/api/tuya/devices'))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the devices')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void api
      .get<TuyaAccountStatus>('/api/tuya/account')
      .then((a) => {
        setAccount(a)
        if (a.linked) void load()
      })
      .catch(() => setAccount({ linked: false, region: null, accessIdHint: null }))
  }, [load])

  const link = async () => {
    setBusy(true)
    setError(null)
    try {
      const a = await api.post<TuyaAccountStatus>('/api/tuya/account', { accessId, accessSecret, region })
      setAccount(a)
      setAccessSecret('')
      toast('Smart Life account linked', 'ok')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not link the account')
    } finally {
      setBusy(false)
    }
  }

  const add = async (devices: TuyaAccountDevice[]) => {
    setBusy(true)
    setError(null)
    try {
      const added = await api.post<Device[]>('/api/tuya/import', { devices: devices.map((d) => ({ id: d.id, kind: kinds[d.id] ?? d.suggestedKind })) })
      toast(added.length === 1 ? `${added[0]!.name} added` : `${added.length} devices added`, 'ok')
      if (added.length === 1) navigate(`/device/${added[0]!.id}`, true)
      else await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add it')
    } finally {
      setBusy(false)
    }
  }

  const unlink = async () => {
    await api.del('/api/tuya/account').catch(() => undefined)
    setAccount({ linked: false, region: null, accessIdHint: null })
    setList(null)
  }

  const ready = (list ?? []).filter((d) => d.supported && !d.existingDeviceId)

  if (!account) {
    return (
      <Sheet title="Smart Life / Tuya" onClose={onClose}>
        <div className="spinner" />
      </Sheet>
    )
  }

  if (!account.linked) {
    return (
      <Sheet
        title="Link your Smart Life account"
        subtitle={heard > 0 ? `The hub can hear ${heard} Smart Life device${heard === 1 ? '' : 's'} on your WiFi. To control ${heard === 1 ? 'it' : 'them'} it needs a key that only your account can give.` : 'One-time step. After it, every Smart Life device adds with one tap.'}
        onClose={onClose}
      >
        <details className="howto" open>
          <summary>How to get the two codes (about ten minutes, free)</summary>
          <ol>
            <li>
              On a computer open <strong>iot.tuya.com</strong> and sign up.
            </li>
            <li>
              Go to <strong>Cloud, Development, Create Cloud Project</strong>. Choose <strong>Smart Home</strong> and the <strong>India</strong> data centre. Keep <strong>IoT Core</strong> ticked on the next step.
            </li>
            <li>
              Open the project, then <strong>Devices, Link App Account, Add App Account</strong>. Scan the code with the Smart Life app (the scan icon on its Me page) and confirm.
            </li>
            <li>
              Open the project{'’'}s <strong>Overview</strong> and copy the <strong>Access ID</strong> and <strong>Access Secret</strong> below.
            </li>
          </ol>
          <p>The codes stay on your hub, encrypted. Tuya{'’'}s free plan needs renewing about once a month on that site; devices on your WiFi keep working without it.</p>
        </details>
        <div className="field">
          <label htmlFor="t-id">Access ID</label>
          <input id="t-id" className="input" value={accessId} autoCapitalize="off" autoComplete="off" spellCheck={false} onChange={(e) => setAccessId(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="t-secret">Access Secret</label>
          <input id="t-secret" className="input" type="password" value={accessSecret} autoComplete="off" onChange={(e) => setAccessSecret(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="t-region">Data centre</label>
          <select id="t-region" className="select" value={region} onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        {error ? <p className="note err">{error}</p> : null}
        <button className="btn primary block" disabled={busy || !accessId.trim() || !accessSecret.trim()} onClick={() => void link()}>
          {busy ? <span className="spinner sm" /> : <Icon name="check" />}
          {busy ? 'Checking with Tuya…' : 'Link the account'}
        </button>
      </Sheet>
    )
  }

  return (
    <Sheet title="Your Smart Life devices" subtitle={`Account linked (project ${account.accessIdHint ?? ''}). Tap Add on anything you want in the house.`} onClose={onClose}>
      {error ? <p className="note err">{error}</p> : null}
      {busy && !list ? <div className="spinner" style={{ margin: '12px auto' }} /> : null}
      {list && list.length === 0 ? <p className="note">The account has no devices yet. Add them in the Smart Life app first.</p> : null}
      {(list ?? []).map((d) => (
        <div key={d.id} className="tuyarow">
          <div className="row" style={{ borderTop: 0, minHeight: 0, padding: 0 }}>
            <span className="foundicon">
              <Icon name={kindIcon(kinds[d.id] ?? d.suggestedKind)} />
            </span>
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>
                {d.name}
              </span>
              <span className="desc">
                {d.categoryLabel} {'·'} {d.lanHost ? `on your WiFi at ${d.lanHost}` : d.online ? 'reached through the cloud' : 'switched off or out of reach'}
              </span>
            </span>
            {d.existingDeviceId ? (
              <button className="btn sm" onClick={() => navigate(`/device/${d.existingDeviceId}`)}>
                Open
              </button>
            ) : d.supported ? (
              <button className="btn sm primary" disabled={busy} onClick={() => void add([d])}>
                Add
              </button>
            ) : null}
          </div>
          {d.existingDeviceId ? null : d.supported ? (
            <div className="btnrow" style={{ marginTop: 8 }}>
              {(['light', 'switch', 'gate'] as DeviceKind[]).map((k) => (
                <button key={k} className={`btn sm ${(kinds[d.id] ?? d.suggestedKind) === k ? 'primary' : 'ghost'}`} onClick={() => setKinds((x) => ({ ...x, [d.id]: k }))}>
                  {kindLabel(k)}
                </button>
              ))}
            </div>
          ) : (
            <p className="desc" style={{ marginTop: 6 }}>
              {d.reason}
            </p>
          )}
        </div>
      ))}
      <div className="btnrow stack" style={{ marginTop: 14 }}>
        {ready.length > 1 ? (
          <button className="btn primary" disabled={busy} onClick={() => void add(ready)}>
            <Icon name="plus" />
            Add all {ready.length}
          </button>
        ) : null}
        <button className="btn" disabled={busy} onClick={() => void load()}>
          {busy ? <span className="spinner sm" /> : <Icon name="refresh" />}
          Load the list again
        </button>
        <button className="btn ghost" onClick={() => void unlink()}>
          Unlink this account
        </button>
      </div>
    </Sheet>
  )
}
