import { describe, expect, it } from 'vitest'
import { agentKey, emptyState, needsYou, reduce, type AgentRef, type NormalizedEvent, type OfficeState } from '../src/index'
import { ev, fold, main, type Body } from './helpers'

const mainOf = (s: OfficeState) => s.agents[agentKey(main)]!
const needsYouKeys = (s: OfficeState) => needsYou(s).map((a) => a.key)
const start = (id: string, ts?: number) => ev({ kind: 'tool.start', toolUseId: id, name: 'N', summary: id }, main, ts)
const end = (id: string, isError = false, ts?: number) => ev({ kind: 'tool.end', toolUseId: id, isError }, main, ts)
const attn = (id: string, ts?: number) => ev({ kind: 'attention', toolUseId: id, source: 'heuristic' }, main, ts)

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    Object.values(o).forEach(deepFreeze)
  }
  return o
}

describe('agent creation', () => {
  it('agentKey format is stable', () => {
    expect(agentKey(main)).toBe('claude:s1:main')
    expect(agentKey({ ...main, agentId: 'a7' })).toBe('claude:s1:a7')
  })

  it('creates an agent on first event', () => {
    const s = fold([ev({ kind: 'session.start', cwd: '/p', gitBranch: 'b', title: 't', model: 'm' }, main, 5)])
    expect(mainOf(s)).toMatchObject({
      key: 'claude:s1:main', cwd: '/p', gitBranch: 'b', title: 't', model: 'm', status: 'idle', activity: 'idle',
      openTools: {}, openOrder: [], children: [], startedAt: 5, lastEventAt: 5,
      usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    })
    expect(s.order).toEqual(['claude:s1:main'])
  })
})

describe('tools', () => {
  it('two parallel tools: ending one falls back to the other', () => {
    let s = fold([start('t1'), start('t2')])
    expect(mainOf(s).status).toBe('working')
    expect(mainOf(s).currentTool?.toolUseId).toBe('t2')
    s = fold([end('t2')], s)
    expect(mainOf(s).currentTool?.toolUseId).toBe('t1')
    expect(Object.keys(mainOf(s).openTools)).toEqual(['t1'])
    s = fold([end('t1')], s)
    expect(mainOf(s).currentTool).toBeUndefined()
    expect(mainOf(s).openTools).toEqual({})
  })

  it('currentTool does not depend on object key order (integer-like ids)', () => {
    let s = fold([start('2'), start('1')])
    expect(mainOf(s).currentTool?.toolUseId).toBe('1')
    s = fold([end('1')], s)
    expect(mainOf(s).currentTool?.toolUseId).toBe('2')
  })

  it('restarting a tool with the same id makes it the current one', () => {
    let s = fold([start('t1', 1), start('t2', 2), start('t1', 3)])
    expect(mainOf(s).currentTool).toMatchObject({ toolUseId: 't1', startedAt: 3 })
    expect(Object.keys(mainOf(s).openTools).sort()).toEqual(['t1', 't2'])
    s = fold([end('t1')], s)
    expect(mainOf(s).currentTool?.toolUseId).toBe('t2')
  })

  it('tool.end with isError sets lastError', () => {
    const s = fold([start('t1'), end('t1', true, 9000)])
    expect(mainOf(s).lastError).toEqual({ toolUseId: 't1', at: 9000 })
  })

  it('tool.end clears attention on that tool', () => {
    const s = fold([start('t1'), attn('t1'), end('t1', true)])
    expect(mainOf(s).attention).toBeUndefined()
    expect(mainOf(s).status).toBe('idle')
  })

  it('tool.end for an unopened id still clears attention pointing at it and recomputes status', () => {
    const s = fold([attn('ghost'), end('ghost')])
    expect(mainOf(s).attention).toBeUndefined()
    expect(mainOf(s).status).toBe('idle')
  })

  it('tool.end for an unknown id leaves other pending attention alone', () => {
    const s = fold([start('t1'), attn('t1'), end('nope', true)])
    expect(mainOf(s).attention?.toolUseId).toBe('t1')
    expect(mainOf(s).status).toBe('waiting')
    expect(mainOf(s).lastError).toBeUndefined()
  })

  it('attention survives ending a different tool; ending the attended one goes idle', () => {
    let s = fold([start('t1'), start('t2'), attn('t1')])
    s = fold([end('t2')], s)
    expect(mainOf(s).attention?.toolUseId).toBe('t1')
    expect(mainOf(s).status).toBe('waiting')
    s = fold([end('t1')], s)
    expect(mainOf(s).status).toBe('idle')
  })

  it('tool.start while attention is pending keeps status waiting', () => {
    const s = fold([start('t1'), attn('t1'), start('t2')])
    expect(mainOf(s).status).toBe('waiting')
  })
})

