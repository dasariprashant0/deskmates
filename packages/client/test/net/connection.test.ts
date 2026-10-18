import { emptyState, type NormalizedEvent } from '@deskmates/core'
import { beforeEach, describe, expect, test } from 'vitest'
import { createConnection, type Status, type WebSocketLike } from '../../src/net'

// compile-time: the real DOM WebSocket class fits the injectable shape
type RealFits = typeof WebSocket extends new (url: string, protocols?: string | string[]) => WebSocketLike ? true : never
export const realFits: RealFits = true

const TOKEN = 'T'.repeat(40)
class FakeWS implements WebSocketLike {
  static all: FakeWS[] = []
  sent: string[] = []
  closed = 0
  onmessage: WebSocketLike['onmessage'] = null
  onclose: WebSocketLike['onclose'] = null
  onerror: WebSocketLike['onerror'] = null
  constructor(public url: string, public protocols?: string | string[]) { FakeWS.all.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.closed++ }
  emit(o: unknown) { this.onmessage?.({ data: typeof o === 'string' ? o : JSON.stringify(o) }) }
  drop(code = 1006) { this.onclose?.({ code }) }
}
const last = () => FakeWS.all[FakeWS.all.length - 1] as FakeWS

let t = 0
let timers: { id: number; at: number; fn: () => void }[] = []
let nid = 0
const advance = (ms: number) => {
  const end = t + ms
  for (;;) {
    const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
    if (!due) break
    timers = timers.filter((x) => x !== due)
    t = Math.max(t, due.at)
    due.fn()
  }
  t = end
}

const snap = (seq = 0) => ({ type: 'snapshot', v: 1, seq, state: { ...emptyState(), seq }, prices: {}, pricesAreExample: true })
const ev = (seq: number): NormalizedEvent => ({ seq, ts: seq, agent: { provider: 'p', sessionId: 's' }, kind: 'message', role: 'user', chars: 1 })
const batch = (a: number, b = a) => ({ type: 'events', fromSeq: a, toSeq: b, events: Array.from({ length: b - a + 1 }, (_, i) => ev(a + i)) })

let statuses: Status[]
let changes: number
const make = (random = () => 0.5) => {
  const c = createConnection({
    url: 'ws://127.0.0.1:1/ws', token: TOKEN, WebSocketImpl: FakeWS,
    setTimeout: (fn, ms) => { const id = ++nid; timers.push({ id, at: t + ms, fn }); return id },
    clearTimeout: (h) => { timers = timers.filter((x) => x.id !== h) },
    now: () => t, onStatus: (s) => statuses.push(s), onChange: () => { changes++ }, random,
  })
  return c
}
beforeEach(() => { FakeWS.all = []; t = 0; timers = []; statuses = []; changes = 0 })

