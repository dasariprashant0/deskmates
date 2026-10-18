import { EXAMPLE_PRICES, type AgentState, type OfficeState } from '@deskmates/core'
import { describe, expect, test } from 'vitest'
import { cycleKey, ENDED_GRACE_MS, shortDir, summarize } from '../../src/hud/summary'

const mk = (sid: string, o: Partial<AgentState> = {}): AgentState => ({
  key: `t:${sid}:main`, ref: { provider: 't', sessionId: sid }, cwd: '/home/u/proj', status: 'working', activity: 'typing',
  openTools: {}, openOrder: [], usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, startedAt: 0, lastEventAt: 0, children: [], ...o,
})
const office = (...a: AgentState[]): OfficeState => ({ agents: Object.fromEntries(a.map((x) => [x.key, x])), order: a.map((x) => x.key), seq: 0 })
const NOW = 100_000

describe('summarize', () => {
  test('empty state', () => {
    const s = summarize(office(), EXAMPLE_PRICES, true, NOW)
    expect(s.agents).toEqual([])
    expect(s.needsYou).toEqual([])
    expect(s.totals).toMatchObject({ running: 0, thinking: 0, needsYou: 0, errors: 0, tokens: 0, usd: 0, anyExample: false })
  })
  test('rows carry name, tool, tokens, cost, elapsed, subagent flag', () => {
    const main = mk('s1', { model: 'example-model', usage: { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 }, startedAt: NOW - 65_000, currentTool: { name: 'Read', summary: 'a.ts', startedAt: 0, toolUseId: 'x' }, children: ['t:s1:sub'] })
    const sub = mk('s1', { key: 't:s1:sub', ref: { provider: 't', sessionId: 's1', agentId: 'sub' }, agentType: 'explorer', parentKey: main.key })
    const s = summarize(office(main, sub), EXAMPLE_PRICES, true, NOW)
    const [a, b] = s.agents
    expect(a).toMatchObject({ name: 'proj', status: 'working', tool: 'a.ts', tokens: 1_000_000, isSub: false, subagents: 1, elapsedLabel: '1m 05s', costLabel: '~$1.00' })
    expect(b).toMatchObject({ name: 'explorer', isSub: true })
    expect(s.totals).toMatchObject({ running: 2, tokens: 1_000_000, usd: 1, anyExample: true })
  })
  test('unknown model: cost unknown, no example flag', () => {
    const s = summarize(office(mk('a', { model: 'zzz', usage: { input: 5, cacheWrite: 0, cacheRead: 0, output: 0 } })), EXAMPLE_PRICES, true, NOW)
    expect(s.agents[0]?.costLabel).toBe('cost unknown')
    expect(s.totals).toMatchObject({ usd: 0, anyExample: false, partialCost: true })
  })
  test('needs-you: attention or waiting, heuristic labelled maybe, longest waiting first', () => {
    const a = mk('a', { status: 'waiting', attention: { toolUseId: '1', source: 'hook', since: 5000 } })
    const b = mk('b', { status: 'working', attention: { toolUseId: '2', source: 'heuristic', since: 1000 } })
    const c = mk('c', { status: 'waiting', lastEventAt: 3000 })
    const d = mk('d')
    const s = summarize(office(a, b, c, d), EXAMPLE_PRICES, false, NOW)
    expect(s.needsYou.map((r) => [r.key, r.status])).toEqual([[b.key, 'maybe waiting'], [c.key, 'needs you'], [a.key, 'needs you']])
    expect(s.totals).toMatchObject({ needsYou: 3, running: 1 })
  })
  test('thinking and errors counted', () => {
    const s = summarize(office(mk('a', { status: 'thinking' }), mk('b', { status: 'error' })), EXAMPLE_PRICES, false, NOW)
    expect(s.totals).toMatchObject({ thinking: 1, errors: 1 })
  })
  test('ended agents drop out after the grace window only', () => {
    const e = (at: number) => mk('e', { status: 'done', endedAt: at })
    expect(summarize(office(e(NOW - ENDED_GRACE_MS + 1)), {}, false, NOW).agents).toHaveLength(1)
    expect(summarize(office(e(NOW - ENDED_GRACE_MS - 1)), {}, false, NOW).agents).toHaveLength(0)
  })
  test('duplicate order keys and missing agents are tolerated', () => {
    const a = mk('a')
    const st: OfficeState = { agents: { [a.key]: a }, order: [a.key, a.key, 'gone'], seq: 0 }
    expect(summarize(st, {}, false, NOW).agents).toHaveLength(1)
  })
})

describe('shortDir', () => {
  test('home becomes ~, long paths are shortened, text stays text', () => {
    expect(shortDir('~/proj')).toBe('~/proj')
    expect(shortDir('/Users/bob/work/app')).toBe('~/work/app')
    expect(shortDir('/home/bob')).toBe('~')
    expect(shortDir('/srv/x')).toBe('/srv/x')
    expect(shortDir(undefined)).toBe('unknown')
    expect(shortDir('~/' + 'abcdefgh/'.repeat(6) + 'leaf').startsWith('…/')).toBe(true)
    expect(shortDir('<img src=x>')).toBe('<img src=x>')
  })
})

describe('cycleKey', () => {
  test('wraps both ways, starts sensibly, handles empty and missing current', () => {
    expect(cycleKey([], undefined, 1)).toBeUndefined()
    expect(cycleKey(['a', 'b', 'c'], undefined, 1)).toBe('a')
    expect(cycleKey(['a', 'b', 'c'], undefined, -1)).toBe('c')
    expect(cycleKey(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(cycleKey(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(cycleKey(['a', 'b', 'c'], 'gone', 1)).toBe('a')
  })
})
