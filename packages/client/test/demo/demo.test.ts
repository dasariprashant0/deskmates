import { reduce, type AgentStatus, type NormalizedEvent, type OfficeState } from '@deskmates/core'
import { describe, expect, test } from 'vitest'
import { createMirror } from '../../src/net'
import { createDemo, demoSnapshot } from '../../src/demo'
import { createSim } from '../../src/sim'

const STEP = 250
const run = (seed: string | undefined, ms: number): NormalizedEvent[] => {
  const d = createDemo(seed === undefined ? undefined : { seed })
  const out: NormalizedEvent[] = []
  for (let t = 0; t <= ms; t += STEP) out.push(...d.advance(t))
  return out
}

describe('demo', () => {
  const evs = run('s', 300_000)

  test('snapshot is empty and valid', () => {
    const s = demoSnapshot()
    expect(s).toMatchObject({ type: 'snapshot', v: 1, seq: 0, prices: {}, pricesAreExample: true })
    expect(Object.keys(s.state.agents)).toEqual([])
  })

  test('deterministic, and seed matters', () => {
    expect(run('s', 120_000)).toEqual(run('s', 120_000))
    expect(run('s', 120_000)).not.toEqual(run('other', 120_000))
    expect(run(undefined, 50_000)).toEqual(run(undefined, 50_000))
  })

  test('advance returns events up to t, once; step size does not change the stream', () => {
    const d = createDemo({ seed: 's' })
    const a = d.advance(30_000)
    expect(a.length).toBeGreaterThan(20)
    expect(a.every((e) => e.ts <= 30_000)).toBe(true)
    expect(d.advance(30_000)).toEqual([])
    const coarse = [...a, ...d.advance(300_000)]
    expect(coarse).toEqual(evs)
  })

  test('seq contiguous from 1, ts non-decreasing, folds without throwing', () => {
    expect(evs.length).toBeGreaterThan(500)
    evs.forEach((e, i) => expect(e.seq).toBe(i + 1))
    for (let i = 1; i < evs.length; i++) expect((evs[i] as NormalizedEvent).ts).toBeGreaterThanOrEqual((evs[i - 1] as NormalizedEvent).ts)
    let s: OfficeState = demoSnapshot().state
    expect(() => { for (const e of evs) s = reduce(s, e) }).not.toThrow()
  })

  test('tool.end only for a started tool, spawn before child events, one error flash per loop', () => {
    const open = new Set<string>()
    const seenTool = new Set<string>()
    const spawned = new Set<string>()
    let errors = 0
    for (const e of evs) {
      const id = `${e.agent.sessionId}/${e.agent.agentId ?? 'main'}`
      if (e.kind === 'tool.start') { open.add(e.toolUseId); seenTool.add(e.toolUseId) }
      if (e.kind === 'tool.end') {
        expect(open.has(e.toolUseId)).toBe(true)
        open.delete(e.toolUseId)
        if (e.isError) errors++
      }
      if (e.kind === 'agent.spawn') spawned.add(id)
      else if (e.agent.agentId !== undefined) expect(spawned.has(id)).toBe(true)
    }
    expect(errors).toBe(3)
  })

  test('tool variety: names, labels, short and long durations, attention', () => {
    const names = new Set<string>()
    const started = new Map<string, number>()
    const durs: number[] = []
    let attention = 0
    let resolved = 0
    for (const e of evs) {
      if (e.kind === 'tool.start') { names.add(e.name); if (e.name !== 'Task') started.set(e.toolUseId, e.ts) } // Task spans its subagents
      if (e.kind === 'tool.end' && started.has(e.toolUseId)) durs.push(e.ts - (started.get(e.toolUseId) ?? e.ts))
      if (e.kind === 'attention') { attention++; expect(e.source).toBe('heuristic') }
      if (e.kind === 'attention.resolved') resolved++
    }
    for (const n of ['Read', 'Grep', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']) expect(names.has(n)).toBe(true)
    expect(evs.some((e) => e.kind === 'tool.start' && e.summary === 'Read: router.ts' || e.kind === 'tool.start' && e.summary.startsWith('Read: '))).toBe(true)
    expect(evs.some((e) => e.kind === 'tool.start' && e.summary === 'Bash: pnpm')).toBe(true)
    expect(Math.min(...durs)).toBeGreaterThanOrEqual(1000)
    expect(Math.min(...durs)).toBeLessThan(3000)
    expect(Math.max(...durs)).toBeGreaterThanOrEqual(6000)
    expect(Math.max(...durs)).toBeLessThanOrEqual(9500)
    expect(attention).toBe(3)
    expect(resolved).toBe(3)
  })

  test('covers every status, 4+ agents with 2 subagents alive together, three projects', () => {
    const seen = new Set<AgentStatus>()
    let s: OfficeState = demoSnapshot().state
    let best = 0
    let bestSubs = 0
    for (const e of evs.filter((x) => x.ts < 100_000)) {
      s = reduce(s, e)
      const alive = Object.values(s.agents).filter((a) => a.endedAt === undefined)
      best = Math.max(best, alive.length)
      bestSubs = Math.max(bestSubs, alive.filter((a) => a.parentKey !== undefined).length)
      for (const a of Object.values(s.agents)) seen.add(a.status)
    }
    for (const st of ['working', 'thinking', 'waiting', 'error', 'done', 'idle'] as const) expect(seen.has(st)).toBe(true)
    expect(best).toBeGreaterThanOrEqual(4)
    expect(bestSubs).toBe(2)
    const cwds = new Set(evs.flatMap((e) => (e.kind === 'session.start' ? [e.cwd] : [])))
    expect([...cwds].sort()).toEqual(['~/code/api-gateway', '~/code/deskmates', '~/code/docs-site'])
    const types = evs.flatMap((e) => (e.kind === 'agent.spawn' ? [e.agentType] : []))
    expect(new Set(types)).toEqual(new Set(['Explore', 'Plan']))
    expect(evs.every((e) => e.agent.provider === 'claude')).toBe(true)
  })

  test('loops repeat with fresh session ids; usage grows', () => {
    const sessions = new Set(evs.map((e) => e.agent.sessionId))
    expect(sessions.size).toBeGreaterThan(9)
    const loop0 = new Set(evs.filter((e) => e.ts < 100_000).map((e) => e.agent.sessionId))
    const loop1 = new Set(evs.filter((e) => e.ts >= 100_000 && e.ts < 200_000).map((e) => e.agent.sessionId))
    for (const id of loop1) expect(loop0.has(id)).toBe(false)
    expect(evs.filter((e) => e.kind === 'usage').length).toBeGreaterThan(30)
  })

  test('feeds the mirror and the slice-1A sim', () => {
    const d = createDemo({ seed: 'sim' })
    const m = createMirror()
    m.applySnapshot(demoSnapshot())
    const sim = createSim()
    let maxChars = 0
    for (let t = 0; t <= 60_000; t += 100) {
      const batch = d.advance(t)
      const first = batch[0]
      const lastEv = batch[batch.length - 1]
      if (first && lastEv) expect(m.applyEvents({ type: 'events', fromSeq: first.seq, toSeq: lastEv.seq, events: batch })).toBe('ok')
      expect(() => { sim.sync(m.state(), t); sim.step(100) }).not.toThrow()
      maxChars = Math.max(maxChars, sim.characters().length)
    }
    expect(maxChars).toBeGreaterThan(1)
  })
})
