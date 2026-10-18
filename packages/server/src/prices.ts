import { DEFAULT_PRICES, PRICES_AS_OF, type PriceTable, type PricesSource } from '@deskmates/core'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_BYTES = 256 * 1024
const FIELDS = ['inputPerMTok', 'cacheWritePerMTok', 'cacheReadPerMTok', 'outputPerMTok'] as const
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000

export type PricesReason = 'missing' | 'prices-unreadable' | 'prices-too-large' | 'prices-invalid-json' | 'prices-invalid-shape'
export type PricesResult = { prices: PriceTable; source: PricesSource; asOf: string; /** true only for source 'example' */ isExample: boolean; reason?: PricesReason }

/** `defaults` is for tests/demo: any table other than DEFAULT_PRICES is reported as source 'example'. User entries win per model. */
export const loadPrices = async (opts: { homeDir: string; warn?: (code: string) => void; defaults?: PriceTable }): Promise<PricesResult> => {
  const defaults = opts.defaults ?? DEFAULT_PRICES
  const base: PricesSource = defaults === DEFAULT_PRICES ? 'default' : 'example'
  const fail = (reason: PricesReason): PricesResult => {
    if (reason !== 'missing') { try { opts.warn?.(reason) } catch { /* ignore */ } }
    return { prices: defaults, source: base, asOf: PRICES_AS_OF, isExample: base === 'example', reason }
  }
  let text: string
  try {
    // O_NONBLOCK so a FIFO at the path cannot hang the open; one handle for stat and read (no TOCTOU).
    const fh = await open(join(opts.homeDir, '.deskmates', 'prices.json'), constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      if (!(await fh.stat()).isFile()) return fail('prices-unreadable')
      const buf = Buffer.alloc(MAX_BYTES + 1)
      let got = 0
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, got)
        if (bytesRead === 0) break
        got += bytesRead
      }
      if (got > MAX_BYTES) return fail('prices-too-large')
      text = buf.toString('utf8', 0, got)
    } finally {
      await fh.close().catch(() => {})
    }
  } catch (e) {
    return fail((e as { code?: unknown })?.code === 'ENOENT' ? 'missing' : 'prices-unreadable')
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fail('prices-invalid-json') }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('prices-invalid-shape')
  const prices: PriceTable = Object.assign(Object.create(null) as PriceTable, defaults)
  for (const [model, v] of Object.entries(raw)) {
    if (model === '__proto__') continue // never a real model id; skipped before validation
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('prices-invalid-shape')
    const r = v as Record<string, unknown>
    const get = (f: (typeof FIELDS)[number]) => (Object.hasOwn(r, f) ? r[f] : undefined)
    const [i, cw, cr, o] = [get('inputPerMTok'), get('cacheWritePerMTok'), get('cacheReadPerMTok'), get('outputPerMTok')]
    if (!num(i) || !num(cw) || !num(cr) || !num(o)) return fail('prices-invalid-shape')
    prices[model] = { inputPerMTok: i, cacheWritePerMTok: cw, cacheReadPerMTok: cr, outputPerMTok: o }
  }
  return { prices, source: 'user', asOf: PRICES_AS_OF, isExample: false }
}
