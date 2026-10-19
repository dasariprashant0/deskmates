import { describe, expect, it } from 'vitest'
import { agentKey } from '../src/index'
import { ev, fold, main } from './helpers'

const a = (s: ReturnType<typeof fold>) => s.agents[agentKey(main)]!
const usage = (input: number, cacheRead: number, cacheWrite: number, ts?: number) =>
  ev({ kind: 'usage', model: 'm', input, cacheRead, cacheWrite, output: 9 }, main, ts)
// The provider's summarizer returns the whole display label ('Read: a.ts', or just the name), so model it like that.
const start = (id: string, name: string, target: string, ts?: number) =>
  ev({ kind: 'tool.start', toolUseId: id, name, summary: target ? `${name}: ${target}` : name }, main, ts)

describe('contextTokens', () => {
  it('is the latest usage prompt size, not cumulative', () => {
    const s = fold([usage(10, 100, 5), usage(20, 300, 0)])
    expect(a(s).contextTokens).toBe(320)
    expect(a(s).usage.input).toBe(30)
  })
  it('is undefined before any usage', () => {
    expect(a(fold([start('t', 'N', 's')])).contextTokens).toBeUndefined()
  })
})

describe('recent events', () => {
  it('starts as an empty list', () => {
    expect(a(fold([ev({ kind: 'activity', state: 'idle' })])).recent).toEqual([])
  })
  it('records tool.start, newest last', () => {
    const s = fold([start('1', 'Read', 'a.ts', 10), start('2', 'Bash', 'ls', 20)])
    expect(a(s).recent).toEqual([{ at: 10, label: 'Read: a.ts' }, { at: 20, label: 'Bash: ls' }])
  })
  it('keeps only the 5 newest', () => {
    const s = fold([1, 2, 3, 4, 5, 6, 7].map((i) => start(String(i), 'T', `s${i}`, i)))
    expect(a(s).recent.map((r) => r.label)).toEqual(['T: s3', 'T: s4', 'T: s5', 'T: s6', 'T: s7'])
  })
  it('records a failed tool by name, and ignores successful ends', () => {
    const s = fold([start('1', 'Edit', 'x', 1), ev({ kind: 'tool.end', toolUseId: '1', isError: true }, main, 2), start('2', 'Read', 'y', 3), ev({ kind: 'tool.end', toolUseId: '2', isError: false }, main, 4)])
    expect(a(s).recent.map((r) => r.label)).toEqual(['Edit: x', 'Edit failed', 'Read: y'])
  })
  it('ignores a failure for an unknown tool id (replayed or orphaned ends must not evict real events)', () => {
    const s = fold([start('1', 'Read', 'a', 1), ev({ kind: 'tool.end', toolUseId: 'zz', isError: true }, main, 2)])
    expect(a(s).recent.map((r) => r.label)).toEqual(['Read: a'])
  })
  it('a non-error end for an unknown id changes nothing in recent', () => {
    const s = fold([start('1', 'Read', 'a', 1), ev({ kind: 'tool.end', toolUseId: 'zz', isError: false }, main, 2)])
    expect(a(s).recent).toEqual([{ at: 1, label: 'Read: a' }])
  })
  it('does not push an entry identical to the newest one', () => {
    const s = fold([ev({ kind: 'attention', toolUseId: '1', source: 'heuristic' }, main, 1), ev({ kind: 'attention', toolUseId: '1', source: 'heuristic' }, main, 2)])
    expect(a(s).recent).toEqual([{ at: 1, label: 'needs you' }])
  })
  it('an empty summary gives the bare name', () => {
    expect(a(fold([start('1', 'Read', '', 1)])).recent[0]!.label).toBe('Read')
  })
  it.each(['Grep', 'Glob', 'Agent', 'Task'])('%s records only the tool name, never free text', (name) => {
    expect(a(fold([start('1', name, 'secret pattern text', 1)])).recent[0]!.label).toBe(name)
  })
  it('strips bidi and zero-width characters', () => {
    const label = a(fold([start('1', 'Read', 'a\u202Eb\u200Bc\u2066d\uFEFFe\u061Cf\u2028g', 1)])).recent[0]!.label
    expect(label).toBe('Read: abcdefg')
  })
  it('records a failure for an open tool', () => {
    const s = fold([start('1', 'Edit', 'x', 1), ev({ kind: 'tool.end', toolUseId: '1', isError: true }, main, 2)])
    expect(a(s).recent.at(-1)!.label).toBe('Edit failed')
  })
  it('records attention, resolution and agent end', () => {
    const s = fold([
      start('1', 'Bash', 'rm', 1),
      ev({ kind: 'attention', toolUseId: '1', source: 'hook' }, main, 2),
      ev({ kind: 'attention.resolved', toolUseId: '1', decision: 'allow' }, main, 3),
      ev({ kind: 'attention', toolUseId: '1', source: 'hook' }, main, 4),
      ev({ kind: 'attention.resolved', toolUseId: '1', decision: 'deny' }, main, 5),
      ev({ kind: 'attention', toolUseId: '1', source: 'hook' }, main, 6),
      ev({ kind: 'attention.resolved', toolUseId: '1' }, main, 7),
    ])
    expect(a(s).recent.map((r) => r.label)).toEqual(['allowed', 'needs you', 'denied', 'needs you', 'resolved'])
    const e = fold([ev({ kind: 'agent.end', reason: 'idle' })])
    expect(a(e).recent.map((r) => r.label)).toEqual(['ended (idle)'])
  })
  it('records allowed', () => {
    const s = fold([ev({ kind: 'attention', toolUseId: '1', source: 'hook' }), ev({ kind: 'attention.resolved', toolUseId: '1', decision: 'allow' })])
    expect(a(s).recent.map((r) => r.label)).toEqual(['needs you', 'allowed'])
  })
  it('cleans labels: control chars, whitespace, 80 code point cap', () => {
    const s = fold([start('1', 'Bash', `a\u0007b\n\n  c\t${'😀'.repeat(100)}`)])
    const label = a(s).recent[0]!.label
    expect(label.startsWith('Bash: ab c ')).toBe(true)
    expect([...label].length).toBe(80)
    expect(label).not.toMatch(/[\u0000-\u001f\u007f]/)
  })
  it('does not record usage, activity or message events', () => {
    const s = fold([usage(1, 1, 1), ev({ kind: 'activity', state: 'thinking' }), ev({ kind: 'message', role: 'user', chars: 5 })])
    expect(a(s).recent).toEqual([])
  })
})
