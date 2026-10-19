import { VIEW_H, VIEW_W } from '../sim'
import type { Fit } from './fit'

/** Compact (phone, or 200-400% zoom) layout applies strictly below this CSS width. */
export const COMPACT_MAX_W = 640
/** Compact HUD strip: a 44 CSS px target row. */
export const COMPACT_HUD_H = 44
/** Aim for a crop about this many view px wide; the real width fills the box at the chosen integer scale. */
const TARGET_CROP_W = 160
/** Focus sits this far above the feet so the sprite and its name tag are centred, not just the shoes. */
const FOCUS_LIFT = 10

export const isCompact = (cssWidth: number): boolean => cssWidth < COMPACT_MAX_W

/** Never crop to less than this many CSS px tall, however big the sheet or small the window. */
const MIN_BOX_H = 96

/** CSS height of the area the crop is really seen in: above the HUD strip and above any open bottom sheet (the card). */
export const visibleBoxHeight = (clientH: number, hudH: number, sheetH: number): number =>
  Math.max(MIN_BOX_H, clientH - hudH - (Number.isFinite(sheetH) && sheetH > 0 ? sheetH : 0))

/** Source rect in view px (whole numbers) and destination rect in device px; `scale` is device px per view px. */
export type Camera = { srcX: number; srcY: number; srcW: number; srcH: number; x: number; y: number; w: number; h: number; scale: number }

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))

/**
 * Crop of the offscreen view, centred on `focus`, at the largest integer scale that makes ~160 view px fill the box width.
 * `box` is CSS px, the result is in device px. No easing: it snaps to whole view px, so there is nothing to disable for reduced motion.
 */
export function compactCamera(box: { w: number; h: number }, focus: { x: number; y: number }, dpr: number): Camera {
  const bw = Math.max(1, Math.floor(box.w * dpr))
  const bh = Math.max(1, Math.floor(box.h * dpr))
  const scale = Math.max(1, Math.floor(bw / TARGET_CROP_W))
  const srcW = Math.min(VIEW_W, Math.max(1, Math.floor(bw / scale)))
  const srcH = Math.min(VIEW_H, Math.max(1, Math.floor(bh / scale)))
  const fx = Number.isFinite(focus.x) ? focus.x : VIEW_W / 2
  const fy = Number.isFinite(focus.y) ? focus.y : VIEW_H / 2
  const srcX = clamp(Math.round(fx - srcW / 2), 0, VIEW_W - srcW)
  const srcY = clamp(Math.round(fy - srcH / 2), 0, VIEW_H - srcH)
  const w = srcW * scale
  const h = srcH * scale
  return { srcX, srcY, srcW, srcH, x: Math.max(0, Math.floor((bw - w) / 2)), y: Math.max(0, Math.floor((bh - h) / 2)), w, h, scale }
}

/** The whole view, from the normal letterboxed fit, in the same shape so drawing and picking share one path. */
export const fullCamera = (f: Fit): Camera => ({ srcX: 0, srcY: 0, srcW: VIEW_W, srcH: VIEW_H, x: f.x, y: f.y, w: f.w, h: f.h, scale: f.scale })

/** View-space point -> device pixel on the canvas. */
export const viewToScreen = (c: Camera, p: { x: number; y: number }): { x: number; y: number } => ({ x: c.x + (p.x - c.srcX) * c.scale, y: c.y + (p.y - c.srcY) * c.scale })

/** Device pixel on the canvas -> view-space point (inverse of `viewToScreen`). */
export const screenToView = (c: Camera, px: number, py: number): { x: number; y: number } => ({ x: c.srcX + (px - c.x) / c.scale, y: c.srcY + (py - c.y) / c.scale })

/** Who the compact camera follows: the selected agent, else the oldest needs-you agent, else the first visible one, else the view centre. */
export function compactFocus(chars: readonly { key: string; x: number; y: number; fade: number }[], selectedKey: string | undefined, needsYouKeys: readonly string[]): { x: number; y: number } {
  const visible = chars.filter((c) => c.fade > 0.05)
  const by = (k: string | undefined) => (k === undefined ? undefined : visible.find((c) => c.key === k))
  const c = by(selectedKey) ?? needsYouKeys.map(by).find((x) => x !== undefined) ?? visible[0]
  return c ? { x: c.x, y: c.y - FOCUS_LIFT } : { x: VIEW_W / 2, y: VIEW_H / 2 }
}
