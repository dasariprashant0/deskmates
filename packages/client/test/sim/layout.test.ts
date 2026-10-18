import { describe, expect, test } from 'vitest'
import { COLS, defaultLayout as L, ROWS, TILE, VIEW_H, VIEW_W, type Tile } from '../../src/sim/layout'
import { findPath } from '../../src/sim/path'

const ok = (t: Tile): boolean => L.walkable[t.y]?.[t.x] === true
const reachable = (t: Tile): boolean => findPath(L.walkable, L.doorTile, t) !== undefined

describe('layout', () => {
  test('dimensions: 20x11 tiles of 16 px = 320x180 view', () => {
    expect(TILE).toBe(16)
    expect(L.walkable).toHaveLength(ROWS)
    expect(ROWS).toBe(11)
    expect(COLS).toBe(20)
    for (const row of L.walkable) expect(row).toHaveLength(COLS)
    expect([VIEW_W, VIEW_H]).toEqual([320, 176])
  })

  test('six desks, four hot desks, door tile walkable', () => {
    expect(L.desks).toHaveLength(6)
    expect(L.hotDesks).toHaveLength(4)
    expect(ok(L.doorTile)).toBe(true)
  })

  test('zones have 2-4 slots (door 1), facing and wait tile', () => {
    for (const [id, z] of Object.entries(L.zones)) {
      if (id === 'door') expect(z.slots).toHaveLength(1)
      else {
        expect(z.slots.length).toBeGreaterThanOrEqual(2)
        expect(z.slots.length).toBeLessThanOrEqual(4)
      }
      expect(z.id).toBe(id)
      expect(['up', 'down', 'left', 'right']).toContain(z.facing)
    }
  })

  test('every slot, waitTile, desk seat, hot desk and queue tile is walkable and reachable from the door', () => {
    const tiles: Tile[] = [
      ...Object.values(L.zones).flatMap((z) => [...z.slots, z.waitTile]),
      ...L.desks.map((d) => d.seat),
      ...L.hotDesks,
      ...L.queue,
    ]
    for (const t of tiles) {
      expect(ok(t), `walkable ${t.x},${t.y}`).toBe(true)
      expect(reachable(t), `reachable ${t.x},${t.y}`).toBe(true)
    }
  })

  test('stand tiles are unique and desk computers are furniture', () => {
    const keys = [
      ...Object.values(L.zones).flatMap((z) => [...z.slots, z.waitTile]),
      ...L.desks.map((d) => d.seat),
      ...L.hotDesks,
      ...L.queue,
    ].map((t) => `${t.x},${t.y}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const d of L.desks) expect(ok(d.computer)).toBe(false)
  })
})