describe('terminal status is sticky', () => {
  const stop = () => ev({ kind: 'agent.end', reason: 'stop' }, main, 500)
  const resolved = (id: string) => ev({ kind: 'attention.resolved', toolUseId: id })

  it('attention then resolved after agent.end(stop) ends done with endedAt', () => {
    const s = fold([stop(), attn('t1'), resolved('t1')])
    expect(mainOf(s)).toMatchObject({ status: 'done', endedAt: 500 })
    expect(mainOf(s).attention).toBeUndefined()
  })

  it('attention after agent.end is recorded but status stays done', () => {
    const s = fold([stop(), attn('t1')])
    expect(mainOf(s).status).toBe('done')
    expect(mainOf(s).attention?.toolUseId).toBe('t1')
  })

  it('a matching tool.end keeps the terminal status', () => {
    const s = fold([stop(), start('t1'), attn('t1'), end('t1')])
    expect(mainOf(s).status).toBe('done')
    expect(mainOf(s).attention).toBeUndefined()
  })

  it('tool.start after agent.end keeps the terminal status', () => {
    expect(mainOf(fold([stop(), start('t1')])).status).toBe('done')
  })

  it('agent.end error stays error through later events', () => {
    const s = fold([ev({ kind: 'agent.end', reason: 'error' }), start('t1'), attn('t1'), resolved('t1'), ev({ kind: 'activity', state: 'typing' })])
    expect(mainOf(s).status).toBe('error')
  })
})

describe('status transitions', () => {
  it('ending the last tool does not change status; only activity/tool.start/attention/agent.end do', () => {
    const s = fold([start('t1'), end('t1')])
    expect(mainOf(s).openTools).toEqual({})
    expect(mainOf(s).status).toBe('working')
  })

  it("resolved restores 'working' or 'idle', never 'thinking'", () => {
    const s = fold([ev({ kind: 'activity', state: 'thinking' }), attn('t1'), ev({ kind: 'attention.resolved', toolUseId: 't1' })])
    expect(mainOf(s).status).toBe('idle')
  })
})

describe('attention', () => {
  it('resolved clears attention and returns to working or idle', () => {
    let s = fold([start('z'), attn('z'), ev({ kind: 'attention.resolved', toolUseId: 'z', decision: 'allow' })])
    expect(mainOf(s).attention).toBeUndefined()
    expect(mainOf(s).status).toBe('working')
    s = fold([end('z'), attn('q'), ev({ kind: 'attention.resolved', toolUseId: 'q' })], s)
    expect(mainOf(s).status).toBe('idle')
  })

  it('needsYou orders oldest first and excludes resolved agents', () => {
    const b: AgentRef = { provider: 'claude', sessionId: 's2' }
    const c: AgentRef = { provider: 'claude', sessionId: 's3' }
    const a = (agent: AgentRef, id: string, ts: number) => ev({ kind: 'attention', toolUseId: id, source: 'hook' }, agent, ts)
    let s = fold([a(c, 'x', 50), a(b, 'y', 20), a(main, 'z', 30)])
    expect(needsYouKeys(s)).toEqual([agentKey(b), agentKey(main), agentKey(c)])
    s = fold([ev({ kind: 'attention.resolved', toolUseId: 'z' })], s)
    expect(needsYouKeys(s)).toEqual([agentKey(b), agentKey(c)])
  })

  it('needsYou with equal since keeps creation order', () => {
    const b: AgentRef = { provider: 'claude', sessionId: 's2' }
    const c: AgentRef = { provider: 'claude', sessionId: 's3' }
    const a = (agent: AgentRef) => ev({ kind: 'attention', toolUseId: 'x', source: 'hook' }, agent, 100)
    expect(needsYouKeys(fold([a(c), a(main), a(b)]))).toEqual([agentKey(c), agentKey(main), agentKey(b)])
  })
})

