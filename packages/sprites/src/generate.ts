import { ANIMS, DIRS, type Anim, type Dir } from './constants'
import { cyrb53, hashBytes, mulberry32 } from './hash'
import {
  ACCESSORIES, BADGE, BEARD, BUILDS, CAP, CHEEK, EYES, FACE, GLASSES, GROUND_SHADOW, HAIR_STYLES, HEAD,
  HEADPHONES, HX, HY, ARM_H, H, INNER_H, INNER_W, LEG_TOP, TORSO_H, W, MUG, NECK, NECK_Y, NOSE_LEFT, OUTFITS, PANTS_FRONT,
  PANTS_SIDE, SCARF_TAIL, SHOE_FRONT, SHOE_SIDE, TORSO_Y, book, clipAboveHead,
  type Accessory, type Layer, type View,
} from './parts'
import { HAIR_BASES, OUTFIT_BASES, SKIN_BASES, hslToRgb, makeRamp, rgbToHsl, tooClose, type Ramp, type Rgb } from './palette'

export type { Anim, Dir }
export type Frame = { readonly width: typeof W; readonly height: typeof H; readonly rgba: Uint8ClampedArray }
/**
 * Read-only. Frames for non-directional animations (sit, type, read, think, celebrate, error)
 * are shared between directions: `sit:up` is the same array as `sit:down`. Frame objects and
 * arrays are frozen. Copy with `new Uint8ClampedArray(f.rgba)` before tinting or editing pixels.
 */
export type SpriteSheet = {
  readonly name: string
  readonly frames: Readonly<Record<`${Anim}:${Dir}`, readonly Frame[]>>
}

export const frameCounts: Record<Anim, number> = {
  walk: 4, idle: 2, sit: 1, type: 2, read: 2, think: 3, celebrate: 4, error: 3,
}

// --- traits (fixed draw order: appending a slot never reshuffles earlier ones) -------------
type Quirk = 'freckle' | 'blush' | 'beard'
export type Traits = Readonly<{
  build: number; outfit: number; hairStyle: number
  skin: Ramp; hair: Ramp; cloth: Ramp; pants: Ramp; accent: Ramp
  accessories: readonly Accessory[]; quirk: Quirk
}>

const STACKABLE = ACCESSORIES.slice(1) // everything except 'none'
const STACK_CHANCE = 0.3 // odds that a second accessory stacks on the first
const FRECKLE_BELOW = 0.4 // quirk roll thresholds: freckle, then blush, then beard
const BLUSH_BELOW = 0.8

const pick = <T>(a: readonly T[], r: number): T => a[Math.floor(r * a.length)] as T

export const traitsFor = (name: string): Traits => {
  const rnd = mulberry32(cyrb53(name))
  const build = Math.floor(rnd() * BUILDS.length)
  const skin = makeRamp(pick(SKIN_BASES, rnd()))
  const hairStyle = Math.floor(rnd() * HAIR_STYLES.length)
  const hair = makeRamp(pick(HAIR_BASES, rnd()))
  const outfit = Math.floor(rnd() * OUTFITS.length)
  const drawnCloth = pick(OUTFIT_BASES, rnd())
  const first = pick(ACCESSORIES, rnd())
  const stackRoll = rnd()
  const second = pick(STACKABLE, rnd())
  const quirkRoll = rnd()

  // at most two accessories; a second one only stacks 30% of the time and never duplicates
  const chosen = new Set<Accessory>([first])
  if (first !== 'none' && second !== first && stackRoll < STACK_CHANCE) chosen.add(second)
  // contrast rule (no extra draws): rotate the outfit hue until it stands apart from skin and hair
  const [h, s, l] = rgbToHsl(drawnCloth)
  const fits = (c: Rgb) => !tooClose(c, skin.base) && !tooClose(c, hair.base)
  const candidates = [drawnCloth, hslToRgb(h + 120, s, l), hslToRgb(h + 240, s, l)]
  const clothBase = candidates.find(fits) ?? hslToRgb(h, s, l > 0.5 ? l - 0.35 : l + 0.35)
  const accentBase = hslToRgb(h + 150, Math.max(s, 0.35), Math.min(0.6, Math.max(0.35, l)))
  const pantsBase = hslToRgb(h + 200, s * 0.45, 0.3)
  return {
    build, outfit, hairStyle, skin, hair,
    cloth: makeRamp(clothBase), pants: makeRamp(pantsBase), accent: makeRamp(accentBase),
    accessories: ACCESSORIES.filter((a) => a !== 'none' && chosen.has(a)),
    quirk: quirkRoll < FRECKLE_BELOW ? 'freckle' : quirkRoll < BLUSH_BELOW ? 'blush' : 'beard',
  }
}

