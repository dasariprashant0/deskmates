import { emptyState, reduce, type NormalizedEvent, type OfficeState } from '@deskmates/core'
import { describe, expect, test } from 'vitest'
import { createMirror, type EventsMessage, type SnapshotMessage } from '../../src/net'

const ref = { provider: 'p', sessionId: 's' }
const mk = (seq: number): NormalizedEvent =>
  seq === 1
    ? { seq, ts: seq, agent: ref, kind: 'session.start', cwd: '/x' }
    : { seq, ts: seq, agent: ref, kind: 'usage', model: 'm', input: seq, cacheWrite: 0, cacheRead: 0, output: 1 }
const batch = (from: number, to: number): EventsMessage => ({
  type: 'events', fromSeq: from, toSeq: to, events: Array.from({ length: to - from + 1 }, (_, i) => mk(from + i)),
})
const snap = (seq = 0, state: OfficeState = emptyState()): SnapshotMessage => ({ type: 'snapshot', v: 1, seq, state, prices: {}, pricesAreExample: true })

describe('mirror', () => {
  test('snapshot + contiguous batches equal a manual fold', () => {
    const m = createMirror()
    m.applySnapshot(snap())
    expect(m.applyEvents(batch(1, 3))).toBe('ok')
    expect(m.applyEvents(batch(4, 4))).toBe('ok')
    let s = emptyState()
    for (let i = 1; i <= 4; i++) s = reduce(s, mk(i))
    expect(m.state()).toEqual(s)
    expect(m.seq()).toBe(4)
  })
  test('gap detected and not applied', () => {
    const m = createMirror()
    m.applySnapshot(snap())
    expect(m.applyEvents(batch(2, 3))).toBe('gap')
    expect(m.seq()).toBe(0)
    expect(m.stats().gaps).toBe(1)
    m.applyEvents(batch(1, 2))
    expect(m.applyEvents(batch(4, 5))).toBe('gap')
    expect(m.seq()).toBe(2)
  })
  test('non contiguous inside a batch is a gap and applies nothing', () => {
    const m = createMirror()
    m.applySnapshot(snap())
    const b = batch(1, 3)
    b.events.splice(1, 1)
    expect(m.applyEvents(b)).toBe('gap')
    expect(m.seq()).toBe(0)
    expect(Object.keys(m.state().agents)).toEqual([])
    const b2 = batch(1, 3)
    expect(m.applyEvents({ ...b2, toSeq: 4 })).toBe('gap')
  })
  test('stale batches ignored', () => {
    const m = createMirror()
    m.applySnapshot(snap())
    m.applyEvents(batch(1, 3))
    const before = m.state()
    expect(m.applyEvents(batch(2, 3))).toBe('stale')
    expect(m.applyEvents(batch(1, 3))).toBe('stale')
    expect(m.state()).toBe(before)
    expect(m.stats().stale).toBe(2)
  })
  test('snapshot replaces state, resets seq, exposes prices; input not mutated', () => {
    const m = createMirror()
    m.applySnapshot(snap())
    m.applyEvents(batch(1, 3))
    let s = emptyState()
    for (let i = 1; i <= 2; i++) s = reduce(s, mk(i))
    const input = snap(2, s)
    const frozen = JSON.stringify(input)
    m.applySnapshot({ ...input, prices: { x: 1 }, pricesAreExample: false })
    expect(m.seq()).toBe(2)
    expect(m.state().agents).toEqual(s.agents)
    expect(m.prices()).toEqual({ x: 1 })
    expect(m.pricesAreExample()).toBe(false)
    m.applyEvents(batch(3, 4))
    expect(JSON.stringify(input)).toBe(frozen)
    expect(m.state().seq).toBe(4)
  })
  test('stats', () => {
    const m = createMirror()
    expect(m.stats()).toEqual({ snapshots: 0, batches: 0, gaps: 0, stale: 0, invalid: 0 })
    m.applySnapshot(snap())
    m.applyEvents(batch(1, 1))
    m.applyEvents(batch(5, 5))
    m.applyEvents(batch(1, 1))
    expect(m.stats()).toEqual({ snapshots: 1, batches: 3, gaps: 1, stale: 1, invalid: 0 })
  })
})

describe('mirror price provenance', () => {
  test('defaults to example until a snapshot says otherwise', () => {
    const m = createMirror()
    expect(m.pricesSource()).toBe('example')
    m.applySnapshot({ ...snap(1), pricesAreExample: false, pricesSource: 'default', pricesAsOf: '2026-10-18' })
    expect(m.pricesSource()).toBe('default'); expect(m.pricesAsOf()).toBe('2026-10-18'); expect(m.pricesAreExample()).toBe(false)
  })
  test('older server without pricesSource: derived from pricesAreExample', () => {
    const m = createMirror()
    m.applySnapshot({ ...snap(1), pricesAreExample: false })
    expect(m.pricesSource()).toBe('user')
    m.applySnapshot({ ...snap(2), pricesAreExample: true })
    expect(m.pricesSource()).toBe('example')
  })
})
