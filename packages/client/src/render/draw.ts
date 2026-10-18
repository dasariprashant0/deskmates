import type { Dir, Frame, SpriteSheet } from '@deskmates/sprites'
import { clipBubble, type CharacterView, type Ring } from '../sim/character'
import { COLS, ROWS, TILE, VIEW_H, VIEW_W, type Furniture, type Layout } from '../sim/layout'
import { PAL, RING_COLOR } from './palette'

export type Bitmap = object
/** The slice of CanvasRenderingContext2D the renderer uses, so tests can record calls. */
export type Ctx2D = {
  fillStyle: string | object
  strokeStyle: string | object
  globalAlpha: number
  lineWidth: number
  font: string
  textAlign: string
  textBaseline: string
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void
  fill(): void
  stroke(): void
  setLineDash(segments: number[]): void
  fillText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
  drawImage(img: Bitmap, x: number, y: number): void
}

export type Sprites = { get(name: string): SpriteSheet }
export type BitmapCache = { get(name: string, anim: string, dir: Dir, frame: number, f: Frame): Bitmap }

export const BITMAP_CACHE_MAX = 500

/** Bounded: past BITMAP_CACHE_MAX entries the oldest inserted one is dropped (Map keeps insertion order). */
export const createBitmapCache = (makeBitmap: (f: Frame) => Bitmap): BitmapCache => {
  const m = new Map<string, Bitmap>()
  return {
    get(name, anim, dir, frame, f) {
      const k = `${name}|${anim}|${dir}|${frame}`
      let b = m.get(k)
      if (!b) {
        b = makeBitmap(f)
        if (m.size >= BITMAP_CACHE_MAX) {
          const oldest = m.keys().next()
          if (!oldest.done) m.delete(oldest.value)
        }
        m.set(k, b)
      }
      return b
    },
  }
}

const widths = new WeakMap<object, Map<string, number>>()
const WIDTHS_MAX = 2000
/** measureText memoised by font + text for this context (labels repeat every frame). */
export function measure(c: Ctx2D, text: string): number {
  let m = widths.get(c)
  if (!m) {
    m = new Map()
    widths.set(c, m)
  }
  const k = `${c.font}|${text}`
  let w = m.get(k)
  if (w === undefined) {
    if (m.size >= WIDTHS_MAX) m.clear()
    w = c.measureText(text).width
    m.set(k, w)
  }
  return w
}

const rect = (c: Ctx2D, color: string, x: number, y: number, w: number, h: number): void => {
  c.fillStyle = color
  c.fillRect(x, y, w, h)
}

export function drawFloor(c: Ctx2D): void {
  rect(c, PAL.bg, 0, 0, VIEW_W, VIEW_H)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (y < 2) rect(c, PAL.wall, x * TILE, y * TILE, TILE, TILE)
      else rect(c, (x + y) % 2 === 0 ? PAL.floorA : PAL.floorB, x * TILE, y * TILE, TILE, TILE)
    }
  }
  rect(c, PAL.wallTrim, 0, 2 * TILE - 2, VIEW_W, 2)
}

