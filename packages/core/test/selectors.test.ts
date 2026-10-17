import { describe, expect, it } from 'vitest'
import { agentKey, costUsd, emptyState, EXAMPLE_PRICES, reduce, roomsByCwd, type AgentRef, type OfficeState } from '../src/index'
import { ev, fold, main } from './helpers'

const sub: AgentRef = { ...main, agentId: 'k' }
const other: AgentRef = { provider: 'claude', sessionId: 's2' }

describe('costUsd', () => {
  const usage = (model: string) => ev({ kind: 'usage', model, input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 })
  it('returns a number for a priced model and undefined for an unpriced one', () => {
    const prices = { m: { inputPerMTok: 1, cacheWritePerMTok: 2, cacheReadPerMTok: 0.5, outputPerMTok: 5 } }
    expect(costUsd(reduce(emptyState(), usage('m')).agents[agentKey(main)]!, prices)).toBeCloseTo(8.5)
    const unpriced = reduce(emptyState(), usage('nope')).agents[agentKey(main)]!
    expect(costUsd(unpriced, prices)).toBeUndefined()
    expect(costUsd(unpriced, EXAMPLE_PRICES)).toBeUndefined()
  })
  it('agent without model is undefined', () => {
    const a = fold([ev({ kind: 'message', role: 'user', chars: 1 })]).agents[agentKey(main)]!
    expect(costUsd(a, EXAMPLE_PRICES)).toBeUndefined()
  })
  it('model names like toString are not treated as priced', () => {
    const a = reduce(emptyState(), usage('toString')).agents[agentKey(main)]!
    expect(costUsd(a, {})).toBeUndefined()
  })
})

describe('roomsByCwd', () => {
  it('groups by cwd and a subagent without cwd lands in its parent room', () => {
    const s = fold([
      ev({ kind: 'session.start', cwd: '/a' }),
      ev({ kind: 'agent.spawn', depth: 1 }, sub),
      ev({ kind: 'session.start', cwd: '/b' }, other),
      ev({ kind: 'message', role: 'user', chars: 1 }, { provider: 'x', sessionId: 'nocwd' }),
    ])
    const rooms = roomsByCwd(s)
    expect(Object.keys(rooms).sort()).toEqual(['/a', '/b', 'unknown'])
    expect(rooms['/a']!.map((a) => a.key)).toEqual(['claude:s1:main', 'claude:s1:k'])
    expect(rooms['/b']!.map((a) => a.key)).toEqual(['claude:s2:main'])
    expect(rooms['unknown']!.map((a) => a.key)).toEqual(['x:nocwd:main'])
  })

  it("a cwd of '__proto__' is just a room", () => {
    const rooms = roomsByCwd(fold([ev({ kind: 'session.start', cwd: '__proto__' })]))
    expect(Object.keys(rooms)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(rooms)).toBe(Object.prototype)
  })

  it('a parent cycle terminates and lands in unknown', () => {
    const s = fold([ev({ kind: 'agent.spawn', depth: 1 }, sub)])
    const a = s.agents['claude:s1:main']!
    const b = s.agents['claude:s1:k']!
    const cyclic: OfficeState = { ...s, agents: { ...s.agents, [a.key]: { ...a, parentKey: b.key } } }
    expect(Object.keys(roomsByCwd(cyclic))).toEqual(['unknown'])
  })
})
