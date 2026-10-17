import type { AgentState, Attention, OfficeState } from './state'
import type { PriceTable } from './prices'

export const costUsd = (agent: AgentState, prices: PriceTable): number | undefined => {
  const m = agent.model
  const p = m !== undefined && Object.prototype.hasOwnProperty.call(prices, m) ? prices[m] : undefined
  if (!p) return undefined
  const u = agent.usage
  return (u.input * p.inputPerMTok + u.cacheWrite * p.cacheWritePerMTok + u.cacheRead * p.cacheReadPerMTok + u.output * p.outputPerMTok) / 1e6
}

type Waiting = AgentState & { attention: Attention }
const isWaiting = (a: AgentState | undefined): a is Waiting => a?.attention !== undefined

// Iterates `order` so ties on `since` keep creation order (Array.sort is stable).
export const needsYou = (state: OfficeState): AgentState[] =>
  state.order
    .map((k) => state.agents[k])
    .filter(isWaiting)
    .sort((a, b) => a.attention.since - b.attention.since)

const MAX_DEPTH = 50

export const roomsByCwd = (state: OfficeState): Record<string, AgentState[]> => {
  const cwdOf = (a: AgentState): string => {
    let cur: AgentState | undefined = a
    for (let i = 0; cur && i < MAX_DEPTH; i++) {
      if (cur.cwd) return cur.cwd
      cur = cur.parentKey ? state.agents[cur.parentKey] : undefined
    }
    return 'unknown'
  }
  const rooms = new Map<string, AgentState[]>() // Map: a cwd like '__proto__' is just a key
  for (const k of state.order) {
    const a = state.agents[k]
    if (!a) continue
    const room = cwdOf(a)
    rooms.set(room, [...(rooms.get(room) ?? []), a])
  }
  return Object.fromEntries(rooms)
}
