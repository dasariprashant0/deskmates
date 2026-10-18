import { describe, expect, test } from 'vitest'
import { frameCounts, generateSprite, generateSpriteFromTraits, hashSheet, traitsFor, type Frame, type Traits } from '../src/index'
import { ANIMS, DIRS, type Anim, type Dir } from '../src/constants'
import { HAIR_STYLES, BUILDS, EYES, HX, HY } from '../src/parts'
import { tooClose, type Ramp, type Rgb } from '../src/palette'

const DIRECTIONAL: readonly Anim[] = ['walk', 'idle']
const same = (a: Frame, b: Frame) => a.rgba.length === b.rgba.length && a.rgba.every((v, i) => v === b.rgba[i])
const mismatches = (a: Frame, b: Frame, map: (i: number) => number) => {
  let n = 0
  for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[map(i)]) n++
  return n
}
const frames = (name: string, anim: Anim, dir: Dir) => generateSprite(name).frames[`${anim}:${dir}`]

describe('determinism and variety', () => {
  test('same name gives identical pixels', () => {
    expect(hashSheet(generateSprite('claude'))).toBe(hashSheet(generateSprite('claude')))
    expect(generateSprite('claude').name).toBe('claude')
  })
  test('200 distinct names give at least 190 distinct sheets', () => {
    const set = new Set<string>()
    for (let i = 0; i < 200; i++) set.add(hashSheet(generateSprite(`agent-${i}`)))
    expect(set.size).toBeGreaterThanOrEqual(190)
  })
})

describe('frame structure', () => {
  const sheet = generateSprite('structure')
  test('frame counts match frameCounts for every anim and dir', () => {
    expect(frameCounts).toEqual({ walk: 4, idle: 2, sit: 1, type: 2, read: 2, think: 3, celebrate: 4, error: 3 })
    for (const a of ANIMS) for (const d of DIRS) expect(sheet.frames[`${a}:${d}`]).toHaveLength(frameCounts[a])
  })
  test('every frame is 16x24, binary alpha, at least 30 opaque pixels', () => {
    for (const a of ANIMS)
      for (const d of DIRS)
        for (const f of sheet.frames[`${a}:${d}`]) {
          expect(f.width).toBe(16)
          expect(f.height).toBe(24)
          expect(f.rgba.length).toBe(1536)
          let opaque = 0
          let badAlpha = 0
          for (let i = 3; i < f.rgba.length; i += 4) {
            const al = f.rgba[i]
            if (al === 255) opaque++
            else if (al !== 0) badAlpha++
          }
          expect(badAlpha).toBe(0)
          expect(opaque).toBeGreaterThanOrEqual(30)
        }
  })
})

describe('directions', () => {
  test('right is the exact mirror of left for walk and idle', () => {
    for (const name of ['claude', 'main', 'agent-7', '']) {
      for (const a of DIRECTIONAL) {
        const l = frames(name, a, 'left')
        const r = frames(name, a, 'right')
        l.forEach((lf, i) => {
          const rf = r[i]
          expect(rf).toBeDefined()
          if (!rf) return
          // pixel (x,y) of right equals pixel (15-x,y) of left, per channel
          const mirrorIndex = (i: number) => {
            const px = i >> 2
            return (((px >> 4) << 4) + (15 - (px & 15))) * 4 + (i & 3)
          }
          expect(mismatches(rf, lf, mirrorIndex)).toBe(0)
        })
      }
    }
  })
  test('left differs from down for walk and idle (really authored)', () => {
    const s = generateSprite('claude')
    for (const a of DIRECTIONAL) {
      const d = s.frames[`${a}:down`][0]
      const l = s.frames[`${a}:left`][0]
      const u = s.frames[`${a}:up`][0]
      if (!d || !l || !u) throw new Error('missing frame')
      expect(same(d, l)).toBe(false)
      expect(same(d, u)).toBe(false)
    }
  })
  test('non-directional anims reuse the down frames for up, left, right', () => {
    const s = generateSprite('claude')
    for (const a of ANIMS.filter((x) => !DIRECTIONAL.includes(x)))
      for (const d of ['up', 'left', 'right'] as Dir[])
        s.frames[`${a}:down`].forEach((f, i) => {
          const o = s.frames[`${a}:${d}`][i]
          expect(o && same(f, o)).toBe(true)
        })
  })
})

