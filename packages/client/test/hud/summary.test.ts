import { EXAMPLE_PRICES, type AgentState, type OfficeState } from '@deskmates/core'
import { describe, expect, test } from 'vitest'
import { cycleKey, describeTotals, ENDED_GRACE_MS, shortDir, summarize } from '../../src/hud/summary'
const EX = { source: 'example', asOf: '2026-10-18' } as const
const USER = { source: 'user', asOf: '2026-10-18' } as const
const DEF = { source: 'default', asOf: '2026-10-18' } as const

const mk = (sid: string, o: Partial<AgentState> = {}): AgentState => ({
  key: `t:${sid}:main`, ref: { provider: 't', sessionId: sid }, cwd: '/home/u/proj', status: 'working', activity: 'typing',
  openTools: {}, openOrder: [], recent: [], usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, startedAt: 0, lastEventAt: 0, children: [], ...o,
})
const office = (...a: AgentState[]): OfficeState => ({ agents: Object.fromEntries(a.map((x) => [x.key, x])), order: a.map((x) => x.key), seq: 0 })
const NOW = 100_000

describe('card fields', () => {
  test('context and recent', () => {
    const r = summarize(office(mk('a', { model: 'x', contextTokens: 84_000, recent: [{ at: 1, label: 'one' }, { at: 2, label: 'two' }] })), EXAMPLE_PRICES, EX, NOW).agents[0]!
    expect(r).toMatchObject({ contextTokens: 84_000, contextPct: 42, contextLabel: '42% of 200K (assumed window)', recent: ['two', 'one'] })
  })
  test('unknown context and a missing recent (older server) do not throw', () => {
    const a = mk('a') as Partial<AgentState>
    delete a.recent
    const r = summarize(office(a as AgentState), EXAMPLE_PRICES, EX, NOW).agents[0]!
    expect(r).toMatchObject({ contextPct: undefined, contextLabel: 'unknown', recent: [] })
  })
})

describe('bad context tokens', () => {
  test.each([-5, NaN, Infinity])('%s is unknown, not 0%%', (n) => {
    const r = summarize(office(mk('a', { contextTokens: n })), EXAMPLE_PRICES, EX, NOW).agents[0]!
    expect(r).toMatchObject({ contextPct: undefined, contextLabel: 'unknown' })
  })
})

