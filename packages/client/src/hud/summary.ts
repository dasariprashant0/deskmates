import type { AgentState, OfficeState, PriceTable, Usage } from '@deskmates/core'
import { CELEBRATE_MS, deriveName } from '../sim/character'
import { labelAgents, type AgentLabel } from './labels'
import { estimateCost, formatCost, formatElapsed, formatTokens, type CostEstimate } from './cost'

export const ENDED_GRACE_MS = CELEBRATE_MS

export type AgentRow = {
  key: string
  /** Full numbered name ('general-purpose #2'). */
  name: string
  /** Tag-sized form of `name`. */
  short: string
  /** 'working' | 'thinking' | 'idle' | 'done' | 'error' | 'needs you' | 'maybe waiting' */
  status: string
  needs: boolean
  tool: string | undefined
  tokens: number
  tokensLabel: string
  usage: Usage
  cost: CostEstimate
  costLabel: string
  elapsedMs: number
  elapsedLabel: string
  isSub: boolean
  subagents: number
  cwd: string | undefined
  model: string | undefined
  /** When it started waiting (needs-you sorting). */
  since: number
}
export type Totals = { running: number; thinking: number; needsYou: number; errors: number; tokens: number; usd: number; anyExample: boolean; partialCost: boolean }
export type Summary = {
  agents: AgentRow[]
  needsYou: AgentRow[]
  totals: Totals
  /** Agents the office is not showing (idle, finished or over the cap); set by the caller from the sim. */
  hidden?: number
}

const isNeeds = (a: AgentState): boolean => a.status === 'waiting' || a.attention !== undefined
const isEnded = (a: AgentState): boolean => a.endedAt !== undefined && (a.status === 'done' || a.status === 'error')
const num = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

const row = (a: AgentState, prices: PriceTable, now: number, label: AgentLabel | undefined): AgentRow => {
  const needs = isNeeds(a)
  const u = a.usage
  const tokens = num(u.input) + num(u.cacheWrite) + num(u.cacheRead) + num(u.output)
  const cost = estimateCost(u, a.model, prices)
  const elapsedMs = Math.max(0, (a.endedAt ?? now) - a.startedAt)
  return {
    key: a.key,
    name: label?.full ?? deriveName(a),
    short: label?.short ?? deriveName(a),
    status: needs ? (a.attention?.source === 'heuristic' ? 'maybe waiting' : 'needs you') : a.status,
    needs,
    tool: a.currentTool?.summary,
    tokens,
    tokensLabel: formatTokens(tokens),
    usage: u,
    cost,
    costLabel: formatCost(cost),
    elapsedMs,
    elapsedLabel: formatElapsed(elapsedMs),
    isSub: a.ref.agentId !== undefined,
    subagents: a.children.length,
    cwd: a.cwd,
    model: a.model,
    since: a.attention?.since ?? a.lastEventAt,
  }
}

export function summarize(state: OfficeState, prices: PriceTable, pricesAreExample: boolean, now: number): Summary {
  const agents: AgentRow[] = []
  const labels = labelAgents(state)
  const seen = new Set<string>()
  for (const k of state.order) {
    const a = state.agents[k]
    if (!a || seen.has(k)) continue
    seen.add(k)
    if (isEnded(a) && a.endedAt !== undefined && now - a.endedAt > ENDED_GRACE_MS) continue
    agents.push(row(a, prices, now, labels.get(k)))
  }
  const needsYou = agents.filter((r) => r.needs).sort((a, b) => a.since - b.since) // stable: ties keep order
  const t: Totals = { running: 0, thinking: 0, needsYou: needsYou.length, errors: 0, tokens: 0, usd: 0, anyExample: false, partialCost: false }
  for (const r of agents) {
    if (!r.needs && r.status === 'working') t.running++
    if (!r.needs && r.status === 'thinking') t.thinking++
    if (r.status === 'error') t.errors++
    t.tokens += r.tokens
    t.usd += r.cost.usd
    if (!r.cost.known) t.partialCost = true
    else if (pricesAreExample) t.anyExample = true
  }
  return { agents, needsYou, totals: t }
}

/** One plain sentence for the visually hidden summary element. */
export function describeTotals(t: Totals, hidden = 0): string {
  const cost = formatCost({ usd: t.usd, known: true })
  const more = hidden > 0 ? ` ${hidden} more sessions not shown because they are idle or finished.` : ''
  return `${t.running} working, ${t.thinking} thinking, ${t.needsYou} need you, ${t.errors} errors. ${formatTokens(t.tokens)} tokens. Estimated cost ${cost}${t.partialCost ? '+' : ''}${t.anyExample ? ' (example prices)' : ''}.${more}`
}

const HOME = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/
const MAX_DIR = 40
/** Display only: home prefix becomes ~, long paths keep the tail. The result is shown with textContent. */
export function shortDir(cwd: string | undefined): string {
  if (!cwd) return 'unknown'
  const p = cwd.replace(HOME, '~')
  if (p.length <= MAX_DIR) return p
  return `…/${p.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}`
}

/** Next/previous key in `keys`, wrapping. A missing current starts at the first (or last when going back). */
export function cycleKey(keys: readonly string[], current: string | undefined, delta: 1 | -1): string | undefined {
  if (keys.length === 0) return undefined
  const i = current === undefined ? -1 : keys.indexOf(current)
  if (i < 0) return delta === 1 ? keys[0] : keys[keys.length - 1]
  return keys[(i + delta + keys.length) % keys.length]
}
