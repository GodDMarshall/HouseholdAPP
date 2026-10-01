import { useEffect, useState } from 'react'
import type { EventRecord } from '@house/shared'
import { api } from '../api.ts'
import { TopBar } from '../components/ui.tsx'
import { clock, usePending } from '../lib.ts'
import { navigate } from '../router.ts'
import { useStore } from '../store.ts'

/** Everything that happened: commands, connection changes, problems. */
export function ActivityScreen() {
  const events = useStore((s) => s.events)
  const setEvents = useStore((s) => s.setEvents)
  const devices = useStore((s) => s.devices)
  const pending = usePending()
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<EventRecord[]>('/api/events?limit=200')
      .then((list) => {
        if (cancelled) return
        const seen = new Set(list.map((e) => e.id))
        const live = useStore.getState().events.filter((e) => !seen.has(e.id))
        setEvents([...live, ...list].sort((a, b) => b.ts.localeCompare(a.ts)))
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
    return () => {
      cancelled = true
    }
  }, [setEvents])

  const shown = onlyProblems ? events.filter((e) => e.level !== 'info') : events
  return (
    <>
      <TopBar title="Activity" sub="What the house has been doing" />
      <main className="content">
        {pending.map((a) => (
          <button key={a.id} className="banner" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(`/device/${a.deviceId}`)}>
            <strong>{devices.find((d) => d.id === a.deviceId)?.name ?? 'Device'}:</strong> {a.label} needs you. Tap to finish it.
          </button>
        ))}
        <div className="btnrow" style={{ margin: '8px 0' }}>
          <button className={`btn sm ${onlyProblems ? '' : 'primary'}`} onClick={() => setOnlyProblems(false)}>
            Everything
          </button>
          <button className={`btn sm ${onlyProblems ? 'primary' : ''}`} onClick={() => setOnlyProblems(true)}>
            Problems only
          </button>
        </div>
        {shown.length === 0 ? (
          <div className="empty">{loaded ? <p>{onlyProblems ? 'No problems recorded.' : 'Nothing has happened yet.'}</p> : <div className="spinner" style={{ margin: '0 auto' }} />}</div>
        ) : (
          <div className="card feed">
            {shown.map((e) => (
              <button key={e.id} className="row" disabled={!e.deviceId} onClick={() => e.deviceId && navigate(`/device/${e.deviceId}`)}>
                <span className={`lvl ${e.level}`} />
                <span className="grow desc" style={{ color: 'var(--text)', fontSize: 15 }}>
                  {e.message}
                </span>
                <span className="time">{clock(e.ts)}</span>
              </button>
            ))}
          </div>
        )}
      </main>
    </>
  )
}
