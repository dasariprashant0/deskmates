import type { Ring } from '../sim/character'

/** Warm office palette (night variant from docs/DESIGN.md plus a few furniture accents). */
export const PAL = {
  bg: '#1b1a2e',
  floorA: '#2c2a46',
  floorB: '#302d4c',
  wall: '#3a3758',
  wallTrim: '#4a4670',
  wood: '#6b4a3a',
  woodLight: '#9a7b62',
  text: '#f1ead8',
  textDim: '#a9a3c2',
  accent: '#ffb454',
  outline: '#0d0c1a',
  paper: '#f1ead8',
  screen: '#142033',
  screenGlow: '#5fd0a0',
  sky: '#7fb3d5',
  leaf: '#4f8f4a',
  leafDark: '#37693a',
  metal: '#55536f',
  metalDark: '#2a2940',
  shadow: 'rgba(13,12,26,0.45)',
  tagBg: 'rgba(13,12,26,0.78)',
  bubbleBg: '#f1ead8',
  bubbleText: '#1b1a2e',
  books: ['#d55e00', '#0072b2', '#e69f00', '#cc79a7', '#009e73', '#f0e442'],
} as const

/** Both floor tile colours; ring colours need >= 3:1 against each (WCAG 1.4.11, asserted in test/render/hud.test.ts). */
export const FLOOR_TILES: readonly string[] = [PAL.floorA, PAL.floorB]

/** Okabe-Ito status colours (working lightened from #0072B2 to reach 3:1 on the floor); every status also has its own shape in draw.ts. */
export const RING_COLOR: Record<Exclude<Ring, 'idle'>, string> = {
  working: '#2B8FCB',
  thinking: '#CC79A7',
  'needs-you': '#E69F00',
  error: '#D55E00',
  done: '#009E73',
}

/** HUD text/background pairs; test/render/hud.test.ts asserts WCAG contrast >= 4.5 for each. */
export const HUD = {
  bg: '#0d0c1a',
  text: '#f1ead8',
  dim: '#a9a3c2',
  chipBg: '#E69F00',
  chipText: '#0d0c1a',
  edge: '#4a4670',
} as const
export const HUD_PAIRS: readonly (readonly [string, string])[] = [
  [HUD.text, HUD.bg],
  [HUD.dim, HUD.bg],
  [HUD.chipText, HUD.chipBg],
]
