import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type NewEvent } from '../src/bus'
import { startTicker, tick } from '../src/ticker'

const ag = { provider: 'claude', sessionId: 's1' }
afterEach(() => { vi.useRealTimers() })

class FlakyBus extends EventBus {
  fail = true
  override publish(e: NewEvent) {
    if (this.fail && e.kind === 'attention') { this.fail = false; throw new Error('boom') }
    return super.publish(e)
  }
}

describe('ticker hardening (item 9)', () => {
  it('a failed publish is retried on the next tick (flag set only after success)', () => {
    const bus = new FlakyBus()
    bus.publish({ ts: 0, agent: ag, kind: 'tool.start', toolUseId: 't1', name: 'Read', summary: '' })
    expect(() => tick({ bus, now: () => 20_000 })).toThrow()
    expect(tick({ bus, now: () => 21_000 })).toBe(1)
  })

  it.each(['stop', 'error'] as const)('agents ended with %s never raise attention, however old the tool', (reason) => {
    const bus = new EventBus()
    bus.publish({ ts: 0, agent: ag, kind: 'tool.start', toolUseId: 't1', name: 'Read', summary: '' })
    bus.publish({ ts: 1, agent: ag, kind: 'agent.end', reason })
    expect(['done', 'error']).toContain(bus.state().agents['claude:s1:main']?.status)
    expect(tick({ bus, now: () => 25_000 })).toBe(0)
    expect(bus.state().agents['claude:s1:main']?.attention).toBeUndefined()
  })

  it('startTicker returns stop and stats, counting ticks', () => {
    vi.useFakeTimers()
    const bus = new EventBus()
    const t = startTicker({ bus, now: () => 5, intervalMs: 10 })
    vi.advanceTimersByTime(35)
    t.stop(); vi.advanceTimersByTime(100)
    expect(t.stats()).toMatchObject({ ticks: 3, errors: {}, lastTickAt: 5 })
  })

  it('a throwing tick increments errors and calls onError, never throws', () => {
    vi.useFakeTimers()
    const codes: string[] = []
    const t = startTicker({ bus: new EventBus(), now: () => { throw new TypeError('x') }, intervalMs: 10, onError: (c) => codes.push(c) })
    vi.advanceTimersByTime(25)
    t.stop()
    expect(t.stats().errors).toEqual({ TypeError: 2 })
    expect(codes).toEqual(['TypeError', 'TypeError'])
  })
})
