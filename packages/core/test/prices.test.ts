import { describe, expect, it } from 'vitest'
import { DEFAULT_PRICES, normalizeModelId, PRICES_AS_OF } from '../src/prices'

describe('normalizeModelId', () => {
  it.each([
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['claude-opus-4-1-20250805', 'claude-opus-4-1'],
    ['claude-opus-4-8[1m]', 'claude-opus-4-8'],
    ['claude-sonnet-4-5-20250929[1m]', 'claude-sonnet-4-5'],
    ['  Claude-Haiku-4-5  ', 'claude-haiku-4-5'],
    ['claude-opus-4', 'claude-opus-4'],
    ['some-unknown-model', 'some-unknown-model'],
    ['<synthetic>', '<synthetic>'],
    ['__proto__', '__proto__'],
    ['', ''],
  ])('%s -> %s', (i, o) => { expect(normalizeModelId(i)).toBe(o) })
  it('never throws on weird input', () => {
    for (const v of [undefined, null, 5, {}, [], Symbol('x'), () => 1]) expect(normalizeModelId(v as unknown as string)).toBe('')
    expect(normalizeModelId('[1m]')).toBe('')
    expect(normalizeModelId('-20250929')).toBe('')
    expect(normalizeModelId('x'.repeat(100_000) + '[')).toHaveLength(100_001)
  })
  it('does not strip short digit runs', () => { expect(normalizeModelId('claude-opus-4-1')).toBe('claude-opus-4-1') })
})

describe('DEFAULT_PRICES', () => {
  it('has as-of date and all keys already normalized', () => {
    expect(PRICES_AS_OF).toBe('2026-10-18')
    for (const k of Object.keys(DEFAULT_PRICES)) expect(normalizeModelId(k)).toBe(k)
  })
  it('spot checks', () => {
    expect(DEFAULT_PRICES['claude-sonnet-4-5']).toEqual({ inputPerMTok: 3, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3, outputPerMTok: 15 })
    expect(DEFAULT_PRICES['claude-fable-5-1']?.cacheReadPerMTok).toBe(0.25)
    expect(DEFAULT_PRICES['claude-haiku-5-5']).toEqual({ inputPerMTok: 0.1, cacheWritePerMTok: 0.125, cacheReadPerMTok: 0.005, outputPerMTok: 0.5 })
    expect(Object.keys(DEFAULT_PRICES)).toHaveLength(20)
  })
})
