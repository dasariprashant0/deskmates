import { EXAMPLE_PRICES } from '@deskmates/core'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadPrices } from '../src/prices'

let base: string
let n = 0
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'dm-prices-')) })
afterAll(async () => { await rm(base, { recursive: true, force: true }) })

const home = async (content?: string) => {
  const h = join(base, `h${n++}`)
  await mkdir(join(h, '.deskmates'), { recursive: true })
  if (content !== undefined) await writeFile(join(h, '.deskmates', 'prices.json'), content)
  return h
}
const run = async (content?: string) => {
  const warns: string[] = []
  const r = await loadPrices({ homeDir: await home(content), warn: (c) => warns.push(c) })
  return { ...r, warns }
}
const entry = { inputPerMTok: 1, cacheWritePerMTok: 2, cacheReadPerMTok: 0.5, outputPerMTok: 4 }

describe('loadPrices', () => {
  it('missing file gives the example table, no warning', async () => {
    const r = await run()
    expect(r).toMatchObject({ prices: EXAMPLE_PRICES, isExample: true, warns: [] })
  })
  it('valid file is used', async () => {
    const r = await run(JSON.stringify({ m1: entry }))
    expect(r.isExample).toBe(false); expect(r.prices['m1']).toEqual(entry); expect(r.warns).toEqual([])
  })
  it('invalid JSON warns once and falls back', async () => {
    const r = await run('{nope')
    expect(r).toMatchObject({ prices: EXAMPLE_PRICES, isExample: true, warns: ['prices-invalid-json'] })
  })
  it.each([['[]'], ['3'], ['null'], [JSON.stringify({ m: { inputPerMTok: 1 } })], [JSON.stringify({ m: 'x' })]])(
    'wrong shape %s warns once', async (c) => {
      const r = await run(c)
      expect(r).toMatchObject({ prices: EXAMPLE_PRICES, isExample: true, warns: ['prices-invalid-shape'] })
    })
  it.each([[-1], [1_000_001], [null], ['5']])('bad number %s ignores the whole file', async (bad) => {
    const r = await run(JSON.stringify({ good: entry, bad: { ...entry, outputPerMTok: bad } }))
    expect(r).toMatchObject({ prices: EXAMPLE_PRICES, isExample: true, warns: ['prices-invalid-shape'] })
  })
  it('__proto__ key does not pollute', async () => {
    const r = await run(`{"__proto__":{"inputPerMTok":9,"cacheWritePerMTok":9,"cacheReadPerMTok":9,"outputPerMTok":9},"m":${JSON.stringify(entry)}}`)
    expect(({} as Record<string, unknown>)['inputPerMTok']).toBeUndefined()
    expect((r.prices as Record<string, unknown>)['inputPerMTok']).toBeUndefined()
    expect(r.prices['m']).toEqual(entry)
    expect(Object.keys(r.prices)).toEqual(['m'])
  })
  it('oversized file is ignored with one warning', async () => {
    const r = await run(JSON.stringify({ m: entry, pad: 'x'.repeat(300 * 1024) }))
    expect(r).toMatchObject({ prices: EXAMPLE_PRICES, isExample: true })
    expect(r.warns).toHaveLength(1)
  })
  it('accepts the 0 and 1_000_000 boundaries', async () => {
    const e = { inputPerMTok: 0, cacheWritePerMTok: 1_000_000, cacheReadPerMTok: 0, outputPerMTok: 1_000_000 }
    const r = await run(JSON.stringify({ m: e }))
    expect(r.isExample).toBe(false); expect(r.prices['m']).toEqual(e)
  })
  it('empty file warns invalid-json once', async () => {
    const r = await run('')
    expect(r.isExample).toBe(true); expect(r.warns).toEqual(['prices-invalid-json'])
  })
  it('unreadable path (a directory) warns prices-unreadable', async () => {
    const h = await home(); await mkdir(join(h, '.deskmates', 'prices.json'))
    const warns: string[] = []
    const r = await loadPrices({ homeDir: h, warn: (c) => warns.push(c) })
    expect(r.isExample).toBe(true); expect(warns).toEqual(['prices-unreadable'])
  })
})
