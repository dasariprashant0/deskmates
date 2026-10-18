import type { Frame, SpriteSheet } from '@deskmates/sprites'
import { describe, expect, test } from 'vitest'
import {
  BITMAP_CACHE_MAX, createBitmapCache, drawCharacter, drawCharacters, drawFloor, drawFurniture, drawRing, drawScene, measure,
  type Ctx2D, type Sprites,
} from '../../src/render/draw'
import { BUBBLE_MAX, type CharacterView, type Ring } from '../../src/sim/character'
import { defaultLayout, VIEW_W } from '../../src/sim/layout'
import { PAL, RING_COLOR } from '../../src/render/palette'

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
    expect(() => drawCharacters(r.ctx, [], sprites, cache())).not.toThrow()
    expect(r.ops).toHaveLength(0)
    expect(() => drawScene(r.ctx, defaultLayout, [], sprites, cache())).not.toThrow()
  })

  test('draw order is back to front (sorted by y)', () => {
    const r = recorder()
    const names = [view({ name: 'c', y: 90 }), view({ name: 'a', y: 30 }), view({ name: 'b', y: 60 })]
    const seen: number[] = []
    const c2 = cache()
    const tracked = { get: (n: string, ...rest: [string, never, number, Frame]) => { seen.push(n.charCodeAt(0)); return c2.get(n, ...rest) } }
    drawCharacters(r.ctx, names, sprites, tracked)
    expect(seen.map((n) => String.fromCharCode(n))).toEqual(['a', 'b', 'c'])
    expect(r.ops.filter((o) => o.op === 'drawImage').map((o) => o.args[2])).toEqual([30 - 23, 60 - 23, 90 - 23])
  })

  test('fade sets globalAlpha and resets it', () => {
    const r = recorder()
    drawCharacter(r.ctx, view({ fade: 0.4 }), sprites, cache())
    const alphas = r.ops.filter((o) => o.op === 'set:globalAlpha').map((o) => o.args[0])
    expect(alphas[0]).toBe(0.4)
    expect(alphas.at(-1)).toBe(1)
  })

  test('bitmaps are cached per sprite+anim+dir+frame', () => {
    let made = 0
    const cc = createBitmapCache(() => { made++; return {} })
    const r = recorder()
    drawCharacter(r.ctx, view(), sprites, cc)
    drawCharacter(r.ctx, view(), sprites, cc)
    expect(made).toBe(1)
    drawCharacter(r.ctx, view({ frame: 1 }), sprites, cc)
    drawCharacter(r.ctx, view({ dir: 'up' }), sprites, cc)
    expect(made).toBe(3)
  })

  test('bubble goes through fillText exactly once and is capped; markup stays text', () => {
    const r = recorder()
    const long = '<img src=x onerror=alert(1)> ' + 'x'.repeat(80)
    drawCharacter(r.ctx, view({ ring: "working", bubble: long }), sprites, cache())
    const texts = r.ops.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]))
    const bubbles = texts.filter((t) => t !== 'ada')
    expect(bubbles).toHaveLength(1)
    expect(Array.from(bubbles[0] ?? '').length).toBeLessThanOrEqual(BUBBLE_MAX)
    expect(texts.filter((t) => t === 'ada')).toHaveLength(1)
  })

  test('no bubble means only the name tag is drawn', () => {
    const r = recorder()
    drawCharacter(r.ctx, view(), sprites, cache())
    expect(r.ops.filter((o) => o.op === 'fillText')).toHaveLength(1)
  })

  test('ring shapes differ per ring and idle draws nothing', () => {
    const rings: Ring[] = ['working', 'thinking', 'needs-you', 'error', 'done', 'idle']
    const sigs = rings.map((ring) => {
      const r = recorder()
      drawRing(r.ctx, ring, 50, 60)
      return r.ops.map((o) => o.op + JSON.stringify(o.args)).join('|')
    })
    expect(sigs[5]).toBe('')
    expect(new Set(sigs).size).toBe(6)
    const dash = (ring: Ring) => {
      const r = recorder()
      drawRing(r.ctx, ring, 50, 60)
      return r.ops.filter((o) => o.op === 'setLineDash').map((o) => JSON.stringify(o.args))
    }
    expect(dash('thinking')).toContain('[[1,2]]')
    expect(dash('working')).not.toContain('[[1,2]]')
  })

  test('needs-you ! mark is static (no blink)', () => {
    const marks = () => {
      const r = recorder()
      drawRing(r.ctx, 'needs-you', 50, 60)
      return r.ops.filter((o) => o.op === 'fillText').length
    }
    expect(marks()).toBe(1)
  })

  test('working ring is 2px wide and uses the contrast-checked colour', () => {
    const r = recorder()
    drawRing(r.ctx, 'working', 50, 60)
    expect(r.ops.find((o) => o.op === 'set:lineWidth')?.args[0]).toBe(2)
    expect(r.ops.find((o) => o.op === 'set:strokeStyle')?.args[0]).toBe(RING_COLOR.working)
  })

  test('bitmap cache holds at most BITMAP_CACHE_MAX entries and drops the oldest', () => {
    let made = 0
    const cc = createBitmapCache(() => { made++; return {} })
    for (let i = 0; i < BITMAP_CACHE_MAX + 5; i++) cc.get(`n${i}`, 'idle', 'down', 0, frame)
    expect(made).toBe(BITMAP_CACHE_MAX + 5)
    cc.get(`n${BITMAP_CACHE_MAX + 4}`, 'idle', 'down', 0, frame)
    expect(made).toBe(BITMAP_CACHE_MAX + 5)
    cc.get('n0', 'idle', 'down', 0, frame)
    expect(made).toBe(BITMAP_CACHE_MAX + 6)
  })

  test('measure memoises by font and text per context', () => {
    let calls = 0
    const c = { font: '8px monospace', measureText: (t: string) => { calls++; return { width: t.length } } } as unknown as Ctx2D
    expect(measure(c, 'abc')).toBe(3)
    expect(measure(c, 'abc')).toBe(3)
    expect(calls).toBe(1)
    c.font = '9px monospace'
    measure(c, 'abc')
    expect(calls).toBe(2)
  })
})

