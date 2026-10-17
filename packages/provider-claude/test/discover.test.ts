import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { discover, readSubagentMeta } from '../src/index'

const NOW = 1_800_000_000_000
let root: string
const touch = async (p: string, ageMs: number, body = '{}') => {
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, body)
  await utimes(p, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000)
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dm-')) })
afterEach(async () => { await chmod(join(root, 'locked'), 0o755).catch(() => {}); await rm(root, { recursive: true, force: true }) })

describe('discover', () => {
  test('finds main + subagent, filters, sorts newest first', async () => {
    await touch(join(root, 'p1', 's1.jsonl'), 5000)
    await touch(join(root, 'p1', 's1', 'subagents', 'agent-ab12.jsonl'), 1000)
    await touch(join(root, 'p1', 's1', 'subagents', 'agent-ab12.meta.json'), 1000)
    await touch(join(root, 'p2', 's2.jsonl'), 3000)
    await touch(join(root, 'p2', 'old.jsonl'), 999_999)
    await touch(join(root, 'p2', 'notes.txt'), 10)
    await touch(join(root, 'stray.jsonl'), 10)
    const r = await discover({ root, maxAgeMs: 60_000, now: NOW })
    expect(r.map((x) => [x.sessionId, x.agentId, x.isSubagent])).toEqual([
      ['s1', 'ab12', true], ['s2', undefined, false], ['s1', undefined, false]])
    expect(r[0]).toMatchObject({ provider: 'claude', filePath: join(root, 'p1', 's1', 'subagents', 'agent-ab12.jsonl') })
  })
  test('missing root and unreadable dir give []/skip', async () => {
    expect(await discover({ root: join(root, 'nope'), maxAgeMs: 1, now: NOW })).toEqual([])
    await touch(join(root, 'locked', 's.jsonl'), 10)
    await touch(join(root, 'ok', 't.jsonl'), 10)
    await chmod(join(root, 'locked'), 0o000)
    const r = await discover({ root, maxAgeMs: 60_000, now: NOW })
    expect(r.map((x) => x.sessionId)).toEqual(['t'])
  })
})

describe('readSubagentMeta', () => {
  test('reads, tolerates missing and invalid', async () => {
    const m = join(root, 'a.meta.json')
    await writeFile(m, JSON.stringify({ agentType: 'x', description: 'd', toolUseId: 't', spawnDepth: 1 }))
    expect(await readSubagentMeta(m)).toEqual({ agentType: 'x', description: 'd', toolUseId: 't', spawnDepth: 1 })
    expect(await readSubagentMeta(join(root, 'missing.json'))).toBeUndefined()
    await writeFile(m, '{bad')
    expect(await readSubagentMeta(m)).toBeUndefined()
    await writeFile(m, '5')
    expect(await readSubagentMeta(m)).toBeUndefined()
  })
})