// --- drawing -------------------------------------------------------------------------------
type Grid = (Rgb | undefined)[]
const OUTLINE: Rgb = [24, 20, 36]
const SHOES: Ramp = makeRamp([52, 46, 64])
const BOOK = makeRamp([140, 80, 56])
const EYE: Rgb = [28, 24, 40]
const EXTRA: Record<string, Rgb> = {
  e: EYE, f: [176, 186, 214], g: [36, 34, 48], d: [58, 56, 78], k: [96, 60, 40], B: BOOK.base, w: [236, 230, 220],
}
const CERAMIC: Ramp = makeRamp([232, 226, 214])
const BADGE_RAMP: Ramp = makeRamp([240, 196, 60])
const BLUSH: Rgb = [232, 130, 140]
const ERR_EYE: Rgb = [216, 48, 56]

const put = (g: Grid, x: number, y: number, c: Rgb) => {
  if (x >= 0 && x < INNER_W && y >= 0 && y < INNER_H) g[y * INNER_W + x] = c
}
const colour = (ch: string, r: Ramp, extra: Record<string, Rgb>): Rgb | undefined =>
  ch === 'o' ? r.base : ch === 's' ? r.shadow : ch === 'h' ? r.highlight : extra[ch]
const stampRows = (g: Grid, rows: readonly string[], x: number, y: number, r: Ramp, extra: Record<string, Rgb> = EXTRA) =>
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const c = colour(row.charAt(i), r, extra)
      if (c) put(g, x + i, y + j, c)
    }
  })
const stamp = (g: Grid, l: Layer | undefined, ox: number, oy: number, r: Ramp, extra: Record<string, Rgb> = EXTRA) => {
  if (l) stampRows(g, l.rows, ox + (l.x ?? 0), oy + l.y, r, extra)
}
// 'far' limbs use the shadow as their base so near and far legs read as different depths
const far = (r: Ramp): Ramp => ({ shadow: r.shadow, base: r.shadow, highlight: r.base })

type ArmMode = 'down' | 'up' | 'type' | 'book' | 'chin' | 'cheeks'
type Pose = {
  dx: number; dy: number               // upper body offset
  legL: readonly [number, number]      // [dx, dy]; in side view legL is the near leg
  legR: readonly [number, number]
  legTop: number; pants: number
  armMode: ArmMode; armL: number; armR: number // vertical swing; in side view armL is the x swing
  spread: number                       // arms-up outward spread
  ex: number; err: boolean
  book: 0 | 1 | 2
}
const BASE: Pose = {
  dx: 0, dy: 0, legL: [0, 0], legR: [0, 0], legTop: LEG_TOP, pants: 3,
  armMode: 'down', armL: 0, armR: 0, spread: 0, ex: 0, err: false, book: 0,
}
const P = (o: Partial<Pose>): Pose => ({ ...BASE, ...o })

const drawLegs = (g: Grid, t: Traits, view: View, p: Pose) => {
  const top = p.legTop
  if (view === 'left') {
    const legs = [
      { leg: p.legR, r: far(t.pants), s: far(SHOES) },
      { leg: p.legL, r: t.pants, s: SHOES },
    ]
    for (const { leg, r, s } of legs) {
      const x = 6 + leg[0]
      const y = top + leg[1]
      stampRows(g, Array.from({ length: p.pants }, () => PANTS_SIDE), x, y, r)
      stamp(g, SHOE_SIDE, x, y + p.pants, s)
    }
  } else {
    for (const { leg, x } of [{ leg: p.legL, x: 5 }, { leg: p.legR, x: 7 }]) {
      const lx = x + leg[0]
      const y = top + leg[1]
      stampRows(g, Array.from({ length: p.pants }, () => PANTS_FRONT), lx, y, t.pants)
      stampRows(g, SHOE_FRONT, lx, y + p.pants, SHOES)
    }
  }
}

