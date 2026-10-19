import { describe, expect, test } from 'vitest'
import { COMPACT_MAX_W, COMPACT_HUD_H, compactCamera, compactFocus, fullCamera, isCompact, screenToView, viewToScreen, visibleBoxHeight } from '../../src/render/compact'
import { fitScale } from '../../src/render/fit'
import { VIEW_H, VIEW_W } from '../../src/sim'

const ch = (key: string, x: number, y: number, fade = 1) => ({ key, x, y, fade })

describe('isCompact', () => {
  test('strictly below 640 css px', () => {
    expect(COMPACT_MAX_W).toBe(640)
    expect(isCompact(639)).toBe(true)
    expect(isCompact(639.9)).toBe(true)
    expect(isCompact(640)).toBe(false)
    expect(isCompact(1280)).toBe(false)
  })
  test('HUD strip is a 44 px target in compact', () => expect(COMPACT_HUD_H).toBe(44))
})

describe('compactCamera', () => {
  const box = (w: number, h = 700) => ({ w, h })
  test.each([320, 360, 375, 390, 414, 639])('scale >= 2 and integer at %i css px, dpr 1/2/3', (w) => {
    for (const dpr of [1, 2, 3]) {
      const c = compactCamera(box(w), { x: 160, y: 90 }, dpr)
      expect(c.scale).toBeGreaterThanOrEqual(2)
      expect(Number.isInteger(c.scale)).toBe(true)
      expect(c.w).toBe(c.srcW * c.scale)
      expect(c.w).toBeLessThanOrEqual(Math.floor(w * dpr))
      expect(Math.floor(w * dpr) - c.w).toBeLessThan(c.scale) // fills the width to within one view px
    }
  })
  test('crop is about 160 view px wide on a phone', () => {
    const c = compactCamera(box(360), { x: 160, y: 90 }, 1)
    expect(c.srcW).toBe(180)
    expect(compactCamera(box(320), { x: 160, y: 90 }, 1).srcW).toBe(160)
  })
  test('centres on the focus when there is room, snapped to whole view px', () => {
    const c = compactCamera(box(320), { x: 150.4, y: 90.6 }, 1)
    expect(c.srcX).toBe(70) // round(150.4 - 80)
    expect(Number.isInteger(c.srcX) && Number.isInteger(c.srcY)).toBe(true)
  })
  test('clamps at all four edges', () => {
    const b = box(320, 100) // 50 view px tall at scale 2
    expect(compactCamera(b, { x: 0, y: 0 }, 1)).toMatchObject({ srcX: 0, srcY: 0 })
    const br = compactCamera(b, { x: VIEW_W, y: VIEW_H }, 1)
    expect(br.srcX).toBe(VIEW_W - br.srcW)
    expect(br.srcY).toBe(VIEW_H - br.srcH)
    expect(compactCamera(b, { x: VIEW_W, y: 0 }, 1)).toMatchObject({ srcX: VIEW_W - 160, srcY: 0 })
    expect(compactCamera(b, { x: 0, y: VIEW_H }, 1)).toMatchObject({ srcX: 0, srcY: VIEW_H - 50 })
  })
  test('the crop never leaves the view, for wild focus points and boxes', () => {
    for (const w of [200, 320, 480, 639]) for (const h of [60, 300, 900]) for (const dpr of [1, 1.5, 2, 3]) for (const f of [{ x: -50, y: -50 }, { x: 999, y: 999 }, { x: 160, y: 90 }, { x: NaN, y: NaN }]) {
      const c = compactCamera({ w, h }, f, dpr)
      expect(c.srcX).toBeGreaterThanOrEqual(0)
      expect(c.srcY).toBeGreaterThanOrEqual(0)
      expect(c.srcX + c.srcW).toBeLessThanOrEqual(VIEW_W)
      expect(c.srcY + c.srcH).toBeLessThanOrEqual(VIEW_H)
      expect(c.x).toBeGreaterThanOrEqual(0)
      expect(c.y).toBeGreaterThanOrEqual(0)
    }
  })
  test('destination is centred in the box when the crop is shorter', () => {
    const c = compactCamera({ w: 320, h: 400 }, { x: 160, y: 90 }, 1)
    expect(c.h).toBe(c.srcH * 2)
    expect(c.y).toBe(Math.floor((400 - c.h) / 2))
  })
})

