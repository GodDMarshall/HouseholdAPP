// Generates the PWA icons (PNG) and an SVG favicon with no image library:
// a dark rounded tile with a simple house glyph in the app's accent colour.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, '..', 'public', 'icons')
fs.mkdirSync(outDir, { recursive: true })

const BG = [15, 17, 21]
const ACCENT = [94, 234, 212]
const DOOR = [15, 17, 21]

function crc32(buf) {
  let c
  const table = crc32.table ?? (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n
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

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size)
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// House glyph in unit coordinates: roof triangle, body, door.
function inHouse(u, v) {
  const roof = v >= 0.28 && v <= 0.5 && Math.abs(u - 0.5) <= (v - 0.28) * (0.34 / 0.22)
  const body = u >= 0.26 && u <= 0.74 && v >= 0.5 && v <= 0.76
  return roof || body
}
function inDoor(u, v) {
  return u >= 0.44 && u <= 0.56 && v >= 0.58 && v <= 0.76
}

function pixel(u, v) {
  if (inDoor(u, v)) return [...DOOR, 255]
  if (inHouse(u, v)) return [...ACCENT, 255]
  return [...BG, 255]
}

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png(size, pixel))
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#0f1115"/>
  <polygon points="50,28 84,50 16,50" fill="#5eead4"/>
  <rect x="26" y="50" width="48" height="26" fill="#5eead4"/>
  <rect x="44" y="58" width="12" height="18" fill="#0f1115"/>
</svg>
`
fs.writeFileSync(path.join(outDir, 'icon.svg'), svg)
console.log('icons written to', outDir)
