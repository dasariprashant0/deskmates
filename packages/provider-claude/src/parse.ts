import type { NormalizedEvent } from '@deskmates/core'
import { summarize } from './summary'
import { toolActivity } from './toolTable'

export type SourceRef = { provider: 'claude'; filePath: string; sessionId: string; agentId?: string; isSubagent: boolean }
export type ParseCtx = { seenMessageIds: Set<string>; started: boolean; openToolIds: Set<string> }
export const newParseCtx = (): ParseCtx => ({ seenMessageIds: new Set(), started: false, openToolIds: new Set() })

/** Counters that make skipped input observable. Never holds transcript content. */
export type ParseDiag = {
  ignored: number; unrecognized: number; malformed: number; oversize: number
  internalError: number; badTimestamp: number; lastUnrecognized?: string
}
export const newParseDiag = (): ParseDiag =>
  ({ ignored: 0, unrecognized: 0, malformed: 0, oversize: 0, internalError: 0, badTimestamp: 0 })

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Ev = DistOmit<NormalizedEvent, 'seq'>
type Obj = Record<string, unknown>

const MAX_LINE = 1_048_576
const CHEAP_LIMIT = Math.floor(MAX_LINE / 3) // at or below this, even 3-byte chars (max per UTF-16 unit) fit in MAX_LINE bytes
const MAX_SEEN = 512
const MAX_OPEN = 1024
// Known metadata line types: ignored by design, not "unrecognized".
const IGNORED_TYPES = new Set(['last-prompt', 'custom-title', 'agent-name', 'mode', 'file-history-snapshot',
  'file-history-delta', 'queue-operation', 'attachment', 'system', 'summary', 'bridge-session'])
const ASSISTANT_BLOCKS = new Set(['thinking', 'redacted_thinking', 'text', 'tool_use'])
const USER_BLOCKS = new Set(['tool_result', 'text', 'image'])

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
// Free text from transcripts is capped at parse time so one hostile line cannot bloat state or snapshots.
const MAX_CWD = 1024
const MAX_FIELD = 128
const cap = (v: string | undefined, max: number) => {
  if (v === undefined || v.length <= max) return v
  const c = v.charCodeAt(max - 1)
  return v.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max) // never end on half a surrogate pair
}
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
// Only tame identifiers survive, so odd type values can never carry content into diag.
const label = (kind: 'type' | 'block', v: unknown) => `${kind}=${typeof v === 'string' && /^[a-z_]{1,24}$/.test(v) ? v : 'other'}`
const addCapped = (set: Set<string>, v: string, cap: number) => {
  set.delete(v)
  set.add(v)
  while (set.size > cap) set.delete(set.values().next().value as string)
}
const tooBig = (line: string) =>
  line.length > MAX_LINE || (line.length > CHEAP_LIMIT && new TextEncoder().encode(line).length > MAX_LINE)

/**
 * Pure, sync, never throws. Only ISO string timestamps are honored; anything else
 * (including a numeric epoch) falls back to `now ?? 0` and counts as badTimestamp.
 * ctx is mutated only after the whole line parsed successfully.
 */
export const parseLine = (src: SourceRef, line: string, ctx: ParseCtx, now?: number, diag?: ParseDiag): Ev[] => {
  try {
    if (line.length === 0) return []
    if (tooBig(line)) { if (diag) diag.oversize++; return [] }
    let o: unknown
    try { o = JSON.parse(line) } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
      if (diag) diag.malformed++
      return []
    }
    if (!isObj(o)) { if (diag) diag.malformed++; return [] }
    const unrecognized = (what: string) => { if (diag) { diag.unrecognized++; diag.lastUnrecognized = what } }
    if (o.type !== 'user' && o.type !== 'assistant') {
      if (typeof o.type === 'string' && IGNORED_TYPES.has(o.type)) { if (diag) diag.ignored++ }
      else unrecognized(label('type', o.type))
      return []
    }
    if (!isObj(o.message)) { unrecognized('message=invalid'); return [] }
    const msg = o.message
    const parsed = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    if (!Number.isFinite(parsed) && diag) diag.badTimestamp++
    const ts = Number.isFinite(parsed) ? parsed : (now ?? 0)
    const out: Ev[] = []
    const push = <K extends Ev['kind']>(kind: K, fields: Omit<Extract<Ev, { kind: K }>, 'kind' | 'ts' | 'agent'>) => {
      const agent = { provider: 'claude', sessionId: src.sessionId, agentId: src.agentId, parentAgentId: undefined }
      // Cast stays: TS cannot prove a generic spread satisfies the distributive union; `fields` is the typed gate.
      out.push({ ts, agent, kind, ...fields } as unknown as Ev)
    }

    // Pending ctx changes, committed only at the end.
    const startedNow = !ctx.started
    const opened: string[] = []
    const closed: string[] = []
    let newSeenId: string | undefined

    if (startedNow) push('session.start', { cwd: cap(s(o.cwd), MAX_CWD) ?? '', gitBranch: s(o.gitBranch), model: cap(s(msg.model), MAX_FIELD) })
    const user = o.type === 'user'
    const userText = (chars: number) => { push('message', { role: 'user', chars }); push('activity', { state: 'thinking' }) }
    if (typeof msg.content === 'string' && user) userText(msg.content.length)
    const blocks = Array.isArray(msg.content) ? msg.content : []
    for (const b of blocks) {
      if (!isObj(b)) { unrecognized('block=invalid'); continue }
      if (!(user ? USER_BLOCKS : ASSISTANT_BLOCKS).has(b.type as string)) { unrecognized(label('block', b.type)); continue }
      if (user) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const id = cap(b.tool_use_id, MAX_FIELD)!
          closed.push(id)
          push('tool.end', { toolUseId: id, isError: b.is_error === true })
        } else if (b.type === 'text' && typeof b.text === 'string') userText(b.text.length)
      } else if (b.type === 'thinking') push('activity', { state: 'thinking' })
      else if (b.type === 'text' && typeof b.text === 'string') {
        push('activity', { state: 'typing' })
        push('message', { role: 'assistant', chars: b.text.length })
      } else if (b.type === 'tool_use') {
        if (typeof b.id !== 'string' || typeof b.name !== 'string') { unrecognized('tool_use=incomplete'); continue }
        const id = cap(b.id, MAX_FIELD)!
        opened.push(id)
        push('tool.start', { toolUseId: id, name: cap(b.name, MAX_FIELD)!, summary: summarize(b.name, b.input) })
        push('activity', { state: toolActivity(b.name) })
      }
    }
    if (!user && isObj(msg.usage)) {
      const id = s(msg.id)
      if (id === undefined || !ctx.seenMessageIds.has(id)) {
        newSeenId = id
        const u = msg.usage
        push('usage', { model: cap(s(msg.model), MAX_FIELD) ?? '', input: n(u.input_tokens), cacheWrite: n(u.cache_creation_input_tokens),
          cacheRead: n(u.cache_read_input_tokens), output: n(u.output_tokens) })
      }
    }

    // Commit.
    if (startedNow) ctx.started = true
    for (const id of opened) addCapped(ctx.openToolIds, id, MAX_OPEN)
    for (const id of closed) ctx.openToolIds.delete(id)
    if (newSeenId !== undefined) addCapped(ctx.seenMessageIds, newSeenId, MAX_SEEN)
    return out
  } catch {
    // Error message may hold content, so only the count is kept.
    if (diag) diag.internalError++
    return []
  }
}
