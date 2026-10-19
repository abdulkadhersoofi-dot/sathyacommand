import type { Api } from '../live/api'

// Shares the phone's location while the person is on duty: every 30 seconds when moving, every two
// minutes when still. In the packaged phone app (Capacitor) the native background-location plugin keeps
// it going with the screen off; in a browser it runs while the app is open.

interface Fix { lat: number; lng: number; accuracy: number }
interface NativeWatcher { addWatcher(o: Record<string, unknown>, cb: (loc?: { latitude: number; longitude: number; accuracy: number }) => void): Promise<string>; removeWatcher(o: { id: string }): Promise<void> }

const native = () => (window as unknown as { Capacitor?: { Plugins?: { BackgroundGeolocation?: NativeWatcher } } }).Capacitor?.Plugins?.BackgroundGeolocation

export function currentFix(timeoutMs = 15_000): Promise<Fix | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return }
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10_000 })
  })
}

const metres = (a: Fix, b: Fix) => {
  const k = Math.PI / 180, x = (b.lng - a.lng) * k * Math.cos(((a.lat + b.lat) / 2) * k), y = (b.lat - a.lat) * k
  return Math.sqrt(x * x + y * y) * 6371000
}

export class Tracker {
  active = false
  last: { at: number; fix: Fix } | null = null
  private watchId: number | null = null
  private nativeId: string | null = null
  onChange: () => void = () => {}

  constructor(private api: Api) {}

  async start() {
    if (this.active) return
    this.active = true
    const handle = (fix: Fix) => void this.consider(fix)
    const n = native()
    if (n) {
      this.nativeId = await n.addWatcher({ backgroundMessage: 'Sathya staff app: location on while on duty', backgroundTitle: 'On duty', requestPermissions: true, distanceFilter: 10 },
        (loc) => { if (loc) handle({ lat: loc.latitude, lng: loc.longitude, accuracy: loc.accuracy }) })
    } else if (navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition((p) => handle({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), () => {},
        { enableHighAccuracy: true, maximumAge: 15_000 })
    }
    this.onChange()
  }

  stop() {
    this.active = false
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId)
    if (this.nativeId) void native()?.removeWatcher({ id: this.nativeId })
    this.watchId = null; this.nativeId = null
    this.onChange()
  }

  private async consider(fix: Fix) {
    const now = Date.now()
    if (this.last) {
      const moved = metres(this.last.fix, fix) > 10
      if (now - this.last.at < (moved ? 30_000 : 120_000)) return
    }
    this.last = { at: now, fix }
    try {
      await this.api.post('/api/staff/location', fix)
    } catch (e) {
      if ((e as { body?: { offDuty?: boolean } }).body?.offDuty) this.stop()   // clocked out elsewhere
    }
  }
}
