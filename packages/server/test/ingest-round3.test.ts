import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover as realDiscover } from '@deskmates/provider-claude'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type NewEvent } from '../src/bus'
import { createIngest, type IngestOpts } from '../src/ingest'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dm-ing3-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const subDir = async () => { const d = join(root, '-work-proj', 'sess', 'subagents'); await mkdir(d, { recursive: true }); return d }
const subFile = async (id = 'abc') => { const f = join(await subDir(), `agent-${id}.jsonl`); await writeFile(f, ''); return f }
const mk = (extra: Partial<IngestOpts> = {}, bus: EventBus = new EventBus()) => ({ bus, ing: createIngest({ root, bus, ...extra }) })
const all = (bus: EventBus) => { const e = bus.since(0); return e === 'gap' ? [] : e }
const spawns = (bus: EventBus) => all(bus).filter((e) => e.kind === 'agent.spawn')

describe('I1: bounded bad-scan heuristic', () => {
  it('skips removals on scans 1-4, removes on 5, and a complete scan resets', async () => {
    const f = await subFile()
    let bad = false
    const warns: string[] = []
    const { bus, ing } = mk({
      warn: (c) => warns.push(c),
      deps: { discover: async (o, d) => { if (bad && d) d.skippedDirs++; return bad ? [] : realDiscover(o, d) } },
    })
    await ing.scanOnce()
    expect(spawns(bus)).toHaveLength(1)
    bad = true
    await rm(f) // aged out of discovery
    for (let i = 1; i <= 4; i++) {
      await ing.scanOnce()
      expect(ing.status().scan.consecutiveBad).toBe(i)
      expect(ing.status().scan.skippedRemovals).toBe(i)
    }
    expect(warns).not.toContain('scan-persistent-skip')
    await ing.scanOnce() // 5th: removal pass allowed
    expect(ing.status().scan.skippedRemovals).toBe(4)
    expect(warns.filter((c) => c === 'scan-persistent-skip')).toHaveLength(1)
    await ing.scanOnce()
    expect(warns.filter((c) => c === 'scan-persistent-skip')).toHaveLength(1)
    // removal really happened: re-creating the file spawns again once discovery is healthy
    bad = false
    await subFile(); await ing.scanOnce()
    expect(ing.status().scan.consecutiveBad).toBe(0)
    expect(spawns(bus)).toHaveLength(2)
  })
})

describe('I2: stop() is bounded', () => {
  it('resolves after stopTimedOut and a late settle publishes nothing', async () => {
    await subFile()
    let release!: () => void
    const hung = new Promise<void>((r) => { release = r })
    const { bus, ing } = mk({
      stopTimeoutMs: 50,
      deps: { discover: async (o, d) => { await hung; return realDiscover(o, d) } },
    })
    const scan = ing.scanOnce()
    const t0 = Date.now()
    await ing.stop()
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(ing.status().loop.stopTimedOut).toBe(1)
    release(); await scan
    expect(all(bus)).toHaveLength(0)
  })

  it('does not count a timeout when work settles in time', async () => {
    const { ing } = mk({ stopTimeoutMs: 50 })
    await ing.scanOnce(); await ing.stop()
    expect(ing.status().loop.stopTimedOut).toBe(0)
  })
})

describe('I4: spawn robustness', () => {
  it('does not mark spawned (or publish) when the file was removed during the meta read', async () => {
    const f = await subFile()
    let enter!: () => void; let release!: () => void
    const entered = new Promise<void>((r) => { enter = r }); const wait = new Promise<void>((r) => { release = r })
    const { bus, ing } = mk({ deps: { readSubagentMeta: async () => { enter(); await wait; return undefined } } })
    const scan = ing.scanOnce()
    await entered
    await rm(f); await ing.pollOnce() // tailer onRemove clears known/spawned
    release(); await scan
    expect(spawns(bus)).toHaveLength(0)
    await subFile(); await ing.scanOnce()
    expect(spawns(bus)).toHaveLength(1)
  })

  it('backs off a persistently failing spawn publish (2s, 4s, ...) and counts retries', async () => {
    await subFile()
    let attempts = 0
    class Bus extends EventBus { override publish(e: NewEvent) { if (e.kind === 'agent.spawn') { attempts++; throw new Error('boom') } return super.publish(e) } }
    let t = 1_000_000
    const { ing } = mk({ now: () => t }, new Bus())
    await ing.scanOnce(); expect(attempts).toBe(1)
    t += 1000; await ing.scanOnce(); expect(attempts).toBe(1)
    t += 1000; await ing.scanOnce(); expect(attempts).toBe(2) // +2s
    t += 3999; await ing.scanOnce(); expect(attempts).toBe(2)
    t += 1; await ing.scanOnce(); expect(attempts).toBe(3) // +4s
    t += 1_000_000; await ing.scanOnce(); expect(attempts).toBe(4)
    expect(ing.status().meta.spawnRetries).toBe(3)
  })

  it('error buckets are keyed through safeCode', async () => {
    const { ing } = mk({ deps: { discover: async () => { throw Object.assign(new Error('x'), { code: '/secret/path with spaces' }) } } })
    await ing.scanOnce()
    expect(Object.keys(ing.status().scan.errors)).toEqual(['OTHER'])
  })
})