// ---- slice 2: bubble clamping, stacking, selection, reduced motion ---------------------------------
type Fill = { color: unknown; x: number; y: number; w: number; h: number }
const fills = (ops: Op[]): Fill[] => {
  let color: unknown
  const out: Fill[] = []
  for (const o of ops) {
    if (o.op === 'set:fillStyle') color = o.args[0]
    if (o.op === 'fillRect') out.push({ color, x: o.args[0] as number, y: o.args[1] as number, w: o.args[2] as number, h: o.args[3] as number })
  }
  return out
}
const overlap = (a: Fill, b: Fill): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('label placement', () => {
  const bubble = 'x'.repeat(24)
  test.each([0, VIEW_W, 3, VIEW_W - 3])('bubble and name tag stay inside the view for x=%i', (x) => {
    const r = recorder()
    drawCharacter(r.ctx, view({ x, y: 80, ring: "working", bubble, name: 'a-long-name-here' }), sprites, cache())
    const tags = fills(r.ops).filter((f) => f.color === PAL.bubbleBg || f.color === PAL.tagBg)
    expect(tags).toHaveLength(2)
    for (const t of tags) {
      expect(t.x).toBeGreaterThanOrEqual(2)
      expect(t.x + t.w).toBeLessThanOrEqual(VIEW_W - 2)
    }
  })
  test('bubble sits above the name tag without overlapping', () => {
    const r = recorder()
    drawCharacter(r.ctx, view({ x: 160, y: 80, ring: "working", bubble: 'hello' }), sprites, cache())
    const f = fills(r.ops)
    const b = f.find((t) => t.color === PAL.bubbleBg)
    const n = f.find((t) => t.color === PAL.tagBg)
    expect(b && n && !overlap(b, n) && b.y < n.y).toBe(true)
  })
  test('near the top the bubble moves below the feet instead of clipping', () => {
    const r = recorder()
    drawCharacter(r.ctx, view({ x: 160, y: 30, ring: "working", bubble: 'hello' }), sprites, cache())
    const b = fills(r.ops).find((t) => t.color === PAL.bubbleBg)
    expect(b?.y).toBeGreaterThanOrEqual(0)
  })
  test('colliding characters get non-overlapping labels', () => {
    const r = recorder()
    drawCharacters(r.ctx, [view({ key: 'a', name: 'aa', x: 100, y: 80, ring: "working", bubble: 'one' }), view({ key: 'b', name: 'bb', x: 104, y: 82, ring: "working", bubble: "two" })], sprites, cache())
    const tags = fills(r.ops).filter((f) => f.color === PAL.bubbleBg || f.color === PAL.tagBg)
    expect(tags).toHaveLength(4)
    for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) expect(overlap(tags[i] as Fill, tags[j] as Fill)).toBe(false)
  })
})

