import type { Tile } from './layout'

export const tileKey = (tile: Tile): string => `${tile.x},${tile.y}`

type Entry = { f: number; h: number; seq: number; idx: number }

// Min-heap ordered by f, then h (closer to goal first), then insertion order: fully deterministic.
const less = (a: Entry, b: Entry): boolean => (a.f !== b.f ? a.f < b.f : a.h !== b.h ? a.h < b.h : a.seq < b.seq)

class Heap {
  private a: Entry[] = []
  get size(): number {
    return this.a.length
  }
  push(e: Entry): void {
    const a = this.a
    a.push(e)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      const pe = a[p]
      const ce = a[i]
      if (!pe || !ce || !less(ce, pe)) break
      a[p] = ce
      a[i] = pe
      i = p
    }
  }
  pop(): Entry | undefined {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (top === undefined || last === undefined) return top
    if (a.length === 0) return top
    a[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      const le = a[l]
      const re = a[r]
      const me = a[m]
      if (le && me && less(le, me)) m = l
      const me2 = a[m]
      if (re && me2 && less(re, me2)) m = r
      if (m === i) break
      const x = a[i]
      const y = a[m]
      if (!x || !y) break
      a[i] = y
      a[m] = x
      i = m
    }
    return top
  }
}

// Fixed neighbor order (up, right, down, left) keeps results identical for identical input.
const DX = [0, 1, 0, -1]
const DY = [-1, 0, 1, 0]

/**
 * A* over a 4-neighbor tile grid. Returns the path excluding `from`, [] when from equals to,
 * undefined when unreachable or an endpoint is out of range / not walkable. `blocked` tiles
 * (keys from tileKey) are impassable except the goal and the start.
 */
export function findPath(walkable: boolean[][], from: Tile, to: Tile, blocked?: Set<string>): Tile[] | undefined {
  const rows = walkable.length
  const cols = walkable[0]?.length ?? 0
  const ok = (x: number, y: number): boolean => x >= 0 && y >= 0 && y < rows && x < cols && walkable[y]?.[x] === true
  if (!ok(from.x, from.y) || !ok(to.x, to.y)) return undefined
  if (from.x === to.x && from.y === to.y) return []

  const n = rows * cols
  const g = new Int32Array(n).fill(-1)
  const parent = new Int32Array(n).fill(-1)
  const closed = new Uint8Array(n)
  const start = from.y * cols + from.x
  const goal = to.y * cols + to.x
  const h = (x: number, y: number): number => Math.abs(x - to.x) + Math.abs(y - to.y)

  const heap = new Heap()
  let seq = 0
  g[start] = 0
  heap.push({ f: h(from.x, from.y), h: h(from.x, from.y), seq: seq++, idx: start })

  while (heap.size > 0) {
    const cur = heap.pop()
    if (!cur) break
    const ci = cur.idx
    if (closed[ci]) continue
    closed[ci] = 1
    if (ci === goal) break
    const cx = ci % cols
    const cy = (ci - cx) / cols
    const cg = g[ci] ?? 0
    for (let d = 0; d < 4; d++) {
      const nx = cx + (DX[d] ?? 0)
      const ny = cy + (DY[d] ?? 0)
      if (!ok(nx, ny)) continue
      const ni = ny * cols + nx
      if (closed[ni]) continue
      if (ni !== goal && blocked?.has(`${nx},${ny}`)) continue
      const ng = cg + 1
      const old = g[ni] ?? -1
      if (old !== -1 && old <= ng) continue
      g[ni] = ng
      parent[ni] = ci
      const nh = h(nx, ny)
      heap.push({ f: ng + nh, h: nh, seq: seq++, idx: ni })
    }
  }

  if (!closed[goal]) return undefined
  const out: Tile[] = []
  for (let i = goal; i !== start; i = parent[i] ?? start) {
    const x = i % cols
    out.push({ x, y: (i - x) / cols })
  }
  return out.reverse()
}
