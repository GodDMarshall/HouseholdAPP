type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let threshold: Level = 'info'

export function setLogLevel(level: Level): void {
  threshold = level
}

export interface Logger {
  debug(msg: string, data?: unknown): void
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
  error(msg: string, data?: unknown): void
  child(scope: string): Logger
}

function fmt(data: unknown): string {
  if (data === undefined) return ''
  if (data instanceof Error) return ' ' + (data.stack ?? data.message)
  try {
    return ' ' + JSON.stringify(data)
  } catch {
    return ' ' + String(data)
  }
}

export function logger(scope: string): Logger {
  const write = (level: Level, msg: string, data?: unknown) => {
    if (ORDER[level] < ORDER[threshold]) return
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${fmt(data)}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (s) => logger(`${scope}:${s}`),
  }
}