describe('selection and reduced motion', () => {
  test('selected character gets a marker shape; others do not', () => {
    const plain = recorder()
    drawCharacter(plain.ctx, view(), sprites, cache())
    const sel = recorder()
    drawCharacter(sel.ctx, view(), sprites, cache(), { selectedKey: 'k' })
    const other = recorder()
    drawCharacter(other.ctx, view(), sprites, cache(), { selectedKey: 'zzz' })
    expect(sel.ops.length).toBeGreaterThan(plain.ops.length)
    expect(other.ops.length).toBe(plain.ops.length)
    expect(fills(sel.ops).some((f) => f.color === PAL.accent)).toBe(true)
  })
  test('the ! is drawn with the character regardless of time', () => {
    const r = recorder()
    drawCharacter(r.ctx, view({ ring: 'needs-you' }), sprites, cache())
    expect(r.ops.filter((o) => o.op === 'fillText' && o.args[0] === '!')).toHaveLength(1)
  })
})

// ---- crowding: label layout, badges, bubble rules -------------------------------------------------
type Drawn = { text: string; bg: unknown; rect: Fill; i: number }
/** Every label the renderer drew, in draw order: the fillRect of its background and the fillText that follows. */
const drawn = (ops: Op[]): Drawn[] => {
  const out: Drawn[] = []
  let color: unknown
  let last: { color: unknown; rect: Fill } | undefined
  ops.forEach((o, i) => {
    if (o.op === 'set:fillStyle') color = o.args[0]
    if (o.op === 'fillRect' && (color === PAL.tagBg || color === PAL.bubbleBg)) last = { color, rect: { color, x: o.args[0] as number, y: o.args[1] as number, w: o.args[2] as number, h: o.args[3] as number } }
    if (o.op === 'fillText' && last && o.args[0] !== '!') { out.push({ text: String(o.args[0]), bg: last.color, rect: last.rect, i }); last = undefined }
  })
  return out
}
const crowd = (n: number, extra: (i: number) => Partial<CharacterView> = () => ({})): CharacterView[] =>
  Array.from({ length: n }, (_, i) => view({ key: `k${i}`, name: 'general-purpose', short: `agent #${i + 1}`, x: 150 + (i % 5) * 4, y: 100 + Math.floor(i / 5) * 5, ...extra(i) }))

