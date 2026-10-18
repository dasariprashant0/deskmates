import { describe, expect, test } from 'vitest'
import { pickCharacter, toView } from '../../src/render/pick'
import type { CharacterView } from '../../src/sim/character'

const v = (key: string, x: number, y: number): CharacterView => ({ key, name: key, x, y, dir: 'down', anim: 'idle', frame: 0, ring: 'idle', fade: 1 })

describe('pickCharacter', () => {
  test('hits inside the sprite box, misses outside, empty list is undefined', () => {
    const cs = [v('a', 100, 100)]
    expect(pickCharacter(cs, 100, 90)).toBe('a')
    expect(pickCharacter(cs, 100, 100)).toBe('a')
    expect(pickCharacter(cs, 120, 90)).toBeUndefined()
    expect(pickCharacter(cs, 100, 60)).toBeUndefined()
    expect(pickCharacter([], 1, 1)).toBeUndefined()
  })
  test('overlap picks the one drawn on top (larger y)', () => {
    expect(pickCharacter([v('back', 100, 90), v('front', 102, 100)], 101, 92)).toBe('front')
  })
  test('ignores faded-out characters', () => {
    expect(pickCharacter([{ ...v('a', 100, 100), fade: 0 }], 100, 90)).toBeUndefined()
  })
})

describe('toView', () => {
  test('maps device pixels through the fit transform', () => {
    const f = { scale: 4, x: 40, y: 8, w: 1280, h: 704 }
    expect(toView(f, 40, 8)).toEqual({ x: 0, y: 0 })
    expect(toView(f, 40 + 4 * 100, 8 + 4 * 50)).toEqual({ x: 100, y: 50 })
  })
})
