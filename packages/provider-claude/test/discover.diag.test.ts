import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { discover, newDiscoverDiag, readSubagentMeta } from '../src/index'

const NOW = 1_800_000_000_000
// chmod-based cases are vacuous as root (root ignores permissions)
const asRoot = process.getuid?.() === 0
let root: string
const touch = async (p: string, ageMs = 10, body = '{}') => {
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, body)
  await utimes(p, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000)
}
const opts = () => ({ root, maxAgeMs: 60_000, now: NOW })
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dm-')) })
afterEach(async () => {
  for (const d of ['locked', 'nox']) await chmod(join(root, d), 0o755).catch(() => {})
  await rm(root, { recursive: true, force: true })
})

describe('discover diag', () => {
  test('missing root is not an error', async () => {
    const d = newDiscoverDiag()
    expect(await discover({ root: join(root, 'nope'), maxAgeMs: 1, now: NOW }, d)).toEqual([])
    expect(d).toEqual({ skippedDirs: 0, skippedFiles: 0 })
  })
  test('other root errors give the code only', async () => {
    await writeFile(join(root, 'afile'), '')
    const d = newDiscoverDiag()
    expect(await discover({ root: join(root, 'afile'), maxAgeMs: 1, now: NOW }, d)).toEqual([])
    expect(d.rootError).toBe('ENOTDIR')
    expect(JSON.stringify(d)).not.toContain(root)
  })
  test.skipIf(asRoot)('unreadable dir counts skippedDirs', async () => {
    await touch(join(root, 'locked', 's.jsonl')); await chmod(join(root, 'locked'), 0o000)
    const d = newDiscoverDiag()
    await discover(opts(), d)
    expect(d.skippedDirs).toBe(1)
    expect(d.rootError).toBeUndefined()
  })
  test.skipIf(asRoot)('stat failures count skippedFiles', async () => {
    await touch(join(root, 'nox', 's.jsonl')); await chmod(join(root, 'nox'), 0o600)
    const d = newDiscoverDiag()
    expect(await discover(opts(), d)).toEqual([])
    expect(d.skippedFiles).toBe(1)
  })
})

describe('discover edge cases', () => {
  test('symlinked file and directories are skipped; empty stem skipped', async () => {
    await touch(join(root, 'real', 's.jsonl'))
    await touch(join(root, 'real', '.jsonl'))
    const out = await mkdtemp(join(tmpdir(), 'dm-out-'))
    await touch(join(out, 'z.jsonl')); await touch(join(out, 'agent-q.jsonl'))
    await symlink(join(root, 'real', 's.jsonl'), join(root, 'real', 'link.jsonl'))
    await symlink(out, join(root, 'linkdir'))
    await touch(join(root, 'real', 'sess', 'x.txt'))
    await symlink(out, join(root, 'real', 'sess', 'subagents'))
    const r = await discover(opts())
    await rm(out, { recursive: true, force: true })
    expect(r.map((x) => x.sessionId)).toEqual(['s'])
  })
  test('many files, deterministic order on ties', async () => {
    for (let i = 0; i < 150; i++) await touch(join(root, 'p', `s${String(i).padStart(3, '0')}.jsonl`), 100)
    const a = await discover(opts())
    expect(a).toHaveLength(150)
    expect(a.map((x) => x.filePath)).toEqual(a.map((x) => x.filePath).sort())
    expect(await discover(opts())).toEqual(a)
  })
})

describe('readSubagentMeta hardening', () => {
  test('warns by code, silent on ENOENT, rejects oversize', async () => {
    const w: string[] = []
    const onWarn = (c: string) => w.push(c)
    const m = join(root, 'm.json')
    expect(await readSubagentMeta(join(root, 'none.json'), onWarn)).toBeUndefined()
    expect(w).toEqual([])
    await writeFile(m, '{bad'); expect(await readSubagentMeta(m, onWarn)).toBeUndefined()
    await writeFile(m, '[]'); expect(await readSubagentMeta(m, onWarn)).toBeUndefined()
    expect(w).toEqual(['meta-corrupt', 'meta-shape'])
    await writeFile(m, JSON.stringify({ agentType: 'a'.repeat(70_000) }))
    expect(await readSubagentMeta(m, onWarn)).toBeUndefined()
    expect(w).toHaveLength(3)
  })
})
