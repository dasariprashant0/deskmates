import { describe, expect, test } from 'vitest'
import { isPointerClick, minBoxView, pickCharacter, toView } from '../../src/render/pick'
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

describe('minimum hit box', () => {
  test('minBoxView grows the box when a view pixel is under 2 CSS px', () => {
    expect(minBoxView(1, 1)).toBe(24)
    expect(minBoxView(2, 1)).toBe(12)
    expect(minBoxView(4, 2)).toBe(12)
  })
  test('a small box picks a point the default box misses, within 24 CSS px', () => {
    const cs = [v('a', 100, 100)]
    expect(pickCharacter(cs, 111, 90)).toBeUndefined()
    expect(pickCharacter(cs, 111, 90, minBoxView(1, 1))).toBe('a')
    expect(pickCharacter(cs, 113, 90, minBoxView(1, 1))).toBeUndefined()
  })
  test('the box also grows vertically when it is shorter than the minimum', () => {
    const cs = [v('a', 100, 100)]
    expect(pickCharacter(cs, 100, 108)).toBeUndefined()
    expect(pickCharacter(cs, 100, 108, 40)).toBe('a')
    expect(pickCharacter(cs, 100, 111, 40)).toBeUndefined()
  })
})

describe('isPointerClick', () => {
  test('keyboard-synthesised clicks (detail 0) are ignored', () => {
    expect(isPointerClick({ detail: 0, clientX: 400, clientY: 300 })).toBe(false)
    expect(isPointerClick({ detail: 1, clientX: 400, clientY: 300 })).toBe(true)
    expect(isPointerClick({ detail: 1, clientX: 0, clientY: 0 })).toBe(false)
  })
})
