import { emptyState, reduce, type NormalizedEvent, type OfficeState } from '@deskmates/core'

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type NewEvent = DistOmit<NormalizedEvent, 'seq'>
type Sub = { fn: (e: NormalizedEvent) => void }

export class EventBus {
  private readonly capacity: number
  private ring: NormalizedEvent[] = []
  private st: OfficeState = emptyState()
  private n = 0
  private subs: Sub[] = []
  private subscriberErrors = 0
  private queue: NormalizedEvent[] = []
  private delivering = false

  constructor(opts: { capacity?: number } = {}) { this.capacity = Math.max(1, opts.capacity ?? 5000) }

  publish(e: NewEvent): NormalizedEvent {
    // Cast: TS cannot prove spreading a distributive union plus seq is a NormalizedEvent.
    const ev = { ...e, seq: this.n + 1 } as NormalizedEvent
    const next = reduce(this.st, ev) // may throw: nothing is committed yet
    this.n = ev.seq
    this.st = next
    this.ring.push(ev)
    // ponytail: shift is O(capacity); use a circular buffer if capacity grows large
    if (this.ring.length > this.capacity) this.ring.shift()
    this.queue.push(ev)
    if (!this.delivering) {
      this.delivering = true
      try {
        for (let q = this.queue.shift(); q; q = this.queue.shift()) this.deliver(q)
      } finally { this.delivering = false }
    }
    return ev
  }

  private deliver(ev: NormalizedEvent): void {
    for (const s of [...this.subs]) {
      try { s.fn(ev) } catch { this.subscriberErrors++ }
    }
  }

  since(seq: number): NormalizedEvent[] | 'gap' {
    if (!Number.isInteger(seq) || seq < 0 || seq > this.n) return 'gap'
    if (seq === this.n) return []
    const oldest = this.n - this.ring.length + 1
    if (seq + 1 < oldest) return 'gap'
    return this.ring.slice(seq + 1 - oldest)
  }

  state(): OfficeState { return this.st }
  seq(): number { return this.n }
  stats() { return { seq: this.n, subscribers: this.subs.length, subscriberErrors: this.subscriberErrors } }

  subscribe(fn: (e: NormalizedEvent) => void): () => void {
    const s: Sub = { fn }
    this.subs.push(s)
    return () => { this.subs = this.subs.filter((x) => x !== s) }
  }
}
