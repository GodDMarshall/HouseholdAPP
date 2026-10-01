import { create } from 'zustand'
import type { Action, Device, DeviceState, EventRecord, FamilyDescriptor, HubStatus, ServerMessage, WifiNetwork } from '@house/shared'

export type AuthPhase = 'unknown' | 'setup' | 'login' | 'ready'

export interface Toast {
  id: number
  text: string
  level: 'info' | 'ok' | 'warn' | 'error'
  actionId?: string
  deviceId?: string
}

interface State {
  auth: AuthPhase
  connected: boolean
  status: HubStatus | null
  devices: Device[]
  states: Record<string, DeviceState>
  wifi: WifiNetwork[]
  actions: Record<string, Action>
  events: EventRecord[]
  families: FamilyDescriptor[]
  toasts: Toast[]
  setAuth(phase: AuthPhase): void
  setConnected(v: boolean): void
  setFamilies(f: FamilyDescriptor[]): void
  setEvents(e: EventRecord[]): void
  apply(msg: ServerMessage): void
  toast(text: string, level?: Toast['level'], extra?: Partial<Toast>): void
  dismissToast(id: number): void
}

let toastSeq = 1
const EVENTS_KEPT = 300
const ACTIONS_KEPT = 200

export const useStore = create<State>((set, get) => ({
  auth: 'unknown',
  connected: false,
  status: null,
  devices: [],
  states: {},
  wifi: [],
  actions: {},
  events: [],
  families: [],
  toasts: [],

  setAuth: (auth) => set({ auth }),
  setConnected: (connected) => set({ connected }),
  setFamilies: (families) => set({ families }),
  setEvents: (events) => set({ events: events.slice(0, EVENTS_KEPT) }),

  apply: (msg) => {
    switch (msg.type) {
      case 'hello': {
        const states: Record<string, DeviceState> = {}
        for (const s of msg.states) states[s.deviceId] = s
        const actions: Record<string, Action> = {}
        for (const a of msg.actions) actions[a.id] = a
        set({ status: msg.status, devices: msg.devices, states, wifi: msg.wifi, actions, connected: true })
        break
      }
      case 'device.upsert': {
        const devices = get().devices.filter((d) => d.id !== msg.device.id)
        devices.push(msg.device)
        devices.sort((a, b) => a.sort - b.sort || a.createdAt.localeCompare(b.createdAt))
        set({ devices })
        break
      }
      case 'device.remove': {
        const states = { ...get().states }
        delete states[msg.deviceId]
        set({ devices: get().devices.filter((d) => d.id !== msg.deviceId), states })
        break
      }
      case 'device.state':
        set({ states: { ...get().states, [msg.state.deviceId]: msg.state } })
        break
      case 'action': {
        const prev = get().actions[msg.action.id]
        const actions = { ...get().actions, [msg.action.id]: msg.action }
        const ids = Object.keys(actions)
        if (ids.length > ACTIONS_KEPT) {
          const sorted = Object.values(actions).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
          const keep: Record<string, Action> = {}
          for (const a of sorted.slice(0, ACTIONS_KEPT)) keep[a.id] = a
          set({ actions: keep })
        } else set({ actions })
        announce(get, msg.action, prev)
        break
      }
      case 'event':
        set({ events: [msg.event, ...get().events].slice(0, EVENTS_KEPT) })
        break
      case 'wifi.networks':
        set({ wifi: msg.networks })
        break
      case 'hub.status':
        set({ status: msg.status })
        break
    }
  },

  toast: (text, level = 'info', extra = {}) => {
    const id = toastSeq++
    set({ toasts: [...get().toasts, { id, text, level, ...extra }] })
    const ttl = level === 'error' || level === 'warn' ? 7000 : 3500
    setTimeout(() => get().dismissToast(id), ttl)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

/** Turn action transitions into toasts, so a tap always gets an answer. */
function announce(get: () => State, action: Action, prev: Action | undefined): void {
  if (prev && prev.status === action.status) return
  const device = get().devices.find((d) => d.id === action.deviceId)
  const name = device?.name ?? 'Device'
  const quiet = action.type === 'ptz.move' || action.type === 'ptz.stop' || action.type === 'probe'
  if (action.status === 'done') {
    if (quiet) return
    get().toast(`${name}: ${action.label} — ${resultText(action)}`, 'ok', { actionId: action.id, deviceId: action.deviceId })
  } else if (action.status === 'failed') {
    get().toast(`${name}: ${action.label} failed — ${action.error ?? 'no reason given'}`, 'error', { actionId: action.id, deviceId: action.deviceId })
  } else if (action.status === 'needs-confirmation') {
    get().toast(`${name}: ${action.label} needs you`, 'warn', { actionId: action.id, deviceId: action.deviceId })
  }
}

export function resultText(a: Action): string {
  const r = a.result ?? {}
  if (typeof r.gate === 'string') {
    return r.gate === 'open' ? 'gate is open' : r.gate === 'closed' ? 'gate is closed' : r.gate === 'stopped' ? 'gate stopped' : 'gate moved'
  }
  if (a.type === 'dim.set' && typeof r.brightness === 'number') return `${r.brightness}%`
  if (typeof r.power === 'boolean') return r.power ? 'now on' : 'now off'
  if (a.type === 'wifi.set' && typeof r.ssid === 'string') return r.onTarget === false ? `told to join ${r.ssid}` : `now on ${r.ssid}`
  if (a.type === 'reboot') return 'restarting'
  if (a.type === 'path.switch' && a.params.pathId) return 'in use now'
  if (typeof r.summary === 'string') return r.summary
  if (a.type === 'snapshot') return 'picture saved'
  return 'done'
}

export function deviceById(id: string): Device | undefined {
  return useStore.getState().devices.find((d) => d.id === id)
}
