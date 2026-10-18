import { emptyState, reduce, type OfficeState } from '@deskmates/core'
import type { EventsMessage, SnapshotMessage } from './protocol'

export type MirrorStats = { snapshots: number; batches: number; gaps: number; stale: number; invalid: number }
export type Mirror = {
  applySnapshot(msg: SnapshotMessage): void
  applyEvents(msg: EventsMessage): 'ok' | 'gap' | 'stale'
  noteInvalid(): void
  state(): OfficeState
  seq(): number
  prices(): unknown
  pricesAreExample(): boolean
  stats(): MirrorStats
}

export function createMirror(): Mirror {
  let state = emptyState()
  let seq = 0
  let prices: unknown = {}
  let example = true
  const st: MirrorStats = { snapshots: 0, batches: 0, gaps: 0, stale: 0, invalid: 0 }
  return {
    applySnapshot(msg) {
      st.snapshots++
      // reduce never mutates, so holding the given object is safe; only `seq` is overridden on a copy.
      state = { ...msg.state, seq: msg.seq }
      seq = msg.seq
      prices = msg.prices
      example = msg.pricesAreExample
    },
    applyEvents(msg) {
      st.batches++
      const { fromSeq, toSeq, events } = msg
      if (toSeq <= seq) { st.stale++; return 'stale' }
      const first = events[0]
      const contiguous =
        fromSeq === seq + 1 && first !== undefined && events.at(-1)?.seq === toSeq && events.every((e, i) => e.seq === fromSeq + i)
      if (!contiguous) { st.gaps++; return 'gap' }
      let s = state
      for (const e of events) s = reduce(s, e)
      state = s
      seq = toSeq
      return 'ok'
    },
    noteInvalid() { st.invalid++ },
    state: () => state,
    seq: () => seq,
    prices: () => prices,
    pricesAreExample: () => example,
    stats: () => ({ ...st }),
  }
}
