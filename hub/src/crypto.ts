import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PREFIX = 'enc:v1:'

/**
 * Encrypts secrets at rest with AES-256-GCM. The key lives in data/secret.key
 * next to the database; whoever has the data folder has the secrets, which is
 * the right trust boundary for a home hub. Back both up together.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static fromKey(key: Buffer): SecretBox {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes')
    return new SecretBox(key)
  }

  static load(dataDir: string): SecretBox {
    fs.mkdirSync(dataDir, { recursive: true })
    const file = path.join(dataDir, 'secret.key')
    if (fs.existsSync(file)) {
      const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')
      return SecretBox.fromKey(key)
    }
    const key = crypto.randomBytes(32)
    fs.writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600 })
    return new SecretBox(key)
  }

  static ephemeral(): SecretBox {
    return new SecretBox(crypto.randomBytes(32))
  }

  isEncrypted(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(PREFIX)
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return PREFIX + [iv, tag, ct].map((b) => b.toString('base64')).join(':')
  }

  decrypt(value: string): string {
    if (!this.isEncrypted(value)) return value
    const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(':')
    if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted value')
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
  }
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

/** scrypt hash for the app PIN. Format: scrypt:<salt>:<hash>. */
export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 })
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split(':')
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = crypto.scryptSync(pin, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 })
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}