describe('animation actually moves', () => {
  test('consecutive walk frames differ in every direction', () => {
    for (const d of DIRS) {
      const w = frames('claude', 'walk', d)
      for (let i = 0; i < w.length - 1; i++) {
        const a = w[i]
        const b = w[i + 1]
        if (!a || !b) throw new Error('missing frame')
        expect(same(a, b)).toBe(false)
      }
    }
  })
  test('idle frames differ; other anims have distinct frames', () => {
    for (const d of DIRS) {
      const [a, b] = frames('claude', 'idle', d)
      if (!a || !b) throw new Error('missing frame')
      expect(same(a, b)).toBe(false)
    }
    for (const a of ['type', 'read', 'think', 'celebrate', 'error'] as Anim[]) {
      const fs = frames('claude', a, 'down')
      for (let i = 0; i < fs.length - 1; i++) {
        const x = fs[i]
        const y = fs[i + 1]
        if (!x || !y) throw new Error('missing frame')
        expect(same(x, y)).toBe(false)
      }
    }
  })
  test('anims differ from each other', () => {
    const hs = new Set(ANIMS.map((a) => frames('claude', a, 'down')[0]).map((f) => f && Array.from(f.rgba).join(',')))
    expect(hs.size).toBe(ANIMS.length)
  })
})

describe('robustness and speed', () => {
  test('empty and 10,000-character names do not throw', () => {
    expect(() => generateSprite('')).not.toThrow()
    expect(() => generateSprite('x'.repeat(10_000))).not.toThrow()
    expect(() => generateSprite('🧑‍💻 日本語\u0000')).not.toThrow()
  })
  test('50 sheets generate well inside a 5 s smoke bound', () => {
    const t = performance.now()
    for (let i = 0; i < 50; i++) generateSprite(`perf-${i}`)
    expect(performance.now() - t).toBeLessThan(5000)
  })
  test('hashSheet is a stable hex digest', () => {
    expect(hashSheet(generateSprite('claude'))).toMatch(/^[0-9a-f]{14}$/)
  })
})

describe('art pins', () => {
  // Intentional guard: these digests pin the art. When the art or palette changes ON PURPOSE,
  // update the literals below (print them with hashSheet). An unexplained failure means the art drifted.
  const PINS: Record<string, string> = {
    claude: '145ace99c56b64',
    main: '10401e9904d226',
    explorer: '13aac063d28350',
  }
  for (const [name, digest] of Object.entries(PINS))
    test(`sheet for "${name}" is unchanged`, () => {
      expect(hashSheet(generateSprite(name))).toBe(digest)
    })
})

