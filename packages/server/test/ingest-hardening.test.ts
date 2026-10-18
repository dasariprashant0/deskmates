import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover as realDiscover } from '@deskmates/provider-claude'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type NewEvent } from '../src/bus'
import { createIngest, type IngestOpts } from '../src/ingest'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dm-ingh-')) })
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })

const iso = (ms: number) => new Date(ms).toISOString()
const asst = (o: { ts: number; id?: string; extra?: string }) => JSON.stringify({
  type: 'assistant', sessionId: 'sess', cwd: '/work/proj', timestamp: iso(o.ts),
  message: { id: `m-${o.id ?? 'x'}`, model: 'example-model', content: [{ type: 'tool_use', id: o.id ?? 'tu1', name: 'Read', input: { file_path: '/a/b.ts' } }] },
})
const projDir = async () => { const d = join(root, '-work-proj'); await mkdir(d, { recursive: true }); return d }
const mainFile = async (lines: string[]) => { const f = join(await projDir(), 'sess.jsonl'); await writeFile(f, lines.map((l) => `${l}\n`).join('')); return f }
const subDir = async () => { const d = join(root, '-work-proj', 'sess', 'subagents'); await mkdir(d, { recursive: true }); return d }
const subFile = async (id = 'abc') => { const d = await subDir(); const f = join(d, `agent-${id}.jsonl`); await writeFile(f, ''); return f }
const mk = (extra: Partial<IngestOpts> = {}, bus: EventBus = new EventBus()) => ({ bus, ing: createIngest({ root, bus, ...extra }) })
const run = async (ing: ReturnType<typeof createIngest>) => { await ing.scanOnce(); await ing.pollOnce() }
const all = (bus: EventBus) => { const e = bus.since(0); return e === 'gap' ? [] : e }
const spawns = (bus: EventBus) => all(bus).filter((e) => e.kind === 'agent.spawn')
const openKeys = (bus: EventBus) => Object.keys(bus.state().agents['claude:sess:main']?.openTools ?? {})
const gate = () => {
  let release!: () => void; let enter!: () => void
  return { wait: new Promise<void>((r) => { release = r }), entered: new Promise<void>((r) => { enter = r }), release: () => release(), enter: () => enter() }
}
const gatedRead = (g: ReturnType<typeof gate>) => async (p: string) => {
  const fh = await open(p, 'r')
  return { stat: () => fh.stat(), close: () => fh.close(), read: async (b: Buffer, o: number, l: number, pos: number) => { g.enter(); await g.wait; return fh.read(b, o, l, pos) } }
}

class FlakyBus extends EventBus {
  constructor(private readonly failKind: string, private failsLeft = 1) { super() }
  override publish(e: NewEvent) {
    if (e.kind === this.failKind && this.failsLeft > 0) { this.failsLeft--; throw new Error('boom') }
    return super.publish(e)
  }
}

describe('item 2: delete and re-create before discovery notices', () => {
  it('re-adds the main file', async () => {
    const now = Date.now()
    const f = await mainFile([asst({ ts: now - 1000, id: 'tu1' })])
    const { bus, ing } = mk(); await run(ing)
    await rm(f); await ing.pollOnce()
    await mainFile([asst({ ts: now, id: 'tu2' })])
    await run(ing)
    expect(openKeys(bus)).toContain('tu2')
  })

  it('re-publishes the subagent spawn for the re-created file', async () => {
    const f = await subFile()
    const { bus, ing } = mk(); await run(ing)
    await rm(f); await ing.pollOnce()
    await subFile(); await run(ing)
    expect(spawns(bus)).toHaveLength(2)
  })
})

describe('item 3: incomplete scans do not remove sources', () => {
  type Mode = 'ok' | 'rootError' | 'skipped' | 'throw'
  it.each(['rootError', 'skipped', 'throw'] as const)('mode %s keeps sources and does not replay afterwards', async (bad: Exclude<Mode, 'ok'>) => {
    const now = Date.now()
    await mainFile([asst({ ts: now - 1000 })]); await subFile()
    let mode: Mode = 'ok'
    const { bus, ing } = mk({
      deps: {
        discover: async (o, d) => {
          if (mode === 'rootError') { if (d) d.rootError = 'EACCES'; return [] }
          if (mode === 'skipped') { if (d) d.skippedDirs++; return [] }
          if (mode === 'throw') throw Object.assign(new Error('x'), { code: 'EIO' })
          return realDiscover(o, d)
        },
      },
    })
    await run(ing)
    const seq0 = bus.seq()
    expect(ing.status().tail.sources).toBe(2)
    mode = bad; await ing.scanOnce()
    expect(ing.status().tail.sources).toBe(2)
    expect(ing.status().scan.skippedRemovals).toBe(1)
    mode = 'ok'; await run(ing)
    expect(bus.seq()).toBe(seq0)
    expect(spawns(bus)).toHaveLength(1)
    expect(ing.status().tail.sources).toBe(2)
  })

  it('lastOkAt only moves on complete scans', async () => {
    await mainFile([asst({ ts: Date.now() - 1000 })])
    let clock = 1000; let bad = false
    const { ing } = mk({ now: () => clock, deps: { discover: async (o, d) => { if (bad) { if (d) d.rootError = 'EACCES'; return [] } return realDiscover(o, d) } } })
    await ing.scanOnce(); expect(ing.status().scan).toMatchObject({ runs: 1, lastAt: 1000, lastOkAt: 1000 })
    clock = 2000; bad = true; await ing.scanOnce()
    expect(ing.status().scan).toMatchObject({ runs: 2, lastAt: 2000, lastOkAt: 1000 })
    clock = 3000; bad = false; await ing.scanOnce()
    expect(ing.status().scan).toMatchObject({ lastAt: 3000, lastOkAt: 3000 })
  })
})

