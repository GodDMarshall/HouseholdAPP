import type { Device } from '@house/shared'
import type { Snapshot } from './adapters/types.ts'
import type { DeviceManager } from './devices.ts'
import { withTimeout } from './lib/http.ts'

export interface SnapshotSource {
  snapshot(deviceId: string): Promise<Snapshot | null>
}

/**
 * One still from a camera: the camera's own picture when it offers one, else a
 * frame cut from the live video. Returns the path it used.
 */
export async function grabSnapshot(
  devices: DeviceManager,
  video: SnapshotSource | null,
  device: Device,
  timeoutMs: number,
): Promise<{ snapshot: Snapshot; pathId: string | null } | null> {
  const adapter = devices.adapterFor(device)
  const live = devices.activePath(device.id)
  let firstError: unknown = null
  if (adapter.snapshot && live && live.kind !== 'sms') {
    try {
      const raw = await withTimeout(adapter.snapshot(devices.context(devices.unmasked(device.id), live)), timeoutMs, 'Taking a picture')
      return { snapshot: trusted(raw, device), pathId: live.id }
    } catch (err) {
      firstError = err
    }
  }
  const frame = video ? await video.snapshot(device.id) : null
  if (frame) return { snapshot: trusted(frame, device), pathId: live?.id ?? null }
  if (firstError) throw firstError
  return null
}

/**
 * A device says what it is sending; the hub believes the bytes instead. Only a
 * real JPEG or PNG is kept (the illustrative camera draws an SVG, and only it
 * may). Anything else from a device is not a picture and is never stored or
 * served.
 */
function trusted(snap: Snapshot, device: Device): Snapshot {
  const b = snap.body
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { contentType: 'image/jpeg', body: b }
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { contentType: 'image/png', body: b }
  if (device.family === 'virtual' && snap.contentType.includes('svg')) return { contentType: 'image/svg+xml', body: b }
  throw new Error('The camera did not send a picture')
}
