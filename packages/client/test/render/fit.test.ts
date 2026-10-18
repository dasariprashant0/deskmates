import { describe, expect, test } from 'vitest'
import { fitScale } from '../../src/render/fit'

describe('fitScale', () => {
  test('integer scale, centred', () => {
    const f = fitScale(320, 176, 1000, 700, 1)
    expect(f.scale).toBe(3)
    expect(f).toMatchObject({ w: 960, h: 528, x: 20, y: 86 })
  })
  test('never below 1, even in a tiny box', () => {
    const f = fitScale(320, 176, 100, 50, 1)
    expect(f.scale).toBe(1)
    expect(f.x).toBe(0)
    expect(f.y).toBe(0)
  })
  test('dpr multiplies the device box; fractional dpr floors', () => {
    expect(fitScale(320, 176, 800, 600, 2).scale).toBe(5)
    expect(Number.isInteger(fitScale(320, 176, 777, 555, 1.25).scale)).toBe(true)
  })
  test('height can be the limiting side', () => {
    expect(fitScale(320, 176, 2000, 360, 1).scale).toBe(2)
  })
})