describe('item 4: guard, stop and restart', () => {
  it('concurrent scanOnce calls share one in-flight run', async () => {
    await mainFile([asst({ ts: Date.now() })])
    let calls = 0
    const { ing } = mk({ deps: { discover: async (o, d) => { calls++; return realDiscover(o, d) } } })
    const a = ing.scanOnce(); const b = ing.scanOnce()
    expect(a).toBe(b)
    await a; expect(calls).toBe(1)
    const p = ing.pollOnce(); expect(ing.pollOnce()).toBe(p); await p
  })

  it('stop() mid-scan prevents adds and publishes', async () => {
    await mainFile([asst({ ts: Date.now() })]); await subFile()
    const g = gate()
    const { bus, ing } = mk({ deps: { discover: async (o, d) => { g.enter(); await g.wait; return realDiscover(o, d) } } })
    const scan = ing.scanOnce(); await g.entered
    const stopped = ing.stop(); g.release(); await stopped; await scan
    expect(ing.status().tail.sources).toBe(0)
    expect(bus.seq()).toBe(0)
  })

  it('stop() mid-poll publishes nothing after it resolves', async () => {
    await mainFile([asst({ ts: Date.now() })])
    const g = gate()
    const { bus, ing } = mk({ deps: { openFile: gatedRead(g) } })
    await ing.scanOnce()
    const poll = ing.pollOnce(); await g.entered
    const stopped = ing.stop(); g.release(); await stopped
    const seq = bus.seq()
    await poll
    expect(bus.seq()).toBe(seq)
    expect(seq).toBe(0)
  })

  it('stop() then start() quickly emits no line twice and leaves one loop', async () => {
    await mainFile([asst({ ts: Date.now() })])
    const g = gate()
    const { bus, ing } = mk({ scanMs: 1e7, pollMs: 1e7, deps: { openFile: gatedRead(g) } })
    await ing.scanOnce()
    const poll = ing.pollOnce(); await g.entered
    const stopped = ing.stop(); ing.start(); g.release(); await stopped; await poll
    await ing.pollOnce(); await ing.scanOnce(); await ing.pollOnce()
    expect(all(bus).filter((e) => e.kind === 'tool.start')).toHaveLength(1)
    expect(ing.status().running).toBe(true)
    await ing.stop()
    expect(ing.status().running).toBe(false)
  })

  it('counts skipped loop ticks while a run is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await mainFile([asst({ ts: Date.now() })])
    const g = gate()
    const { ing } = mk({ scanMs: 10, pollMs: 1e7, deps: { discover: async (o, d) => { g.enter(); await g.wait; return realDiscover(o, d) } } })
    ing.start()
    vi.advanceTimersByTime(10); await g.entered
    vi.advanceTimersByTime(30)
    const stopped = ing.stop(); g.release(); await stopped
    expect(ing.status().loop.skippedTicks).toBe(3)
  })
})

describe('item 5: removal during an in-flight read', () => {
  it('publishes nothing and does not recreate a ctx', async () => {
    const f = await mainFile([asst({ ts: Date.now() })])
    const g = gate()
    const { bus, ing } = mk({ deps: { openFile: gatedRead(g) } })
    await ing.scanOnce()
    const poll = ing.pollOnce(); await g.entered
    await rm(f); await ing.scanOnce()
    g.release(); await poll
    expect(bus.seq()).toBe(0)
    expect(ing.status().tail.sources).toBe(0)
  })
})

