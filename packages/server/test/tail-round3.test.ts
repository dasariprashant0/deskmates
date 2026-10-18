import { execFileSync } from 'node:child_process'
import { appendFile, closeSync, mkdir, mkdtemp, open, openSync, rm, writeFile } from 'node:fs'
import { constants } from 'node:fs'
import { mkdir as mkdirP, appendFile as appendP, mkdtemp as mkdtempP, open as openP, rm as rmP, writeFile as writeP } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceRef } from '@deskmates/provider-claude'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { safeCode } from '../src/codes'
import { Tailer, type TailerOpts } from '../src/tail'

void appendFile; void mkdir; void mkdtemp; void open; void rm; void writeFile
let dir: string
let n = 0
beforeAll(async () => { dir = await mkdtempP(join(tmpdir(), 'dm-tail3-')) })
afterAll(async () => { await rmP(dir, { recursive: true, force: true }) })

const path = () => join(dir, `f${n++}.jsonl`)
const srcOf = (filePath: string): SourceRef => ({ provider: 'claude', filePath, sessionId: 's', isSubagent: false })
const mk = (opts: Omit<TailerOpts, 'onLine'> = {}) => {
  const lines: string[] = []
  const t = new Tailer({ onLine: (e) => lines.push(e.line), recentMs: Infinity, ...opts })
  return { t, lines }
}
const err = (code: unknown) => Object.assign(new Error('x'), { code })
const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `line-${String(from + i).padStart(4, '0')}`)

describe('T1 stale fingerprint after early exit', () => {
  it('halt mid-read then resume: every line once, no reset', async () => {
    const p = path()
    const first = rows(0, 5)
    await writeP(p, first.join('\n') + '\n')
    let reads = 0
    let stopped = false
    let armed = false
    const { t, lines } = mk({
      chunkSize: 16,
      isStopped: () => stopped,
      openFile: async (f) => {
        const fh = await openP(f, 'r')
        return { stat: () => fh.stat(), close: () => fh.close(), read: async (b, o, l, pos) => { if (armed && ++reads === 3) stopped = true; return fh.read(b, o, l, pos) } }
      },
    })
    t.add(srcOf(p)); await t.poll()
    expect(lines).toEqual(first)
    const more = rows(5, 40)
    await appendP(p, more.join('\n') + '\n')
    reads = 0; armed = true
    await t.poll() // halts mid-read
    expect(lines.length).toBeLessThan(40)
    stopped = false
    await t.poll()
    expect(lines).toEqual(rows(0, 40))
    expect(t.stats().resets).toBe(0)
  })

  it('fh.read throwing mid-file then recovery: no duplicates, no reset', async () => {
    const p = path()
    let clock = 1_000_000
    await writeP(p, rows(0, 5).join('\n') + '\n')
    let reads = 0
    let failAt = Infinity
    const { t, lines } = mk({
      chunkSize: 16,
      now: () => clock,
      openFile: async (f) => {
        const fh = await openP(f, 'r')
        return { stat: () => fh.stat(), close: () => fh.close(), read: async (b, o, l, pos) => { if (++reads === failAt) throw err('EIO'); return fh.read(b, o, l, pos) } }
      },
    })
    t.add(srcOf(p)); await t.poll()
    await appendP(p, rows(5, 40).join('\n') + '\n')
    reads = 0; failAt = 3
    await t.poll()
    expect(t.stats().errors.EIO).toBe(1)
    failAt = Infinity; clock += 60_000
    await t.poll()
    expect(lines).toEqual(rows(0, 40))
    expect(t.stats().resets).toBe(0)
  })
})

describe('T2 non-regular files', () => {
  it('FIFO at the path: poll resolves promptly, counts NOTFILE, regular files still tail', async () => {
    const fifo = join(dir, `fifo${n++}`)
    try { execFileSync('mkfifo', [fifo]) } catch { return } // mkfifo unavailable: skip
    const good = path(); await writeP(good, 'ok\n')
    const { t, lines } = mk()
    t.add(srcOf(fifo)); t.add(srcOf(good))
    let timer: NodeJS.Timeout | undefined
    const winner = await Promise.race([
      t.poll().then(() => 'done'),
      new Promise<string>((r) => { timer = setTimeout(() => r('timeout'), 2000) }),
    ])
    clearTimeout(timer)
    // unblock a stuck open (pre-fix behavior) so the worker can exit
    try { closeSync(openSync(fifo, constants.O_RDWR | (constants.O_NONBLOCK ?? 0))) } catch { /* ignore */ }
    expect(winner).toBe('done')
    expect(t.stats().errors.NOTFILE).toBe(1)
    expect(lines).toEqual(['ok'])
  })

  it('a directory at the path counts EISDIR or NOTFILE without throwing', async () => {
    const d = join(dir, `d${n++}`); await mkdirP(d)
    const { t } = mk()
    t.add(srcOf(d))
    await expect(t.poll()).resolves.toBeUndefined()
    const e = t.stats().errors
    expect((e.EISDIR ?? 0) + (e.NOTFILE ?? 0)).toBe(1)
  })
})

