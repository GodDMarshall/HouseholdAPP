import type { DeviceKind, PathKind } from '@house/shared'

const PATHS: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10M10 19.5v-5h4v5',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.5a7.5 7.5 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9a7.5 7.5 0 0 0 2.6 1.5l.5 2.5h4l.5-2.5a7.5 7.5 0 0 0 2.6-1.5l2.3.9 2-3.4-2-1.5Z',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 5l-7 7 7 7',
  camera: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h8A1.5 1.5 0 0 1 15 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 15.5v-7ZM15 10.5l5-3v9l-5-3',
  gate: 'M3 20V7M21 20V7M3 9h18M3 17h18M7.5 9v8M12 9v8M16.5 9v8',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.8 10.6c.7.6 1.1 1.3 1.3 2.4h5c.2-1.1.6-1.8 1.3-2.4A6 6 0 0 0 12 3Z',
  plug: 'M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8ZM12 17v4',
  sensor: 'M12 12h.01M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8',
  box: 'M4 8l8-4 8 4v8l-8 4-8-4V8ZM4 8l8 4 8-4M12 12v8',
  wifi: 'M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.7 16a5 5 0 0 1 6.6 0M12 19.5h.01',
  sim: 'M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM9 12h6v6H9v-6ZM12 12v6',
  cloud: 'M7 18a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 11.5 1.5A3.8 3.8 0 0 1 17.5 18H7Z',
  sms: 'M4 5.5h16v10.5H9l-5 4V5.5ZM8 10h8M8 13h5',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5',
  up: 'M5 15l7-7 7 7',
  down: 'M5 9l7 7 7-7',
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  stop: 'M7 7h10v10H7z',
  open: 'M4 20V5M20 20V5M4 7h4M16 7h4M4 17h4M16 17h4M10 12H7m0 0 2-2m-2 2 2 2M14 12h3m0 0-2-2m2 2-2 2',
  close: 'M4 20V5M20 20V5M4 7h16M4 17h16M7 12h3m0 0-2-2m2 2-2 2M17 12h-3m0 0 2-2m-2 2 2 2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 4 2.5 20h19L12 4ZM12 10v4.5M12 17.5h.01',
  power: 'M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0',
  pin: 'M9 3h6l-1 6 3 3H7l3-3-1-6ZM12 12v9',
  shot: 'M4 8h3l2-3h6l2 3h3v11H4V8ZM12 16.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2ZM10 20.5h4',
  x: 'M6 6l12 12M18 6 6 18',
  more: 'M9 6l6 6-6 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9.5h-13V11Z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
}

export type IconName = keyof typeof PATHS

export function Icon({ name, className }: { name: IconName | string; className?: string }) {
  const d = PATHS[name] ?? PATHS.box
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

export function kindIcon(kind: DeviceKind): IconName {
  switch (kind) {
    case 'camera': return 'camera'
    case 'gate': return 'gate'
    case 'light': return 'bulb'
    case 'switch': return 'plug'
    case 'sensor': return 'sensor'
    default: return 'box'
  }
}

export function pathIcon(kind: PathKind): IconName {
  switch (kind) {
    case 'lan': return 'wifi'
    case 'cellular': return 'sim'
    case 'cloud': return 'cloud'
    case 'sms': return 'sms'
  }
}
