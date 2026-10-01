import { useEffect, useMemo, useState } from 'react'
import type { Action, ActionType, Device, DeviceState } from '@house/shared'
import { api, ApiError, getToken } from './api.ts'
import { useStore } from './store.ts'

/** Load a protected picture with the sign-in header and hand back a local object URL for <img>. */
export function useAuthBlob(url: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!url) return
    let cancelled = false
    let made: string | null = null
    fetch(url, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => {
        if (cancelled) return
        made = URL.createObjectURL(blob)
        setSrc(made)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [url])
  return src
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return `${d} d ago`
}

export function clock(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return sameDay ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`
}

/** Android wants sms:number?body=, iOS wants sms:number&body=. The hub sends the Android form. */
export function smsHref(handoff: string): string {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  return ios ? handoff.replace('?body=', '&body=') : handoff
}

/** Send a command. A toast reports failures to even start; the store reports the outcome. */
export async function act(deviceId: string, type: ActionType, params?: Record<string, unknown>): Promise<Action | null> {
  try {
    return await api.post<Action>(`/api/devices/${deviceId}/actions`, { type, params })
  } catch (err) {
    useStore.getState().toast(err instanceof ApiError ? err.message : 'Could not send the command', 'error')
    return null
  }
}

/** Resolve when an action reaches a final state (or the timeout passes). */
export function waitForAction(id: string, timeoutMs = 120_000): Promise<Action | null> {
  return new Promise((resolve) => {
    const done = (a: Action | undefined) => a && (a.status === 'done' || a.status === 'failed' || a.status === 'needs-confirmation')
    const first = useStore.getState().actions[id]
    if (done(first)) return resolve(first!)
    const t = window.setTimeout(() => {
      unsub()
      resolve(useStore.getState().actions[id] ?? null)
    }, timeoutMs)
    const unsub = useStore.subscribe((s) => {
      const a = s.actions[id]
      if (done(a)) {
        window.clearTimeout(t)
        unsub()
        resolve(a!)
      }
    })
  })
}

const QUIET: ActionType[] = ['ptz.move', 'ptz.stop', 'snapshot']

/** Is something in flight for this device (shown as a spinner on the tile)? */
export function useBusy(deviceId: string): boolean {
  return useStore((s) => Object.values(s.actions).some((a) => a.deviceId === deviceId && (a.status === 'queued' || a.status === 'running') && !QUIET.includes(a.type)))
}

export function usePending(deviceId?: string): Action[] {
  const actions = useStore((s) => s.actions)
  return useMemo(
    () =>
      Object.values(actions)
        .filter((a) => a.status === 'needs-confirmation' && (!deviceId || a.deviceId === deviceId))
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    [actions, deviceId],
  )
}

export function stateLine(device: Device, state: DeviceState | undefined): string {
  if (!state) return 'Checking…'
  if (!state.online) return state.summary
  const s = state.state
  switch (device.kind) {
    case 'light':
    case 'switch':
      if (typeof s.power === 'boolean') {
        if (s.power && typeof s.brightness === 'number') return `On · ${s.brightness}%`
        return s.power ? 'On' : 'Off'
      }
      return state.summary
    case 'gate': {
      const g = String(s.gate ?? 'unknown')
      return g === 'unknown' ? 'Ready' : g.charAt(0).toUpperCase() + g.slice(1)
    }
    default:
      return state.summary
  }
}

export function isOn(state: DeviceState | undefined): boolean {
  return state?.online === true && state.state.power === true
}

export function activePathOf(device: Device, state: DeviceState | undefined) {
  return device.paths.find((p) => p.id === state?.activePathId) ?? null
}
