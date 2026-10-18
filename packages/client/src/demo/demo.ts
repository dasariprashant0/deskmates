import { emptyState, EXAMPLE_PRICES, PRICES_AS_OF, type Activity, type AgentRef, type NormalizedEvent } from '@deskmates/core'
import type { SnapshotMessage } from '../net/protocol'
import { createRng, type Rng } from '../sim/rng'

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Draft = DistOmit<NormalizedEvent, 'seq'>
type Body = DistOmit<NormalizedEvent, 'seq' | 'ts' | 'agent'>

export const LOOP_MS = 100_000

export const demoSnapshot = (): SnapshotMessage => ({
  type: 'snapshot', v: 1, seq: 0, state: emptyState(), prices: EXAMPLE_PRICES, pricesAreExample: true, pricesSource: 'example', pricesAsOf: PRICES_AS_OF,
})

type Kind = { name: string; act: Activity; lo: number; hi: number; labels: readonly string[] }
const KINDS: readonly Kind[] = [
  { name: 'Read', act: 'reading', lo: 1000, hi: 2500, labels: ['router.ts', 'handler.ts', 'config.json', 'index.ts', 'README.md'] },
  { name: 'Grep', act: 'searching', lo: 1000, hi: 3000, labels: ['handleRequest', 'TODO', 'retryPolicy'] },
  { name: 'Bash', act: 'running', lo: 3000, hi: 9000, labels: ['pnpm'] },
  { name: 'Edit', act: 'editing', lo: 1000, hi: 2000, labels: ['router.ts', 'limits.ts', 'guide.md'] },
  { name: 'Write', act: 'typing', lo: 1500, hi: 3000, labels: ['notes.md', 'cache.ts', 'plan.md'] },
  { name: 'WebFetch', act: 'searching', lo: 3000, hi: 7000, labels: ['docs.example.com', 'rfc-9110'] },
  { name: 'WebSearch', act: 'searching', lo: 4000, hi: 9000, labels: ['vite config', 'token bucket'] },
]
const MODELS = { api: 'example-model', docs: 'example-model-small', dm: 'example-model' } // keys of EXAMPLE_PRICES, so demo costs show

const between = (r: Rng, lo: number, hi: number): number => Math.round((lo + r.next() * (hi - lo)) / 100) * 100

