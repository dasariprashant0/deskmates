import { describe, expect, test } from 'vitest'
import { contextLabel, contextShare, contextWindowFor } from '../../src/hud/context'

describe('context', () => {
  test('window defaults to 200K, 1M for [1m] / -1m model ids', () => {
    expect(contextWindowFor(undefined)).toBe(200_000)
    expect(contextWindowFor('claude-sonnet-4-5')).toBe(200_000)
    expect(contextWindowFor('claude-sonnet-4-5[1m]')).toBe(1_000_000)
    expect(contextWindowFor('claude-opus-4-1-1m')).toBe(1_000_000)
  })
  test('share is clamped 0..1 and tolerates bad numbers', () => {
    expect(contextShare(50_000, 200_000)).toBe(0.25)
    expect(contextShare(500_000, 200_000)).toBe(1)
    expect(contextShare(-5, 200_000)).toBe(0)
    expect(contextShare(NaN, 200_000)).toBe(0)
    expect(contextShare(5, 0)).toBe(0)
  })
  test('label states the window is assumed', () => {
    expect(contextLabel(84_000, 'claude-x')).toBe('42% of 200K (assumed window)')
    expect(contextLabel(500_000, 'x[1m]')).toBe('50% of 1M (assumed window)')
    expect(contextLabel(undefined, 'x')).toBe('unknown')
  })
})

test('contextLabel: negative and non-finite are unknown', () => {
  for (const n of [-1, NaN, Infinity]) expect(contextLabel(n, 'x')).toBe('unknown')
})
