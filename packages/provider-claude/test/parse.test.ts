import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { newParseCtx, parseLine, type SourceRef } from '../src/index'

const src: SourceRef = { provider: 'claude', filePath: '/x/s1.jsonl', sessionId: 's1', isSubagent: false }
const agent = { provider: 'claude', sessionId: 's1', agentId: undefined }
const lines = readFileSync(new URL('./fixtures/exchange.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean)
const ts = (i: number) => Date.parse(`2026-01-01T00:00:0${i}.000Z`)
const usage = (input: number, output: number) => ({ kind: 'usage', model: 'claude-test', input, cacheWrite: 2, cacheRead: 3, output })

describe('parseLine golden', () => {
  test('full exchange maps to exact events', () => {
    const ctx = newParseCtx()
    const out = lines.flatMap((l) => parseLine(src, l, ctx, 999))
    const e = (i: number, x: object) => ({ ts: ts(i), agent, ...x })
    expect(out).toEqual([
      e(0, { kind: 'session.start', cwd: '/w/proj', gitBranch: 'main', model: undefined }),
      e(0, { kind: 'message', role: 'user', chars: 18 }),
      e(0, { kind: 'activity', state: 'thinking' }),
      e(1, { kind: 'activity', state: 'thinking' }),
      e(1, usage(10, 5)),
      e(2, { kind: 'activity', state: 'typing' }),
      e(2, { kind: 'message', role: 'assistant', chars: 12 }),
      e(3, { kind: 'tool.start', toolUseId: 't1', name: 'Read', summary: 'Read: notes.txt' }),
      e(3, { kind: 'activity', state: 'reading' }),
      e(4, { kind: 'tool.end', toolUseId: 't1', isError: false }),
      e(5, { kind: 'activity', state: 'typing' }),
      e(5, { kind: 'message', role: 'assistant', chars: 5 }),
      e(5, usage(20, 7)),
    ])
    expect(out.filter((x) => x.kind === 'session.start')).toHaveLength(1)
    expect(ctx.started).toBe(true)
  })

  test('subagent events carry agentId', () => {
    const sub: SourceRef = { ...src, agentId: 'a1', isSubagent: true }
    const out = parseLine(sub, lines[0]!, newParseCtx())
    expect(out.every((x) => x.agent.agentId === 'a1' && x.agent.parentAgentId === undefined)).toBe(true)
  })

  test('ts falls back to now then 0', () => {
    const l = JSON.stringify({ type: 'user', cwd: '/c', message: { role: 'user', content: 'hi' } })
    expect(parseLine(src, l, newParseCtx(), 42)[0]!.ts).toBe(42)
    expect(parseLine(src, l, newParseCtx())[0]!.ts).toBe(0)
  })

  test('never includes raw text', () => {
    const ctx = newParseCtx()
    const s = JSON.stringify(lines.flatMap((l) => parseLine(src, l, ctx)))
    for (const t of ['SECRET-PROMPT-TEXT', 'SECRET-THOUGHT', 'SECRET-REPLY', 'SECRET-RESULT', '/Users/x/secret'])
      expect(s).not.toContain(t)
  })
})

describe('parseLine robustness', () => {
  const p = (l: string) => parseLine(src, l, newParseCtx())
  test('bad inputs return []', () => {
    const good = lines[2]!
    for (const l of [good.slice(0, 40), 'not json', '', '   ', '[1,2]', '5', 'null', '"s"',
      '{"type":"weird"}', '{"type":"assistant"}', '{"type":"user"}', '{}', 'x'.repeat(1_048_577)])
      expect(p(l)).toEqual([])
  })
  test('extra unknown fields are ignored', () => {
    const o = JSON.parse(lines[0]!)
    o.zzz = { deep: [1] }
    expect(p(JSON.stringify(o)).map((x) => x.kind)).toEqual(['session.start', 'message', 'activity'])
  })
  test('300 seeded mutations never throw', () => {
    let s = 12345
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const base = lines[4]!
    for (let i = 0; i < 300; i++) {
      const at = Math.floor(rnd() * base.length)
      const ch = String.fromCharCode(32 + Math.floor(rnd() * 95))
      const m = rnd() < 0.5 ? base.slice(0, at) + base.slice(at + 1) : base.slice(0, at) + ch + base.slice(at + 1)
      expect(() => p(m)).not.toThrow()
    }
  })
})

describe('usage and tool bookkeeping', () => {
  test('usage once per message.id; distinct ids separate', () => {
    const ctx = newParseCtx()
    const kinds = (l: string) => parseLine(src, l, ctx).filter((x) => x.kind === 'usage').length
    expect([kinds(lines[2]!), kinds(lines[3]!), kinds(lines[4]!), kinds(lines[6]!)]).toEqual([1, 0, 0, 1])
  })
  test('missing usage fields map to 0', () => {
    const l = JSON.stringify({ type: 'assistant', message: { id: 'q', model: 'm', content: [], usage: {} } })
    expect(parseLine(src, l, newParseCtx())).toContainEqual({ kind: 'usage', model: 'm', input: 0, cacheWrite: 0, cacheRead: 0, output: 0, ts: 0, agent })
  })
  test('openToolIds add/remove; orphan result still emits tool.end', () => {
    const ctx = newParseCtx()
    parseLine(src, lines[4]!, ctx)
    expect([...ctx.openToolIds]).toEqual(['t1'])
    parseLine(src, lines[5]!, ctx)
    expect(ctx.openToolIds.size).toBe(0)
    const again = parseLine(src, lines[5]!, ctx)
    expect(again.some((x) => x.kind === 'tool.end' && 'toolUseId' in x && x.toolUseId === 't1')).toBe(true)
  })
  test('is_error true is reported', () => {
    const l = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', is_error: true }] } })
    expect(parseLine(src, l, newParseCtx()).find((x) => x.kind === 'tool.end')).toMatchObject({ isError: true })
  })
})
