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
      const snapshot = await withTimeout(adapter.snapshot(devices.context(devices.unmasked(device.id), live)), timeoutMs, 'Taking a picture')
      return { snapshot, pathId: live.id }
    } catch (err) {
      firstError = err
    }
  }
  const frame = video ? await video.snapshot(device.id) : null
  if (frame) return { snapshot: frame, pathId: live?.id ?? null }
  if (firstError) throw firstError
  return null
}
