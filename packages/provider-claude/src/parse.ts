import type { NormalizedEvent } from '@deskmates/core'
import { summarize } from './summary'
import { toolActivity } from './toolTable'

export type SourceRef = { provider: 'claude'; filePath: string; sessionId: string; agentId?: string; isSubagent: boolean }
export type ParseCtx = { seenMessageIds: Set<string>; started: boolean; openToolIds: Set<string> }
export const newParseCtx = (): ParseCtx => ({ seenMessageIds: new Set(), started: false, openToolIds: new Set() })

type Ev = Omit<NormalizedEvent, 'seq'>
type Obj = Record<string, unknown>
const MAX_LINE = 1_048_576
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const parseLine = (src: SourceRef, line: string, ctx: ParseCtx, now?: number): Ev[] => {
  try {
    if (line.length === 0 || line.length > MAX_LINE) return []
    const o: unknown = JSON.parse(line)
    if (!isObj(o) || (o.type !== 'user' && o.type !== 'assistant') || !isObj(o.message)) return []
    const msg = o.message
    const parsed = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    const ts = Number.isFinite(parsed) ? parsed : (now ?? 0)
    const agent = { provider: 'claude', sessionId: src.sessionId, agentId: src.agentId, parentAgentId: undefined }
    const out: Ev[] = []
    const push = (e: { kind: Ev['kind'] } & Obj) => out.push({ ts, agent, ...e } as Ev)

    if (!ctx.started) {
      ctx.started = true
      push({ kind: 'session.start', cwd: s(o.cwd) ?? '', gitBranch: s(o.gitBranch), model: s(msg.model) })
    }
    const user = o.type === 'user'
    const userText = (len: number) => { push({ kind: 'message', role: 'user', chars: len }); push({ kind: 'activity', state: 'thinking' }) }
    const blocks = Array.isArray(msg.content) ? msg.content : []
    if (typeof msg.content === 'string' && user) userText(msg.content.length)
    for (const b of blocks) {
      if (!isObj(b)) continue
      if (user) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          ctx.openToolIds.delete(b.tool_use_id)
          push({ kind: 'tool.end', toolUseId: b.tool_use_id, isError: b.is_error === true })
        } else if (b.type === 'text' && typeof b.text === 'string') userText(b.text.length)
      } else if (b.type === 'thinking') push({ kind: 'activity', state: 'thinking' })
      else if (b.type === 'text' && typeof b.text === 'string') {
        push({ kind: 'activity', state: 'typing' })
        push({ kind: 'message', role: 'assistant', chars: b.text.length })
      } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        ctx.openToolIds.add(b.id)
        push({ kind: 'tool.start', toolUseId: b.id, name: b.name, summary: summarize(b.name, b.input) })
        push({ kind: 'activity', state: toolActivity(b.name) })
      }
    }
    if (!user && isObj(msg.usage)) {
      const id = s(msg.id)
      if (id === undefined || !ctx.seenMessageIds.has(id)) {
        if (id !== undefined) ctx.seenMessageIds.add(id)
        const u = msg.usage
        push({ kind: 'usage', model: s(msg.model) ?? '', input: n(u.input_tokens), cacheWrite: n(u.cache_creation_input_tokens),
          cacheRead: n(u.cache_read_input_tokens), output: n(u.output_tokens) })
      }
    }
    return out
  } catch {
    return []
  }
}
