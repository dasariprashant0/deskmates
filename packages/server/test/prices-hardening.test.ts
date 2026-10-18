import { DEFAULT_PRICES } from '@deskmates/core'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadPrices } from '../src/prices'

let base: string
let n = 0
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'dm-priceh-')) })
afterAll(async () => { await rm(base, { recursive: true, force: true }) })

const home = async () => { const h = join(base, `h${n++}`); await mkdir(join(h, '.deskmates'), { recursive: true }); return h }
const run = async (content?: string) => {
  const h = await home(); const warns: string[] = []
  if (content !== undefined) await writeFile(join(h, '.deskmates', 'prices.json'), content)
  const r = await loadPrices({ homeDir: h, warn: (c) => warns.push(c) })
  return { ...r, warns }
}
const e = { inputPerMTok: 1, cacheWritePerMTok: 2, cacheReadPerMTok: 0.5, outputPerMTok: 4 }
const bad = (reason: string) => ({ isExample: false, source: 'default', prices: DEFAULT_PRICES, reason, warns: [reason] })

describe('loadPrices hardening (item 8)', () => {
  it('missing file reports reason missing and no warning', async () => {
    expect(await run()).toMatchObject({ isExample: false, source: 'default', reason: 'missing', warns: [] })
  })
  it('valid file has no reason', async () => {
    const r = await run(JSON.stringify({ m: e }))
    expect(r.reason).toBeUndefined(); expect(r.isExample).toBe(false)
  })
  it('invalid JSON reason', async () => { expect(await run('{x')).toMatchObject(bad('prices-invalid-json')) })
  it('oversized file reason prices-too-large', async () => {
    expect(await run(JSON.stringify({ m: e, pad: 'x'.repeat(300 * 1024) }))).toMatchObject(bad('prices-too-large'))
  })
  it('exactly 256 KB is accepted, one byte more is not', async () => {
    const mkBody = (size: number) => { const base = JSON.stringify({ m: e, pad: '' }); return JSON.stringify({ m: e, pad: ' '.repeat(size - base.length) }) }
    // pad is not a valid entry, so a size-accepted file is reported as invalid-shape, not too-large
    expect(await run(mkBody(256 * 1024))).toMatchObject({ reason: 'prices-invalid-shape' })
    expect(await run(mkBody(256 * 1024 + 1))).toMatchObject({ reason: 'prices-too-large' })
  })
  it.each([
    ['negative', { ...e, inputPerMTok: -0.01 }],
    ['above 1_000_000', { ...e, inputPerMTok: 1_000_000.5 }],
    ['string NaN', { ...e, inputPerMTok: 'NaN' }],
    ['string Infinity', { ...e, inputPerMTok: 'Infinity' }],
    ['missing field', { inputPerMTok: 1, cacheWritePerMTok: 1, cacheReadPerMTok: 1 }],
    ['array entry', [1, 2, 3, 4]],
    ['non-object entry', 7],
    ['null entry', null],
  ])('%s entry rejects the whole file', async (_name, entry) => {
    expect(await run(JSON.stringify({ good: e, m: entry }))).toMatchObject(bad('prices-invalid-shape'))
  })
  it('1e999 (parses to Infinity) is rejected', async () => {
    expect(await run('{"m":{"inputPerMTok":1e999,"cacheWritePerMTok":1,"cacheReadPerMTok":1,"outputPerMTok":1}}')).toMatchObject(bad('prices-invalid-shape'))
  })
  it('an empty object file is valid and not an example', async () => {
    const r = await run('{}'); expect(r.isExample).toBe(false); expect(r.prices).toEqual(DEFAULT_PRICES); expect(r.source).toBe('user')
  })
  it('__proto__ is skipped before validation, even with a junk value', async () => {
    const r = await run(`{"__proto__":5,"m":${JSON.stringify(e)}}`)
    expect(r.isExample).toBe(false); expect(Object.keys(r.prices)).toEqual([...Object.keys(DEFAULT_PRICES), 'm'])
  })
  it('a directory at the path is unreadable', async () => {
    const h = await home(); await mkdir(join(h, '.deskmates', 'prices.json'))
    const warns: string[] = []
    expect(await loadPrices({ homeDir: h, warn: (c) => warns.push(c) })).toMatchObject({ isExample: false, source: 'default', reason: 'prices-unreadable' })
    expect(warns).toEqual(['prices-unreadable'])
  })
  it('a FIFO at the path does not block and is unreadable', async () => {
    const h = await home(); const f = join(h, '.deskmates', 'prices.json')
    try { execFileSync('mkfifo', [f]) } catch { return } // mkfifo unavailable: skip
    const warns: string[] = []
    const r = await loadPrices({ homeDir: h, warn: (c) => warns.push(c) })
    expect(r).toMatchObject({ isExample: false, source: 'default', reason: 'prices-unreadable' })
    expect(warns).toEqual(['prices-unreadable'])
  }, 3000)
})