const drawHead = (g: Grid, t: Traits, view: View, p: Pose) => {
  const ox = HX + p.dx
  const oy = HY + p.dy
  const style = HAIR_STYLES[t.hairStyle] ?? HAIR_STYLES[0]
  const hv = style ? style[view] : {}
  const cap = t.accessories.includes('cap')
  const clip = (l: Layer | undefined) => (cap ? clipAboveHead(l) : l)
  stamp(g, HEAD, ox, oy, t.skin)
  stamp(g, clip(hv.back), ox, oy, t.hair)
  stamp(g, FACE[view], ox, oy, t.skin)
  if (view === 'left') stamp(g, NOSE_LEFT, ox, oy, t.skin)
  const eyes = EYES[view]
  if (eyes) for (const col of eyes.cols) put(g, ox + col + p.ex, oy + eyes.row, p.err ? ERR_EYE : EYE)
  const cheek = CHEEK[view]
  if (cheek && t.quirk !== 'beard') put(g, ox + cheek[0], oy + cheek[1], t.quirk === 'blush' ? BLUSH : t.skin.shadow)
  if (t.quirk === 'beard') stamp(g, BEARD[view], ox, oy, t.hair)
  stamp(g, clip(hv.front), ox, oy, t.hair)
}

const drawTorso = (g: Grid, t: Traits, view: View, p: Pose) => {
  const build = BUILDS[t.build] ?? BUILDS[0]
  const outfit = OUTFITS[t.outfit] ?? OUTFITS[0]
  if (!build || !outfit) return
  const c = build.core
  const w = c + 2
  const x0 = (INNER_W - w) / 2
  const ty = TORSO_Y + p.dy
  const coreX = (view === 'left' ? (INNER_W - c) / 2 : x0 + 1) + p.dx
  for (let r = 0; r < TORSO_H; r++) stampRows(g, [outfit.core(r, c)], coreX, ty + r, t.cloth)
  stamp(g, NECK, p.dx, p.dy, t.skin)

  type Side = 'L' | 'R'
  const xL = x0 + p.dx
  const xR = x0 + w - 1 + p.dx
  // left arm catches the light (highlight / skin base), right arm is in shade
  const cell = (side: Side, x: number, y: number, sleeve: boolean) => {
    if (sleeve) stampRows(g, [side === 'L' ? 'h' : 's'], x, y, t.cloth)
    else stampRows(g, [side === 'L' ? 'o' : 's'], x, y, t.skin)
  }
  const armDown = (side: Side, x: number, swing: number) => {
    for (let r = 0; r < ARM_H; r++) cell(side, x, ty + r + swing, r < outfit.sleeve)
  }

  if (view === 'left') {
    // one visible arm swinging over the torso, drawn in shade so it separates from the torso
    const ax = 6 + p.armL + p.dx
    for (let r = 0; r < ARM_H; r++) {
      const sleeve = r < outfit.sleeve
      stampRows(g, [sleeve ? 'ss' : 'oo'], ax, ty + r, sleeve ? t.cloth : t.skin)
    }
    return
  }
  switch (p.armMode) {
    case 'down':
      armDown('L', xL, p.armL)
      armDown('R', xR, p.armR)
      break
    case 'up':
      for (const [side, x] of [['L', xL - p.spread], ['R', xR + p.spread]] as const)
        for (let i = 0; i < ARM_H; i++) cell(side, x, ty + 1 - i, i < outfit.sleeve)
      break
    case 'type':
      for (const [side, x, dy] of [['L', xL, p.armL], ['R', xR, p.armR]] as const) {
        for (let r = 0; r < 3; r++) cell(side, x, ty + r, r < outfit.sleeve)
        cell(side, x + (side === 'L' ? 1 : -1), ty + 3 + dy, false)
      }
      break
    case 'book': {
      const by = ty + 2 - (p.book === 2 ? 1 : 0)
      for (const [side, x] of [['L', xL], ['R', xR]] as const)
        for (let r = 0; r < 3; r++) cell(side, x, ty + r, r < outfit.sleeve)
      stampRows(g, book(c), x0 + 1 + p.dx, by, BOOK)
      cell('L', x0 + 1 + p.dx, by + 2, false)
      cell('R', x0 + c + p.dx, by + 2, false)
      break
    }
    case 'chin':
    case 'cheeks': {
      // one forearm (or both) folded up toward the face
      const raise = (side: Side, x: number) => {
        cell(side, x, ty, outfit.sleeve > 0)
        cell(side, x, ty + 1, outfit.sleeve > 0)
        cell(side, x, ty - 1, false)
        cell(side, x + (side === 'L' ? 1 : -1), ty - 2, false)
      }
      if (p.armMode === 'cheeks') raise('L', xL)
      else armDown('L', xL, p.armL)
      raise('R', xR)
      break
    }
  }
}

