import { EXAMPLE_PRICES, type AgentState, type OfficeState } from '@deskmates/core'
import { describe, expect, test } from 'vitest'
import { summarize } from '../../src/hud/summary'
import type { Ctx2D } from '../../src/render/draw'
import { drawHud } from '../../src/render/hud'
import { FLOOR_TILES, HUD_PAIRS, RING_COLOR } from '../../src/render/palette'

type Op = { op: string; args: unknown[] }
const recorder = (): { ctx: Ctx2D; ops: Op[] } => {
  const ops: Op[] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, p: string) => (p === 'measureText' ? (s: string) => ({ width: s.length * 7 }) : (...args: unknown[]) => { ops.push({ op: p, args }) }),
    set: (_t, p: string, v: unknown) => { ops.push({ op: `set:${p}`, args: [v] }); return true },
  }) as unknown as Ctx2D
  return { ctx, ops }
}
const mk = (sid: string, o: Partial<AgentState> = {}): AgentState => ({
  key: `t:${sid}:main`, ref: { provider: 't', sessionId: sid }, cwd: `/home/u/${sid}`, status: 'working', activity: 'typing',
  openTools: {}, openOrder: [], usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, startedAt: 0, lastEventAt: 0, children: [], ...o,
})
const office = (...a: AgentState[]): OfficeState => ({ agents: Object.fromEntries(a.map((x) => [x.key, x])), order: a.map((x) => x.key), seq: 0 })
const box = { x: 0, y: 500, w: 1600, h: 40 }
const texts = (ops: Op[]): string[] => ops.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]))

describe('drawHud fit', () => {
  const busy = summarize(
    office(
      ...Array.from({ length: 12 }, (_, i) => mk(`w${i}`, { model: 'example-model', usage: { input: 3_000_000, cacheWrite: 0, cacheRead: 0, output: 0 } })),
      ...Array.from({ length: 3 }, (_, i) => mk(`t${i}`, { status: 'thinking' })),
      mk('e', { status: 'error' }),
      mk('n', { status: 'waiting', attention: { toolUseId: 'x', source: 'hook', since: 1 } }),
    ),
    EXAMPLE_PRICES, true, 0,
  )
  test.each([320, 480, 640, 1280])('nothing is cut off and errors + cost stay visible at %i px', (w) => {
    const r = recorder()
    drawHud(r.ctx, busy, { x: 0, y: 0, w, h: 32 }, 1)
    const placed = r.ops.filter((o) => o.op === 'fillText')
    for (const o of placed) expect(Number(o.args[1]) + String(o.args[0]).length * 7).toBeLessThanOrEqual(w)
    const all = texts(r.ops).join(' | ')
    expect(all).toMatch(/\b1 errors|\b1x/)
    expect(all).toContain('~$')
  })
  test('wide boxes keep the full wording, narrow ones abbreviate', () => {
    const wide = recorder()
    drawHud(wide.ctx, busy, { x: 0, y: 0, w: 1280, h: 32 }, 1)
    expect(texts(wide.ops).join(' ')).toContain('12 working')
    const narrow = recorder()
    drawHud(narrow.ctx, busy, { x: 0, y: 0, w: 320, h: 32 }, 1)
    expect(texts(narrow.ops).join(' ')).not.toContain('working')
  })
})

