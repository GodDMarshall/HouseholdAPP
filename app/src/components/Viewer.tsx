import { useEffect, useRef, useState } from 'react'
import type { Device, DeviceState } from '@house/shared'
import { api, getToken } from '../api.ts'

interface StreamInfo {
  available: boolean
  go2rtc: string
  canSnapshot: boolean
}

const CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus']

/**
 * The camera picture: live video through the hub when go2rtc is running,
 * otherwise a fast run of stills. Falls back by itself.
 */
export function Viewer({ device, state, stillsMs = 700 }: { device: Device; state: DeviceState | undefined; stillsMs?: number }) {
  const [info, setInfo] = useState<StreamInfo | null>(null)
  const [liveFailed, setLiveFailed] = useState<string | null>(null)
  const online = state?.online === true

  useEffect(() => {
    let cancelled = false
    setLiveFailed(null)
    api
      .get<StreamInfo>(`/api/devices/${device.id}/stream`)
      .then((i) => !cancelled && setInfo(i))
      .catch(() => !cancelled && setInfo({ available: false, go2rtc: 'error', canSnapshot: device.capabilities.includes('snapshot') }))
    return () => {
      cancelled = true
    }
  }, [device.id, state?.activePathId, online, device.capabilities])

  if (!online) {
    return (
      <div className="viewer">
        <div className="overlay">
          <div>
            <strong>{device.name} is unreachable</strong>
            <div>{state?.summary ?? 'Checking…'}</div>
          </div>
        </div>
      </div>
    )
  }
  if (!info) {
    return (
      <div className="viewer">
        <div className="overlay">
          <div className="spinner" />
        </div>
      </div>
    )
  }
  const live = info.available && !liveFailed
  return (
    <div className="viewer">
      {live ? (
        <LiveVideo deviceId={device.id} onFail={setLiveFailed} />
      ) : info.canSnapshot ? (
        <Stills deviceId={device.id} intervalMs={stillsMs} />
      ) : (
        <div className="overlay">
          <div>
            <strong>No picture</strong>
            <div>{info.go2rtc === 'missing' ? 'Live video is not installed on the hub yet.' : 'This camera has no stream on the current connection.'}</div>
          </div>
        </div>
      )}
      <span className={`chip badge ${live ? 'err' : ''}`}>{live ? 'LIVE' : info.canSnapshot ? 'STILLS' : 'OFF'}</span>
    </div>
  )
}

/** Poll stills with the auth header (never puts the token in a URL). */
export function Stills({ deviceId, intervalMs, className }: { deviceId: string; intervalMs: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stop = false
    let timer: number | undefined
    let current: string | null = null
    const tick = async () => {
      if (stop) return
      if (document.visibilityState !== 'visible') {
        timer = window.setTimeout(tick, 1000)
        return
      }
      try {
        const res = await fetch(`/api/devices/${deviceId}/snapshot`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))
        const blob = await res.blob()
        if (stop) return
        const url = URL.createObjectURL(blob)
        setSrc(url)
        setError(null)
        if (current) URL.revokeObjectURL(current)
        current = url
        timer = window.setTimeout(tick, intervalMs)
      } catch {
        if (stop) return
        setError('No picture right now')
        timer = window.setTimeout(tick, 3000)
      }
    }
    void tick()
    return () => {
      stop = true
      if (timer) window.clearTimeout(timer)
      if (current) URL.revokeObjectURL(current)
    }
  }, [deviceId, intervalMs])

  if (!src) return <div className={className ?? 'overlay'}>{error ?? <div className="spinner" />}</div>
  return <img className={className} src={src} alt="Camera picture" />
}

type MediaSourceCtor = typeof MediaSource

function LiveVideo({ deviceId, onFail }: { deviceId: string; onFail: (reason: string) => void }) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = ref.current
    if (!video) return
    const w = window as unknown as { ManagedMediaSource?: MediaSourceCtor; MediaSource?: MediaSourceCtor }
    const MS = w.ManagedMediaSource ?? w.MediaSource
    if (!MS) {
      onFail('This browser cannot play live video')
      return
    }
    let closed = false
    let gotData = false
    const ms = new MS()
    if (w.ManagedMediaSource) {
      ;(video as HTMLVideoElement & { disableRemotePlayback: boolean }).disableRemotePlayback = true
      video.srcObject = ms as unknown as MediaProvider
    } else {
      video.src = URL.createObjectURL(ms)
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/video/api/ws?src=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(getToken() ?? '')}`)
    ws.binaryType = 'arraybuffer'
    let sb: SourceBuffer | null = null
    const queue: ArrayBuffer[] = []
    let msOpen = false
    let wsOpen = false
    const codecs = CODECS.filter((c) => MS.isTypeSupported(`video/mp4; codecs="${c}"`)).join()
    const begin = () => ws.send(JSON.stringify({ type: 'mse', value: codecs }))
    ms.addEventListener(
      'sourceopen',
      () => {
        msOpen = true
        if (wsOpen) begin()
      },
      { once: true },
    )
    const flush = () => {
      if (!sb || sb.updating) return
      const next = queue.shift()
      if (next) {
        try {
          sb.appendBuffer(next)
        } catch {
          /* dropped segment */
        }
        return
      }
      if (sb.buffered.length) {
        const end = sb.buffered.end(sb.buffered.length - 1)
        const first = sb.buffered.start(0)
        if (end - first > 20) {
          try {
            sb.remove(first, end - 10)
          } catch {
            /* ignore */
          }
        }
        if (video.currentTime < end - 4) video.currentTime = end - 0.5
      }
    }
    ws.onopen = () => {
      wsOpen = true
      if (msOpen) begin()
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data) as { type: string; value: string }
        if (msg.type === 'mse') {
          try {
            sb = ms.addSourceBuffer(msg.value)
            sb.mode = 'segments'
            sb.addEventListener('updateend', flush)
          } catch {
            onFail('This phone cannot decode the camera’s video format')
          }
        } else if (msg.type === 'error') {
          onFail(msg.value)
        }
        return
      }
      gotData = true
      if (!sb) return
      if (sb.updating || queue.length) queue.push(ev.data as ArrayBuffer)
      else {
        try {
          sb.appendBuffer(ev.data as ArrayBuffer)
        } catch {
          /* dropped segment */
        }
      }
    }
    ws.onclose = () => {
      if (!closed) onFail('Live video stopped')
    }
    const watchdog = window.setTimeout(() => {
      if (!gotData && !closed) onFail('No video arrived')
    }, 9000)
    void video.play().catch(() => undefined)
    return () => {
      closed = true
      window.clearTimeout(watchdog)
      ws.close()
      try {
        video.pause()
        video.removeAttribute('src')
        video.srcObject = null
        video.load()
      } catch {
        /* ignore */
      }
    }
  }, [deviceId, onFail])

  return <video ref={ref} autoPlay muted playsInline />
}
