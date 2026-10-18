import type { CharacterView } from '../sim/character'
import type { Fit } from './fit'

const HALF_W = 8
const TOP = 24
const BELOW = 2

/** Device pixel -> 320x176 view coordinate, using the same transform the blit used. */
export const toView = (f: Fit, px: number, py: number): { x: number; y: number } => ({ x: (px - f.x) / f.scale, y: (py - f.y) / f.scale })

const MIN_CSS = 24

/** View-space size of a 24x24 CSS px box: `scale` is device px per view px, `dpr` device px per CSS px. */
export const minBoxView = (scale: number, dpr: number): number => (MIN_CSS * dpr) / Math.max(1, scale)

/** Real pointer clicks only: Enter on a focused canvas can fire a synthetic click (detail 0) at the centre. */
export const isPointerClick = (e: { detail: number; clientX: number; clientY: number }): boolean => e.detail > 0 && !(e.clientX === 0 && e.clientY === 0)

/**
 * Key of the character under a view-space point; the one drawn last (largest y) wins.
 * `minBox` (view px) is the smallest hit box edge: the sprite box grows around its centre to reach it.
 */
export function pickCharacter(chars: readonly CharacterView[], x: number, y: number, minBox = 0): string | undefined {
  const halfW = Math.max(HALF_W, minBox / 2)
  const grow = Math.max(0, minBox - (TOP + BELOW)) / 2
  let best: CharacterView | undefined
  for (const c of chars) {
    if (c.fade <= 0.05) continue
    if (Math.abs(x - c.x) > halfW || y < c.y - TOP - grow || y > c.y + BELOW + grow) continue
    if (!best || c.y >= best.y) best = c
  }
  return best?.key
}
