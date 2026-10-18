export type LoopOpts = {
  now: () => number
  raf: (cb: () => void) => number
  cancel: (id: number) => void
  draw: () => void
  step: (dtMs: number) => void
  isHidden: () => boolean
  fpsCap?: number
}
export type Loop = { start(): void; stop(): void }

export const MAX_DT_MS = 100

export function createLoop(o: LoopOpts): Loop {
  const minGap = 1000 / (o.fpsCap ?? 30) - 1 // small slack so a 60 Hz raf lands on every other frame
  let id: number | undefined
  let last: number | undefined // time of the last processed frame; undefined after a pause or start

  const frame = (): void => {
    id = o.raf(frame)
    if (o.isHidden()) {
      last = undefined // resume without a time jump
      return
    }
    const t = o.now()
    if (last === undefined) {
      last = t
      o.draw()
      return
    }
    const dt = t - last
    if (dt < minGap) return
    last = t
    o.step(Math.min(dt, MAX_DT_MS))
    o.draw()
  }

  return {
    start() {
      if (id !== undefined) return
      last = undefined
      id = o.raf(frame)
    },
    stop() {
      if (id !== undefined) o.cancel(id)
      id = undefined
    },
  }
}
