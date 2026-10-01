import { useEffect, useMemo, useState } from 'react'
import {
  kindLabel,
  pathKindLabel,
  type Capability,
  type Device,
  type DeviceKind,
  type DiscoveredDevice,
  type Family,
  type FamilyDescriptor,
  type NotifyLevel,
  type PathInput,
  type PathKind,
} from '@house/shared'
import { api, ApiError } from '../api.ts'
import { Icon, kindIcon, pathIcon } from '../components/icons.tsx'
import { FieldInput, Sheet, Switch, TopBar } from '../components/ui.tsx'
import { back, navigate, popSteps, pushStep } from '../router.ts'
import { useStore } from '../store.ts'

interface Draft {
  name: string
  kind: DeviceKind
  family: Family | ''
  room: string
  config: Record<string, unknown>
  paths: PathInput[]
  notify: NotifyLevel
}

const NOTIFY_CHOICES: Array<{ value: NotifyLevel; label: string }> = [
  { value: 'everything', label: 'Everything it does' },
  { value: 'important', label: 'What matters: gates, WiFi moves, problems' },
  { value: 'problems', label: 'Only problems' },
  { value: 'none', label: 'Nothing' },
]

interface TestResult {
  capabilities: Capability[]
  results: Array<{ pathId: string; label: string; ok: boolean; latencyMs: number | null; error: string | null; unverifiable: boolean }>
}

const KINDS: Array<{ kind: DeviceKind; desc: string }> = [
  { kind: 'camera', desc: 'Live view, pan and tilt, pictures' },
  { kind: 'gate', desc: 'Main gate or garage door: open, stop, close' },
  { kind: 'light', desc: 'On, off and brightness' },
  { kind: 'switch', desc: 'Sockets, pumps, anything on a relay' },
  { kind: 'sensor', desc: 'Something that only reports' },
  { kind: 'other', desc: 'Anything else' },
]

const CAP_TEXT: Partial<Record<Capability, string>> = {
  power: 'on / off',
  dim: 'brightness',
  gate: 'gate control',
  'gate-state': 'knows open / closed',
  ptz: 'pan and tilt',
  presets: 'presets',
  snapshot: 'pictures',
  stream: 'live video',
  wifi: 'can be moved between WiFi networks',
  'wifi-scan': 'can list WiFi it sees',
  cellular: 'reports SIM status',
  reboot: 'restart',
  sms: 'text commands',
}

