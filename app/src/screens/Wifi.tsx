import { useState } from 'react'
import { SECRET_MASK, type WifiNetwork } from '@house/shared'
import { api, ApiError } from '../api.ts'
import { Icon } from '../components/icons.tsx'
import { Sheet, TopBar, nextSecretValue } from '../components/ui.tsx'
import { useStore } from '../store.ts'

interface Edit {
  id: string | null
  ssid: string
  password: string
  notes: string
}

/** The WiFi networks of the house. Devices can be moved between these from their own page. */
export function WifiScreen() {
  const wifi = useStore((s) => s.wifi)
  const devices = useStore((s) => s.devices)
  const states = useStore((s) => s.states)
  const toast = useStore((s) => s.toast)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const onNetwork = (w: WifiNetwork) =>
    devices.filter((d) => {
      const active = d.paths.find((p) => p.id === states[d.id]?.activePathId)
      return active?.wifiNetworkId === w.id
    })

  const save = async () => {
    if (!edit) return
    setBusy(true)
    setError(null)
    try {
      const body = { ssid: edit.ssid, password: edit.password, notes: edit.notes }
      if (edit.id) await api.put(`/api/wifi/${edit.id}`, body)
      else await api.post('/api/wifi', body)
      toast(`${edit.ssid} saved`, 'ok')
      setEdit(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!edit?.id) return
    setBusy(true)
    try {
      await api.del(`/api/wifi/${edit.id}`)
      toast(`${edit.ssid} removed`, 'info')
      setEdit(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <TopBar
        title="WiFi networks"
        sub="The networks of the house"
        right={
          <button className="iconbtn" onClick={() => (setConfirmRemove(false), setError(null), setEdit({ id: null, ssid: '', password: '', notes: '' }))} aria-label="Add WiFi network">
            <Icon name="plus" />
          </button>
        }
      />
      <main className="content">
        <p className="note">Store each house network once, with its password. Then any device that supports it can be moved to another network from its own page, and the hub knows where to look for it.</p>
        {wifi.length === 0 ? (
          <div className="empty">
            <h2>No networks yet</h2>
            <p>Add the main router first, then any backup router.</p>
          </div>
        ) : (
          <div className="card">
            {wifi.map((w) => {
              const here = onNetwork(w)
              return (
                <button key={w.id} className="row" onClick={() => (setConfirmRemove(false), setError(null), setEdit({ id: w.id, ssid: w.ssid, password: w.hasPassword ? SECRET_MASK : '', notes: w.notes }))}>
                  <Icon name="wifi" className="picon" />
                  <span className="grow">
                    <span className="title" style={{ display: 'block' }}>
                      {w.ssid}
                    </span>
                    <span className="desc">
                      {[w.notes, w.hasPassword ? null : 'no password stored', here.length ? `${here.length} device${here.length === 1 ? '' : 's'} on it now` : 'no devices on it now'].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <Icon name="more" className="picon" />
                </button>
              )
            })}
          </div>
        )}
        {edit ? (
          <Sheet title={edit.id ? 'Edit network' : 'Add a network'} onClose={() => setEdit(null)}>
            <div className="field">
              <label htmlFor="w-ssid">Network name (SSID)</label>
              <input id="w-ssid" className="input" value={edit.ssid} autoCapitalize="off" autoComplete="off" spellCheck={false} onChange={(e) => setEdit({ ...edit, ssid: e.target.value })} />
              <div className="help">Exactly as the router shows it, capitals included.</div>
            </div>
            <div className="field">
              <label htmlFor="w-pass">Password</label>
              <input
                id="w-pass"
                className="input"
                type="password"
                value={edit.password}
                autoComplete="off"
                onFocus={(e) => edit.password === SECRET_MASK && e.target.select()}
                onChange={(e) => setEdit({ ...edit, password: nextSecretValue(edit.password, e.target.value) })}
              />
              <div className="help">
                {edit.password === SECRET_MASK ? 'Saved. Type a new one to change it; leave it alone to keep it. ' : ''}Kept encrypted on the hub. Needed to move a device onto this network.
              </div>
            </div>
            <div className="field">
              <label htmlFor="w-notes">Note (optional)</label>
              <input id="w-notes" className="input" value={edit.notes} placeholder="Main router, 4G router in the hall" onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
            </div>
            {error ? <p className="note err">{error}</p> : null}
            {confirmRemove ? (
              <>
                <p className="note warn">
                  Remove {edit.ssid} and its stored password? Devices keep their connections, but they can no longer be moved onto this network from the app.
                </p>
                <div className="btnrow">
                  <button className="btn danger" disabled={busy} onClick={() => void remove()}>
                    Yes, remove it
                  </button>
                  <button className="btn ghost" onClick={() => setConfirmRemove(false)}>
                    Keep it
                  </button>
                </div>
              </>
            ) : (
              <>
                <button className="btn primary block" disabled={busy || !edit.ssid.trim()} onClick={() => void save()}>
                  Save
                </button>
                {edit.id ? (
                  <button className="btn ghost block" style={{ marginTop: 18, color: 'var(--err)' }} disabled={busy} onClick={() => setConfirmRemove(true)}>
                    Remove this network
                  </button>
                ) : null}
              </>
            )}
          </Sheet>
        ) : null}
      </main>
    </>
  )
}
