import type { AgentRef, NormalizedEvent } from './events'
import { agentKey, type AgentState, type AgentStatus, type Attention, type OfficeState, type OpenTool } from './state'

const KINDS = {
  'session.start': 1, 'agent.spawn': 1, 'agent.end': 1, activity: 1, 'tool.start': 1, 'tool.end': 1,
  attention: 1, 'attention.resolved': 1, usage: 1, message: 1,
} satisfies Record<NormalizedEvent['kind'], 1>

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const omit = <V>(o: Record<string, V>, k: string): Record<string, V> => {
  const c = { ...o }
  delete c[k]
  return c
}
const terminal = (s: AgentStatus) => s === 'done' || s === 'error'
const settled = (openTools: Record<string, OpenTool>) => Object.keys(openTools).length === 0
// Used only when attention clears (tool.end / attention.resolved). Terminal status sticks; 'thinking' is not restored.
// Elsewhere status changes only via activity, tool.start, attention, attention.resolved and agent.end:
// ending the last tool leaves 'working' until the next activity event.
const statusFor = (a: AgentState, attention: Attention | undefined, openTools: Record<string, OpenTool>): AgentStatus =>
  terminal(a.status) ? a.status : attention ? 'waiting' : settled(openTools) ? 'idle' : 'working'

const fresh = (ref: AgentRef, ts: number): AgentState => ({
  key: agentKey(ref),
  ref,
  status: 'idle',
  activity: 'idle',
  openTools: {},
  openOrder: [],
  usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  startedAt: ts,
  lastEventAt: ts,
  children: [],
})

const currentOf = (openTools: Record<string, OpenTool>, openOrder: string[]): AgentState['currentTool'] => {
  const id = openOrder.at(-1)
  const t = id === undefined ? undefined : openTools[id]
  return id !== undefined && t ? { toolUseId: id, ...t } : undefined
}

// Returns the patch for one agent; everything is copied, nothing mutated.
const apply = (a: AgentState, e: NormalizedEvent): Partial<AgentState> => {
  switch (e.kind) {
    case 'session.start':
      return {
        cwd: e.cwd,
        ...(e.title !== undefined && { title: e.title }),
        ...(e.model !== undefined && { model: e.model }),
        ...(e.gitBranch !== undefined && { gitBranch: e.gitBranch }),
      }
    case 'agent.spawn':
      return {
        ...(e.description !== undefined && { spawnDescription: e.description }),
        ...(e.agentType !== undefined && { agentType: e.agentType }),
      }
    case 'activity': {
      // A late activity after done/error only updates `activity`; attention keeps 'waiting'.
      const mapped = e.state === 'thinking' ? 'thinking' : e.state === 'idle' ? 'idle' : 'working'
      return { activity: e.state, status: a.attention || terminal(a.status) ? a.status : mapped }
    }
    case 'tool.start': {
      const openTools = { ...omit(a.openTools, e.toolUseId), [e.toolUseId]: { name: e.name, summary: e.summary, startedAt: e.ts } }
      const openOrder = [...a.openOrder.filter((id) => id !== e.toolUseId), e.toolUseId]
      return { openTools, openOrder, currentTool: currentOf(openTools, openOrder), status: terminal(a.status) ? a.status : a.attention ? 'waiting' : 'working' }
    }
    case 'tool.end': {
      const isOpen = has(a.openTools, e.toolUseId)
      const openTools = isOpen ? omit(a.openTools, e.toolUseId) : a.openTools
      const openOrder = isOpen ? a.openOrder.filter((id) => id !== e.toolUseId) : a.openOrder
      const patch: Partial<AgentState> = isOpen ? { openTools, openOrder, currentTool: currentOf(openTools, openOrder) } : {}
      if (isOpen && e.isError) patch.lastError = { toolUseId: e.toolUseId, at: e.ts }
      if (a.attention?.toolUseId === e.toolUseId) {
        patch.attention = undefined
        patch.status = statusFor(a, undefined, openTools)
      }
      return patch
    }
    case 'attention':
      return { attention: { toolUseId: e.toolUseId, source: e.source, since: e.ts, ...(e.requestId !== undefined && { requestId: e.requestId }) }, status: terminal(a.status) ? a.status : 'waiting' } // terminal agents record attention but keep their status
    case 'attention.resolved':
      return a.attention?.toolUseId === e.toolUseId ? { attention: undefined, status: statusFor(a, undefined, a.openTools) } : {}
    case 'usage':
      return {
        model: e.model,
        usage: {
          input: a.usage.input + e.input,
          cacheWrite: a.usage.cacheWrite + e.cacheWrite,
          cacheRead: a.usage.cacheRead + e.cacheRead,
          output: a.usage.output + e.output,
        },
      }
    case 'agent.end':
      return { status: e.reason === 'stop' ? 'done' : e.reason, endedAt: e.ts, attention: undefined }
    case 'message':
      return {}
    default: {
      const unreachable: never = e
      return unreachable
    }
  }
}

export const reduce = (state: OfficeState, event: NormalizedEvent): OfficeState => {
  if (!has(KINDS, event.kind)) return state
  // ponytail: copies `agents` (O(agents)) per event; switch to structural sharing (immer-style) if sessions reach thousands.
  const agents = { ...state.agents }
  let order = state.order
  const ensure = (ref: AgentRef): AgentState => {
    const k = agentKey(ref)
    let a = agents[k]
    if (!a) {
      a = fresh(ref, event.ts)
      agents[k] = a
      order = [...order, k]
    }
    return a
  }
  const patch = (a: AgentState, p: Partial<AgentState>): AgentState => (agents[a.key] = { ...a, ...p })

  if (event.kind === 'agent.spawn') {
    const { provider, sessionId, parentAgentId } = event.agent
    const parentRef: AgentRef = { provider, sessionId, ...(parentAgentId !== undefined && { agentId: parentAgentId }) }
    const pk = agentKey(parentRef)
    const ck = agentKey(event.agent)
    if (pk !== ck) {
      const parent = ensure(parentRef)
      const child = ensure(event.agent)
      patch(parent, { children: parent.children.includes(ck) ? parent.children : [...parent.children, ck] })
      patch(child, { parentKey: pk })
    }
  }

  const a = ensure(event.agent)
  patch(a, { ...apply(a, event), lastEventAt: Math.max(a.lastEventAt, event.ts) })
  return { agents, order, seq: Math.max(state.seq, event.seq) }
}
