// Takes a consistent copy of the hub's data while the hub may be running.
//   node scripts/backup.mjs <dataDir> <outDir>
// The database is copied with SQLite's own snapshot (VACUUM INTO), which is safe
// against a live writer; the keys are plain file copies.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
const [dataDir, outDir] = process.argv.slice(2)
if (!dataDir || !outDir) {
  console.error('usage: node scripts/backup.mjs <dataDir> <outDir>')
  process.exit(2)
}
const dbFile = path.join(dataDir, 'house.db')
if (!fs.existsSync(dbFile)) {
  console.error(`No database at ${dbFile}`)
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })
const target = path.join(outDir, 'house.db')
fs.rmSync(target, { force: true })

const db = new DatabaseSync(dbFile, { readOnly: true })
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
db.close()

for (const name of ['secret.key', 'vapid.json']) {
  const src = path.join(dataDir, name)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, name))
}

// Prove the copy opens and holds the registry before calling it a backup.
const check = new DatabaseSync(target, { readOnly: true })
const devices = check.prepare('SELECT COUNT(*) AS n FROM devices').get().n
const wifi = check.prepare('SELECT COUNT(*) AS n FROM wifi_networks').get().n
check.close()
if (!fs.existsSync(path.join(outDir, 'secret.key'))) {
  console.error('secret.key is missing: the backup could not decrypt stored passwords. Not a usable backup.')
  process.exit(1)
}
console.log(`${devices} devices, ${wifi} WiFi networks`)
