import crypto from 'node:crypto'

/** Short, URL-safe, prefixed ids: dev_x7Kq9..., pth_..., act_..., evt_..., wifi_... */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`
}
