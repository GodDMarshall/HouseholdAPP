// Draws the Android launcher icons and splash pictures for the shell with no
// image library: the same dark tile and house glyph as the phone app's icons.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const res = path.resolve(here, '..', 'android', 'app', 'src', 'main', 'res')

const BG = [15, 17, 21]
const ACCENT = [94, 234, 212]

function crc32(buf) {
  const table = crc32.table ?? (crc32.table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  }))
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y)
      const o = y * (w * 4 + 1) + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// The house glyph in unit coordinates (0..1 across the glyph's own square).
function inHouse(u, v) {
  const roof = v >= 0.28 && v <= 0.5 && Math.abs(u - 0.5) <= (v - 0.28) * (0.34 / 0.22)
  const body = u >= 0.26 && u <= 0.74 && v >= 0.5 && v <= 0.76
  return roof || body
}
function inDoor(u, v) {
  return u >= 0.44 && u <= 0.56 && v >= 0.58 && v <= 0.76
}
/** A w x h picture: dark background, the glyph in a centred square of side `glyph` px. */
function picture(w, h, glyph, { round = false, transparentOutside = false } = {}) {
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2
  return png(w, h, (x, y) => {
    if (round && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) return [0, 0, 0, 0]
    const u = (x + 0.5 - (cx - glyph / 2)) / glyph
    const v = (y + 0.5 - (cy - glyph / 2)) / glyph
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
      if (inDoor(u, v)) return [...BG, 255]
      if (inHouse(u, v)) return [...ACCENT, 255]
    }
    return transparentOutside ? [0, 0, 0, 0] : [...BG, 255]
  })
}

const write = (rel, buf) => {
  const p = path.join(res, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, buf)
  console.log('wrote', path.relative(res, p), buf.length, 'bytes')
}

// Launcher icons: legacy square + round, and the adaptive foreground (108dp, glyph inside the 66% safe zone).
const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
for (const [name, scale] of Object.entries(DENSITY)) {
  const icon = Math.round(48 * scale)
  write(`mipmap-${name}/ic_launcher.png`, picture(icon, icon, icon))
  write(`mipmap-${name}/ic_launcher_round.png`, picture(icon, icon, icon, { round: true }))
  const fg = Math.round(108 * scale)
  write(`mipmap-${name}/ic_launcher_foreground.png`, picture(fg, fg, Math.round(fg * 0.66), { transparentOutside: true }))
}
write('values/ic_launcher_background.xml', Buffer.from('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0F1115</color>\n</resources>\n'))

// Splash pictures: the glyph small in the middle of a dark screen, one per size the template ships.
const SPLASH = { 'drawable': [480, 320], 'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720], 'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280], 'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800], 'drawable-port-xhdpi': [720, 1280], 'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920] }
for (const [dir, [w, h]] of Object.entries(SPLASH)) write(`${dir}/splash.png`, picture(w, h, Math.round(Math.min(w, h) * 0.3)))
