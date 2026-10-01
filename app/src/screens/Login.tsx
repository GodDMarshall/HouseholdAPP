import { useEffect, useState } from 'react'
import { api, ApiError, setToken } from '../api.ts'
import { Logo } from '../App.tsx'
import { useStore } from '../store.ts'

const MAX = 8

/** PIN pad. First run sets the PIN (typed twice); after that it signs in. */
export function LoginScreen({ mode, onDone }: { mode: 'setup' | 'login'; onDone: () => void }) {
  const [pin, setPin] = useState('')
  const [first, setFirst] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(false)

  const fail = (msg: string) => {
    setError(msg)
    setPin('')
    setShake(true)
    window.setTimeout(() => setShake(false), 400)
  }

  const submit = async () => {
    if (busy) return
    if (pin.length < 4) return fail('At least 4 digits')
    if (mode === 'setup' && first === null) {
      setFirst(pin)
      setPin('')
      setError(null)
      return
    }
    if (mode === 'setup' && first !== pin) {
      setFirst(null)
      return fail('The two PINs did not match. Start again.')
    }
    setBusy(true)
    try {
      const res = await api.post<{ token: string }>(mode === 'setup' ? '/api/auth/setup' : '/api/auth/login', { pin })
      setToken(res.token)
      onDone()
    } catch (err) {
      if (mode === 'setup' && err instanceof ApiError && err.status === 409) {
        // Another phone set the PIN a moment ago: this one now signs in with it.
        setFirst(null)
        setPin('')
        setError('A PIN was just set on another phone. Enter that PIN.')
        useStore.getState().setAuth('login')
        return
      }
      fail(err instanceof ApiError ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const press = (d: string) => {
    setError(null)
    setPin((p) => (p.length < MAX ? p + d : p))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key)
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1))
      else if (e.key === 'Enter') void submit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const title = mode === 'setup' ? (first === null ? 'Choose a PIN' : 'Type it again') : 'House Control'
  const hint =
    mode === 'setup'
      ? first === null
        ? 'This PIN protects the house. 4 to 8 digits. Every phone that opens the app will need it once.'
        : 'Enter the same PIN once more to confirm.'
      : 'Enter the house PIN.'

  return (
    <div className="login">
      <Logo />
      <h1>{title}</h1>
      <p>{error ?? hint}</p>
      <div className={`pindots ${shake ? 'shake' : ''}`} aria-label={`${pin.length} digits entered`}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span key={i} className={i < pin.length ? 'f' : ''} />
        ))}
      </div>
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} onClick={() => press(d)} aria-label={d}>
            {d}
          </button>
        ))}
        <button className="fn" onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete">
          Delete
        </button>
        <button onClick={() => press('0')} aria-label="0">
          0
        </button>
        <button className="fn" onClick={() => void submit()} disabled={busy} aria-label="OK" style={{ color: 'var(--accent)', fontWeight: 700 }}>
          {busy ? '…' : 'OK'}
        </button>
      </div>
    </div>
  )
}
