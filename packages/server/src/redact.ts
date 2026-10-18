import type { OfficeState } from '@deskmates/core'

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

// Replaces homeDir with '~' wherever it starts a path: at the start of a string, or after a
// non-path character (space, quote, '=' ...), and only when it ends at a boundary ('/', '\', end, or a delimiter).
const makeRedactor = (homeDir: string): ((s: string) => string) | undefined => {
  const home = homeDir.length > 1 ? homeDir.replace(/[\\/]+$/, '') : homeDir
  if (home === '' || home === '/' || home === '\\') return undefined
  const re = new RegExp(`(^|[^A-Za-z0-9_.\\-/\\\\~])${esc(home)}(?=$|[/\\\\\\s"'():,;])`, 'g')
  return (s) => s.replace(re, '$1~')
}

const walk = (v: unknown, f: (s: string) => string): unknown => {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map((x) => walk(x, f))
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, f)
    return out
  }
  return v
}

// Generic deep copy with home redaction on every string value (state, events, anything JSON-like).
export const redactDeep = <T>(value: T, homeDir: string): T => {
  const f = makeRedactor(homeDir)
  return (f === undefined ? value : walk(value, f)) as T
}

// Returns a COPY of the state; the input is never mutated. Covers cwd, title, gitBranch,
// spawnDescription, tool summaries and every other free-text string in AgentState.
export const redactHome = (state: OfficeState, homeDir: string): OfficeState => redactDeep(state, homeDir)
