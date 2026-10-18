import { describe, expect, it } from 'vitest'
import { EventBus, type NewEvent } from '../src/bus'

const agent = { provider: 'claude', sessionId: 's1' }
const act = (ts: number): NewEvent => ({ ts, agent, kind: 'activity', state: 'typing' })

describe('EventBus hardening (items 7, 12)', () => {
  it('a throwing reduce leaves seq, state and ring untouched and propagates', () => {
    const b = new EventBus()
    b.publish(act(1))
    const bad = { ts: 2, agent: null, kind: 'activity', state: 'idle' } as unknown as NewEvent
    expect(() => b.publish(bad)).toThrow()
    expect(b.seq()).toBe(1)
    expect(b.state().seq).toBe(1)
    expect(b.since(1)).toEqual([])
    expect(b.since(0)).toHaveLength(1)
    expect(b.publish(act(3)).seq).toBe(2)
  })

  it.each([[Number.NaN], [1.5], [-1], [99], [Infinity]])('since(%s) is a gap', (v) => {
    const b = new EventBus(); b.publish(act(1))
    expect(b.since(v)).toBe('gap')
  })

  it('the same function subscribed twice is removable independently', () => {
    const b = new EventBus(); let calls = 0
    const fn = () => { calls++ }
    const u1 = b.subscribe(fn); const u2 = b.subscribe(fn)
    b.publish(act(1)); expect(calls).toBe(2)
    u1(); u1(); b.publish(act(2)); expect(calls).toBe(3)
    u2(); b.publish(act(3)); expect(calls).toBe(3)
  })

  it('a re-entrant publish is delivered after the current event to every subscriber', () => {
    const b = new EventBus(); const log: string[] = []
    b.subscribe((e) => { log.push(`A${e.seq}`); if (e.seq === 1) b.publish(act(2)) })
    b.subscribe((e) => log.push(`B${e.seq}`))
    b.publish(act(1))
    expect(log).toEqual(['A1', 'B1', 'A2', 'B2'])
    expect(b.seq()).toBe(2)
  })

  it('stats reports seq, subscribers and subscriber errors', () => {
    const b = new EventBus()
    const u = b.subscribe(() => { throw new Error('x') }); b.subscribe(() => {})
    b.publish(act(1)); b.publish(act(2))
    expect(b.stats()).toEqual({ seq: 2, subscribers: 2, subscriberErrors: 2 })
    u(); expect(b.stats().subscribers).toBe(1)
  })
})
