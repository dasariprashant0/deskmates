import type { PriceTable, Usage } from '@deskmates/core'

export type CostEstimate = { usd: number; known: boolean }

const MAX_USD = 1e12
const count = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

/** ESTIMATE only: tokens x per-million price. Unknown model => known:false, usd 0. Never NaN or negative. */
export function estimateCost(usage: Usage, model: string | undefined, prices: PriceTable): CostEstimate {
  const p = model !== undefined && Object.hasOwn(prices, model) ? prices[model] : undefined
  if (!p) return { usd: 0, known: false }
  const usd = (count(usage.input) * p.inputPerMTok + count(usage.cacheWrite) * p.cacheWritePerMTok + count(usage.cacheRead) * p.cacheReadPerMTok + count(usage.output) * p.outputPerMTok) / 1e6
  return { usd: Number.isFinite(usd) && usd > 0 ? Math.min(usd, MAX_USD) : 0, known: true }
}

const price = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
/** The wire `prices` is `unknown`; keep only well-formed entries. */
export function asPriceTable(raw: unknown): PriceTable {
  const out: PriceTable = Object.create(null) as PriceTable
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (k === '__proto__' || typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    const { inputPerMTok: i, cacheWritePerMTok: w, cacheReadPerMTok: c, outputPerMTok: o } = r
    if (price(i) && price(w) && price(c) && price(o)) out[k] = { inputPerMTok: i, cacheWritePerMTok: w, cacheReadPerMTok: c, outputPerMTok: o }
  }
  return out
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd).toLocaleString('en-US')}`
}
/** Always '~' prefixed: cost is an estimate. */
export const formatCost = (c: CostEstimate): string => (c.known ? `~${formatUsd(c.usd)}` : 'cost unknown')

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1) return '0'
  if (n < 1000) return String(Math.floor(n))
  const k = Math.round(n / 100) / 10
  if (k < 1000) return `${k}k`
  const m = Math.round(n / 1e5) / 10
  if (m < 1000) return `${m}M`
  return `${Math.round(n / 1e8) / 10}B`
}

const pad = (n: number): string => String(n).padStart(2, '0')
export function formatElapsed(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`
}
