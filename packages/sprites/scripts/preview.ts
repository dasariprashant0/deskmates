// Contact sheet: bun scripts/preview.ts <out.png>. Dev tool only, so node:zlib and node:fs are fine here.
import { writeFileSync } from 'node:fs'
import { encodePng } from './png'
import { generateSprite, type Anim, type Dir, type Frame } from '../src/index'

const out = process.argv[2]
if (!out) throw new Error('usage: bun scripts/preview.ts <output.png>')

const NAMES = [
  'claude', 'explorer', 'planner', 'reviewer', 'main', 'builder', 'tester', 'writer',
  ...Array.from({ length: 16 }, (_, i) => `agent-${i + 1}`),
]
const COLUMNS: [Anim, Dir, number][] = [
  ['walk', 'down', 0], ['walk', 'down', 1], ['walk', 'down', 2], ['walk', 'down', 3],
  ['walk', 'left', 0], ['walk', 'up', 0], ['idle', 'down', 0], ['sit', 'down', 0],
  ['type', 'down', 0], ['read', 'down', 0], ['think', 'down', 0], ['celebrate', 'down', 0], ['error', 'down', 0],
]
const SCALE = 4
const GAP = 2
const BG: [number, number, number] = [128, 128, 128]
const cell = (n: number) => n * (16 * SCALE + GAP) + GAP
const W = cell(COLUMNS.length)
const H = NAMES.length * (24 * SCALE + GAP) + GAP
const px = new Uint8Array(W * H * 4)
for (let i = 0; i < W * H; i++) px.set([...BG, 255], i * 4)

const blit = (f: Frame, ox: number, oy: number) => {
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 16; x++) {
      const s = (y * 16 + x) * 4
      if (f.rgba[s + 3] === 0) continue
      for (let dy = 0; dy < SCALE; dy++)
        for (let dx = 0; dx < SCALE; dx++) {
          const d = ((oy + y * SCALE + dy) * W + ox + x * SCALE + dx) * 4
          px[d] = f.rgba[s] ?? 0; px[d + 1] = f.rgba[s + 1] ?? 0; px[d + 2] = f.rgba[s + 2] ?? 0; px[d + 3] = 255
        }
    }
}
NAMES.forEach((name, row) => {
  const sheet = generateSprite(name)
  COLUMNS.forEach(([a, d, i], col) => {
    const f = sheet.frames[`${a}:${d}`][i]
    if (f) blit(f, GAP + col * (16 * SCALE + GAP), GAP + row * (24 * SCALE + GAP))
  })
})

writeFileSync(out, encodePng(px, W, H))
console.log(`wrote ${out} (${W}x${H})`)
