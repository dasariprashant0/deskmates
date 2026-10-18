import { describe, expect, test } from 'vitest'
import { createLoop } from '../../src/render/loop'

const setup = (fpsCap?: number) => {
  let t = 0
  let cb: (() => void) | undefined
  let hidden = false
  const steps: number[] = []
  let draws = 0
  let cancelled = 0
  const loop = createLoop({
    now: () => t,
    raf: (f) => { cb = f; return 1 },
    cancel: () => { cancelled++; cb = undefined },
    draw: () => { draws++ },
    step: (dt) => { steps.push(dt) },
    isHidden: () => hidden,
    ...(fpsCap !== undefined && { fpsCap }),
  })
  const tick = (at: number) => { t = at; const f = cb; cb = undefined; f?.() }
  return { loop, tick, steps, draws: () => draws, setHidden: (h: boolean) => { hidden = h }, cancelled: () => cancelled }
}

describe('loop', () => {
  test('steps with real dt and skips frames above the cap', () => {
    const s = setup()
    s.loop.start()
    s.tick(0)
    s.tick(16) // too soon for 30 fps
    s.tick(34)
    s.tick(50)
    s.tick(67)
    expect(s.steps).toEqual([34, 33])
    expect(s.draws()).toBe(3)
  })
  test('clamps dt to 100 ms', () => {
    const s = setup()
    s.loop.start()
    s.tick(0)
    s.tick(5000)
    expect(s.steps).toEqual([100])
  })
  test('hidden: no step, no draw; resumes without a time jump', () => {
    const s = setup()
    s.loop.start()
    s.tick(0)
    s.tick(40)
    s.setHidden(true)
    const d = s.draws()
    s.tick(10_000)
    s.tick(20_000)
    expect(s.steps).toEqual([40])
    expect(s.draws()).toBe(d)
    s.setHidden(false)
    s.tick(20_010)
    s.tick(20_050)
    expect(s.steps).toEqual([40, 40])
  })
  test('stop cancels and start is idempotent', () => {
    const s = setup()
    s.loop.start()
    s.loop.start()
    s.loop.stop()
    expect(s.cancelled()).toBe(1)
  })
})
