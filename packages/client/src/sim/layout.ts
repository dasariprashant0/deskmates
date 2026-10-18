import type { Dir } from '@deskmates/sprites'

export const TILE = 16
export const COLS = 20
export const ROWS = 11
export const VIEW_W = COLS * TILE
export const VIEW_H = ROWS * TILE

export type Tile = { x: number; y: number }
export type ZoneId = 'bookshelf' | 'terminal' | 'whiteboard' | 'webwall' | 'rack' | 'coffee' | 'bell' | 'door'
export type FurnitureKind = ZoneId | 'desk' | 'decor'
export type Furniture = { name: string; x: number; y: number; w: number; h: number; kind: FurnitureKind }
export type Zone = { id: ZoneId; slots: Tile[]; facing: Dir; waitTile: Tile }
export type Desk = { seat: Tile; facing: Dir; computer: Tile }
export type Layout = {
  walkable: boolean[][]
  furniture: Furniture[]
  zones: Record<ZoneId, Zone>
  desks: Desk[]
  hotDesks: Tile[]
  doorTile: Tile
  /** Standing spots near the door for agents when every desk and hot desk is taken. */
  queue: Tile[]
}

const t = (x: number, y: number): Tile => ({ x, y })

/** Pixel position of a tile's feet-center in the 320x180 view. */
export const tilePx = (tile: Tile): { x: number; y: number } => ({
  x: tile.x * TILE + TILE / 2,
  y: tile.y * TILE + TILE - 2,
})

const furniture: Furniture[] = [
  { name: 'plant-left', x: 0, y: 0, w: 1, h: 2, kind: 'decor' },
  { name: 'bookshelf', x: 1, y: 0, w: 4, h: 2, kind: 'bookshelf' },
  { name: 'window-left', x: 5, y: 0, w: 2, h: 2, kind: 'decor' },
  { name: 'whiteboard', x: 7, y: 0, w: 5, h: 2, kind: 'whiteboard' },
  { name: 'window-right', x: 12, y: 0, w: 2, h: 2, kind: 'decor' },
  { name: 'webwall', x: 14, y: 0, w: 5, h: 2, kind: 'webwall' },
  { name: 'plant-right', x: 19, y: 0, w: 1, h: 2, kind: 'decor' },
  { name: 'rack', x: 0, y: 4, w: 2, h: 3, kind: 'rack' },
  { name: 'terminal', x: 18, y: 4, w: 2, h: 3, kind: 'terminal' },
  { name: 'desk-0', x: 6, y: 4, w: 2, h: 1, kind: 'desk' },
  { name: 'desk-1', x: 9, y: 4, w: 2, h: 1, kind: 'desk' },
  { name: 'desk-2', x: 12, y: 4, w: 2, h: 1, kind: 'desk' },
  { name: 'desk-3', x: 6, y: 7, w: 2, h: 1, kind: 'desk' },
  { name: 'desk-4', x: 9, y: 7, w: 2, h: 1, kind: 'desk' },
  { name: 'desk-5', x: 12, y: 7, w: 2, h: 1, kind: 'desk' },
  { name: 'bell', x: 9, y: 10, w: 2, h: 1, kind: 'bell' },
  { name: 'coffee', x: 17, y: 9, w: 3, h: 2, kind: 'coffee' },
  { name: 'door', x: 1, y: 10, w: 2, h: 1, kind: 'door' },
]

const walkable: boolean[][] = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => true))
for (const f of furniture) {
  for (let y = f.y; y < f.y + f.h; y++) {
    const row = walkable[y]
    if (!row) continue
    for (let x = f.x; x < f.x + f.w; x++) row[x] = false
  }
}

const doorTile = t(1, 9)

const deskSeat = (x: number, y: number): Desk => ({ seat: t(x, y), facing: 'up', computer: t(x, y - 1) })

export const defaultLayout: Layout = {
  walkable,
  furniture,
  zones: {
    bookshelf: { id: 'bookshelf', slots: [t(1, 2), t(2, 2), t(3, 2), t(4, 2)], facing: 'up', waitTile: t(5, 2) },
    whiteboard: { id: 'whiteboard', slots: [t(8, 2), t(9, 2), t(10, 2)], facing: 'up', waitTile: t(7, 2) },
    webwall: { id: 'webwall', slots: [t(15, 2), t(16, 2), t(17, 2)], facing: 'up', waitTile: t(14, 2) },
    rack: { id: 'rack', slots: [t(2, 4), t(2, 5), t(2, 6)], facing: 'left', waitTile: t(2, 7) },
    terminal: { id: 'terminal', slots: [t(17, 4), t(17, 5), t(17, 6)], facing: 'right', waitTile: t(17, 7) },
    coffee: { id: 'coffee', slots: [t(17, 8), t(18, 8), t(19, 8)], facing: 'down', waitTile: t(16, 8) },
    bell: { id: 'bell', slots: [t(9, 9), t(10, 9)], facing: 'down', waitTile: t(11, 9) },
    door: { id: 'door', slots: [doorTile], facing: 'down', waitTile: t(2, 9) },
  },
  desks: [deskSeat(6, 5), deskSeat(9, 5), deskSeat(12, 5), deskSeat(6, 8), deskSeat(9, 8), deskSeat(12, 8)],
  hotDesks: [t(3, 10), t(4, 10), t(5, 10), t(6, 10)],
  doorTile,
  queue: [t(2, 8), t(3, 8), t(4, 8), t(3, 9), t(4, 9), t(1, 8)],
}
