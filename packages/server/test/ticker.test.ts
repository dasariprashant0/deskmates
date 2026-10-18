import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/bus'
import { startTicker, tick } from '../src/ticker'

const ag = { provider: 'claude', sessionId: 's1' }
const setup = (name = 'Read', t0 = 1000) => {
  const bus = new EventBus()
  bus.publish({ ts: t0, agent: ag, kind: 'session.start', cwd: '/w' })
  bus.publish({ ts: t0, agent: ag, kind: 'tool.start', toolUseId: 't1', name, summary: '' })
  return bus
}
const kinds = (bus: EventBus) => {
  const e = bus.since(0)
  return e === 'gap' ? [] : e.map((x) => x.kind)
}

describe('tick', () => {
  it('fires attention after 8s of an open Read, not before', () => {
    const bus = setup()
    expect(tick({ bus, now: () => 1000 + 8000 })).toBe(0)
    expect(tick({ bus, now: () => 1000 + 8001 })).toBe(1)
    const last = bus.since(2)
    expect(last === 'gap' ? last : last[0]).toMatchObject({ kind: 'attention', source: 'heuristic', toolUseId: 't1', ts: 9001 })
    expect(bus.state().agents['claude:s1:main']?.status).toBe('waiting')
  })

  it('fires once across many ticks', () => {
    const bus = setup()
    let total = 0
    for (let i = 0; i < 20; i++) total += tick({ bus, now: () => 20_000 + i * 1000 })
    expect(total).toBe(1)
  })

  it('does not refire after attention was resolved', () => {
    const bus = setup()
    tick({ bus, now: () => 20_000 })
    bus.publish({ ts: 20_001, agent: ag, kind: 'attention.resolved', toolUseId: 't1' })
    expect(tick({ bus, now: () => 30_000 })).toBe(0)
  })

  it('Bash waits 60s', () => {
    const bus = setup('Bash')
    expect(tick({ bus, now: () => 1000 + 59_000 })).toBe(0)
    expect(tick({ bus, now: () => 1000 + 60_001 })).toBe(1)
  })

  it('Agent never raises attention', () => {
    const bus = setup('Agent')
    expect(tick({ bus, now: () => 1000 + 10 * 60_000 })).toBe(0)
  })

  it('honours a custom attentionAfterMs', () => {
    const bus = setup('Read')
    expect(tick({ bus, now: () => 1500, attentionAfterMs: () => 100 })).toBe(1)
  })

  it.each(['stop', 'error'] as const)('skips an agent that ended with %s', (reason) => {
    const bus = setup()
    bus.publish({ ts: 1100, agent: ag, kind: 'agent.end', reason })
    expect(tick({ bus, now: () => 20_000 })).toBe(0)
    expect(kinds(bus)).not.toContain('attention')
  })

  it('marks an agent idle-ended after 30 minutes, once', () => {
    const bus = new EventBus()
    bus.publish({ ts: 0, agent: ag, kind: 'session.start', cwd: '/w' })
    expect(tick({ bus, now: () => 30 * 60_000 })).toBe(0)
    expect(tick({ bus, now: () => 30 * 60_000 + 1 })).toBe(1)
    const e = bus.since(1)
    expect(e === 'gap' ? e : e[0]).toMatchObject({ kind: 'agent.end', reason: 'idle', ts: 30 * 60_000 + 1 })
    expect(tick({ bus, now: () => 60 * 60_000 })).toBe(0)
  })

  it('does not idle-end an agent already ended', () => {
    const bus = new EventBus()
    bus.publish({ ts: 0, agent: ag, kind: 'session.start', cwd: '/w' })
    bus.publish({ ts: 1, agent: ag, kind: 'agent.end', reason: 'stop' })
    expect(tick({ bus, now: () => 99 * 60_000 })).toBe(0)
  })
})

describe('startTicker', () => {
  it('runs ticks until stopped', async () => {
    const bus = setup()
    const t = startTicker({ bus, now: () => 20_000, intervalMs: 5 })
    await new Promise((r) => setTimeout(r, 50))
    t.stop()
    expect(kinds(bus).filter((k) => k === 'attention')).toHaveLength(1)
  })
})
