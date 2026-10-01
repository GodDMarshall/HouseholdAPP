import { config, VERSION } from './config.ts'
import { createHub, localAddresses } from './hub.ts'
import { logger, setLogLevel } from './lib/log.ts'

setLogLevel(config.logLevel)
const log = logger('hub')

async function main(): Promise<void> {
  log.info(`House Control hub v${VERSION} starting`, { dataDir: config.dataDir, port: config.port })
  const hub = await createHub(config, log)
  const port = await hub.start()

  const addresses = localAddresses()
  log.info(`Open the app at http://localhost:${port}${addresses.length ? '  (on the phone: ' + addresses.map((a) => `http://${a}:${port}`).join(' or ') + ')' : ''}`)
  if (!hub.auth.isConfigured()) log.info('No PIN set yet — the first phone to open the app will set one')

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    log.info(`${signal} received, shutting down`)
    await hub.stop().catch((err) => log.error('Error while stopping', err))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${config.port} is already in use. Another copy of the hub may be running, or set HC_PORT to another port.`)
  } else {
    log.error('Hub failed to start', err)
  }
  process.exit(1)
})
