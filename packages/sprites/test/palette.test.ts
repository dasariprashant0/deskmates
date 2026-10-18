import { describe, expect, test } from 'vitest'
import { HAIR_BASES, OUTFIT_BASES, SKIN_BASES, hslToRgb, makeRamp, rgbToHsl, type Rgb } from '../src/palette'

const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}
const light = (c: Rgb) => rgbToHsl(c)[2]
const ALL: Rgb[] = [...SKIN_BASES, ...HAIR_BASES, ...OUTFIT_BASES]

describe('makeRamp', () => {
  test('shadow < base < highlight in lightness for every palette colour', () => {
    for (const c of ALL) {
      const r = makeRamp(c)
      expect(light(r.shadow)).toBeLessThan(light(r.base))
      expect(light(r.base)).toBeLessThan(light(r.highlight))
    }
  })
  test('all channels are integers within 0..255, even for extremes', () => {
    for (const c of [...ALL, [0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 0, 255]] as Rgb[]) {
      const r = makeRamp(c)
      for (const step of [r.shadow, r.base, r.highlight])
        for (const ch of step) {
          expect(Number.isInteger(ch)).toBe(true)
          expect(ch).toBeGreaterThanOrEqual(0)
          expect(ch).toBeLessThanOrEqual(255)
        }
    }
  })
  test('shadow hue moves toward blue, highlight toward yellow', () => {
    const warm: Rgb = [200, 120, 80]
    const [h] = rgbToHsl(warm)
    const r = makeRamp(warm)
    expect(hueDist(rgbToHsl(r.shadow)[0], 240)).toBeLessThan(hueDist(h, 240))
    expect(hueDist(rgbToHsl(r.highlight)[0], 60)).toBeLessThan(hueDist(h, 60))
  })
  test('base is kept as given', () => {
    expect(makeRamp([10, 20, 30]).base).toEqual([10, 20, 30])
  })
})

describe('skin palette', () => {
  test('8 natural tones: hue 10-40, saturation 25-65%, light to dark', () => {
    expect(SKIN_BASES).toHaveLength(8)
    const ls = SKIN_BASES.map((c) => {
      const [h, sat, l] = rgbToHsl(c)
      expect(h).toBeGreaterThanOrEqual(10)
      expect(h).toBeLessThan(40) // never yellow
      expect(sat).toBeGreaterThanOrEqual(0.25)
      expect(sat).toBeLessThanOrEqual(0.65)
      expect(l).toBeGreaterThanOrEqual(0.33)
      expect(l).toBeLessThanOrEqual(0.82)
      return l
    })
    expect(ls).toEqual([...ls].sort((a, b) => b - a))
  })
})

describe('pinned colour maths (localises palette regressions)', () => {
  test('makeRamp outputs', () => {
    expect(makeRamp([200, 120, 80])).toEqual({ shadow: [143, 61, 45], base: [200, 120, 80], highlight: [217, 176, 134] })
    expect(makeRamp([59, 125, 216])).toEqual({ shadow: [30, 61, 153], base: [59, 125, 216], highlight: [119, 183, 228] })
  })
  test('hslToRgb outputs', () => {
    expect(hslToRgb(200, 0.5, 0.5)).toEqual([64, 149, 191])
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0])
  })
})