describe('item 6: spawn failures', () => {
  it('a throwing meta read falls back to depth 1 and the scan continues', async () => {
    await mainFile([asst({ ts: Date.now() })]); await subFile()
    const { bus, ing } = mk({ deps: { readSubagentMeta: async () => { throw new Error('x') } } })
    await expect(ing.scanOnce()).resolves.toBeUndefined()
    expect(spawns(bus)).toHaveLength(1)
    expect(spawns(bus)[0]).toMatchObject({ depth: 1 })
    expect(ing.status().tail.sources).toBe(2)
  })

  it('a failed spawn publish is retried by the next scan', async () => {
    await subFile()
    const bus = new FlakyBus('agent.spawn')
    let t = Date.now() // injected clock: spawn retries are now backed off (round 3)
    const { ing } = mk({ now: () => t }, bus)
    await ing.scanOnce()
    expect(spawns(bus)).toHaveLength(0)
    expect(ing.status().published.errors).toBe(1)
    expect(ing.status().tail.sources).toBe(1)
    t += 2000; await ing.scanOnce()
    expect(spawns(bus)).toHaveLength(1)
    await ing.scanOnce()
    expect(spawns(bus)).toHaveLength(1)
  })
})

describe('item 10: status and publish isolation', () => {
  it('one failing publish does not drop the rest of its line', async () => {
    await mainFile([asst({ ts: Date.now() - 1000 })])
    const bus = new FlakyBus('tool.start')
    const { ing } = mk({}, bus); await run(ing)
    const kinds = all(bus).map((e) => e.kind)
    expect(kinds).toContain('session.start'); expect(kinds).toContain('activity')
    expect(kinds).not.toContain('tool.start')
    expect(ing.status().published).toMatchObject({ errors: 1 })
    expect(ing.status().published.events).toBe(kinds.length)
  })

  it('status has the documented shape and diag() is an alias', async () => {
    await mainFile([asst({ ts: Date.now() - 1000 })])
    const { bus, ing } = mk(); await run(ing)
    const s = ing.status()
    expect(s).toMatchObject({
      running: false,
      scan: { runs: 1, found: 1, skippedRemovals: 0, errors: {} },
      poll: { runs: 1, errors: {} },
      published: { errors: 0, seq: bus.seq() },
      meta: { corrupt: 0, shape: 0 },
      loop: { skippedTicks: 0 },
    })
    expect(s.scan.lastAt).toBeTypeOf('number'); expect(s.poll.lastAt).toBeTypeOf('number')
    expect(s.lastError).toBeUndefined()
    expect(ing.diag()).toEqual(s)
  })

  it('counts corrupt meta and holds no raw content', async () => {
    await mainFile(['{broken SECRET-MARKER']); const d = await subDir()
    await writeFile(join(d, 'agent-abc.jsonl'), ''); await writeFile(join(d, 'agent-abc.meta.json'), '{SECRET-MARKER')
    const { ing } = mk(); await run(ing)
    expect(ing.status().meta.corrupt).toBe(1)
    expect(JSON.stringify(ing.status())).not.toContain('SECRET-MARKER')
  })

  it('warn fires only on state changes', async () => {
    await mainFile([asst({ ts: Date.now() })])
    let mode: 'root' | 'throw' | 'ok' = 'root'
    const calls: [string, unknown][] = []
    const { ing } = mk({
      warn: (c, ctx) => calls.push([c, ctx]),
      deps: { discover: async (o, d) => {
        if (mode === 'root') { if (d) d.rootError = 'EACCES'; return [] }
        if (mode === 'throw') throw Object.assign(new Error('x'), { code: 'EIO' })
        return realDiscover(o, d)
      } },
    })
    await ing.scanOnce(); await ing.scanOnce(); await ing.scanOnce()
    expect(calls).toEqual([['EACCES', { where: 'discover' }]])
    mode = 'throw'; await ing.scanOnce(); await ing.scanOnce()
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(['EIO', { where: 'scan' }])
    mode = 'ok'; await ing.scanOnce(); mode = 'root'; await ing.scanOnce()
    expect(calls).toHaveLength(3)
    expect(ing.status().lastError).toMatchObject({ where: 'scan' })
  })

  it('a throwing warn callback cannot break a scan', async () => {
    const { ing } = mk({ warn: () => { throw new Error('x') } })
    await expect(ing.scanOnce()).resolves.toBeUndefined()
  })

  it('ctx is dropped on tail reset so session.start is re-emitted', async () => {
    const now = Date.now()
    const f = await mainFile([asst({ ts: now - 1000, id: 'tu1' })])
    const { bus, ing } = mk(); await run(ing)
    await writeFile(f, `${asst({ ts: now, id: 'tu2' })}\n${'x'.repeat(0)}`)
    await appendFile(f, '')
    await ing.pollOnce()
    expect(all(bus).filter((e) => e.kind === 'session.start').length).toBeGreaterThanOrEqual(1)
    expect(openKeys(bus)).toContain('tu2')
  })
})
