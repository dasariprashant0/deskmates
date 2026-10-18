// Part templates. Everything here is plain data so the art is easy to edit.
//
// Template characters: 'o' = ramp base, 's' = ramp shadow, 'h' = ramp highlight,
// '.' or ' ' = transparent, anything else = a named extra colour (see generate.ts):
//   e eye, f glasses frame, g dark frame/band, c accent, d ground shadow, k coffee, B book cover, w paper.
//
// Coordinates live in the inner 14x22 area. Head-relative layers (hair, face, caps...) are
// placed from the head's top-left corner (HX, HY); x and y may be negative for hair that
// rises above or spreads beside the head.

export type Layer = { x?: number; y: number; rows: readonly string[] }
export type View = 'down' | 'up' | 'left'

export const W = 16 // frame size; the character is drawn inside the inner area so the outline fits
export const H = 24
export const INNER_W = W - 2
export const INNER_H = H - 2
export const TORSO_H = 6
export const ARM_H = 5
export const HX = 3 // head left edge (head is 8 wide, columns 3..10)
export const HY = 3 // head top row (head is 6 tall)
export const NECK_Y = 9
export const TORSO_Y = 10 // torso is 6 rows, 10..15
export const LEG_TOP = 16 // pants start; 3 pants rows then 2 shoe rows, ends row 20
export const SHADOW_Y = 21

const L = (y: number, rows: readonly string[], x = 0): Layer => ({ x, y, rows })
const R = (s: string, n: number): string[] => Array.from({ length: n }, () => s)
const H8 = 'oooooooo'

// --- head, face -------------------------------------------------------------------------
//                           col: 01234567
export const HEAD: Layer = L(0, ['.hooooo.', 'oooooooo', 'ooooooos', 'ooooooos', '.ooooss.', '..ssss..'])
// face skin (brow to chin) is drawn over hair-back so long hair never covers the face. Eyes are placed in code.
export const FACE: Record<View, Layer | undefined> = {
  down: L(1, ['.oooooo.', '.oooooo.', '.oooooo.', '.ooooss.', '..ssss..']),
  up: undefined,
  left: L(1, ['.ooooo..', 'oooooo..', 'oooooo..', '.oooos..', '..ss....']),
}
export const NOSE_LEFT: Layer = L(3, ['o'], -1)
/** Eye columns (head-relative) and row. */
export const EYES: Record<View, { cols: readonly number[]; row: number } | undefined> = {
  down: { cols: [2, 5], row: 2 },
  up: undefined,
  left: { cols: [2], row: 2 },
}
export const NECK: Layer = L(NECK_Y, ['oo'], 6)

// --- quirks -----------------------------------------------------------------------------
/** Single cheek pixel for freckle/blush (head-relative). */
export const CHEEK: Record<View, readonly [number, number] | undefined> = {
  down: [1, 3],
  up: undefined,
  left: [1, 3],
}
/** Beard shapes, drawn in the hair colour. */
export const BEARD: Record<View, Layer | undefined> = {
  down: L(3, ['.o....o.', '.oooooo.', '..oooo..']),
  up: undefined,
  left: L(3, ['oo......', '.oooo...', '..oo....']),
}

// --- hair -------------------------------------------------------------------------------
export type HairView = { back?: Layer; front?: Layer }
export type HairStyle = { name: string; down: HairView; up: HairView; left: HairView }

const LONG_FRONT = L(0, ['.hooooo.', 'oooooooo', 'oo....oo'])
const SIDE_FRONT = L(0, ['.hooooo.', '.ooooooo', '..oo.ooo'])

