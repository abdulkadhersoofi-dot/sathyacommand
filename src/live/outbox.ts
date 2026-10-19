import { ApiError, isNetworkError, type Api } from './api'

// Requests a tablet could not send because the connection dropped. Each carries an idempotency key, so
// resending is safe: the server answers a repeated request once. Kept in the browser until delivered.

export interface Queued { key: string; method: string; path: string; body: unknown; label: string; at: number }
export interface Failed extends Queued { error: string }

const KEY = 'sathya.outbox'
const load = (): { queue: Queued[]; failed: Failed[] } => { try { return JSON.parse(localStorage.getItem(KEY) ?? '') } catch { return { queue: [], failed: [] } } }
export const newKey = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 13)}`

export class Outbox {
  queue: Queued[]
  failed: Failed[]
  private listeners = new Set<() => void>()
  private flushing = false

  constructor(private api: Api) {
    const s = load()
    this.queue = s.queue ?? []
    this.failed = s.failed ?? []
    window.addEventListener('online', () => void this.flush())
    setInterval(() => { if (this.queue.length) void this.flush() }, 15_000)
  }

  onChange(fn: () => void) { this.listeners.add(fn) }
  private save() {
    try { localStorage.setItem(KEY, JSON.stringify({ queue: this.queue, failed: this.failed })) } catch { /* storage full or blocked: the queue stays in memory */ }
    this.listeners.forEach((l) => l())
  }

  /** Sends now if possible; otherwise queues it (behind anything already waiting) and returns null. */
  async send<T>(method: string, path: string, body: unknown, label: string): Promise<T | null> {
    const item: Queued = { key: newKey(), method, path, body, label, at: Date.now() }
    if (this.queue.length) { this.queue.push(item); this.save(); void this.flush(); return null }   // keep the order of actions
    try {
      return await this.api.req<T>(method, path, body, { 'idempotency-key': item.key })
    } catch (e) {
      if (!isNetworkError(e)) throw e
      this.queue.push(item); this.save()
      return null
    }
  }

  /** Delivers waiting requests in order; stops at the first one the network still refuses. */
  async flush() {
    if (this.flushing || !this.queue.length) return
    this.flushing = true
    let sent = 0
    try {
      while (this.queue.length) {
        const q = this.queue[0]
        try {
          await this.api.req(q.method, q.path, q.body, { 'idempotency-key': q.key })
          sent++
        } catch (e) {
          if (isNetworkError(e)) break
          this.failed.push({ ...q, error: e instanceof ApiError ? e.message : String(e) })
        }
        this.queue.shift()
        this.save()
      }
    } finally { this.flushing = false }
    if (sent) this.listeners.forEach((l) => l())
  }

  dismissFailed() { this.failed = []; this.save() }
}
