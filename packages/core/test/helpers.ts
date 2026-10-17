import { emptyState, reduce, type AgentRef, type NormalizedEvent, type OfficeState } from '../src/index'

type DistOmit<T> = T extends unknown ? Omit<T, 'seq' | 'ts' | 'agent'> : never
/** Event body without envelope; distributive so typos in per-kind fields fail to compile. */
export type Body = DistOmit<NormalizedEvent>

export const main: AgentRef = { provider: 'claude', sessionId: 's1' }
let n = 0
export const ev = (body: Body, agent: AgentRef = main, ts: number = ++n * 1000): NormalizedEvent => ({ seq: ++n, ts, agent, ...body })
export const fold = (events: NormalizedEvent[], s: OfficeState = emptyState()): OfficeState => events.reduce(reduce, s)