const drawOne = (c: Ctx2D, f: Furniture): void => {
  const x = f.x * TILE
  const y = f.y * TILE
  const w = f.w * TILE
  const h = f.h * TILE
  switch (f.kind) {
    case 'bookshelf': {
      rect(c, PAL.outline, x, y, w, h)
      rect(c, PAL.wood, x + 1, y + 1, w - 2, h - 2)
      for (let r = 0; r < 2; r++) {
        rect(c, PAL.woodLight, x + 2, y + r * 16 + 14, w - 4, 2)
        for (let i = 0; i < 9; i++) rect(c, PAL.books[(i + r * 3) % PAL.books.length] ?? PAL.accent, x + 3 + i * 6, y + r * 16 + 4 + (i % 3), 4, 10 - (i % 3))
      }
      break
    }
    case 'whiteboard':
      rect(c, PAL.outline, x + 2, y + 3, w - 4, h - 8)
      rect(c, PAL.paper, x + 3, y + 4, w - 6, h - 10)
      for (let i = 0; i < 3; i++) rect(c, i === 1 ? PAL.accent : PAL.textDim, x + 8, y + 9 + i * 6, w - 24 - i * 8, 2)
      rect(c, PAL.woodLight, x + 4, y + h - 5, w - 8, 2)
      break
    case 'webwall':
      rect(c, PAL.outline, x + 2, y + 3, w - 4, h - 7)
      rect(c, PAL.screen, x + 3, y + 4, w - 6, h - 9)
      for (let i = 0; i < 4; i++) rect(c, PAL.screenGlow, x + 8, y + 8 + i * 5, 14 + ((i * 17) % 40), 2)
      break
    case 'rack':
      rect(c, PAL.outline, x + 2, y + 2, w - 4, h - 3)
      rect(c, PAL.metalDark, x + 3, y + 3, w - 6, h - 5)
      for (let i = 0; i < 5; i++) {
        rect(c, PAL.metal, x + 5, y + 6 + i * 8, w - 10, 6)
        rect(c, i % 2 === 0 ? PAL.screenGlow : PAL.accent, x + 7, y + 8 + i * 8, 2, 2)
      }
      break
    case 'terminal':
      rect(c, PAL.outline, x + 2, y + 6, w - 4, h - 8)
      rect(c, PAL.screen, x + 4, y + 8, w - 8, h - 22)
      for (let i = 0; i < 4; i++) rect(c, PAL.screenGlow, x + 7, y + 11 + i * 5, 8 + ((i * 7) % 12), 2)
      rect(c, PAL.metal, x + 4, y + h - 12, w - 8, 8)
      break
    case 'desk':
      rect(c, PAL.outline, x, y + 4, w, h - 2)
      rect(c, PAL.woodLight, x + 1, y + 5, w - 2, h - 5)
      rect(c, PAL.wood, x + 1, y + h - 3, w - 2, 2)
      rect(c, PAL.outline, x + w / 2 - 7, y - 2, 14, 10)
      rect(c, PAL.screen, x + w / 2 - 6, y - 1, 12, 7)
      rect(c, PAL.screenGlow, x + w / 2 - 4, y + 1, 7, 1)
      rect(c, PAL.metal, x + w / 2 - 2, y + 8, 4, 2)
      break
    case 'bell':
      rect(c, PAL.outline, x, y + 4, w, h - 4)
      rect(c, PAL.wood, x + 1, y + 5, w - 2, h - 6)
      rect(c, PAL.accent, x + w / 2 - 4, y + 1, 8, 5)
      rect(c, PAL.text, x + w / 2 - 1, y - 1, 2, 2)
      break
    case 'coffee':
      rect(c, PAL.outline, x, y + 2, w, h - 2)
      rect(c, PAL.wood, x + 1, y + 3, w - 2, h - 4)
      rect(c, PAL.woodLight, x + 1, y + 3, w - 2, 3)
      rect(c, PAL.metalDark, x + 6, y - 6, 12, 14)
      rect(c, PAL.accent, x + 9, y - 2, 6, 3)
      rect(c, PAL.paper, x + 30, y + 6, 5, 5)
      break
    case 'door':
      rect(c, PAL.outline, x + 2, y + 2, w - 4, h - 2)
      rect(c, PAL.wood, x + 4, y + 4, w - 8, h - 4)
      rect(c, PAL.accent, x + w - 8, y + 9, 2, 2)
      break
    default:
      if (f.name.startsWith('plant')) {
        rect(c, PAL.wood, x + 3, y + h - 8, w - 6, 8)
        rect(c, PAL.leafDark, x + 2, y + 6, w - 4, h - 14)
        rect(c, PAL.leaf, x + 4, y + 3, w - 8, h - 12)
      } else {
        rect(c, PAL.woodLight, x + 1, y + 2, w - 2, h - 4)
        rect(c, PAL.sky, x + 3, y + 4, w - 6, h - 8)
        rect(c, PAL.woodLight, x + w / 2 - 1, y + 4, 2, h - 8)
      }
  }
}

export function drawFurniture(c: Ctx2D, layout: Layout): void {
  for (const f of layout.furniture) drawOne(c, f)
}

// ---- characters -------------------------------------------------------------------------------
const RING_SHAPE: Record<Exclude<Ring, 'idle'>, string> = {
  working: 'solid',
  thinking: 'dotted',
  'needs-you': 'double',
  error: 'x',
  done: 'check',
}

const line = (c: Ctx2D, pts: [number, number][]): void => {
  c.beginPath()
  pts.forEach(([x, y], i) => (i === 0 ? c.moveTo(x, y) : c.lineTo(x, y)))
  c.stroke()
}