export const HAIR_STYLES: readonly HairStyle[] = [
  {
    name: 'buzz',
    down: { front: L(0, ['.hooooo.', 'o......o']) },
    up: { back: L(0, ['.hooooo.', ...R(H8, 3)]) },
    left: { front: L(0, ['.hooooo.', '....oooo']) },
  },
  {
    name: 'short',
    down: { front: L(0, ['.hooooo.', 'oo.ooooo', 'o......o']) },
    up: { back: L(0, ['.hooooo.', ...R(H8, 4)]) },
    left: { front: L(0, ['.hooooo.', '.ooooooo', '....oooo']), back: L(1, R('....oooo', 3)) },
  },
  {
    name: 'long',
    down: { front: LONG_FRONT, back: L(1, [...R(H8, 5), 'oo....oo', 'oo....oo']) },
    up: { back: L(0, ['.hooooo.', ...R(H8, 6), H8, '.oooooo.']) },
    left: { front: SIDE_FRONT, back: L(1, [...R('..oooooo', 5), '...ooooo', '....oooo']) },
  },
  {
    name: 'bob',
    down: { front: LONG_FRONT, back: L(1, [...R(H8, 4), 'oo....oo']) },
    up: { back: L(0, ['.hooooo.', ...R(H8, 5), '.oooooo.']) },
    left: { front: SIDE_FRONT, back: L(1, R('..oooooo', 5)) },
  },
  {
    name: 'spiky',
    down: { front: L(-1, ['.o.oo.o.', '.hooooo.', 'oo.oo.oo', 'o......o']) },
    up: { back: L(-1, ['.o.oo.o.', '.hooooo.', ...R(H8, 4), '.oooooo.']) },
    left: { front: L(-1, ['.o.oo.o.', '.hooooo.', '.ooooooo', '....oooo']) },
  },
  {
    name: 'mohawk',
    down: { front: L(-1, ['...hh...', '...oo...', '...oo...']) },
    up: { back: L(-1, ['...hh...', '...oo...', ...R('..oooo..', 5)]) },
    left: { front: L(-1, ['...hh...', '...oo...', '...oo...']) },
  },
  {
    name: 'curly',
    down: {
      front: L(0, ['.hooooo.', 'o.o..o.o']),
      back: L(-1, ['..hooooo..', '.oooooooo.', ...R('oooooooooo', 5), 'oo......oo'], -1),
    },
    up: { back: L(-1, ['..hooooo..', '.oooooooo.', ...R('oooooooooo', 5), '.oooooooo.'], -1) },
    left: {
      front: L(0, ['.hooooo.', '.o.o.ooo']),
      back: L(-1, ['..hooooo..', '.oooooooo.', ...R('oooooooooo', 5)], -1),
    },
  },
  {
    name: 'ponytail',
    down: { front: L(0, ['.hooooo.', 'oooooooo', 'o......o']), back: L(1, ['......oo', '.......o']) },
    up: { back: L(0, ['.hooooo.', ...R(H8, 4), '...oo...', '...oo...', '...oo...']) },
    left: {
      front: L(0, ['.hooooo.', '.ooooooo', '..o..ooo']),
      back: L(1, ['..oooooo..', '..oooooo..', '...ooooooo', '.....oo.oo', '........oo', '........o.']),
    },
  },
  {
    name: 'swoop',
    down: { front: L(0, ['.hooooo.', 'oooooooo', 'oo.....o']) },
    up: { back: L(0, ['.hooooo.', ...R(H8, 4)]) },
    left: { front: L(0, ['.hooooo.', 'oooooooo', 'oo....oo']) },
  },
  {
    name: 'bun',
    down: { front: L(-2, ['...oo...', '..hooo..', '.hooooo.', 'oooooooo', 'o......o']) },
    up: { back: L(-2, ['...oo...', '..hooo..', '.hooooo.', ...R(H8, 4)]) },
    left: { front: L(-2, ['....oo..', '...hooo.', '.hooooo.', '.ooooooo', '....oooo']) },
  },
]

/** Drop rows above the head (used under a cap so spikes and buns do not poke through). */
export const clipAboveHead = (l: Layer | undefined): Layer | undefined => {
  if (!l || l.y >= 0) return l
  const cut = -l.y
  return { x: l.x ?? 0, y: 0, rows: l.rows.slice(cut) }
}