describe('face readability (every hair style x build x accessory)', () => {
  const EYE: Rgb = [28, 24, 40]
  const base = traitsFor('face-fixture')
  const eq = (a: Rgb, b: Rgb) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
  const inRamp = (c: Rgb, r: Ramp) => eq(c, r.base) || eq(c, r.shadow) || eq(c, r.highlight)
  // canvas pixel for head-relative (col,row) in the idle frame 0; head is drawn at inner (HX,HY), canvas offset +1
  const px = (f: Frame, col: number, row: number): Rgb => {
    const i = ((HY + row + 1) * 16 + HX + col + 1) * 4
    return [f.rgba[i] ?? 0, f.rgba[i + 1] ?? 0, f.rgba[i + 2] ?? 0]
  }
  const eyes = EYES.down
  if (!eyes) throw new Error('down eyes missing')
  for (const accessory of ['none', 'cap', 'glasses', 'headphones', 'scarf'] as const)
    HAIR_STYLES.forEach((style, hairStyle) =>
      BUILDS.forEach((_, build) =>
        test(`${style.name} / build ${build} / ${accessory}`, () => {
          const t: Traits = { ...base, hairStyle, build, quirk: 'freckle', accessories: accessory === 'none' ? [] : [accessory] }
          const f = generateSpriteFromTraits(t, 'fixture').frames['idle:down'][0]
          if (!f) throw new Error('no frame')
          // (a) eyes are exactly the eye colour
          for (const c of eyes.cols) expect(px(f, c, eyes.row)).toEqual(EYE)
          // (b) the row above the eyes has hair (or cap) pixels
          let hair = 0
          for (let c = 0; c < 8; c++) {
            const p = px(f, c, eyes.row - 1)
            if (inRamp(p, t.hair) || (accessory === 'cap' && inRamp(p, t.accent))) hair++
          }
          expect(hair).toBeGreaterThanOrEqual(2)
          // (c) face visible: skin between the eyes and at least two skin pixels on the eye row
          const eyeRow = Array.from({ length: 8 }, (_, c) => px(f, c, eyes.row))
          expect(eyeRow.filter((p) => inRamp(p, t.skin)).length).toBeGreaterThanOrEqual(2)
          expect(inRamp(px(f, 3, eyes.row), t.skin)).toBe(true)
          // (d) lower face (cheek and chin rows) keeps skin even under a scarf
          for (const row of [3, 4]) {
            const n = Array.from({ length: 8 }, (_, c) => px(f, c, row)).filter((p) => inRamp(p, t.skin)).length
            expect(n).toBeGreaterThanOrEqual(2)
          }
        }),
      ),
    )
})

describe('outfit contrast', () => {
  test('over 500 names the outfit never sits too close to skin or hair', () => {
    for (let i = 0; i < 500; i++) {
      const t = traitsFor(`contrast-${i}`)
      expect(tooClose(t.cloth.base, t.skin.base)).toBe(false)
      expect(tooClose(t.cloth.base, t.hair.base)).toBe(false)
    }
  })
  test('traitsFor is deterministic and generateSprite equals the traits path', () => {
    expect(traitsFor('claude')).toEqual(traitsFor('claude'))
    expect(hashSheet(generateSpriteFromTraits(traitsFor('claude'), 'claude'))).toBe(hashSheet(generateSprite('claude')))
  })
})

describe('read-only and shared frames', () => {
  const s = generateSprite('claude')
  test('non-directional anims share the down array (documented)', () => {
    expect(s.frames['sit:up']).toBe(s.frames['sit:down'])
    expect(s.frames['error:right']).toBe(s.frames['error:down'])
  })
  test('walk:right is its own array, not walk:left', () => {
    expect(s.frames['walk:right']).not.toBe(s.frames['walk:left'])
  })
  test('sheet, frames record, arrays and frame objects are frozen', () => {
    expect(Object.isFrozen(s)).toBe(true)
    expect(Object.isFrozen(s.frames)).toBe(true)
    for (const a of ANIMS) for (const d of DIRS) {
      const arr = s.frames[`${a}:${d}`]
      expect(Object.isFrozen(arr)).toBe(true)
      for (const f of arr) expect(Object.isFrozen(f)).toBe(true)
    }
  })
  test('a frozen array rejects push in strict mode', () => {
    const arr = s.frames['walk:down'] as Frame[]
    expect(() => arr.push(arr[0] as Frame)).toThrow(TypeError)
  })
})

describe('trait pins', () => {
  test('traitsFor("claude") is stable (localises trait-draw regressions)', () => {
    const t = traitsFor('claude')
    const hex = (c: readonly number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
    expect({
      build: t.build, outfit: t.outfit, hairStyle: t.hairStyle, accessories: t.accessories, quirk: t.quirk,
      skin: hex(t.skin.base), hair: hex(t.hair.base), cloth: hex(t.cloth.base),
    }).toEqual({
      build: 0, outfit: 4, hairStyle: 7, accessories: ['mug'], quirk: 'freckle',
      skin: '#e8cab0', hair: '#3a5ccf', cloth: '#2e9e6b',
    })
  })
})