describe('other events', () => {
  it('usage accumulates and records model', () => {
    const s = fold([
      ev({ kind: 'usage', model: 'm1', input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }),
      ev({ kind: 'usage', model: 'm2', input: 10, cacheWrite: 20, cacheRead: 30, output: 40 }),
    ])
    expect(mainOf(s).usage).toEqual({ input: 11, cacheWrite: 22, cacheRead: 33, output: 44 })
    expect(mainOf(s).model).toBe('m2')
  })

  it('activity maps to status', () => {
    let s = fold([ev({ kind: 'activity', state: 'thinking' })])
    expect(mainOf(s).status).toBe('thinking')
    s = fold([ev({ kind: 'activity', state: 'editing' })], s)
    expect(mainOf(s)).toMatchObject({ status: 'working', activity: 'editing' })
    s = fold([ev({ kind: 'activity', state: 'idle' })], s)
    expect(mainOf(s).status).toBe('idle')
  })

  it('activity does not override waiting', () => {
    const s = fold([start('t'), attn('t'), ev({ kind: 'activity', state: 'thinking' })])
    expect(mainOf(s)).toMatchObject({ status: 'waiting', activity: 'thinking' })
  })

  it('late activity after agent.end updates activity but keeps the terminal status', () => {
    const s = fold([ev({ kind: 'agent.end', reason: 'stop' }), ev({ kind: 'activity', state: 'typing' })])
    expect(mainOf(s)).toMatchObject({ status: 'done', activity: 'typing' })
  })

  it.each([['stop', 'done'], ['idle', 'idle'], ['error', 'error']] as const)('agent.end %s -> %s with endedAt', (reason, status) => {
    expect(mainOf(fold([ev({ kind: 'agent.end', reason }, main, 77)]))).toMatchObject({ status, endedAt: 77 })
  })

  it('message events change only lastEventAt and seq', () => {
    const base = fold([start('t')])
    const after = reduce(base, ev({ kind: 'message', role: 'user', chars: 5 }, main, 424242))
    expect(mainOf(after)).toEqual({ ...mainOf(base), lastEventAt: 424242 })
    expect(after.seq).toBeGreaterThan(base.seq)
  })

  it('seq and lastEventAt never move backwards on out-of-order events', () => {
    const late = { ...ev({ kind: 'message', role: 'user', chars: 1 }, main, 100), seq: 1 }
    const s = reduce(fold([ev({ kind: 'message', role: 'user', chars: 1 }, main, 5000)]), late)
    expect(mainOf(s).lastEventAt).toBe(5000)
    expect(s.seq).toBeGreaterThan(1)
  })
})

describe('spawn', () => {
  const k1: AgentRef = { ...main, agentId: 'k1' }
  const k2: AgentRef = { ...main, agentId: 'k2' }
  const g: AgentRef = { ...main, agentId: 'g', parentAgentId: 'k1' }
  const spawn = (a: AgentRef) => ev({ kind: 'agent.spawn', agentType: 'Explore', description: 'd', depth: 1 }, a)

  it('links parent and child and keeps child order stable', () => {
    const s = fold([spawn(k1), spawn(k2), spawn(g)])
    expect(mainOf(s).children).toEqual(['claude:s1:k1', 'claude:s1:k2'])
    expect(s.agents['claude:s1:k1']).toMatchObject({
      parentKey: 'claude:s1:main', spawnDescription: 'd', agentType: 'Explore', children: ['claude:s1:g'],
    })
    expect(s.agents['claude:s1:g']!.parentKey).toBe('claude:s1:k1')
    expect(s.order).toEqual(['claude:s1:main', 'claude:s1:k1', 'claude:s1:k2', 'claude:s1:g'])
  })

  it('spawning the same child twice does not duplicate', () => {
    const s = fold([spawn(k1), spawn(k2), spawn(k1)])
    expect(mainOf(s).children).toEqual(['claude:s1:k1', 'claude:s1:k2'])
    expect(s.order).toHaveLength(3)
  })
})