describe('T3 backoff for every persistent error', () => {
  it('doubles 1s, 2s, 4s; skipped polls do not open; success resets', async () => {
    const p = path(); await writeP(p, 'a\n')
    let clock = 5_000_000
    let calls = 0
    let failing = 3
    const { t, lines } = mk({
      now: () => clock,
      openFile: async (f) => { calls++; if (failing > 0) { failing--; throw err('EIO') } return openP(f, 'r') },
    })
    t.add(srcOf(p))
    const at = async (dt: number, expectCalls: number) => { clock += dt; await t.poll(); expect(calls).toBe(expectCalls) }
    await at(0, 1)       // fail 1 -> wait 1s
    await at(999, 1)     // skipped
    await at(1, 2)       // fail 2 -> wait 2s
    await at(1999, 2)    // skipped
    await at(1, 3)       // fail 3 -> wait 4s
    await at(3999, 3)    // skipped
    await at(1, 4)       // success
    expect(lines).toEqual(['a'])
    await appendP(p, 'b\n')
    failing = 1
    await at(0, 5)       // fail again: backoff restarted at 1s (reset on success)
    await at(999, 5)
    await at(1, 6)
    expect(lines).toEqual(['a', 'b'])
  })

  it('caps at 30 s', async () => {
    const p = path(); await writeP(p, 'a\n')
    let clock = 9_000_000
    let calls = 0
    const { t } = mk({ now: () => clock, openFile: async () => { calls++; throw err('EIO') } })
    t.add(srcOf(p))
    for (let i = 0; i < 12; i++) { await t.poll(); clock += 30_000 } // always past any capped wait
    expect(calls).toBe(12)
    await t.poll(); clock += 29_999; const before = calls; await t.poll()
    expect(calls).toBe(before)
  })
})

describe('T4 safeCode', () => {
  it.each([
    ['ENOENT', 'ENOENT'], ['has space', 'OTHER'], ['/etc/passwd', 'OTHER'], ['x'.repeat(500), 'OTHER'],
    ['x'.repeat(24), 'x'.repeat(24)], ['x'.repeat(25), 'OTHER'], ['é', 'OTHER'], ['', 'OTHER'],
    [42, 'OTHER'], [{ toString: () => 'EIO' }, 'OTHER'], [null, 'OTHER'], [undefined, 'OTHER'],
  ])('%j -> %s', (x, want) => { expect(safeCode(x)).toBe(want) })

  it('attacker-influenced error codes never become bucket keys', async () => {
    const bad = ['has space', '/etc/passwd/secret', 'x'.repeat(500), 'café', { a: 1 }, undefined]
    const { t } = mk({ openFile: async (f) => { throw err(bad[Number(f.split('#')[1])]) } })
    bad.forEach((_, i) => t.add(srcOf(`${join(dir, 'z')}#${i}`)))
    await t.poll()
    expect(t.stats().errors).toEqual({ OTHER: bad.length })
    expect(t.stats().lastError?.code).toBe('OTHER')
  })
})

describe('T5 statFile option', () => {
  it('idle fast path uses the injected statFile', async () => {
    const p = path(); await writeP(p, 'a\n')
    let opens = 0; let statCalls = 0; let lie = false
    const { t } = mk({
      openFile: async (f) => { opens++; return openP(f, 'r') },
      statFile: async (f) => { statCalls++; const s = await (await import('node:fs/promises')).stat(f); return lie ? { ino: s.ino, size: s.size + 1, mtimeMs: s.mtimeMs } : s },
    })
    t.add(srcOf(p)); await t.poll()
    await t.poll()
    expect(opens).toBe(1)
    lie = true
    await t.poll()
    expect(statCalls).toBeGreaterThanOrEqual(2)
    expect(opens).toBe(2)
  })
})
