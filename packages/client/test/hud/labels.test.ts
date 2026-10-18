import type { AgentState, OfficeState } from '@deskmates/core'
import { describe, expect, test } from 'vitest'
import { abbreviate, labelAgents } from '../../src/hud/labels'
import { NAME_MAX } from '../../src/sim/character'

const main = (sid: string, cwd: string, startedAt = 0): AgentState => ({
  key: `t:${sid}:main`, ref: { provider: 't', sessionId: sid }, cwd, status: 'working', activity: 'typing',
  openTools: {}, openOrder: [], usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, startedAt, lastEventAt: startedAt, children: [],
})
const sub = (sid: string, id: string, type: string, startedAt: number, parent = `t:${sid}:main`): AgentState => ({
  ...main(sid, '/x/p', startedAt), key: `t:${sid}:${id}`, ref: { provider: 't', sessionId: sid, agentId: id }, agentType: type, parentKey: parent,
})
const office = (...a: AgentState[]): OfficeState => ({ agents: Object.fromEntries(a.map((x) => [x.key, x])), order: a.map((x) => x.key), seq: 0 })

describe('labelAgents', () => {
  test('unique names carry no number', () => {
    const m = labelAgents(office(main('a', '/w/alpha'), main('b', '/w/beta')))
    expect(m.get('t:a:main')).toEqual({ short: 'alpha', full: 'alpha' })
    expect(m.get('t:b:main')?.full).toBe('beta')
  })

  test('siblings under one parent are numbered by start time, then key', () => {
    const m = labelAgents(office(
      sub('s', 'z', 'general-purpose', 20), sub('s', 'b', 'general-purpose', 10), sub('s', 'a', 'general-purpose', 10), main('s', '/w/proj'),
    ))
    expect(m.get('t:s:a')?.full).toBe('general-purpose #1')
    expect(m.get('t:s:b')?.full).toBe('general-purpose #2')
    expect(m.get('t:s:z')?.full).toBe('general-purpose #3')
    expect(m.get('t:s:z')?.short).toBe('agent #3')
    expect(m.get('t:s:main')?.full).toBe('proj')
  })

  test('same type under different parents does not collide', () => {
    const m = labelAgents(office(main('s1', '/w/a'), main('s2', '/w/b'), sub('s1', 'x', 'general-purpose', 1), sub('s2', 'y', 'general-purpose', 2)))
    expect(m.get('t:s1:x')?.full).toBe('general-purpose')
    expect(m.get('t:s2:y')?.full).toBe('general-purpose')
  })

  test('main agents sharing a project name are numbered', () => {
    const m = labelAgents(office(main('b', '/w/proj', 5), main('a', '/w/proj', 1)))
    expect(m.get('t:a:main')?.full).toBe('proj #1')
    expect(m.get('t:b:main')?.full).toBe('proj #2')
  })

  test('a number never changes once a later sibling arrives or the order array is shuffled', () => {
    const a = main('a', '/w/proj', 1)
    const b = main('b', '/w/proj', 2)
    const c = main('c', '/w/proj', 3)
    const before = labelAgents(office(a, b))
    const after = labelAgents(office(c, b, a))
    expect(after.get(b.key)?.full).toBe(before.get(b.key)?.full)
    expect(after.get(a.key)?.full).toBe(before.get(a.key)?.full)
    expect(after.get(c.key)?.full).toBe('proj #3')
  })

  test('short tags fit NAME_MAX and keep the number', () => {
    const long = 'a-very-long-project-name'
    const m = labelAgents(office(main('a', `/w/${long}`, 1), main('b', `/w/${long}`, 2), ...Array.from({ length: 12 }, (_, i) => sub('s', `g${i}`, 'general-purpose', 100 + i))))
    for (const l of m.values()) expect(Array.from(l.short).length).toBeLessThanOrEqual(NAME_MAX)
    expect(m.get('t:b:main')?.short.endsWith(' #2')).toBe(true)
    expect(m.get('t:s:g11')?.short).toBe('agent #12')
  })

  test('abbreviate shortens only known long names', () => {
    expect(abbreviate('general-purpose')).toBe('agent')
    expect(abbreviate('deskmates')).toBe('deskmates')
  })
})
