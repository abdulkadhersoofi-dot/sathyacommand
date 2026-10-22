// Talks to the Sathya HMS server. The session token lives in sessionStorage, so closing the tab signs out.

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> = {}) { super(message) }
}

const TOKEN_KEY = 'sathya.token'
const readToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) } catch { return null } }

export interface LiveEvent { seq: number; at: string; action: string; entity: { type: string; id: string }; actor: string; amount?: number }

export class Api {
  token: string | null = readToken()
  onSignedOut: () => void = () => location.reload()

  constructor(public base: string) {}

  setToken(t: string | null) {
    this.token = t
    try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY) } catch { /* private mode: token stays in memory */ }
  }

  private headers(json: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra }
    if (json) h['content-type'] = 'application/json'
    if (this.token) h.authorization = `Bearer ${this.token}`
    return h
  }

  /** How long a request may take before the screen gives up on it (Render waking from sleep takes up to ~30 s). */
  timeoutMs = 25_000

  async req<T = unknown>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    // A request that never answers must not leave a screen waiting for ever.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await fetch(this.base + path, { method, headers: this.headers(body !== undefined, extraHeaders), body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal })
    } catch (e) {
      if (ctrl.signal.aborted) throw new ApiError(0, 'The server did not answer in time. Check the connection, wait a moment and try again.', { timeout: true })
      throw new TypeError('No connection to the HMS. Check the internet connection and try again.')
    } finally { clearTimeout(timer) }
    const text = await res.text()
    const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text
    if (!res.ok) {
      const err = new ApiError(res.status, (data as { error?: string })?.error ?? `Request failed (${res.status})`, typeof data === 'object' ? data : {})
      if (res.status === 401 && this.token && !path.startsWith('/auth/')) { this.setToken(null); this.onSignedOut() }
      throw err
    }
    return data as T
  }

  get = <T = unknown>(path: string) => this.req<T>('GET', path)
  post = <T = unknown>(path: string, body: unknown = {}) => this.req<T>('POST', path, body)

  /** Opens an authenticated document (e.g. a printable invoice) in a new tab. */
  async openDocument(path: string, method = 'GET') {
    const win = window.open('', '_blank')
    const html = await this.req<string>(method, path, method === 'POST' ? {} : undefined)
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    if (win) win.location.href = url
    else location.href = url
  }

  /** Server-sent events over fetch (so the token can go in a header), reconnecting with backoff. */
  stream(onEvent: (e: LiveEvent) => void, onState: (connected: boolean) => void = () => {}) {
    let stopped = false
    let delay = 2000
    const run = async () => {
      while (!stopped) {
        try {
          const res = await fetch(this.base + '/api/stream', { headers: this.headers(false) })
          if (!res.ok || !res.body) throw new Error(String(res.status))
          onState(true)
          delay = 2000
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let i: number
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, i)
              buf = buf.slice(i + 2)
              const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
              if (data) onEvent(JSON.parse(data))
            }
          }
        } catch { /* fall through to reconnect */ }
        onState(false)
        if (stopped) break
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 30_000)
      }
    }
    void run()
    return () => { stopped = true }
  }
}

/** The server could not be reached at all (Wi-Fi down, server restarting), as opposed to it refusing the request. */
export const isNetworkError = (e: unknown) => e instanceof TypeError || (e instanceof ApiError && (e.status === 0 || ([502, 503, 504].includes(e.status) && !e.body.error)))

/** True when an HMS server answers at `base` (the app then runs on live data instead of the sample). */
export async function serverAvailable(base: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2500)
    const res = await fetch(base + '/health', { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return false
    const j = await res.json()
    return j?.ok === true && typeof j.db === 'string'
  } catch {
    return false
  }
}