const drawAccessories = (g: Grid, t: Traits, view: View, p: Pose) => {
  const ox = HX + p.dx
  const oy = HY + p.dy
  const has = (a: Accessory) => t.accessories.includes(a)
  const c = (BUILDS[t.build] ?? BUILDS[0])?.core ?? 6
  const w = c + 2
  const x0 = (INNER_W - w) / 2
  const side = view === 'left'
  const ty = TORSO_Y + p.dy
  const ex = { ...EXTRA, c: t.accent.base }
  if (has('glasses')) stamp(g, GLASSES[view], ox, oy, t.skin, ex)
  if (has('headphones')) {
    const h = HEADPHONES[view]
    if (!has('cap')) for (const l of h.band) stamp(g, l, ox, oy, t.skin, ex)
    for (const l of h.cups) stamp(g, l, ox, oy, t.skin, ex)
  }
  if (has('cap')) for (const l of CAP[view]) stamp(g, l, ox, oy, t.accent, ex)
  if (has('scarf')) {
    stampRows(g, ['oooo'], 5 + p.dx, NECK_Y + p.dy, t.accent)
    const cw = side ? c : w
    stampRows(g, [`h${'o'.repeat(cw - 2)}s`], (side ? (INNER_W - c) / 2 : x0) + p.dx, ty, t.accent)
    const tail = SCARF_TAIL[view]
    if (tail) stamp(g, { ...tail, y: tail.y + p.dy }, p.dx, 0, t.accent)
  }
  if (has('mug') && view !== 'up') {
    const mx = side ? Math.max(0, (INNER_W - c) / 2 - 3) : Math.min(x0 + w, 11)
    stampRows(g, MUG, mx + p.dx, ty + 3, CERAMIC)
  }
  if (has('badge') && view !== 'up') {
    stampRows(g, BADGE, (side ? (INNER_W - c) / 2 : x0 + 2) + p.dx, ty + 2, BADGE_RAMP)
  }
}

const render = (t: Traits, view: View, p: Pose): Frame => {
  const g: Grid = new Array<Rgb | undefined>(INNER_W * INNER_H).fill(undefined)
  // z-order: shadow, legs, outfit, body, head, hair-back, face, hair-front, accessory
  stamp(g, GROUND_SHADOW, 0, 0, t.skin)
  drawLegs(g, t, view, p)
  drawTorso(g, t, view, p)
  drawHead(g, t, view, p)
  drawAccessories(g, t, view, p)

  // blit into WxH with a 1px dark outline around the silhouette
  const rgba = new Uint8ClampedArray(W * H * 4)
  const set = (x: number, y: number, c: Rgb) => {
    const i = (y * W + x) * 4
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255
  }
  const at = (x: number, y: number) => (x >= 0 && x < INNER_W && y >= 0 && y < INNER_H ? g[y * INNER_W + x] : undefined)
  for (let y = -1; y <= INNER_H; y++)
    for (let x = -1; x <= INNER_W; x++) {
      const c = at(x, y)
      if (c) set(x + 1, y + 1, c)
      else if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) set(x + 1, y + 1, OUTLINE)
    }
  return Object.freeze({ width: W, height: H, rgba })
}

