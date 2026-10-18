import { emptyState } from '@deskmates/core'
import { describe, expect, test } from 'vitest'
import { encodeResync, parseServerMessage } from '../../src/net'

const snap = { type: 'snapshot', v: 1, seq: 5, state: { ...emptyState(), seq: 5 }, prices: { a: 1 }, pricesAreExample: true }
const ev = { seq: 6, ts: 1, agent: { provider: 'p', sessionId: 's' }, kind: 'activity', state: 'thinking' }
const evs = { type: 'events', fromSeq: 6, toSeq: 6, events: [ev] }

describe('parseServerMessage', () => {
  test('valid snapshot (object and string)', () => {
    for (const raw of [snap, JSON.stringify(snap)]) {
      const m = parseServerMessage(raw)
      expect(m.type).toBe('snapshot')
      if (m.type === 'snapshot') {
        expect(m.seq).toBe(5)
        expect(m.pricesAreExample).toBe(true)
      }
    }
  })
  test('valid events', () => {
    const m = parseServerMessage(JSON.stringify(evs))
    expect(m.type).toBe('events')
    if (m.type === 'events') expect(m.events).toHaveLength(1)
  })
  test.each([
    ['wrong v', { ...snap, v: 2 }],
    ['no seq', { ...snap, seq: undefined }],
    ['string seq', { ...snap, seq: '5' }],
    ['NaN seq', { ...snap, seq: Number.NaN }],
    ['no state', { ...snap, state: undefined }],
    ['agents array', { ...snap, state: { agents: [] } }],
    ['agents missing', { ...snap, state: {} }],
    ['events not array', { ...evs, events: {} }],
    ['event not object', { ...evs, events: [1] }],
    ['event no seq', { ...evs, events: [{ kind: 'x' }] }],
    ['event no kind', { ...evs, events: [{ seq: 1 }] }],
    ['event null', { ...evs, events: [null] }],
    ['fromSeq missing', { ...evs, fromSeq: undefined }],
    ['unknown type', { type: 'wat' }],
    ['null', null],
    ['number', 42],
    ['array', [snap]],
    ['bad json', '{nope'],
    ['empty string', ''],
    ['json null string', 'null'],
  ])('invalid: %s', (_n, raw) => {
    expect(parseServerMessage(raw)).toEqual({ type: 'invalid' })
  })
  test('oversized frame ignored', () => {
    const big = JSON.stringify({ ...evs, pad: 'x'.repeat(1_048_576) })
    expect(big.length).toBeGreaterThan(1_048_576)
    expect(parseServerMessage(big)).toEqual({ type: 'invalid' })
  })
  test('never throws on hostile input', () => {
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    expect(parseServerMessage(cyc)).toEqual({ type: 'invalid' })
    expect(parseServerMessage(undefined)).toEqual({ type: 'invalid' })
  })
  test('__proto__ keys do not pollute', () => {
    const raw = '{"type":"snapshot","v":1,"seq":0,"state":{"agents":{"__proto__":{"polluted":1}},"order":[],"seq":0,"__proto__":{"polluted2":1}},"prices":{},"pricesAreExample":false}'
    const m = parseServerMessage(raw)
    expect(m.type).toBe('snapshot')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined()
    if (m.type === 'snapshot') expect(Object.keys(m.state.agents)).toEqual([])
    const e = '{"type":"events","fromSeq":1,"toSeq":1,"events":[{"seq":1,"kind":"message","__proto__":{"polluted3":1}}]}'
    const m2 = parseServerMessage(e)
    expect(m2.type).toBe('events')
    expect(({} as Record<string, unknown>).polluted3).toBeUndefined()
    if (m2.type === 'events') expect(Object.keys(m2.events[0] ?? {})).not.toContain('__proto__')
  })
})

test('encodeResync', () => {
  expect(JSON.parse(encodeResync())).toEqual({ type: 'resync' })
})

describe('snapshot price provenance', () => {
  const parse = (extra: object) => parseServerMessage({ ...snap, ...extra })
  test('parses pricesSource and pricesAsOf', () => {
    const m = parse({ pricesSource: 'default', pricesAsOf: '2026-10-18' })
    expect(m).toMatchObject({ type: 'snapshot', pricesSource: 'default', pricesAsOf: '2026-10-18' })
  })
  test('tolerates missing and malformed fields', () => {
    for (const extra of [{}, { pricesSource: 'weird', pricesAsOf: 5 }, { pricesSource: {}, pricesAsOf: 'x'.repeat(100) }]) {
      const m = parse(extra)
      expect(m.type).toBe('snapshot')
      if (m.type === 'snapshot') { expect(m.pricesSource).toBeUndefined(); expect(m.pricesAsOf).toBeUndefined() }
    }
  })
})
