import { appendFile, chmod, mkdir, mkdtemp, open, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceRef } from '@deskmates/provider-claude'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Tailer, type TailerOpts } from '../src/tail'

let dir: string
let n = 0
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'dm-tailh-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const path = () => join(dir, `f${n++}.jsonl`)
const srcOf = (filePath: string): SourceRef => ({ provider: 'claude', filePath, sessionId: 's', isSubagent: false })
const mk = (opts: Omit<TailerOpts, 'onLine'> = {}) => {
  const lines: string[] = []
  const resets: string[] = []
  const t = new Tailer({ onLine: (e) => lines.push(e.line), onReset: (f) => resets.push(f), ...opts })
  return { t, lines, resets }
}
// Opener whose reads block until released; `entered` resolves once a read is waiting.
const gated = () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let enter!: () => void
  const entered = new Promise<void>((r) => { enter = r })
  const openFile = async (p: string) => {
    const fh = await open(p, 'r')
    return {
      stat: () => fh.stat(),
      close: () => fh.close(),
      read: async (b: Buffer, o: number, l: number, pos: number) => { enter(); await gate; return fh.read(b, o, l, pos) },
    }
  }
  return { openFile, release, entered }
}

describe('Tailer same-inode rewrite (item 1)', () => {
  it('truncate + regrow larger on the same inode resets and emits only the new lines', async () => {
    const p = path(); const A = 'A'.repeat(70); const B = 'B'.repeat(80)
    await writeFile(p, `${A}\n`); await utimes(p, 1e9, 1e9)
    const { t, lines, resets } = mk({ recentMs: Infinity }); t.add(srcOf(p)); await t.poll()
    await writeFile(p, `${B}\nC\n`); await utimes(p, 2e9, 2e9); await t.poll()
    expect(lines).toEqual([A, B, 'C'])
    expect(t.stats().resets).toBe(1)
    expect(resets).toEqual([p])
  })

  it('same size, different content (size === offset) also resets', async () => {
    const p = path(); const A = 'A'.repeat(70); const B = 'B'.repeat(70)
    await writeFile(p, `${A}\n`); await utimes(p, 1e9, 1e9)
    const { t, lines } = mk({ recentMs: Infinity }); t.add(srcOf(p)); await t.poll()
    await writeFile(p, `${B}\n`); await utimes(p, 2e9, 2e9); await t.poll()
    expect(lines).toEqual([A, B])
    expect(t.stats().resets).toBe(1)
  })

  it('small files are fingerprinted too (shorter than 64 bytes)', async () => {
    const p = path()
    await writeFile(p, 'aaaa\n'); await utimes(p, 1e9, 1e9)
    const { t, lines } = mk({ recentMs: Infinity }); t.add(srcOf(p)); await t.poll()
    await writeFile(p, 'bbbb\ncc\n'); await utimes(p, 2e9, 2e9); await t.poll()
    expect(lines).toEqual(['aaaa', 'bbbb', 'cc'])
  })

  it('skips open() when ino, size and mtime are unchanged', async () => {
    const p = path(); await writeFile(p, 'a\n')
    let opens = 0
    const { t, lines } = mk({ openFile: (f) => { opens++; return open(f, 'r') } }); t.add(srcOf(p))
    await t.poll(); await t.poll(); await t.poll()
    expect(opens).toBe(1)
    await appendFile(p, 'b\n'); await t.poll()
    expect(opens).toBe(2)
    expect(lines).toEqual(['a', 'b'])
  })
})

describe('Tailer concurrency (items 4, 5)', () => {
  it('poll is re-entrancy safe: concurrent calls share one run', async () => {
    const p = path(); await writeFile(p, 'a\nb\n')
    const { t, lines } = mk(); t.add(srcOf(p))
    const a = t.poll(); const b = t.poll()
    expect(a).toBe(b)
    await Promise.all([a, b])
    expect(lines).toEqual(['a', 'b'])
  })

  it('remove() during an in-flight read emits nothing and fires no onRemove', async () => {
    const p = path(); await writeFile(p, 'x\ny\n')
    const g = gated(); const gone: string[] = []
    const { t, lines } = mk({ openFile: g.openFile, onRemove: (f) => gone.push(f) }); t.add(srcOf(p))
    const poll = t.poll(); await g.entered
    t.remove(p); g.release(); await poll
    expect(lines).toEqual([])
    expect(gone).toEqual([])
    expect(t.stats().sources).toBe(0)
  })

  it('isStopped halts an in-flight poll before emitting', async () => {
    const p = path(); await writeFile(p, 'x\ny\n')
    const g = gated(); let stopped = false
    const { t, lines } = mk({ openFile: g.openFile, isStopped: () => stopped }); t.add(srcOf(p))
    const poll = t.poll(); await g.entered
    stopped = true; g.release(); await poll
    expect(lines).toEqual([])
  })
})

