import { describe, expect, test } from 'vitest'
import { cyrb53, mulberry32 } from '../src/index'

describe('cyrb53', () => {
  test('is deterministic', () => {
    expect(cyrb53('claude')).toBe(cyrb53('claude'))
  })
  test('differs for different strings', () => {
    expect(cyrb53('claude')).not.toBe(cyrb53('claudf'))
  })
  test('seed changes the result', () => {
    expect(cyrb53('claude', 1)).not.toBe(cyrb53('claude', 2))
    expect(cyrb53('claude', 0)).toBe(cyrb53('claude'))
  })
  test('handles empty and unicode strings', () => {
    expect(Number.isSafeInteger(cyrb53(''))).toBe(true)
    expect(Number.isSafeInteger(cyrb53('héllo 🧑‍💻 日本語'))).toBe(true)
    expect(cyrb53('🧑‍💻')).not.toBe(cyrb53(''))
  })
})

describe('mulberry32', () => {
  test('is deterministic', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 20; i++) expect(a()).toBe(b())
  })
  test('different seeds give different streams', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)())
  })
  test('returns values in [0,1)', () => {
    const r = mulberry32(cyrb53('range'))
    for (let i = 0; i < 5000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