/** Status ring on the floor plus a mark beside the head. Shape, not colour, tells statuses apart. */
export function drawRing(c: Ctx2D, ring: Ring, x: number, y: number): void {
  if (ring === 'idle') return
  c.strokeStyle = RING_COLOR[ring]
  c.fillStyle = RING_COLOR[ring]
  c.lineWidth = ring === 'working' ? 2 : 1
  const mx = x + 10
  const my = y - 20
  const ell = (rx: number, ry: number): void => {
    c.beginPath()
    c.ellipse(x, y - 1, rx, ry, 0, 0, Math.PI * 2)
    c.stroke()
  }
  switch (RING_SHAPE[ring]) {
    case 'solid':
      c.setLineDash([])
      ell(9, 4)
      break
    case 'dotted':
      c.setLineDash([1, 2])
      ell(9, 4)
      c.setLineDash([])
      break
    case 'double':
      c.setLineDash([])
      ell(9, 4)
      ell(11, 5)
      c.font = 'bold 9px monospace' // static: a blinking mark would fail WCAG 2.2.2
      c.textAlign = 'center'
      c.textBaseline = 'alphabetic'
      c.fillText('!', mx, my + 4)
      break
    case 'x':
      c.setLineDash([])
      c.lineWidth = 2
      line(c, [[mx - 3, my - 3], [mx + 3, my + 3]])
      line(c, [[mx + 3, my - 3], [mx - 3, my + 3]])
      break
    case 'check':
      c.setLineDash([])
      c.lineWidth = 2
      line(c, [[mx - 4, my], [mx - 1, my + 3], [mx + 4, my - 3]])
      break
  }
  c.lineWidth = 1
}

const SPRITE_W = 16
const SPRITE_H = 24
const MARGIN = 2
const TAG_H = 9
/** Vertical step between label candidates, in view px; equal to TAG_H so stacked tags touch but never overlap. */
const STEP = 9
export const MAX_BUBBLES = 6

export type DrawOpts = { selectedKey?: string; hoveredKey?: string }
type Rect = { x: number; y: number; w: number; h: number }
type Label = { r: Rect; text: string; bg: string; fg: string; alpha: number }
const hit = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const clampX = (cx: number, w: number): number => Math.max(MARGIN, Math.min(Math.round(cx - w / 2), VIEW_W - MARGIN - w))
const BASE = (by: number): number => by - 7 // rect top for a text baseline

/** The '#n' of a numbered tag, else the first two letters of the name. */
const badgeText = (v: CharacterView): string => {
  const m = /#(\d+)$/.exec(v.short ?? '')
  return m ? `#${m[1]}` : Array.from(v.name).slice(0, 2).join('').toUpperCase()
}

const isLiveRing = (v: CharacterView): boolean => v.ring === 'working' || v.ring === 'thinking'