describe('robustness', () => {
  it('unknown event kind returns the same state', () => {
    const base = fold([start('t')])
    expect(reduce(base, ev({ kind: 'bogus' } as unknown as Body))).toBe(base)
    expect(reduce(base, ev({ kind: 'toString' } as unknown as Body))).toBe(base)
  })

  it('out-of-order tool.end only touches lastEventAt and seq', () => {
    const base = fold([start('t')])
    const after = reduce(base, end('nope', true, 99999999))
    expect(mainOf(after)).toEqual({ ...mainOf(base), lastEventAt: 99999999 })
    expect(() => fold([end('a')])).not.toThrow()
  })

  it('never mutates its input', () => {
    let s = deepFreeze(fold([ev({ kind: 'session.start', cwd: '/p' })]))
    const events = [
      start('t'),
      attn('t'),
      ev({ kind: 'agent.spawn', depth: 1 }, { ...main, agentId: 'c' }),
      ev({ kind: 'usage', model: 'm', input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }),
      end('t', true),
      ev({ kind: 'agent.end', reason: 'stop' }),
    ].map(deepFreeze)
    for (const e of events) {
      const next = reduce(s, e)
      expect(next).not.toBe(s)
      s = deepFreeze(next)
    }
  })

  it('keeps `order` referentially stable when no agent is added', () => {
    const base = fold([start('t')])
    expect(reduce(base, end('t')).order).toBe(base.order)
  })
})

describe('properties', () => {
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const genEvents = (seed: number): NormalizedEvent[] => {
    const r = rng(seed)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
    const agents: AgentRef[] = [main, { ...main, agentId: 'a' }, { ...main, agentId: 'b', parentAgentId: 'a' }, { provider: 'claude', sessionId: 's2' }]
    const bodies: Array<() => Body> = [
      () => ({ kind: 'session.start', cwd: pick(['/a', '/b']) }),
      () => ({ kind: 'agent.spawn', depth: 1 }),
      () => ({ kind: 'agent.end', reason: pick(['stop', 'idle', 'error'] as const) }),
      () => ({ kind: 'activity', state: pick(['thinking', 'typing', 'idle', 'editing'] as const) }),
      () => ({ kind: 'tool.start', toolUseId: pick(['1', '2', '3']), name: 'N', summary: 's' }),
      () => ({ kind: 'tool.end', toolUseId: pick(['1', '2', '3']), isError: r() < 0.5 }),
      () => ({ kind: 'attention', toolUseId: pick(['1', '2', '3']), source: 'heuristic' }),
      () => ({ kind: 'attention.resolved', toolUseId: pick(['1', '2', '3']) }),
      () => ({ kind: 'usage', model: 'm', input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }),
      () => ({ kind: 'message', role: 'user', chars: 3 }),
    ]
    const len = 5 + Math.floor(r() * 40)
    return Array.from({ length: len }, (_, i) => ({ seq: i, ts: i * 10, agent: pick(agents), ...pick(bodies)() }))
  }

  const checkInvariants = (s: OfficeState, usageEvents: number) => {
    const keys = Object.keys(s.agents)
    expect(new Set(s.order).size).toBe(s.order.length)
    expect([...s.order].sort()).toEqual([...keys].sort())
    let total = 0
    for (const a of Object.values(s.agents)) {
      if (a.status !== 'done' && a.status !== 'error') expect(a.status === 'waiting').toBe(a.attention !== undefined)
      if (a.currentTool) expect(a.openTools).toHaveProperty([a.currentTool.toolUseId])
      expect([...a.openOrder].sort()).toEqual(Object.keys(a.openTools).sort())
      for (const c of a.children) expect(s.agents[c]).toBeDefined()
      if (a.parentKey) expect(s.agents[a.parentKey]).toBeDefined()
      total += a.usage.input + a.usage.cacheWrite + a.usage.cacheRead + a.usage.output
    }
    expect(total).toBe(usageEvents * 10)
  }

  it('invariants hold after every step of 200 seeded sequences', () => {
    for (let seed = 1; seed <= 200; seed++) {
      let s = emptyState()
      let usageEvents = 0
      for (const e of genEvents(seed)) {
        s = reduce(s, e)
        if (e.kind === 'usage') usageEvents++
        checkInvariants(s, usageEvents)
      }
    }
  })

  it('one fold equals two chunked folds and is deterministic', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const events = genEvents(seed)
      const cut = seed % (events.length + 1)
      const whole = fold(events)
      expect(fold(events.slice(cut), fold(events.slice(0, cut)))).toEqual(whole)
      expect(fold(events)).toEqual(whole)
    }
  })
})