describe('drawHud', () => {
  test('empty state draws without throwing and shows zero counts', () => {
    const r = recorder()
    const hits = drawHud(r.ctx, summarize(office(), EXAMPLE_PRICES, true, 0), box, 1)
    expect(hits).toEqual([])
    const all = texts(r.ops).join(' ')
    expect(all).toContain('0 working')
    expect(all).toContain('0 needs you')
  })
  test('shows counts, tokens, ~cost and the example marker', () => {
    const s = summarize(office(mk('a', { model: 'example-model', usage: { input: 2_000_000, cacheWrite: 0, cacheRead: 0, output: 0 } }), mk('b', { status: 'error' })), EXAMPLE_PRICES, true, 0)
    const r = recorder()
    drawHud(r.ctx, s, box, 1)
    const all = texts(r.ops).join(' | ')
    expect(all).toContain('1 working')
    expect(all).toContain('1 errors')
    expect(all).toContain('2M tokens')
    expect(all).toContain('~$2.00')
    expect(all).toContain('example prices')
  })
  test('no example marker for real prices', () => {
    const r = recorder()
    drawHud(r.ctx, summarize(office(mk('a')), EXAMPLE_PRICES, false, 0), box, 1)
    expect(texts(r.ops).join(' ')).not.toContain('example prices')
  })
  test('at most 3 chips, overflow is +N, chips carry a text label', () => {
    const waits = ['a', 'b', 'c', 'd', 'e'].map((s, i) => mk(s, { status: 'waiting', attention: { toolUseId: s, source: i === 0 ? 'heuristic' : 'hook', since: i } }))
    const r = recorder()
    const hits = drawHud(r.ctx, summarize(office(...waits), EXAMPLE_PRICES, false, 0), box, 1)
    expect(hits).toHaveLength(3)
    expect(hits.map((h) => h.key)).toEqual(['t:a:main', 't:b:main', 't:c:main'])
    const t = texts(r.ops)
    expect(t).toContain('+2')
    expect(t.some((x) => x.includes('maybe'))).toBe(true)
  })
  test('chips that do not fit are folded into +N, nothing is drawn past the box', () => {
    const waits = ['aaaa', 'bbbb'].map((s) => mk(s, { status: 'waiting', attention: { toolUseId: s, source: 'hook', since: 1 } }))
    const r = recorder()
    const narrow = { x: 0, y: 0, w: 700, h: 40 }
    const hits = drawHud(r.ctx, summarize(office(...waits), EXAMPLE_PRICES, false, 0), narrow, 1)
    for (const h of hits) expect(h.x + h.w).toBeLessThanOrEqual(narrow.w)
    expect(hits.length + Number((texts(r.ops).find((x) => /^\+\d+$/.test(x)) ?? '+0').slice(1))).toBe(2)
  })
  test('selected chip gets an outline', () => {
    const w = mk('a', { status: 'waiting', attention: { toolUseId: 'x', source: 'hook', since: 1 } })
    const strokes = (sel?: string) => {
      const r = recorder()
      drawHud(r.ctx, summarize(office(w), EXAMPLE_PRICES, false, 0), box, 1, sel)
      return r.ops.filter((o) => o.op === 'strokeRect').length
    }
    expect(strokes(w.key)).toBeGreaterThan(strokes())
  })
  test('markup in names stays text', () => {
    const r = recorder()
    drawHud(r.ctx, summarize(office(mk('x', { cwd: '/p/<img src=x onerror=1>', status: 'waiting', attention: { toolUseId: 'x', source: 'hook', since: 1 } })), EXAMPLE_PRICES, false, 0), box, 1)
    expect(r.ops.every((o) => o.op !== 'drawImage')).toBe(true)
  })
})

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0)
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [Math.max(lum(a), lum(b)), Math.min(lum(a), lum(b))]
  return (hi + 0.05) / (lo + 0.05)
}
describe('HUD contrast', () => {
  test.each(HUD_PAIRS.map((p) => [...p]))('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrast(fg as string, bg as string)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('ring contrast', () => {
  const cases = Object.entries(RING_COLOR).flatMap(([ring, color]) => FLOOR_TILES.map((floor) => [ring, color, floor]))
  test.each(cases)('%s ring %s on floor %s is at least 3:1', (_ring, color, floor) => {
    expect(contrast(color as string, floor as string)).toBeGreaterThanOrEqual(3)
  })
})

describe('drawHud hidden count', () => {
  const base = summarize(office(mk('a')), EXAMPLE_PRICES, true, 0)
  test('shows +N idle only when something is hidden', () => {
    const none = recorder()
    drawHud(none.ctx, base, box, 1)
    expect(texts(none.ops).join(' ')).not.toContain('idle')
    const some = recorder()
    drawHud(some.ctx, { ...base, hidden: 12 }, box, 1)
    expect(texts(some.ops)).toContain('+12 idle')
  })
  test('narrow boxes shorten it to +N and it still fits at 480 px', () => {
    const r = recorder()
    drawHud(r.ctx, { ...base, hidden: 12 }, { x: 0, y: 0, w: 480, h: 32 }, 1)
    for (const o of r.ops.filter((x) => x.op === 'fillText')) expect(Number(o.args[1]) + String(o.args[0]).length * 7).toBeLessThanOrEqual(480)
    expect(texts(r.ops).join(' ')).toMatch(/\+12/)
  })
  test('chips use the short numbered name', () => {
    const s = summarize(office(mk('a', { status: 'waiting', attention: { toolUseId: 'x', source: 'hook', since: 1 }, cwd: '/w/proj', startedAt: 1 }), mk('b', { cwd: '/w/proj', startedAt: 2 })), EXAMPLE_PRICES, true, 0)
    const r = recorder()
    drawHud(r.ctx, s, box, 1)
    expect(texts(r.ops)).toContain('proj #1')
  })
})
