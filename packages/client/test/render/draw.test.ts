import type { Frame, SpriteSheet } from '@deskmates/sprites'
import { describe, expect, test } from 'vitest'
import {
  createBitmapCache, drawCharacter, drawCharacters, drawFloor, drawFurniture, drawRing, drawScene,
  type Ctx2D, type Sprites,
} from '../../src/render/draw'
import { BUBBLE_MAX, type CharacterView, type Ring } from '../../src/sim/character'
import { defaultLayout } from '../../src/sim/layout'

type Op = { op: string; args: unknown[] }
const recorder = (): { ctx: Ctx2D; ops: Op[] } => {
  const ops: Op[] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, p: string) => (p === 'measureText' ? (s: string) => ({ width: s.length * 4 }) : (...args: unknown[]) => { ops.push({ op: p, args }) }),
    set: (_t, p: string, v: unknown) => { ops.push({ op: `set:${p}`, args: [v] }); return true },
  }) as unknown as Ctx2D
  return { ctx, ops }
}

const frame = { width: 16, height: 24, rgba: new Uint8ClampedArray(16 * 24 * 4) } as unknown as Frame
const sprites: Sprites = {
  get: (name): SpriteSheet => ({ name, frames: new Proxy({}, { get: () => [frame, frame] }) as SpriteSheet['frames'] }),
}
const view = (o: Partial<CharacterView> = {}): CharacterView => ({
  key: 'k', name: 'ada', x: 50, y: 60, dir: 'down', anim: 'idle', frame: 0, ring: 'idle', fade: 1, ...o,
})
const cache = () => createBitmapCache(() => ({}))

describe('draw', () => {
  test('floor and furniture draw without throwing and only use rectangles', () => {
    const r = recorder()
    drawFloor(r.ctx)
    drawFurniture(r.ctx, defaultLayout)
    expect(r.ops.some((o) => o.op === 'fillRect')).toBe(true)
    expect(r.ops.some((o) => o.op === 'drawImage')).toBe(false)
  })

  test('empty list draws nothing and does not throw', () => {
    const r = recorder()
    expect(() => drawCharacters(r.ctx, [], sprites, cache(), 0)).not.toThrow()
    expect(r.ops).toHaveLength(0)
    expect(() => drawScene(r.ctx, defaultLayout, [], sprites, cache(), 0)).not.toThrow()
  })

  test('draw order is back to front (sorted by y)', () => {
    const r = recorder()
    const names = [view({ name: 'c', y: 90 }), view({ name: 'a', y: 30 }), view({ name: 'b', y: 60 })]
    const seen: number[] = []
    const c2 = cache()
    const tracked = { get: (n: string, ...rest: [string, never, number, Frame]) => { seen.push(n.charCodeAt(0)); return c2.get(n, ...rest) } }
    drawCharacters(r.ctx, names, sprites, tracked, 0)
    expect(seen.map((n) => String.fromCharCode(n))).toEqual(['a', 'b', 'c'])
    expect(r.ops.filter((o) => o.op === 'drawImage').map((o) => o.args[2])).toEqual([30 - 23, 60 - 23, 90 - 23])
  })

  test('fade sets globalAlpha and resets it', () => {
    const r = recorder()
    drawCharacter(r.ctx, view({ fade: 0.4 }), sprites, cache(), 0)
    const alphas = r.ops.filter((o) => o.op === 'set:globalAlpha').map((o) => o.args[0])
    expect(alphas[0]).toBe(0.4)
    expect(alphas.at(-1)).toBe(1)
  })

  test('bitmaps are cached per sprite+anim+dir+frame', () => {
    let made = 0
    const cc = createBitmapCache(() => { made++; return {} })
    const r = recorder()
    drawCharacter(r.ctx, view(), sprites, cc, 0)
    drawCharacter(r.ctx, view(), sprites, cc, 0)
    expect(made).toBe(1)
    drawCharacter(r.ctx, view({ frame: 1 }), sprites, cc, 0)
    drawCharacter(r.ctx, view({ dir: 'up' }), sprites, cc, 0)
    expect(made).toBe(3)
  })

  test('bubble goes through fillText exactly once and is capped; markup stays text', () => {
    const r = recorder()
    const long = '<img src=x onerror=alert(1)> ' + 'x'.repeat(80)
    drawCharacter(r.ctx, view({ bubble: long }), sprites, cache(), 0)
    const texts = r.ops.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]))
    const bubbles = texts.filter((t) => t !== 'ada')
    expect(bubbles).toHaveLength(1)
    expect(Array.from(bubbles[0] ?? '').length).toBeLessThanOrEqual(BUBBLE_MAX)
    expect(texts.filter((t) => t === 'ada')).toHaveLength(1)
  })

  test('no bubble means only the name tag is drawn', () => {
    const r = recorder()
    drawCharacter(r.ctx, view(), sprites, cache(), 0)
    expect(r.ops.filter((o) => o.op === 'fillText')).toHaveLength(1)
  })

  test('ring shapes differ per ring and idle draws nothing', () => {
    const rings: Ring[] = ['working', 'thinking', 'needs-you', 'error', 'done', 'idle']
    const sigs = rings.map((ring) => {
      const r = recorder()
      drawRing(r.ctx, ring, 50, 60, 0)
      return r.ops.map((o) => o.op + JSON.stringify(o.args)).join('|')
    })
    expect(sigs[5]).toBe('')
    expect(new Set(sigs).size).toBe(6)
    const dash = (ring: Ring) => {
      const r = recorder()
      drawRing(r.ctx, ring, 50, 60, 0)
      return r.ops.filter((o) => o.op === 'setLineDash').map((o) => JSON.stringify(o.args))
    }
    expect(dash('thinking')).toContain('[[1,2]]')
    expect(dash('working')).not.toContain('[[1,2]]')
  })

  test('needs-you ! mark pulses', () => {
    const marks = (tick: number) => {
      const r = recorder()
      drawRing(r.ctx, 'needs-you', 50, 60, tick)
      return r.ops.filter((o) => o.op === 'fillText').length
    }
    expect(marks(0)).toBe(1)
    expect(marks(400)).toBe(0)
  })
})