describe('crowded labels', () => {
  test('16 characters stacked within 20 px: no two drawn label rects overlap and all stay inside the view', () => {
    const r = recorder()
    drawCharacters(r.ctx, crowd(16, (i) => ({ ring: 'working', bubble: `tool ${i}` })), sprites, cache())
    const d = drawn(r.ops)
    expect(d.length).toBeGreaterThan(4)
    for (let i = 0; i < d.length; i++) {
      const a = (d[i] as Drawn).rect
      expect(a.x).toBeGreaterThanOrEqual(0)
      expect(a.x + a.w).toBeLessThanOrEqual(VIEW_W)
      for (let j = i + 1; j < d.length; j++) expect(overlap(a, (d[j] as Drawn).rect)).toBe(false)
    }
  })

  test('when the full tag cannot be placed a compact #n badge is drawn instead', () => {
    const r = recorder()
    drawCharacters(r.ctx, crowd(16), sprites, cache())
    const texts = drawn(r.ops).map((d) => d.text)
    expect(texts.some((t) => /^#\d+$/.test(t))).toBe(true)
    expect(texts.some((t) => t.startsWith('agent #'))).toBe(true)
  })

  test('a lone character gets its full tag and no badge', () => {
    const r = recorder()
    drawCharacters(r.ctx, [view({ short: 'agent #2' })], sprites, cache())
    expect(drawn(r.ops).map((d) => d.text)).toEqual(['agent #2'])
  })

  test('selected and hovered labels are full and drawn last, even in a crowd', () => {
    const r = recorder()
    drawCharacters(r.ctx, crowd(16), sprites, cache(), { selectedKey: 'k0', hoveredKey: 'k7' })
    const d = drawn(r.ops)
    expect(d.slice(-2).map((x) => x.text)).toEqual(['agent #1', 'agent #8'])
    for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++) expect(overlap((d[i] as Drawn).rect, (d[j] as Drawn).rect)).toBe(false)
  })

  test('selected label is last even when it sorts first', () => {
    const r = recorder()
    drawCharacters(r.ctx, [view({ key: 'top', name: 'top', y: 40 }), view({ key: 'bot', name: 'bot', y: 120 })], sprites, cache(), { selectedKey: 'top' })
    expect(drawn(r.ops).map((d) => d.text)).toEqual(['bot', 'top'])
  })

  test('idle characters never get a bubble; the selected one does', () => {
    const idle = recorder()
    drawCharacters(idle.ctx, [view({ bubble: 'Read: x', ring: 'idle' }), view({ key: 'd', bubble: 'Read: y', ring: 'done', y: 100 }), view({ key: 'n', bubble: 'Read: z', ring: 'needs-you', y: 120 })], sprites, cache())
    expect(drawn(idle.ops).filter((d) => d.bg === PAL.bubbleBg)).toHaveLength(0)
    const sel = recorder()
    drawCharacters(sel.ctx, [view({ bubble: 'Read: x', ring: 'idle' })], sprites, cache(), { selectedKey: 'k' })
    expect(drawn(sel.ops).filter((d) => d.bg === PAL.bubbleBg).map((d) => d.text)).toEqual(['Read: x'])
  })

  test('at most 6 bubbles; the ones farthest from the selection are dropped and the selection keeps its own', () => {
    const views = Array.from({ length: 12 }, (_, i) => view({ key: `k${i}`, name: `n${i}`, x: 20 + i * 24, y: 90, ring: 'working', bubble: `b${i}` }))
    const r = recorder()
    drawCharacters(r.ctx, views, sprites, cache(), { selectedKey: 'k0' })
    const b = drawn(r.ops).filter((d) => d.bg === PAL.bubbleBg).map((d) => d.text).sort()
    expect(b).toHaveLength(6)
    expect(b).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5'])
    const none = recorder()
    drawCharacters(none.ctx, views, sprites, cache())
    expect(drawn(none.ops).filter((d) => d.bg === PAL.bubbleBg)).toHaveLength(6)
  })

  test('fade is applied per label', () => {
    const r = recorder()
    drawCharacters(r.ctx, [view({ fade: 0.5 })], sprites, cache())
    const i = r.ops.findIndex((o) => o.op === 'fillText')
    const alpha = r.ops.slice(0, i).filter((o) => o.op === 'set:globalAlpha').at(-1)?.args[0]
    expect(alpha).toBe(0.5)
  })
})
