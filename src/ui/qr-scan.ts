// Scans a QR code (or a barcode, when asked) with the phone camera where the browser supports it
// (BarcodeDetector), otherwise the code printed under it can be typed in.

interface Detector { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }

export async function scanQr(host: HTMLElement, formats = ['qr_code']): Promise<string | null> {
  const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector
  if (!BD || !navigator.mediaDevices?.getUserMedia) return null
  const video = document.createElement('video')
  video.setAttribute('playsinline', '')
  video.className = 'qr-video'
  host.prepend(video)
  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    video.srcObject = stream
    await video.play()
    const detector = new BD({ formats })
    const until = Date.now() + 30_000
    while (Date.now() < until && video.isConnected) {
      const codes = await detector.detect(video).catch(() => [])
      if (codes[0]?.rawValue) return codes[0].rawValue
      await new Promise((r) => setTimeout(r, 250))
    }
    return null
  } catch { return null } finally {
    stream?.getTracks().forEach((t) => t.stop())
    video.remove()
  }
}