/** At most MAX_BUBBLES bubbles: live characters and the selected one; the rest are dropped farthest-from-selection first. */
function bubbleKeys(views: readonly CharacterView[], selectedKey: string | undefined): Set<string> {
  const sel = views.find((v) => v.key === selectedKey)
  const pool = views.filter((v) => v.bubble && v !== sel && isLiveRing(v))
  const d = (v: CharacterView): number => (sel ? Math.hypot(v.x - sel.x, v.y - sel.y) : 0)
  pool.sort((a, b) => d(a) - d(b) || b.y - a.y || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const keep = pool.slice(0, MAX_BUBBLES - (sel?.bubble ? 1 : 0))
  if (sel?.bubble) keep.push(sel)
  return new Set(keep.map((v) => v.key))
}

/**
 * Places every label in one pass over `sorted` (y, then x). A tag goes above the head; when that collides it tries
 * three steps higher, then below the feet, and finally shrinks to a '#n' badge that searches further (or is skipped).
 * Selected and hovered characters are placed first, always get their full text, and are drawn last, on top.
 */
function layoutLabels(c: Ctx2D, sorted: readonly CharacterView[], o: DrawOpts): Label[] {
  c.font = '8px monospace'
  const placed: Rect[] = []
  const rest: Label[] = []
  const top: Label[] = []
  const bubbles = bubbleKeys(sorted, o.selectedKey)
  const rectFor = (text: string, cx: number, by: number): Rect => {
    const w = Math.ceil(measure(c, text)) + 4
    return { x: clampX(cx, w), y: BASE(by), w, h: TAG_H }
  }
  const free = (r: Rect): boolean => r.y >= 0 && r.y + r.h <= VIEW_H && !placed.some((p) => hit(p, r))
  const first = (text: string, cx: number, bys: number[]): Rect | undefined => {
    for (const by of bys) {
      const r = rectFor(text, cx, by)
      if (free(r)) return r
    }
    return undefined
  }
  const add = (out: Label[], r: Rect, text: string, bg: string, fg: string, alpha: number): void => {
    placed.push(r)
    out.push({ r, text, bg, fg, alpha })
  }
  const place = (v: CharacterView, focus: boolean): void => {
    const x = Math.round(v.x)
    const y = Math.round(v.y)
    const out = focus ? top : rest
    const head = y - SPRITE_H - 1
    const text = v.short ?? v.name
    let tag = first(text, x, [head, head - STEP, head - 2 * STEP, head - 3 * STEP, y + 11])
    let shown: Rect | undefined
    if (tag) shown = tag
    else if (focus) {
      tag = rectFor(text, x, head)
      tag.y = Math.max(0, Math.min(tag.y, VIEW_H - TAG_H))
      shown = tag
    } else {
      const b = badgeText(v)
      const far = [head, ...Array.from({ length: 9 }, (_, i) => head - (i + 1) * STEP), ...Array.from({ length: 5 }, (_, i) => y + 11 + i * STEP)]
      const br = first(b, x, far)
      if (br) {
        add(out, br, b, PAL.tagBg, PAL.text, v.fade)
        return
      }
    }
    if (shown) add(out, shown, text, PAL.tagBg, PAL.text, v.fade)
    if (v.bubble && bubbles.has(v.key)) {
      const bt = clipBubble(v.bubble)
      const above = (shown ? shown.y : head - 6) - 3
      const bys = [above, above - STEP, above - 2 * STEP, y + 14, y + 14 + STEP, y + 14 + 2 * STEP]
      let r = first(bt, x, bys)
      if (!r && v.key === o.selectedKey) {
        r = rectFor(bt, x, above)
        r.y = Math.max(0, Math.min(r.y, VIEW_H - TAG_H))
      }
      if (r) add(out, r, bt, PAL.bubbleBg, PAL.bubbleText, v.fade)
    }
  }
  const focusKeys = [o.selectedKey, o.hoveredKey]
  const focus = new Set<string>()
  for (const k of focusKeys) {
    const v = sorted.find((q) => q.key === k)
    if (v && !focus.has(v.key)) {
      focus.add(v.key)
      place(v, true)
    }
  }
  for (const v of sorted) if (!focus.has(v.key)) place(v, false)
  return [...rest, ...top]
}

function drawLabels(c: Ctx2D, sorted: readonly CharacterView[], o: DrawOpts): void {
  if (sorted.length === 0) return
  const labels = layoutLabels(c, sorted, o)
  if (labels.length === 0) return
  c.font = '8px monospace'
  c.textAlign = 'center'
  c.textBaseline = 'alphabetic'
  for (const l of labels) {
    c.globalAlpha = l.alpha
    rect(c, l.bg, l.r.x, l.r.y, l.r.w, l.r.h)
    c.fillStyle = l.fg
    c.fillText(l.text, l.r.x + l.r.w / 2, l.r.y + 7)
  }
  c.globalAlpha = 1
}

/** Corner brackets around the sprite: a shape, not only a colour, marks the selection. */
function drawSelection(c: Ctx2D, x: number, y: number): void {
  const l = x - 10
  const r = x + 9
  const t = y - 27
  const b = y + 3
  for (const [cx, cy, dx, dy] of [[l, t, 1, 1], [r, t, -1, 1], [l, b, 1, -1], [r, b, -1, -1]] as const) {
    rect(c, PAL.accent, dx > 0 ? cx : cx - 3, cy, 4, 1)
    rect(c, PAL.accent, cx, dy > 0 ? cy : cy - 3, 1, 4)
  }
}

function drawBody(c: Ctx2D, v: CharacterView, sprites: Sprites, cache: BitmapCache, o: DrawOpts): void {
  const x = Math.round(v.x)
  const y = Math.round(v.y)
  c.globalAlpha = v.fade
  c.fillStyle = PAL.shadow
  c.beginPath()
  c.ellipse(x, y - 1, 6, 2.5, 0, 0, Math.PI * 2)
  c.fill()
  drawRing(c, v.ring, x, y)
  const look = v.look ?? v.name
  const frames = sprites.get(look).frames[`${v.anim}:${v.dir}`]
  const f = frames?.[v.frame % (frames.length || 1)]
  if (f) c.drawImage(cache.get(look, v.anim, v.dir, v.frame, f), x - SPRITE_W / 2, y - SPRITE_H + 1)
  if (o.selectedKey !== undefined && o.selectedKey === v.key) drawSelection(c, x, y)
  c.globalAlpha = 1
}

export function drawCharacter(c: Ctx2D, v: CharacterView, sprites: Sprites, cache: BitmapCache, o: DrawOpts = {}): void {
  drawBody(c, v, sprites, cache, o)
  drawLabels(c, [v], o)
}

/** Bodies back to front, then all labels on top so no sprite covers a name or bubble. */
export function drawCharacters(c: Ctx2D, views: readonly CharacterView[], sprites: Sprites, cache: BitmapCache, o: DrawOpts = {}): void {
  const sorted = [...views].sort((a, b) => a.y - b.y || a.x - b.x)
  for (const v of sorted) drawBody(c, v, sprites, cache, o)
  drawLabels(c, sorted, o)
}

export function drawScene(c: Ctx2D, layout: Layout, views: readonly CharacterView[], sprites: Sprites, cache: BitmapCache, o: DrawOpts = {}): void {
  drawFloor(c)
  drawFurniture(c, layout)
  drawCharacters(c, views, sprites, cache, o)
}