describe('summarize', () => {
  test('empty state', () => {
    const s = summarize(office(), EXAMPLE_PRICES, EX, NOW)
    expect(s.agents).toEqual([])
    expect(s.needsYou).toEqual([])
    expect(s.totals).toMatchObject({ running: 0, thinking: 0, needsYou: 0, errors: 0, tokens: 0, usd: 0, anyExample: false })
  })
  test('rows carry name, tool, tokens, cost, elapsed, subagent flag', () => {
    const main = mk('s1', { model: 'example-model', usage: { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 }, startedAt: NOW - 65_000, currentTool: { name: 'Read', summary: 'a.ts', startedAt: 0, toolUseId: 'x' }, children: ['t:s1:sub'] })
    const sub = mk('s1', { key: 't:s1:sub', ref: { provider: 't', sessionId: 's1', agentId: 'sub' }, agentType: 'explorer', parentKey: main.key })
    const s = summarize(office(main, sub), EXAMPLE_PRICES, EX, NOW)
    const [a, b] = s.agents
    expect(a).toMatchObject({ name: 'proj', status: 'working', tool: 'a.ts', tokens: 1_000_000, isSub: false, subagents: 1, elapsedLabel: '1m 05s', costLabel: '~$1.00' })
    expect(b).toMatchObject({ name: 'explorer', isSub: true })
    expect(s.totals).toMatchObject({ running: 2, tokens: 1_000_000, usd: 1, anyExample: true })
  })
  test('unknown model: cost unknown, no example flag', () => {
    const s = summarize(office(mk('a', { model: 'zzz', usage: { input: 5, cacheWrite: 0, cacheRead: 0, output: 0 } })), EXAMPLE_PRICES, EX, NOW)
    expect(s.agents[0]?.costLabel).toBe('cost unknown')
    expect(s.totals).toMatchObject({ usd: 0, anyExample: false, partialCost: true })
  })
  test('needs-you: attention or waiting, heuristic labelled maybe, longest waiting first', () => {
    const a = mk('a', { status: 'waiting', attention: { toolUseId: '1', source: 'hook', since: 5000 } })
    const b = mk('b', { status: 'working', attention: { toolUseId: '2', source: 'heuristic', since: 1000 } })
    const c = mk('c', { status: 'waiting', lastEventAt: 3000 })
    const d = mk('d')
    const s = summarize(office(a, b, c, d), EXAMPLE_PRICES, USER, NOW)
    expect(s.needsYou.map((r) => [r.key, r.status])).toEqual([[b.key, 'maybe waiting'], [c.key, 'needs you'], [a.key, 'needs you']])
    expect(s.totals).toMatchObject({ needsYou: 3, running: 1 })
  })
  test('thinking and errors counted', () => {
    const s = summarize(office(mk('a', { status: 'thinking' }), mk('b', { status: 'error' })), EXAMPLE_PRICES, USER, NOW)
    expect(s.totals).toMatchObject({ thinking: 1, errors: 1 })
  })
  test('ended agents drop out after the grace window only', () => {
    const e = (at: number) => mk('e', { status: 'done', endedAt: at })
    expect(summarize(office(e(NOW - ENDED_GRACE_MS + 1)), {}, USER, NOW).agents).toHaveLength(1)
    expect(summarize(office(e(NOW - ENDED_GRACE_MS - 1)), {}, USER, NOW).agents).toHaveLength(0)
  })
  test('duplicate order keys and missing agents are tolerated', () => {
    const a = mk('a')
    const st: OfficeState = { agents: { [a.key]: a }, order: [a.key, a.key, 'gone'], seq: 0 }
    expect(summarize(st, {}, USER, NOW).agents).toHaveLength(1)
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

describe('describeTotals', () => {
  test('counts, tokens, ~cost and example marker', () => {
    const s = summarize(office(mk('a', { model: 'example-model', usage: { input: 2_000_000, cacheWrite: 0, cacheRead: 0, output: 0 } }), mk('b', { status: 'error' })), EXAMPLE_PRICES, EX, NOW)
    expect(describeTotals(s.totals)).toBe('1 working, 0 thinking, 0 need you, 1 errors. 2M tokens. Estimated cost ~$2.00+ (example prices).')
  })
  test('real prices have no marker', () => {
    const s = summarize(office(mk('a')), EXAMPLE_PRICES, USER, NOW)
    expect(describeTotals(s.totals)).not.toContain('example')
  })
})

describe('numbered names and hidden text', () => {
  test('rows use the full numbered name and keep a short one', () => {
    const p = mk('s', { startedAt: 1 })
    const subs = [1, 2].map((i) => ({ ...mk('s', { startedAt: 10 + i }), key: `t:s:g${i}`, ref: { provider: 't', sessionId: 's', agentId: `g${i}` }, agentType: 'general-purpose', parentKey: p.key }))
    const sm = summarize({ agents: Object.fromEntries([p, ...subs].map((a) => [a.key, a])), order: [p.key, ...subs.map((a) => a.key)], seq: 0 }, EXAMPLE_PRICES, EX, NOW)
    expect(sm.agents.map((r) => r.name)).toEqual(['proj', 'general-purpose #1', 'general-purpose #2'])
    expect(sm.agents.map((r) => r.short)).toEqual(['proj', 'agent #1', 'agent #2'])
  })
  test('describeTotals mentions hidden sessions only when there are some', () => {
    const t = summarize({ agents: {}, order: [], seq: 0 }, EXAMPLE_PRICES, EX, NOW).totals
    expect(describeTotals(t)).not.toContain('not shown')
    expect(describeTotals(t, 12)).toContain('12 more sessions not shown because they are idle or finished')
  })
})

describe('describeTotals price provenance', () => {
  const t = (m: typeof EX | typeof USER | typeof DEF) => describeTotals(summarize(office(mk('a', { model: 'example-model', usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 0 } })), EXAMPLE_PRICES, m, NOW).totals)
  test('default says built-in prices with the as-of date', () => {
    expect(t(DEF)).toContain('Estimated from built-in prices as of 2026-10-18; override in ~/.deskmates/prices.json.')
    expect(t(DEF)).not.toContain('example')
  })
  test('user says prices.json', () => { expect(t(USER)).toContain('Estimated from your prices.json.') })
  test('example keeps the example marker only', () => { expect(t(EX)).toContain('(example prices)'); expect(t(EX)).not.toContain('built-in') })
})
