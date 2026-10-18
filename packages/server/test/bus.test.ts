import { emptyState, reduce, type NormalizedEvent } from '@deskmates/core'
import { describe, expect, it } from 'vitest'
import { EventBus, type NewEvent } from '../src/bus'

const agent = { provider: 'claude', sessionId: 's1' }
const act = (ts: number): NewEvent => ({ ts, agent, kind: 'activity', state: 'typing' })

describe('EventBus', () => {
  it('assigns monotonic seq from 1', () => {
    const b = new EventBus()
    expect([b.publish(act(1)).seq, b.publish(act(2)).seq, b.publish(act(3)).seq]).toEqual([1, 2, 3])
    expect(b.seq()).toBe(3)
  })

  it('since returns events, [] at head, gap when evicted', () => {
    const b = new EventBus({ capacity: 3 })
    for (let i = 0; i < 10; i++) b.publish(act(i))
    expect(b.since(10)).toEqual([])
    const tail = b.since(7)
    expect(tail === 'gap' ? tail : tail.map((e) => e.seq)).toEqual([8, 9, 10])
    expect(b.since(8)).toHaveLength(2)
    expect(b.since(6)).toBe('gap')
    expect(b.since(0)).toBe('gap')
    expect(b.since(11)).toBe('gap')
  })

  it('since(0) returns everything while the ring holds it', () => {
    const b = new EventBus()
    expect(b.since(0)).toEqual([])
    b.publish(act(1)); b.publish(act(2))
    expect(b.since(0)).toHaveLength(2)
  })

  it('state equals the reduce fold of published events', () => {
    const b = new EventBus({ capacity: 2 })
    const evs: NormalizedEvent[] = [
      b.publish({ ts: 1, agent, kind: 'session.start', cwd: '/w' }),
      b.publish({ ts: 2, agent, kind: 'tool.start', toolUseId: 't1', name: 'Read', summary: 'x' }),
      b.publish({ ts: 3, agent, kind: 'tool.end', toolUseId: 't1', isError: false }),
      b.publish({ ts: 4, agent: { ...agent, agentId: 'a' }, kind: 'agent.spawn', depth: 1 }),
    ]
    expect(b.state()).toEqual(evs.reduce(reduce, emptyState()))
  })

  it('supports subscribe and unsubscribe, in order, synchronously', () => {
    const b = new EventBus(); const log: string[] = []
    const u1 = b.subscribe((e) => log.push(`a${e.seq}`)); b.subscribe((e) => log.push(`b${e.seq}`))
    b.publish(act(1)); u1(); b.publish(act(2))
    expect(log).toEqual(['a1', 'b1', 'b2'])
  })

  it('a throwing subscriber does not break publish or the others', () => {
    const b = new EventBus(); const got: number[] = []
    b.subscribe(() => { throw new Error('boom') }); b.subscribe((e) => got.push(e.seq))
    expect(b.publish(act(1)).seq).toBe(1)
    expect(got).toEqual([1])
  })
})
