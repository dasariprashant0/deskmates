import type { OfficeState } from '@deskmates/core'

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

// Replaces homeDir with '~' wherever it starts a path: at the start of a string, or after a
// non-path character (space, quote, '=' ...), and only when it ends at a boundary ('/', '\', end, or a delimiter).
const homeRedactor = (homeDir: string): ((s: string) => string) | undefined => {
  const home = homeDir.length > 1 ? homeDir.replace(/[\\/]+$/, '') : homeDir
  if (home === '' || home === '/' || home === '\\') return undefined
  const re = new RegExp(`(^|[^A-Za-z0-9_.\\-/\\\\~])${esc(home)}(?=$|[/\\\\\\s"'():,;])`, 'g')
  return (s) => s.replace(re, '$1~')
}

// API-key-looking tokens: Anthropic/OpenAI-style sk-, GitHub ghp_/gho_/..., AWS access key ids, Slack xoxb-/xoxp-, JWTs.
// The lookbehind keeps words like "task-..." from matching. Heuristic, not a guarantee.
const SECRET = new RegExp(
  '(?<![A-Za-z0-9])(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}' +
  '|xox[bp]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})', 'g')

/** Compile once (home regex + secret masks); reuse for every string. */
export const makeRedactor = (homeDir: string): ((s: string) => string) => {
  const h = homeRedactor(homeDir)
  return (s) => {
    const r = s.replace(SECRET, '[redacted]')
    return h ? h(r) : r
  }
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

// Deep copy applying an already-compiled redactor to every string value.
export const redactWith = <T>(value: T, f: (s: string) => string): T => walk(value, f) as T

// Generic deep copy with home and secret redaction on every string value (state, events, anything JSON-like).
export const redactDeep = <T>(value: T, homeDir: string): T => redactWith(value, makeRedactor(homeDir))

// Returns a COPY of the state; the input is never mutated. Covers cwd, title, gitBranch,
// spawnDescription, tool summaries and every other free-text string in AgentState.
export const redactHome = (state: OfficeState, homeDir: string): OfficeState => redactDeep(state, homeDir)