describe('connection', () => {
  test('offers exactly [deskmates.v1, token]; token never in URL', () => {
    make().start()
    expect(last().protocols).toEqual(['deskmates.v1', TOKEN])
    expect(last().url).not.toContain(TOKEN)
  })

  test('status transitions and snapshot/events flow', () => {
    const c = make()
    c.start()
    expect(statuses).toEqual(['connecting'])
    last().emit(snap(0))
    expect(statuses).toEqual(['connecting', 'live'])
    last().emit(batch(1, 2))
    expect(c.mirror.seq()).toBe(2)
    expect(changes).toBe(2)
    last().drop()
    expect(statuses.at(-1)).toBe('reconnecting')
  })

  test('gap sends a single resync, rate limited to 1 per second', () => {
    const c = make()
    c.start()
    const s = last()
    s.emit(snap(0))
    s.emit(batch(5)) // gap -> immediate resync
    expect(s.sent).toHaveLength(1)
    expect(JSON.parse(s.sent[0] ?? '')).toEqual({ type: 'resync' })
    advance(100)
    s.emit(batch(6))
    s.emit(batch(7))
    expect(s.sent).toHaveLength(1)
    advance(899)
    expect(s.sent).toHaveLength(1)
    advance(1)
    expect(s.sent).toHaveLength(2) // exactly one queued resync
    advance(5000)
    expect(s.sent).toHaveLength(2)
    c.resync()
    expect(s.sent).toHaveLength(3)
  })

  test('snapshot cancels a pending resync', () => {
    const c = make()
    c.start()
    last().emit(snap(0))
    last().emit(batch(5))
    last().emit(batch(6))
    last().emit(snap(10))
    advance(2000)
    expect(last().sent).toHaveLength(1)
  })

  test('backoff 1,2,4,8,16,30,30 with jitter bounds, reset after snapshot', () => {
    const c = make(() => 0.5) // no jitter
    c.start()
    for (const want of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const n = FakeWS.all.length
      last().drop()
      advance(want - 1)
      expect(FakeWS.all.length).toBe(n)
      advance(1)
      expect(FakeWS.all.length).toBe(n + 1)
    }
    last().emit(snap(0))
    const n = FakeWS.all.length
    last().drop()
    advance(999)
    expect(FakeWS.all.length).toBe(n)
    advance(1)
    expect(FakeWS.all.length).toBe(n + 1)
  })

  test('jitter is +-20%', () => {
    for (const [r, want] of [[0, 800], [1, 1200]] as const) {
      FakeWS.all = []; timers = []; t = 0
      make(() => r).start()
      last().drop()
      advance(want - 1)
      expect(FakeWS.all).toHaveLength(1)
      advance(1)
      expect(FakeWS.all).toHaveLength(2)
    }
  })

  test.each([1008, 1009])('close %i goes offline for 60 s then retries', (code) => {
    const c = make()
    c.start()
    last().drop(code)
    expect(statuses.at(-1)).toBe('offline')
    advance(59_999)
    expect(FakeWS.all).toHaveLength(1)
    advance(1)
    expect(FakeWS.all).toHaveLength(2)
    c.stop()
  })

  test('error triggers reconnect once even if close follows', () => {
    make().start()
    const s = last()
    s.onerror?.({})
    s.drop()
    advance(1000)
    expect(FakeWS.all).toHaveLength(2)
    advance(10_000)
    expect(FakeWS.all).toHaveLength(2)
  })

  test('stop cancels timers, closes, and prevents reconnect; late messages ignored', () => {
    const c = make()
    c.start()
    const s = last()
    s.emit(snap(0))
    s.emit(batch(5))
    s.emit(batch(6)) // pending resync timer
    c.stop()
    expect(s.closed).toBe(1)
    expect(timers).toHaveLength(0)
    const n = changes
    s.emit(snap(3))
    s.emit(batch(1))
    s.drop()
    advance(100_000)
    expect(changes).toBe(n)
    expect(c.mirror.seq()).toBe(0)
    expect(FakeWS.all).toHaveLength(1)
  })

  test('stop while a reconnect is scheduled prevents it', () => {
    const c = make()
    c.start()
    last().drop()
    c.stop()
    advance(100_000)
    expect(FakeWS.all).toHaveLength(1)
  })

  test('invalid frames are counted and ignored; 50 in a row reconnect', () => {
    const c = make()
    c.start()
    const s = last()
    s.emit(snap(0))
    for (let i = 0; i < 49; i++) s.emit('garbage')
    expect(c.mirror.stats().invalid).toBe(49)
    s.emit(batch(1)) // valid frame resets the run
    for (let i = 0; i < 49; i++) s.emit('garbage')
    expect(s.closed).toBe(0)
    s.emit('garbage')
    expect(s.closed).toBe(1)
    expect(statuses.at(-1)).toBe('reconnecting')
    advance(1000)
    expect(FakeWS.all).toHaveLength(2)
  })

  test('onChange at most once per frame', () => {
    const c = make()
    c.start()
    last().emit(snap(0))
    changes = 0
    last().emit(batch(1, 100))
    expect(changes).toBe(1)
    last().emit(batch(1, 100)) // stale
    last().emit(batch(300)) // gap
    last().emit('junk')
    expect(changes).toBe(1)
  })
})
