import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus } from '../src/bus'
import { createIngest } from '../src/ingest'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dm-ingest-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const iso = (ms: number) => new Date(ms).toISOString()
const asst = (o: { ts: number; tool?: string; id?: string }) => JSON.stringify({
  type: 'assistant', sessionId: 'sess', cwd: '/work/proj', timestamp: iso(o.ts),
  message: { id: `m-${o.id ?? 'x'}`, model: 'example-model', content: [{ type: 'tool_use', id: o.id ?? 'tu1', name: o.tool ?? 'Read', input: { file_path: '/a/b.ts' } }] },
})
const result = (ts: number, id = 'tu1') => JSON.stringify({
  type: 'user', sessionId: 'sess', cwd: '/work/proj', timestamp: iso(ts),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] },
})
const projDir = async () => { const d = join(root, '-work-proj'); await mkdir(d, { recursive: true }); return d }
const mainFile = async (lines: string[]) => { const f = join(await projDir(), 'sess.jsonl'); await writeFile(f, lines.map((l) => `${l}\n`).join('')); return f }
const setup = (extra: { maxAgeMs?: number } = {}) => {
  const bus = new EventBus()
  const ing = createIngest({ root, bus, ...extra })
  return { bus, ing }
}
const run = async (ing: ReturnType<typeof createIngest>) => { await ing.scanOnce(); await ing.pollOnce() }
const main = (bus: EventBus) => bus.state().agents['claude:sess:main']
const all = (bus: EventBus) => { const e = bus.since(0); return e === 'gap' ? [] : e }

describe('createIngest', () => {
  it('turns a session file into agent state with a completed tool', async () => {
    const now = Date.now()
    await mainFile([asst({ ts: now - 2000 }), result(now - 1000)])
    const { bus, ing } = setup(); await run(ing)
    expect(main(bus)?.cwd).toBe('/work/proj')
    expect(main(bus)?.openOrder).toEqual([])
    expect(all(bus).map((e) => e.kind)).toContain('tool.end')
  })

  it('publishes appended lines on the next poll', async () => {
    const now = Date.now()
    const f = await mainFile([asst({ ts: now - 2000 }), result(now - 1500)])
    const { bus, ing } = setup(); await run(ing)
    const before = bus.seq()
    await appendFile(f, `${asst({ ts: now, id: 'tu2' })}\n`); await ing.pollOnce()
    expect(bus.seq()).toBeGreaterThan(before)
    expect(Object.keys(main(bus)?.openTools ?? {})).toEqual(['tu2'])
  })

  it('subagent with meta gives exactly one spawn linked to the main agent', async () => {
    const now = Date.now()
    await mainFile([asst({ ts: now - 3000, tool: 'Agent', id: 'toolu_sa' })])
    const sub = join(root, '-work-proj', 'sess', 'subagents'); await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'explorer', description: 'look around', toolUseId: 'toolu_sa', spawnDepth: 2 }))
    await writeFile(join(sub, 'agent-abc.jsonl'), `${JSON.stringify({ type: 'assistant', sessionId: 'sess', agentId: 'abc', isSidechain: true, cwd: '/work/proj', timestamp: iso(now - 1000), message: { content: [{ type: 'text', text: 'hi' }] } })}\n`)
    const { bus, ing } = setup(); await run(ing); await run(ing)
    const spawns = all(bus).filter((e) => e.kind === 'agent.spawn')
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ depth: 2, viaToolUseId: 'toolu_sa' })
    expect(bus.state().agents['claude:sess:abc']).toMatchObject({ parentKey: 'claude:sess:main', agentType: 'explorer', spawnDescription: 'look around' })
    expect(main(bus)?.children).toEqual(['claude:sess:abc'])
  })

  it('subagent without meta still spawns once at depth 1', async () => {
    const sub = join(root, '-work-proj', 'sess', 'subagents'); await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'agent-zzz.jsonl'), '')
    const { bus, ing } = setup(); await run(ing)
    const spawns = all(bus).filter((e) => e.kind === 'agent.spawn')
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ depth: 1 })
  })

  it('ignores a file older than maxAgeMs', async () => {
    const now = Date.now()
    const f = await mainFile([asst({ ts: now - 9_000_000 })])
    await utimes(f, (now - 9_000_000) / 1000, (now - 9_000_000) / 1000)
    const { bus, ing } = setup({ maxAgeMs: 3_600_000 }); await run(ing)
    expect(bus.seq()).toBe(0)
  })

  it('old-but-within-maxAge file publishes nothing historical, then only new lines', async () => {
    const now = Date.now(); const old = now - 3_600_000
    const f = await mainFile([asst({ ts: old }), result(old + 1)])
    await utimes(f, old / 1000, old / 1000)
    const { bus, ing } = setup(); await run(ing)
    expect(bus.seq()).toBe(0)
    await appendFile(f, `${asst({ ts: now, id: 'tu9' })}\n`); await ing.pollOnce()
    expect(Object.keys(main(bus)?.openTools ?? {})).toEqual(['tu9'])
  })

  it('scanning twice does not duplicate lines', async () => {
    const now = Date.now()
    await mainFile([asst({ ts: now - 2000 }), result(now - 1000)])
    const { bus, ing } = setup(); await run(ing)
    const seq = bus.seq()
    await run(ing); await run(ing)
    expect(bus.seq()).toBe(seq)
  })

  it('counts malformed lines and keeps going; diag holds no raw content', async () => {
    const now = Date.now()
    await mainFile(['{not json SECRET-MARKER', asst({ ts: now - 1000 }), '{"type":"weird-SECRET-MARKER"}'])
    const { bus, ing } = setup(); await run(ing)
    const d = ing.diag()
    expect(d.parse.malformed).toBe(1)
    expect(d.tail.lines).toBe(3)
    expect(main(bus)?.cwd).toBe('/work/proj')
    expect(JSON.stringify(d)).not.toContain('SECRET-MARKER')
  })

  it('removes sources that disappear from discovery', async () => {
    const now = Date.now()
    const f = await mainFile([asst({ ts: now - 1000 })])
    const { ing } = setup(); await run(ing)
    expect(ing.diag().tail.sources).toBe(1)
    await rm(f); await ing.scanOnce()
    expect(ing.diag().tail.sources).toBe(0)
  })

  it('start/stop run the loops and stop cleanly', async () => {
    const now = Date.now()
    await mainFile([asst({ ts: now - 1000 })])
    const bus = new EventBus()
    const ing = createIngest({ root, bus, scanMs: 20, pollMs: 10 })
    ing.start()
    await new Promise((r) => setTimeout(r, 150))
    ing.stop()
    expect(main(bus)?.cwd).toBe('/work/proj')
    const s = bus.seq(); await new Promise((r) => setTimeout(r, 60)); expect(bus.seq()).toBe(s)
  })
})