/** One ~100 s scripted loop as time-ordered drafts (ts absolute). Pure: depends only on (seed, loop). */
function buildLoop(seed: string, k: number): Draft[] {
  const out: Draft[] = []
  const base = k * LOOP_MS
  let n = 0
  const push = (t: number, agent: AgentRef, body: Body) => { out.push({ ...body, ts: base + t, agent } as Draft) }
  const id = () => `toolu_${k}_${++n}`
  const claude = (name: string, suffix = ''): AgentRef => ({ provider: 'claude', sessionId: `demo-${name}-${k}${suffix}` })

  const usage = (r: Rng, t: number, a: AgentRef, model: string) =>
    push(t, a, { kind: 'usage', model, input: between(r, 800, 4000), cacheWrite: between(r, 0, 2000), cacheRead: between(r, 2000, 20_000), output: between(r, 200, 1500) })

  type ToolOpts = { isError?: boolean; attentionAt?: number; attentionFor?: number; toolUseId?: string }
  const tool = (r: Rng, a: AgentRef, model: string, t: number, kd: Kind, dur: number, o: ToolOpts = {}): number => {
    const toolUseId = o.toolUseId ?? id()
    push(t, a, { kind: 'activity', state: kd.act })
    push(t + 50, a, { kind: 'tool.start', toolUseId, name: kd.name, summary: `${kd.name}: ${r.pick(kd.labels) ?? ''}` })
    if (o.attentionAt !== undefined) {
      push(t + 50 + o.attentionAt, a, { kind: 'attention', toolUseId, source: 'heuristic' })
      push(t + 50 + o.attentionAt + (o.attentionFor ?? 6000), a, { kind: 'attention.resolved', toolUseId, decision: 'allow' })
    }
    push(t + 50 + dur, a, { kind: 'tool.end', toolUseId, isError: o.isError === true })
    usage(r, t + 70 + dur, a, model)
    return t + 70 + dur
  }

  // Think, run a tool, repeat, until `to`.
  const work = (r: Rng, a: AgentRef, model: string, from: number, to: number) => {
    let t = from
    let i = Math.floor(r.next() * KINDS.length)
    for (;;) {
      const kd = KINDS[i++ % KINDS.length] as Kind
      const think = between(r, 800, 2000)
      const dur = between(r, kd.lo, kd.hi)
      if (t + think + dur + 120 > to) return
      push(t, a, { kind: 'activity', state: 'thinking' })
      if (r.next() < 0.3) push(t + 100, a, { kind: 'message', role: 'assistant', chars: between(r, 200, 1200) })
      t = tool(r, a, model, t + think, kd, dur) + 100
    }
  }
  const rng = (name: string) => createRng(`${seed}:${k}:${name}`)
  const kind = (name: string) => KINDS.find((x) => x.name === name) as Kind

  // api-gateway: long Bash with heuristic attention, one failing Bash.
  const A = claude('api-gateway')
  const ra = rng('a')
  push(0, A, { kind: 'session.start', cwd: '~/code/api-gateway', gitBranch: 'main', title: 'Add rate limiting', model: MODELS.api })
  work(ra, A, MODELS.api, 600, 38_000)
  tool(ra, A, MODELS.api, 38_500, kind('Bash'), 9000, { attentionAt: 2000, attentionFor: 6000 })
  work(ra, A, MODELS.api, 48_000, 58_000)
  tool(ra, A, MODELS.api, 58_500, kind('Bash'), 3000, { isError: true })
  work(ra, A, MODELS.api, 62_500, 95_500)
  push(96_500, A, { kind: 'agent.end', reason: 'stop' })

  // docs-site: idles for a while, finishes, restarts as a new session.
  const D = claude('docs-site')
  const rd = rng('d')
  push(100, D, { kind: 'session.start', cwd: '~/code/docs-site', gitBranch: 'main', title: 'Update the docs', model: MODELS.docs })
  work(rd, D, MODELS.docs, 700, 24_000)
  push(25_000, D, { kind: 'activity', state: 'idle' })
  push(45_000, D, { kind: 'activity', state: 'thinking' })
  work(rd, D, MODELS.docs, 45_500, 68_000)
  push(70_000, D, { kind: 'agent.end', reason: 'stop' })
  const D2 = claude('docs-site', 'b')
  push(78_000, D2, { kind: 'session.start', cwd: '~/code/docs-site', gitBranch: 'main', title: 'Update the docs', model: MODELS.docs })
  work(rd, D2, MODELS.docs, 78_800, 95_000)
  push(97_500, D2, { kind: 'agent.end', reason: 'stop' })

  // deskmates: two parallel subagents (Explore, Plan); Plan fails.
  const K = claude('deskmates')
  const rk = rng('k')
  push(200, K, { kind: 'session.start', cwd: '~/code/deskmates', gitBranch: 'main', title: 'Plan the refactor', model: MODELS.dm })
  work(rk, K, MODELS.dm, 800, 27_000)
  const t1 = id()
  const t2 = id()
  push(27_450, K, { kind: 'activity', state: 'running' })
  push(27_500, K, { kind: 'tool.start', toolUseId: t1, name: 'Task', summary: 'Task: explore repo layout' })
  push(27_600, K, { kind: 'tool.start', toolUseId: t2, name: 'Task', summary: 'Task: plan the refactor' })
  const subs = [
    { agentId: 'explore-1', type: 'Explore', desc: 'Map the module structure', via: t1, till: 43_000, endAt: 44_000, reason: 'stop' as const, toolEnd: 44_300 },
    { agentId: 'plan-1', type: 'Plan', desc: 'Outline the migration steps', via: t2, till: 51_000, endAt: 52_000, reason: 'error' as const, toolEnd: 52_300 },
  ]
  for (const s of subs) {
    const ref: AgentRef = { ...K, agentId: s.agentId }
    const rs = rng(s.agentId)
    push(s.agentId === 'explore-1' ? 27_800 : 27_900, ref, { kind: 'agent.spawn', agentType: s.type, description: s.desc, viaToolUseId: s.via, depth: 1 })
    push(28_000, ref, { kind: 'session.start', cwd: '~/code/deskmates', model: MODELS.dm })
    work(rs, ref, MODELS.dm, 28_500, s.till)
    push(s.endAt, ref, { kind: 'agent.end', reason: s.reason })
    push(s.toolEnd, K, { kind: 'tool.end', toolUseId: s.via, isError: false })
  }
  work(rk, K, MODELS.dm, 53_500, 95_500)
  push(97_000, K, { kind: 'agent.end', reason: 'stop' })

  return out.sort((x, y) => x.ts - y.ts) // stable: ties keep script order
}

/**
 * Deterministic scripted loop. `advance(nowMs)` returns every event scheduled at or before nowMs not yet returned;
 * seq comes from an internal counter starting at 1, so batches feed `mirror.applyEvents` directly after `demoSnapshot()`.
 */
export function createDemo(opts: { seed?: string } = {}): { advance(nowMs: number): NormalizedEvent[] } {
  const seed = opts.seed ?? 'deskmates-demo'
  let loop = 0
  let queue: Draft[] = []
  let idx = 0
  let seq = 0
  return {
    advance(nowMs) {
      const out: NormalizedEvent[] = []
      for (;;) {
        if (idx >= queue.length) {
          if (loop * LOOP_MS > nowMs) break
          queue = buildLoop(seed, loop++)
          idx = 0
          continue
        }
        const d = queue[idx] as Draft
        if (d.ts > nowMs) break
        idx++
        out.push({ ...d, seq: ++seq } as NormalizedEvent)
      }
      return out
    },
  }
}
