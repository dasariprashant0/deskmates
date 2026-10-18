// Every hair style x build x accessory, down view: bun scripts/preview-traits.ts <out.png>
import { writeFileSync } from 'node:fs'
import { encodePng } from './png'
import { generateSpriteFromTraits, traitsFor, type Frame } from '../src/index'
import { HAIR_STYLES } from '../src/parts'
import { makeRamp } from '../src/palette'

const out = process.argv[2]
if (!out) throw new Error('usage: bun scripts/preview-traits.ts <output.png>')
const base = traitsFor('claude')
const ACCS = [[], ['cap'], ['glasses'], ['headphones'], ['scarf']] as const
const SCALE = 4, GAP = 2, CW = 16 * SCALE + GAP, CH = 24 * SCALE + GAP
const cols = 3 * ACCS.length
const W = cols * CW + GAP, H = HAIR_STYLES.length * CH + GAP
const px = new Uint8Array(W * H * 4)
for (let i = 0; i < W * H; i++) px.set([128, 128, 128, 255], i * 4)
const blit = (f: Frame, ox: number, oy: number) => {
  for (let y = 0; y < 24; y++) for (let x = 0; x < 16; x++) {
    const s = (y * 16 + x) * 4
    if (f.rgba[s + 3] === 0) continue
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
      const d = ((oy + y * SCALE + dy) * W + ox + x * SCALE + dx) * 4
      px[d] = f.rgba[s] ?? 0; px[d + 1] = f.rgba[s + 1] ?? 0; px[d + 2] = f.rgba[s + 2] ?? 0
    }
  }
}
HAIR_STYLES.forEach((_, row) => {
  ACCS.forEach((acc, a) => {
    for (let b = 0; b < 3; b++) {
      const t = { ...base, hairStyle: row, build: b, accessories: acc, quirk: 'freckle' as const,
        hair: makeRamp([90, 56, 34]), cloth: makeRamp([60, 125, 216]) }
      const f = generateSpriteFromTraits(t, 'traits').frames['idle:down'][0]
      if (f) blit(f, GAP + (a * 3 + b) * CW, GAP + row * CH)
    }
  })
})
writeFileSync(out, encodePng(px, W, H))
console.log(`wrote ${out} (${W}x${H})`)