describe('Tailer errors and robustness (items 11, 13)', () => {
  it('a directory path is counted as EISDIR without throwing', async () => {
    const d = join(dir, `d${n++}`); await mkdir(d)
    const { t } = mk(); t.add(srcOf(d))
    await expect(t.poll()).resolves.toBeUndefined()
    expect(t.stats().errors.EISDIR).toBe(1)
    expect(t.stats().failing).toBe(1)
  })

  it('follows a symlink to a file', async () => {
    const p = path(); await writeFile(p, 'a\nb\n')
    const l = path(); await symlink(p, l)
    const { t, lines } = mk(); t.add(srcOf(l)); await t.poll()
    expect(lines).toEqual(['a', 'b'])
  })

  it('CRLF split across a read boundary is stripped', async () => {
    const p = path(); await writeFile(p, 'ab\r\ncd\r\n')
    const { t, lines } = mk({ chunkSize: 3 }); t.add(srcOf(p)); await t.poll()
    expect(lines).toEqual(['ab', 'cd'])
  })

  it.each([1, 2, 3])('multi-byte characters split across read chunks (chunkSize %i)', async (chunkSize) => {
    const p = path(); await writeFile(p, 'café € \u{1F600}\nz\n')
    const { t, lines } = mk({ chunkSize }); t.add(srcOf(p)); await t.poll()
    expect(lines).toEqual(['café € \u{1F600}', 'z'])
  })

  it('backs off 5 s after EMFILE, then retries', async () => {
    const p = path(); await writeFile(p, 'a\n')
    let clock = 1000; let fail = true; let calls = 0
    const { t, lines } = mk({
      now: () => clock,
      openFile: async (f) => { calls++; if (fail) throw Object.assign(new Error('x'), { code: 'EMFILE' }); return open(f, 'r') },
    })
    t.add(srcOf(p)); await t.poll()
    expect(t.stats().errors.EMFILE).toBe(1)
    await t.poll(); expect(calls).toBe(1)
    clock += 5001; fail = false; await t.poll()
    expect(calls).toBe(2)
    expect(lines).toEqual(['a'])
    expect(t.stats().failing).toBe(0)
  })

  it('records lastError and failing for a failing source', async () => {
    const p = path(); await writeFile(p, 'a\n')
    const { t } = mk({ now: () => 42, openFile: async () => { throw Object.assign(new Error('x'), { code: 'EIO' }) } })
    t.add(srcOf(p)); await t.poll()
    expect(t.stats()).toMatchObject({ failing: 1, lastError: { code: 'EIO', at: 42 } })
  })

  it('counts close failures in a CLOSE bucket', async () => {
    const p = path(); await writeFile(p, 'a\n')
    const { t, lines } = mk({
      openFile: async (f) => {
        const fh = await open(f, 'r')
        return { stat: () => fh.stat(), read: (b, o, l, pos) => fh.read(b, o, l, pos), close: async () => { await fh.close(); throw new Error('close') } }
      },
    })
    t.add(srcOf(p)); await t.poll()
    expect(lines).toEqual(['a'])
    expect(t.stats().errors.CLOSE).toBe(1)
  })

  it('callback errors land in the CALLBACK bucket', async () => {
    const p = path(); await writeFile(p, 'a\nb\n')
    const t = new Tailer({ onLine: () => { throw new TypeError('boom') } }); t.add(srcOf(p)); await t.poll()
    expect(t.stats().errors.CALLBACK).toBe(2)
    expect(t.stats().lastError?.code).toBe('CALLBACK')
  })

  it('discards the half-written line when first seen old (starts at EOF mid-line)', async () => {
    const p = path(); const T = 1_700_000_000
    await writeFile(p, 'old1\nhalf'); await utimes(p, T, T)
    const { t, lines } = mk({ now: () => T * 1000 + 3_600_000 }); t.add(srcOf(p)); await t.poll()
    await appendFile(p, '-rest\nnext\n'); await t.poll()
    expect(lines).toEqual(['next'])
  })

  it('keeps the first appended line when an old file ended on a newline or is empty', async () => {
    const T = 1_700_000_000
    const a = path(); await writeFile(a, 'old1\n'); await utimes(a, T, T)
    const b = path(); await writeFile(b, ''); await utimes(b, T, T)
    const { t, lines } = mk({ now: () => T * 1000 + 3_600_000 }); t.add(srcOf(a)); t.add(srcOf(b)); await t.poll()
    await appendFile(a, 'n1\n'); await appendFile(b, 'n2\n'); await t.poll()
    expect(lines.sort()).toEqual(['n1', 'n2'])
  })

  it.skipIf(process.getuid?.() === 0)('EACCES shows up in failing and lastError', async () => {
    const p = path(); await writeFile(p, 'a\n'); await chmod(p, 0)
    let clock = Date.now() // injected: errors now back off (round 3), so advance past it
    const { t } = mk({ now: () => clock }); t.add(srcOf(p)); await t.poll()
    expect(t.stats()).toMatchObject({ failing: 1, lastError: { code: 'EACCES' } })
    await chmod(p, 0o644); clock += 1001; await t.poll()
    expect(t.stats().failing).toBe(0)
  })

  it('truncate fires onReset', async () => {
    const p = path(); await writeFile(p, 'aaaa\nbbbb\n')
    const { t, resets } = mk(); t.add(srcOf(p)); await t.poll()
    await truncate(p, 0); await appendFile(p, 'c\n'); await t.poll()
    expect(resets).toEqual([p])
  })
})
