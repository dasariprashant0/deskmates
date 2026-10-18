import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type NewEvent } from '../src/bus'
import { startTicker } from '../src/ticker'

afterEach(() => { vi.useRealTimers() })

const a1 = { provider: 'claude', sessionId: 's1' }
const a2 = { provider: 'claude', sessionId: 's2' }

class ThrowingBus extends EventBus {
  err: unknown = undefined
  override publish(e: NewEvent) {
    if (this.err !== undefined && e.kind === 'attention' && e.agent.sessionId === 's1') throw this.err
    return super.publish(e)
  }
}

const mk = (err?: unknown) => {
  const bus = new ThrowingBus()
  bus.publish({ ts: 0, agent: a1, kind: 'tool.start', toolUseId: 't1', name: 'Read', summary: '' })
  bus.publish({ ts: 0, agent: a2, kind: 'tool.start', toolUseId: 't2', name: 'Read', summary: '' })
  bus.err = err
  return bus
}
const attn = (bus: EventBus, s: string) => bus.state().agents[`claude:${s}:main`]?.attention

const run = (bus: EventBus, onError?: (c: string) => void) => {
  vi.useFakeTimers()
  const t = startTicker({ bus, now: () => 20_000, intervalMs: 10, onError })
  return t
}

describe('ticker round 3: per-publish isolation', () => {
  it('a throwing publish for one agent does not starve the next, is counted safely, and retries', () => {
    const bus = mk(Object.assign(new Error('secret content'), { code: 'EBOOM' }))
    const codes: string[] = []
    const t = run(bus, (c) => codes.push(c))
    vi.advanceTimersByTime(10)
    expect(attn(bus, 's2')).toBeDefined()
    expect(attn(bus, 's1')).toBeUndefined()
    expect(t.stats().errors).toEqual({ EBOOM: 1 })
    expect(codes).toEqual(['EBOOM'])
    bus.err = undefined
    vi.advanceTimersByTime(10)
    t.stop()
    expect(attn(bus, 's1')).toBeDefined()
    expect(t.stats().lastTickAt).toBe(20_000)
  })

  it('a throwing onError does not break the tick', () => {
    const bus = mk(new TypeError('x'))
    const t = run(bus, () => { throw new Error('onError boom') })
    vi.advanceTimersByTime(10)
    t.stop()
    expect(attn(bus, 's2')).toBeDefined()
    expect(t.stats().errors).toEqual({ TypeError: 1 })
    expect(t.stats().lastTickAt).toBe(20_000)
  })

  it.each([
    ['spaces', 'has some spaces'],
    ['500 chars', 'x'.repeat(500)],
    ['a path', '/Users/me/secret.txt'],
  ])('hostile error code (%s) buckets as OTHER', (_n, code) => {
    const bus = mk(Object.assign(new Error('m'), { code }))
    const t = run(bus)
    vi.advanceTimersByTime(10)
    t.stop()
    expect(t.stats().errors).toEqual({ OTHER: 1 })
  })
})
