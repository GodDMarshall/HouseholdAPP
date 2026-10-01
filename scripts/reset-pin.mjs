// Forgot the house PIN? Stop the hub, run `npm run reset-pin`, start the hub.
// The next phone to open the app chooses a new PIN. Devices and WiFi are kept;
// every phone has to sign in again.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.HC_DATA_DIR ?? path.join(root, 'data')
const file = path.join(dataDir, 'house.db')

if (!fs.existsSync(file)) {
  console.error(`No hub data found at ${file}. Nothing to reset.`)
  process.exit(1)
}
const db = new DatabaseSync(file)
const had = db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'pin_hash'").get().n
const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
db.exec("DELETE FROM settings WHERE key = 'pin_hash'; DELETE FROM sessions;")
const devices = db.prepare('SELECT COUNT(*) AS n FROM devices').get().n
db.close()
console.log(had ? 'PIN cleared.' : 'There was no PIN set.')
console.log(`${sessions} signed-in phone(s) signed out. ${devices} device(s) kept.`)
console.log('Start the hub; the next phone to open the app chooses the new PIN.')
