export type Rgb = readonly [number, number, number]
export type Ramp = Readonly<{ shadow: Rgb; base: Rgb; highlight: Rgb }>

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const byte = (v: number) => clamp(Math.round(v), 0, 255)

/** Returns [hue 0..360, saturation 0..1, lightness 0..1]. */
export const rgbToHsl = ([r, g, b]: Rgb): [number, number, number] => {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === R) h = ((G - B) / d) % 6
  else if (max === G) h = (B - R) / d + 2
  else h = (R - G) / d + 4
  return [(h * 60 + 360) % 360, s, l]
}

export const hslToRgb = (h: number, s: number, l: number): Rgb => {
  const hh = (((h % 360) + 360) % 360) / 60
  const c = (1 - Math.abs(2 * clamp(l, 0, 1) - 1)) * clamp(s, 0, 1)
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x]
  const m = clamp(l, 0, 1) - c / 2
  return [byte((r + m) * 255), byte((g + m) * 255), byte((b + m) * 255)]
}

const HUE_SHIFT = 10 // degrees
/** Move hue `from` toward `target` along the shortest arc by at most HUE_SHIFT degrees. */
const toward = (from: number, target: number) => {
  const d = ((target - from + 540) % 360) - 180
  return (from + clamp(d, -HUE_SHIFT, HUE_SHIFT) + 360) % 360
}

/** 3-step ramp: shadow L-18% leaning blue, highlight L+14% leaning yellow. */
export const makeRamp = (base: Rgb): Ramp => {
  const [h, s, l] = rgbToHsl(base)
  return {
    shadow: hslToRgb(toward(h, 240), s, l - 0.18),
    base,
    highlight: hslToRgb(toward(h, 60), s, l + 0.14),
  }
}

const hex = (s: string): Rgb => [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]

// Natural skin set, light to dark: hue 18-28 degrees, saturation 40-55%, lightness 80% down to 35%.
const SKIN_HSL: readonly (readonly [number, number, number])[] = [
  [28, 0.55, 0.8], [26, 0.55, 0.72], [25, 0.52, 0.64], [24, 0.5, 0.57],
  [23, 0.48, 0.5], [22, 0.45, 0.44], [20, 0.42, 0.39], [18, 0.4, 0.35],
]
export const SKIN_BASES: readonly Rgb[] = SKIN_HSL.map(([h, sat, l]) => hslToRgb(h, sat, l))
export const HAIR_BASES: readonly Rgb[] = [
  '2b1d1a', '4a2c1a', '7a4a28', 'b5772f', 'd9b45a', 'a8a8b0', 'b83a2a', '3a5ccf', '8f4fc4', '2fa58a',
].map(hex)
export const OUTFIT_BASES: readonly Rgb[] = [
  'd9534f', 'e8833a', 'e3b93c', '7cb342', '2e9e6b', '2aa6b8', '3b7dd8', '5a5fcf', '9b59b6', 'd65a9f', '5c6b7a', 'e8e2d0',
].map(hex)

/** True when two colours are hard to tell apart: hue within 40 degrees AND lightness within 25 points. */
export const tooClose = (a: Rgb, b: Rgb): boolean => {
  const [ha, , la] = rgbToHsl(a)
  const [hb, , lb] = rgbToHsl(b)
  const d = Math.abs(ha - hb) % 360
  return Math.min(d, 360 - d) < 40 && Math.abs(la - lb) < 0.25
}
