import type { NormalizedEvent, OfficeState, PricesSource } from '@deskmates/core'

export const PROTOCOL = 'deskmates.v1'
export const MAX_FRAME_CHARS = 1_048_576

export type SnapshotMessage = { type: 'snapshot'; v: 1; seq: number; state: OfficeState; prices: unknown; pricesAreExample: boolean; pricesSource?: PricesSource; pricesAsOf?: string }
export type EventsMessage = { type: 'events'; fromSeq: number; toSeq: number; events: NormalizedEvent[] }
export type ServerMessage = SnapshotMessage | EventsMessage
export type InvalidMessage = { type: 'invalid' }

const INVALID: InvalidMessage = { type: 'invalid' }
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isSource = (x: unknown): x is PricesSource => x === 'default' || x === 'user' || x === 'example'
// Dropping `__proto__` at parse time keeps hostile keys out of every later spread/copy.
const noProto = (k: string, v: unknown): unknown => (k === '__proto__' ? undefined : v)

/** Strict, never-throwing parser. Accepts a JSON string or an already-decoded value. */
export function parseServerMessage(raw: unknown): ServerMessage | InvalidMessage {
  try {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
    if (typeof text !== 'string' || text.length > MAX_FRAME_CHARS) return INVALID
    const m: unknown = JSON.parse(text, noProto)
    if (!isObj(m)) return INVALID
    if (m.type === 'snapshot') {
      const { seq, state } = m
      if (m.v !== 1 || !isNum(seq) || !isObj(state) || !isObj(state.agents)) return INVALID
      const order = Array.isArray(state.order) ? (state.order as string[]) : Object.keys(state.agents)
      return {
        type: 'snapshot', v: 1, seq,
        state: { agents: state.agents as OfficeState['agents'], order, seq },
        prices: isObj(m.prices) ? m.prices : {},
        pricesAreExample: m.pricesAreExample === true,
        ...(isSource(m.pricesSource) && { pricesSource: m.pricesSource }),
        ...(typeof m.pricesAsOf === 'string' && m.pricesAsOf.length <= 32 && { pricesAsOf: m.pricesAsOf }),
      }
    }
    if (m.type === 'events') {
      const { fromSeq, toSeq, events } = m
      if (!isNum(fromSeq) || !isNum(toSeq) || !Array.isArray(events)) return INVALID
      if (!events.every((e) => isObj(e) && isNum(e.seq) && typeof e.kind === 'string')) return INVALID
      return { type: 'events', fromSeq, toSeq, events: events as NormalizedEvent[] }
    }
    return INVALID
  } catch {
    return INVALID
  }
}

export const encodeResync = (): string => JSON.stringify({ type: 'resync' })
