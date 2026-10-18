import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover as realDiscover } from '@deskmates/provider-claude'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus } from '../src/bus'
import { createIngest, type IngestOpts } from '../src/ingest'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dm-ing3b-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const subFile = async () => { const d = join(root, '-work-proj', 'sess', 'subagents'); await mkdir(d, { recursive: true }); const f = join(d, 'agent-abc.jsonl'); await writeFile(f, ''); return f }
const mk = (extra: Partial<IngestOpts> = {}) => { const bus = new EventBus(); return { bus, ing: createIngest({ root, bus, ...extra }) } }

describe('I1b: forced removal only for a normal discover with growing skips', () => {
  it.each(['throw', 'rootError'] as const)('mode %s never removes however many bad scans', async (mode) => {
    await subFile()
    let bad = false
    const warns: string[] = []
    const { ing } = mk({
      warn: (c) => warns.push(c),
      deps: { discover: async (o, d) => {
        if (bad && mode === 'throw') throw Object.assign(new Error('x'), { code: 'EIO' })
        if (bad && d) d.rootError = 'EACCES'
        return bad ? [] : realDiscover(o, d)
      } },
    })
    await ing.scanOnce()
    expect(ing.status().tail.sources).toBe(1)
    bad = true
    for (let i = 0; i < 8; i++) await ing.scanOnce()
    expect(ing.status().tail.sources).toBe(1)
    expect(ing.status().scan.skippedRemovals).toBe(8)
    expect(warns).not.toContain('scan-persistent-skip')
  })

  it('persistent skipped dirs (normal return) still remove on scan 5 and warn', async () => {
    const f = await subFile()
    let bad = false
    const warns: string[] = []
    const { ing } = mk({ warn: (c) => warns.push(c), deps: { discover: async (o, d) => { if (bad && d) d.skippedDirs++; return bad ? [] : realDiscover(o, d) } } })
    await ing.scanOnce(); await rm(f); bad = true
    for (let i = 0; i < 4; i++) await ing.scanOnce()
    expect(ing.status().tail.sources).toBe(1)
    await ing.scanOnce()
    expect(ing.status().tail.sources).toBe(0)
    expect(warns.filter((c) => c === 'scan-persistent-skip')).toHaveLength(1)
  })
})

describe('loop jobs that reject', () => {
  it('do not raise an unhandled rejection (exercises the .catch)', async () => {
    const seen: unknown[] = []
    const h = (e: unknown) => { seen.push(e) }
    process.on('unhandledRejection', h)
    let boom = false
    try {
      // now() throwing inside runScan's catch path makes the scan job itself reject.
      const { ing } = mk({ scanMs: 10, pollMs: 1000, now: () => { if (boom) throw new Error('clock'); return Date.now() }, deps: { discover: async () => { throw new Error('x') } } })
      boom = true
      ing.start(); await new Promise((r) => setTimeout(r, 80)); await ing.stop()
    } finally { process.off('unhandledRejection', h) }
    expect(seen).toEqual([])
  })
})
