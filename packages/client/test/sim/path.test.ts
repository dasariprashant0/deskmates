import { describe, expect, test } from 'vitest'
import { findPath, tileKey } from '../../src/sim/path'

const grid = (rows: string[]): boolean[][] => rows.map((r) => [...r].map((c) => c !== '#'))
const open = (w: number, h: number): boolean[][] => grid(Array.from({ length: h }, () => '.'.repeat(w)))

describe('findPath', () => {
  test('shortest length on an open grid, excludes start, ends at goal', () => {
    const p = findPath(open(10, 10), { x: 1, y: 1 }, { x: 7, y: 4 })
    expect(p).toHaveLength(9)
    expect(p?.at(-1)).toEqual({ x: 7, y: 4 })
    expect(p?.[0]).not.toEqual({ x: 1, y: 1 })
  })

  test('steps are 4-neighbor', () => {
    const start = { x: 0, y: 0 }
    const p = findPath(open(6, 6), start, { x: 5, y: 5 }) ?? []
    let prev = start
    for (const t of p) {
      expect(Math.abs(t.x - prev.x) + Math.abs(t.y - prev.y)).toBe(1)
      prev = t
    }
  })

  test('routes around walls', () => {
    const g = grid(['.....', '.###.', '.....'])
    const p = findPath(g, { x: 2, y: 0 }, { x: 2, y: 2 })
    expect(p).toHaveLength(6)
    for (const t of p ?? []) expect(g[t.y]?.[t.x]).toBe(true)
  })

  test('unreachable returns undefined', () => {
    expect(findPath(grid(['..#..']), { x: 0, y: 0 }, { x: 4, y: 0 })).toBeUndefined()
  })

  test('from equals to returns []', () => {
    expect(findPath(open(3, 3), { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([])
  })

  test('out-of-range or non-walkable endpoints return undefined', () => {
    const g = grid(['.#.'])
    expect(findPath(g, { x: -1, y: 0 }, { x: 2, y: 0 })).toBeUndefined()
    expect(findPath(g, { x: 0, y: 0 }, { x: 3, y: 0 })).toBeUndefined()
    expect(findPath(g, { x: 0, y: 5 }, { x: 2, y: 0 })).toBeUndefined()
    expect(findPath(g, { x: 1, y: 0 }, { x: 2, y: 0 })).toBeUndefined()
    expect(findPath(g, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeUndefined()
  })

  test('deterministic: identical input gives identical path', () => {
    const g = open(15, 15)
    const a = findPath(g, { x: 0, y: 0 }, { x: 14, y: 9 })
    for (let i = 0; i < 5; i++) expect(findPath(g, { x: 0, y: 0 }, { x: 14, y: 9 })).toEqual(a)
  })

  test('blocked tiles are impassable', () => {
    const g = grid(['...', '...', '...'])
    const blocked = new Set([tileKey({ x: 1, y: 0 }), tileKey({ x: 1, y: 1 })])
    const p = findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }, blocked)
    expect(p).toHaveLength(6)
    expect(p?.some((t) => blocked.has(tileKey(t)))).toBe(false)
  })

  test('blocked does not apply to the goal or the start', () => {
    const g = grid(['...'])
    const blocked = new Set([tileKey({ x: 0, y: 0 }), tileKey({ x: 2, y: 0 })])
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }, blocked)).toHaveLength(2)
  })

  test('blocked middle tile makes a corridor unreachable', () => {
    const g = grid(['...'])
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }, new Set([tileKey({ x: 1, y: 0 })]))).toBeUndefined()
  })

  test('50x50 grid with walls in under 20 ms', () => {
    const g = open(50, 50)
    for (let y = 0; y < 49; y++) if (y % 4 === 1) for (let x = 0; x < 49; x++) (g[y] as boolean[])[x] = false
    const s = performance.now()
    const p = findPath(g, { x: 0, y: 0 }, { x: 49, y: 49 })
    const dt = performance.now() - s
    expect(p).toBeDefined()
    expect(dt).toBeLessThan(20)
  })
})