// --- torso, outfits ---------------------------------------------------------------------
/** Core width (between the arms). Torso total width is core + 2 arm columns. */
export const BUILDS = [{ core: 4 }, { core: 6 }, { core: 8 }] as const

export type Outfit = { name: string; sleeve: number; core: (row: number, c: number) => string }
const rep = (ch: string, n: number) => ch.repeat(n)
export const OUTFITS: readonly Outfit[] = [
  { name: 'tee', sleeve: 2, core: (r, c) => (r === 0 ? rep('h', c) : r === 5 ? rep('s', c) : rep('o', c)) },
  {
    name: 'hoodie',
    sleeve: 4,
    core: (r, c) => (r === 0 ? rep('h', c) : r === 4 ? `o${rep('s', c - 2)}o` : r === 5 ? rep('s', c) : rep('o', c)),
  },
  {
    name: 'jacket',
    sleeve: 4,
    core: (r, c) => (r === 0 ? rep('h', c) : `${rep('o', c / 2 - 1)}ss${rep('o', c / 2 - 1)}`),
  },
  { name: 'stripes', sleeve: 2, core: (r, c) => rep(r % 2 === 0 ? 'h' : 'o', c) },
  { name: 'belted', sleeve: 2, core: (r, c) => (r === 0 ? rep('h', c) : r === 3 ? rep('s', c) : rep('o', c)) },
  { name: 'vest', sleeve: 0, core: (r, c) => (r === 0 ? rep('h', c) : `s${rep('o', c - 2)}s`) },
]

// --- legs -------------------------------------------------------------------------------
export const PANTS_FRONT = 'os'
export const SHOE_FRONT: readonly string[] = ['oo', 'os']
export const PANTS_SIDE = 'oo'
export const SHOE_SIDE: Layer = L(0, ['oo', 'ooo'], -1) // toe pokes one pixel to the left
export const GROUND_SHADOW: Layer = L(SHADOW_Y, ['dddddd'], 4)

// --- accessories ------------------------------------------------------------------------
export const ACCESSORIES = ['none', 'glasses', 'headphones', 'cap', 'scarf', 'mug', 'badge'] as const
export type Accessory = (typeof ACCESSORIES)[number]

export const GLASSES: Record<View, Layer | undefined> = {
  down: L(2, ['f....f', '.f..f.'], 1),
  up: undefined,
  left: L(2, ['f...f', '.f...'], 1),
}
export const HEADPHONES: Record<View, { band: readonly Layer[]; cups: readonly Layer[] }> = {
  down: { band: [L(0, ['gggggggg'])], cups: [L(1, ['c', 'c'], -1), L(1, ['c', 'c'], 8)] },
  up: { band: [L(0, ['gggggggg'])], cups: [L(1, ['c', 'c'], -1), L(1, ['c', 'c'], 8)] },
  left: { band: [L(0, ['gggggggg'])], cups: [L(2, ['cc', 'cc'], 3)] },
}
export const CAP: Record<View, readonly Layer[]> = {
  down: [L(-1, ['.hooooo.', 'oooooooo', 'ssssssss'])],
  up: [L(-1, ['.hooooo.', ...R(H8, 2), '.oooooo.'])],
  left: [L(-1, ['.hooooo.', H8]), L(1, ['ssssssoooo'], -2)],
}
// Scarf: neck row, top torso row (width follows the build), optional tail. Absolute rows below.
export const SCARF_TAIL: Record<View, Layer | undefined> = {
  down: L(11, ['os', 'os'], 6),
  up: undefined,
  left: L(11, ['o', '.o'], 8),
}
export const MUG: readonly string[] = ['kkk', 'ooo', 'sss']
export const BADGE: readonly string[] = ['hh', 'ss']

// --- props ------------------------------------------------------------------------------
export const book = (n: number): string[] => [`B${rep('w', n - 2)}B`, `B${rep('w', n - 2)}B`, rep('B', n)]
