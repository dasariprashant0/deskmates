import { appendFile, chmod, mkdtemp, rename, rm, truncate, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceRef } from '@deskmates/provider-claude'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Tailer, type TailEvent } from '../src/tail'

let dir: string
let n = 0
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'dm-tail-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const path = () => join(dir, `f${n++}.jsonl`)
const srcOf = (filePath: string): SourceRef => ({ provider: 'claude', filePath, sessionId: 's', isSubagent: false })
const mk = (opts: { maxLineBytes?: number; recentMs?: number; now?: () => number } = {}) => {
  const lines: string[] = []
  const t = new Tailer({ onLine: (e: TailEvent) => lines.push(e.line), ...opts })
  return { t, lines }
}

describe('Tailer', () => {
  it('emits a line appended in three chunks exactly once, intact', async () => {
    const p = path(); await writeFile(p, '')
    const { t, lines } = mk(); t.add(srcOf(p)); await t.poll()
    await appendFile(p, '{"a":'); await t.poll()
    await appendFile(p, '"hello'); await t.poll()
    expect(lines).toEqual([])
    await appendFile(p, ' world"}\n'); await t.poll()
    await t.poll()
    expect(lines).toEqual(['{"a":"hello world"}'])
  })

  it('emits two lines from one chunk in order, and reports the source', async () => {
    const p = path(); await writeFile(p, 'one\ntwo\n')
    const seen: TailEvent[] = []
    const t = new Tailer({ onLine: (e) => seen.push(e) }); t.add(srcOf(p)); await t.poll()
    expect(seen.map((e) => e.line)).toEqual(['one', 'two'])
    expect(seen[0]?.src.filePath).toBe(p)
    expect(t.stats()).toMatchObject({ sources: 1, lines: 2 })
  })

  it('decodes a multi-byte character split across appends', async () => {
    const p = path(); await writeFile(p, '')
    const { t, lines } = mk(); t.add(srcOf(p)); await t.poll()
    const b = Buffer.from('café € \u{1F600}\n')
    for (let i = 0; i < b.length; i += 2) { await appendFile(p, b.subarray(i, i + 2)); await t.poll() }
    expect(lines).toEqual(['café € \u{1F600}'])
  })

  it('strips CRLF endings', async () => {
    const p = path(); await writeFile(p, 'a\r\nb\r\n')
    const { t, lines } = mk(); t.add(srcOf(p)); await t.poll()
    expect(lines).toEqual(['a', 'b'])
  })

  it('does not emit a partial last line until its newline arrives', async () => {
    const p = path(); await writeFile(p, 'done\npart')
    const { t, lines } = mk(); t.add(srcOf(p)); await t.poll()
    expect(lines).toEqual(['done'])
    await appendFile(p, 'ial\n'); await t.poll()
    expect(lines).toEqual(['done', 'partial'])
  })

  it('re-reads from 0 after truncate and counts resets', async () => {
    const p = path(); await writeFile(p, 'aaaa\nbbbb\n')
    const { t, lines } = mk(); t.add(srcOf(p)); await t.poll()
    await truncate(p, 0); await appendFile(p, 'cc\n'); await t.poll()
    expect(lines).toEqual(['aaaa', 'bbbb', 'cc'])
    expect(t.stats().resets).toBe(1)
  })

  it('resets when the file is replaced by a new inode', async () => {
    const p = path(); await writeFile(p, 'aa\n')
    const { t, lines } = mk(); t.add(srcOf(p)); await t.poll()
    const q = path(); await writeFile(q, 'bb\ncc\n'); await rename(q, p); await t.poll()
    expect(lines).toEqual(['aa', 'bb', 'cc'])
    expect(t.stats().resets).toBe(1)
  })

  it('drops a deleted source silently', async () => {
    const p = path(); await writeFile(p, 'a\n')
    const { t } = mk(); t.add(srcOf(p)); await t.poll()
    await unlink(p)
    await expect(t.poll()).resolves.toBeUndefined()
    expect(t.stats().sources).toBe(0)
    expect(t.stats().errors).toEqual({})
  })

  it('is idempotent on add and supports remove', async () => {
    const p = path(); await writeFile(p, 'a\n')
    const { t, lines } = mk(); t.add(srcOf(p)); t.add(srcOf(p)); await t.poll()
    expect(lines).toEqual(['a']); expect(t.stats().sources).toBe(1)
    t.remove(p); expect(t.stats().sources).toBe(0)
  })

  it('skips an oversized line and still emits the next one', async () => {
    const p = path(); await writeFile(p, `${'x'.repeat(500)}\nok\n`)
    const { t, lines } = mk({ maxLineBytes: 100 }); t.add(srcOf(p)); await t.poll()
    expect(lines).toEqual(['ok'])
    expect(t.stats().skippedOversize).toBe(1)
  })

  it('does not buffer a 20 MB newline-free file', async () => {
    const p = path(); await writeFile(p, Buffer.alloc(20 * 1024 * 1024, 120))
    const { t, lines } = mk(); t.add(srcOf(p)); await t.poll()
    expect(t.bufferedBytes()).toBeLessThanOrEqual(1_048_576)
    expect(t.stats().skippedOversize).toBe(1)
    await appendFile(p, '\nok\n'); await t.poll()
    expect(lines).toEqual(['ok'])
    expect(t.stats().skippedOversize).toBe(1)
  })

  it('first sight: recent file starts at 0, old file at EOF', async () => {
    const recent = path(); const old = path()
    await writeFile(recent, 'r1\n'); await writeFile(old, 'o1\n')
    const T = 1_700_000_000
    await utimes(recent, T, T); await utimes(old, T - 3600, T - 3600)
    const { t, lines } = mk({ now: () => T * 1000 + 1000, recentMs: 600_000 })
    t.add(srcOf(recent)); t.add(srcOf(old)); await t.poll()
    expect(lines).toEqual(['r1'])
    await appendFile(old, 'o2\n'); await t.poll()
    expect(lines).toEqual(['r1', 'o2'])
  })

  it.skipIf(process.getuid?.() === 0)('counts EACCES and recovers after chmod back', async () => {
    const p = path(); await writeFile(p, 'a\n'); await chmod(p, 0)
    let clock = Date.now() // injected: errors now back off (round 3), so advance past it
    const { t, lines } = mk({ now: () => clock }); t.add(srcOf(p)); await t.poll()
    expect(t.stats().errors.EACCES).toBeGreaterThanOrEqual(1)
    expect(t.stats().sources).toBe(1)
    await chmod(p, 0o644); clock += 1001; await t.poll()
    expect(lines).toEqual(['a'])
  })

  it('never throws when onLine throws', async () => {
    const p = path(); await writeFile(p, 'a\nb\n')
    const lines: string[] = []
    const t = new Tailer({ onLine: (e) => { lines.push(e.line); throw new Error('boom') } })
    t.add(srcOf(p)); await expect(t.poll()).resolves.toBeUndefined()
    expect(lines).toEqual(['a', 'b'])
  })

  it('reports removal through onRemove', async () => {
    const p = path(); await writeFile(p, 'a\n')
    const gone: string[] = []
    const t = new Tailer({ onLine: () => {}, onRemove: (f) => gone.push(f) }); t.add(srcOf(p)); await t.poll()
    await unlink(p); await t.poll()
    expect(gone).toEqual([p])
  })

  it('property: random chunking always emits exactly the known lines in order', async () => {
    let seed = 12345
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296 }
    const alphabet = ['a', 'Z', ' ', '{', '"', 'é', '€', '\u{1F600}']
    for (let c = 0; c < 100; c++) {
      const known = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () =>
        Array.from({ length: Math.floor(rnd() * 40) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(''))
      const bytes = Buffer.from(known.map((l) => `${l}\n`).join(''))
      const p = path(); await writeFile(p, '')
      const { t, lines } = mk(); t.add(srcOf(p)); await t.poll()
      for (let i = 0; i < bytes.length;) {
        const k = 1 + Math.floor(rnd() * 12)
        await appendFile(p, bytes.subarray(i, i + k)); i += k
        if (rnd() < 0.7) await t.poll()
      }
      await t.poll()
      expect(lines).toEqual(known)
    }
  })
})
