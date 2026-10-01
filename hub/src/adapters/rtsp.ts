/**
 * Camera by stream address — for any camera that gives an RTSP (or other
 * go2rtc-readable) video address but speaks none of the richer protocols.
 * Live view and stills only; no PTZ, no WiFi change.
 */
import type { Capability, FamilyDescriptor } from '@house/shared'
import { request } from '../lib/http.ts'
import { requireHost, tcpProbe, unsupported, type Adapter, type AdapterContext, type Snapshot } from './types.ts'

const DEFAULT_STREAM = 'rtsp://{user}:{pass}@{host}:{port}/stream1'

function fill(template: string, ctx: AdapterContext, encode: boolean): string {
  const enc = (s: string) => (encode ? encodeURIComponent(s) : s)
  const host = requireHost(ctx)
  const port = String(ctx.path.port ?? 554)
  const user = ctx.str('username')
  const pass = ctx.secret('password') ?? ''
  let out = template.split('{host}').join(host).split('{port}').join(port)
  if (!user) out = out.replace('{user}:{pass}@', '').replace('{user}@', '')
  return out.split('{user}').join(enc(user)).split('{pass}').join(enc(pass))
}

const adapter: Adapter = {
  family: 'rtsp',

  describe(): FamilyDescriptor {
    return {
      id: 'rtsp',
      label: 'Camera by stream address',
      tagline: 'Any camera with an RTSP video address. Live view and pictures only.',
      kinds: ['camera'],
      fields: [
        {
          name: 'streamUrl',
          label: 'Video address',
          type: 'text',
          required: true,
          default: DEFAULT_STREAM,
          help: 'Keep {host} and {port} so each connection uses its own address; {user} and {pass} are filled from below. Other schemes go2rtc reads also work, e.g. dvrip://{user}:{pass}@{host}:34567?channel=0 for XMEye / ICSee cameras.',
        },
        { name: 'username', label: 'Username', type: 'text', help: 'Leave empty if the camera has no login.' },
        { name: 'password', label: 'Password', type: 'password', secret: true },
        {
          name: 'snapshotUrl',
          label: 'Still picture address',
          type: 'text',
          help: 'Optional. An http address that returns a JPEG, e.g. http://{host}/snapshot.jpg. Without it, pictures are cut from the live video (needs ffmpeg on the hub).',
        },
      ],
      pathKinds: ['lan', 'cellular'],
      defaultPort: 554,
      capabilities: ['stream', 'snapshot'],
      notes: [
        'Find the video address in the camera’s manual or its app under RTSP. Many cameras need RTSP switched on first.',
        'This kind of camera cannot be moved between WiFi networks from here; use its own app for that.',
      ],
    }
  },

  capabilities(): Capability[] {
    return ['stream', 'snapshot']
  },

  async probe(ctx) {
    return tcpProbe(requireHost(ctx), ctx.path.port ?? 554, ctx.timeoutMs)
  },

  async execute(_ctx, action) {
    return unsupported(action)
  },

  streamSources(ctx) {
    const template = ctx.str('streamUrl', DEFAULT_STREAM).trim() || DEFAULT_STREAM
    return [fill(template, ctx, true)]
  },

  async snapshot(ctx): Promise<Snapshot> {
    const template = ctx.str('snapshotUrl').trim()
    if (!template) throw new Error('No still picture address set for this camera')
    const url = fill(template.replace('{user}:{pass}@', ''), ctx, true)
    const user = ctx.str('username')
    const res = await request(url, {
      timeoutMs: ctx.timeoutMs,
      // Older cameras only do Basic; allow that on the house network, never over the public SIM path.
      digest: user ? { username: user, password: ctx.secret('password') ?? '', allowBasic: ctx.path.kind !== 'cellular' } : undefined,
      insecure: true,
    })
    if (res.status === 401) throw new Error('The camera refused the username or password')
    if (res.status !== 200) throw new Error(`The camera answered HTTP ${res.status} for the picture`)
    return { contentType: res.headers['content-type'] ?? 'image/jpeg', body: res.body }
  },
}

export default adapter
