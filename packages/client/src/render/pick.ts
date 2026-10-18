import type { CharacterView } from '../sim/character'
import type { Fit } from './fit'

const HALF_W = 8
const TOP = 24
const BELOW = 2

/** Device pixel -> 320x176 view coordinate, using the same transform the blit used. */
export const toView = (f: Fit, px: number, py: number): { x: number; y: number } => ({ x: (px - f.x) / f.scale, y: (py - f.y) / f.scale })

/** Key of the character under a view-space point; the one drawn last (largest y) wins. */
export function pickCharacter(chars: readonly CharacterView[], x: number, y: number): string | undefined {
  let best: CharacterView | undefined
  for (const c of chars) {
    if (c.fade <= 0.05) continue
    if (Math.abs(x - c.x) > HALF_W || y < c.y - TOP || y > c.y + BELOW) continue
    if (!best || c.y >= best.y) best = c
  }
  return best?.key
}
