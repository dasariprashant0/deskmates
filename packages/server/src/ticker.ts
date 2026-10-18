import type { EventBus } from './bus'
import { safeCode } from './codes'

export type TickerOpts = {
  bus: EventBus
  now: () => number
  attentionAfterMs?: (toolName: string) => number
  awayAfterMs?: number
  onError?: (code: string) => void
}

const defaultAttention = (name: string) => (name === 'Agent' ? Infinity : name === 'Bash' ? 60_000 : 8_000)
// Tool ids already flagged, per bus, so a resolved attention is not raised again for the same tool.
const flagged = new WeakMap<EventBus, Set<string>>()
const codeOf = (e: unknown) => { const r = e as { code?: unknown; name?: unknown } | null | undefined; return safeCode(r?.code ?? r?.name) }

// Each publish is isolated: a failure is reported via `report` and the pass continues. Without `report`
// (direct callers) the first failure is rethrown after the pass and cleanup have completed.
export const tick = (opts: TickerOpts, report?: (err: unknown) => void): number => {
  let firstErr: { e: unknown } | undefined
  const fail = (e: unknown) => { if (report) report(e); else firstErr ??= { e } }
  const { bus } = opts
  const t = opts.now()
  const limit = opts.attentionAfterMs ?? defaultAttention
  const away = opts.awayAfterMs ?? 30 * 60_000
  let done = flagged.get(bus)
  if (!done) { done = new Set(); flagged.set(bus, done) }
  const open = new Set<string>()
  let published = 0
  for (const a of Object.values(bus.state().agents)) {
    const terminal = a.status === 'done' || a.status === 'error'
    for (const [id, tool] of Object.entries(a.openTools)) {
      const k = `${a.key}|${id}`
      open.add(k)
      if (terminal || done.has(k) || a.attention?.toolUseId === id) continue
      if (t - tool.startedAt > limit(tool.name)) {
        try {
          bus.publish({ ts: t, agent: a.ref, kind: 'attention', toolUseId: id, source: 'heuristic' })
          done.add(k) // only after a successful publish, so a failure is retried next tick
          published++
        } catch (e) { fail(e) }
      }
    }
    if (a.endedAt === undefined && t - a.lastEventAt > away) {
      try {
        bus.publish({ ts: t, agent: a.ref, kind: 'agent.end', reason: 'idle' })
        published++
      } catch (e) { fail(e) }
    }
  }
  for (const k of done) if (!open.has(k)) done.delete(k)
  if (firstErr) throw firstErr.e
  return published
}

export const startTicker = (opts: TickerOpts & { intervalMs?: number }) => {
  const st = { ticks: 0, errors: {} as Record<string, number>, lastTickAt: undefined as number | undefined }
  const h = setInterval(() => {
    st.ticks++
    const count = (e: unknown) => {
      const c = codeOf(e)
      st.errors[c] = (st.errors[c] ?? 0) + 1
      try { opts.onError?.(c) } catch { /* ignore */ }
    }
    try { tick(opts, count); st.lastTickAt = opts.now() } catch (e) { count(e) }
  }, opts.intervalMs ?? 1000)
  h.unref()
  return {
    stop: () => clearInterval(h),
    stats: () => ({ ticks: st.ticks, errors: { ...st.errors }, ...(st.lastTickAt !== undefined && { lastTickAt: st.lastTickAt }) }),
  }
}
