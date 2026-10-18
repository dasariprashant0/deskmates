import { DEFAULT_PRICES, EXAMPLE_PRICES, type PriceTable } from '@deskmates/core'
import { describe, expect, test } from 'vitest'
import { asPriceTable, estimateCost, formatCost, formatElapsed, formatTokens, formatUsd, pricesNote } from '../../src/hud/cost'

const T: PriceTable = { m: { inputPerMTok: 3, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3, outputPerMTok: 15 } }
const U = (n: number) => ({ input: n, cacheWrite: n, cacheRead: n, output: n })

describe('estimateCost', () => {
  test('per-million pricing across all four token kinds', () => {
    const r = estimateCost(U(1_000_000), 'm', T)
    expect(r.known).toBe(true)
    expect(r.usd).toBeCloseTo(22.05, 6)
  })
  test('unknown, missing and prototype-ish models are unknown with usd 0', () => {
    for (const m of ['nope', undefined, '__proto__', 'constructor', 'toString']) expect(estimateCost(U(1e6), m, T)).toEqual({ usd: 0, known: false })
  })
  test('zero usage on a known model is known and 0', () => {
    expect(estimateCost(U(0), 'm', T)).toEqual({ usd: 0, known: true })
  })
  test('huge, NaN, negative and infinite counts never produce NaN or negatives', () => {
    for (const n of [1e308, Infinity, NaN, -5, -Infinity]) {
      const r = estimateCost(U(n), 'm', T)
      expect(Number.isFinite(r.usd)).toBe(true)
      expect(r.usd).toBeGreaterThanOrEqual(0)
    }
  })
  test('example prices', () => {
    expect(estimateCost({ input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 }, 'example-model', EXAMPLE_PRICES)).toEqual({ usd: 1, known: true })
  })
})

describe('asPriceTable', () => {
  test('keeps valid entries, drops junk and non-objects', () => {
    expect(asPriceTable(null)).toEqual({})
    expect(asPriceTable([1])).toEqual({})
    const t = asPriceTable({ ok: T.m, bad: { inputPerMTok: 'x' }, neg: { inputPerMTok: -1, cacheWritePerMTok: 0, cacheReadPerMTok: 0, outputPerMTok: 0 } })
    expect(Object.keys(t)).toEqual(['ok'])
  })
})

describe('formatters', () => {
  test('formatUsd', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(1.234)).toBe('$1.23')
    expect(formatUsd(12345.6)).toBe('$12,346')
    expect(formatUsd(NaN)).toBe('$0.00')
    expect(formatUsd(-3)).toBe('$0.00')
  })
  test('formatCost always carries ~ and unknown is explicit', () => {
    expect(formatCost({ usd: 1.5, known: true })).toBe('~$1.50')
    expect(formatCost({ usd: 0, known: false })).toBe('cost unknown')
  })
  test('formatTokens', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(999_999)).toBe('1M')
    expect(formatTokens(3_400_000)).toBe('3.4M')
    expect(formatTokens(2_500_000_000)).toBe('2.5B')
    expect(formatTokens(NaN)).toBe('0')
    expect(formatTokens(-1)).toBe('0')
  })
  test('formatElapsed', () => {
    expect(formatElapsed(42_000)).toBe('42s')
    expect(formatElapsed(185_000)).toBe('3m 05s')
    expect(formatElapsed(3_720_000)).toBe('1h 02m')
    expect(formatElapsed(-5)).toBe('0s')
    expect(formatElapsed(NaN)).toBe('0s')
  })
})

describe('estimateCost model id normalization', () => {
  const P = { 'claude-sonnet-4-5': { inputPerMTok: 3, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3, outputPerMTok: 15 } }
  const one = { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 }
  test.each(['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5[1m]', 'Claude-Sonnet-4-5-20250929[1m]', 'claude-sonnet-4-5'])('%s finds the entry', (m) => {
    expect(estimateCost(one, m, P)).toEqual({ usd: 3, known: true })
  })
  test('synthetic, unknown, empty and prototype keys stay unknown', () => {
    for (const m of ['<synthetic>', 'claude-unknown-9', '', '__proto__', 'constructor']) expect(estimateCost(one, m, P)).toEqual({ usd: 0, known: false })
  })
  test('built-in defaults price a real dated id', () => {
    expect(estimateCost(one, 'claude-opus-4-1-20250805', DEFAULT_PRICES)).toEqual({ usd: 15, known: true })
  })
})

describe('pricesNote', () => {
  test('per source', () => {
    expect(pricesNote({ source: 'default', asOf: '2026-10-18' })).toBe('Estimated from built-in prices as of 2026-10-18; override in ~/.deskmates/prices.json')
    expect(pricesNote({ source: 'user', asOf: '2026-10-18' })).toBe('Estimated from your prices.json')
    expect(pricesNote({ source: 'example', asOf: '2026-10-18' })).toBe('')
  })
})
