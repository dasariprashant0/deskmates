import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSubagentMeta } from '../src/index'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dm-fifo-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const hasMkfifo = (() => { try { execFileSync('mkfifo', ['--help'], { stdio: 'ignore' }) } catch (e) { return (e as { code?: string }).code !== 'ENOENT' } return true })()
const timeout = (ms: number) => new Promise<'timeout'>((r) => { const t = setTimeout(() => r('timeout'), ms); t.unref() })

describe('readSubagentMeta on non-regular files', () => {
  it.skipIf(!hasMkfifo)('a FIFO resolves promptly with undefined and warns meta-corrupt', async () => {
    const p = join(dir, 'a.meta.json')
    execFileSync('mkfifo', [p])
    const warns: string[] = []
    const r = await Promise.race([readSubagentMeta(p, (c) => warns.push(c)), timeout(2000)])
    expect(r).toBeUndefined()
    expect(warns).toEqual(['meta-corrupt'])
  })

  it('oversize file (> 64 KB) is rejected with meta-corrupt', async () => {
    const p = join(dir, 'big.meta.json')
    await writeFile(p, JSON.stringify({ agentType: 'x'.repeat(70_000) }))
    const warns: string[] = []
    expect(await readSubagentMeta(p, (c) => warns.push(c))).toBeUndefined()
    expect(warns).toEqual(['meta-corrupt'])
  })

  it('a directory is rejected with meta-corrupt', async () => {
    const warns: string[] = []
    expect(await readSubagentMeta(dir, (c) => warns.push(c))).toBeUndefined()
    expect(warns).toEqual(['meta-corrupt'])
  })
})
