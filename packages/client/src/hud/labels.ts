import type { AgentState, OfficeState } from '@deskmates/core'
import { deriveName, NAME_MAX } from '../sim/character'

export type AgentLabel = { short: string; full: string; look: string }

const SHORT: Record<string, string> = {
  'general-purpose': 'agent',
  'statusline-setup': 'statusline',
  'claude-code-guide': 'cc-guide',
}
export const abbreviate = (name: string): string => SHORT[name] ?? name

const groupOf = (a: AgentState, name: string): string => (a.ref.agentId !== undefined ? `sub:${a.parentKey ?? ''}:${name}` : `main:${name}`)

/**
 * View-space names. Agents sharing a derived name under the same parent (subagents) or the same project name (main
 * agents) get an ordinal. It is sticky: a key keeps its ordinal while it is in state, a newcomer takes the lowest
 * ordinal no agent in its group holds (a first snapshot goes in (startedAt, key) order), and a key that leaves state
 * frees its ordinal. A name alone in its group stays plain. `short` fits NAME_MAX for name tags; `full` is for the
 * card and list; `look` seeds the sprite, so siblings differ and the first one keeps the plain-name look.
 * ponytail: the lowest-free scan is linear per newcomer; fine for the few siblings a group ever has.
 */
export function createLabeler(): (state: OfficeState) => Map<string, AgentLabel> {
  const held = new Map<string, Map<string, number>>() // group -> key -> ordinal
  return (state) => {
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
    for (const g of held.keys()) if (!groups.has(g)) held.delete(g)
    const out = new Map<string, AgentLabel>()
    for (const [g, list] of groups) {
      list.sort((x, y) => x.a.startedAt - y.a.startedAt || (x.a.key < y.a.key ? -1 : x.a.key > y.a.key ? 1 : 0))
      const prev = held.get(g)
      const mine = new Map<string, number>()
      if (prev) for (const { a } of list) { const n = prev.get(a.key); if (n !== undefined) mine.set(a.key, n) }
      const used = new Set(mine.values())
      for (const { a } of list) {
        if (mine.has(a.key)) continue
        let n = 1
        while (used.has(n)) n++
        used.add(n)
        mine.set(a.key, n)
      }
      held.set(g, mine)
      for (const { a, name } of list) {
        const n = mine.get(a.key) ?? 1
        const look = n === 1 ? name : `${name} #${n}`
        if (list.length === 1) {
          out.set(a.key, { short: Array.from(abbreviate(name)).slice(0, NAME_MAX).join(''), full: name, look })
          continue
        }
        const suffix = ` #${n}`
        const room = Math.max(1, NAME_MAX - suffix.length)
        out.set(a.key, { short: `${Array.from(abbreviate(name)).slice(0, room).join('')}${suffix}`, full: `${name}${suffix}`, look })
      }
    }
    return out
  }
}

/** One-shot labels with no memory; the app holds a `createLabeler()` so ordinals stay put between calls. */
export const labelAgents = (state: OfficeState): Map<string, AgentLabel> => createLabeler()(state)
