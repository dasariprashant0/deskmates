# @deskmates/sprites

Procedural, original pixel-art characters. Every agent name hashes to a unique 16x24 RGBA character
(build, skin, hair, outfit, accessories, quirk) with walk, idle, sit, type, read, think, celebrate
and error animations. Pure data: no DOM, no Node APIs in `src/`, so it bundles for the browser.

## API

```ts
import { generateSprite, frameCounts, hashSheet } from '@deskmates/sprites'

const sheet = generateSprite('claude')            // pure, deterministic, never throws
const f = sheet.frames['walk:left'][2]            // keys are `${anim}:${dir}`
// f = { width: 16, height: 24, rgba: Uint8ClampedArray(1536) }
new ImageData(new Uint8ClampedArray(f.rgba), f.width, f.height)
```

- Anims: `walk idle sit type read think celebrate error` (`frameCounts` gives frames per anim). Dirs: `down up left right`.
- `hashSheet(sheet)`: stable hex digest of all pixels (used to pin the art in tests).
- `traitsFor(name)` and `generateSpriteFromTraits(traits, name)`: the chosen slots, and rendering from them.
- Sheets are read-only. Frame objects and arrays are frozen, and frames for non-directional anims
  (everything except walk and idle) are shared between directions (`sit:up` is the same array as `sit:down`).
  Copy with `new Uint8ClampedArray(f.rgba)` before tinting.
- Generation is cheap but not free: cache the sheet by name in the consumer (for example one offscreen canvas per sheet).

## Preview

```sh
bun scripts/preview.ts <out.png>          # 24 sample names, many poses
bun scripts/preview-traits.ts <out.png>   # every hair style x build x accessory, down view
```

Tests: `node node_modules/vitest/vitest.mjs run`. Typecheck: `node node_modules/typescript/bin/tsc -p . --noEmit`.
Art lives in `src/parts.ts` (string templates) and the pose tables in `src/generate.ts`. If the art changes on
purpose, re-pin the `hashSheet` and `traitsFor` literals in `test/generate.test.ts`.

## Known limitations

- Face-readability tests cover only the down view.
- The sleep animation from DESIGN.md is intentionally absent.
- Mug and badge are not drawn in the up view.
- Dark skin tones with large light hair give low eye contrast.
- Only walk and idle are authored in all four directions; the other animations face down only.
- `generate.ts` is large; a split into traits, draw and poses is planned.
