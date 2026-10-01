import { useEffect, type ReactNode } from 'react'
import type { ConnectionPath, Device, DeviceState, FieldSpec, PathHealth } from '@house/shared'
import { SECRET_MASK } from '@house/shared'
import { useStore } from '../store.ts'
import { navigate } from '../router.ts'
import { Icon, pathIcon } from './icons.tsx'

export function Sheet({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="sheet-back" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <h2>{title}</h2>
        {subtitle ? <div className="ssub">{subtitle}</div> : <div style={{ height: 8 }} />}
        {children}
      </div>
    </div>
  )
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="toasts" aria-live="polite">
      {toasts.slice(-3).map((t) => (
        <div
          key={t.id}
          className={`toast ${t.level}`}
          onClick={() => {
            dismiss(t.id)
            if (t.deviceId && (t.level === 'warn' || t.level === 'error')) navigate(`/device/${t.deviceId}`)
          }}
        >
          <span className="tdot" />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

/** The little "On Home WiFi" / "SIM" / "Offline" pill on every tile. */
export function ConnChip({ device, state }: { device: Device; state: DeviceState | undefined }) {
  if (!state) return <span className="chip">{'…'}</span>
  if (!state.online) return <span className="chip err"><Icon name="alert" />Offline</span>
  const active = device.paths.find((p) => p.id === state.activePathId)
  if (!active) return <span className="chip ok">Online</span>
  const first = device.paths.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority)[0]
  const fallback = first && first.id !== active.id
  const cls = active.kind === 'sms' ? 'warn' : fallback ? 'blue' : 'ok'
  return (
    <span className={`chip ${cls}`}>
      <Icon name={pathIcon(active.kind)} />
      {active.label}
    </span>
  )
}

export function pathSubtitle(path: ConnectionPath, health: PathHealth | undefined): string {
  const where = path.kind === 'sms' ? path.host ?? '' : path.host ? `${path.host}${path.port ? ':' + path.port : ''}` : 'address not set'
  if (!path.enabled) return `${where} · turned off`
  if (!health || health.status === 'unknown') return `${where} · not checked yet`
  if (health.status === 'checking') return `${where} · checking…`
  if (health.status === 'up') {
    if (path.kind === 'sms') return `${where} · ready (texts cannot be checked)`
    return `${where} · ${health.latencyMs != null ? health.latencyMs + ' ms' : 'answering'}`
  }
  return `${where} · ${health.error ?? 'not answering'}`
}

export function TopBar({ title, sub, onBack, right }: { title: string; sub?: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <header className="topbar">
      {onBack ? (
        <button className="iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      ) : null}
      <h1>
        {title}
        {sub ? <div className="sub">{sub}</div> : null}
      </h1>
      {right}
    </header>
  )
}

/** One form field drawn from a family descriptor. */
export function FieldInput({ spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  const id = `f-${spec.name}`
  if (spec.type === 'toggle') {
    const on = value === true || value === 'true'
    return (
      <div className="field">
        <div className="row" style={{ borderTop: 0, padding: 0 }}>
          <div className="grow">
            <div className="title">{spec.label}</div>
            {spec.help ? <div className="desc">{spec.help}</div> : null}
          </div>
          <Switch on={on} onChange={onChange} label={spec.label} />
        </div>
      </div>
    )
  }
  return (
    <div className="field">
      <label htmlFor={id}>
        {spec.label}
        {spec.required ? '' : ' (optional)'}
      </label>
      {spec.type === 'select' ? (
        <select id={id} className="select" value={String(value ?? spec.default ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(spec.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : spec.type === 'textarea' ? (
        <textarea id={id} className="textarea" value={String(value ?? '')} placeholder={spec.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          id={id}
          className="input"
          type={spec.type === 'password' ? 'password' : spec.type === 'number' ? 'number' : 'text'}
          inputMode={spec.type === 'number' ? 'decimal' : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={String(value ?? '')}
          placeholder={spec.placeholder}
          onFocus={(e) => {
            // Select the saved dots so typing replaces them. Looking at the field changes nothing.
            if (spec.secret && e.target.value === SECRET_MASK) e.target.select()
          }}
          onChange={(e) =>
            onChange(spec.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : spec.secret ? nextSecretValue(String(value ?? ''), e.target.value) : e.target.value)
          }
        />
      )}
      {spec.secret && value === SECRET_MASK ? <div className="help">Saved. Type a new one to change it; leave it alone to keep it.</div> : null}
      {spec.help ? <div className="help">{spec.help}</div> : null}
    </div>
  )
}

/**
 * Editing a saved secret that the app only knows as dots. Typing replaces the
 * dots with what was typed; nibbling at the dots keeps the saved value; only
 * emptying the field clears it.
 */
export function nextSecretValue(previous: string, typed: string): string {
  if (previous !== SECRET_MASK) return typed
  if (typed === '') return ''
  const real = typed.split('•').join('')
  return real === '' ? SECRET_MASK : real
}
