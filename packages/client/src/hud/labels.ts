import type { AgentState, OfficeState } from '@deskmates/core'
import { deriveName, NAME_MAX } from '../sim/character'

export type AgentLabel = { short: string; full: string }

const SHORT: Record<string, string> = {
  'general-purpose': 'agent',
  'statusline-setup': 'statusline',
  'claude-code-guide': 'cc-guide',
}
export const abbreviate = (name: string): string => SHORT[name] ?? name

const groupOf = (a: AgentState, name: string): string => (a.ref.agentId !== undefined ? `sub:${a.parentKey ?? ''}:${name}` : `main:${name}`)

/**
 * View-space names. Agents sharing a derived name under the same parent (subagents) or the same project name (main
 * agents) get an ordinal by (startedAt, key), so it never depends on `order` or on who is currently visible.
 * A name that is alone in its group stays plain. `short` fits NAME_MAX for name tags; `full` is for the card and list.
 * ponytail: numbers count every agent in the state, ended ones included, so a long history yields larger ordinals;
 * upgrade to a sticky per-session counter if that reads badly.
 */
export function labelAgents(state: OfficeState): Map<string, AgentLabel> {
  const groups = new Map<string, { a: AgentState; name: string }[]>()
  const seen = new Set<string>()
  for (const k of state.order) {
    const a = state.agents[k]
    if (!a || seen.has(k)) continue
    seen.add(k)
    const name = deriveName(a)
    const g = groupOf(a, name)
    const list = groups.get(g)
    if (list) list.push({ a, name })
    else groups.set(g, [{ a, name }])
  }
  const out = new Map<string, AgentLabel>()
  for (const list of groups.values()) {
    list.sort((x, y) => x.a.startedAt - y.a.startedAt || (x.a.key < y.a.key ? -1 : x.a.key > y.a.key ? 1 : 0))
    list.forEach(({ a, name }, i) => {
      if (list.length === 1) {
        out.set(a.key, { short: Array.from(abbreviate(name)).slice(0, NAME_MAX).join(''), full: name })
        return
      }
      const suffix = ` #${i + 1}`
      const room = Math.max(1, NAME_MAX - suffix.length)
      out.set(a.key, { short: `${Array.from(abbreviate(name)).slice(0, room).join('')}${suffix}`, full: `${name}${suffix}` })
    })
  }
  return out
}
