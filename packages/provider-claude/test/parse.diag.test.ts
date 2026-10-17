import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'
import { newParseCtx, newParseDiag, parseLine, type SourceRef } from '../src/index'

const src: SourceRef = { provider: 'claude', filePath: '/x/s1.jsonl', sessionId: 's1', isSubagent: false }
const lines = readFileSync(new URL('./fixtures/exchange.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean)
const run = (l: string, ctx = newParseCtx()) => { const d = newParseDiag(); const out = parseLine(src, l, ctx, undefined, d); return { out, d } }
const asst = (content: unknown[], extra: object = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', message: { id: 'm', model: 'x', content }, ...extra })

describe('diag counters', () => {
  test('newParseDiag starts at zero', () => {
    expect(newParseDiag()).toEqual({ ignored: 0, unrecognized: 0, malformed: 0, oversize: 0, internalError: 0, badTimestamp: 0 })
  })
  test('malformed: invalid and non-object JSON', () => {
    for (const l of ['{bad', '[1]', '5', 'null']) expect(run(l).d.malformed).toBe(1)
    expect(run('').d.malformed).toBe(0)
  })
  test('oversize counted, by chars and by UTF-8 bytes', () => {
    expect(run('x'.repeat(1_048_577)).d.oversize).toBe(1)
    const big = run(JSON.stringify({ type: 'user', message: { content: '€'.repeat(400_000) } }))
    expect(big.d.oversize).toBe(1)
    expect(big.out).toEqual([])
    const ok = run('x'.repeat(400_000))
    expect(ok.d.oversize).toBe(0)
    expect(ok.d.malformed).toBe(1)
  })
  test('ignored by design vs unrecognized type', () => {
    for (const t of ['last-prompt', 'custom-title', 'agent-name', 'mode', 'file-history-snapshot', 'file-history-delta',
      'queue-operation', 'attachment', 'system', 'summary', 'bridge-session']) {
      const r = run(JSON.stringify({ type: t })); expect(r.d.ignored).toBe(1); expect(r.d.unrecognized).toBe(0)
    }
    const r = run('{"type":"foo"}')
    expect(r.d).toMatchObject({ unrecognized: 1, ignored: 0, lastUnrecognized: 'type=foo' })
    expect(run('{}').d.unrecognized).toBe(1)
  })
  test('lastUnrecognized never carries content', () => {
    expect(run(JSON.stringify({ type: 'a b/SECRET\n' + 'z'.repeat(100) })).d.lastUnrecognized).toMatch(/^type=[\w.-]{1,40}$/)
  })
  test('non-object message is unrecognized', () => {
    expect(run('{"type":"user","message":"hi"}').d).toMatchObject({ unrecognized: 1, lastUnrecognized: 'message=invalid' })
  })
  test('unknown block type counts even when the line yields events', () => {
    const r = run(asst([{ type: 'server_tool_use' }, { type: 'text', text: 'hi' }]))
    expect(r.out.length).toBeGreaterThan(0)
    expect(r.d).toMatchObject({ unrecognized: 1, lastUnrecognized: 'block=server_tool_use' })
  })
  test('tool_use missing id or name is unrecognized', () => {
    expect(run(asst([{ type: 'tool_use', name: 'Read' }])).d).toMatchObject({ unrecognized: 1, lastUnrecognized: 'tool_use=incomplete' })
    expect(run(asst([{ type: 'tool_use', id: 'a' }])).d.unrecognized).toBe(1)
  })
  test('known blocks do not count', () => {
    expect(run(lines[2]!).d).toEqual(newParseDiag())
  })
  test('badTimestamp: missing, unparseable, numeric epoch (not honored)', () => {
    const t = (ts: unknown) => run(JSON.stringify({ type: 'user', timestamp: ts, message: { content: 'x' } }))
    expect(t(undefined).d.badTimestamp).toBe(1)
    expect(t('nope').d.badTimestamp).toBe(1)
    const e = t(1_700_000_000_000)
    expect(e.d.badTimestamp).toBe(1)
    expect(e.out[0]!.ts).toBe(0)
    expect(t('2026-01-01T00:00:00Z').d.badTimestamp).toBe(0)
  })
  test('internalError stores only the error name', () => {
    const spy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw new RangeError('SECRET message') })
    const r = run('{}')
    spy.mockRestore()
    expect(r.out).toEqual([])
    expect(r.d.internalError).toBe(1)
    expect(JSON.stringify(r.d)).not.toContain('SECRET')
  })
  test('diag is optional', () => {
    expect(parseLine(src, '{bad', newParseCtx())).toEqual([])
  })
})

describe('ctx integrity and bounds', () => {
  test('an internal throw leaves ctx unchanged', () => {
    const o = {
      type: 'assistant', cwd: '/c', message: { id: 'm9', content: [
        { type: 'tool_use', id: 't9', name: 'Read', input: {} },
        { type: 'text', get text(): string { throw new TypeError('boom') } }],
      usage: { input_tokens: 1 } },
    }
    const spy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => o)
    const ctx = newParseCtx(); const d = newParseDiag()
    const out = parseLine(src, '{}', ctx, undefined, d)
    spy.mockRestore()
    expect(out).toEqual([])
    expect(d.internalError).toBe(1)
    expect(ctx.started).toBe(false)
    expect(ctx.openToolIds.size).toBe(0)
    expect(ctx.seenMessageIds.size).toBe(0)
  })
  test('sets stay capped over 10,000 lines', () => {
    const ctx = newParseCtx()
    for (let i = 0; i < 10_000; i++) {
      parseLine(src, JSON.stringify({ type: 'assistant', message: { id: 'm' + i, model: 'x', content: [{ type: 'tool_use', id: 't' + i, name: 'Read', input: {} }], usage: {} } }), ctx)
    }
    expect(ctx.seenMessageIds.size).toBeLessThanOrEqual(512)
    expect(ctx.openToolIds.size).toBeLessThanOrEqual(1024)
    expect(ctx.seenMessageIds.has('m9999')).toBe(true)
    expect(ctx.openToolIds.has('t0')).toBe(false)
  })
  test('each event has its own agent object', () => {
    const out = run(lines[0]!).out
    expect(out.length).toBeGreaterThan(1)
    expect(out[0]!.agent).not.toBe(out[1]!.agent)
    expect(out[0]!.agent).toEqual(out[1]!.agent)
  })
  test('__proto__ / constructor keys do not pollute', () => {
    const l = '{"type":"assistant","__proto__":{"polluted":1},"message":{"__proto__":{"p2":1},"constructor":{"prototype":{"p3":1}},"content":[{"type":"text","text":"a","__proto__":{"p4":1}}]}}'
    parseLine(src, l, newParseCtx())
    const o = {} as Record<string, unknown>
    for (const k of ['polluted', 'p2', 'p3', 'p4']) expect(o[k]).toBeUndefined()
  })
})
