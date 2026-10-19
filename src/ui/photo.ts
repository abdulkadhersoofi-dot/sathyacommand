import type { Api } from '../live/api'

// Photos from the phone camera, shrunk before upload (about 1280 px, JPEG), and shown again through
// the authenticated API (an <img> tag cannot send the sign-in token itself).

/** Opens the camera (or file picker) and resolves with a resized JPEG data URL, or null if cancelled. */
export function takePhoto(maxSide = 1280): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.setAttribute('capture', 'environment')
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) { resolve(null); return }
      const img = new Image()
      img.onload = () => {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height))
        const c = document.createElement('canvas')
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
        URL.revokeObjectURL(img.src)
        resolve(c.toDataURL('image/jpeg', 0.72))
      }
      img.onerror = () => resolve(null)
      img.src = URL.createObjectURL(file)
    })
    input.click()
  })
}

export async function uploadPhoto(api: Api, kind: string, dataUrl: string) {
  return (await api.post<{ id: string }>('/api/uploads', { kind, dataUrl })).id
}

const cache = new Map<string, string>()

/** Fills every <img data-upload="id"> inside root with the photo, fetched with the sign-in token. */
export function hydratePhotos(api: Api, root: HTMLElement) {
  root.querySelectorAll<HTMLImageElement>('img[data-upload]').forEach(async (img) => {
    const id = img.dataset.upload!
    if (!cache.has(id)) {
      try {
        const res = await fetch(api.base + `/api/uploads/${id}`, { headers: api.token ? { authorization: `Bearer ${api.token}` } : {} })
        if (!res.ok) return
        cache.set(id, URL.createObjectURL(await res.blob()))
      } catch { return }
    }
    img.src = cache.get(id)!
  })
}