/** Add a device (stepped) or edit one (everything on one page). */
export function DeviceForm({ id }: { id?: string }) {
  const editing = Boolean(id)
  const existing = useStore((s) => (id ? s.devices.find((d) => d.id === id) : undefined))
  const families = useStore((s) => s.families)
  const setFamilies = useStore((s) => s.setFamilies)
  const wifi = useStore((s) => s.wifi)
  const devices = useStore((s) => s.devices)
  const toast = useStore((s) => s.toast)

  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<Draft>({ name: '', kind: 'camera', family: '', room: '', config: {}, paths: [], notify: 'important' })
  const [loaded, setLoaded] = useState(!editing)
  const [test, setTest] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [found, setFound] = useState<DiscoveredDevice[] | null>(null)
  const [finding, setFinding] = useState(false)

  useEffect(() => {
    if (families.length === 0) void api.get<FamilyDescriptor[]>('/api/families').then(setFamilies).catch(() => undefined)
  }, [families.length, setFamilies])

  useEffect(() => {
    if (editing && existing && !loaded) {
      setDraft({ name: existing.name, kind: existing.kind, family: existing.family, room: existing.room, config: { ...existing.config }, paths: existing.paths.map((p) => ({ ...p })), notify: existing.notify })
      setLoaded(true)
    }
  }, [editing, existing, loaded])

  // Each wizard step is a history entry: the phone's Back button goes one step
  // back and keeps everything typed, instead of throwing the form away.
  const goTo = (n: number) => {
    pushStep(n)
    setStep(n)
  }
  useEffect(() => {
    if (editing) return
    const onPop = (e: PopStateEvent) => {
      const st = (e.state as { hcStep?: number } | null)?.hcStep
      setStep(typeof st === 'number' ? st : 0)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [editing])

  const family = families.find((f) => f.id === draft.family)
  const usable = useMemo(() => families.filter((f) => f.kinds.includes(draft.kind)), [families, draft.kind])
  const rooms = useMemo(() => [...new Set(devices.map((d) => d.room).filter(Boolean))], [devices])
  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }))
    setTest(null)
    setError(null)
  }

  const defaultPath = (f: FamilyDescriptor, kind: PathKind): PathInput => ({
    priority: 0,
    kind,
    label: kind === 'lan' ? wifi[0]?.ssid ?? 'WiFi' : kind === 'cellular' ? 'SIM' : kind === 'sms' ? 'SMS' : 'Cloud',
    wifiNetworkId: kind === 'lan' ? wifi[0]?.id ?? null : null,
    host: '',
    port: kind === 'lan' || kind === 'cellular' ? f.defaultPort : null,
    extra: {},
    enabled: true,
  })

  const chooseFamily = (f: FamilyDescriptor, preset?: DiscoveredDevice) => {
    const config: Record<string, unknown> = {}
    for (const field of f.fields) if (field.default !== undefined) config[field.name] = field.default
    const first = f.pathKinds[0]
    const paths = first ? [defaultPath(f, first)] : []
    if (preset && paths[0]) {
      paths[0].host = preset.host
      paths[0].port = preset.port ?? f.defaultPort
    }
    patch({ family: f.id, config: { ...config, ...(preset?.config ?? {}) }, paths, name: preset?.name ?? draft.name })
  }

  const discover = async () => {
    setFinding(true)
    try {
      setFound(await api.get<DiscoveredDevice[]>('/api/discover?seconds=4'))
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Search failed', 'error')
    } finally {
      setFinding(false)
    }
  }

  const body = () => ({ ...draft, paths: draft.paths.map((p, i) => ({ ...p, priority: i, host: p.host?.toString().trim() || null, port: p.port ? Number(p.port) : null })) })

  const runTest = async () => {
    setTesting(true)
    setError(null)
    try {
      setTest(await api.post<TestResult>('/api/devices/test', { ...body(), id }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const saved = editing ? await api.put<Device>(`/api/devices/${id}`, body()) : await api.post<Device>('/api/devices', body())
      toast(`${saved.name} saved`, 'ok')
      // Fold the wizard's own steps away so Back from the new device goes home, not into an empty form.
      if (!editing) await popSteps(step)
      navigate(`/device/${saved.id}`, true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    try {
      await api.del(`/api/devices/${id}`)
      toast(`${draft.name} removed`, 'info')
      navigate('/', true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove')
    }
  }

  if (editing && !loaded) {
    return (
      <>
        <TopBar title="Edit device" onBack={() => back(id ? `/device/${id}` : '/')} />
        <main className="content">
          <div className="empty">
            <div className="spinner" style={{ margin: '0 auto' }} />
          </div>
        </main>
      </>
    )
  }

  // ------------------------------------------------------------ sections

  const kindSection = (
    <div className="choices">
      {KINDS.map(({ kind, desc }) => (
        <button key={kind} className={`choice ${draft.kind === kind ? 'sel' : ''}`} onClick={() => patch({ kind, family: '', config: {}, paths: [] })}>
          <span className="ctitle">
            <Icon name={kindIcon(kind)} />
            {kindLabel(kind)}
          </span>
          <span className="cdesc">{desc}</span>
        </button>
      ))}
    </div>
  )

  const familySection = (
    <>
      <div className="choices">
        {usable.map((f) => (
          <button key={f.id} className={`choice full ${draft.family === f.id ? 'sel' : ''}`} onClick={() => chooseFamily(f)}>
            <span className="ctitle">{f.label}</span>
            <span className="cdesc">{f.tagline}</span>
          </button>
        ))}
      </div>
      {usable.length === 0 ? <p className="note warn">Nothing in this build can drive a {kindLabel(draft.kind).toLowerCase()} yet.</p> : null}
      <div className="btnrow" style={{ marginTop: 14 }}>
        <button className="btn" disabled={finding} onClick={() => void discover()}>
          {finding ? <span className="spinner sm" /> : <Icon name="search" />}
          Find devices on the network
        </button>
      </div>
      {found ? (
        found.length === 0 ? (
          <p className="note">Nothing answered. Cameras must have ONVIF switched on to be found; you can still add them by address.</p>
        ) : (
          <div className="card">
            <h2>Found on the network</h2>
            {found.map((d) => {
              const f = families.find((x) => x.id === d.family)
              return (
                <button
                  key={`${d.family}-${d.host}`}
                  className="row"
                  disabled={!f || f.kinds.length === 0}
                  onClick={() => {
                    if (!f) return
                    setDraft((prev) => ({ ...prev, kind: f.kinds.includes(prev.kind) ? prev.kind : d.kind }))
                    chooseFamily(f, d)
                    if (!editing) goTo(2)
                  }}
                >
                  <Icon name={kindIcon(d.kind)} className="picon" />
                  <span className="grow">
                    <span className="title" style={{ display: 'block' }}>
                      {d.name}
                    </span>
                    <span className="desc">
                      {d.host}
                      {d.port ? ':' + d.port : ''} {'·'} {f?.label ?? d.family} {d.detail ? '· ' + d.detail : ''}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )
      ) : null}
    </>
  )

  const detailsSection = (
    <>
      <div className="field">
        <label htmlFor="f-name">Name</label>
        <input id="f-name" className="input" value={draft.name} placeholder={draft.kind === 'camera' ? 'Gate camera' : draft.kind === 'gate' ? 'Main gate' : 'Veranda light'} onChange={(e) => patch({ name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="f-room">Where it is (optional)</label>
        <input id="f-room" className="input" list="rooms" value={draft.room} placeholder="Main gate, Hall, Porch" onChange={(e) => patch({ room: e.target.value })} />
        <datalist id="rooms">
          {rooms.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </div>
      {family?.fields
        .filter((f) => !f.showWhen || draft.config[f.showWhen.field] === f.showWhen.equals)
        .map((f) => (
          <FieldInput key={f.name} spec={f} value={draft.config[f.name]} onChange={(v) => patch({ config: { ...draft.config, [f.name]: v } })} />
        ))}
      <div className="field">
        <label htmlFor="f-notify">Notify my phone about</label>
        <select id="f-notify" className="select" value={draft.notify} onChange={(e) => patch({ notify: e.target.value as NotifyLevel })}>
          {NOTIFY_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {family?.notes.map((n, i) => (
        <p key={i} className="note">
          {n}
        </p>
      ))}
    </>
  )

  const setPath = (i: number, p: Partial<PathInput>) => patch({ paths: draft.paths.map((x, j) => (j === i ? { ...x, ...p } : x)) })
  const movePath = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= draft.paths.length) return
    const paths = [...draft.paths]
    ;[paths[i], paths[j]] = [paths[j]!, paths[i]!]
    patch({ paths })
  }

  const pathsSection = (
    <>
      <p className="note">The hub tries these from the top. The first one that answers is used; if it stops answering the next one takes over.</p>
      {draft.paths.map((p, i) => (
        <div key={p.id ?? i} className="pathcard">
          <div className="phead">
            <Icon name={pathIcon(p.kind)} className="picon" />
            <span className="grow">
              {i + 1}. {pathKindLabel(p.kind)}
            </span>
            <button className="iconbtn" style={{ width: 36, height: 36 }} onClick={() => movePath(i, -1)} disabled={i === 0} aria-label="Move up">
              <Icon name="up" />
            </button>
            <button className="iconbtn" style={{ width: 36, height: 36 }} onClick={() => movePath(i, 1)} disabled={i === draft.paths.length - 1} aria-label="Move down">
              <Icon name="down" />
            </button>
            <button className="iconbtn" style={{ width: 36, height: 36 }} onClick={() => patch({ paths: draft.paths.filter((_, j) => j !== i) })} aria-label="Remove connection">
              <Icon name="trash" />
            </button>
          </div>
          {p.kind === 'lan' ? (
            <div className="field">
              <label>WiFi network</label>
              <select
                className="select"
                value={p.wifiNetworkId ?? ''}
                onChange={(e) => {
                  const w = wifi.find((x) => x.id === e.target.value)
                  setPath(i, { wifiNetworkId: e.target.value || null, label: w ? w.ssid : 'Wired / other' })
                }}
              >
                <option value="">Wired / not a stored WiFi</option>
                {wifi.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.ssid}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {p.kind === 'cloud' ? (
            <p className="help" style={{ color: 'var(--muted)', fontSize: 13 }}>
              Reached through the maker{'’'}s cloud. No address needed.
            </p>
          ) : (
            <div className={p.kind === 'sms' ? '' : 'two'}>
              <div className="field" style={{ margin: '8px 0' }}>
                <label>{p.kind === 'sms' ? 'Phone number of the SIM in the device' : p.kind === 'cellular' ? 'Public address of the SIM' : 'Address (IP)'}</label>
                <input
                  className="input"
                  value={p.host ?? ''}
                  inputMode={p.kind === 'sms' ? 'tel' : 'url'}
                  autoCapitalize="off"
                  autoComplete="off"
                  placeholder={p.kind === 'sms' ? '+91 98xxx xxxxx' : p.kind === 'cellular' ? 'e.g. 49.205.12.77' : 'e.g. 192.168.1.50'}
                  onChange={(e) => setPath(i, { host: e.target.value })}
                />
              </div>
              {p.kind !== 'sms' ? (
                <div className="field" style={{ margin: '8px 0' }}>
                  <label>Port</label>
                  <input className="input" type="number" inputMode="numeric" value={p.port ?? ''} onChange={(e) => setPath(i, { port: e.target.value ? Number(e.target.value) : null })} />
                </div>
              ) : null}
            </div>
          )}
          {p.kind === 'cellular' ? <p className="help" style={{ color: 'var(--muted)', fontSize: 13 }}>Works only when the carrier gives this SIM a public address. The test below tells you.</p> : null}
          <div className="row" style={{ borderTop: 0, minHeight: 44 }}>
            <span className="grow desc">Use this connection</span>
            <Switch on={p.enabled !== false} onChange={(v) => setPath(i, { enabled: v })} label="Use this connection" />
          </div>
        </div>
      ))}
      {family ? (
        <div className="btnrow">
          {family.pathKinds.map((k) => (
            <button key={k} className="btn sm" onClick={() => patch({ paths: [...draft.paths, defaultPath(family, k)] })}>
              <Icon name="plus" />
              {pathKindLabel(k)}
            </button>
          ))}
        </div>
      ) : null}
    </>
  )

  const testSection = (
    <>
      <button className="btn block" disabled={testing || !family || draft.paths.length === 0} onClick={() => void runTest()}>
        {testing ? <span className="spinner sm" /> : <Icon name="refresh" />}
        Test the connections
      </button>
      {test ? (
        <div className="card" style={{ background: 'var(--bg-2)' }}>
          {test.results.map((r) => (
            <div key={r.pathId} className="row">
              <span className={`pdot ${r.ok ? 'up' : 'down'}`} style={{ width: 12, height: 12, borderRadius: '50%', background: r.ok ? 'var(--ok)' : 'var(--err)' }} />
              <span className="grow">
                <span className="title" style={{ display: 'block' }}>
                  {r.label}
                </span>
                <span className="desc">{r.ok ? (r.unverifiable ? 'Ready. Texts cannot be checked in advance.' : `Answering${r.latencyMs != null ? ` in ${r.latencyMs} ms` : ''}`) : r.error ?? 'No answer'}</span>
              </span>
            </div>
          ))}
          {test.capabilities.length ? (
            <p className="note ok">
              It can do:{' '}
              {test.capabilities
                .map((c) => CAP_TEXT[c])
                .filter(Boolean)
                .join(', ')}
              .
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="note err">{error}</p> : null}
      <button className="btn primary block" style={{ marginTop: 12 }} disabled={saving || !family || !draft.name.trim()} onClick={() => void save()}>
        {saving ? <span className="spinner sm" /> : <Icon name="check" />}
        {editing ? 'Save changes' : 'Save device'}
      </button>
    </>
  )

  // -------------------------------------------------------------- render

  if (editing) {
    return (
      <>
        <TopBar title={`Edit ${existing?.name ?? 'device'}`} onBack={() => back(`/device/${id}`)} />
        <main className="content" style={{ paddingBottom: 40 }}>
          <div className="card">
            <h2>Details</h2>
            {detailsSection}
          </div>
          <div className="card">
            <h2>Connections</h2>
            {pathsSection}
          </div>
          <div className="card">
            <h2>Test and save</h2>
            {testSection}
          </div>
          <button className="btn danger block" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" />
            Remove this device
          </button>
          {confirmDelete ? (
            <Sheet title={`Remove ${draft.name}?`} subtitle="Its settings, connections and history are deleted from the hub. The device itself is not touched." onClose={() => setConfirmDelete(false)}>
              <div className="btnrow">
                <button className="btn danger" onClick={() => void remove()}>
                  Remove
                </button>
                <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </button>
              </div>
            </Sheet>
          ) : null}
        </main>
      </>
    )
  }

  const titles = ['What is it?', 'How does it connect?', 'Its details', 'Ways to reach it', 'Test and save']
  const canNext = step === 0 ? true : step === 1 ? Boolean(family) : step === 2 ? Boolean(draft.name.trim()) : step === 3 ? draft.paths.length > 0 : false
  return (
    <>
      <TopBar title="Add a device" sub={`Step ${step + 1} of 5 · ${titles[step]}`} onBack={() => (step === 0 ? back('/') : history.back())} />
      <main className="content" style={{ paddingBottom: 40 }}>
        <div className="steps">
          {titles.map((_, i) => (
            <span key={i} className={i <= step ? 'done' : ''} />
          ))}
        </div>
        {step === 0 ? kindSection : step === 1 ? familySection : step === 2 ? detailsSection : step === 3 ? pathsSection : testSection}
        {step < 4 ? (
          <button className="btn primary block" style={{ marginTop: 18 }} disabled={!canNext} onClick={() => goTo(step + 1)}>
            Next
            <Icon name="right" />
          </button>
        ) : null}
      </main>
    </>
  )
}