describe('screen <-> view', () => {
  test('round trips within a pixel, through the crop and the full view', () => {
    const cams = [compactCamera({ w: 375, h: 700 }, { x: 40, y: 150 }, 2), compactCamera({ w: 320, h: 500 }, { x: 300, y: 20 }, 3), fullCamera(fitScale(VIEW_W, VIEW_H, 1000, 700, 1))]
    for (const cam of cams) for (const p of [{ x: cam.srcX + 1, y: cam.srcY + 1 }, { x: cam.srcX + cam.srcW / 2, y: cam.srcY + cam.srcH / 2 }, { x: cam.srcX + cam.srcW - 1, y: cam.srcY + cam.srcH - 1 }]) {
      const s = viewToScreen(cam, p)
      const b = screenToView(cam, s.x, s.y)
      expect(Math.abs(b.x - p.x)).toBeLessThan(1)
      expect(Math.abs(b.y - p.y)).toBeLessThan(1)
    }
  })
  test('full camera maps like the old fit transform', () => {
    const f = fitScale(VIEW_W, VIEW_H, 1000, 700, 1)
    expect(screenToView(fullCamera(f), f.x + f.scale * 10, f.y + f.scale * 20)).toEqual({ x: 10, y: 20 })
  })
  test('a click on the crop corner lands on the crop corner in view space', () => {
    const c = compactCamera({ w: 320, h: 500 }, { x: 100, y: 100 }, 1)
    expect(screenToView(c, c.x, c.y)).toEqual({ x: c.srcX, y: c.srcY })
  })
})

describe('compactFocus', () => {
  const chars = [ch('a', 10, 50), ch('b', 200, 120), ch('c', 300, 60)]
  const centre = { x: VIEW_W / 2, y: VIEW_H / 2 }
  test('selected wins over needs-you', () => {
    expect(compactFocus(chars, 'b', ['c'])).toMatchObject({ x: 200 })
  })
  test('else the oldest needs-you agent (first in the list)', () => {
    expect(compactFocus(chars, undefined, ['c', 'b'])).toMatchObject({ x: 300 })
  })
  test('else the first visible character, skipping faded ones', () => {
    expect(compactFocus([ch('z', 5, 5, 0), ...chars], undefined, [])).toMatchObject({ x: 10 })
  })
  test('else the view centre', () => {
    expect(compactFocus([], undefined, [])).toEqual(centre)
  })
  test('unknown selected or needs-you keys fall through to the next rule', () => {
    expect(compactFocus(chars, 'gone', ['c'])).toMatchObject({ x: 300 })
    expect(compactFocus(chars, 'gone', ['nope'])).toMatchObject({ x: 10 })
  })
  test('focus sits a little above the feet so sprite and tag are centred', () => {
    expect(compactFocus(chars, 'a', []).y).toBeLessThan(50)
  })
})

describe('visibleBoxHeight', () => {
  test('is the area above the HUD when no sheet is open', () => {
    expect(visibleBoxHeight(812, 44, 0)).toBe(768)
  })
  test('excludes an open bottom sheet so the focus is centred in what is actually visible', () => {
    expect(visibleBoxHeight(812, 44, 400)).toBe(368)
  })
  test('never collapses below a usable minimum, even for a huge sheet or tiny window', () => {
    expect(visibleBoxHeight(568, 44, 900)).toBe(96)
    expect(visibleBoxHeight(50, 44, 0)).toBe(96)
  })
  test('bad sheet heights count as no sheet', () => {
    expect(visibleBoxHeight(812, 44, Number.NaN)).toBe(768)
    expect(visibleBoxHeight(812, 44, -10)).toBe(768)
  })
})