const mirror = (f: Frame): Frame => {
  const rgba = new Uint8ClampedArray(f.rgba.length)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4
      const d = (y * W + (W - 1 - x)) * 4
      for (let c = 0; c < 4; c++) rgba[d + c] = f.rgba[s + c] ?? 0
    }
  return Object.freeze({ width: W, height: H, rgba })
}

// --- poses ---------------------------------------------------------------------------------
const SPREAD_LEGS = { legL: [-1, 0], legR: [1, 0] } as const
const SIT = { dy: 2, legTop: 18, pants: 1 } as const
const POSES: Record<Anim, Pose[]> = {
  walk: [
    P({ dy: 1, ...SPREAD_LEGS, armL: -1, armR: 1 }),
    P({ legL: [0, -1] }),
    P({ dy: 1, ...SPREAD_LEGS, armL: 1, armR: -1 }),
    P({ legR: [0, -1] }),
  ],
  idle: [P({}), P({ dy: 1 })],
  sit: [P(SIT)],
  type: [
    P({ ...SIT, armMode: 'type', armL: 0, armR: -1 }),
    P({ ...SIT, armMode: 'type', armL: -1, armR: 0 }),
  ],
  read: [P({ armMode: 'book', book: 1 }), P({ armMode: 'book', book: 2 })],
  think: [P({ armMode: 'chin' }), P({ armMode: 'chin', ex: -1 }), P({ armMode: 'chin', ex: 1, legL: [0, -1] })],
  celebrate: [
    P({ dy: 1 }),
    P({ dy: -1, armMode: 'up', legL: [0, -1], legR: [0, -1] }),
    P({ dy: -1, armMode: 'up', spread: 1, legL: [-1, -1], legR: [1, -1] }),
    P({ armMode: 'up' }),
  ],
  error: [
    P({ dy: 1, armMode: 'cheeks', err: true }),
    P({ dy: 1, dx: -1, armMode: 'cheeks', err: true }),
    P({ dy: 1, dx: 1, armMode: 'cheeks', err: true }),
  ],
}
// side-view poses: legL = near leg, armL = x swing of the near arm
const LEFT_POSES: Partial<Record<Anim, Pose[]>> = {
  walk: [
    P({ dy: 1, legL: [-2, 0], legR: [2, 0], armL: 2 }),
    P({ legL: [0, -1] }),
    P({ dy: 1, legL: [2, 0], legR: [-2, 0], armL: -2 }),
    P({ legR: [0, -1] }),
  ],
  idle: POSES.idle,
}

export const generateSprite = (name: string): SpriteSheet => generateSpriteFromTraits(traitsFor(name), name)

export const generateSpriteFromTraits = (t: Traits, name: string): SpriteSheet => {
  const frames = {} as Record<`${Anim}:${Dir}`, readonly Frame[]>
  for (const anim of ANIMS) {
    const down = Object.freeze(POSES[anim].map((p) => render(t, 'down', p)))
    frames[`${anim}:down`] = down
    const left = LEFT_POSES[anim]
    if (left) {
      const l = Object.freeze(left.map((p) => render(t, 'left', p)))
      frames[`${anim}:left`] = l
      frames[`${anim}:right`] = Object.freeze(l.map(mirror))
      frames[`${anim}:up`] = Object.freeze(POSES[anim].map((p) => render(t, 'up', p)))
    } else {
      // authored facing down only: other directions share the same pixel data
      frames[`${anim}:up`] = down
      frames[`${anim}:left`] = down
      frames[`${anim}:right`] = down
    }
  }
  return Object.freeze({ name, frames: Object.freeze(frames) })
}

// hashBytes takes a 32-bit seed: fold the 53-bit running hash (low word xor high word) to chain frames.
const foldSeed = (acc: number) => (acc >>> 0) ^ Math.floor(acc / 4294967296)

export const hashSheet = (sheet: SpriteSheet): string => {
  let acc = 0
  for (const anim of ANIMS)
    for (const dir of DIRS)
      for (const f of sheet.frames[`${anim}:${dir}`]) acc = hashBytes(f.rgba, foldSeed(acc))
  return acc.toString(16).padStart(14, '0')
}
